# Exploratory QA

Invoke `$exploratory-qa` in a Codex session at the repository root. The skill is
available through `.agents/skills/exploratory-qa` and permits only explicit
invocation. It coordinates the existing Codex session and delegates using normal
Codex credentials. It does not start a separate paid API agent.

The default explorer request is Luna Max. Completion reviewers and repository
scouts use the caller's saved settings when the model-settings skill is installed.
Record requested and reported models separately. Do not silently substitute an
unavailable model or change saved settings. The four role files describe inputs,
responsibilities, and outputs. They are loaded into fresh agent contexts by the
coordinator; they are not permission configuration files.

## A run

Read `qa/config.json`. It selects one synthetic operator persona, four missions,
independent product expectations, and repository memory. The persona is a stated
hypothesis about a user, not customer research. Missions cover triage, address
correction, conditional replacement consent, and interrupted work with Undo.
The explorer chooses questions and UI actions; mission briefs contain no answer
key. The coordinator may investigate an unplanned follow-up.

Install dependencies and Chromium as described in the README, then build once
with `vp run build`. Supply `PARCEL_QA_API_KEY` in the environment for live mode.
Do not put a key in a prompt, command argument, report, or tracked file. The adapter
does not fall back to ordinary app keys or load an env file. For offline work use
`--mode offline`, which starts the actual app with scripted providers.

```sh
vp run qa -- init --mode live --minutes 120 --budget 0.10
```

The result supplies an absolute `runDir` outside the checkout. Substitute it for
`RUN_DIR` below. Keep `serve` running in a terminal or tool session. It owns the
disposable loopback server and browser and stops them on its deadline or shutdown.

```sh
vp run qa -- serve --run RUN_DIR
vp run qa -- packet --run RUN_DIR --role explorer --scenario queue-triage
```

Pass only that packet to a fresh explorer delegate, without conversation history.
Select other missions with `address-correction`, `replacement-consent`, or
`recovery`. They share one spending total and one deadline. A new-user explorer
does not inherit the QA team's previous findings or lessons.

The explorer sends a JSON browser operation through stdin or `--input FILE`:

```sh
vp run qa -- browser --run RUN_DIR --input - <<'JSON'
{"action":"snapshot"}
JSON
```

Use the returned controls to click, fill, press keys, ask a chat question,
reload, resize, or take a screenshot. Each command records local evidence and
returns an observation ID for the debrief. The role packet gives command examples.
The adapter controls its browser and blocks new paid WebSocket requests at the
spending limit. Packet filtering limits accidental disclosure, but an agent with
general shell access is not technically prevented from reading repository files.
Respect the explorer role's restrictions and report any breach.

## Diagnosis and correction

The coordinator uses `packet --role investigator` and `packet --role verifier`
after exploration. Those packets include expected outcomes and prior learning.
`vp run qa -- verify --run RUN_DIR` reads actual persisted facts for these roles.
Do not provide this output to the explorer.

Debrief each mission and record attempted/completed/blocked coverage. Use
`event --run RUN_DIR --input FILE` to add classified findings and subsequent
diagnosis/verification. The [record contract](../tools/qa-loop/README.md) describes
the JSON fields. Keep the user consequence, reproduction, expected result and
source, observations, diagnosis evidence, correction, and verification together.
Unknown causes remain unknown. Unclear product intent stays a product question.

Investigate prompt, tool, UX, application, data, guidance, and tester causes as
the evidence warrants. Preserve an original reproduction before a correction
when practical. A fresh verifier checks the original case and a related variation
against a fixed change. Resolved findings require both results to pass. A run
does not need to find a bug or open a PR to provide useful evidence.

Use the repository's implementation and review workflow to prepare one PR for
verified changes. Larger discoveries can remain local findings with a next action.
Do not merge or deploy from a QA run. Do not add guessed product rules to
`AGENTS.md`; update guidance only when a verified, reusable engineering lesson
justifies it.

## Time, cost, and continuation

`status --run RUN_DIR` synchronizes cumulative app usage into the run record.
The $0.10 default is a spending stop threshold, not a guaranteed billing ceiling.
A bounded app turn already admitted can take the total above it. Failed and
cancelled calls count. Any completed live attempt with unknown cost blocks new
inference. Only app-key inference counts; Codex usage is excluded. Offline mode
is explicitly labeled and cannot demonstrate live answer quality.

Measure completed work and committed visible changes, not first tokens. The
adapter's verifier facts retain app completion measurements. Browser-command
duration includes driver overhead and must not be presented as pure app latency.
Compare tokens/cost only for equivalent successful tasks, and retain missing
measurements as missing.

```sh
vp run qa -- status --run RUN_DIR
vp run qa -- resume --run RUN_DIR
vp run qa -- stop --run RUN_DIR --reason 'Exploration finished; unresolved findings retained.'
```

Resume reconciles an interrupted coordinator's turn reservation with the same
adapter and ledger. It preserves the original deadline and spending total.
After the adapter has stopped, inspect the retained evidence or start a new run;
do not restart a stopped adapter with a new allowance under the old run ID.
`show --run RUN_DIR` reads the retained report without starting the app.

## Memory and reuse

Raw browser results, screenshots, database state, and traces remain in the
private local run directory. Repository memory contains only explicitly selected
synthetic summaries and regression cases. Prepare promotion JSON as described in
the module contract, have the verifier inspect it against the synthetic evidence,
then use `promote --run RUN_DIR --input FILE`. The validator checks provenance,
verification, known credential patterns, and field limits. Pattern screening
cannot prove arbitrary free text is safe. Keep doubtful records local.

The next run reads `qa/memory/lessons.json` and records the IDs and source revisions
of matching lessons. The coordinator and verifier use them to choose follow-ups
and check earlier outcomes. The explorer continues to receive only a persona,
mission, and browser procedure. This lets the team learn without teaching a new
user the expected answers.

For another application, copy `tools/qa-loop`, link its bundled skill from the
repository's `.agents/skills`, and supply a product adapter plus persona, mission,
expectation, and memory files. The portable core imports only Node modules.
`scripts/qa.mjs` is this repo's integration example. No application production
module imports the QA package.

Run `vp run test:qa` for credential-free helper, information-separation, memory,
accounting, cleanup, and actual-browser checks. `vp run check` includes them.
The fixed paid suite in `docs/live-acceptance.md` remains a separate, human-invoked
tool. Automatic or scheduled live QA is outside this implementation.
