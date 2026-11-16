"""Shared disposable Postgres 16 database for instant-search worker tests."""

import os
import subprocess
from pathlib import Path
from urllib.parse import urlsplit, urlunsplit

import psycopg
import pytest
from psycopg.rows import dict_row

SQL_DIR = Path(__file__).resolve().parents[2] / "web" / "src" / "db" / "sql"
DB_NAME = "sm_instant_search"
CUSTOMER = "11111111-1111-4111-8111-111111111111"
SEARCH = "22222222-2222-4222-8222-222222222222"


def _admin_url() -> str:
    url = os.environ.get("POSTGRES_TEST_URL", "")
    if not url:
        pytest.skip("POSTGRES_TEST_URL is not set")
    return url


def _db_url(dbname: str) -> str:
    parts = urlsplit(_admin_url())
    return urlunsplit((parts.scheme, parts.netloc, f"/{dbname}", parts.query, parts.fragment))


def _reset_roles(admin) -> None:
    admin.execute(
        "select pg_terminate_backend(pid) from pg_stat_activity "
        "where datname = %s and pid <> pg_backend_pid()",
        (DB_NAME,),
    )
    admin.execute(f"drop database if exists {DB_NAME}")
    admin.execute("drop role if exists app_user")
    admin.execute("drop role if exists worker_role")


@pytest.fixture(scope="module")
def instant_database():
    admin = psycopg.connect(_admin_url(), autocommit=True)
    version = admin.execute("show server_version_num").fetchone()[0]
    if int(version) // 10000 != 16:
        admin.close()
        pytest.skip(f"need Postgres 16, connected to {version}")
    _reset_roles(admin)
    admin.execute(f"create database {DB_NAME}")
    url = _db_url(DB_NAME)
    for path in sorted(SQL_DIR.glob("*.sql")):
        subprocess.run(
            ["psql", url, "-v", "ON_ERROR_STOP=1", "-f", str(path)],
            check=True,
            capture_output=True,
            text=True,
        )
    try:
        yield url
    finally:
        admin = psycopg.connect(_admin_url(), autocommit=True)
        _reset_roles(admin)
        admin.close()


class RowListConnection:
    """Expose psycopg with the list-of-dict rows the worker store expects."""

    def __init__(self, conn):
        self.conn = conn

    def execute(self, sql, params=None):
        cursor = self.conn.execute(sql, params)
        if cursor.description is None:
            return cursor
        return cursor.fetchall()

    def commit(self):
        return self.conn.commit()

    def rollback(self):
        return self.conn.rollback()

    def close(self):
        return self.conn.close()


@pytest.fixture
def db(instant_database):
    conn = RowListConnection(
        psycopg.connect(instant_database, autocommit=False, row_factory=dict_row)
    )
    conn.execute("delete from instant_searches")
    conn.execute("delete from customers where id = %s", (CUSTOMER,))
    conn.execute("insert into customers (id, customer_id, created_at) values (%s, %s, now())", (CUSTOMER, CUSTOMER))
    conn.execute(
        """
        insert into instant_searches
          (id, customer_id, query_text, keyword_intent, date_window, sort_mode,
           language_filter, status, created_at, deadline_at, retention_expires_at)
        values (%s, %s, 'barayam', 'phrase', '7d', 'relevance', 'all', 'queued',
                now(), now() + interval '40 seconds', now() + interval '30 days')
        """,
        (SEARCH, CUSTOMER),
    )
    conn.commit()
    try:
        yield conn
    finally:
        conn.rollback()
        conn.close()
