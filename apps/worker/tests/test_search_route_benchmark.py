import json
import subprocess
import sys
from pathlib import Path


WORKER = Path(__file__).resolve().parents[1]
SCRIPT = WORKER / "tools" / "search_route_benchmark.py"
FIXTURE = WORKER / "tests" / "fixtures" / "scrapeatlas" / "search_benchmark.json"


def run_benchmark(path):
    return subprocess.run([sys.executable, str(SCRIPT), str(path)], capture_output=True, text=True)


def test_offline_replay_reports_each_loss_stage_and_the_two_controls():
    result = run_benchmark(FIXTURE)
    assert result.returncode == 0, result.stderr
    report = json.loads(result.stdout)
    assert report["provenance"] == "synthetic"
    brand, generic, zero = report["results"]
    assert brand["query"] == "tukuliling kopi"
    assert brand["top_10_ids"] == [f"p{i}" for i in range(1, 11)]
    assert brand["direct_matches_at_10"] == 2
    assert brand["precision_at_10"] == 0.2
    assert brand["benchmark_ids_recovered_at_10"] == ["p2"]
    assert brand["benchmark_recall_at_10"] == 0.2
    assert brand["benchmark_ids_missing_from_raw"] == ["missing"]
    assert brand["benchmark_ids_dropped_in_normalization"] == ["malformed"]
    assert brand["benchmark_ids_excluded_before_ranking"] == ["old"]
    assert brand["benchmark_ids_ranked_below_top_10"] == ["p11"]
    assert brand["benchmark_ids_ranked_below_weaker_items"] == ["p2", "p11"]
    assert brand["total_usable_results"] == 11
    assert brand["provider_credits"] == 1
    assert brand["latency_ms"] == 123
    assert generic["query"] == "kopi keliling"
    assert generic["precision_at_10"] == 1.0
    assert generic["benchmark_recall_at_10"] is None
    assert zero["query"] == "qzxv meralopi 8j7rf"
    assert zero["total_usable_results"] == 0
    assert zero["precision_at_10"] is None


def test_replay_keeps_unknown_labels_and_charges_unmeasured(tmp_path):
    data = json.loads(FIXTURE.read_text())
    generic = data["cases"][1]
    generic["labels"] = {}
    generic["provider_credits"] = None
    generic["latency_ms"] = None
    path = tmp_path / "capture.json"
    path.write_text(json.dumps(data))

    result = run_benchmark(path)
    assert result.returncode == 0, result.stderr
    generic_result = json.loads(result.stdout)["results"][1]
    assert generic_result["unjudged_top_10_ids"] == ["generic"]
    assert generic_result["precision_at_10"] is None
    assert generic_result["provider_credits"] is None
    assert generic_result["latency_ms"] is None


def test_replay_rejects_inconsistent_stage_identities(tmp_path):
    data = json.loads(FIXTURE.read_text())
    data["cases"][0]["ranked_ids"].append("untracked")
    path = tmp_path / "capture.json"
    path.write_text(json.dumps(data))

    result = run_benchmark(path)
    assert result.returncode != 0
    assert "ranked_ids must be a subset of normalized_ids" in result.stderr


def test_failed_retrieval_is_distinguished_from_a_successful_empty_page(tmp_path):
    data = json.loads(FIXTURE.read_text())
    empty = data["cases"][2]
    empty["outcome"] = "failed"
    empty["benchmark_ids"] = ["known"]
    path = tmp_path / "capture.json"
    path.write_text(json.dumps(data))

    result = run_benchmark(path)
    assert result.returncode == 0, result.stderr
    failed = json.loads(result.stdout)["results"][2]
    assert failed["benchmark_ids_missing_from_raw"] is None
    assert failed["benchmark_recall_at_10"] is None
    assert failed["total_usable_results"] is None
