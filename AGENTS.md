# Parcel Hopscotch

For UI work, read `ux.md` and inspect the rendered application using the headless browser workflow below. Read `docs/architecture.md` when changing module responsibilities, inference, persistence, or transport.
For test work, follow [the testing strategy](docs/testing-strategy.md); use [the reusable performance guide](docs/test-suite-performance.md) when choosing runner setup or tuning execution.

## Delivery

Implement the assigned GitHub issue in its own branch and worktree. The user authorized Sol High implementers, independent completion review, PR creation, and the orchestrator's verified merges. The repository stays private until the owner's audit. Production deployment belongs to the owner after that audit.

Use the `implement-issue`, `github-use`, `code-guidance`, and applicable `ux-design` skills. Read the provided run packet for role settings, base revision, and scope. The issue agent owns its changes and PR. Resolve ordinary ambiguity with the orchestrator rather than asking an absent user.

Prove each acceptance criterion before completion review. Keep the reviewed target unchanged during review. The orchestrator verifies the resulting PR, checks, and reviewed commit before merging.

## UI inspection and visual proof

Use Vitest Browser Mode for rendered UI tests and checkpoint screenshots. Render
actual React components with the application CSS and disposable, typed test data.
Keep Playwright for complete flows through the server, SQLite, WebSockets,
multiple sessions, reloads, and browser navigation. Temporary servers must bind
to `127.0.0.1` and stop after capture. This must work on a VM without a desktop,
browser extension, or connection to the owner's computer.

Capture meaningful states of the application, such as the initial view, a filled
field, a review awaiting acceptance, an error, and the saved result. Evidence may
show the app before or after a change. When both help explain the change, use the
same viewport and browser settings and label them Before and After. For a new
feature, show its working states. Wait for the intended state, fonts, images,
and rendering before capture.

Inspect the PNG files with an image-viewing tool. Check text contrast, clipping,
overlap, spacing, sizing, reachable actions, and desktop and narrow layouts.
DOM assertions and reconstructed Trace View snapshots alone do not establish
visual approval. Use rendered geometry and contrast assertions for important
controls alongside screenshot inspection. Extend the tests for affected states.

Attach selected screenshots using `gh pr create --attach` or
`gh pr comment --attach`, and describe what they demonstrate. Vitest's HTML report
retains Trace View interaction and assertion history. Keep Playwright traces on
failure. Video is optional when timing or motion matters to the change.

See `README.md` and `docs/browser-testing.md` for commands and artifact paths.
If capture or inspection fails, record the exact error and keep visual approval
pending. If a tool rejects an operation for security reasons, report it and stop
that operation. Do not retry through another browser, proxy, tunnel, or service.

## Guided help

Keep reusable guidance contracts and transitions in `src/guidance/`. They must
not import application modules. Modules own their targets, guide text,
availability decisions, and outcome names behind `src/modules/<name>/index.ts`.
The application composes those exports in `src/modules/guidance.ts` and passes
them to the client renderer. Do not add a second hand-maintained target or tool
catalogue to documentation or prompts.

Register a target on the actual rendered control through a React ref, with its
entity and evaluated availability. The real control and guidance must use the
same availability result. Do not infer a target from a CSS selector or model
text. A renamed target must fail type checking or its rendered contract test.

Guidance may explain, offer navigation, and annotate. Only the person starts a
guide or uses a business command. Do not add preparation or acceptance to the
guidance dispatcher. Record progress from correlated application results or
rendered readiness, never from a click, a model claim, or another browser's
update. A return to stale work requires fresh review.

For changes to these contracts, run `vp run check:guidance`, the guidance unit
and integration tests, and the affected Browser Mode and E2E tests. Keep the
negative tests for an internal import, a missing rendered target, and a
wrong-entity outcome. Update saved-state versions when their meaning changes;
an incompatible continuation must stop safely. Add an independent expected
outcome to tests instead of deriving all assertions from the declaration under
test. See `docs/guidance.md` for the current experiment and its limits.

## Engineering

Effect 4, TypeScript, React, Vite Plus, pnpm, Node, SQLite, and shadcn are agreed. Pin compatible package versions. Use Effect for server resources, cancellation, failures, and typed validation.

One typed registry defines tool schemas and catalogue metadata. Validate untrusted model arguments and realtime messages before dispatch. The server derives user identity; models and clients cannot choose another user's data. Model tools may query, guide, classify, or prepare a proposal. Only a human acceptance command commits a reviewed proposal.

Measure send-to-completed-work and accept-to-committed-visible-update. Do not add first-token or first-useful-output metrics. Streaming may improve interaction, but completion is the benchmark.

Prepaid OpenRouter credits with automatic recharge disabled are the spending ceiling. Keep requests, outputs, tool rounds, concurrency, and retries bounded. Preserve audit costs through reset. Keep credentials and authentication headers out of client bundles, logs, model context, and audit bodies.

Use direct, concrete language. Do not use `seam`, `spine`, `shape`, `load-bearing`, or `blast radius` in original software prose or new code names, including plurals, inflections, and compounds. Exact existing source names and quotes are allowed when the work requires them. Name the actual component, API, behavior, or failure case instead.
