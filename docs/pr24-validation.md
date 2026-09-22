# Agent workflow validation

Issue #23 keeps model selection automatic while allowing ordinary multi-step
workflows to finish. All 16 registered tools are offered on every model request.
The consent Explore card now submits its order-specific question to the same
Ministral loop as chat. Jev runs only when the model chooses a classification
tool. A missing or unsuccessful consent check remains a failed scenario with its
actual inference trace.

Proposal preparation waits for the initiating browser's display acknowledgement.
After the requested tool calls finish, a displayed proposal receives this
application-generated message without another model request:

> The proposal is ready for your review. Nothing changes until you accept it.

Tool failures remain in the final message. Missing proposal UI produces a failed
tool result with a saved-proposal recovery instruction. Cancellation and reset
retain their existing terminal states. A successful server turn still waits for
the browser's final-render acknowledgement before recording completed work.

## Acceptance evidence

| Requirement | Evidence |
| --- | --- |
| Full registry and automatic selection | Runtime regressions check all 16 tool names and `auto` on each of five consecutive requests, and on the consent path. |
| Lookup, note, and teaching instructions | General system instructions distinguish order IDs, actual note text, consent evidence, and the three available tutorials. Registry descriptions reinforce those choices. Live selection accuracy remains for the owner's suite. |
| Factual proposal acknowledgement | Regression checks one request for a displayed batch, persisted tool results, unchanged orders and no receipt; browser checks confirm the message and pending human acceptance. |
| Bounded larger responses | Provider regression consumes 4,096 SSE fragments above the old byte limit and rejects token allowances above 4,096. Runtime permits eight requests, six tools per request, a 32 KiB request context and bounded stored history. Chat permits 2 MiB per response and 120 seconds per provider attempt. |
| Failure handling | Tests cover missing UI, failed preparation, another failed tool beside a displayed proposal, cancellation, reset, exhausted credits, the eight-request stop, and missing final-render acknowledgement. |
| Real Explore selection | Supplied-adapter tests verify Ministral chooses consent and that an answer without a consent tool call is not replaced with a direct Jev success. Browser tests retain the delayed visible-Audit acknowledgement check. |
| Explicit paid suite | Repository script `vp run test:live` covers four scenario buttons and 16 directed tool cases with two repetitions by default. It checks tool outputs, unchanged business state, proposal display, complete durations, cost and truncation. See [live acceptance](live-acceptance.md). |
| Dedicated credential and isolation | External preflight starts an unavailable-provider server with a temporary SQLite database and no environment-file loader. Missing `PARCEL_LIVE_TEST_API_KEY` reports not run even when the application-key variable is set. No live inference was run by the agent. |

## Local checks

Validation uses Node 24.19.0 and Playwright 1.62.1 through Vite Plus.

- `vp run check`: 161 unit and integration tests, client/server type checks, and production build passed.
- `vp run test:e2e`: 38 desktop and narrow browser cases passed.
- Targeted runtime regressions passed again after the consent trace lookup was made independent of Audit pagination.
- Final proof captures Work, Explore, Audit, proposal review, and the acknowledgement at 1440×1000 and 320×900. Playwright also records the proposal-to-acceptance flow and the model-selected consent flow.
- Runner syntax, no-inference preflight, missing-dedicated-key behavior, and offline setup-failure, exhausted-credit, truncation, and highlight assertions passed. The preflight records zero provider attempts and explicitly reports live acceptance as not run.

## Owner live run and runner corrections

The first owner run returned 27 passes and 13 failures, with no reported output
truncation. Five cases hit SQLite read locks, and both Undo cases timed out on an
incorrect exact-text receipt assertion despite successful acceptance. The runner
now waits for SQLite locks and matches the receipt state correctly. At the owner's
request, the suite now lives in the repo, runs headlessly with automated disposable
receipt setup, and retains its report, database, screenshots, and traces under
`artifacts/live/`. This replaces the issue's original external-runner requirement.

Three malformed provider responses, two highlight failures, and one missed batch
preparation remain unproven. The old report discarded the evidence needed to
identify their cause. The new runner retains provider error messages and redacted
responses plus complete local audit data so the next owner-run suite can be
diagnosed. No successful paid rerun is claimed.

The repository runner's `--self-test` passed with a separate process holding an
exclusive SQLite lock. Its `--check` built the application and completed the
headless acceptance/receipt flow with zero provider requests. The final screenshot
was inspected. Missing dedicated credentials returned exit code 1 even with the
ordinary application key set to a dummy value. Retained databases and traces were
confirmed gitignored. No application UI changed in this runner update.

## Second owner live run

The retained run `2026-09-22T18-42-15.592Z` passed 36 of 40 cases. Both Undo
cases and all batch cases passed; there were no database lock failures, unknown
cost attempts, or reported truncations. Reported cost was $0.00403886 across 96
provider attempts. The four failures were:

- Both highlight cases read the order, then tried to highlight its evidence
  without opening the order. The browser correctly reported the target missing.
- One overview listed only ready orders and omitted queue grouping.
- One overview failed input validation for `listOrders`. The adapter still
  omitted the rejected arguments, so their exact defect cannot be established.

The general model instructions now distinguish data lookup from opening a view,
require successful order navigation before highlighting evidence, and describe
unfiltered listings and status grouping for a queue overview. Rejected calls now
retain JSON arguments through existing credential redaction, allowing the next
schema error to be diagnosed without accepting invalid arguments. A regression
test proves both rejection and redaction. These are prompt and diagnostic changes;
no successful paid rerun is claimed. The full offline check passed 162 tests,
typechecking, and production build.
The existing scripted browser workflow for opening and highlighting evidence,
preparing a batch, and preparing reset also passed at desktop and narrow widths.

## Overview outcome checks and one authorized paid run

The owner approved a follow-up to define the overview answer, clarify read-tool
instructions, and verify facts rather than a required tool sequence. The overview
now asks for status totals and up to three review examples with recorded issues.
The runtime asks for compact count and order lines. `listOrders` descriptions
explain that each row keeps status, family, and issue together; `groupOrders`
descriptions explain that separate status and family groups are not intersections.
All 16 tools remain available with automatic selection.

The live checker compares final overview counts and each example's ID, review
status, family, and exact issue against the pre-turn database. It permits compact
lines and labeled ID/family/Issue blocks, ignores harmless Markdown styling and
separators, and rejects unsupported extra claims. A successful queue read is
required, with no fixed sequence. Dedicated cases still check every named tool.
Offline regressions reject wrong totals, wrong status/family/issue, unknown or
repeated IDs, missing facts, and invented urgency. This is a defined answer
contract, not a general natural-language fact checker.

The owner explicitly authorized one agent-run paid invocation, overriding the
default human-only restriction for that invocation. It ran with two samples and
retained evidence at `artifacts/live/2026-09-22T18-59-14.375Z/`. Original result:
36 passed, 4 failed, 95 provider attempts, $0.00400660 known cost, zero unknown-cost
attempts, and zero truncations. No retry was made under that authorization.

The retained failures established:

- Overview sample 1 sent `listOrders` with `status: review` and `family: null`.
  Optional list filters now explicitly accept null as no filter. Invalid enum
  values, unknown fields, and null required IDs remain rejected. Offline registry
  and runtime regressions prove null and omitted filters behave alike.
- Overview sample 2 returned correct counts and three correct recorded issues in
  labeled blocks. The final checker accepts that format. An offline reassessment
  of the unchanged saved answer passed, recorded in `overview-reassessment.json`.
- Both audit-trace prerequisites read the order, then attempted an unrequested
  highlight without navigation. The prerequisite prompt now explicitly asks for
  the saved address only and no navigation or highlighting. That prompt change
  has not had a paid verification run.

The final offline check passed 163 tests, typechecking, and production build.
Playwright captured the updated overview flow at 1440×1000 and 320×900; all four selected tests passed. The screenshots and recording were inspected. Files are under `artifacts/overview-proof/`.
The owner then explicitly authorized one additional run. The final suite passed
40/40 cases, including both overview fact checks and repeated coverage of all
16 tools. Evidence is retained at `artifacts/live/2026-09-22T19-04-03.714Z/`.
All 40 turns had completed browser measurements: p50 994.8 ms, p95 2232.1 ms.
The run recorded 100 provider attempts, $0.00449172 known cost, zero unknown-cost
attempts, and zero truncations. This establishes the two sampled repetitions;
it does not guarantee every future model response.
