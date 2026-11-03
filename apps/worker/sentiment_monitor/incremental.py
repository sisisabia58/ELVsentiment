"""Incremental X collection.

Harken's FetchPage.next_cursor is the X recent-search next_token, which pages
toward older posts. The value stored for the next run is the newest status id
we have fully caught up to, and the next run asks for posts newer than that id.
"""


def numeric_since_id(value) -> str | None:
    if isinstance(value, str) and value.isdigit():
        return value
    return None


def _mention_id(mention) -> str | None:
    external_id = mention.get("external_id") if isinstance(mention, dict) else None
    if isinstance(external_id, str) and external_id.isdigit():
        return external_id
    return None


def reached_floor(mentions, floor_id: str | None) -> bool:
    floor = numeric_since_id(floor_id)
    if floor is None:
        return False
    boundary = int(floor)
    for mention in mentions:
        mid = _mention_id(mention)
        if mid is not None and int(mid) <= boundary:
            return True
    return False


def newest_marker(mentions, floor_id, floor_since):
    best_id = numeric_since_id(floor_id)
    best_since = floor_since
    for mention in mentions:
        mid = _mention_id(mention)
        if mid is None:
            continue
        if best_id is None or int(mid) > int(best_id):
            best_id = mid
            best_since = mention.get("posted_at")
    return best_id, best_since


class IncrementalCollect:
    def __init__(self, mentions, floor_id, floor_since, blocked_detail):
        self.mentions = mentions
        self.floor_id = floor_id
        self.floor_since = floor_since
        self.blocked_detail = blocked_detail


def collect_newer_x(fetch_page, admit_page, *, floor_id, floor_since, first_limit):
    """Collect posts newer than floor_id.

    fetch_page(cursor, since, since_id, limit) -> (mentions, next_cursor).
    The first page is already reserved. Later pages call admit_page() before
    the request. next_cursor is followed only inside this walk. The stored
    floor advances only when the walk reaches the previous floor, so a budget
    stop does not skip the posts in between. The first collection has no
    numeric floor: it keeps one newest page and does not backfill older posts.
    """
    since_id = numeric_since_id(floor_id)
    mentions = []
    cursor = None
    limit = first_limit
    already_reserved = True
    seen_cursors: set[str] = set()
    while True:
        if not already_reserved:
            admission = admit_page()
            if not isinstance(admission, int):
                detail = getattr(admission, "detail", None) or "x_customer_cap"
                return IncrementalCollect(mentions, since_id, floor_since, detail)
            limit = admission
        page, next_cursor = fetch_page(
            cursor,
            floor_since if since_id else None,
            since_id,
            limit,
        )
        mentions.extend(page)
        already_reserved = False
        if since_id is None or reached_floor(page, since_id) or not next_cursor or not page:
            new_id, new_since = newest_marker(mentions, since_id, floor_since)
            return IncrementalCollect(mentions, new_id, new_since, None)
        if next_cursor in seen_cursors:
            return IncrementalCollect(mentions, since_id, floor_since, None)
        seen_cursors.add(next_cursor)
        cursor = next_cursor
