import io
import json
from pathlib import Path
import urllib.error

import pytest

from sentiment_monitor.providers.capabilities import ProviderSetting
from sentiment_monitor.providers.canonical import CanonicalPost
from sentiment_monitor.providers.comments import (
    COMMENT_ENDPOINTS,
    CommentFetch,
    fetch_comments,
)

FIXTURES = Path(__file__).parent / "fixtures" / "scrapeatlas"


class Response(io.StringIO):
    def __init__(self, payload, status=200, headers=None):
        super().__init__(json.dumps(payload))
        self.status = status
        self.headers = headers or {}

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


def fixture(name):
    return json.loads((FIXTURES / name).read_text(encoding="utf-8"))


def post(**overrides):
    values = dict(
        platform="threads", external_id="p1",
        text="ayam goreng ini enak banget", title=None,
        author_name="Rina", author_handle="rina",
        url="https://threads.com/@rina/post/p1", published_at="2026-11-14T10:00:00Z",
        thumbnail_url=None, views=None, likes=10, replies=2, shares=0,
        top_replies=(), hashtags=(), source_provider="scrapeatlas",
        routes=("scrapeatlas.threads.recent",), raw_ref="scrapeatlas:threads:p1",
        collected_at="2026-11-15T00:00:00Z",
    )
    values.update(overrides)
    return CanonicalPost(**values)


SETTINGS = {"comments": ProviderSetting("comments", "scrapeatlas")}


def test_threads_comments_map_text_author_and_likes():
    def opener(request, timeout=0):
        return Response(
            {"success": True, "status": "success", "comments": [
                {"pk": "c1", "text": "kriuk banget", "user": {"username": "rina"},
                 "taken_at": 1794754670, "like_count": 12},
            ], "coverage": {"warnings": []}},
            headers={"x-credits-charged": "1"},
        )

    result = fetch_comments(
        "threads", post(url="https://threads.com/@a/post/1"),
        settings=SETTINGS,
        env={"SCRAPEATLAS_API_KEY": "synthetic"}, opener=opener,
    )
    assert result.state == "answered"
    assert result.comments[0].text == "kriuk banget"
    assert result.comments[0].author_handle == "rina"
    assert result.comments[0].likes == 12
    assert result.call.credits_charged == 1
    assert result.call.safe_detail == "ok"


def test_malformed_threads_reply_keeps_valid_siblings_and_the_paid_call():
    result = fetch_comments(
        "threads", post(), settings=SETTINGS, env={"SCRAPEATLAS_API_KEY": "synthetic"},
        opener=lambda *args, **kwargs: Response({
            "success": True,
            "comments": [
                {"pk": "before", "text": "kriuk banget"},
                {"pk": "bad", "text": "rusak", "taken_at": 10**500},
                {"pk": "after", "text": "masih hangat", "taken_at": 1794754670},
            ],
        }, headers={"x-credits-charged": "2"}),
    )
    assert result.state == "answered"
    assert [item.external_id for item in result.comments] == ["before", "after"]
    assert result.call.credits_charged == 2
    assert result.call.http_status == 200


def test_missing_comments_key_is_unavailable_without_network():
    called = []
    result = fetch_comments(
        "tiktok", post(),
        settings=SETTINGS,
        env={}, opener=lambda *a, **k: called.append(1),
    )
    assert result.state == "unavailable"
    assert result.safe_detail == "missing_key"
    assert called == []


def test_missing_post_url_is_unavailable_without_network():
    called = []
    result = fetch_comments(
        "threads", post(url=None),
        settings=SETTINGS,
        env={"SCRAPEATLAS_API_KEY": "synthetic"},
        opener=lambda *a, **k: called.append(1),
    )
    assert result.state == "unavailable"
    assert result.safe_detail == "missing_url"
    assert called == []


@pytest.mark.parametrize(
    "platform,file_name,fragment,author,likes",
    [
        ("threads", "comments_threads.json", "Anter cipondoh", "vivuyy14", 0),
        ("tiktok", "comments_tiktok.json", "tim yg ngk suka", "ervinavina657", 5161),
        ("instagram", "comments_instagram.json", "ditunggu di margo", "naatashaa8", 0),
        ("youtube", "comments_youtube.json", "Nunggu lebih dari", "@bbonggi4554", 10),
        ("facebook", "comments_facebook.json", "Iya iyaaalah", "Dul Aglao", 3),
        ("reddit", "comments_reddit.json", "Saking rasisnya", "TheDarkestTheory64", 162),
    ],
)
def test_each_platform_fixture_maps_text_author_and_likes(platform, file_name, fragment, author, likes):
    seen = []

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(fixture(file_name), headers={"x-credits-charged": "1"})

    result = fetch_comments(
        platform, post(platform=platform, url="https://example.invalid/post/1"),
        settings=SETTINGS,
        env={"SCRAPEATLAS_API_KEY": "synthetic"}, opener=opener,
    )
    assert result.state == "answered"
    assert result.comments
    assert fragment in result.comments[0].text
    assert result.comments[0].author_handle == author
    assert result.comments[0].likes == likes
    assert result.call.credits_charged == 1
    assert "url=https%3A%2F%2Fexample.invalid%2Fpost%2F1" in seen[0]
    assert result.call.provider == "scrapeatlas"


def test_facebook_requests_newest_sort():
    seen = []

    def opener(request, timeout=0):
        seen.append(request.full_url)
        return Response(fixture("comments_facebook.json"), headers={"x-credits-charged": "1"})

    fetch_comments(
        "facebook", post(platform="facebook", url="https://example.invalid/post/1"),
        settings=SETTINGS,
        env={"SCRAPEATLAS_API_KEY": "synthetic"}, opener=opener,
    )
    assert "sort=newest" in seen[0]


def test_facebook_skips_replies_with_no_text():
    payload = fixture("comments_facebook.json")
    payload["comments"] = [
        {"id": "sticker", "text": "  ", "author": {"name": "Stiker"}, "reaction_count": 1},
        payload["comments"][0],
    ]

    def opener(request, timeout=0):
        del request, timeout
        return Response(payload, headers={"x-credits-charged": "1"})

    result = fetch_comments(
        "facebook", post(platform="facebook", url="https://example.invalid/post/1"),
        settings=SETTINGS,
        env={"SCRAPEATLAS_API_KEY": "synthetic"}, opener=opener,
    )
    assert [item.external_id for item in result.comments] == [payload["comments"][1]["id"]]
    assert result.comments[0].text.startswith("Iya iyaaalah")


def test_facebook_labels_a_sticker_and_drops_invisible_text():
    payload = fixture("comments_facebook.json")
    payload["comments"] = [
        {"id": "blank", "text": "\u200b", "author": {"name": "Zhong Lun"}, "reaction_count": 1},
        {
            "id": "sticker",
            "text": "\ufffc",
            "author": {"name": "Miki Yong"},
            "attachments": [{"type": "sticker", "url": "https://example.invalid/sticker.png"}],
            "reaction_count": 2,
        },
        payload["comments"][0],
    ]

    def opener(request, timeout=0):
        del request, timeout
        return Response(payload, headers={"x-credits-charged": "1"})

    result = fetch_comments(
        "facebook", post(platform="facebook", url="https://example.invalid/post/1"),
        settings=SETTINGS,
        env={"SCRAPEATLAS_API_KEY": "synthetic"}, opener=opener,
    )
    assert [item.external_id for item in result.comments] == ["sticker", payload["comments"][2]["id"]]
    assert result.comments[0].text == "lampiran media"
    assert result.comments[0].author_name == "Miki Yong"


def test_facebook_keeps_the_stored_zhong_lun_text_and_prefers_a_longer_message():
    """Staging search a923bb0d stored Miki Yong's text as the ASCII name Zhong Lun."""
    payload = fixture("comments_facebook.json")
    payload["comments"] = [
        {
            "id": "miki",
            "text": "Zhong Lun",
            "author": {"name": "Miki Yong"},
            "reaction_count": 0,
            "reply_count": 0,
        },
        {
            "id": "with-message",
            "text": "\u3164",
            "message": "enak sekali",
            "author": {"name": "Ada Pesan"},
            "reaction_count": 0,
        },
        {
            "id": "sticker",
            "text": "\u3164",
            "author": {"name": "Stiker"},
            "attachments": [{"type": "sticker", "url": "https://example.invalid/sticker.png"}],
            "reaction_count": 0,
        },
    ]

    def opener(request, timeout=0):
        del request, timeout
        return Response(payload, headers={"x-credits-charged": "1"})

    result = fetch_comments(
        "facebook", post(platform="facebook", url="https://example.invalid/post/1"),
        settings=SETTINGS,
        env={"SCRAPEATLAS_API_KEY": "synthetic"}, opener=opener,
    )
    by_id = {item.external_id: item for item in result.comments}
    assert by_id["miki"].text == "Zhong Lun"
    assert by_id["miki"].author_name == "Miki Yong"
    assert by_id["miki"].likes == 0
    assert by_id["with-message"].text == "enak sekali"
    assert by_id["sticker"].text == "lampiran media"


def test_404_not_found_is_answered_with_zero_comments_and_credits():
    def opener(request, timeout=0):
        raise urllib.error.HTTPError(
            request.full_url, 404, "not found", {},
            io.BytesIO(b'{"success":false,"status":"failed","failure":{"code":"not_found"}}'),
        )

    result = fetch_comments(
        "threads", post(),
        settings=SETTINGS,
        env={"SCRAPEATLAS_API_KEY": "synthetic"}, opener=opener,
    )
    assert result.state == "answered"
    assert result.comments == []
    assert result.call.credits_charged == 0
    assert result.call.http_status == 404


def test_logically_failed_200_returns_failed_with_no_comments():
    def opener(request, timeout=0):
        return Response(fixture("failed_status.json"), headers={"x-credits-charged": "1"})

    result = fetch_comments(
        "tiktok", post(platform="tiktok"),
        settings=SETTINGS,
        env={"SCRAPEATLAS_API_KEY": "synthetic"}, opener=opener,
    )
    assert result.state == "failed"
    assert result.safe_detail == "failed_status"
    assert result.comments == []


def test_linkedin_comments_are_unsupported_without_network():
    called = []
    result = fetch_comments(
        "linkedin", post(platform="linkedin"),
        settings={"comments": ProviderSetting("comments", "scrapeatlas")},
        env={"SCRAPEATLAS_API_KEY": "synthetic"},
        opener=lambda *a, **k: called.append(1),
    )
    assert result.state == "unavailable"
    assert result.safe_detail == "unsupported_provider"
    assert called == []


def test_endpoints_cover_six_platforms_and_no_linkedin():
    assert set(COMMENT_ENDPOINTS) == {
        "threads", "tiktok", "instagram", "youtube", "facebook", "reddit"
    }
    assert all(path.endswith("/comments") for path in COMMENT_ENDPOINTS.values())


def test_comment_fetch_fields_match_contract():
    fetch = CommentFetch("p1", [], None, "unavailable", "missing_key")
    assert fetch.post_id == "p1"
    assert fetch.comments == []
    assert fetch.call is None


def test_invalid_comments_envelope_retains_accounted_failure():
    result = fetch_comments("threads", post(), settings=SETTINGS, env={"SCRAPEATLAS_API_KEY":"fixture"},
        opener=lambda *a, **k: Response({"success":True, "comments":{}}, headers={"x-credits-charged":"2"}))
    assert result.state == "failed" and result.safe_detail == "malformed_envelope"
    assert result.call.credits_charged == 2
