-- Supabase SQL Editor에서 파일 전체를 한 번 실행한다. 0001/0002와 public.vector가 사전에 필요하다.
-- 보강 ERD의 5테이블·33컬럼을 생성하고 TEST_ 이외의 기존 CSV 서비스와 overview 벡터만 복사한다.
-- 기존 6테이블의 자료·권한과 API 저장소는 변경하지 않는다. rag_document_* 원문·MD·이력도 복사하지 않는다.
-- 사용자 정보·대화 본문·월별 집계 테이블과 벡터 근사 인덱스는 추가하지 않는다.
-- 실행 중 원본 2테이블의 쓰기를 잠근다. 실패하면 전체 롤백하며, 성공 후 최종 SELECT에 대조 결과가 나온다.
BEGIN;
SET LOCAL lock_timeout = '10s';
SET LOCAL search_path = pg_catalog, public;

DO $preflight$
DECLARE
    target_name TEXT;
    role_name TEXT;
BEGIN
    IF NOT pg_try_advisory_xact_lock(188904002, 3) THEN
        RAISE EXCEPTION '0003 이관이 다른 세션에서 실행 중입니다.';
    END IF;
    FOREACH target_name IN ARRAY ARRAY[
        'departments', 'welfare_programs', 'welfare_document_vectors',
        'counselors', 'counselor_connections'
    ] LOOP
        IF to_regclass(format('public.%I', target_name)) IS NOT NULL THEN
            RAISE EXCEPTION '대상 public.%가 이미 존재합니다. 재실행하거나 기존 표를 덮어쓰지 않습니다.', target_name;
        END IF;
    END LOOP;
    IF to_regprocedure('public.refresh_welfare_programs_updated_at()') IS NOT NULL THEN
        RAISE EXCEPTION 'updated_at 함수가 이미 존재합니다. 기존 함수를 덮어쓰지 않습니다.';
    END IF;
    IF to_regtype('public.vector') IS NULL THEN
        RAISE EXCEPTION 'public.vector 확장이 먼저 필요합니다.';
    END IF;
    FOREACH target_name IN ARRAY ARRAY[
        'welfare_services', 'welfare_chunks', 'rag_document_admins',
        'rag_documents', 'rag_document_jobs', 'rag_document_chunks'
    ] LOOP
        IF to_regclass(format('public.%I', target_name)) IS NULL THEN
            RAISE EXCEPTION '기존 public.%가 없습니다. 선행 스키마와 0001/0002를 확인하세요.', target_name;
        END IF;
    END LOOP;
    FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated', 'service_role'] LOOP
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
            RAISE EXCEPTION '필수 DB 역할 %가 없습니다.', role_name;
        END IF;
    END LOOP;
    IF NOT (SELECT rolbypassrls FROM pg_roles WHERE rolname = 'service_role')
        OR NOT has_schema_privilege('service_role', 'public', 'USAGE') THEN
        RAISE EXCEPTION 'service_role의 RLS 우회와 public 스키마 USAGE 권한을 확인하세요.';
    END IF;
END;
$preflight$;

-- 잠금을 얻은 뒤 스냅샷을 만든다. 잠금 대기가 10초를 넘으면 변경 없이 중단한다.
LOCK TABLE public.welfare_services, public.welfare_chunks IN SHARE MODE;
CREATE TEMP TABLE _welfare_erd_services ON COMMIT DROP AS
SELECT service_id, name, summary, ministry, department, url, contacts, source_updated_at, synced_at
FROM public.welfare_services
WHERE left(service_id, 5) <> 'TEST_';

CREATE TEMP TABLE _welfare_erd_chunks ON COMMIT DROP AS
SELECT c.chunk_id, c.service_id, c.content, c.embedding, c.embed_model
FROM public.welfare_chunks c
JOIN pg_temp._welfare_erd_services s USING (service_id)
WHERE left(c.chunk_id, 5) <> 'TEST_';

DO $source_check$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_temp._welfare_erd_services)
        OR NOT EXISTS (SELECT 1 FROM pg_temp._welfare_erd_chunks) THEN
        RAISE EXCEPTION '공식 서비스 또는 벡터 스냅샷이 비어 있습니다.';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_temp._welfare_erd_services
        WHERE service_id IS NULL OR name IS NULL OR length(name) > 200
            OR ministry IS NULL OR department IS NULL OR length(department) > 150
            OR summary IS NULL OR url IS NULL OR contacts IS NULL OR synced_at IS NULL
    ) THEN
        RAISE EXCEPTION '원본 서비스의 필수 필드 또는 VARCHAR 길이가 대상 정의와 맞지 않습니다.';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_temp._welfare_erd_chunks
        WHERE chunk_id IS NULL OR content IS NULL OR embedding IS NULL
            OR embed_model IS DISTINCT FROM 'bge-m3' OR public.vector_dims(embedding) <> 1024
    ) THEN
        RAISE EXCEPTION '원본 벡터의 필수 값, bge-m3 모델 또는 1024차원 조건이 맞지 않습니다.';
    END IF;
    -- 미래에 추가된 상세·문서 청크를 CSV 요약으로 오인하지 않도록 기존 생성 형식도 확인한다.
    IF EXISTS (
        SELECT 1 FROM pg_temp._welfare_erd_chunks c
        JOIN pg_temp._welfare_erd_services s USING (service_id)
        WHERE c.chunk_id IS DISTINCT FROM s.service_id || ':overview'
            OR c.content IS DISTINCT FROM '서비스명: ' || s.name || E'\n분류: '
                || concat_ws(' > ', nullif(s.ministry, ''), nullif(s.department, ''))
                || E'\n요약: ' || s.summary
    ) THEN
        RAISE EXCEPTION '기존 CSV overview 이외의 청크가 있습니다. 출처를 별도로 검토한 뒤 이관하세요.';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_temp._welfare_erd_services s
        WHERE NOT EXISTS (SELECT 1 FROM pg_temp._welfare_erd_chunks c WHERE c.service_id = s.service_id)
    ) THEN
        RAISE EXCEPTION 'overview 벡터가 없는 공식 서비스가 있습니다.';
    END IF;
END;
$source_check$;

CREATE TABLE public.departments (
    department_id BIGSERIAL PRIMARY KEY,
    department_name VARCHAR(150) NOT NULL,
    ministry_name TEXT NOT NULL,
    CONSTRAINT departments_ministry_department_unique UNIQUE (ministry_name, department_name)
);

CREATE TABLE public.welfare_programs (
    program_id BIGSERIAL PRIMARY KEY,
    program_name VARCHAR(200) NOT NULL,
    eligibility TEXT,
    benefit_details TEXT,
    application_method TEXT,
    department_id BIGINT NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    external_service_id TEXT UNIQUE,
    summary TEXT,
    source_url TEXT,
    contacts JSONB NOT NULL DEFAULT '[]'::jsonb,
    source_updated_at DATE,
    CONSTRAINT welfare_programs_department_id_fkey
        FOREIGN KEY (department_id) REFERENCES public.departments(department_id) ON DELETE RESTRICT
);

CREATE TABLE public.welfare_document_vectors (
    vector_id BIGSERIAL PRIMARY KEY,
    program_id BIGINT NOT NULL,
    chunk_content TEXT NOT NULL,
    embedding public.vector NOT NULL,
    source_reference TEXT NOT NULL,
    chunk_key TEXT UNIQUE,
    embedding_model TEXT NOT NULL,
    embedding_digest TEXT,
    evidence_metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    CONSTRAINT welfare_document_vectors_program_id_fkey
        FOREIGN KEY (program_id) REFERENCES public.welfare_programs(program_id) ON DELETE CASCADE,
    CONSTRAINT welfare_document_vectors_embedding_dims_check CHECK (public.vector_dims(embedding) = 1024),
    CONSTRAINT welfare_document_vectors_embedding_model_check CHECK (length(btrim(embedding_model)) > 0)
);

CREATE TABLE public.counselors (
    counselor_id BIGSERIAL PRIMARY KEY,
    counselor_name VARCHAR(100) NOT NULL,
    department_id BIGINT NOT NULL,
    phone_number VARCHAR(30) NOT NULL,
    CONSTRAINT counselors_department_id_fkey
        FOREIGN KEY (department_id) REFERENCES public.departments(department_id) ON DELETE RESTRICT
);

CREATE TABLE public.counselor_connections (
    connection_id BIGSERIAL PRIMARY KEY,
    counselor_id BIGINT NOT NULL,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    connection_status VARCHAR(20) NOT NULL DEFAULT 'requested',
    confirmed_at TIMESTAMPTZ,
    CONSTRAINT counselor_connections_counselor_id_fkey
        FOREIGN KEY (counselor_id) REFERENCES public.counselors(counselor_id) ON DELETE RESTRICT,
    CONSTRAINT counselor_connections_status_check
        CHECK (connection_status IN ('requested', 'connected', 'failed', 'cancelled')),
    CONSTRAINT counselor_connections_confirmation_check
        CHECK ((connection_status = 'connected') = (confirmed_at IS NOT NULL)),
    CONSTRAINT counselor_connections_time_order_check
        CHECK (confirmed_at IS NULL OR confirmed_at >= requested_at)
);

-- FK 삭제 검사와 연결 조회에 사용한다. vector 타입은 차원 없는 원본 선언을 유지한다.
CREATE INDEX welfare_programs_department_id_idx ON public.welfare_programs(department_id);
CREATE INDEX welfare_document_vectors_program_id_idx ON public.welfare_document_vectors(program_id);
CREATE INDEX counselors_department_id_idx ON public.counselors(department_id);
CREATE INDEX counselor_connections_counselor_id_idx ON public.counselor_connections(counselor_id);

CREATE FUNCTION public.refresh_welfare_programs_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = ''
AS $function$
BEGIN
    NEW.updated_at := CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$function$;

CREATE TRIGGER welfare_programs_refresh_updated_at
BEFORE UPDATE ON public.welfare_programs
FOR EACH ROW EXECUTE FUNCTION public.refresh_welfare_programs_updated_at();

ALTER TABLE public.departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.welfare_programs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.welfare_document_vectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.counselors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.counselor_connections ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON public.departments,public.welfare_programs,public.welfare_document_vectors,
    public.counselors,public.counselor_connections FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.departments,public.welfare_programs,public.welfare_document_vectors,
    public.counselors,public.counselor_connections TO service_role;

REVOKE ALL ON SEQUENCE public.departments_department_id_seq,public.welfare_programs_program_id_seq,
    public.welfare_document_vectors_vector_id_seq,public.counselors_counselor_id_seq,
    public.counselor_connections_connection_id_seq FROM PUBLIC,anon,authenticated;
GRANT USAGE,SELECT ON SEQUENCE public.departments_department_id_seq,public.welfare_programs_program_id_seq,
    public.welfare_document_vectors_vector_id_seq,public.counselors_counselor_id_seq,
    public.counselor_connections_connection_id_seq TO service_role;

REVOKE ALL ON FUNCTION public.refresh_welfare_programs_updated_at() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_welfare_programs_updated_at() TO service_role;

INSERT INTO public.departments (ministry_name, department_name)
SELECT DISTINCT ministry, department FROM pg_temp._welfare_erd_services
ORDER BY ministry, department;

-- 요약을 상세 자격·혜택·신청 방법으로 대체하지 않는다. INSERT에는 수정시각 트리거가 적용되지 않는다.
INSERT INTO public.welfare_programs (
    program_name, eligibility, benefit_details, application_method, department_id, updated_at,
    external_service_id, summary, source_url, contacts, source_updated_at
)
SELECT s.name, NULL, NULL, NULL, d.department_id, s.synced_at,
    s.service_id, s.summary, s.url, s.contacts, s.source_updated_at
FROM pg_temp._welfare_erd_services s
JOIN public.departments d ON d.ministry_name = s.ministry AND d.department_name = s.department
ORDER BY s.service_id;

INSERT INTO public.welfare_document_vectors (
    program_id, chunk_content, embedding, source_reference, chunk_key,
    embedding_model, embedding_digest, evidence_metadata
)
SELECT p.program_id, c.content, c.embedding, s.url, c.chunk_id, c.embed_model, NULL,
    jsonb_build_object(
        'source_kind', 'csv_summary', 'detail_eligible', false,
        'legacy_table', 'public.welfare_chunks',
        'legacy_service_id', c.service_id, 'legacy_chunk_id', c.chunk_id,
        'source_url', s.url, 'source_updated_at', s.source_updated_at
    )
FROM pg_temp._welfare_erd_chunks c
JOIN pg_temp._welfare_erd_services s USING (service_id)
JOIN public.welfare_programs p ON p.external_service_id = c.service_id
ORDER BY c.chunk_id;

DO $verify$
DECLARE
    target_name TEXT;
    role_name TEXT;
    sequence_oid OID;
BEGIN
    IF (SELECT count(*) FROM public.departments) <>
            (SELECT count(*) FROM (SELECT DISTINCT ministry, department FROM pg_temp._welfare_erd_services) d)
        OR (SELECT count(*) FROM public.welfare_programs) <> (SELECT count(*) FROM pg_temp._welfare_erd_services)
        OR (SELECT count(*) FROM public.welfare_document_vectors) <> (SELECT count(*) FROM pg_temp._welfare_erd_chunks)
        OR EXISTS (SELECT 1 FROM public.counselors)
        OR EXISTS (SELECT 1 FROM public.counselor_connections) THEN
        RAISE EXCEPTION '이관 건수 대조 실패: 전체 변경을 롤백합니다.';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_temp._welfare_erd_services s
        LEFT JOIN public.welfare_programs p ON p.external_service_id = s.service_id
        LEFT JOIN public.departments d ON d.department_id = p.department_id
        WHERE p.program_id IS NULL OR d.department_id IS NULL
            OR ROW(p.program_name, p.summary, d.ministry_name, d.department_name, p.source_url,
                p.contacts, p.source_updated_at, p.updated_at)
                IS DISTINCT FROM ROW(s.name, s.summary, s.ministry, s.department, s.url,
                    s.contacts, s.source_updated_at, s.synced_at)
            OR p.eligibility IS NOT NULL OR p.benefit_details IS NOT NULL OR p.application_method IS NOT NULL
    ) THEN
        RAISE EXCEPTION '서비스 필드 또는 상세 NULL 대조 실패: 전체 변경을 롤백합니다.';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_temp._welfare_erd_chunks c
        JOIN pg_temp._welfare_erd_services s USING (service_id)
        LEFT JOIN public.welfare_document_vectors v ON v.chunk_key = c.chunk_id
        LEFT JOIN public.welfare_programs p ON p.program_id = v.program_id
        WHERE v.vector_id IS NULL OR p.external_service_id IS DISTINCT FROM c.service_id
            OR v.chunk_content IS DISTINCT FROM c.content
            OR v.embedding IS DISTINCT FROM c.embedding
            OR v.embedding_model IS DISTINCT FROM c.embed_model
            OR v.embedding_digest IS NOT NULL
            OR v.source_reference IS DISTINCT FROM s.url
            OR v.evidence_metadata IS DISTINCT FROM jsonb_build_object(
                'source_kind', 'csv_summary', 'detail_eligible', false,
                'legacy_table', 'public.welfare_chunks',
                'legacy_service_id', c.service_id, 'legacy_chunk_id', c.chunk_id,
                'source_url', s.url, 'source_updated_at', s.source_updated_at
            )
    ) THEN
        RAISE EXCEPTION '벡터 값·본문·모델·출처 대조 실패: 전체 변경을 롤백합니다.';
    END IF;
    FOREACH target_name IN ARRAY ARRAY[
        'departments', 'welfare_programs', 'welfare_document_vectors',
        'counselors', 'counselor_connections'
    ] LOOP
        IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = to_regclass('public.' || target_name)) THEN
            RAISE EXCEPTION '새 테이블 %의 RLS가 꺼져 있습니다.', target_name;
        END IF;
        SELECT seqrelid INTO STRICT sequence_oid
        FROM pg_sequence WHERE seqrelid = pg_get_serial_sequence(
            'public.' || target_name,
            CASE target_name
                WHEN 'departments' THEN 'department_id'
                WHEN 'welfare_programs' THEN 'program_id'
                WHEN 'welfare_document_vectors' THEN 'vector_id'
                WHEN 'counselors' THEN 'counselor_id'
                ELSE 'connection_id'
            END
        )::regclass;
        FOREACH role_name IN ARRAY ARRAY['anon', 'authenticated'] LOOP
            IF has_table_privilege(role_name, 'public.' || target_name,
                'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
                OR has_sequence_privilege(role_name, sequence_oid, 'USAGE,SELECT,UPDATE') THEN
                RAISE EXCEPTION '%에 새 테이블 % 또는 시퀀스 접근권한이 남았습니다.', role_name, target_name;
            END IF;
        END LOOP;
        IF NOT (has_table_privilege('service_role', 'public.' || target_name, 'SELECT')
            AND has_table_privilege('service_role', 'public.' || target_name, 'INSERT')
            AND has_table_privilege('service_role', 'public.' || target_name, 'UPDATE')
            AND has_table_privilege('service_role', 'public.' || target_name, 'DELETE')
            AND has_sequence_privilege('service_role', sequence_oid, 'USAGE')
            AND has_sequence_privilege('service_role', sequence_oid, 'SELECT')) THEN
            RAISE EXCEPTION 'service_role의 % 또는 시퀀스 권한이 부족합니다.', target_name;
        END IF;
    END LOOP;
END;
$verify$;

-- 스냅샷은 커밋 때 제거한다. 결과만 세션 임시 표에 남겨 COMMIT 성공 후 마지막 SELECT로 반환한다.
CREATE TEMP TABLE _welfare_erd_result ON COMMIT PRESERVE ROWS AS
SELECT CURRENT_TIMESTAMP AS source_snapshot_at,
    (SELECT count(*) FROM public.welfare_services) AS old_services_total,
    (SELECT count(*) FROM public.welfare_chunks) AS old_vectors_total,
    (SELECT count(*) FROM pg_temp._welfare_erd_services) AS old_official_services,
    (SELECT count(*) FROM pg_temp._welfare_erd_chunks) AS old_official_vectors,
    (SELECT count(*) FROM (SELECT DISTINCT ministry, department FROM pg_temp._welfare_erd_services) d)
        AS old_ministry_department_pairs,
    (SELECT count(*) FROM public.departments) AS new_departments,
    (SELECT count(*) FROM public.welfare_programs) AS new_programs,
    (SELECT count(*) FROM public.welfare_document_vectors) AS new_vectors,
    (SELECT count(*) FROM public.counselors) AS new_counselors,
    (SELECT count(*) FROM public.counselor_connections) AS new_connections,
    jsonb_build_object(
        'rag_document_admins', (SELECT count(*) FROM public.rag_document_admins),
        'rag_documents', (SELECT count(*) FROM public.rag_documents),
        'rag_document_jobs', (SELECT count(*) FROM public.rag_document_jobs),
        'rag_document_chunks', (SELECT count(*) FROM public.rag_document_chunks)
    ) AS old_document_tables_rows,
    'passed'::text AS count_comparison,
    'passed'::text AS service_field_comparison,
    'passed'::text AS vector_value_and_metadata_comparison,
    'passed'::text AS new_tables_access_check;

COMMIT;

SELECT true AS transaction_committed, r.* FROM pg_temp._welfare_erd_result r;
