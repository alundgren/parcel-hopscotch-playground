# Live acceptance tests

Run the paid suite explicitly from the checkout:

```bash
vp run test:live
```

Supply your own `PARCEL_LIVE_TEST_API_KEY` in the terminal environment first.
The command requires that variable and does not fall back to
`OPENROUTER_API_KEY` or load keys from `.env` or `.env.local`. Missing credentials
produce a not-run report and a nonzero exit before building or starting the app.
Anyone with the checkout and their own inference key can run it. Agents must not
run the paid suite; ordinary tests, `check`, and CI never invoke it.

The command builds the current checkout, starts an isolated loopback server with
fresh SQLite data, and runs headless Playwright. No visible browser, acceptance
pauses, temporary-folder management, or separate runner installation is needed.
Install the project's pinned Chromium once with `vp exec playwright install chromium`
if it is not installed; Linux VMs may need `--with-deps`.

All four Explore buttons and 16 directed natural-language cases run twice by
default: 40 primary turns and four setup turns. Every model request keeps the full
registry and automatic tool selection. `vp run test:live --samples 3` changes the
repetitions (two to five). Each turn has a 180-second runner deadline and the
application's finite request, output, tool-round, and retry limits. Exhausted
credits stop the suite. This spends prepaid credit; there is no guaranteed dollar
total.

For a focused, repeated check of the BB-1042 guidance exchange, run
`vp run test:live --case guidance-wording --samples 5`. Each fresh sample sends
"Teach me how to fix BB-1042." followed by "yes" and checks the replies,
navigation acknowledgement, and rendered customer message. The focused case
does not run as part of the full tool-coverage suite. The app answers this
particular request from its current order record, so this case checks live-mode
browser behavior without paid inference. Use
`vp run test:live --case guidance-check-wording --samples 5` for the related
"What should I check before changing the address" wording. That response is
also built from the current order record.

Each case uses a fresh local identity. For Undo setup, Playwright clicks **Accept
1 change** on the disposable address proposal, waits for the receipt, then asks
the live model to prepare Undo. The test driver performs that setup through the
ordinary UI; the model still cannot commit changes. All measured agent turns
must leave business state unchanged, including their pending Undo proposals.
There is no production connection or scripted substitute for live inference.

Every invocation prints its results path under `artifacts/live/<timestamp>/`.
That directory is gitignored and retained for local debugging:

- `report.json`: assertions, completed tools, provider errors and redacted
  responses, tool/UI audit evidence, turn history, timings, tokens, bytes,
  truncation, retries, and known/unknown costs.
- `workspace.sqlite`: the isolated application's persisted data and audit.
- `<sample>-<case>/final.png` and `trace.zip`: final screenshot and Playwright
  browser trace for each case, including failures.

Open a trace with `vp exec playwright show-trace <path-to-trace.zip>`, or ask your
agent to inspect the report and database. Reports include failed and incomplete
samples; latency percentiles use only completed browser measurements. Setup
requests count toward costs. Missing repeated tool coverage fails the suite. The overview accepts any successful
queue-read sequence and checks the final answer against the pre-turn database.
It verifies all three status counts and up to three distinct review orders,
including each ID, status, family, and verbatim recorded issue. The overview
uses a compact line format defined in the model instructions. The checker also
accepts labeled ID/family and Issue blocks for review examples; when a block omits
status, it must still describe an order whose database status is review. Unexpected
lines fail as unsupported claims; formatting failures are reported separately
from wrong counts or order facts. Dedicated cases still require their named tool.
The child server and browser stop automatically, while results stay on disk.

Credential-free checks are available for agents and contributors:

```bash
vp run test:live --self-test
vp run test:live --check
```

The first checks reporting, credit exhaustion, truncation, highlight assertions,
and SQLite read contention without starting the app. The second builds and starts
the app with unavailable providers and verifies the browser, automated receipt
setup, catalogue, and evidence queries. It records zero provider requests and
reports live acceptance as **not run**, even if the dedicated key is present.
These checks do not establish real-model accuracy.
