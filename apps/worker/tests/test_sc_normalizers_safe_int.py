"""Shared JEV normalizers and their Cari copies must parse ints safely."""


from sentiment_monitor.sources.normalization import unix_to_iso
from sentiment_monitor.sources.threads import normalize_threads_item
from sentiment_monitor.sources.tiktok import normalize_tiktok_item

COLLECTED = "2026-11-16T00:00:00Z"




def test_threads_superscript_count_is_none():
    result = normalize_threads_item({"pk": "1", "code": "c", "like_count": "²"}, COLLECTED)
    assert result["likes"] is None


def test_tiktok_superscript_count_is_none():
    result = normalize_tiktok_item({"aweme_id": "1", "stats": {"diggCount": "²"}}, COLLECTED)
    assert result["likes"] is None


def test_tiktok_arabic_indic_count_is_none():
    result = normalize_tiktok_item({"aweme_id": "1", "stats": {"playCount": "٣"}}, COLLECTED)
    assert result["views"] is None


def test_ms_epoch_timestamps_do_not_raise():
    expected = "2026-11-15T14:57:50Z"
    assert unix_to_iso(1794754670000) == expected
    assert unix_to_iso("1794754670000") == expected
    result = normalize_threads_item({"pk": "1", "taken_at": 1794754670000}, COLLECTED)
    assert result["posted_at"] == expected


def test_out_of_range_epoch_is_none_not_an_exception():
    assert unix_to_iso(1e20) is None
    assert unix_to_iso("1e20") == "1e20"
