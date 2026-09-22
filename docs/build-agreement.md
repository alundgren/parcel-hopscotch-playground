# Build agreement

Agreed with the owner on 2026-09-21. This document supersedes earlier discovery notes.

## Outcome

Build the complete Parcel Hopscotch app in the private `alundgren/parcel-hopscotch-playground` repository. The owner will audit before making it public and deploying it. Future URL: `https://parcel.irudd.net`. Sol High implementers work through reviewed GitHub issues, raise PRs with evidence, and the orchestrator checks and merges them.

## Product

Bracken & Beam is a fictional homewares fulfilment desk. Seed around 24 orders covering address, stock/substitution, missing bundle components, parcel weight, delayed carrier scans, and potential duplicates. Deterministic, repeatable scenario events simulate automated work. Provide conventional UI controls as well as agent access. Exclude real shipping, payments, refunds, and customer messaging.

There are three main screens: Work, Explore, and Audit. Follow the visual guidance in `ux.md` and the application branding. Work includes queue, details, review, receipts, Undo, and tutorial overlays. Explore provides four example scenarios and a filterable catalogue of actual tools. Audit explains inference and resulting app activity using compact expandable rows.

Ministral handles conversation and bounded tool use. Jev handles constrained classification of notes and conditional consent. Code owns arithmetic, stock, policy eligibility, permissions, transitions, and transaction checks. Include complete address, substitution, and batch tutorials, advancing on real app events. A user can learn a task and then complete a similar case independently.

## Identity and isolation

Cloudflare Access and a Cloudflare Tunnel protect the whole production app. Trust `Cf-Access-Authenticated-User-Email` without JWT validation by explicit owner choice. Reject missing, duplicate, or malformed identity headers. The tunnel-to-local-port deployment is part of that trust assumption. Production has no development identity fallback.

Each user sees only their own orders, inventory, proposals, chat, tutorials, and audit. Identity comes from the server request, never a model argument or browser-supplied user ID. Use a separate internal user ID and keep the login email out of model prompts and inference audit payloads. Local development and tests may use an explicitly enabled fixed demo identity.

Reset restores the first-login experience except for Audit. Restore seed data and scenario state, clear chat and tutorial progress, invalidate proposals, and cancel active turns. Retain inference history, actual costs, and a reset marker. Reject messages or proposals from the previous reset generation. The agent can prepare reset, and a user confirms it in the UI.

## Commands and tools

The agent can query, group, navigate, highlight registered targets, guide tutorials, classify, and prepare changes. It cannot execute browser code or arbitrary selectors. A shared typed registry defines runtime schemas, permissions, names, descriptions, and catalogue examples.

All business mutations require the user's explicit click on a concrete preview. Commit through the same validated server commands used by ordinary UI controls. Before acceptance, show record IDs, before/after values, effects, and omissions. If any reviewed record changes, apply none of the batch and request refreshed review. Transactions must be atomic, ownership checked, and duplicate acceptance idempotent. Undo is a new checked change and cannot overwrite subsequent work.

## Inference and measurement

Use OpenRouter with `mistralai/ministral-3b-2512` and `typesafe/jev-1.13`. Chat uses the completion API; Jev uses the alpha Decisions API. Validate provider payloads and tool arguments at runtime. Keep vendor-specific parsing inside adapters. Stream useful UI updates over one bidirectional WebSocket. There is no UI polling. Reconnect, cancellation, duplicates, backpressure, and reset races must have defined behavior.

Measure time from Send until the requested work and final UI updates are complete. Separately measure Accept until the committed change is visible. Record provider-request completion and whole-turn completion so multiple model calls cannot masquerade as one fast interaction. Do not calculate or display first-token or first-useful-output benchmarks. Publish sample counts, p50/p95 completion, cost, and correctness for repeatable tasks.

Prepaid credits with Auto Recharge disabled are the spending ceiling. The owner declined a separate application budget or dedicated key cap. Still bound input/output size, tool rounds, concurrency, timeout, and retries. Stop on exhausted-credit errors. Use only the agreed models; do not silently substitute a larger or different model. Missing live credentials or provider failures must remain visible in validation results.

The OpenRouter key is a server secret. Audit allows curated request and response bodies plus selected app results, bytes, actual provider/model, usage, cost, retries, errors, cancellation, and tool outcomes. Exclude credentials, auth headers, cookies, environment values, and login identity. Represent missing usage or billing data as unknown.

## Delivery and validation

Use TypeScript, React, Vite Plus 1.0.0-rc.0, Node 24.19.0, pnpm 12.5.0, Effect 4, SQLite, and shadcn. Run project commands through Vite Plus, keep exact compatible dependency pins, and commit the pnpm lockfile. Keep reusable inference, typed tool execution, realtime transport, and UI guidance separate from the fictional fulfilment rules without building a general agent framework.

Provide unit tests for validation, policies, identity isolation, transactions, resets, tool dispatch, provider parsing, and failure behavior. Vitest Browser Mode tests actual rendered components and captures meaningful PNG checkpoints for visual inspection. Playwright uses deterministic providers and real app transport for complete flows on desktop and narrow screens, retaining traces on failure. Every UI PR attaches application screenshots using `gh --attach`. Show before or after states, or the new feature when there is no earlier state. Record video when motion needs review. CI runs without paid inference or private credentials. Live checks and benchmarks run explicitly with the local server secret.

Prepare a single root Dockerfile and persistent SQLite volume for Piploy, with loopback host-port exposure for the tunnel. Production registration, tunnel configuration, public visibility, and deployment happen after the owner's audit.

License original code and assets under MIT and retain third-party notices.
