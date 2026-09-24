# Testing strategy for Parcel Hopscotch

This file records where new tests belong and how to keep the routine checks fast. For reusable advice and source links, see the [test performance guide](test-suite-performance.md). For screenshot capture and visual inspection, see [browser testing](browser-testing.md).

## Choose the smallest runner that can prove the behavior

| Behavior to prove | Runner | Test data |
| --- | --- | --- |
| Pure fulfilment rule, parser, schema, tool registry, or client state transition | Vitest Node unit test | Plain typed values |
| SQLite command, owner isolation, migration, audit record, provider adapter, or realtime protocol | Vitest Node integration test | Temporary SQLite file and scripted provider |
| Rendered React state, accessible control, focus, local interaction, contrast, clipping, or responsive layout | Vitest Browser Mode | Actual components and CSS with typed workspace data |
| Browser plus server behavior: WebSocket delivery, saved result after reload, multiple sessions, navigation, or a race across processes | Playwright E2E | Disposable SQLite database, per-test identity, scripted provider |
| Actual model compatibility | Explicit paid live check | Bounded request with a separately supplied credential |

Write a test for a behavior that would matter to a person using the app or for a contract between modules that could break silently. Keep security and data invariants at the server boundary: another user cannot read or accept a proposal, model arguments cannot commit a change, stale proposals cannot write, and reset cannot erase retained audit records. Test failure, cancellation, and retry behavior at the layer that owns each decision.

Avoid a test that merely repeats a type check, snapshots a large object without a specific contract, or verifies a mock's own answer. Do not repeat the same filtering or tab interaction in every runner. Browser Mode covers its UI states; one E2E case should prove that real registry or audit data reaches the browser. Keep a second E2E case only when it proves another server or browser interaction, such as a second session receiving an update.

## Structure tests around independent outcomes

- Give each test one named outcome and assert the observable result. A workflow can have several steps when they are needed to reach that result. Split unrelated outcomes so a failure points to one behavior.
- Use typed fixture builders for the smallest useful state. Change only fields relevant to the case. Keep tests readable without a large abstraction that hides the action under test.
- Use a fresh temporary database for Node tests that mutate storage. Close resources and remove files in teardown. Share immutable seed definitions, never mutable records between tests.
- Use a distinct authenticated user for each E2E test. Browser contexts isolate cookies and storage, not SQLite rows. Create extra contexts for multi-session tests with the same identity only when that is the behavior under test.
- Keep external inference scripted in routine suites. Live provider checks require an explicit command and credential; they do not run in CI.
- Assert visible labels, roles, text, state, and persisted results. Use test IDs for stable application targets when an accessible query cannot name the element. Avoid assertions on private React state or arbitrary CSS selectors unless the test is specifically checking layout.

## Keep the routine commands efficient

`vp run test:unit` and `vp run test:integration` run in Node without a browser. `vp run test:browser` mounts the actual React app at desktop and narrow widths without starting the server. `vp run test:e2e` builds and starts the app once on an available loopback port with a private SQLite file that is removed when the command ends. Use `node scripts/run-e2e.mjs tests/e2e/workspace.spec.ts --project=desktop` for a focused server-backed run. `vp run proof:visual` captures Browser Mode checkpoints and an HTML report. Use `vp run proof:e2e` when a server-backed screenshot is needed for review. Ordinary passing E2E tests keep no manual screenshots; Playwright still retains failure screenshots and traces.

Wait for a specific state with locator assertions. Keep a fixed delay only when elapsed time is the contract, such as confirming a cancelled turn does not arrive late. For a visual checkpoint, wait for the intended state, fonts, images, and rendering before capture, then inspect the PNG at both widths.

The E2E server and SQLite file are shared for one test run. Per-test users prevent data collisions, but SQLite still permits one writer at a time. Keep the worker count small and measure it on the CI-sized machine. Do not enable full test parallelism or more workers solely because the CPU count is higher. The desktop E2E project proves all server-backed flows. The narrow E2E project runs workspace and tutorial flows, where stacked chat and guidance can affect interaction. Browser Mode checks Explore and Audit at both widths, while Node tests prove their server data contracts. Use `node scripts/benchmark-tests.mjs --label NAME --runs 3` to compare passing command medians on the same idle host. Record changes in coverage alongside timing changes.
