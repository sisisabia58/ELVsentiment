from datetime import datetime, timezone

from harken.models import Mention
from harken.sources import REGISTRY
from harken.sources.base import FetchPage, Source

_API = "https://graph.threads.com/v1.0/keyword_search"


class ThreadsSource(Source):
    name = "threads"
    label = "Threads"
    needs_config = True

    def __init__(self, access_token: str | None = None, **options):
        super().__init__(**options)
        self.access_token = access_token

    def fetch(self, query: str, limit: int = 25) -> list[Mention]:
        return self.fetch_page(query, limit=limit).mentions

    def fetch_page(
        self,
        query: str,
        limit: int = 25,
        *,
        cursor: str | None = None,
        since: datetime | None = None,
    ) -> FetchPage:
        del cursor
        if not self.access_token:
            raise RuntimeError("Threads requires an access token")
        params = {
            "q": query,
            "search_type": "RECENT",
            "search_mode": "KEYWORD",
            "fields": "id,text,media_type,permalink,timestamp,username",
            "limit": str(max(1, min(limit, 100))),
            "access_token": self.access_token,
        }
        if since is not None:
            params["since"] = str(int(since.timestamp()))
        with self._client() as client:
            response = client.get(_API, params=params)
            response.raise_for_status()
            data = response.json()
        mentions: list[Mention] = []
        for post in data.get("data", []):
            post_id = post.get("id")
            if not post_id:
                continue
            mentions.append(
                Mention(
                    id=str(post_id),
                    source=self.name,
                    query=query,
                    author=post.get("username"),
                    text=post.get("text") or "",
                    url=post.get("permalink"),
                    created_at=_parse_timestamp(post.get("timestamp")),
                )
            )
        return FetchPage(mentions, None)


def register_threads() -> None:
    REGISTRY["threads"] = ThreadsSource


def _parse_timestamp(value: str | None) -> datetime:
    if value:
        try:
            return datetime.fromisoformat(value.replace("+0000", "+00:00"))
        except ValueError:
            pass
    return datetime.now(timezone.utc)
