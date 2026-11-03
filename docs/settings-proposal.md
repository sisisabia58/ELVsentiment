# Monitor settings

The approval commit turns on scoring, topic labels, topic counting, and the shared-operator credential policy. `high_impact`, `jev_fallback_rule`, and `x-budget` stay off. Threshold numbers below are the live scoring values once that commit is on this branch.

## Scoring thresholds

| Name | Value | Meaning |
| --- | --- | --- |
| `relevanceExcludeMax` | **0.35** | Relevance noul at or below this is treated as confidently irrelevant (excluded bucket). |
| `relevanceIncludeMin` | **0.75** | Relevance must reach this before a post can count as relevant; between exclude max and this minimum stays in review. |
| `sentimentConfidenceMin` | **0.70** | Below this, sentiment is uncertain (Belum yakin / `not_sure` with `sentimentUncertain`). |
| `topicNoulMin` | **0.65** | Topic ids need noul at or above this to count; otherwise the fallback topic applies. |
| `attentionNegativeConfidenceMin` | **0.85** | Negative mentions need sentiment confidence at or above this to appear in Perlu perhatian. |

## Topic labels (eight scored topics)

Each row is an id, the label shown in the product, and a short gloss of the English instruction in `config/topic-labels.json`. The JSON `instructions` string is what Jev receives.

| Id | Label | Instruction summary |
| --- | --- | --- |
| `harga` | Harga | Price, cost, or value for money. |
| `kualitas` | Kualitas produk | Quality, taste, durability, or whether the product works. |
| `layanan` | Layanan pelanggan | Customer service, staff, or business response. |
| `pengiriman` | Pengiriman | Delivery, shipping time, or courier. |
| `promo` | Promo | Discounts, vouchers, or promotions. |
| `stok` | Ketersediaan stok | In stock or sold out. |
| `kemasan` | Kemasan | Packaging or parcel condition. |
| `pengalaman` | Pengalaman pembelian | Buying experience, checkout, or ordering. |

## Fallback topic

| Name | Value | Meaning |
| --- | --- | --- |
| `fallbackTopicId` (`lainnya`) | **lainnya** | Used when no topic clears `topicNoulMin`; not asked as its own Jev question. Owners can save it and see it in the review form as Lainnya. |

## Approval flags

Scoring, topic labels, topic counting, and the shared-operator credential policy are turned on by the approval commit. `high_impact`, `jev_fallback_rule`, and `x-budget` stay off.

| Flag | Value | Meaning |
| --- | --- | --- |
| `scoring_policy` (launch-approvals) | **true** | Turned on by the approval commit so numeric thresholds apply to routing. |
| `topic_labels` (launch-approvals) | **true** | Turned on by the approval commit so the topic label set is live. |
| `topic_counting` (launch-approvals) | **true** | Turned on by the approval commit so topic counts are allowed. |
| `topic-labels.json` `approved` | **true** | Turned on by the approval commit together with the launch flags above. |
| `credential_policy` | **true**, mode `shared_operator` | Shared-operator credential policy is turned on by the approval commit. |
| `high_impact` | **false** | High-impact attention reasons stay off. |
| `jev_fallback_rule` | **false** | OpenRouter fallback rule stays off. |
| `x-budget.json` `approved` | **false** | X API budget cap stays off. |

How to start, check, stop, and roll back the production scorer is in `docs/operator-scoring.md`. The scorer is a separate Railway service on the web image. Its start command is `exec node dist/scoring/cli.js --loop` and its working directory is `/app/apps/web`. OpenRouter stays off.

Inside one request, retries are only HTTP 429, HTTP 5xx, and timeouts. A dropped connection (`{ network: true }`) is not retried inside that request. The claim commits before the Jev call and stores `scoring_claimed_at` plus `scoring_attempts`. The next run returns a `scoring` row to `pending` when the claim is older than 180 seconds, or when `scoring_claimed_at` is null, and then scores it again. Each claim counts as one attempt. After 3 attempts, another retryable failure or a stale claim is marked `failed` and is not picked up again. HTTP 4xx other than 429, and an invalid judgment, are marked `failed` on that claim. OpenRouter stays off. To retry one terminal row, set that row's `scoring_status` to `pending` and `scoring_attempts` to 0. Leave rows whose claim is still inside the lease alone.
