# Bounded provider benchmark

Mode: live

Measured revision: bfe74280c512ae8677260fc0d8844e750e1283be

Fixture digest: 7cc2cc38f2425ab080d3c2e0d25457d1977221b01dd190b96f0ae0035f89d971

Stop reason: completed

Attempted requests: 28 of at most 28

This deliberate sample covers only the listed synthetic cases. It does not establish broad model speed or quality.

The fixed order was Jev followed by Ministral. Order effects were not randomized in this run.

The tool results below measure a two-request benchmark sequence with real registry validation and local read-only tool execution. They are not app server-turn or browser Send-to-completed-work timings. Live browser timing was not measured by this command.

Scenario completion applies fixed required-fact checks for these two synthetic tasks. It is not a general factual-correctness score. The retained answers require manual inspection.

## Constrained classifications

| Model | Attempted / planned | Valid | Failed or invalid | Accuracy over attempts | Accuracy over valid responses | Unsafe explicit approvals | Provider response p50 / p95, ms | Correct work p50 / p95, ms | Input / output tokens | Cost known / unknown |
| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| jev | 12 / 12 | 12 | 0 | 100.0% (12/12) | 100.0% (12/12) | 0/5, missing or invalid 0 | 264.4 / 531.4 (n=12, nearest-rank) | 264.4 / 531.4 (n=12, nearest-rank) | 6033 / 647 (0 / 0 unknown) | $0.00025339 / 0 |
| ministral | 12 / 12 | 12 | 0 | 91.7% (11/12) | 91.7% (11/12) | 1/5, missing or invalid 0 | 312.2 / 3374.3 (n=12, nearest-rank) | 312.2 / 3374.3 (n=11, nearest-rank) | 2649 / 138 (0 / 0 unknown) | $0.00022110 / 0 |

## Tool scenario sequences

Completed sequences: 1/2 attempted, 2 planned.

Valid provider-response latency: p50 340.7 ms, p95 1359.8 ms, n=3, nearest-rank.

Completed sequence latency: p50 2008.2 ms, p95 2008.2 ms, n=1, nearest-rank.

Known scenario cost subtotal: $0.00012570. Unknown cost count: 0.

Known scenario input/output token subtotals: 742/515. Unknown input/output counts: 0/0.

Every attempted request and failure is in `attempts.json`. Machine-readable summaries are in `report.json`.
