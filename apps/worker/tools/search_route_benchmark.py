"""Score sanitized search route captures from disk without making requests."""

from __future__ import annotations

import argparse
import json
from pathlib import Path


def score_case(case: dict) -> dict:
    raw_ids = set(case["raw_ids"])
    normalized_ids = set(case["normalized_ids"])
    ranked_order = list(dict.fromkeys(case["ranked_ids"]))
    ranked_ids = set(ranked_order)
    benchmark_ids = list(dict.fromkeys(case["benchmark_ids"]))
    labels = case["labels"]
    outcome = case["outcome"]

    if not normalized_ids <= raw_ids:
        raise ValueError("normalized_ids must be a subset of raw_ids")
    if not ranked_ids <= normalized_ids:
        raise ValueError("ranked_ids must be a subset of normalized_ids")
    if not set(labels.values()) <= {"direct", "weak"}:
        raise ValueError("labels must be direct or weak")
    if outcome not in {"success", "partial", "failed", "unavailable"}:
        raise ValueError("outcome must be success, partial, failed, or unavailable")

    top_10 = ranked_order[:10]
    unjudged = [post_id for post_id in top_10 if post_id not in labels]
    direct_matches = None if unjudged else sum(labels[post_id] == "direct" for post_id in top_10)
    recovered = [post_id for post_id in top_10 if post_id in benchmark_ids]
    first_weak_index = next(
        (index for index, post_id in enumerate(ranked_order) if labels.get(post_id) == "weak"),
        len(ranked_order),
    )
    below_weaker = [
        post_id for post_id in ranked_order[first_weak_index + 1 :]
        if post_id in benchmark_ids
    ]

    result = {
        key: case[key]
        for key in ("query", "route", "params", "page_count", "outcome", "latency_ms", "provider_credits")
    }
    result["coverage"] = case.get("coverage")
    dropped_ids = raw_ids - normalized_ids
    excluded_ids = normalized_ids - ranked_ids
    metrics = {
        "top_10_ids": top_10,
        "direct_matches_at_10": direct_matches,
        "unjudged_top_10_ids": unjudged,
        "precision_at_10": direct_matches / len(top_10) if top_10 and direct_matches is not None else None,
        "benchmark_ids_recovered_at_10": recovered,
        "benchmark_recall_at_10": len(recovered) / len(benchmark_ids) if benchmark_ids else None,
        "benchmark_ids_missing_from_raw": [post_id for post_id in benchmark_ids if post_id not in raw_ids],
        "benchmark_ids_dropped_in_normalization": [post_id for post_id in benchmark_ids if post_id in dropped_ids],
        "benchmark_ids_excluded_before_ranking": [post_id for post_id in benchmark_ids if post_id in excluded_ids],
        "benchmark_ids_ranked_below_top_10": [post_id for post_id in ranked_order[10:] if post_id in benchmark_ids],
        "benchmark_ids_ranked_below_weaker_items": below_weaker,
        "total_usable_results": len(ranked_order),
    }
    result.update(metrics if outcome in {"success", "partial"} else dict.fromkeys(metrics))
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("capture", type=Path, help="sanitized benchmark capture JSON")
    args = parser.parse_args()
    try:
        capture = json.loads(args.capture.read_text(encoding="utf-8"))
        provenance = capture["provenance"]
        if provenance not in {"synthetic", "staging"}:
            raise ValueError("provenance must be synthetic or staging")
        results = [score_case(case) for case in capture["cases"]]
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.error(str(error))
    print(json.dumps({"provenance": provenance, "results": results}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
