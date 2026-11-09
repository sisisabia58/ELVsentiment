from contextlib import nullcontext

from sentiment_monitor.relevance import literal_match_status


class CommitOutcomeUnknown(Exception):
    """The authoritative commit phase raised; durability is unknown."""

    def __init__(self, error: Exception) -> None:
        super().__init__("commit_outcome_unknown")
        self.error = error


def _returned_rows(result) -> int:
    if result is None:
        return 0
    try:
        return len(result)
    except TypeError:
        return 0


def _first_id(result):
    if not result:
        return None
    try:
        row = result[0]
    except (TypeError, KeyError, IndexError):
        return None
    if isinstance(row, dict):
        return row.get("id")
    try:
        return row["id"]
    except (TypeError, KeyError, IndexError):
        pass
    try:
        return row[0]
    except (TypeError, KeyError, IndexError):
        return getattr(row, "id", None)


class PostgresStore:
    def __init__(self, conn):
        self._conn = conn
        self._open = False
        self._customer_id = None

    def source_state(self, query: str, source: str) -> dict:
        row = self._conn.execute(
            """
            select incremental_cursor, incremental_since, backfill_cursor, last_success_at, last_error
            from source_cursors
            where query_key = %s and source = %s
            """,
            (query, source),
        )
        return row or {}

    def record_source_error(self, query: str, source: str, error: str) -> None:
        if not self._open:
            raise RuntimeError("cursor_outside_mention_transaction")
        self._conn.execute(
            """
            insert into source_cursors (customer_id, query_key, source, last_error)
            values (%s, %s, %s, %s)
            on conflict (query_key, source) do update set last_error = excluded.last_error
            """,
            (self._customer_id, query, source, error),
        )

    def record_source_success(self, query, source, mentions, *, mode, next_cursor, incremental_since=None) -> None:
        del mentions
        if not self._open:
            raise RuntimeError("cursor_outside_mention_transaction")
        if mode == "backfill":
            sql = """
            insert into source_cursors (customer_id, query_key, source, backfill_cursor, last_success_at, last_error)
            values (%s, %s, %s, %s, now(), null)
            on conflict (query_key, source) do update
              set backfill_cursor = excluded.backfill_cursor,
                  last_success_at = excluded.last_success_at,
                  last_error = null
            """
            self._conn.execute(sql, (self._customer_id, query, source, next_cursor))
            return
        sql = """
        insert into source_cursors (
          customer_id, query_key, source, incremental_cursor, incremental_since, last_success_at, last_error
        )
        values (%s, %s, %s, %s, %s, now(), null)
        on conflict (query_key, source) do update
          set incremental_cursor = excluded.incremental_cursor,
              incremental_since = excluded.incremental_since,
              last_success_at = excluded.last_success_at,
              last_error = null
        """
        self._conn.execute(sql, (self._customer_id, query, source, next_cursor, incremental_since))

    def write_mentions_and_cursor(
        self,
        *,
        customer_id,
        project_id,
        query_key,
        source,
        mentions,
        next_cursor,
        incremental_since=None,
    ) -> int:
        self._open = True
        saved = 0
        self._customer_id = customer_id
        manages_transactions = bool(getattr(self._conn, "manages_transactions", False))
        start_transaction = getattr(self._conn, "transaction", None)
        scope = start_transaction() if callable(start_transaction) else nullcontext()
        commit_phase = False
        try:
            with scope:
                if not manages_transactions:
                    self._conn.execute("begin")
                self._conn.execute("select set_config('app.customer_id', %s::text, true)", (str(customer_id),))
                for mention in mentions:
                    inserted = self._conn.execute(
                        """
                        insert into mentions (
                          id, customer_id, project_id, source, external_id, excerpt, url, author,
                          posted_at, collected_at, matched_variants, scoring_status
                        ) values (
                          gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, %s, now(), %s, 'pending'
                        )
                        on conflict (customer_id, project_id, source, external_id) do nothing
                        returning id
                        """,
                        (
                            customer_id,
                            project_id,
                            source,
                            mention["external_id"],
                            mention["excerpt"],
                            mention["url"],
                            mention["author"],
                            mention["posted_at"],
                            [mention["variant"]],
                        ),
                    )
                    saved += _returned_rows(inserted)
                    mention_id = _first_id(inserted)
                    if mention_id is None:
                        mention_id = _first_id(
                            self._conn.execute(
                                "select id from mentions "
                                "where customer_id = %s and project_id = %s "
                                "and source = %s and external_id = %s",
                                (customer_id, project_id, source, mention["external_id"]),
                            )
                        )
                    if mention_id is None:
                        continue
                    variant = mention["variant"]
                    intent = mention.get("intent") or getattr(variant, "intent", "phrase")
                    self._conn.execute(
                        """
                        update mentions
                        set matched_variants = (
                          select array_agg(distinct value)
                          from unnest(matched_variants || %s::text[]) as value
                        )
                        where id = %s and customer_id = %s
                        """,
                        ([variant], mention_id, customer_id),
                    )
                    self._conn.execute(
                        """
                        insert into mention_keyword_associations (
                          id, customer_id, project_id, mention_id, keyword_text, intent,
                          route_id, source, status, collected_at
                        ) values (
                          gen_random_uuid(), %s, %s, %s, %s, %s, %s, %s, %s, coalesce(%s, now())
                        )
                        on conflict (mention_id, keyword_text, route_id) do update
                          set intent = excluded.intent,
                              status = excluded.status,
                              collected_at = excluded.collected_at
                        """,
                        (
                            customer_id,
                            project_id,
                            mention_id,
                            str(variant),
                            intent,
                            mention.get("route_id") or f"{source}.keyword",
                            source,
                            literal_match_status(mention.get("excerpt") or "", str(variant), intent),
                            mention.get("collected_at"),
                        ),
                    )
                self.record_source_success(
                    query_key,
                    source,
                    mentions,
                    mode="incremental",
                    next_cursor=next_cursor,
                    incremental_since=incremental_since,
                )
                commit_phase = True
                if not manages_transactions:
                    self._conn.execute("COMMIT")
                self._conn.commit()
                if not manages_transactions:
                    commit_phase = False
        except Exception as error:
            if not manages_transactions:
                self._conn.execute("ROLLBACK")
                self._conn.rollback()
            if commit_phase:
                raise CommitOutcomeUnknown(error) from None
            raise
        finally:
            self._open = False
        return saved
