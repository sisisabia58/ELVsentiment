"""Port of the independent QA adapter matrix onto the production DB path.

Every case runs through ``scheduler._call`` -> ``CursorRowAdapter`` with the
worker role, exactly like the worker loop. No provider transport happens: the
ScrapeAtlas opener is an in-memory fake.
"""

import json
import uuid
from datetime import datetime, timezone

import pytest

from sentiment_monitor import instant_search
from sentiment_monitor import scheduler
from sentiment_monitor.providers.capabilities import DEFAULT_SETTINGS, ProviderSetting
from sentiment_monitor.providers.fetch import fetch_platform

CANARY = "synthetic-key-" + uuid.uuid4().hex


class FakeResponse:
    def __init__(self, body, status=200, headers=None):
        self._body = body
        self.status = status
        self.headers = headers or {"x-credits-charged": "1"}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False

    def read(self, size=-1):
        return self._body if size is None or size < 0 else self._body[:size]


def opener_for(body, headers=None):
    def opener(request, timeout=None):
        assert request.get_header("X-api-key") == CANARY
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        return FakeResponse(raw, headers=headers)

    return opener


def item(platform, index, *, views=None, likes=None, date=None, text=None, ident=None, extra=None):
    text = text if text is not None else f"barayam enak {index}"
    identity = ident if ident is not None else f"id{index}"
    if platform == "threads":
        data = {"pk": identity, "code": f"C{index}", "caption": {"text": text}, "user": {"username": "u"}, "taken_at": date if date is not None else 1794754670, "like_count": likes}
    elif platform == "tiktok":
        data = {"id": identity, "desc": text, "createTime": date if date is not None else 1793360245, "author": {"uniqueId": "u"}, "stats": {"playCount": views, "diggCount": likes}}
    elif platform == "youtube":
        data = {"id": identity, "title": text, "url": f"https://www.youtube.com/watch?v={identity}", "publishedTime": date, "viewCountInt": views, "channel": {"title": "c"}}
    elif platform == "reddit":
        data = {"id": identity, "title": text, "permalink": f"/r/x/{identity}", "created_at_iso": date, "score": likes}
    elif platform == "facebook":
        data = {"id": identity, "text": text, "url": f"https://facebook.com/{identity}", "publishTime": date if date is not None else 1773072560, "reactionCount": likes, "videoViewCount": views}
    else:
        data = {"id": identity, "description": text, "url": f"https://linkedin.com/{identity}", "datePublished": date, "likeCount": likes}
    if extra:
        data.update(extra)
    return data


LIST_KEY = {"threads": "posts", "tiktok": "item_list", "youtube": "videos", "reddit": "posts", "facebook": "posts", "linkedin": "posts"}


def payload(platform, items):
    return {"success": True, "status": "success", LIST_KEY[platform]: items}


DATE_CASES = {
    "threads": [None, "1794754670", 1794754670000, "2 days ago"],
    "tiktok": ["1793360245", 1793360245000, "kemarin", -1],
    "youtube": ["2026-10-25T16:24:34.450Z", "2 days ago", "2026-10-25T16:24:34", "2026-13-45T00:00:00Z", ""],
    "reddit": ["2026-10-25T16:24:34+07:00", "2 days ago", 1773072560],
    "facebook": [1773072560000, "1773072560", "kemarin", 1e20],
    "linkedin": ["2026-11-03T07:36:49.500Z", "1 minggu", "0000-00-00"],
}


def _cases():
    cases = []
    for platform in LIST_KEY:
        cases.append((platform, "baseline", payload(platform, [item(platform, 1, views=5, likes=3)])))
        cases.append((platform, "missing+nulls", payload(platform, [{}, {"id": None}, item(platform, 2, views=None, likes=None, text="")])))
        cases.append((platform, "numeric strings", payload(platform, [item(platform, 3, views=" 12 ", likes="7")])))
        cases.append((platform, "superscript digit", payload(platform, [item(platform, 4, views="²", likes="²")])))
        cases.append((platform, "views/likes 3e9", payload(platform, [item(platform, 5, views=3_000_000_000, likes=3_000_000_000)])))
        cases.append((platform, "emoji/NUL text", payload(platform, [item(platform, 6, text="🔥👩‍👩‍👧 barayam \u202eenak\u202c 😍 \x00nul")])))
        cases.append((platform, "duplicates", payload(platform, [item(platform, 7), item(platform, 7), item(platform, 8, ident=""), item(platform, 8, ident="")])))
        for index, date in enumerate(DATE_CASES[platform]):
            cases.append((platform, f"date {date!r}", payload(platform, [item(platform, 20 + index, date=date)])))
        cases.append((platform, "huge 3000 items", payload(platform, [item(platform, 1000 + index, text="barayam " + "x" * 2000) for index in range(3000)])))
        cases.append((platform, "malformed JSON", b"{not json"))
        cases.append((platform, "list root", b"[1,2,3]"))
        cases.append((platform, "success:false weird code", {"success": False, "failure": {"code": "EVIL " + CANARY}}))
        cases.append((platform, "non-dict items", payload(platform, [1, "x", None, [1]])))
        cases.append((platform, "neg credit header", payload(platform, [item(platform, 9)]), {"x-credits-charged": "-3"}))
    return cases


CASES = _cases()


def settings_only(platform):
    settings = {}
    for name in DEFAULT_SETTINGS:
        settings[name] = ProviderSetting(platform=name, provider="off")
    settings[platform] = ProviderSetting(platform=platform, provider="scrapeatlas")
    return settings


def run_case(prod_db, platform, body, headers=None):
    prod_db.admin.execute("delete from instant_searches")
    search_id = str(uuid.uuid4())
    prod_db.admin.execute(
        """
        insert into instant_searches
          (id, customer_id, query_text, keyword_intent, date_window, sort_mode,
           language_filter, status, deadline_at)
        values (%s, %s, 'barayam', 'phrase', 'all', 'relevance', 'all', 'queued',
                now() + interval '40 seconds')
        """,
        (search_id, prod_db.customer),
    )
    adapter = {}

    def fetcher(platform_name, keyword, settings, **kwargs):
        try:
            result = fetch_platform(
                platform_name,
                keyword,
                settings,
                env={"SCRAPEATLAS_API_KEY": CANARY, "CARI_PROVIDER_MODE": "live"},
                collected_at=kwargs["collected_at"],
                date_window_days=None,
                opener=opener_for(body, headers),
            )
            adapter.update(
                state=result.state,
                detail=result.safe_detail,
                posts=len(result.posts),
                credits=[call.credits_charged for call in result.calls],
            )
            return result
        except Exception as error:  # noqa: BLE001 - recorded for the assertion
            adapter.update(exc=type(error).__name__)
            raise

    def go(conn):
        job = instant_search.claim_instant_search(conn, "qa")
        instant_search.run_instant_search(
            conn,
            job,
            env={},
            now=datetime.now(timezone.utc),
            settings=settings_only(platform_name),
            fetcher=fetcher,
        )

    platform_name = platform
    store = "ok"
    try:
        scheduler._call(prod_db.connect, go)
    except Exception as error:  # noqa: BLE001 - the failure is the result
        store = "CYCLE_ABORT:" + type(error).__name__
    row = prod_db.admin.execute(
        "select status from instant_searches where id = %s", (search_id,)
    ).fetchone()
    source = prod_db.admin.execute(
        "select state, safe_detail from instant_search_sources where search_id = %s",
        (search_id,),
    ).fetchone()
    rows = prod_db.admin.execute(
        "select count(*) as n from instant_search_results where search_id = %s",
        (search_id,),
    ).fetchone()["n"]
    return adapter, store, row["status"] if row else None, source, rows


@pytest.mark.parametrize("platform,name,body,headers", [(case[0], case[1], case[2], case[3] if len(case) > 3 else None) for case in CASES], ids=[f"{case[0]}-{case[1]}" for case in CASES])
def test_adapter_case_never_aborts_the_cycle(prod_db, platform, name, body, headers):
    adapter, store, status, source, rows = run_case(prod_db, platform, body, headers)
    assert store == "ok", f"{platform} {name}: {store} adapter={adapter}"
    assert status is not None and status != "queued", (platform, name, status, adapter)
    assert source is not None, (platform, name, "missing source")
    assert rows >= 0


@pytest.mark.parametrize("platform", list(LIST_KEY))
def test_overflowing_counts_are_clamped_and_stored(prod_db, platform):
    body = payload(platform, [item(platform, 500, views=3_000_000_000, likes=3_000_000_000)])
    adapter, store, status, source, rows = run_case(prod_db, platform, body)
    assert store == "ok"
    assert adapter.get("state") == "answered", adapter
    assert source["state"] == "answered", (platform, source, adapter)
    assert rows == 1, (platform, rows, adapter)
    stored = prod_db.admin.execute(
        "select views, likes from instant_search_results where platform = %s", (platform,)
    ).fetchone()
    counts = [value for value in (stored["views"], stored["likes"]) if value is not None]
    assert counts and max(counts) == 3_000_000_000, stored


@pytest.mark.parametrize("platform", list(LIST_KEY))
def test_negative_credit_header_is_dropped_but_call_is_ledgered(prod_db, platform):
    body = payload(platform, [item(platform, 501)])
    adapter, store, status, source, rows = run_case(prod_db, platform, body, {"x-credits-charged": "-3"})
    assert store == "ok", adapter
    ledger = prod_db.admin.execute(
        "select credits_charged from search_credit_ledger where platform = %s", (platform,)
    ).fetchall()
    assert ledger, (platform, adapter)
    assert all(row["credits_charged"] is None for row in ledger), ledger


@pytest.mark.parametrize("text", ["barayam \x00 enak", "barayam \ud800 enak"])
def test_nul_and_lone_surrogates_are_sanitized_not_fatal(prod_db, text):
    body = payload("youtube", [item("youtube", 502, text=text)])
    adapter, store, status, source, rows = run_case(prod_db, "youtube", body)
    assert store == "ok", adapter
    assert source["state"] == "answered", (source, adapter)
    assert rows == 1
    stored = prod_db.admin.execute(
        "select text from instant_search_results where platform = 'youtube'"
    ).fetchone()["text"]
    assert "\x00" not in stored
    assert "\ud800" not in stored


@pytest.mark.parametrize("date", ["2 days ago", "kemarin", "2026-13-45T00:00:00Z", "0000-00-00"])
def test_unparseable_dates_are_stored_as_null(prod_db, date):
    body = payload("reddit", [item("reddit", 503, date=date)])
    adapter, store, status, source, rows = run_case(prod_db, "reddit", body)
    assert store == "ok", adapter
    assert source["state"] == "answered", (source, adapter)
    stored = prod_db.admin.execute(
        "select published_at from instant_search_results where platform = 'reddit'"
    ).fetchone()
    assert stored["published_at"] is None


def test_bad_record_does_not_roll_back_another_search_or_the_ledger(prod_db):
    prod_db.admin.execute("delete from instant_searches")
    ids = []
    for index in range(2):
        search_id = str(uuid.uuid4())
        ids.append(search_id)
        prod_db.admin.execute(
            """
            insert into instant_searches
              (id, customer_id, query_text, keyword_intent, date_window, sort_mode,
               language_filter, status, deadline_at)
            values (%s, %s, %s, 'phrase', 'all', 'relevance', 'all', 'queued',
                    now() + interval '40 seconds')
            """,
            (search_id, prod_db.customer, f"barayam {index}"),
        )

    def bad(platform_name, keyword, settings, **kwargs):
        from sentiment_monitor.providers.canonical import CanonicalPost

        post = CanonicalPost(
            platform=platform_name,
            external_id=f"{platform_name}-1",
            text="barayam \x00 enak",
            title=None,
            author_name=None,
            author_handle=None,
            url=None,
            published_at="kemarin",
            thumbnail_url=None,
            views=3_000_000_000,
            likes=-4,
            replies=None,
            shares=None,
            top_replies=(),
            hashtags=(),
            source_provider="scrapeatlas",
            routes=("scrapeatlas.search",),
            raw_ref=f"scrapeatlas:{platform_name}",
            collected_at="2026-11-16T00:00:00Z",
        )
        from sentiment_monitor.providers.canonical import RouteCall
        from sentiment_monitor.providers.scrapecreators_adapter import PlatformFetch

        return PlatformFetch(
            platform_name,
            "scrapeatlas",
            [post],
            [RouteCall("scrapeatlas", platform_name, "scrapeatlas.search", "success", 200, -2, 10, 5, "ok")],
            "answered",
            "ok",
            5,
        )

    processed = instant_search.run_instant_search_cycle(
        prod_db.connect,
        env={},
        now=datetime.now(timezone.utc),
        limits=None,
        fetcher=bad,
        max_searches=2,
    )
    assert processed == 2
    for search_id in ids:
        view = prod_db.view(search_id)
        assert view["search"]["status"] in ("succeeded", "partial"), view
        assert view["search"]["status"] != "queued"
    ledger = prod_db.admin.execute(
        "select search_id, credits_charged from search_credit_ledger order by search_id"
    ).fetchall()
    assert ledger, "paid calls were lost"
    assert all(row["credits_charged"] is None for row in ledger), ledger
    # A second cycle must not re-run the finished searches.
    assert instant_search.run_instant_search_cycle(
        prod_db.connect,
        env={},
        now=datetime.now(timezone.utc),
        limits=None,
        fetcher=bad,
    ) == 0


@pytest.mark.parametrize("platform", list(LIST_KEY))
@pytest.mark.parametrize("body,detail", [(b"{not json", "malformed_json"), (b"[1,2,3]", "malformed_envelope")])
def test_malformed_bodies_still_ledger_the_paid_credit(prod_db, platform, body, detail):
    adapter, store, status, source, rows = run_case(prod_db, platform, body)
    assert store == "ok", adapter
    assert adapter.get("state") == "failed", adapter
    assert adapter.get("detail") == detail, adapter
    ledger = prod_db.admin.execute(
        "select credits_charged, safe_detail from search_credit_ledger where platform = %s",
        (platform,),
    ).fetchall()
    assert ledger, (platform, adapter)
    assert ledger[0]["credits_charged"] == 1, ledger
