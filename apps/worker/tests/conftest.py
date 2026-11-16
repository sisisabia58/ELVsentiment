"""Shared disposable Postgres 16 database for instant-search worker tests."""

import os
import subprocess
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import quote, urlsplit, urlunsplit

import psycopg
import pytest
from psycopg import sql
from psycopg.rows import dict_row

SQL_DIR = Path(__file__).resolve().parents[2] / "web" / "src" / "db" / "sql"
DB_NAME = "sm_instant_search"
CUSTOMER = "11111111-1111-4111-8111-111111111111"
SEARCH = "22222222-2222-4222-8222-222222222222"
WORKER_PASSWORD = "synthetic-worker-password"
APP_PASSWORD = "synthetic-app-password"


def _admin_url() -> str:
    url = os.environ.get("POSTGRES_TEST_URL", "")
    if not url:
        pytest.skip("POSTGRES_TEST_URL is not set")
    return url


def _db_url(dbname: str) -> str:
    parts = urlsplit(_admin_url())
    return urlunsplit((parts.scheme, parts.netloc, f"/{dbname}", parts.query, parts.fragment))


def _drop_leftover_databases(admin) -> None:
    """Drop sm_* databases left behind by the web PG suite.

    The worker fixture reuses the cluster-level app_user/worker_role names, so
    any leftover objects owned by them in another database block the role drop.
    """
    rows = admin.execute(
        "select datname from pg_database "
        "where datistemplate = false and datname like %s "
        "and datname <> current_database()",
        ("sm\\_%",),
    ).fetchall()
    for (name,) in rows:
        admin.execute(
            "select pg_terminate_backend(pid) from pg_stat_activity "
            "where datname = %s and pid <> pg_backend_pid()",
            (name,),
        )
        admin.execute(sql.SQL("drop database if exists {}").format(sql.Identifier(name)))


def _reset_roles(admin) -> None:
    _drop_leftover_databases(admin)
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


def _role_url(dbname: str, user: str, password: str) -> str:
    parts = urlsplit(_admin_url())
    host = parts.hostname or "127.0.0.1"
    port = f":{parts.port}" if parts.port else ""
    return f"{parts.scheme}://{quote(user)}:{quote(password)}@{host}{port}/{dbname}"


def _seed(db) -> None:
    db.execute("delete from search_credit_ledger")
    db.execute("delete from instant_searches")
    db.execute("delete from customers where id = %s", (CUSTOMER,))
    db.execute("insert into customers (id, customer_id, created_at) values (%s, %s, now())", (CUSTOMER, CUSTOMER))
    db.execute(
        """
        insert into instant_searches
          (id, customer_id, query_text, keyword_intent, date_window, sort_mode,
           language_filter, status, created_at, deadline_at, retention_expires_at)
        values (%s, %s, 'barayam', 'phrase', '7d', 'relevance', 'all', 'queued',
                now(), now() + interval '40 seconds', now() + interval '30 days')
        """,
        (SEARCH, CUSTOMER),
    )


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


@pytest.fixture(scope="module")
def prod_database(instant_database):
    """Give the RLS roles a password so tests can log in like production."""
    admin = psycopg.connect(_admin_url(), autocommit=True)
    admin.execute(f"alter role worker_role login password '{WORKER_PASSWORD}'")
    admin.execute(f"alter role app_user login password '{APP_PASSWORD}'")
    admin.close()
    return instant_database


@dataclass
class ProdDB:
    connect: object
    admin: object
    observer: object
    customer: str
    search: str

    def view(self, search_id: str) -> dict:
        observer = self.observer
        with observer.transaction():
            observer.execute(
                "select set_config('app.customer_id', %s, true)", (self.customer,)
            )
            search = observer.execute(
                "select status, error_code, credits_used, started_at, finished_at "
                "from instant_searches where id = %s",
                (search_id,),
            ).fetchone()
            sources = observer.execute(
                "select platform, state, result_count, safe_detail "
                "from instant_search_sources where search_id = %s order by platform",
                (search_id,),
            ).fetchall()
            counts = observer.execute(
                "select platform, count(*) as n from instant_search_results "
                "where search_id = %s group by platform order by platform",
                (search_id,),
            ).fetchall()
            ledger = observer.execute(
                "select count(*) as n from search_credit_ledger where search_id = %s",
                (search_id,),
            ).fetchone()
        return {
            "search": search,
            "sources": sources,
            "counts": {row["platform"]: row["n"] for row in counts},
            "ledger": ledger["n"],
        }


@pytest.fixture
def prod_db(prod_database):
    """Production-shaped connection factory: CursorRowAdapter + autocommit=False."""
    from sentiment_monitor import scheduler

    worker_url = _role_url(DB_NAME, "worker_role", WORKER_PASSWORD)
    app_url = _role_url(DB_NAME, "app_user", APP_PASSWORD)
    admin = psycopg.connect(_db_url(DB_NAME), autocommit=True, row_factory=dict_row)
    _seed(admin)

    def connect():
        return scheduler.CursorRowAdapter(
            psycopg.connect(worker_url, autocommit=False, row_factory=dict_row)
        )

    observer = psycopg.connect(app_url, autocommit=True, row_factory=dict_row)
    env = ProdDB(connect, admin, observer, CUSTOMER, SEARCH)
    try:
        yield env
    finally:
        observer.close()
        admin.close()
