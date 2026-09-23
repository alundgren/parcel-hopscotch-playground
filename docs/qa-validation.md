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
under the private local QA run directory. Only the selected lesson is committed.
