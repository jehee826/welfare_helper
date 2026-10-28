-- 문서 원본과 Docling 결과를 공유 DB에 보존한다. 기존 행·버킷·관리자 설정은 삭제하지 않는다.
BEGIN;
ALTER TABLE public.rag_documents
    ADD COLUMN original_bytes bytea,
    ADD COLUMN analysis_json jsonb,
    ADD COLUMN markdown text,
    ADD COLUMN local_ingestion boolean NOT NULL DEFAULT false,
    ALTER COLUMN uploaded_by DROP NOT NULL,
    ADD CONSTRAINT rag_documents_local_actor CHECK (uploaded_by IS NOT NULL OR local_ingestion);
ALTER TABLE public.rag_document_jobs ALTER COLUMN created_by DROP NOT NULL;
COMMIT;
