import json
import sys
from pathlib import Path


def _rows(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def evaluate(labels_path: Path, predictions_path: Path, criteria_path: Path) -> int:
    criteria = json.loads(criteria_path.read_text(encoding="utf-8"))
    thresholds = (
        criteria.get("relevance_max_error_rate"),
        criteria.get("sentiment_max_error_rate"),
        criteria.get("topic_min_exact_agreement"),
        criteria.get("uncertain_routing_min_recall"),
    )
    if criteria.get("approved") is not True or criteria.get("includes_informal_indonesian") is not True:
        return 2
    if any(value is None for value in thresholds):
        return 2
    labels = _rows(labels_path)
    if any(row.get("launch_set") is not True for row in labels):
        return 2
    predictions = {row["id"]: row for row in _rows(predictions_path)}
    relevance_compared = relevance_errors = 0
    sentiment_compared = sentiment_errors = 0
    topic_compared = topic_matches = 0
    uncertain_total = uncertain_hits = 0
    for label in labels:
        prediction = predictions[label["id"]]
        relevance_compared += 1
        if bool(label["relevant"]) != bool(prediction["relevant"]):
            relevance_errors += 1
        if label["relevant"] and label.get("sentiment") is not None:
            sentiment_compared += 1
            topic_compared += 1
            if label["sentiment"] != prediction.get("sentiment"):
                sentiment_errors += 1
            if set(label.get("topics") or []) == set(prediction.get("topics") or []):
                topic_matches += 1
        if label.get("human_uncertain") is True:
            uncertain_total += 1
            if prediction.get("routing_bucket") == "not_sure":
                uncertain_hits += 1
    relevance_rate = relevance_errors / relevance_compared if relevance_compared else 0
    sentiment_rate = sentiment_errors / sentiment_compared if sentiment_compared else 0
    topic_agreement = topic_matches / topic_compared if topic_compared else 1
    uncertain_recall = uncertain_hits / uncertain_total if uncertain_total else 1
    if (
        relevance_rate <= criteria["relevance_max_error_rate"]
        and sentiment_rate <= criteria["sentiment_max_error_rate"]
        and topic_agreement >= criteria["topic_min_exact_agreement"]
        and uncertain_recall >= criteria["uncertain_routing_min_recall"]
    ):
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(evaluate(Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])))
