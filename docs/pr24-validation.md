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
| External owner-run suite | Separate local runner covers four scenario buttons and 16 directed tool cases with two repetitions by default. It checks tool outputs, unchanged business state, proposal display, complete durations, cost and truncation. See [live acceptance](live-acceptance.md). |
| Dedicated credential and isolation | External preflight starts an unavailable-provider server with a temporary SQLite database and no environment-file loader. Missing `PARCEL_LIVE_TEST_API_KEY` reports not run even when the application-key variable is set. No live inference was run by the agent. |

## Local checks

Validation uses Node 24.19.0 and Playwright 1.62.1 through Vite Plus.

- `vp run check`: 161 unit and integration tests, client/server type checks, and production build passed.
- `vp run test:e2e`: 38 desktop and narrow browser cases passed.
- Targeted runtime regressions passed again after the consent trace lookup was made independent of Audit pagination.
- Final proof captures Work, Explore, Audit, proposal review, and the acknowledgement at 1440×1000 and 320×900. Playwright also records the proposal-to-acceptance flow and the model-selected consent flow.
- External runner syntax, no-inference preflight, and missing-dedicated-key behavior passed. The preflight records zero provider attempts and explicitly reports live acceptance as not run.

## Visual comparison notes

The approved prototype is unchanged. Both it and the application are served over
loopback HTTP by temporary servers managed by Playwright. The capture waits for
the intended state, fonts, images and rendering frames. Comparisons label the
reference and implementation and use matching viewport and browser settings.

The actual queue contains the agreed 24 seeded orders and six eligible changes;
the prototype illustrates four orders and two changes. The larger review therefore
scrolls. Separate acknowledgement comparisons show the chat at narrow widths.
The application keeps its existing connection indicator and recovery controls.
Explore shows 16 actual tools instead of the prototype's 14 illustrative entries.
The consent card names BB-1076 so the model can look up the relevant evidence.
Audit shows retained request IDs, actual recorded tool outcomes and completed-work
measurements instead of the prototype's illustrative timings and first-output
metric. These differences preserve the approved colors, work/chat layout,
review-before-acceptance behavior, and narrow-screen ordering.
