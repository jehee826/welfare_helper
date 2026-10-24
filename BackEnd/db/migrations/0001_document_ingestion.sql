-- Supabase SQL Editor에서 검토 후 별도로 적용한다. 기존 서비스·청크·Storage는 변경하지 않는다.
BEGIN;
CREATE TABLE public.rag_document_admins (
    user_id uuid PRIMARY KEY REFERENCES auth.users(id),
    active boolean NOT NULL DEFAULT true,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.rag_documents (
    id uuid PRIMARY KEY,
    service_id text NOT NULL REFERENCES public.welfare_services(service_id),
    name text NOT NULL,
    source_url text NOT NULL,
    basis_year text NOT NULL CHECK (basis_year ~ '^(19|20)[0-9]{2}$'),
    source_updated_at date,
    file_hash text NOT NULL CHECK (length(file_hash)=64),
    file_size integer NOT NULL CHECK (file_size > 0),
    suffix text NOT NULL CHECK (suffix IN ('pdf','docx','md')),
    test_only boolean NOT NULL DEFAULT false,
    object_key text NOT NULL UNIQUE,
    parser_version text NOT NULL,
    parse_config jsonb NOT NULL,
    dedupe_key text NOT NULL UNIQUE,
    uploaded_by uuid NOT NULL REFERENCES auth.users(id),
    status text NOT NULL DEFAULT 'uploading',
    analysis_job_id uuid,
    active_job_id uuid,
    active boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX rag_documents_active_service ON public.rag_documents(service_id) WHERE active;
CREATE TABLE public.rag_document_jobs (
    id uuid PRIMARY KEY,
    document_id uuid NOT NULL REFERENCES public.rag_documents(id),
    kind text NOT NULL CHECK (kind IN ('analyze','index')),
    state text NOT NULL DEFAULT 'queued' CHECK (state IN ('queued','running','succeeded','failed')),
    input_key text NOT NULL,
    payload jsonb NOT NULL DEFAULT '{}',
    result jsonb NOT NULL DEFAULT '{}',
    attempts integer NOT NULL DEFAULT 0,
    available_at timestamptz NOT NULL DEFAULT now(),
    lease_token uuid,
    lease_until timestamptz,
    error_code text,
    created_by uuid NOT NULL REFERENCES auth.users(id),
    created_at timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,
    UNIQUE(document_id,kind,input_key)
);
CREATE INDEX rag_document_jobs_claim ON public.rag_document_jobs(state,available_at,lease_until);
ALTER TABLE public.rag_documents ADD FOREIGN KEY(analysis_job_id) REFERENCES public.rag_document_jobs(id);
ALTER TABLE public.rag_documents ADD FOREIGN KEY(active_job_id) REFERENCES public.rag_document_jobs(id);
CREATE TABLE public.rag_document_chunks (
    job_id uuid NOT NULL REFERENCES public.rag_document_jobs(id),
    index_key text NOT NULL,
    document_id uuid NOT NULL REFERENCES public.rag_documents(id),
    chunk_id text NOT NULL,
    service_id text NOT NULL REFERENCES public.welfare_services(service_id),
    content text NOT NULL,
    embedding vector(1024) NOT NULL,
    embed_model text NOT NULL,
    embed_digest text NOT NULL,
    input_hash text NOT NULL,
    PRIMARY KEY(job_id,index_key,chunk_id)
);
CREATE INDEX rag_document_chunks_reuse ON public.rag_document_chunks(embed_model,embed_digest,input_hash);
CREATE INDEX rag_document_chunks_active ON public.rag_document_chunks(document_id,job_id,index_key);
ALTER TABLE public.rag_document_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_document_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.rag_document_chunks ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rag_document_admins,public.rag_documents,public.rag_document_jobs,public.rag_document_chunks FROM PUBLIC,anon,authenticated;
GRANT ALL ON public.rag_document_admins,public.rag_documents,public.rag_document_jobs,public.rag_document_chunks TO service_role;
COMMIT;
