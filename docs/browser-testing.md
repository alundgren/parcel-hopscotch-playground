# Browser tests and visual review

Vitest 5 Browser Mode runs the React UI in headless Chromium with its application
CSS. It handles local interactions, view states, and visual layout checks without
starting the application server or compiling a production bundle. Playwright
still tests workflows that depend on WebSockets, SQLite, reloads, or multiple
browser sessions. Both use the pinned Playwright browser installation.

## Commands

```bash
vp exec playwright install --with-deps chromium
vp run test:unit
vp run test:integration
vp run test:browser
vp run test:e2e
vp run proof:visual
```

The unit and integration suites use Node. Browser Mode mounts the application
with typed, controlled workspace data. The E2E suite starts the built application
with disposable SQLite data, a local test identity, and scripted providers.
Ordinary checks do not make paid inference requests.

## Inspect rendered pixels

`proof:visual` runs the Browser Mode tests with named PNG checkpoints and an HTML
report under `artifacts/visual/`. Each run replaces that generated directory;
preserve any Before evidence elsewhere first. Names identify the screen size and state, such
as initial view, filled field, review, error, and saved result. Wait for the
expected content, `document.fonts.ready`, image decoding, and rendering frames
before capture. Use 1440×1000 and 320×900, Chromium, reduced motion, and fixed
locale and timezone. Keep those settings the same when comparing two app states.

Checkpoints use a small [custom Browser Mode command](https://vitest.dev/api/browser/commands)
to capture the Playwright viewport and attach the PNG to the test report. In
Vitest 5.0.1, the default body screenshot can extend beyond the test iframe and
add blank space for a tall page. The command keeps the configured viewport and
uses focused scrolling for content below the fold. It accepts only checkpoint
paths under the visual artifact directory and runs only during visual proof.

Open the PNG files with an image-viewing tool before calling a change visually
reviewed. Inspect readable text, content clipping, overlapping elements, action
placement, spacing, and control sizes. A passing visibility assertion cannot
prove that foreground and background colors differ. The browser tests also
check computed contrast and geometry on important controls to catch these
failures automatically.

For a changed flow, attach app screenshots from before or after the change.
Include both when useful, with clear Before and After labels. For a new feature,
show its working states. Use the full page for overall layout and focused captures
for details below the fold. Attach selected PNGs with `gh pr create --attach` or
`gh pr comment --attach`; explain the task state and any remaining visual defect.
Do not commit routine generated evidence. CI retains the reports and screenshots.
Video is optional for changes where motion or timing needs inspection.

## Trace View and failures

The proof run enables Vitest's built-in Trace View and its HTML reporter. Serve
`artifacts/visual/report` over loopback HTTP to follow actions, assertions, and
named checkpoints:

```bash
vp preview --outDir artifacts/visual/report --host 127.0.0.1 --port 4175 --strictPort
```

Open `http://127.0.0.1:4175` and stop the temporary server afterward.

Trace View records DOM snapshots and reconstructs earlier states. It is useful
for finding the step that failed, but it does not preserve every rendered pixel.
Even with inline images enabled, external fonts and CSS background resources can
remain URL-dependent. Explicit PNGs are the visual evidence. See the official
[Trace View documentation](https://vitest.dev/guide/browser/trace-view).

Both browser runners retain Playwright traces on failure. Browser Mode saves
them in `tests/browser/__traces__/`; E2E uses `test-results/`. Keep the provider's
default trace directory so browser instances have separate temporary trace files. Use
`vp exec playwright show-trace <trace.zip>` to inspect one. Successful E2E runs
avoid continuous recording. For a focused video rerun, use `RECORD_VIDEO=true vp run test:e2e`.
`vp run proof:video` records the existing paced batch and stale-review flows.

## Coverage boundaries

Browser Mode tests use the actual app components and styles, with controlled
workspace state. They test UI behavior, not server authorization or persistence.
Keep the server integration suites and Playwright flows for those guarantees.
Neither screenshots nor geometry checks alone establish complete accessibility.
Visual inspection remains part of reviewing UI changes.

Vitest also supports `toMatchScreenshot` for comparing rendered components with
reviewed image baselines. This repository uses targeted layout and contrast
assertions plus checkpoint inspection instead of a full-page baseline. That
avoids accepting a new image simply because font rendering differs on another
machine. Add image comparison for a stable component when its exact appearance
is a requirement, using a controlled browser and font environment and explicit
review of baseline changes. See [Vitest's visual regression guide](https://vitest.dev/guide/browser/visual-regression-testing).

## Timing the suites

Run suites sequentially on the same idle VM, with dependencies and Chromium
already installed. Keep the Node version, browser, retries, and worker settings
in the report. Timings include command startup and teardown; E2E includes its
production build and server startup. Installation time is excluded.

```bash
node scripts/benchmark-tests.mjs --label after --runs 3
```

Choose a subset with `--suites unit,integration,browser,e2e,proof`. Each attempt
writes a full log and elapsed seconds to `artifacts/test-timings/<label>/results.json`.
Failures stop the measurement and remain in the report; do not count them as
successful speedups. The first run may warm compiler caches, so retain all samples
and compare medians. State any removed, added, or moved coverage alongside the
timings. An old E2E suite and a new Browser Mode suite are different workloads.

See the [2026-09-22 evaluation](benchmarks/2026-09-22-browser/README.md) for
recorded before/after samples, coverage differences, and validation limits.

Vite+ 1.0.0-rc.0 bundles Vitest 5.0.1. Dependency and config migration follows the
[official migration guide](https://viteplus.dev/guide/vitest-v5), with exact pins
for the optional browser provider and HTML reporter.
