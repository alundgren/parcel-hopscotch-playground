# Human-run live acceptance

Issue #23 includes a local runner delivered separately from this checkout. Keep
`run.mjs` and its local README in an external directory, such as
`~/.local/share/parcel-hopscotch-live/pr24/`. The runner is not a package script,
test-discovery target, or CI job. It does not run as part of agent validation.

Build the desired revision with `vp run build`. From that checkout, check the
external runner without inference:

```bash
vp env exec --node 24.19.0 node ~/.local/share/parcel-hopscotch-live/pr24/run.mjs \
  --check --repo "$PWD" --output /tmp/parcel-live-preflight.json
```

The separate `--self-test` option checks failure reporting, setup credit exhaustion,
truncation, and the requested highlight target without a server or inference.

This starts the built app over loopback with disposable SQLite data and unavailable
providers. It checks Chromium, the 16-tool catalogue, and read-only evidence
queries. A successful preflight reports live tests as **not run**.

For the paid suite, the owner supplies `PARCEL_LIVE_TEST_API_KEY` in the terminal
environment and invokes the runner explicitly:

```bash
vp env exec --node 24.19.0 node ~/.local/share/parcel-hopscotch-live/pr24/run.mjs \
  --confirm-live --samples 2 --repo "$PWD" --output /tmp/parcel-live-results.json
```

The runner reads only that key. It never falls back to `OPENROUTER_API_KEY` and
never loads `.env` or `.env.local`. It starts Node directly with a fresh,
allowlisted environment, passing the dedicated test key to the server's existing
configuration field. Missing credentials produce a not-run report before any
server, browser, or provider starts. Do not put a key in a command argument or
commit reports containing private annotations.

The suite opens a visible Chromium browser and runs all four Explore buttons plus
16 directed natural-language tool cases. Every model request keeps the complete
registry and automatic tool selection. Each case uses a fresh local identity and
seeded work. The default two repetitions run 40 primary turns and four setup
turns. Two to five repetitions are supported. Each turn has a 180-second runner
deadline and the application's finite provider and tool-call limits. This can
spend prepaid credit; the runner does not estimate a guaranteed dollar total.

For each Undo case, the runner opens an address proposal and pauses in the
terminal. The person reviews it and clicks **Accept 1 change** in the browser,
then presses Enter in the terminal. The runner never clicks an acceptance control.
It asks the model to prepare Undo against that real receipt and leaves the Undo
proposal pending. All other cases verify that orders, inventory, and receipts
remain unchanged. There is no production connection and no scripted substitute
for missing or unsuccessful live inference.

The JSON report records each case's assertions and failures, actual completed tool
coverage, provider outcomes, output truncation, stored-result truncation, request
and response bytes, tokens, unknown and known costs, retries, server completion,
and browser Send-to-completed-work duration. It reports p50 and p95 only from
completed browser measurements and keeps failed or incomplete samples visible.
Setup requests are included in cost totals. Missing tool coverage fails the suite.
Unknown billing is counted separately from known cost. Closing the runner removes
its temporary database and stops its child server.

The delivered local runner and README are the executable artifact. This document
alone does not install them on another machine. Copy the external directory there,
install the repository's pinned Playwright Chromium, and run the preflight before
paid acceptance. Live correctness remains pending until the owner runs the suite;
credential-free regression tests do not establish model accuracy.
