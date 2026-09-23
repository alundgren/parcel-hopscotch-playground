# Exploratory QA validation

## Owner-reported incident

The owner reported a production incident on 2026-09-23 involving the synthetic
seeded order BB-1051. Accepting its substitution changed the blue mug to sage at
the same GBP 24 price, reserved one sage mug, and committed version 2. The order
remained Ready because release to packing was a separate action.

When asked why the order looked unchanged, the assistant invented a version
mismatch and offered the substitution again. After the tool reported that the
resolution was already accepted, it suggested rejecting that resolution or
accepting a change with no effect. A later accepted ready batch released the
order to packing at version 3.

This report supplies the fifth mission's starting question and expected state
transitions. It is evidence of one user's difficulty, not a frequency estimate.
The investigator must check receipts and persisted order state. The explorer
receives the operator's task without the expected explanation.

The local fixture starts with four sage mugs. The verifier caught the difference
from the reported one-mug starting condition. Prepare that condition with three
ordinary `Advance stock scenario` actions, then verify one available mug and
BB-1051 at version 1 before the mission. Do not silently assume the seed has one.

## First live session

Run `2026-09-23T19-06-48-037Z-7493d01f-722f-434b-9d30-eabb3893667d`
used revision `37c4cfa`, persona version 1, a two-hour limit, and a USD 0.10
spending stop threshold. The fresh explorer requested Luna Max and saw only its
persona, queue-triage mission, and controlled browser instructions. The runtime
did not separately report an actual model identifier.

The explorer asked which orders could be worked and which needed review or
waiting. The assistant reported six ready, zero review, and zero waiting, then
placed BB-1112 under review or waiting. The rendered queue and persisted fixture
agreed on six ready, fourteen review, and four waiting. BB-1112 was ready.
Observation `895264a7-860c-41a5-9ece-a3ffdcd6790c` records that discrepancy.

Investigation found that the model requested `listOrders` with a ready filter,
then treated those six results as the whole queue. The correction supplies
whole-queue totals separately from filtered counts and tells the model to match
each named order to its recorded status. Deterministic checks exercise the ready
filter and related unfiltered/review queries. These checks prove available tool
data, not live model compliance.

The first answer completed in 1,849 ms according to the app's browser completion
measurement. A follow-up failed with `transport_error`; its cause is unknown.
The run retained USD 0.000266 known cost, one request with unknown cost, 4,226
known input tokens, and 162 known output tokens across three provider attempts.
The QA gate stopped further inference. Other missions were not attempted in
this session. Missing tokens and cost are not zero.

The inspected synthetic lesson `triage-compare-all-statuses` records the need to
check whole-queue counts and individual classifications separately. Raw browser
evidence, screenshots, SQLite state, and the unresolved transport finding remain
under the private local QA run directory. Selected synthetic lessons and verified
regression cases are committed separately from that evidence.

## Second live session and follow-up investigation

Run `2026-09-23T19-25-15-837Z-bd097df9-327b-41c4-95fd-178a5d2dc088`
started at `bf25a04` with persona version 2 and all five missions. Its coordinator
consumed `triage-compare-all-statuses`; the fresh explorer packet contained no
memory or expected answers. Later missions reused that explorer as a returning
user, with that condition stated in each dispatch.

The initial queue answer correctly reported six ready, fourteen review, and four
waiting, with BB-1112 ready. This verifies the earlier count correction in a fresh
live answer. A separate phrase still called BB-1112 a duplicate; a follow-up
corrected that claim. Passing the count check did not make all wording correct.

The explorer accepted BB-1051's replacement through the normal review control.
The verifier found one sage mug reserved, the sage item at GBP 24, version 2,
resolved and incomplete. The model nevertheless compared current version 2 with
the receipt's pre-acceptance `expectedVersion: 1` as though they matched. It also
suggested accepting all six eligible orders and undoing only five, although the
application supports whole-receipt Undo. The explorer left that batch unaccepted.

These failures led to model-facing receipts that report actual committed versions
and business changes, plus explicit descriptions of the available batch and Undo
operations. Independent verification also found the old version field in selected
receipt context, separate from `getOrder`; both paths need the same interpretation.
Internal proposal versions still protect acceptance and Undo from stale changes.

The address mission succeeded: BB-1042 changed from 14 to 41 Willow Lane while
keeping Bath and BA1 2AB. Reopened UI and persisted state agreed on version 2,
Ready, resolved, and incomplete. Acceptance opened another pending proposal, so
the explorer canceled that review before checking the saved address.

The conditional-consent mission ended with BB-1076 unchanged at version 1. Its
proposal had no changes and a disabled Held control. The first answer recommended
acceptance despite the request for a picture; later advice correctly distinguished
conditional from explicit consent. The runtime also called the held proposal
ready for review using its fixed acknowledgement. Those are recorded failures
of explanation; the server's consent check prevented the incorrect substitution.

The recovery mission reversed the single-change substitution receipt. The saved
order returned to blue at version 3, unresolved and incomplete; available sage
stock returned to one. A reload preserved this. Ready beside an unavailable-item
issue remained confusing to the explorer. This is a wording concern, separate
from the successful Undo transaction.

## Focused live verification

Run `2026-09-23T19-51-17-488Z-a9c904ca-0398-453d-9ef8-5df30932678a`
used `5c2f5e5`. A fresh explorer received the same task, without prior findings.
It correctly learned that packing includes every eligible Ready order and Undo
reverses the whole receipt. It inspected and accepted the six-order batch, then
confirmed after reload that BB-1051 was released to packing at version 3.
However, the first answer still understated the remaining action. The explorer
also could not inspect the exact values behind BB-1112's comparison note. Whether
that note is sufficient review evidence remains a product question.

Run `2026-09-23T20-00-30-088Z-5e7a7fcc-c235-44ca-9e08-c9260fe82d2c`
used `a097e4b`, which also corrects selected-receipt context. **The owner-reported
explanation remains unresolved.** `getOrder` supplied the sage item at GBP 24,
version 2, resolved and incomplete, plus the accepted blue-to-sage receipt. The
answer nevertheless said the item would update only on batch acceptance and
that no action remained. An independent verifier checked both the captured answer
and stored tool history. The precise reason the model ignored these facts is
unproven; this replay rules out missing `getOrder` data as the explanation.

The later human-accepted batch again produced version 3 and completion. The
explorer also found contradictory BB-1063 fixture data: the issue and warehouse
note say the throw is reserved, while its business state says it is not. The
batch reserves one throw. This is a separate confirmed data defect, retained for
correction rather than explained away by the assistant.

Both focused runs consumed the earlier triage and accepted-resolution lessons
with source revisions recorded; their fresh explorer packets excluded those
lessons. The failed owner explanation was not promoted as a verified regression.

The last explorer initially used screenshot labels with spaces. Four captures
failed with `Screenshot label must contain only letters, numbers, dashes, or
underscores.` Its packet did not state that restriction and the wrapper hid the
specific error. The wrapper now rejects invalid labels with an actionable message,
and packets state the rule. The same explorer then captured and inspected the
saved receipt at desktop and 320px widths without further inference. This helper
correction was made during capture recovery; the app remained at `a097e4b`.

## Cost and completed-work measurements

Every run used a USD 0.10 stop threshold and a two-hour maximum, ending earlier
when its planned work finished or accounting stopped inference. Provider attempts
include tool rounds and the app's consent-model calls, not just user messages.

| Run | Known USD | Unknown-cost attempts | Known input / output tokens | Provider attempts |
| --- | ---: | ---: | ---: | ---: |
| 1 | 0.000266 | 1 | 4,226 / 162 | 3 |
| 2 | 0.006941454 | 0 | 127,287 / 1,836 | 29 |
| 3 | 0.002164880 | 0 | 50,681 / 459 | 13 |
| 4 | 0.001475380 | 0 | 35,563 / 618 | 9 |

Known spending totals USD 0.010847714, plus the first run's unknown amount. No
run crossed its threshold. This is not an efficiency comparison: missions,
conversation length, and correctness differed. A cheap inaccurate answer is not
counted as an efficient successful result.

App send-to-completed-work measurements, excluding browser-driver overhead:

| Run | Completed turns | Minimum / median / maximum milliseconds |
| --- | ---: | ---: |
| 1 | 1 | 1,849 / 1,849 / 1,849 |
| 2 | 15 | 702 / 1,758 / 5,391 |
| 3 | 8 | 608 / 1,300 / 2,218 |
| 4 | 6 | 592 / 1,927 / 4,140 |

Accept-to-committed-visible-update measurements were 42.2 ms for run 3's
substitution, and 53.8 ms / 56.8 ms for run 4's substitution / packing batch.
Run 2 had no such measurements, and run 3's batch measurement was absent when an
older pending proposal replaced the receipt. Missing measurements are not zero.

## Remaining investigations

| Finding | Supported cause or uncertainty | Next action |
| --- | --- | --- |
| Incorrect accepted-work explanation | Live answer contradicts correct tool facts; precise model failure is unknown. | Compare structured, application-owned progress explanations with model narration using the retained original case. |
| Unrelated proposal replaces accepted result | Snapshot selects another pending proposal; the client effect opens it and clears the receipt. | Limit automatic restoration and verify acceptance with multiple pending proposals. |
| Conflicting conditional-consent advice | Model misreads conditional evidence; fixed runtime acknowledgement also calls a held proposal ready. | Respect proposal readiness in acknowledgements and verify the initial advice separately. |
| BB-1063 reservation conflict | Seed issue/evidence and business state disagree. | Choose a consistent starting state and check the resulting inventory delta. |
| BB-1112 called a duplicate | Initial wording misreads the family; follow-up corrects the conclusion. | Retest the initial answer against distinct-order evidence. |
| Ready after Undo is unclear | Undo correctly restores a ready but unresolved order. | Clarify resolution and packing progress for novices. |
| Cancel retains a proposal | Closing review does not discard saved work; intended wording is uncertain. | Decide and document close versus discard behavior. |
| Exact comparison values unavailable | Fixture offers a conclusion without underlying values. | Decide what evidence a reviewer needs before accepting the batch. |
| Literal chat Markdown | The current chat renders formatting markers as text. | Retain for the separate chat-readability work. |

Raw findings include reproduction, consequence, expected-result source, diagnosis
confidence, verification and observation references. They remain in the private
local runs. No follow-up issues were created automatically.

All four adapters closed their browser and server; their loopback ports rejected
connections afterward. The temporary credential file was removed. An exact-value
scan of 424 repository and local evidence files found no copy of the supplied key.
An earlier temporary smoke-test directory remains after a tool rejected its
cleanup; the retained record does not contain the rejection reason. No retry of
that cleanup was attempted.

## Automated checks and independent verification

`vp run check` passed at `5c402cd` with 191 application tests and 18 QA-helper
tests, including the desktop/narrow component tests, type checks, build,
real-browser offline adapter exercises, accounting stops, continuation,
information separation, and memory validation. Live providers are not used by
these tests or CI.

Completion review found that an unreadable accounting table made the coordinator
reject null usage totals, preventing inspection and closure. The correction at
`0a3a7fe` preserves the last known numeric totals, records unavailable accounting,
and blocks new inference. If accounting returns, the run can reconcile its
unfinished turn. If the app stops without final accounting, the run closes with
an explicit missing-final-usage record instead of inventing a total.

After that correction, `vp run test:qa` passed all 21 QA-helper tests, type checks,
and build. The added wrapper regression covers ledger loss, restoration, and
shutdown with missing final accounting; the browser test also stops the real
offline app while its ledger table is missing. All four retained live run records
from the earlier format still load as closed with their recorded costs unchanged.

An earlier full check failed the existing provider-audit test's one-second
wall-clock assertion at 1,284 ms while live work and targeted verification were
running. An earlier occurrence was 1,078 ms; its isolated rerun passed. The final
full check passed after the QA apps stopped. The assertion was not changed;
its timer includes repository setup as well as the bounded notification. These
observations suggest load sensitivity, rather than establishing its exact cause.

Independent Sol High functional verification at `a097e4b` passed both model-facing
receipt paths, owner isolation, stale-Undo protection, and whole-batch Undo. It
also inspected the three promoted memory records against their synthetic source
evidence. The same verifier independently confirmed the remaining live narration
failure and the contradictory throw fixture. Requested role models are recorded;
the runtime did not separately report an actual explorer model identifier.

Selected desktop and narrow screenshots were inspected. Receipt entries and
controls were readable; existing chat Markdown and scrolling concerns remain
recorded. Screenshots demonstrate the visible state, not the accuracy of every
assistant sentence displayed beside it.

## Interpretation

These are exploratory case studies, not an accuracy estimate. A synthetic persona
and an agent's reactions do not establish how common a human difficulty is. The
record separates observed failures, supported causes, product questions, and
missing measurements. Deterministic tests prove available data and state changes;
live answers are checked separately.

The first run's unknown-cost request stopped inference. Later runs used separate
disposable workspaces after corrections, with their own retained accounting. No
run's ledger was reset to continue after a spending stop. Codex inference is
excluded from every amount reported here.
