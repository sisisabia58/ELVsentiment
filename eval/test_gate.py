import json
from pathlib import Path

from gate import evaluate

ROOT = Path(__file__).resolve().parents[1]


def test_committed_criteria_block_launch():
    sample = Path(__file__).parent / "format-sample.jsonl"
    assert evaluate(sample, sample, ROOT / "config" / "eval-criteria.json") == 2


def test_user_thresholds_are_applied(tmp_path):
    labels = tmp_path / "labels.jsonl"
    predictions = tmp_path / "predictions.jsonl"
    criteria = tmp_path / "criteria.json"
    labels.write_text(
        json.dumps(
            {
                "id": "1",
                "relevant": True,
                "sentiment": "positive",
                "topics": ["harga"],
                "human_uncertain": False,
                "informal": True,
                "launch_set": True,
            }
        )
        + "\n",
        encoding="utf-8",
    )
    predictions.write_text(
        json.dumps(
            {
                "id": "1",
                "relevant": True,
                "sentiment": "positive",
                "topics": ["harga"],
                "routing_bucket": "included",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    criteria.write_text(
        json.dumps(
            {
                "approved": True,
                "includes_informal_indonesian": True,
                "relevance_max_error_rate": 0,
                "sentiment_max_error_rate": 0,
                "topic_min_exact_agreement": 1,
                "uncertain_routing_min_recall": 1,
            }
        ),
        encoding="utf-8",
    )
    assert evaluate(labels, predictions, criteria) == 0
    predictions.write_text(
        json.dumps(
            {
                "id": "1",
                "relevant": False,
                "sentiment": "negative",
                "topics": [],
                "routing_bucket": "excluded",
            }
        )
        + "\n",
        encoding="utf-8",
    )
    assert evaluate(labels, predictions, criteria) == 1
