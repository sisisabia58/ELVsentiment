import pytest

from sentiment_monitor.pg_store import PostgresStore


class Tx:
    def __init__(self, fail_on=None):
        self.fail_on = fail_on
        self.statements = []
        self.committed = False
        self.rolled_back = False

    def execute(self, sql, params=None):
        if self.fail_on and self.fail_on in sql:
            raise RuntimeError("insert failed")
        self.statements.append(sql)

    def commit(self):
        self.statements.append("COMMIT")
        self.committed = True

    def rollback(self):
        self.statements.append("ROLLBACK")
        self.rolled_back = True


MENTION = {
    "external_id": "100",
    "excerpt": "geprek gembus",
    "url": "https://x.com/ani/status/100",
    "author": "ani",
    "posted_at": "2026-11-01T00:00:00+00:00",
    "variant": "geprek gembus",
}


def test_cursor_advances_only_with_the_mention_commit():
    tx = Tx()
    PostgresStore(tx).write_mentions_and_cursor(
        customer_id="customer-a",
        project_id="project-1",
        query_key="customer-a:project-1:geprek gembus",
        source="x",
        mentions=[MENTION],
        next_cursor="cursor-2",
    )
    joined = "\n".join(tx.statements)
    assert joined.index("insert into mentions") < joined.index("source_cursors")
    assert joined.index("source_cursors") < joined.index("COMMIT")
    assert "set_config" in joined
    assert tx.committed is True
    assert tx.rolled_back is False


def test_failed_mention_insert_rolls_the_cursor_back():
    tx = Tx(fail_on="insert into mentions")
    with pytest.raises(RuntimeError):
        PostgresStore(tx).write_mentions_and_cursor(
            customer_id="customer-a",
            project_id="project-1",
            query_key="customer-a:project-1:geprek gembus",
            source="x",
            mentions=[MENTION],
            next_cursor="cursor-2",
        )
    assert tx.committed is False
    assert tx.rolled_back is True
    assert "COMMIT" not in tx.statements
    assert not any("source_cursors" in sql for sql in tx.statements)


def test_record_source_success_refuses_to_commit_on_its_own():
    tx = Tx()
    with pytest.raises(RuntimeError):
        PostgresStore(tx).record_source_success(
            "customer-a:project-1:geprek gembus",
            "x",
            [],
            mode="incremental",
            next_cursor="cursor-2",
        )
    assert tx.committed is False


class _TransactionScope:
    def __init__(self, log):
        self.log = log

    def __enter__(self):
        self.log.append("enter")
        return self

    def __exit__(self, exc_type, exc, tb):
        self.log.append("exit")
        return False


def test_write_mentions_enters_transaction_and_still_sends_begin_and_commit():
    tx = Tx()
    log = []
    tx.transaction = lambda: _TransactionScope(log)
    PostgresStore(tx).write_mentions_and_cursor(
        customer_id="customer-a",
        project_id="project-1",
        query_key="customer-a:project-1:geprek gembus",
        source="x",
        mentions=[MENTION],
        next_cursor="cursor-2",
    )
    assert log == ["enter", "exit"]
    assert tx.statements[0] == "begin"
    mention_at = next(i for i, sql in enumerate(tx.statements) if "insert into mentions" in sql)
    commit_at = next(i for i, sql in enumerate(tx.statements) if sql == "COMMIT")
    assert tx.statements.index("begin") < mention_at < commit_at
    assert tx.committed is True
    assert tx.rolled_back is False
