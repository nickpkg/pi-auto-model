# Routing evaluation corpus

This is a hand-authored, deterministic smoke corpus for release regression checks. It is not a public benchmark and does not claim to measure model-answer quality. Cases cover English and Chinese simple work, debugging, refactoring, architecture, incident response, and security review.

The gate measures route-selection accuracy, over-routing, under-routing, and a relative catalog-cost index against always selecting the frontier fixture model. Expand or replace it with a licensed real-task corpus when production traces can be safely anonymized and labeled.

## Offline acceptance and real-task protocol

Run `npm run check` without provider credentials. The suite uses fake provider streams; it must not call paid models. Missing routes fail the gate instead of being counted as frontier selections. Integration checks cover restricted routing, cancellation, partial streams, full tool-loop reservations, cross-provider actual cost, split compaction, and side-effect-free previews.

Before claiming quality preservation or monetary savings, compare the router and fixed-model baselines on the same versioned, licensed task snapshots. Use separate calibration and held-out tasks, with executable acceptance tests for code edits/debugging and a documented review rubric for non-code tasks. Do not tune and report on the same twelve smoke prompts.

For every task and baseline, record: task/repository revision, router config and model IDs, acceptance-test result, completion/cancellation/failure, all attempted targets, token/cache usage, reported cost (unknown when unavailable), wall time, and TTFT. Include classifier, compaction and failed-attempt costs in the total. Report success rate, cost per accepted task, latency p50/p95, failover rate, and the share of unknown-cost runs. A successful API response alone is not a successful task; synthetic catalog-cost ratios are not invoice savings.

Real provider evaluation is intentionally not automated here: it needs approved tasks, credentials and an explicit spending allowance. No real-answer quality or real-cost result has been collected by this offline gate.
