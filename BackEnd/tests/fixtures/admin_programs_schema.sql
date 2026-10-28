DROP SCHEMA IF EXISTS public CASCADE;
CREATE SCHEMA public;

CREATE TABLE public.departments (
    department_id bigserial PRIMARY KEY,
    department_name varchar(150) NOT NULL,
    ministry_name text NOT NULL,
    CONSTRAINT departments_name_check CHECK (length(btrim(department_name::text)) > 0 AND length(btrim(ministry_name)) > 0)
);
CREATE UNIQUE INDEX departments_ministry_department_unique ON public.departments (ministry_name, department_name);

CREATE TABLE public.welfare_programs (
    program_id bigserial PRIMARY KEY,
    program_name varchar(200) NOT NULL,
    eligibility text,
    benefit_details text,
    application_method text,
    department_id bigint NOT NULL REFERENCES public.departments (department_id) ON DELETE RESTRICT,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    external_service_id text UNIQUE,
    summary text,
    source_url text,
    contacts jsonb NOT NULL DEFAULT '[]'::jsonb,
    source_updated_at date,
    test_only boolean NOT NULL DEFAULT false,
    CONSTRAINT welfare_programs_name_check CHECK (length(btrim(program_name::text)) > 0),
    CONSTRAINT welfare_programs_external_id_check CHECK (external_service_id IS NULL OR length(btrim(external_service_id)) > 0),
    CONSTRAINT welfare_programs_contacts_check CHECK (jsonb_typeof(contacts) = 'array')
);
CREATE INDEX welfare_programs_department_idx ON public.welfare_programs (department_id);

CREATE FUNCTION public.welfare_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.updated_at := clock_timestamp();
    RETURN NEW;
END;
$$;
CREATE TRIGGER welfare_programs_touch_updated_at BEFORE UPDATE ON public.welfare_programs
    FOR EACH ROW EXECUTE FUNCTION public.welfare_touch_updated_at();

CREATE TABLE public.rag_documents (
    document_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    program_id bigint NOT NULL REFERENCES public.welfare_programs (program_id) ON DELETE RESTRICT,
    document_name text NOT NULL,
    source_url text NOT NULL,
    source_organization text NOT NULL,
    source_updated_at date,
    basis_year smallint,
    test_only boolean NOT NULL DEFAULT false,
    markdown text,
    analysis_json jsonb,
    reviewed_by uuid,
    reviewed_at timestamptz,
    local_ingestion boolean NOT NULL DEFAULT false,
    active_job_id uuid,
    created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE public.rag_document_jobs (
    job_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    document_id uuid NOT NULL REFERENCES public.rag_documents (document_id) ON DELETE CASCADE,
    state text NOT NULL,
    embedding_model text,
    embedding_digest text,
    chunk_config jsonb
);
