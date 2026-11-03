from dataclasses import dataclass
from datetime import datetime

from harken.models import Mention
from harken.sources.x import XSource


@dataclass(frozen=True)
class Candidate:
    source: str
    external_id: str
    variant: str
    text: str
    url: str | None
    author: str | None
    created_at: str


def external_id_for(mention: Mention) -> str:
    if mention.source == "x" and mention.url and "/status/" in mention.url:
        return mention.url.rsplit("/status/", 1)[1].split("?")[0]
    return mention.id


def _attach_since_id(source, since_id: str) -> None:
    """Ask X for posts newer than since_id without editing Harken.

    XSource.fetch_page sends next_token and start_time only. since_id is the
    recent-search parameter that excludes posts we have already stored.
    """
    original_client = source._client

    def _client(**kwargs):
        client = original_client(**kwargs)
        original_get = client.get

        def get(url, params=None, **kw):
            if isinstance(params, dict):
                params = {**params, "since_id": since_id}
            return original_get(url, params=params, **kw)

        client.get = get
        return client

    source._client = _client


def fetch_x_with_cursor(
    query: str,
    bearer_token: str,
    *,
    cursor: str | None,
    since: datetime | None,
    limit: int,
    since_id: str | None = None,
):
    source = XSource(bearer_token=bearer_token)
    if since_id:
        _attach_since_id(source, since_id)
    page = source.fetch_page(query, limit=limit, cursor=cursor, since=since)
    candidates = [
        Candidate(
            source="x",
            external_id=external_id_for(mention),
            variant=query,
            text=mention.text,
            url=mention.url,
            author=mention.author,
            created_at=mention.created_at.isoformat(),
        )
        for mention in page.mentions
    ]
    return candidates, page.next_cursor


def fetch_x_page(query: str, bearer_token: str, *, cursor: str | None, since: datetime | None, limit: int) -> list[Candidate]:
    candidates, _next_cursor = fetch_x_with_cursor(
        query, bearer_token, cursor=cursor, since=since, limit=limit
    )
    return candidates


from sentiment_monitor.sources.threads import ThreadsSource


def fetch_threads_page(
    query: str,
    access_token: str,
    *,
    since: datetime | None,
    limit: int,
) -> tuple[list[Candidate], bool]:
    page = ThreadsSource(access_token=access_token).fetch_page(query, limit=limit, since=since)
    candidates = [
        Candidate(
            source="threads",
            external_id=mention.id,
            variant=query,
            text=mention.text,
            url=mention.url,
            author=mention.author,
            created_at=mention.created_at.isoformat(),
        )
        for mention in page.mentions
    ]
    return candidates, len(page.mentions) == max(1, min(limit, 100))
