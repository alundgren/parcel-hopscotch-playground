# Acceptance report, 2026-09-22

This report covers deterministic application acceptance on a headless Linux x86_64 VM with four available CPUs, Node v24.21.0, and Chromium 151.0.7922.34. The tests use the scripted providers through the application WebSocket transport and SQLite repository. They do not make paid provider requests.

## Complete-flow coverage

The 36 Playwright cases run at 1440×1000 and 320×900. Together they cover:

- Work filtering and evidence, address and batch review, explicit acceptance, Undo, reset, selected-work context, final replies, stale batch rejection, and reset during an active turn.
- Agent tool calls, UI navigation, reconnect after transport loss, retirement of a replaced browser session, and a deterministic provider failure with recovery.
- Separate users' turns, audit history, accepted data, provider failures, and resets through two independent browser contexts.
- Conditional consent and exhausted stock without an acceptance action.
- All three tutorials, including navigation, cancellation, verified completion, independent cases, and reset.
- Explore catalogue filters and details, all four scenario cards, exact Audit links, and recovery of completed examples through review.
- Audit search, every detail tab, live updates, retained reset history, and retained interrupted/error outcomes.

The acceptance tests assert browser-visible results after the real server has handled each command. A separate integration correction checks the intended provider-attempt record for numeric audit searches, so random UUID digits cannot make the assertion ambiguous. Production substring search behavior is unchanged.

## Completion measurements

The deterministic batch flow records each completion boundary separately:

| Viewport | Server turn | Browser Send-to-completed-work | Accept-to-committed-visible-update |
| --- | ---: | ---: | ---: |
| 1440×1000 | 337 ms | 420 ms | 43.1 ms |
| 320×900 | 194 ms | 240 ms | 70.8 ms |

These are individual acceptance samples from this Linux VM. They are regression evidence for the actual transport and persistence path, not provider performance samples. The live benchmark has separate provider-request and harness-sequence timings and did not run a browser.

## Visual evidence

`pnpm proof:visual` captures Work, Explore, and Audit from the unchanged approved prototype and the application at the same task state and viewport. Each output is labeled with its source, view, and pixel dimensions.

The implementation keeps the approved layout and visual hierarchy. Deliberate content differences are visible in the comparisons:

- Work displays the full 24-order seeded workspace and its six ready orders; the prototype uses four illustrative orders and two ready orders.
- Explore displays all 16 registered tools from the typed registry; the prototype contains 14 illustrative tools.
- Audit displays retained application records, completed-work timing, and the full validated consent result. The prototype uses illustrative records and includes the obsolete first-useful timing label.

## Live provider evidence

The [live benchmark report](benchmarks/2026-09-22-live/README.md) and its machine-readable artifacts retain the single authorized 28-request run. Jev completed 12/12 constrained cases with 0/5 unsafe explicit approvals. Ministral completed 11/12 with 1/5 unsafe explicit approvals. One of two tool sequences completed; the other retained an `incomplete_response` at the 256-token cap. All attempts reported cost, totaling $0.000600186.

## CI evidence retention

The browser job always uploads `playwright-report` and `test-results`, including videos, screenshots, and traces on failure. Artifacts are retained for 14 days. CI uses Node 26.7.0, separate from the local Linux measurements above.
