CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS welfare_services (
    service_id        TEXT PRIMARY KEY,
    name              TEXT NOT NULL,
    summary           TEXT NOT NULL,
    ministry          TEXT NOT NULL,
    department        TEXT NOT NULL DEFAULT '',
    url               TEXT NOT NULL DEFAULT '',
    contacts          JSONB NOT NULL DEFAULT '[]'::jsonb,
    source_updated_at DATE,
    synced_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS welfare_chunks (
    chunk_id    TEXT PRIMARY KEY,
    service_id  TEXT NOT NULL REFERENCES welfare_services (service_id) ON DELETE CASCADE,
    content     TEXT NOT NULL,
    embedding   vector(1024) NOT NULL,
    embed_model TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS welfare_chunks_service_id_idx ON welfare_chunks (service_id);
