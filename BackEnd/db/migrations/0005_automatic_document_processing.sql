-- 자동 문서 처리 계약 초안. 사용자가 검토 후 직접 적용하며 앱은 실행하지 않는다.
-- 기존 8테이블·97컬럼과 원자 게시 경로를 유지한다. 기존 데이터·대기 작업은 수정하지 않는다.
-- 기존 수동 검토 기록은 그대로 보존한다. 과거 대기 작업은 취소 후 재업로드해야 자동 처리된다.
-- 신규 automatic 작업은 reviewed_by/reviewed_at을 NULL로 유지하고 원본·분석·처리 설정을 검증한다.
BEGIN;

ALTER TABLE public.rag_documents DROP CONSTRAINT rag_documents_current_fields_check;
ALTER TABLE public.rag_documents ADD CONSTRAINT rag_documents_current_fields_check CHECK (
    active_job_id IS NULL OR (
        file_sha256 IS NOT NULL AND file_format IS NOT NULL AND original_bytes IS NOT NULL
        AND markdown IS NOT NULL AND length(btrim(markdown)) > 0 AND analysis_json IS NOT NULL
        AND (local_ingestion OR uploaded_by IS NOT NULL)
        AND ((reviewed_at IS NULL AND reviewed_by IS NULL)
             OR (reviewed_at IS NOT NULL AND (local_ingestion OR reviewed_by IS NOT NULL)))
    )
);
-- 기존 문서 guard가 active_job_id의 성공 작업과 검토 필드를 대조한다.
-- 아래 작업 CHECK가 수동 작업의 기존 검토 필수 조건을 유지하므로 NULL 허용은 자동 작업에 한정된다.
ALTER TABLE public.rag_document_jobs DROP CONSTRAINT rag_document_jobs_review_check;
ALTER TABLE public.rag_document_jobs ADD CONSTRAINT rag_document_jobs_review_check CHECK (
    (coalesce(parse_config->>'processing_mode', 'manual') <> 'automatic'
        OR (reviewed_by IS NULL AND reviewed_at IS NULL))
    AND (state NOT IN ('embedding','ready','succeeded') OR (
        parser_version IS NOT NULL AND length(btrim(parser_version)) > 0
        AND embedding_model IS NOT NULL AND embedding_digest IS NOT NULL
        AND (
            (coalesce(parse_config->>'processing_mode', 'manual') = 'automatic'
                AND coalesce(chunk_config->>'processing_mode', '') = 'automatic'
                AND coalesce(chunk_config->'payload'->>'processing_mode', '') = 'automatic'
                AND coalesce(chunk_config->>'embedding_model', '') = embedding_model
                AND length(coalesce(chunk_config->>'tokenizer_revision', '')) > 0
                AND coalesce(chunk_config->'payload'->>'analysis_hash', '') ~ '^[0-9a-f]{64}$'
                AND coalesce(chunk_config->'payload'->>'source_fingerprint', '') ~ '^[0-9a-f]{64}$'
                AND coalesce(chunk_config->'payload'->>'source_file_sha256', '') ~ '^[0-9a-f]{64}$'
                AND length(coalesce(chunk_config->'payload'->>'processed_at', '')) > 0
                AND reviewed_by IS NULL AND reviewed_at IS NULL)
            OR (coalesce(parse_config->>'processing_mode', 'manual') <> 'automatic'
                AND reviewed_at IS NOT NULL AND (reviewed_by IS NOT NULL OR local_ingestion))
        )
    ))
);

CREATE OR REPLACE FUNCTION public.welfare_guard_job()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $job$
DECLARE
    allowed_states text[];
    mutable_fields text[] := ARRAY[
        'state','attempts','available_at','lease_token','lease_until','error_code','finished_at',
        'candidate_metadata','candidate_original','candidate_markdown','candidate_analysis','expected_active_job_id'
    ];
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.state <> 'queued' THEN RAISE EXCEPTION '새 작업은 queued 상태로 시작해야 합니다.'; END IF;
        RETURN NEW;
    END IF;
    IF EXISTS (SELECT 1 FROM public.rag_documents WHERE active_job_id = OLD.job_id) THEN
        IF TG_OP = 'DELETE' THEN
            RAISE EXCEPTION '현재 검색 작업은 문서 교체 또는 문서 삭제로 정리하세요.';
        END IF;
        IF NEW IS DISTINCT FROM OLD THEN RAISE EXCEPTION '현재 검색 작업의 설정은 변경할 수 없습니다.'; END IF;
        RETURN NEW;
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    IF NEW.job_id IS DISTINCT FROM OLD.job_id OR NEW.document_id IS DISTINCT FROM OLD.document_id THEN
        RAISE EXCEPTION '작업 ID와 문서 소속은 변경할 수 없습니다.';
    END IF;
    IF NEW.parse_config IS DISTINCT FROM OLD.parse_config THEN
        RAISE EXCEPTION 'parse_config_is_immutable_create_new_job';
    END IF;
    IF OLD.state IN ('succeeded','failed','cancelled') AND NEW IS DISTINCT FROM OLD THEN
        RAISE EXCEPTION '종료된 작업의 재시도는 새 작업으로 등록하세요.';
    END IF;
    allowed_states := CASE OLD.state
        WHEN 'queued' THEN ARRAY['queued','parsing','failed','cancelled']
        WHEN 'parsing' THEN CASE WHEN OLD.parse_config->>'processing_mode' = 'automatic'
            THEN ARRAY['parsing','embedding','failed','cancelled']
            ELSE ARRAY['parsing','awaiting_review','failed','cancelled'] END
        WHEN 'awaiting_review' THEN ARRAY['awaiting_review','embedding','failed','cancelled']
        WHEN 'embedding' THEN ARRAY['embedding','ready','failed','cancelled']
        WHEN 'ready' THEN ARRAY['ready','succeeded','failed','cancelled']
        ELSE ARRAY[OLD.state] END;
    IF NOT (NEW.state = ANY(allowed_states)) THEN
        RAISE EXCEPTION '허용되지 않은 작업 상태 전환: % -> %', OLD.state, NEW.state;
    END IF;
    -- 실패·취소는 검토 후보를 변경하는 대신 비워야 한다. 현재 성공 작업의 불변성은 위에서 검사한다.
    IF NEW.state IN ('failed','cancelled') AND (
        NEW.candidate_metadata <> '{}'::jsonb OR NEW.candidate_original IS NOT NULL
        OR NEW.candidate_markdown IS NOT NULL OR NEW.candidate_analysis IS NOT NULL
        OR NEW.expected_active_job_id IS NOT NULL OR NEW.lease_token IS NOT NULL OR NEW.lease_until IS NOT NULL
    ) THEN
        RAISE EXCEPTION '실패·취소 작업의 후보 원문과 임시 자료를 비우세요.';
    END IF;
    IF OLD.state IN ('embedding','ready') THEN
        IF (to_jsonb(NEW)-mutable_fields) IS DISTINCT FROM (to_jsonb(OLD)-mutable_fields) THEN
            RAISE EXCEPTION '검토 완료 후 모델·설정·검토자를 바꿀 수 없습니다.';
        END IF;
        IF NEW.state NOT IN ('succeeded','failed','cancelled') AND (
            NEW.candidate_metadata IS DISTINCT FROM OLD.candidate_metadata
            OR NEW.candidate_original IS DISTINCT FROM OLD.candidate_original
            OR NEW.candidate_markdown IS DISTINCT FROM OLD.candidate_markdown
            OR NEW.candidate_analysis IS DISTINCT FROM OLD.candidate_analysis
            OR NEW.expected_active_job_id IS DISTINCT FROM OLD.expected_active_job_id
        ) THEN
            RAISE EXCEPTION '검토한 후보를 변경하지 말고 새 작업을 등록하세요.';
        END IF;
    END IF;
    RETURN NEW;
END;
$job$;

CREATE OR REPLACE FUNCTION public.welfare_publish_document(p_job_id uuid,p_lease_token uuid)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = ''
AS $publish$
DECLARE
    target_document uuid;
    current_document public.rag_documents%ROWTYPE;
    candidate_job public.rag_document_jobs%ROWTYPE;
    metadata jsonb;
    chunk_count bigint;
    first_chunk integer;
    last_chunk integer;
    metadata_key text;
BEGIN
    SELECT document_id INTO target_document FROM public.rag_document_jobs WHERE job_id = p_job_id;
    IF NOT FOUND THEN RAISE EXCEPTION '작업이 없습니다.'; END IF;
    -- 잠금 순서는 문서 -> 작업이다. 동일 문서의 동시 교체를 직렬화한다.
    SELECT * INTO current_document FROM public.rag_documents
    WHERE document_id = target_document FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION '문서가 없습니다.'; END IF;
    SELECT * INTO candidate_job FROM public.rag_document_jobs WHERE job_id = p_job_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION '작업이 삭제되었습니다.'; END IF;
    IF candidate_job.state = 'succeeded' AND current_document.active_job_id = p_job_id THEN
        RETURN target_document;
    END IF;
    IF candidate_job.state <> 'ready' OR p_lease_token IS NULL
       OR candidate_job.lease_token IS DISTINCT FROM p_lease_token
       OR candidate_job.lease_until IS NULL OR candidate_job.lease_until <= clock_timestamp() THEN
        RAISE EXCEPTION 'ready 상태와 유효한 작업 소유권이 필요합니다.';
    END IF;
    IF candidate_job.expected_active_job_id IS DISTINCT FROM current_document.active_job_id THEN
        RAISE EXCEPTION '현재 문서가 다른 작업으로 바뀌었습니다. 새 작업으로 다시 검토하세요.';
    END IF;
    IF NOT candidate_job.local_ingestion THEN
        PERFORM 1 FROM public.rag_document_admins
        WHERE user_id = candidate_job.created_by AND active FOR SHARE;
        IF NOT FOUND THEN RAISE EXCEPTION '작업 요청자의 문서 관리자 권한이 없습니다.'; END IF;
        IF coalesce(candidate_job.parse_config->>'processing_mode','manual') <> 'automatic' THEN
            PERFORM 1 FROM public.rag_document_admins
            WHERE user_id = candidate_job.reviewed_by AND active FOR SHARE;
            IF NOT FOUND THEN RAISE EXCEPTION '검토자의 문서 관리자 권한이 없습니다.'; END IF;
        END IF;
    END IF;
    metadata := candidate_job.candidate_metadata;
    FOREACH metadata_key IN ARRAY ARRAY['document_name','source_url','source_organization','file_sha256','file_format'] LOOP
        IF jsonb_typeof(metadata->metadata_key) IS DISTINCT FROM 'string'
           OR length(btrim(metadata->>metadata_key)) = 0 THEN
            RAISE EXCEPTION '필수 후보 메타데이터가 없거나 잘못되었습니다: %', metadata_key;
        END IF;
    END LOOP;
    IF jsonb_typeof(metadata->'test_only') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'candidate_metadata.test_only는 boolean이어야 합니다.';
    END IF;
    IF metadata->>'file_sha256' IS DISTINCT FROM encode(sha256(candidate_job.candidate_original),'hex') THEN
        RAISE EXCEPTION '후보 원본 해시가 일치하지 않습니다.';
    END IF;
    IF candidate_job.parse_config->>'processing_mode' = 'automatic' THEN
        IF candidate_job.reviewed_by IS NOT NULL OR candidate_job.reviewed_at IS NOT NULL
           OR candidate_job.chunk_config->'payload'->>'source_file_sha256' IS DISTINCT FROM metadata->>'file_sha256'
           OR (candidate_job.chunk_config->'payload'->>'processed_at')::timestamptz < candidate_job.created_at
           OR (candidate_job.chunk_config->'payload'->>'processed_at')::timestamptz > clock_timestamp() THEN
            RAISE EXCEPTION 'automatic_processing_provenance_mismatch';
        END IF;
    END IF;
    SELECT count(*),min(chunk_index),max(chunk_index) INTO chunk_count,first_chunk,last_chunk
    FROM public.welfare_document_vectors WHERE job_id = p_job_id;
    IF chunk_count = 0 OR first_chunk <> 0 OR last_chunk <> chunk_count - 1 THEN
        RAISE EXCEPTION '청크 순번은 0부터 누락 없이 연속되어야 합니다.';
    END IF;
    IF EXISTS (
        SELECT 1 FROM public.welfare_document_vectors
        WHERE job_id = p_job_id AND (
            document_id <> target_document
            OR embedding_model IS DISTINCT FROM candidate_job.embedding_model
            OR embedding_digest IS DISTINCT FROM candidate_job.embedding_digest
            OR char_end > char_length(candidate_job.candidate_markdown)
        )
    ) THEN RAISE EXCEPTION '청크 소속·모델·원문 범위가 일치하지 않습니다.'; END IF;
    IF candidate_job.lease_until <= clock_timestamp() THEN RAISE EXCEPTION '작업 소유권이 만료되었습니다.'; END IF;

    -- 지역 변수에는 후보를 유지하고, DB 작업 행에는 이전 원문 사본을 남기지 않는다.
    UPDATE public.rag_document_jobs
    SET state = 'succeeded',finished_at = clock_timestamp(),error_code = NULL,
        lease_token = NULL,lease_until = NULL,expected_active_job_id = NULL,
        candidate_metadata = '{}'::jsonb,candidate_original = NULL,
        candidate_markdown = NULL,candidate_analysis = NULL
    WHERE job_id = p_job_id;

    UPDATE public.rag_documents
    SET document_name = metadata->>'document_name',source_url = metadata->>'source_url',
        source_organization = metadata->>'source_organization',
        source_updated_at = (metadata->>'source_updated_at')::date,
        basis_year = (metadata->>'basis_year')::smallint,
        valid_from = (metadata->>'valid_from')::date,valid_until = (metadata->>'valid_until')::date,
        region_scope = metadata->>'region_scope',test_only = (metadata->>'test_only')::boolean,
        file_sha256 = metadata->>'file_sha256',file_format = metadata->>'file_format',
        original_bytes = candidate_job.candidate_original,markdown = candidate_job.candidate_markdown,
        analysis_json = candidate_job.candidate_analysis,uploaded_by = candidate_job.created_by,
        reviewed_by = candidate_job.reviewed_by,reviewed_at = candidate_job.reviewed_at,
        local_ingestion = candidate_job.local_ingestion,active_job_id = p_job_id
    WHERE document_id = target_document;

    -- 이 문서의 이전 작업·후보 원본·청크·벡터를 함께 제거한다. 다른 문서는 유지한다.
    DELETE FROM public.rag_document_jobs WHERE document_id = target_document AND job_id <> p_job_id;
    RETURN target_document;
END;
$publish$;

CREATE OR REPLACE FUNCTION public.welfare_document_processing_contract()
RETURNS text LANGUAGE sql IMMUTABLE SECURITY INVOKER SET search_path = ''
AS $$ SELECT 'automatic-v1'::text; $$;
REVOKE ALL ON FUNCTION public.welfare_document_processing_contract() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.welfare_document_processing_contract() TO service_role;

COMMIT;
