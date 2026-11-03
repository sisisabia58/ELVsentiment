import json
from pathlib import Path

REQUIRED_TRUE = (
    "stack_reviewed",
    "credential_policy",
    "scoring_policy",
    "topic_labels",
    "topic_counting",
    "overview_formula",
    "jev_fallback_rule",
    "eval_criteria",
    "x_cost_understood",
)

NEEDLES = (
    "api.telegram.org",
    "hooks.slack.com",
    "nodemailer",
    "whatsapp",
    "harken.web",
    "LexiconSentiment",
    "harken.pipeline",
    "harken.alerts",
    "/me/threads",
    "chat/completions",
)

SKIP_NAMES = {"launch_gate.py", "test_launch_gate.py", "test_monitor_only.py"}


def launch_allowed(flags: dict) -> bool:
    if flags.get("high_impact") is not False:
        return False
    if any(flags.get(name) is not True for name in REQUIRED_TRUE):
        return False
    reduced = flags.get("reduced_source_launch")
    threads = flags.get("threads_public_search_demonstrated") is True
    if reduced is None:
        return threads
    return reduced == "x_only_approved"


def scan_forbidden(root: Path) -> list[str]:
    hits: list[str] = []
    for folder in ("apps", "eval"):
        base = root / folder
        if not base.exists():
            continue
        for path in base.rglob("*"):
            if path.suffix not in {".py", ".ts", ".tsx", ".js", ".jsx", ".sql"}:
                continue
            if not path.is_file() or path.name in SKIP_NAMES:
                continue
            if "node_modules" in path.parts or ".venv" in path.parts:
                continue
            text = path.read_text(encoding="utf-8", errors="ignore")
            if any(needle in text for needle in NEEDLES):
                hits.append(str(path))
    return hits


def main() -> int:
    flags = json.loads(Path("config/launch-approvals.json").read_text(encoding="utf-8"))
    if launch_allowed(flags):
        print("allowed")
        return 0
    print("blocked")
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
