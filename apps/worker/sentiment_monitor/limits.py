import json
import os
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class Limits:
    x_monthly_global_post_reads: int
    x_monthly_per_customer_post_reads: int
    threads_rolling_24h_reserve: int
    threads_rolling_24h_platform: int
    schedule_min_interval_hours: int
    manual_min_interval_seconds: int
    max_jobs_per_tick: int
    worker_poll_seconds: int
    worker_heartbeat_stale_seconds: int


def load_limits(path: Path, env: dict[str, str] | None = None) -> Limits:
    source = os.environ if env is None else env
    file = json.loads(path.read_text(encoding="utf-8"))

    def value(name: str, key: str) -> int:
        raw = source.get(name)
        return int(raw) if raw not in (None, "") else int(file[key])

    limits = Limits(
        x_monthly_global_post_reads=value("X_MONTHLY_GLOBAL_POST_READS", "x_monthly_global_post_reads"),
        x_monthly_per_customer_post_reads=value("X_MONTHLY_PER_CUSTOMER_POST_READS", "x_monthly_per_customer_post_reads"),
        threads_rolling_24h_reserve=value("THREADS_ROLLING_24H_RESERVE", "threads_rolling_24h_reserve"),
        threads_rolling_24h_platform=value("THREADS_ROLLING_24H_PLATFORM", "threads_rolling_24h_platform"),
        schedule_min_interval_hours=value("SCHEDULE_MIN_INTERVAL_HOURS", "schedule_min_interval_hours"),
        manual_min_interval_seconds=value("MANUAL_MIN_INTERVAL_SECONDS", "manual_min_interval_seconds"),
        max_jobs_per_tick=value("MAX_JOBS_PER_TICK", "max_jobs_per_tick"),
        worker_poll_seconds=value("WORKER_POLL_SECONDS", "worker_poll_seconds"),
        worker_heartbeat_stale_seconds=value("WORKER_HEARTBEAT_STALE_SECONDS", "worker_heartbeat_stale_seconds"),
    )
    if limits.threads_rolling_24h_reserve > limits.threads_rolling_24h_platform:
        raise ValueError("threads_reserve")
    if not 15 <= limits.worker_poll_seconds <= 30:
        raise ValueError("worker_poll_seconds")
    return limits
