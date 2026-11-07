-- 검토 후 승인된 운영 담당자가 적용한다. 앱/worker는 DDL을 실행하지 않는다.
-- 연락처 안내 기록만 추가하며 기존 테이블·관리자·문서·상담 자료를 변경하지 않는다.
BEGIN;
CREATE TABLE public.contact_referrals (
    response_id uuid NOT NULL,
    department_id bigint NOT NULL REFERENCES public.departments(department_id) ON DELETE RESTRICT,
    label text NOT NULL CHECK (length(label) BETWEEN 1 AND 160),
    phone text NOT NULL CHECK (length(phone) BETWEEN 3 AND 20 AND phone <> '129'),
    contact_version text NOT NULL CHECK (contact_version ~ '^[0-9a-f]{64}$'),
    source_url text NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
    document_id uuid NOT NULL,
    document_version text NOT NULL CHECK (length(document_version) BETWEEN 1 AND 200),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (response_id, contact_version)
);
CREATE INDEX contact_referrals_created ON public.contact_referrals(created_at);
CREATE INDEX contact_referrals_department_created ON public.contact_referrals(department_id,created_at);
ALTER TABLE public.contact_referrals ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.contact_referrals FROM PUBLIC,anon,authenticated;
GRANT SELECT,INSERT,DELETE ON public.contact_referrals TO service_role;
COMMIT;
