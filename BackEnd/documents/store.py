"""현재 문서와 후보 작업을 분리하고 DB 게시 함수로만 검색 자료를 교체한다."""

import json
from contextlib import closing, contextmanager
from uuid import uuid4

from psycopg2.extras import Json, RealDictCursor, execute_values

from BackEnd.core.db import connect
from BackEnd.core.settings import get_settings
from BackEnd.documents.contracts import DocumentError, PARSER_VERSION, stable_hash
from BackEnd.rag.embeddings import validate_embeddings

PENDING = ('queued', 'parsing', 'awaiting_review', 'embedding', 'ready')
WORKING = ('parsing', 'awaiting_review', 'embedding', 'ready')
SERVICE_ID = "coalesce(p.external_service_id, 'PROGRAM_' || p.program_id::text)"


class DocumentStore:
    def __init__(self, connection_factory):
        self.connect = connection_factory

    @contextmanager
    def cursor(self):
        with closing(self.connect()) as conn, conn, conn.cursor(cursor_factory=RealDictCursor) as cur:
            yield cur

    @staticmethod
    def _admin(cur, actor, local=False):
        if actor is None:
            if not local:
                raise DocumentError('admin_permission_required')
            return
        cur.execute('SELECT 1 FROM public.rag_document_admins WHERE user_id=%s AND active FOR SHARE', (actor,))
        if not cur.fetchone():
            raise DocumentError('admin_permission_required')

    def is_admin(self, actor):
        with self.cursor() as cur:
            cur.execute('SELECT 1 FROM public.rag_document_admins WHERE user_id=%s AND active', (actor,))
            return bool(cur.fetchone())

    def programs(self, test_only=None, offset=0, limit=50):
        with self.cursor() as cur:
            cur.execute('SELECT p.program_id,' + SERVICE_ID + ' AS service_id,p.program_name,p.summary,'
                        'p.source_url,p.test_only,d.ministry_name,d.department_name '
                        'FROM public.welfare_programs p JOIN public.departments d USING(department_id) '
                        'WHERE (%s IS NULL OR p.test_only=%s) ORDER BY p.program_id LIMIT %s OFFSET %s',
                        (test_only,test_only,limit+1,offset))
            rows=cur.fetchall()
            return {'items':[dict(r) for r in rows[:limit]], 'offset':offset, 'limit':limit,
                    'next_offset':offset+limit if len(rows)>limit else None}

    @staticmethod
    def _document(cur, document_id, lock=False):
        cur.execute('SELECT d.*, ' + SERVICE_ID + ' AS service_id, p.program_name AS service_name, '
                    'p.test_only AS program_test_only FROM public.rag_documents d '
                    'JOIN public.welfare_programs p USING(program_id) WHERE d.document_id=%s'
                    + (' FOR UPDATE OF d' if lock else ''), (document_id,))
        row = cur.fetchone()
        if not row:
            raise DocumentError('document_not_found')
        return dict(row)

    @staticmethod
    def _pending(cur, document_id):
        cur.execute('SELECT * FROM public.rag_document_jobs WHERE document_id=%s AND state=ANY(%s) '
                    'ORDER BY created_at DESC LIMIT 1 FOR UPDATE', (document_id, list(PENDING)))
        return cur.fetchone()

    @staticmethod
    def _new_job(cur, doc, metadata, original, actor, config):
        # 실패 후보는 정리하고, 현재 성공 작업은 게시 함수가 교체할 때까지 그대로 둔다.
        cur.execute("DELETE FROM public.rag_document_jobs WHERE document_id=%s AND state IN ('failed','cancelled')",
                    (doc['document_id'],))
        cur.execute('INSERT INTO public.rag_document_jobs(document_id,expected_active_job_id,candidate_metadata,'
                    'candidate_original,parser_version,parse_config,created_by,local_ingestion) '
                    'VALUES(%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *',
                    (doc['document_id'], doc['active_job_id'], Json(json.loads(json.dumps(metadata, default=str))), original, PARSER_VERSION,
                     Json({**config, 'processing_mode': 'automatic'}), actor, actor is None))
        return dict(cur.fetchone())

    def automatic_ready(self):
        with self.cursor() as cur:
            cur.execute("SELECT to_regprocedure('public.welfare_document_processing_contract()') AS contract")
            if not cur.fetchone()['contract']:
                return False
            cur.execute('SELECT public.welfare_document_processing_contract() AS version')
            return cur.fetchone()['version'] == 'automatic-v1'

    def register(self, metadata, file_hash, size, suffix, actor, config, original, *, document_id=None, shared_password=False):
        if not self.automatic_ready():
            raise DocumentError('automatic_processing_schema_required')
        replacing = document_id is not None
        document_id = str(document_id) if document_id is not None else None
        if len(original) != size or stable_hash(original) != file_hash:
            raise DocumentError('original_hash_mismatch')
        with self.cursor() as cur:
            self._admin(cur, actor, local=actor is None)
            cur.execute('SELECT p.program_id,p.test_only FROM public.welfare_programs p WHERE '
                        + SERVICE_ID + '=%s FOR SHARE', (metadata['service_id'],))
            programs = cur.fetchall()
            if not programs:
                raise DocumentError('linked_service_not_found')
            if len(programs) != 1:
                raise DocumentError('ambiguous_service_identifier')
            program = programs[0]
            if program['test_only'] and not metadata['test_only']:
                raise DocumentError('test_program_requires_test_document')
            candidate = {**metadata, 'document_name': metadata['name'], 'file_sha256': file_hash,
                         'file_format': suffix}
            if document_id is None:
                cur.execute('INSERT INTO public.rag_documents(program_id,document_name,source_url,source_organization,'
                            'basis_year,source_updated_at,valid_from,valid_until,region_scope,test_only,uploaded_by,local_ingestion) '
                            'VALUES(%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s) RETURNING document_id',
                            (program['program_id'], metadata['name'], metadata['source_url'], metadata['source_organization'],
                             metadata.get('basis_year'), metadata.get('source_updated_at'), metadata.get('valid_from'),
                             metadata.get('valid_until'), metadata.get('region_scope'), metadata['test_only'], actor, actor is None))
                document_id = cur.fetchone()['document_id']
            doc = self._document(cur, document_id, lock=True)
            if doc['program_id'] != program['program_id']:
                raise DocumentError('document_program_immutable')
            self._admin(cur, actor, local=shared_password or doc['local_ingestion'])
            pending = self._pending(cur, document_id)
            if pending:
                if (replacing and pending['state'] == 'awaiting_review'
                        and pending['parse_config'].get('processing_mode') != 'automatic'):
                    # 사용자가 새 파일을 명시적으로 첨부한 경우에만 이전 대기 후보를 교체한다.
                    self._discard(cur, pending['job_id'], 'cancelled', 'legacy_replaced_by_upload')
                else:
                    raise DocumentError('document_job_already_pending')
            job = self._new_job(cur, doc, candidate, original, actor, config)
            return doc, job

    def status(self, document_id):
        with self.cursor() as cur:
            # 문서와 작업을 같은 문장 스냅샷으로 읽는다.
            cur.execute('SELECT d.document_id,d.program_id,d.document_name,d.source_url,d.source_organization,d.basis_year,'
                        'd.source_updated_at,d.valid_from,d.valid_until,d.region_scope,d.test_only,d.local_ingestion,'
                        'd.active_job_id,d.created_at,d.updated_at, ' + SERVICE_ID + ' AS service_id, p.test_only AS program_test_only, '
                        '(SELECT coalesce(jsonb_agg(jsonb_build_object('
                        "'job_id',j.job_id,'state',j.state,'attempts',j.attempts,'error_code',j.error_code,"
                        "'created_at',j.created_at,'finished_at',j.finished_at,'reviewed_at',j.reviewed_at,"
                        "'parser_version',j.parser_version,'embedding_model',j.embedding_model,"
                        "'embedding_digest',j.embedding_digest,'candidate_metadata',j.candidate_metadata,"
                        "'processing_mode',coalesce(j.parse_config->>'processing_mode','manual'),"
                        "'processed_at',j.chunk_config->'payload'->>'processed_at')), '[]'::jsonb) "
                        'FROM public.rag_document_jobs j WHERE j.document_id=d.document_id) AS jobs '
                        'FROM public.rag_documents d JOIN public.welfare_programs p USING(program_id) '
                        'WHERE d.document_id=%s', (document_id,))
            row = cur.fetchone()
            if not row:
                raise DocumentError('document_not_found')
            doc = dict(row)
            jobs = sorted(doc.pop('jobs'), key=lambda j: j['created_at'], reverse=True)
            # 원문은 별도 분석/Markdown 경로에서만 반환한다.
            for key in ('original_bytes', 'markdown', 'analysis_json'):
                doc.pop(key, None)
            return doc, jobs

    def analysis_result(self, document_id):
        with self.cursor() as cur:
            cur.execute("SELECT j.job_id,j.state,j.chunk_config,j.parser_version,coalesce(j.parse_config->>'processing_mode','manual') AS processing_mode,"
                        'CASE WHEN j.state=\'succeeded\' THEN d.analysis_json ELSE j.candidate_analysis END AS analysis '
                        'FROM public.rag_documents d JOIN public.rag_document_jobs j ON j.document_id=d.document_id '
                        "WHERE d.document_id=%s AND (j.state='succeeded' AND j.job_id=d.active_job_id "
                        "OR j.state IN ('awaiting_review','embedding','ready') "
                        "OR (j.state='parsing' AND j.parse_config->>'processing_mode'='automatic' AND j.candidate_analysis IS NOT NULL)) "
                        "ORDER BY (j.state<>'succeeded') DESC,j.created_at DESC LIMIT 1", (document_id,))
            row = cur.fetchone()
            if not row or not row['analysis']:
                raise DocumentError('analysis_not_ready')
            job = dict(row)
            expected = job['chunk_config'].get('payload', {}).get('analysis_hash')
            if job['state'] in ('embedding', 'ready', 'succeeded') and not expected:
                raise DocumentError('analysis_review_hash_missing')
            job['analysis_hash'] = expected or stable_hash(job['analysis'])
            return job

    def policy(self, service_id):
        # CSV 필드는 탐색 메타데이터이며 검토 문서보다 우선하는 상세 근거로 승격하지 않는다.
        return {'hash': '', 'years': []}

    def queue_index(self, document_id, actor, request, expected_job_id, analysis_hash, settings):
        # 과거 호출자는 자동 승인으로 바꾸지 않고 재업로드를 안내한다.
        raise DocumentError('manual_index_disabled_upload_again')

    def retry(self, document_id, actor, config, *, shared_password=False):
        if not self.automatic_ready():
            raise DocumentError('automatic_processing_schema_required')
        with self.cursor() as cur:
            doc = self._document(cur, document_id, lock=True)
            self._admin(cur, actor, local=shared_password or doc['local_ingestion'])
            if self._pending(cur, document_id):
                raise DocumentError('document_job_already_pending')
            if not doc['original_bytes']:
                raise DocumentError('candidate_discarded_upload_file_again')
            metadata = {k: doc[k] for k in ('source_url','source_organization','source_updated_at','basis_year',
                                          'valid_from','valid_until','region_scope','test_only','file_sha256','file_format')}
            metadata['document_name'] = doc['document_name']
            metadata['service_id'] = doc['service_id']
            return str(self._new_job(cur, doc, metadata, bytes(doc['original_bytes']), actor, config)['job_id'])

    @staticmethod
    def _discard(cur, job_id, state, code):
        # 0004의 종료 후보 정리 계약을 사용한다. 현재 문서 행은 수정하지 않는다.
        cur.execute('UPDATE public.rag_document_jobs SET state=%s,error_code=%s,finished_at=clock_timestamp(),'
                    "lease_token=NULL,lease_until=NULL,expected_active_job_id=NULL,candidate_metadata='{}'::jsonb,"
                    'candidate_original=NULL,candidate_markdown=NULL,candidate_analysis=NULL WHERE job_id=%s',
                    (state, code[:100], job_id))
        cur.execute('DELETE FROM public.welfare_document_vectors WHERE job_id=%s', (job_id,))

    def cancel(self, document_id, actor, *, shared_password=False):
        with self.cursor() as cur:
            self._document(cur, document_id, lock=True)
            job = self._pending(cur, document_id)
            if not job:
                raise DocumentError('pending_job_not_found')
            self._admin(cur, actor, local=shared_password or job['local_ingestion'])
            self._discard(cur, job['job_id'], 'cancelled', 'cancelled_by_user')
            return str(job['job_id'])

    def delete(self, document_id, actor, *, shared_password=False):
        with self.cursor() as cur:
            doc = self._document(cur, document_id, lock=True)
            self._admin(cur, actor, local=shared_password or doc['local_ingestion'])
            cur.execute('DELETE FROM public.rag_documents WHERE document_id=%s', (document_id,))

    def claim(self, seconds, service_id=None):
        eligible = "j.parse_config->>'processing_mode'='automatic' AND j.available_at<=clock_timestamp() " \
                   "AND (j.state='queued' OR (j.state IN ('parsing','embedding','ready') " \
                   "AND (j.lease_until IS NULL OR j.lease_until<=clock_timestamp())))"
        with self.cursor() as cur:
            # 문서 -> 작업 순서로 잠가 게시·취소와 잠금 순서를 맞춘다.
            cur.execute('SELECT d.document_id FROM public.rag_documents d JOIN public.welfare_programs p USING(program_id) '
                        'WHERE (%s IS NULL OR ' + SERVICE_ID + '=%s) AND EXISTS ('
                        'SELECT 1 FROM public.rag_document_jobs j WHERE j.document_id=d.document_id AND ' + eligible + ') '
                        'ORDER BY d.created_at FOR UPDATE OF d SKIP LOCKED LIMIT 1', (service_id, service_id))
            row = cur.fetchone()
            if not row:
                return None
            cur.execute('SELECT j.* FROM public.rag_document_jobs j WHERE j.document_id=%s AND ' + eligible +
                        ' ORDER BY j.created_at FOR UPDATE SKIP LOCKED LIMIT 1', (row['document_id'],))
            job = cur.fetchone()
            if not job:
                return None
            if job['attempts'] >= 3:
                self._discard(cur, job['job_id'], 'failed', 'lease_expired_after_max_attempts')
                return None
            try:
                self._admin(cur, job['created_by'], local=job['local_ingestion'])
            except DocumentError:
                self._discard(cur, job['job_id'], 'failed', 'admin_permission_revoked')
                return None
            cur.execute("UPDATE public.rag_document_jobs SET state=CASE WHEN state='queued' THEN 'parsing' ELSE state END,"
                        'attempts=attempts+1,lease_token=%s,lease_until=clock_timestamp()+%s*interval \'1 second\','
                        'error_code=NULL WHERE job_id=%s RETURNING *', (str(uuid4()), seconds, job['job_id']))
            return dict(cur.fetchone())

    @staticmethod
    def _lease(cur, job_id, token):
        cur.execute('SELECT document_id FROM public.rag_document_jobs WHERE job_id=%s', (job_id,))
        row = cur.fetchone()
        if not row:
            raise DocumentError('job_lease_lost')
        cur.execute('SELECT 1 FROM public.rag_documents WHERE document_id=%s FOR UPDATE', (row['document_id'],))
        cur.execute('SELECT * FROM public.rag_document_jobs WHERE job_id=%s AND lease_token=%s '
                    'AND state=ANY(%s) AND lease_until>clock_timestamp() FOR UPDATE', (job_id, token, list(WORKING)))
        job = cur.fetchone()
        if not job:
            raise DocumentError('job_lease_lost')
        return job

    def claimed_job(self, job_id, token):
        with self.cursor() as cur:
            job = dict(self._lease(cur, job_id, token))
            self._admin(cur, job['created_by'], local=job['local_ingestion'])
            doc = self._document(cur, job['document_id'])
            if job['state'] != 'ready':
                doc.update(job['candidate_metadata'])
            doc['parser_version'] = job['parser_version']
            job['document'] = doc
            return job

    def heartbeat(self, job_id, token, seconds):
        with self.cursor() as cur:
            cur.execute('UPDATE public.rag_document_jobs SET lease_until=clock_timestamp()+%s*interval \'1 second\' '
                        'WHERE job_id=%s AND lease_token=%s AND state=ANY(%s) AND lease_until>clock_timestamp()',
                        (seconds, job_id, token, list(WORKING)))
            return cur.rowcount == 1

    def job_state(self, job_id):
        with self.cursor() as cur:
            cur.execute('SELECT state FROM public.rag_document_jobs WHERE job_id=%s', (job_id,))
            row = cur.fetchone()
            return row['state'] if row else None

    def progress(self, job_id):
        with self.cursor() as cur:
            cur.execute('SELECT j.state, (SELECT count(*) FROM public.welfare_document_vectors v WHERE v.job_id=j.job_id) '
                        'AS stored FROM public.rag_document_jobs j WHERE j.job_id=%s', (job_id,))
            return dict(cur.fetchone() or {})

    def fail(self, job_id, token, code):
        with self.cursor() as cur:
            try:
                job = self._lease(cur, job_id, token)
            except DocumentError:
                return
            self._discard(cur, job['job_id'], 'failed', code)

    def finish_analysis(self, job_id, token, analysis):
        with self.cursor() as cur:
            job = self._lease(cur, job_id, token)
            self._admin(cur, job['created_by'], local=job['local_ingestion'])
            if job['state'] != 'parsing':
                raise DocumentError('job_state_changed')
            if job['parse_config'].get('processing_mode') == 'automatic':
                from BackEnd.documents.contracts import automatic_source_fingerprint

                if analysis.get('blockers') or not analysis.get('blocks') or not analysis.get('markdown', '').strip():
                    raise DocumentError('analysis_quality_blocked')
                settings = get_settings()
                doc = self._document(cur, job['document_id'])
                candidate = {**doc, **job['candidate_metadata']}
                cur.execute('SELECT clock_timestamp() AS processed_at')
                processed_at = cur.fetchone()['processed_at'].isoformat()
                payload = {
                    'processing_mode': 'automatic', 'analysis_hash': stable_hash(analysis),
                    'source_fingerprint': automatic_source_fingerprint(candidate),
                    'source_file_sha256': candidate['file_sha256'], 'service_name': doc['service_name'],
                    'processed_at': processed_at,
                }
                config = {'processing_mode': 'automatic', 'payload': payload,
                          'embedding_model': settings.ollama_embed,
                          'tokenizer_revision': settings.rerank_model + '@' + settings.rerank_revision}
                # 같은 소유권으로 자동 청크·임베딩을 이어간다. 사람 검토 기록은 만들지 않는다.
                cur.execute('UPDATE public.rag_document_jobs SET candidate_analysis=%s,candidate_markdown=%s,'
                            'chunk_config=%s WHERE job_id=%s',
                            (Json(analysis), analysis['markdown'], Json(config), job_id))
                return
            cur.execute("UPDATE public.rag_document_jobs SET state='awaiting_review',candidate_analysis=%s,candidate_markdown=%s,"
                        'lease_token=NULL,lease_until=NULL WHERE job_id=%s', (Json(analysis), analysis['markdown'], job_id))

    def begin_embedding(self, job_id, token, model, digest):
        with self.cursor() as cur:
            job = self._lease(cur, job_id, token)
            if job['state'] == 'embedding':
                if (job['embedding_model'], job['embedding_digest']) != (model, digest):
                    raise DocumentError('embedding_identity_changed_create_new_job')
                return
            if (job['parse_config'].get('processing_mode') != 'automatic' or job['state'] != 'parsing'
                    or job['chunk_config'].get('processing_mode') != 'automatic'
                    or not job['chunk_config'].get('payload')):
                raise DocumentError('automatic_analysis_required')
            if job['chunk_config']['embedding_model'] != model:
                raise DocumentError('embedding_identity_changed_create_new_job')
            cur.execute("UPDATE public.rag_document_jobs SET state='embedding',embedding_model=%s,embedding_digest=%s "
                        'WHERE job_id=%s', (model, digest, job_id))

    def reused_vectors(self, model, digest, hashes):
        if not hashes:
            return {}
        with self.cursor() as cur:
            cur.execute('SELECT DISTINCT ON(v.input_hash) v.input_hash,v.embedding::text FROM public.welfare_document_vectors v '
                        'JOIN public.rag_documents d ON d.document_id=v.document_id AND d.active_job_id=v.job_id '
                        'JOIN public.rag_document_jobs j ON j.job_id=v.job_id '
                        "WHERE j.state='succeeded' AND v.embedding_model=%s AND v.embedding_digest=%s "
                        'AND v.input_hash=ANY(%s) ORDER BY v.input_hash', (model, digest, hashes))
            return {r['input_hash']: json.loads(r['embedding']) for r in cur.fetchall()}

    def save_vectors(self, job_id, token, document_id, records, vectors, model, digest):
        validate_embeddings(list(vectors.values()), len(records), 1024)
        with self.cursor() as cur:
            job = self._lease(cur, job_id, token)
            self._admin(cur, job['created_by'], local=job['local_ingestion'])
            if str(job['document_id']) != str(document_id) or job['state'] != 'embedding':
                raise DocumentError('job_document_or_state_mismatch')
            if (job['embedding_model'], job['embedding_digest']) != (model, digest):
                raise DocumentError('embedding_identity_changed_create_new_job')
            values=[]
            for r in records:
                c=r['chunk']
                values.append((document_id,job_id,r['chunk_index'],c.text,c.embedding_text(),
                               '['+','.join(str(x) for x in vectors[c.chunk_id])+']',model,digest,
                               stable_hash(c.embedding_text().encode()),[c.section,*c.heading_context.splitlines()],
                               r['page_start'],r['page_end'],
                               r['char_start'],r['char_end'],len(c.text),r['token_count'],r['overlap_chars'],r['overlap_tokens'],
                               Json(r['source_spans']),Json({'chunk':json.loads(c.storage())})))
            execute_values(cur, 'INSERT INTO public.welfare_document_vectors(document_id,job_id,chunk_index,chunk_content,'
                           'embedding_text,embedding,embedding_model,embedding_digest,input_hash,section_path,page_start,page_end,'
                           'char_start,char_end,char_count,token_count,overlap_chars,overlap_tokens,source_spans,evidence_metadata) '
                           'VALUES %s ON CONFLICT(job_id,chunk_index) DO UPDATE SET chunk_content=EXCLUDED.chunk_content,'
                           'embedding_text=EXCLUDED.embedding_text,embedding=EXCLUDED.embedding,embedding_model=EXCLUDED.embedding_model,'
                           'embedding_digest=EXCLUDED.embedding_digest,input_hash=EXCLUDED.input_hash,section_path=EXCLUDED.section_path,'
                           'page_start=EXCLUDED.page_start,page_end=EXCLUDED.page_end,char_start=EXCLUDED.char_start,char_end=EXCLUDED.char_end,'
                           'char_count=EXCLUDED.char_count,token_count=EXCLUDED.token_count,overlap_chars=EXCLUDED.overlap_chars,'
                           'overlap_tokens=EXCLUDED.overlap_tokens,source_spans=EXCLUDED.source_spans,evidence_metadata=EXCLUDED.evidence_metadata',
                           values, template='(%s,%s,%s,%s,%s,%s::public.vector,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s)')

    def activate(self, job_id, token):
        from BackEnd.documents.retrieval import validate_document_vectors

        with self.cursor() as cur:
            job = self._lease(cur, job_id, token)
            self._admin(cur, job['created_by'], local=job['local_ingestion'])
            if job['parse_config'].get('processing_mode') != 'automatic':
                self._admin(cur, job['reviewed_by'], local=job['local_ingestion'])
            doc=self._document(cur,job['document_id'])
            # 제도 이름도 실제 임베딩 입력이므로 게시 중 바뀌지 않도록 공유 잠금을 잡는다.
            cur.execute('SELECT p.program_name,p.test_only,' + SERVICE_ID + ' AS service_id '
                        'FROM public.welfare_programs p WHERE p.program_id=%s FOR SHARE',(doc['program_id'],))
            program = cur.fetchone()
            if (program['program_name'] != job['chunk_config']['payload']['service_name']
                    or program['service_id'] != job['candidate_metadata'].get('service_id')):
                raise DocumentError('linked_service_changed_create_new_job')
            if str(job['expected_active_job_id'] or '') != str(doc['active_job_id'] or ''):
                raise DocumentError('active_document_changed_create_new_job')
            doc.update(service_id=program['service_id'],service_name=program['program_name'],
                       program_test_only=program['test_only'])
            candidate_year = job['candidate_metadata'].get('basis_year')
            if doc['active_job_id'] and doc['basis_year'] and candidate_year and int(candidate_year) < doc['basis_year']:
                raise DocumentError('older_basis_rejected')
            cur.execute('SELECT * FROM public.welfare_document_vectors WHERE job_id=%s ORDER BY chunk_index',(job_id,))
            rows=cur.fetchall()
            source={**doc,**job['candidate_metadata'], 'markdown':job['candidate_markdown'],
                    'analysis_json':job['candidate_analysis'], 'reviewed_by':job['reviewed_by'],
                    'reviewed_at':job['reviewed_at'], 'local_ingestion':job['local_ingestion']}
            validate_document_vectors(source,job,rows)
            if job['state']=='embedding':
                cur.execute("UPDATE public.rag_document_jobs SET state='ready' WHERE job_id=%s",(job_id,))
            elif job['state']!='ready':
                raise DocumentError('job_not_ready')
            # 현재 원문·작업·벡터를 직접 갱신하지 않는다. CAS 비교와 이전 자료 정리는 DB가 수행한다.
            cur.execute('SELECT public.welfare_publish_document(%s,%s)',(job_id,token))


def get_document_store():
    return DocumentStore(lambda: connect(get_settings()))
