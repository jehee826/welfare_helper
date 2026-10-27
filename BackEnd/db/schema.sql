-- 읽기 전용 확인용이다. 애플리케이션은 DDL이나 이전 마이그레이션을 자동 실행하지 않는다.
-- 새 DB 구축은 검토된 재구축 SQL을 사용자가 SQL Editor에서 직접 실행한다.
SELECT name AS required_table, to_regclass('public.' || name) IS NOT NULL AS present
FROM (VALUES ('departments'), ('welfare_programs'), ('counselors'), ('counselor_connections'),
    ('rag_document_admins'), ('rag_documents'), ('rag_document_jobs'), ('welfare_document_vectors')) t(name);
