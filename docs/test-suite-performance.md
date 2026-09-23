# Fast browser and database tests

This guide applies to React apps with Vite or Vite+, a Node server, a database,
and browser tests. For each assertion, choose the least expensive test
environment that can observe the failure it is meant to catch. Keep a few
complete flows to prove that the parts work together.

## Decide where a test belongs

| Required observation | Start with | Example |
| --- | --- | --- |
| A pure rule, parser, schema, or state transition | Node unit test | Reject invalid tool arguments |
| A repository write, migration, server command, or protocol message | Node integration test with disposable state | A reset retains audit records |
| Rendered React, focus, a local interaction, an error state, or responsive layout | Vitest Browser Mode with real components and CSS | A narrow review keeps its accept button visible |
| The browser, server, transport, and database working together | Playwright E2E | Accept a proposal and see the committed result after reload |
| Two sessions, reconnects, navigation, or a client/server race | Playwright E2E | A second tab receives a reset event |

Ask what real parts must run for the claimed failure to happen. A component
test cannot prove server authorization or persistence. A Node test cannot
prove a control is reachable. Keep an E2E flow for each important connection
between layers without repeating every UI state in a slower runner.

Browser Mode uses a real browser, CSS, browser APIs, and user events. A
component test can run without the application server or a production build.
It can inspect computed layout and capture pixels. Browser startup still costs
time, so small business rules belong in Node. Use a maintained browser
provider in CI when real interaction matters.
[Vitest Browser Mode](https://vitest.dev/guide/browser/),
[component testing](https://vitest.dev/guide/browser/component-testing).

Parcel Hopscotch's [Browser Mode tests](../tests/browser/app.visual.test.tsx)
already cover catalogue filtering, Audit controls, and layout at desktop and
narrow widths. Playwright keeps real WebSocket, SQLite, reload, multi-user,
and accepted-work cases. Preserve a server integration test when Browser Mode
uses controlled data instead of a server response.

## Independent test data

- Give each mutable E2E test its own user, account, or record ID. Derive IDs
  from the test ID and retry. Browser contexts isolate storage, but they do
  not isolate server records. A fresh user often eliminates a reset at test
  start; keep a separate test for reset itself.
  [Playwright data isolation](https://playwright.dev/docs/test-parallel#avoiding-shared-state-in-parallel-tests).
- Seed data before opening the page. Use the app's test API, Playwright's
  `request` fixture, or a test-only Node database helper. The browser then
  performs the action whose visible result matters.
  [Playwright API testing](https://playwright.dev/docs/api-testing).
- Put setup and cleanup in fixtures. Test-scoped fixtures suit mutable data;
  worker-scoped fixtures suit expensive reusable data. Fixtures run on demand,
  so avoid a large `beforeEach` that every test pays for.
  [Playwright fixtures](https://playwright.dev/docs/test-fixtures).
- If login is expensive, a setup project can save `storageState`. Share an
  account only when tests cannot conflict on its server data; otherwise use
  an account per worker or test. Keep saved auth state out of git. This has
  little value for apps with a cheap test identity.
  [Playwright authentication](https://playwright.dev/docs/auth),
  [projects](https://playwright.dev/docs/test-projects).
- Replace paid or slow external providers at their outgoing boundary while
  retaining the app's validation and persistence. Keep separate opt-in live
  compatibility checks. Typed component data and request mocks are useful
  for UI states, but they do not prove the live service. In Vitest Browser
  Mode, imported module namespaces cannot always be spied on directly; use
  `vi.mock` with a factory or `{ spy: true }`, or inject the dependency. MSW
  is another option for repeatable HTTP responses across test environments.
  [Vitest request mocking](https://vitest.dev/guide/mocking/requests),
  [module mocking](https://vitest.dev/guide/mocking/modules),
  [Playwright API mocking](https://playwright.dev/docs/mock),
  [MSW](https://mswjs.io/).

For SQLite, a fresh temporary file per test server or worker is straightforward.
The default `:memory:` database belongs to one connection and cannot supply
data to a child server process. SQLite serializes writers, so different users
in one file can still contend. Start with separate users and measure two
workers. Add separate files and server processes if contention justifies the
setup. A test transaction cannot undo commits made by another connection.
[SQLite in-memory databases](https://www.sqlite.org/inmemorydb.html),
[isolation](https://www.sqlite.org/isolation.html),
[transactions](https://www.sqlite.org/lang_transaction.html).

Use a database container when production uses a database server whose behavior
the test must exercise. SQLite apps gain little from putting their database
file in a container; disposable files avoid container startup.

## Avoidable waiting and recording

- Prefer locator actions and assertions that retry until a specific state
  appears. Replace a pause after a click with an assertion on the next visible
  state, response, or event. Do not use `networkidle` as general readiness.
  [Playwright auto-waiting](https://playwright.dev/docs/actionability),
  [assertions](https://playwright.dev/docs/test-assertions),
  [page API](https://playwright.dev/docs/api/class-page).
- Keep elapsed time when it is the behavior under test. For a delayed reply
  or reconnect deadline, assert the state before and after the boundary, or
  control the clock when that accurately models the code.
- Put routine screenshots in a visual-proof run. Keep screenshots and traces
  on failure in the normal run. Successful full-page screenshots cost
  rendering, encoding, and disk writes, but measure the cost before claiming
  a saving. Use video when motion or timing matters.
  [Playwright best practices](https://playwright.dev/docs/best-practices).
- Before visual capture, wait for the intended state, fonts, images, and
  rendering frames. Inspect the PNG, not just DOM assertions or a reconstructed
  trace. See [this repo's visual review procedure](browser-testing.md).

## Parallel work and coverage projects

- Playwright runs files concurrently when `workers` exceeds one. Tests within
  a file run in order unless `fullyParallel` or a parallel `describe` opts in.
  Isolate backend state first, then compare one and two workers on the CI host.
  More workers consume memory and can expose database contention.
  [Playwright parallelism](https://playwright.dev/docs/test-parallel).
- Use projects for intentional browser, device, or environment coverage. Each
  added viewport repeats its selected tests. Cover responsive component states
  in Browser Mode, then keep E2E cases at each width where navigation or server
  interaction differs. A full cross-viewport E2E run can remain a final check
  while focused local runs select one project.
  [Playwright projects](https://playwright.dev/docs/test-projects).
- Shard across CI jobs when one host has reached a useful worker count. Give
  each shard separate app and database state. Without full parallel mode,
  Playwright divides shards by file, so uneven files can leave jobs idle.
  Merge blob reports after the jobs finish.
  [Playwright sharding](https://playwright.dev/docs/test-sharding).
- Vitest can also run independent files concurrently. Give database-writing
  tests separate databases; put exclusive tests in a sequential project rather
  than disabling parallelism for every test. Order the projects if both groups
  touch the same exclusive resource. Tune worker count to CPU, memory, and
  database behavior. [Vitest parallelism](https://vitest.dev/guide/parallelism),
  [parallel and sequential files](https://vitest.dev/guide/recipes/parallel-sequential).

## Startup and measurement

- Let Playwright `webServer` start the app and wait for a health URL. A fast
  local command may use Vite and a Node test server; a final command should
  still exercise the production build. If local runs reuse a server, verify
  its configuration and disposable database so a stale process cannot pass.
  [Playwright web server](https://playwright.dev/docs/test-webserver).
- Keep Vitest `setupFiles` small because they run before each test file. Use
  `globalSetup` for expensive process-level work and fixtures for state that
  needs cleanup. Keep Node and browser tests in named projects with distinct
  globs. With Vite+, check the bundled Vitest version before pinning browser
  provider packages. [Vitest setup](https://vitest.dev/guide/learn/setup-teardown),
  [global setup](https://vitest.dev/config/globalsetup),
  [projects](https://vitest.dev/guide/projects),
  [Vite+ Vitest guide](https://viteplus.dev/guide/vitest-v5).
- Retain failure traces. Continuous tracing and rich reports for every passing
  test add work; use them when investigating a problem or collecting visual
  proof. `trace: "on-first-retry"` is useful when CI retries a failed test;
  `retain-on-failure` preserves the failing first attempt.
  [Playwright tracing guidance](https://playwright.dev/docs/best-practices).

Record command wall time and test duration separately. Build, server startup,
browser launch, test bodies, screenshots, and teardown can dominate different
suites. Vitest reports transform, setup, import, test, and environment time;
its profiler can locate slow imports. Change one factor at a time, compare
several passing runs on the same idle machine, and note any coverage moved or
removed. Vitest's `doctor` command can compare test configurations when startup
or worker settings are suspect.
[Vitest profiling](https://vitest.dev/guide/profiling-test-performance),
[CLI](https://vitest.dev/guide/cli).

In the reported Parcel Hopscotch run, the 34 Playwright test bodies totaled
about 116 seconds with one worker. The source contains 22.1 seconds of fixed
waits and 18 successful full-page screenshot calls per viewport. Some waits
check timed behavior, so these are candidates for experiments, not promised
savings. `playwright.config.ts` also builds the app before every E2E run.
Use `node scripts/benchmark-tests.mjs --label NAME --runs 3` to compare complete
command medians after every run passes.

## Recommended changes for Parcel Hopscotch

1. Remove the unconditional `pause()` calls in `tutorials.spec.ts` and
   `explore.spec.ts`, and the two screenshot pauses in `audit.spec.ts`, after
   checking each assertion. These account for 25.8 seconds across both
   viewports in the reported run. Wait for the intended UI state and rendering
   before a screenshot. Keep explicit time checks that test delayed replies,
   cancellation, and session replacement. Do not count all 25.8 seconds as a
   guaranteed saving until a passing benchmark confirms it.
2. Move routine successful E2E screenshots behind a visual-proof command.
   There are 18 full-page screenshot calls per viewport. Keep failure capture
   in ordinary runs and selected checkpoint PNGs for UI review. Measure the
   time saved; screenshot cost is not yet separated from test duration.
3. Add one Playwright fixture that assigns a unique test identity before the
   first navigation. The acceptance tests already use the identity header;
   the remaining files use the same development user. Fresh identity data
   should allow setup resets to be removed from tests that do not verify reset.
   Then benchmark `workers: 1` and `workers: 2`. Try `fullyParallel` only after
   tests are independent and file-level parallelism is stable.
4. Audit duplicate UI assertions. Browser Mode already covers catalogue
   filtering and Audit tab controls. Keep E2E checks that prove registry data,
   live Audit updates, tutorial persistence across reload, human acceptance,
   and WebSocket behavior. Remove a duplicate browser journey only after its
   distinct server assertion remains in an E2E or integration test.
5. Measure the production build and server startup separately. The E2E
   `webServer` builds and typechecks on every invocation. If that dominates
   focused local runs, add a separate local command using Vite and the test
   server. Keep the built-app run as the final check.
6. Review Vitest's global `fileParallelism: false` after database-writing tests
   have separate temporary files. Increase workers only if a benchmark shows
   a stable improvement on the machine that runs the checks.

Apply one change at a time. Record complete command medians and test failures,
and run the full desktop and narrow suite after changing identity or worker
settings. The first two changes reduce work without changing which real app
parts the E2E tests exercise. Identity isolation is the prerequisite for useful
Playwright parallelism.
