from sentiment_monitor.instant_search import (
    claim_instant_search,
    credit_total,
    record_call,
)
from sentiment_monitor.providers.canonical import RouteCall


def test_ledger_stores_safe_fields_only(db):
    job = claim_instant_search(db, "worker-1")
    call = RouteCall(
        provider="scrapeatlas", platform="youtube", route="scrapeatlas.youtube.search",
        outcome="failed", http_status=500, credits_charged=0, body_length=1234,
        latency_ms=800, safe_detail="http_5xx",
    )
    record_call(db, job, call)
    row = db.execute("select * from search_credit_ledger where search_id=%s", (job.id,))[0]
    assert row["credits_charged"] == 0
    assert row["body_length"] == 1234
    assert row["safe_detail"] == "http_5xx"
    assert row["http_status"] == 500
    assert row["latency_ms"] == 800
    assert row["provider"] == "scrapeatlas"
    assert row["platform"] == "youtube"
    assert row["route"] == "scrapeatlas.youtube.search"
    assert "provider-secret" not in str(row)
    assert credit_total(db, job.id) == 0


def test_non_whitelisted_route_and_detail_are_reduced(db):
    job = claim_instant_search(db, "worker-1")
    call = RouteCall(
        "scrapeatlas", "youtube", "bad route with secret", "failed", 500, 0, 10, 5,
        "synthetic-key prompt raw body",
    )
    record_call(db, job, call)
    row = db.execute("select route, safe_detail from search_credit_ledger where search_id=%s", (job.id,))[0]
    assert row["route"] == "other"
    assert row["safe_detail"] == "other"


def test_unknown_and_zero_credits_are_preserved_separately(db):
    job = claim_instant_search(db, "worker-1")
    record_call(
        db, job,
        RouteCall("scrapeatlas", "youtube", "scrapeatlas.youtube.search", "success", 200, None, 10, 5, "ok"),
    )
    record_call(
        db, job,
        RouteCall("scrapeatlas", "reddit", "scrapeatlas.reddit.search", "success", 200, 0, 10, 5, "ok"),
    )
    rows = db.execute(
        "select platform, credits_charged from search_credit_ledger where search_id=%s order by platform",
        (job.id,),
    )
    assert rows == [
        {"platform": "reddit", "credits_charged": 0},
        {"platform": "youtube", "credits_charged": None},
    ]
    assert credit_total(db, job.id) == 0


def test_ledger_never_keeps_provider_text_or_headers(db):
    job = claim_instant_search(db, "worker-1")
    record_call(
        db, job,
        RouteCall(
            "scrapeatlas", "youtube", "https://api.scrapeatlas.com/v1?key=synthetic-key",
            "failed", 500, None, 42, 12, "authorization: Bearer synthetic-key",
        ),
    )
    row = db.execute("select * from search_credit_ledger where search_id=%s", (job.id,))[0]
    rendered = str(row)
    for forbidden in ("synthetic-key", "api.scrapeatlas.com", "authorization", "Bearer"):
        assert forbidden not in rendered
    assert row["route"] == "other"
    assert row["safe_detail"] == "other"
