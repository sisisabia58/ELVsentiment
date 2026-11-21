from concurrent.futures import ThreadPoolExecutor
from uuid import uuid4

import pytest

from sentiment_monitor.gemini import GeminiError, GeminiResult
from sentiment_monitor.intent import Keyword
from sentiment_monitor.mention_triage import (
    TriageInput,
    run_pantau_triage_poll,
    triage_mention,
)
from sentiment_monitor.pg_store import PostgresStore

BODY = "Saldo kepotong di Tukuliling, minumannya nggak keluar"
ENABLED = {"PANTAU_FILTER_TRIAGE_ENABLED": "true"}


class Classifier:
    def __init__(self, *, sentiment="negative", actionability="actionable", source="firsthand",
                 excerpt=BODY, issue_category="payment", error=None):
        self.data = dict(sentiment=sentiment, actionability=actionability, source=source,
                         excerpt=excerpt, issue_category=issue_category)
        self.error = error
        self.calls = 0

    def generate_json(self, **_):
        self.calls += 1
        if self.error:
            raise self.error
        return GeminiResult(self.data, "fixture", 20, 30, 0.0)


@pytest.mark.parametrize("text,terms,title,hashtags,overrides,expected", [
    (BODY, ["tukuliling kopi", "tukuliling"], None, (), {}, ("attention", "literal_match", 1)),
    ("Saldo kedai kopi kepotong", ["tukuliling kopi"], None, (), {}, ("excluded", "no_match", 0)),
    (BODY, ["tukuliling kopi"], None, (), {}, ("ambiguous", "all_words_match", 1)),
    (BODY, ["tukuliling"], None, (), {"source": "repost"}, ("ambiguous", "literal_match", 1)),
    (BODY, ["tukuliling"], None, (), {"source": "hearsay"}, ("ambiguous", "literal_match", 1)),
    (BODY, ["tukuliling"], None, (), {"source": "quoted"}, ("ambiguous", "literal_match", 1)),
    ("Kopinya enak! " + BODY, ["tukuliling"], None, (), {"sentiment": "mixed"}, ("attention", "literal_match", 1)),
    ("", ["tukuliling"], None, (), {}, ("ambiguous", "insufficient_text", 0)),
    ("👍", ["tukuliling"], None, (), {}, ("ambiguous", "insufficient_text", 0)),
    ("Stok habis", ["tukuliling"], BODY, (), {}, ("attention", "literal_match", 1)),
    ("Stok habis", [Keyword("#tukuliling", "hashtag")], None, ("#tukuliling",),
     {"excerpt": "Stok habis", "issue_category": "stock"}, ("attention", "literal_match", 1)),
    ("Kopi Tukuliling enak", ["tukuliling"], None, (),
     {"sentiment": "positive", "actionability": "not_actionable", "excerpt": None, "issue_category": None},
     ("mention", "literal_match", 1)),
])
def test_relevance_and_classification(text, terms, title, hashtags, overrides, expected):
    client = Classifier(**overrides)
    decision = triage_mention(TriageInput(tuple(terms), text, title, hashtags), client)
    assert (decision.destination, decision.relevance_tier, client.calls) == expected


@pytest.mark.parametrize("overrides", [
    {"excerpt": "This did not appear in the source"},
    {"excerpt": None},
    {"sentiment": "hostile"},
    {"issue_category": ["payment"]},
])
def test_invalid_output_cannot_create_attention(overrides):
    with pytest.raises(GeminiError, match="invalid_response"):
        triage_mention(TriageInput(("tukuliling",), BODY), Classifier(**overrides))


def seed_project(prod_db, count=1, *, pilot=True, seeded=False):
    project_id = uuid4()
    db = prod_db.admin
    db.execute("insert into projects values (%s, %s, 'Tukuliling', now(), %s)", (project_id, prod_db.customer, pilot))
    db.execute(
        "insert into keyword_variants (id, customer_id, project_id, text, active, created_at) "
        "values (gen_random_uuid(), %s, %s, 'tukuliling', true, now())", (prod_db.customer, project_id)
    )
    db.execute(
        "insert into mentions (id, customer_id, project_id, source, external_id, excerpt, posted_at, collected_at, "
        "matched_variants, scoring_status, pantau_origin_search_id) "
        "select gen_random_uuid(), %s, %s, 'threads', i::text, %s, now(), now(), '{}', 'pending', %s "
        "from generate_series(1, %s) i",
        (prod_db.customer, project_id, BODY, prod_db.search if seeded else None, count),
    )
    return project_id


@pytest.fixture
def triage_db(prod_db):
    try:
        yield prod_db
    finally:
        db = prod_db.admin
        db.execute("delete from owner_corrections")
        db.execute("delete from source_cursors")
        db.execute("delete from mentions")
        db.execute("delete from keyword_variants")
        db.execute("delete from projects")


def jobs(db, project_id):
    return db.execute(
        "select status, failure_code from pantau_triage_jobs where project_id = %s order by status", (project_id,)
    ).fetchall()


def test_seed_and_scheduled_copies_share_one_job(triage_db):
    project_id = seed_project(triage_db, seeded=True)
    conn = triage_db.connect()
    try:
        assert PostgresStore(conn).write_mentions_and_cursor(
            customer_id=triage_db.customer, project_id=project_id, query_key=f"{project_id}:test", source="threads",
            mentions=[dict(external_id="1", excerpt=BODY, url=None, author=None, posted_at="2026-11-20T12:00:00Z",
                           variant="tukuliling", title="Tukuliling", hashtags=("#tukuliling",))],
            next_cursor=None,
        ) == 0
    finally:
        conn.close()
    client = Classifier()
    run_pantau_triage_poll(triage_db.connect, client=client, env=ENABLED)
    assert jobs(triage_db.admin, project_id) == [{"status": "completed", "failure_code": None}]
    row = triage_db.admin.execute(
        "select j.destination, j.issue_category, m.pantau_origin_search_id from pantau_triage_judgments j "
        "join mentions m on m.id = j.mention_id where m.project_id = %s", (project_id,)
    ).fetchone()
    assert row["destination"] == "attention"
    assert row["issue_category"] == "payment"
    assert str(row["pantau_origin_search_id"]) == triage_db.search
    assert client.calls == 1


def test_disabled_worker_and_non_pilot_projects_make_no_model_calls(triage_db):
    seed_project(triage_db)
    normal = seed_project(triage_db, pilot=False)
    client = Classifier()
    run_pantau_triage_poll(triage_db.connect, client=client, env={})
    assert client.calls == 0
    run_pantau_triage_poll(triage_db.connect, client=client, env={"PANTAU_FILTER_TRIAGE_ENABLED": "1"})
    assert client.calls == 1
    assert jobs(triage_db.admin, normal) == []


def test_concurrent_workers_reserve_at_most_twenty_admissions(triage_db):
    project_id = seed_project(triage_db, count=22)
    clients = [Classifier() for _ in range(3)]

    def drain(client):
        while run_pantau_triage_poll(triage_db.connect, client=client, env=ENABLED):
            pass

    with ThreadPoolExecutor(max_workers=len(clients)) as pool:
        list(pool.map(drain, clients))
    assert sum(client.calls for client in clients) == 20
    assert [row["status"] for row in jobs(triage_db.admin, project_id)] == ["completed"] * 20 + ["deferred"] * 2


def test_provider_failure_retries_and_exhausts_without_judgment(triage_db):
    project_id = seed_project(triage_db)
    client = Classifier(error=GeminiError("rate_limited", retry_after_ms=1000))
    for status in ["retrying", "retrying", "failed"]:
        run_pantau_triage_poll(triage_db.connect, client=client, env=ENABLED)
        assert jobs(triage_db.admin, project_id)[0]["status"] == status
        triage_db.admin.execute("update pantau_triage_jobs set available_at = now() - interval '1 second'")
    assert client.calls == 3
    assert triage_db.admin.execute("select * from pantau_triage_judgments").fetchone() is None


def test_stale_claim_cannot_replace_newer_judgment_or_owner_correction(triage_db):
    project_id = seed_project(triage_db)

    class Stalled(Classifier):
        def generate_json(self, **kwargs):
            db = triage_db.admin
            db.execute("update pantau_triage_jobs set lease_expires_at = now() - interval '1 second'")
            db.execute(
                "insert into owner_corrections select id, customer_id, 'correct', 'relevant', 'positive', '{}', now() "
                "from mentions where project_id = %s", (project_id,)
            )
            run_pantau_triage_poll(triage_db.connect, client=Classifier(), env=ENABLED)
            return super().generate_json(**kwargs)

    stalled = Stalled(sentiment="positive", actionability="not_actionable", excerpt=None, issue_category=None)
    run_pantau_triage_poll(triage_db.connect, client=stalled, env=ENABLED)
    assert triage_db.admin.execute("select destination from pantau_triage_judgments").fetchall() == [
        {"destination": "attention"}
    ]
    assert triage_db.admin.execute("select sentiment from owner_corrections").fetchall() == [{"sentiment": "positive"}]


def test_a_capped_projects_backlog_does_not_delay_other_projects(triage_db):
    seed_project(triage_db, count=25)
    client = Classifier()
    for _ in range(5):
        run_pantau_triage_poll(triage_db.connect, client=client, env=ENABLED)
    assert client.calls == 20
    other = seed_project(triage_db)
    run_pantau_triage_poll(triage_db.connect, client=client, env=ENABLED)
    assert jobs(triage_db.admin, other)[0]["status"] == "completed"
    assert client.calls == 21


def test_scheduled_evidence_is_retained_on_new_mentions(triage_db):
    project_id = seed_project(triage_db, count=0)
    conn = triage_db.connect()
    try:
        assert PostgresStore(conn).write_mentions_and_cursor(
            customer_id=triage_db.customer, project_id=project_id, query_key=f"{project_id}:test", source="threads",
            mentions=[dict(external_id="1", excerpt="Stok habis", url=None, author=None, posted_at=None,
                           variant="tukuliling", title="Tukuliling", hashtags=("#tukuliling",))],
            next_cursor=None,
        ) == 1
    finally:
        conn.close()
    run_pantau_triage_poll(triage_db.connect, client=Classifier(excerpt="Stok habis", issue_category="stock"), env=ENABLED)
    assert triage_db.admin.execute(
        "select j.destination, j.issue_category, m.pantau_title, m.pantau_hashtags "
        "from pantau_triage_judgments j join mentions m on m.id = j.mention_id"
    ).fetchone() == {"destination": "attention", "issue_category": "stock",
                    "pantau_title": "Tukuliling", "pantau_hashtags": ["#tukuliling"]}


def test_no_match_and_missing_text_remain_deterministic_after_cap(triage_db):
    project_id = seed_project(triage_db, count=22)
    client = Classifier()
    for _ in range(6):
        run_pantau_triage_poll(triage_db.connect, client=client, env=ENABLED)
    # Add evidence arriving after the project reached its admission limit.
    triage_db.admin.execute(
        "insert into mentions (id, customer_id, project_id, source, external_id, excerpt, collected_at, "
        "matched_variants, scoring_status) values "
        "(gen_random_uuid(), %s, %s, 'threads', 'new-excluded', 'kopi tidak enak', now(), '{}', 'pending'), "
        "(gen_random_uuid(), %s, %s, 'threads', 'new-ambiguous', '', now(), '{}', 'pending')",
        (triage_db.customer, project_id, triage_db.customer, project_id),
    )
    run_pantau_triage_poll(triage_db.connect, client=client, env=ENABLED)
    assert triage_db.admin.execute(
        "select m.external_id, t.destination from mentions m join pantau_triage_judgments t on t.mention_id = m.id "
        "where m.external_id in ('new-excluded', 'new-ambiguous') order by m.external_id"
    ).fetchall() == [{"external_id": "new-ambiguous", "destination": "ambiguous"},
                     {"external_id": "new-excluded", "destination": "excluded"}]
    assert client.calls == 20
