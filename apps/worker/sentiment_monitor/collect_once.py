from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Mapping


def _read_json(path: Path) -> dict[str, object]:
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    if not isinstance(data, dict):
        raise ValueError(f"{path} must contain a JSON object")
    return data


def gate(root: Path) -> int:
    policy = _read_json(root / "config" / "credential-policy.json")
    if policy.get("approved") is not True or policy.get("mode") != "shared_operator":
        return 2
    return 0


def sources_allowed(root: Path, env: Mapping[str, str]) -> set[str]:
    if gate(root) != 0:
        return set()

    allowed: set[str] = set()
    if str(env.get("SCRAPECREATORS_API_KEY") or "").strip():
        allowed.update(("threads", "instagram", "tiktok"))

    x_budget = _read_json(root / "config" / "x-budget.json")
    if x_budget.get("approved") is True and str(env.get("X_BEARER_TOKEN") or "").strip():
        allowed.add("x")

    return allowed


def main() -> int:
    from sentiment_monitor.paths import repo_root

    root = repo_root()
    allowed = sorted(sources_allowed(root, os.environ))
    print(json.dumps({"allowed_sources": allowed}))
    return gate(root)


if __name__ == "__main__":
    raise SystemExit(main())

