import io
import json

import pytest

import sentiment_monitor.scheduler as scheduler
import sentiment_monitor.sources.instagram as instagram
import sentiment_monitor.sources.threads as threads
import sentiment_monitor.sources.tiktok as tiktok
from sentiment_monitor.intent import Keyword


class _Response(io.StringIO):
    status = 200

    def __init__(self, payload):
        super().__init__(json.dumps(payload))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


CASES = [
    ("instagram_phrase_parse_2", instagram, "phrase", 2, [2, 3], "parse"),
    ("tiktok_phrase_parse_2", tiktok, "phrase", 2, [2, 3], "parse"),
    ("tiktok_phrase_parse_3", tiktok, "phrase", 3, [2, 3, 4], "parse"),
    ("instagram_hashtag_parse_6", instagram, "hashtag", 6, [2, 3], "parse"),
    ("threads_phrase_parse_1", threads, "phrase", 1, [3], "parse"),
    ("instagram_phrase_false_0", instagram, "phrase", 0, [2, 3], "false"),
    ("tiktok_phrase_false_0", tiktok, "phrase", 0, [2, 3], "false"),
]


@pytest.mark.parametrize(
    "case_id,module,intent,fail_at,charges,mode", CASES, ids=[case[0] for case in CASES]
)
def test_each_route_event_reports_only_its_own_attempt_credits(
    monkeypatch, case_id, module, intent, fail_at, charges, mode
):
    calls = []
    normalization_count = [0]
    attribute = f"normalize_{module.__name__.rsplit('.', 1)[-1]}_item"
    original = getattr(module, attribute)

    def normalize(item, collected_at):
        normalization_count[0] += 1
        if mode == "parse" and normalization_count[0] == fail_at:
            raise TypeError("synthetic parser failure")
        return original(item, collected_at)

    monkeypatch.setattr(module, attribute, normalize)

    def opener(request, timeout=0):
        credit = charges[len(calls)]
        calls.append(credit)
        posts = [
            {
                "pk": str(len(calls)),
                "caption": "kopi",
                "aweme_id": str(len(calls)),
                "desc": "kopi",
                "id": str(len(calls)),
                "text": "kopi",
            }
        ]
        if intent == "hashtag" and len(calls) == 1:
            posts = [{"pk": str(index), "caption": "#kopi"} for index in range(5)]
        payload = {
            "posts": posts,
            "reels": posts,
            "search_item_list": posts,
            "cursor": "2" if intent == "hashtag" else None,
            "credits_charged": credit,
        }
        if mode == "false":
            payload["success"] = False
        return _Response(payload)

    fetch = getattr(module, f"fetch_{module.__name__.rsplit('.', 1)[-1]}_mentions")
    keyword = Keyword("#kopi" if intent == "hashtag" else "kopi", intent)
    try:
        result = scheduler._guarded_fetch(
            module.__name__.rsplit(".", 1)[-1],
            lambda: fetch(
                keyword,
                "synthetic",
                "2026-11-10T00:00:00Z",
                opener=opener,
            ),
        )
    except scheduler.SourceFetchError as error:
        aggregate = error.credits_charged
        events = error.route_events
        kind = "recoverable" if error.recoverable else "fatal"
    else:
        aggregate = result["credits_charged"]
        events = result["route_events"]
        kind = "success"

    assert calls == charges, case_id
    assert aggregate == sum(charges), case_id
    assert [event["credits_charged"] for event in events] == charges, case_id
    assert kind == ("fatal" if mode == "parse" else "recoverable"), case_id
    assert [event["http_status"] for event in events] == [200] * len(charges), case_id
