import json
from pathlib import Path

from sentiment_monitor.collect_once import gate
from sentiment_monitor.limits import load_limits


def test_repo_root_with_config_dir(tmp_path, monkeypatch):
    from sentiment_monitor.paths import repo_root

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "limits.json").write_text(
        json.dumps(
            {
                "x_monthly_global_post_reads": 20000,
                "x_monthly_per_customer_post_reads": 2000,
                "threads_rolling_24h_reserve": 1500,
                "threads_rolling_24h_platform": 2200,
                "schedule_min_interval_hours": 11,
                "manual_min_interval_seconds": 901,
                "max_jobs_per_tick": 5,
                "worker_poll_seconds": 20,
                "worker_heartbeat_stale_seconds": 91,
            }
        ),
        encoding="utf-8",
    )
    (config_dir / "credential-policy.json").write_text(
        json.dumps({"approved": False, "mode": "shared_operator"}),
        encoding="utf-8",
    )
    (config_dir / "x-budget.json").write_text(json.dumps({"approved": False}), encoding="utf-8")

    monkeypatch.setenv("CONFIG_DIR", str(config_dir))

    root = repo_root()
    assert root == config_dir.resolve().parent
    limits = load_limits(root / "config" / "limits.json")
    assert limits.schedule_min_interval_hours == 11
    assert limits.manual_min_interval_seconds == 901
    assert limits.worker_heartbeat_stale_seconds == 91
    assert gate(root) == 2


def test_repo_root_default_without_config_dir(monkeypatch):
    from sentiment_monitor import paths
    from sentiment_monitor.paths import repo_root

    monkeypatch.delenv("CONFIG_DIR", raising=False)

    expected = Path(paths.__file__).resolve().parents[3]
    root = repo_root()
    assert root == expected
    assert (root / "config" / "limits.json").is_file()
