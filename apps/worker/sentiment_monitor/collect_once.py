import json
from pathlib import Path


def gate(root: Path) -> int:
    policy = json.loads((root / "config" / "credential-policy.json").read_text(encoding="utf-8"))
    if policy.get("approved") is not True or policy.get("mode") != "shared_operator":
        return 2
    return 0


def sources_allowed(root: Path, env) -> set[str]:
    if gate(root) != 0:
        return set()
    allowed: set[str] = set()
    if str(env.get("THREADS_ACCESS_TOKEN") or "").strip():
        allowed.add("threads")
    budget = json.loads((root / "config" / "x-budget.json").read_text(encoding="utf-8"))
    if budget.get("approved") is True and str(env.get("X_BEARER_TOKEN") or "").strip():
        allowed.add("x")
    return allowed


if __name__ == "__main__":
    from sentiment_monitor.paths import repo_root

    raise SystemExit(gate(repo_root()))
