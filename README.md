![Parcel Hopscotch, an AI interface playground](docs/assets/readme-header.png)

# Parcel Hopscotch

Parcel Hopscotch is a private playground for completing synthetic fulfilment work through ordinary controls or a small embedded agent. Bracken & Beam, the fictional shop, has seeded address, stock, bundle, weight, carrier and duplicate-order exceptions. Every model-proposed business change waits for a human to review and accept it.

The experiment compares Ministral conversation and tool use with Jev constrained decisions through OpenRouter. Audit records complete request and turn timing, actual model and provider data, tokens, costs, failures and resulting app activity. Each operator has isolated work. Reset restores seeded work while retaining inference audit and cost history.

## Fresh local setup

Install Vite Plus 1.0.0-rc.0 from the exact [official installer source](https://github.com/voidzero-dev/vite-plus/blob/173e734826cdf79ef05ba91390c3508be5ebba3b/packages/cli/install.sh). The installer manages the project-pinned Node 24.19.0 runtime and pnpm 12.5.0. It adds only the Vite Plus executable directory to supported shell startup files; it does not replace system Node or change another package manager's settings. Load the generated shell environment before running `vp`; a new terminal will load it automatically.

```bash
curl -fsSL https://raw.githubusercontent.com/voidzero-dev/vite-plus/173e734826cdf79ef05ba91390c3508be5ebba3b/packages/cli/install.sh | VP_VERSION=1.0.0-rc.0 VP_NODE_MANAGER=yes bash
. "${XDG_CONFIG_HOME:-$HOME/.config}/vite-plus/env"
git clone https://github.com/alundgren/parcel-hopscotch-playground.git
cd parcel-hopscotch-playground
cp .env.example .env.local
vp install --frozen-lockfile
vp exec playwright install --with-deps chromium
vp run dev
```

For an existing Vite+ installation, run `vp upgrade 1.0.0-rc.0` before installing the project dependencies.

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
vp run test:browser
vp run test:e2e
vp run proof:visual
vp run benchmark:providers -- --mode fixture --output-dir /tmp/parcel-provider-benchmark-fixture
```

### Headless visual proof on a development VM

Install the repository's pinned Chromium and its system libraries with
`vp exec playwright install --with-deps chromium`. Keep its cache accessible to
the development user and repeat the install when Playwright changes. CI runs the
same command. The production image does not need a browser or Python.

`vp run test:browser` uses Vitest 5 Browser Mode to render the application with
its real styles at 1440×1000 and 320×900. Typed fixture data keeps the tests
repeatable and avoids paid inference. Tests interact with the rendered UI and
check important controls for contrast and layout errors.

`vp run proof:visual` also retains named PNG checkpoints and a Vitest HTML report
with Trace View history under `artifacts/visual/`. Inspect the PNGs with an
image-viewing tool. Trace View helps explain actions and assertions; its DOM
reconstruction does not replace inspection of the rendered pixels.

For UI changes, show application states before or after the change. Capture both
when that helps explain it, using matching viewports and browser settings. For a
new feature, capture its working states. Wait for fonts, assets, and the intended
state before capture. Attach selected PNGs with `gh pr create --attach` or
`gh pr comment --attach`. Videos are optional when timing or motion matters.

`vp run test:e2e` retains Playwright for complete flows through real WebSockets,
SQLite, reloads, and separate browser sessions. It starts a loopback-only server
with disposable data and stops it on exit. Port 4173 must be free. Failure
screenshots and traces go to `test-results/` with a report in `playwright-report/`.

See [browser testing](docs/browser-testing.md) for coverage, visual review,
Trace View, and timing commands. If capture or inspection fails, record the exact
error and leave visual approval pending. Report security rejections and stop the
rejected operation.

Run `vp run test:live` with your own `PARCEL_LIVE_TEST_API_KEY` for the [paid live acceptance suite](docs/live-acceptance.md). It builds the app, runs headless Playwright across all four Explore scenarios and every registered tool, and retains debugging evidence under gitignored `artifacts/live/`. People invoke paid runs explicitly; agents and CI use only credential-free validation.

For freeform investigation, explicitly invoke `$exploratory-qa` in Codex. The
[QA workflow](docs/exploratory-qa.md) runs a disposable local app with one synthetic
operator persona, separate explorer/investigator/verifier roles, and retained
lessons. Its default time limit is two hours and its app spending stop threshold
is $0.10. Codex usage is outside that allowance. Live QA uses only the explicitly
supplied `PARCEL_QA_API_KEY`; `vp run test:qa` exercises the helpers and actual
browser with scripted providers and makes no paid requests.

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

The image uses the exact Vite Plus 1.0.0-rc.0 builder index and Node 24.19.0 Bookworm slim runtime index recorded in the [operator guide](docs/operator-guide.md). The Dockerfile compiles the application and installs a fresh production-only dependency tree on the builder platform. The current production graph has no target-dependent native package. Recheck that fact before copying dependencies if the graph changes. See the operator guide for the ARM64 artifact inspection and execution limit.

## Operation and data

The built image runs one nonroot Node process as UID/GID 1000. It serves the React build, `/api/health` and `/ws` on container port 3000. SQLite lives at `/data/parcel.sqlite`. An empty Docker named volume inherits the image directory ownership. A bind directory, including a Piploy-managed directory, must be writable by UID 1000. For a private local directory, `install -d -m 0700 -o 1000 -g 1000 /path/to/data` establishes that access.

Use the in-app reset command to restore your own seeded workspace. It clears work, chat and tutorial progress, cancels active turns and invalidates proposals while retaining Audit and costs. To discard a local container database completely, stop the container and remove only the volume you created for it, such as `docker volume rm parcel-hopscotch-local-data`.

Production binds the host port to loopback. Cloudflare Access and Tunnel protect that endpoint, and production has no development identity fallback. The owner configures repository access, host environment, managed directory permissions, port allocation, Cloudflare allowlist and tunnel, and deployment after the private audit. The [operator guide and offline Piploy payload](docs/operator-guide.md) list the exact contract without changing production.

Original source and assets in this repository are licensed under [MIT](LICENSE). Runtime npm packages keep their own licenses and notices inside their package directories. The container includes the repository license and the production dependency files.
