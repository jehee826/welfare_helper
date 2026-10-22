import os
from dataclasses import replace
from urllib.parse import urlparse

import psycopg2
import pytest

from BackEnd.rag.repository import PgServiceRepository
from BackEnd.tests.test_chat import CARE, PENSION

TEST_DSN = os.environ.get("RAG_TEST_DATABASE_URL", "")
VECTOR = [1.0] + [0.0] * 1023


@pytest.fixture
def repo():
    if not TEST_DSN:
        pytest.skip("RAG_TEST_DATABASE_URL로 지정한 일회용 로컬 DB에서 실행합니다.")
    target = urlparse(TEST_DSN)
    if target.hostname not in ("127.0.0.1", "localhost") or target.path != "/rag_test":
        pytest.fail("테스트는 로컬 rag_test 데이터베이스에서만 실행할 수 있습니다.")
    repository = PgServiceRepository(lambda: psycopg2.connect(TEST_DSN))
    repository.init_schema()
    with psycopg2.connect(TEST_DSN) as conn, conn.cursor() as cursor:
        cursor.execute("TRUNCATE welfare_services CASCADE")
    return repository


def indexed(*records):
    return {record.service_id: (record.summary, VECTOR) for record in records}


def test_snapshot_retains_missing_services_by_default_and_prunes_only_explicitly(repo):
    repo.sync_snapshot([PENSION, CARE], indexed(PENSION, CARE))
    result = repo.sync_snapshot([PENSION], {})
    assert result == {"upserted": 1, "embedded": 0, "removed": 0, "total": 2}
    assert {record.service_id for record in repo.all_services()} == {PENSION.service_id, CARE.service_id}
    assert repo.sync_snapshot([PENSION], {}, prune=True)["removed"] == 1
    assert set(repo.indexed_chunks()) == {PENSION.service_id}


def test_search_excludes_embeddings_from_other_models(repo):
    repo.sync_snapshot([PENSION], indexed(PENSION))
    other = PgServiceRepository(lambda: psycopg2.connect(TEST_DSN), embed_model="other-model")
    other.sync_snapshot([CARE], indexed(CARE))
    assert repo.dense_search(VECTOR, 5) == [(PENSION.service_id, 1.0)]
    assert other.dense_search(VECTOR, 5) == [(CARE.service_id, 1.0)]


def test_dense_limit_is_applied_to_unique_services_not_chunks(repo):
    repo.sync_snapshot([PENSION, CARE], indexed(PENSION, CARE))
    with psycopg2.connect(TEST_DSN) as conn, conn.cursor() as cursor:
        cursor.execute(
            "INSERT INTO welfare_chunks SELECT chunk_id || ':extra', service_id, content, embedding, embed_model "
            "FROM welfare_chunks WHERE service_id = %s",
            (PENSION.service_id,),
        )
    assert len(repo.dense_search(VECTOR, 2)) == 2


def test_invalid_snapshot_rolls_back_existing_metadata(repo):
    repo.sync_snapshot([PENSION], indexed(PENSION))
    with pytest.raises(psycopg2.Error):
        repo.sync_snapshot([
            replace(PENSION, name="변경되면 안 되는 이름"),
            replace(CARE, updated_at="invalid-date"),
        ], {})
    assert [record.name for record in repo.all_services()] == [PENSION.name]


def test_empty_snapshot_is_rejected_without_connecting():
    def unexpected():
        pytest.fail("빈 스냅샷에서 DB에 접속했습니다.")

    with pytest.raises(ValueError, match="빈 스냅샷"):
        PgServiceRepository(unexpected).sync_snapshot([], {}, prune=True)


@pytest.mark.parametrize("vector", [
    [1.0, 0.0], [float("nan")] * 1024, [0.0] * 1024,
])
def test_invalid_vectors_are_rejected_without_connecting(vector):
    def unexpected():
        pytest.fail("잘못된 임베딩으로 DB에 접속했습니다.")

    with pytest.raises(ValueError):
        PgServiceRepository(unexpected).dense_search(vector, 5)
