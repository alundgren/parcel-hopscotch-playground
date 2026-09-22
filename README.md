![Parcel Hopscotch, an AI interface playground](docs/assets/readme-header.png)

# Parcel Hopscotch

Parcel Hopscotch is a private playground for completing synthetic fulfilment work through ordinary controls or a small embedded agent. Bracken & Beam, the fictional shop, has seeded address, stock, bundle, weight, carrier and duplicate-order exceptions. Every model-proposed business change waits for a human to review and accept it.

The experiment compares Ministral conversation and tool use with Jev constrained decisions through OpenRouter. Audit records complete request and turn timing, actual model and provider data, tokens, costs, failures and resulting app activity. Each operator has isolated work. Reset restores seeded work while retaining inference audit and cost history.

## Fresh local setup

Install Vite Plus 0.3.0 from the exact [official installer source](https://github.com/voidzero-dev/vite-plus/blob/b2d15e3899dcc8adedfd45d98de9d30046a624f4/packages/cli/install.sh). The installer manages the project-pinned Node 24.19.0 runtime and pnpm 12.5.0. It adds only the Vite Plus executable directory to supported shell startup files; it does not replace system Node or change another package manager's settings. Load the generated shell environment before running `vp`; a new terminal will load it automatically.

```bash
curl -fsSL https://raw.githubusercontent.com/voidzero-dev/vite-plus/b2d15e3899dcc8adedfd45d98de9d30046a624f4/packages/cli/install.sh | VP_VERSION=0.3.0 VP_NODE_MANAGER=yes bash
. "${XDG_CONFIG_HOME:-$HOME/.config}/vite-plus/env"
git clone https://github.com/alundgren/parcel-hopscotch-playground.git
cd parcel-hopscotch-playground
cp .env.example .env.local
vp install --frozen-lockfile
vp exec playwright install --with-deps chromium
vp run dev
```

Open `http://127.0.0.1:5173`. The Vite client proxies the Effect Node server on port 3000. `vp run dev:server` and `vp run start` load the ignored `.env.local` file automatically. An exported process variable takes precedence over the same key in that file.

The example configuration uses the deterministic scripted provider and an explicitly enabled development identity. It makes no paid requests. For a built-server check, set `PUBLIC_ORIGIN=http://127.0.0.1:3000`, then run:

```bash
vp run build
vp run start
```

To run the deliberate live checks, set `AGENT_PROVIDER_MODE=live` and put `OPENROUTER_API_KEY` in `.env.local`. Do not pass the key in a command argument or add the file to Git. `vp run smoke:providers` makes one bounded request to each agreed model. `vp run benchmark:providers -- --mode live --confirm-live ...` is the separately bounded benchmark command. Ordinary development, tests, container verification and CI do not need or use the key.

## Checks and evidence

```bash
vp run check
vp run test:e2e
vp run proof:visual
vp run proof:video
vp run benchmark:providers -- --mode fixture --output-dir /tmp/parcel-provider-benchmark-fixture
```

### Headless visual proof on a development VM

Provision Python 3 and the repository's pinned Playwright Chromium with its system
libraries in the development VM image. After installing project dependencies, run
`vp exec playwright install --with-deps chromium` as the development user, with
sudo available for system packages. Keep the browser cache available to that user.
Repeat the install when the pinned Playwright version changes. CI already runs
this command. Chromium is a development dependency; the production Docker image
does not need it.

Use `vp run proof:visual` for the Work, Explore, Audit, prepared-batch, and acknowledgement comparisons at
1440×1000 and 320×900. Playwright starts the app with disposable SQLite data and
serves the prototype and assets from `docs` at
`http://127.0.0.1:4174/design/approved-prototype.html` using Python 3. Both servers
bind to loopback and Playwright stops them on exit. Ports 4173 and 4174 must be free.
The script waits for the expected UI state, fonts, and images before capture.

Before UI edits, capture and inspect the relevant reference images. After edits,
rerun the proof and inspect the labeled comparisons with an image-viewing tool.
Extend the proof for any affected states it does not cover. Use the same viewport
and browser settings for the reference and application. Run `vp run proof:video`
for the existing demonstration flows, or record the affected flow in another
Playwright test. Screenshots, comparisons, and videos are saved in `test-results`;
preserve the required files before another run replaces that directory. Attach
comparisons and videos to the PR with `gh pr create --attach` or
`gh pr comment --attach`, and explain any deliberate differences.

This workflow runs entirely in the VM without a desktop, browser extension, or
owner computer connection. If capture or inspection fails, record the exact error
and leave visual approval pending. A security rejection must be reported, not
retried through alternative access routes.


Playwright uses the scripted providers through the real WebSocket transport and SQLite repository. It records videos in `test-results/`. The visual command creates ten same-state comparisons against the unchanged approved prototype at 1440 by 1000 and 320 by 900. The video command records readable desktop and narrow demonstrations. Its pauses occur after the measured completion boundaries.

The retained [acceptance report](docs/acceptance-report.md) documents 36 browser cases and separate server-turn, Send-to-completed-work and Accept-to-visible samples. The [live benchmark report](docs/benchmarks/2026-09-22-live/README.md) retains the single authorized 28-request run. Jev sent no token cap; its question, choice, request and response byte, and timeout bounds are recorded in the report correction. The 64-token cap applies only to Ministral constrained requests. Those historical benchmark scenarios requested at most 256 tokens. Current agent turns allow 4,096 output tokens per request, up to eight model requests per turn and six tool calls per request. Chat responses are limited to 2 MiB and 120 seconds per provider attempt; Jev keeps its separate limits. One of two live tool scenarios remained incomplete and is reported that way.

The separate [human-run live acceptance suite](docs/live-acceptance.md) covers all four Explore scenarios and every registered tool with repeated real inference. It is delivered outside this checkout and uses only `PARCEL_LIVE_TEST_API_KEY`. The owner runs the paid suite.

## Local container review

Build and open a local-only container with a development identity:

```bash
docker build --platform linux/amd64 --tag parcel-hopscotch:local .
docker volume create parcel-hopscotch-local-data
docker run --rm --name parcel-hopscotch-local \
  --publish 127.0.0.1:3000:3000 \
  --mount type=volume,source=parcel-hopscotch-local-data,target=/data \
  --env NODE_ENV=development \
  --env HOST=0.0.0.0 \
  --env PORT=3000 \
  --env PUBLIC_ORIGIN=http://127.0.0.1:3000 \
  --env DATABASE_PATH=/data/parcel.sqlite \
  --env ENABLE_DEV_IDENTITY=true \
  --env DEV_USER_EMAIL=demo@example.test \
  --env AGENT_PROVIDER_MODE=scripted \
  parcel-hopscotch:local
```

Open `http://127.0.0.1:3000`. This development identity example is only for direct local browser review. A production container rejects WebSocket requests without exactly one valid `Cf-Access-Authenticated-User-Email` header, so visiting it directly in a browser does not establish an identity. Cloudflare Access supplies that header in the intended deployment.

Run the complete local packaging check with:

```bash
vp run verify:container
```

The command first refuses non-Unix Docker endpoints. It builds a temporary image for the local Docker engine's platform, publishes only on loopback, checks React, health, PID 1, UID/GID 1000, production identity rejection and acceptance, WebSocket operation, an accepted order change, SIGTERM shutdown, and named-volume plus bind-directory persistence after container replacement. It removes only its uniquely named containers, volume, bind directory and image.

For the bind check, a short-lived root helper inside the local Docker engine changes only the verifier-created temporary directory to UID/GID 1000, then restores its original host ownership before cleanup. The application containers still run as the nonroot `node` user.

The image uses the exact Vite Plus 0.3.0 builder index and Node 24.19.0 Bookworm slim runtime index recorded in the [operator guide](docs/operator-guide.md). The Dockerfile compiles the application and installs a fresh production-only dependency tree on the builder platform. The current production graph has no target-dependent native package. Recheck that fact before copying dependencies if the graph changes. See the operator guide for the ARM64 artifact inspection and execution limit.

## Operation and data

The built image runs one nonroot Node process as UID/GID 1000. It serves the React build, `/api/health` and `/ws` on container port 3000. SQLite lives at `/data/parcel.sqlite`. An empty Docker named volume inherits the image directory ownership. A bind directory, including a Piploy-managed directory, must be writable by UID 1000. For a private local directory, `install -d -m 0700 -o 1000 -g 1000 /path/to/data` establishes that access.

Use the in-app reset command to restore your own seeded workspace. It clears work, chat and tutorial progress, cancels active turns and invalidates proposals while retaining Audit and costs. To discard a local container database completely, stop the container and remove only the volume you created for it, such as `docker volume rm parcel-hopscotch-local-data`.

Production binds the host port to loopback. Cloudflare Access and Tunnel protect that endpoint, and production has no development identity fallback. The owner configures repository access, host environment, managed directory permissions, port allocation, Cloudflare allowlist and tunnel, and deployment after the private audit. The [operator guide and offline Piploy payload](docs/operator-guide.md) list the exact contract without changing production.

Original source and assets in this repository are licensed under [MIT](LICENSE). Runtime npm packages keep their own licenses and notices inside their package directories. The container includes the repository license and the production dependency files.
