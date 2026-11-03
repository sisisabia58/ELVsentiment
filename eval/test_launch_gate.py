import json
from pathlib import Path

from launch_gate import launch_allowed

ROOT = Path(__file__).resolve().parents[1]


def flags(**overrides):
    base = {
        "stack_reviewed": True,
        "credential_policy": True,
        "scoring_policy": True,
        "topic_labels": True,
        "topic_counting": True,
        "overview_formula": True,
        "jev_fallback_rule": True,
        "eval_criteria": True,
        "threads_public_search_demonstrated": True,
        "x_cost_understood": True,
        "reduced_source_launch": None,
        "high_impact": False,
    }
    base.update(overrides)
    return base


def test_committed_file_blocks():
    committed = json.loads((ROOT / "config" / "launch-approvals.json").read_text(encoding="utf-8"))
    assert launch_allowed(committed) is False


def test_two_source_and_explicit_x_only():
    assert launch_allowed(flags()) is True
    assert launch_allowed(flags(threads_public_search_demonstrated=False)) is False
    assert launch_allowed(flags(threads_public_search_demonstrated=False, reduced_source_launch="x_only_approved")) is True
