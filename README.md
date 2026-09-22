![Parcel Hopscotch, an AI interface playground](docs/assets/readme-header.png)

# Parcel Hopscotch

A playground for fast AI as an alternative to the UI. Run the fulfilment desk at Bracken & Beam, a fictional homewares shop, by clicking or by asking the agent to find work, teach a task, and prepare changes for your approval.

The experiment compares Ministral conversation and tool use with Jev's constrained decisions through OpenRouter. Success means getting the work done quickly. Audit shows complete interaction timing, requests, responses, tokens, costs, and what happened in the app.

Implementation is in progress. The approved [interactive prototype](docs/design/approved-prototype.html), [build agreement](docs/build-agreement.md), [architecture](docs/architecture.md), and [visual guidance](ux.md) define the intended result.

Each user has their own seeded work and can reset it. Reset preserves audit history. Cloudflare Access controls access at the tunnel, and the app trusts its authenticated email header.

## Local workspace

Use Node 22.18 or newer and pnpm 12.5. The development identity must be enabled explicitly:

```bash
cp .env.example .env.local
set -a; source .env.local; set +a
pnpm install
pnpm dev
```

Open `http://127.0.0.1:5173`. The Vite client proxies the Effect Node server on port 3000. Production ignores the development identity and requires exactly one valid `Cf-Access-Authenticated-User-Email` header.

Run the local checks with:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm test:e2e
```

Create the six labeled approved-reference comparisons at 1440×1000 and 320×900 with:

```bash
pnpm proof:visual
```

Playwright writes the comparisons, raw screenshots, and videos to `test-results/`. The command waits for the real workspace and tool catalogue before capture.

Create readable desktop and narrow demonstrations of completed batch work and stale-review recovery with:

```bash
pnpm proof:video
```

This adds pauses after completed states are visible. The pauses occur outside the Send-to-completed-work and Accept-to-visible measurement intervals.

Exercise the complete bounded provider benchmark without paid requests with:

```bash
pnpm benchmark:providers -- --mode fixture --output-dir /tmp/parcel-provider-benchmark-fixture
```

The fixture directory must be empty. Live mode additionally requires `--confirm-live`, a clean checkout, an output directory outside the repository, and `OPENROUTER_API_KEY` in the process environment. It is disabled in CI. The retained [single live run](docs/benchmarks/2026-09-22-live/README.md) records the fixed inputs, limits, outcomes, actual usage, and costs.

Run the bounded live provider check explicitly with:

```bash
pnpm smoke:providers
```

It makes one Ministral request and one Jev request through the application adapters. It requires `OPENROUTER_API_KEY` in the environment or ignored `.env.local`, records sanitized attempts in `.tmp/provider-smoke.sqlite`, and prints only the result plus model, token, complete-duration, and cost metadata. Ordinary tests and CI never call paid providers.

Live validation passed on 2026-09-22. Ministral completed a forced `getOrder` call through Mistral in 532 ms for 114 tokens at USD 0.0000114. In the same bounded Jev request, TypeSafe model `typesafe/jev-1.13-20260917` returned a numeric Noul answer and classified conditional consent with the documented Choice label-description map in 411 ms for 477 tokens at USD 0.000017598. These are compatibility checks, not performance benchmarks.

Playwright builds the app, starts the real server with an `example.test` identity, uses its WebSocket transport, and records video in `test-results/`.

Licensed under [MIT](LICENSE).
