def query_key(customer_id: str, project_id: str, variant: str) -> str:
    return f"{customer_id}:{project_id}:{variant}"


def commit_cursor(store, query_key: str, source: str, mentions: list, next_cursor: str | None, handoff_ok: bool) -> None:
    if not handoff_ok:
        store.record_source_error(query_key, source, "handoff_failed")
        return
    store.record_source_success(
        query_key,
        source,
        mentions,
        mode="incremental",
        next_cursor=next_cursor,
    )
