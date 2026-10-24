from BackEnd.core.db import connection_options
from BackEnd.core.settings import Settings


def test_separate_password_is_passed_to_driver_without_uri_interpolation():
    url = "postgresql://postgres.example@actual-pooler.example:5432/postgres"
    password = "test-only@/#:%secret"
    settings = Settings(_env_file=None, database_url=url, database_password=password)
    options = connection_options(settings)
    assert options["dsn"] == url and password not in options["dsn"]
    assert options["password"] == password and options["sslmode"] == "require"


def test_existing_url_password_stays_supported_without_override():
    url = "postgresql://user:test-only@db.example:5432/postgres"
    options = connection_options(Settings(_env_file=None, database_url=url, database_password=None))
    assert options["dsn"] == url and "password" not in options


def test_local_password_remains_independent():
    settings = Settings(_env_file=None, database_url=None, db_host="localhost", db_name="local",
                        db_user="local", db_password="local-only", database_password="shared-only")
    assert connection_options(settings)["password"] == "local-only"
