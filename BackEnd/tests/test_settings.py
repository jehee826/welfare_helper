import pytest
from pydantic import ValidationError

from BackEnd.core.settings import Settings


def test_embedding_dimension_can_be_read_from_environment(monkeypatch):
    monkeypatch.setenv("EMBED_DIM", "1024")
    assert Settings(_env_file=None).embed_dim == 1024


def test_dimension_incompatible_with_existing_schema_is_rejected():
    with pytest.raises(ValidationError):
        Settings(_env_file=None, embed_dim=768)
