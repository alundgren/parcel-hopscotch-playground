# Reusable exploratory QA loop

The bundled `skill/` describes a manually invoked coordinator and separate explorer, investigator, and verifier roles. This directory contains the portable record and packet code. `core.mjs` imports only Node modules. The host repository supplies its persona, missions, browser adapter, expected outcomes, and any authorized correction workflow. Importing this module or starting the ordinary application does not start QA or spend money.

## Run data

`createRun` writes `run.json` under `~/.local/state/qa-loop/runs/<id>` by default. It creates run directories with mode `0700` and files with mode `0600`. `rootDir` can override that location for isolated tests. It must be an absolute, private directory. Existing path components and record files cannot be symlinks. The file is replaced atomically after validation. Keep screenshots, traces, adapter state, and raw evidence under the same run directory. Do not commit it.

The `version: 1` run record contains one revision, creation time, two-hour default deadline, `$0.10` default app spending stop threshold, model labels, persona reference, scenario references, consumed lesson citations, cumulative app usage, accounting availability, current scenario, any in-flight paid turn, observations, findings, and coverage. A reference is `{ "id": "queue", "version": "1", "digest": "optional content digest" }`. A run can cover several scenarios under one deadline and spending threshold. `createRun` can load a memory file and select lessons matching the persona and any selected scenario. Lessons from the current source revision are included, so an immediate second run can use the first run's learning. Every consumed lesson retains its ID and source revision for citation. Existing version 1 records without `accounting` still load; the field is optional for compatibility.

Use `updateRun` with exactly one of these events:

| Event | Fields after `type` | Result |
| --- | --- | --- |
| `scenario.start` | `scenarioId` | Selects the current mission. |
| `observation.add` | `observation` | Records action, result, duration in milliseconds, and optional local evidence reference. |
| `finding.add` | `finding` | Adds a classified concern linked to observations. |
| `finding.update` | `findingId`, full `finding` | Changes status, diagnosis, correction, or verification without changing identity. |
| `coverage.add` | `scenarioId`, `outcome`, `evidence`, optional `at` | Marks a mission attempted, completed, or blocked. |
| `usage.record` | cumulative `usage` | Stores an adapter reading without allowing any field to decrease. |
| `accounting.unavailable` | none | Retains the last numeric usage and blocks new paid turns until a valid reading returns. |
| `turn.start` | `scenarioId`, `id` | Reserves the only paid turn after the spending and time checks. |
| `turn.finish` | `id`, cumulative `usage` | Accounts for the turn and clears the reservation. |

An observation is `{ "id", "scenarioId", "at", "action", "result", "durationMs", "evidence" }`; `evidence` may be `null`. A finding is `{ "id", "scenarioId", "kind", "status", "title", "reproduction", "consequence", "expected": { "result", "source" }, "diagnosis": { "status", "hypothesis", "evidence" }, "correctionStatus", "verification": { "original", "adjacent" }, "observationIds" }`. `kind` is `defect`, `ux-concern`, `product-question`, `environment-failure`, or `tester-failure`. `status` is `open`, `investigating`, `confirmed`, `dismissed`, or `resolved`. Diagnosis may stay `unknown` with null hypothesis and evidence; the runner must not fill it from a guess. A check has `status` of `not-run`, `pass`, `fail`, or `blocked`, plus `evidence` and `at`. A resolved finding requires passing original and adjacent checks. Unfinished findings remain in `run.json` when the run closes.

`usage` is `{ "knownCostUsd", "unknownCostRequests", "inputTokens", "outputTokens", "requestCount" }`. It counts only application provider calls; Codex role inference is outside the example allowance. `accounting` is `{ "available", "unavailableAt", "finalUsageMissing" }`. A missing `accounting` field in an older version 1 record means available. `accounting.unavailable` leaves the last recorded numeric `usage` untouched; those numbers are historical, not current totals, and may be the initial zeros if no adapter reading succeeded. A valid monotonic `usage.record` restores availability before `turn.finish` can clear a reservation. `runDecision` blocks paid turns while accounting is unavailable, as well as after the deadline, during an in-flight turn, at the known spending threshold, or when an app request has unknown cost. It never claims to impose a billing ceiling: the last admitted turn can overshoot. If the adapter stops while the ledger is unreadable, the host may call `closeRun` with `finalAccountingUnavailable: true` only after confirming adapter shutdown. That closes the run, clears an unresolved reservation, and sets `finalUsageMissing: true`; it does not estimate missing dollars, requests, or tokens. Otherwise, a reservation survives restart until a valid `turn.finish`. Do not reset cumulative usage for another mission or after adapter restart.

## Role packets

`packetFor(run, 'explorer', { persona, mission, browserProcedure })` returns only those three strings, `version`, and `role`. The explorer should receive that packet in a fresh context. The API rejects extra explorer fields. This is an output allowlist, but keeping the explorer away from source files, hidden expected outcomes, prior lessons, and other conversations is an instruction and orchestration responsibility. The function cannot control tools or prior model context by itself.

`packetFor` for `coordinator`, `investigator`, and `verifier` includes the run with findings and cited lessons, plus optional source and expected material. The host must send that packet only to the relevant role. It should not hand hidden answers to an explorer through browser output or adapter messages.

## Repository memory

`promoteMemory` accepts **explicitly selected** `lessons` and `regressions` and writes a versioned JSON memory file. Each record must say `synthetic: true`, name `reviewedBy` and `reviewedAt`, and match the run's persona, scenario, and source revision. A lesson names a source observation and may name a resolved finding. A regression names a resolved defect whose original and adjacent checks passed. The CLI rejects unknown fields, duplicate IDs, common secrets, transcript role prefixes, email addresses, angle brackets, and absolute or parent paths in promoted text. The memory file can be tracked; raw run data should stay local.

The text screen catches common mistakes, not every possible secret or personal detail in free text. A reviewer must inspect the selected synthetic summaries and regression steps against the source evidence before promotion. A `reviewedBy` string records that review; the helper cannot authenticate its author. These restrictions keep raw traces out of repo memory but cannot prevent someone from writing an unsafe paraphrase.

A lesson has `{ "id", "personaId", "scenarioId", "sourceRevision", "summary", "sourceObservationId", "sourceFindingId": null, "reviewedBy", "reviewedAt", "synthetic": true }`. A regression has `{ "id", "personaId", "scenarioId", "sourceRevision", "findingId", "setup", "action", "expected", "reviewedBy", "reviewedAt", "synthetic": true }`. The memory file has `{ "version": 1, "lessons": [], "regressions": [] }`.

## CLI and adapter contract

The CLI prints JSON to stdout and errors to stderr. Pass JSON through `--input /path/to/file` or `--input -` for stdin.

```sh
node tools/qa-loop/cli.mjs init --input /tmp/qa-init.json
node tools/qa-loop/cli.mjs show --run-dir /absolute/run/dir
node tools/qa-loop/cli.mjs event --run-dir /absolute/run/dir --input /tmp/qa-event.json
node tools/qa-loop/cli.mjs decision --run-dir /absolute/run/dir --input /tmp/qa-decision.json
node tools/qa-loop/cli.mjs packet --run-dir /absolute/run/dir --role explorer --input /tmp/explorer-input.json
node tools/qa-loop/cli.mjs promote --run-dir /absolute/run/dir --memory-file /absolute/qa-memory.json --input /tmp/selected-memory.json
node tools/qa-loop/cli.mjs close --run-dir /absolute/run/dir --reason 'session complete'
```

The host adapter is a separate process. It exposes `serve --run-dir PATH --mode offline|live --budget-usd NUMBER --duration-minutes NUMBER`, `command --run-dir PATH --request JSON`, `status --run-dir PATH`, `verify --run-dir PATH`, and `stop --run-dir PATH`. Browser commands use an `action` such as `snapshot`, `click`, `fill`, `press`, `chat`, `screenshot`, or `reload`. `status` reports `usage`, `busy`, deadline, and stop reason. With an unreadable ledger, the adapter reports `accountingAvailable: false` and null usage fields. The coordinator records `accounting.unavailable` instead of passing those nulls to `usage.record` or `turn.finish`. `status` and `resume` can still inspect the run and its last known numeric reading. A later valid ledger reading can finish the reserved turn; `stop` closes with missing final accounting after adapter shutdown. The adapter must serialize its own live requests too; the core reservation does not enforce remote concurrency across unrelated processes.

Run the portable core tests with `node --test tools/qa-loop/core.test.mjs`.
This is the narrow exception to the host repository's Vitest Node convention:
`core.mjs` and its tests use only Node built-ins so another repository can copy
the directory without taking a test-runner dependency. Parcel-specific pure,
SQLite, and wrapper checks run under the Vitest Node unit and integration
projects through `vp run test:qa`. The real server/browser adapter lifecycle
runs separately with `vp run test:qa:e2e`; it uses scripted inference and no
paid key. The check enables `--record-trace true` for the offline adapter's
`serve` command. The adapter saves its own Playwright context trace in the
private run directory before shutdown. The test copies that trace and app log
to ignored `artifacts/qa-adapter-failures/` only on failure. Live sessions
cannot enable this trace option.
