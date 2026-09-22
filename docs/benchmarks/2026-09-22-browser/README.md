# Vite+ and browser testing evaluation

Measured on 2026-09-22. Vitest 5 Browser Mode now covers rendered UI states and
visual checkpoints; Playwright retains the complete application workflows.

## Suite timings

Three successful, sequential runs per command on the same AMD64 development VM
(4 DO-Premium-AMD CPUs, 8 GiB RAM, Linux 7.0.0-31). Dependencies and Chromium were
already installed. No competing container builds or test runs were started.
Elapsed time includes process startup and teardown; E2E includes the production
build and application server startup. Installation time is excluded. All samples
are retained in [before.json](before.json) and [after.json](after.json).

| Suite | Cases before → after | Before median | After median | Change |
| --- | ---: | ---: | ---: | ---: |
| Unit | 94 → 94 | 8.97 s | 8.03 s | −10.5% |
| Server integration | 69 → 69 | 45.87 s | 43.95 s | −4.2% |
| Rendered browser UI | 0 → 18 | — | 10.44 s | Added |
| E2E | 38 → 34 | 242.90 s | 193.96 s | −20.2% |
| Visual proof | 4 → 18 | 47.46 s | 15.72 s | −66.9% |

The before revision is `71f5ae0e79617412bfaa5a9df96cbb64f59b73ad`; the timed after
revision is `7d10d27580e556095b9355405fe3d037da13aae9`. Vite+ changed from 0.3.0 to
1.0.0-rc.0, and Vitest from 4.1.11 to 5.0.1. Both runs used Node 24.19.0,
pnpm 12.5.0, Playwright 1.62.1, Chromium 151.0.7922.34 (revision 1234), one worker,
and no retries (`CI` unset). The before commands were timed with Python's
monotonic clock; the after commands use the committed Node runner's monotonic
clock. Neither clears compiler or filesystem caches between samples.

These are different browser workloads. The old proof command recorded video,
captured ten application states plus reference images, and made comparison
composites. It also ran as four cases inside the E2E suite. Those cases are gone;
the remaining 34 E2E cases keep real transport, persistence, identity, tutorial,
acceptance, undo, reset, and reload coverage. Routine video recording is now off.
The new proof command runs all 18 rendered UI cases and captures 30 PNGs plus
Trace View history, without starting the application server or building a
production bundle. Its controlled fixtures contain three representative orders
and four catalogue entries, including long text and failure states.

The unchanged Node test counts provide a closer comparison. The browser numbers
measure the changed workflow, not an isolated Vitest speedup. Three samples from
one VM do not establish a general performance result. Reproduce with
`node scripts/benchmark-tests.mjs --label after --runs 3`.

## Rendered UI and evidence

The tests mount the actual React application and CSS in Chromium. They check
contrast, control bounds, clipping, overlap, spacing, and page-wide overflow;
deliberately broken styles verify that the checks reject unreadable, clipped,
overlapping, and off-screen content. Work, review, receipt, filled composer,
disconnected/busy/error, Explore, and Audit states have explicit checkpoints.

All 30 PNGs were inspected, including individual desktop and narrow screenshots
of review actions, the composer, expanded tool examples, and Audit details.
There are 15 captures at exactly 1440×1000 and 15 at exactly 320×900. Focused
captures scroll to content below the fold. Narrow Audit intentionally scrolls
horizontally inside its table. The images show readable text and reachable
review controls without page-wide overflow. They do not establish complete
accessibility or replace server integration tests.

Two RC details needed care: body screenshots can add blank padding beyond the
test iframe, so a restricted public custom command captures the configured
viewport; shared custom Playwright trace directories can collide across browser
projects, so the provider's default separate directories are retained. PNGs are
attached to the HTML report with named annotations. Trace View provides action
and assertion history but reconstructs DOM states; it is not pixel evidence.
See [browser testing](../../browser-testing.md) for commands and official docs.

The saved HTML report was served over loopback and opened in headless Chromium.
It showed 18 passing cases, named checkpoints, interaction/assertion history,
and screenshot annotations without page errors. The temporary server was
stopped afterward. The default `vp run check` also passed type checks, all 181
Node and Browser Mode tests, and the production build.

## Container and VM validation

The VM's global vp is now 1.0.0-rc.0. Both Docker dependency stages use the pinned
official RC builder and a shared locked pnpm store, following the cache approach
in [repo-control PR #122](https://github.com/alundgren/repo-control/pull/122).
Arguments pass through `vp install -- ...`; the image does not guarantee
Corepack. Node and the fresh production-only dependency stage are retained.

`vp run verify:container` passed on AMD64, including nonroot execution, health,
production identity rejection/acceptance, WebSocket operation, an accepted order
change, named-volume and bind-directory persistence after replacement, runtime
contents, and shutdown. An ARM64 build also completed and reports `linux/arm64`,
user `node`, and the expected Node entry command.

The initial production install downloaded 27 packages. The build stage reused
those 27 and downloaded its remaining 121. A second production install, forced
by changing only its RUN prefix to `test -d /pnpm/store &&`, reported 27 reused
and zero downloaded. The package manifest and lockfile stayed unchanged, so this
checks the mounted store rather than an already-cached RUN layer. BuildKit cache
retention still depends on the selected builder and garbage collection.

Actual ARM64 execution and the Pi's incremental build behavior remain for the
owner to check on that host. This VM is AMD64; no production deployment or paid
inference was performed.
