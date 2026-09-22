# Parcel Hopscotch

Read `docs/build-agreement.md` before changing behavior. For UI work, also read `ux.md` and inspect `docs/design/approved-prototype.html` in a browser. Read `docs/architecture.md` when changing module responsibilities, inference, persistence, or transport.

## Delivery

Implement the assigned GitHub issue in its own branch and worktree. The user authorized Sol High implementers, independent completion review, PR creation, and the orchestrator's verified merges. The repository stays private until the owner's audit. Production deployment belongs to the owner after that audit.

Use the `implement-issue`, `github-use`, `code-guidance`, and applicable `ux-design` skills. Read the provided run packet for role settings, base revision, and scope. The issue agent owns its changes and PR. Resolve ordinary ambiguity with the orchestrator rather than asking an absent user.



UI PRs must attach side-by-side images of the approved reference and actual result using `gh pr create --attach` or `gh pr comment --attach`. Capture the same task state and viewport, label each image, and explain deliberate differences required by the issue. Attach Playwright video for the affected flow. An updated screenshot alone does not establish visual approval.

Prove each acceptance criterion before completion review. Keep the reviewed target unchanged during review. The orchestrator verifies the resulting PR, checks, and reviewed commit before merging.

## Engineering

Effect 4, TypeScript, React, Vite Plus, pnpm, Node, SQLite, and shadcn are agreed. Pin compatible package versions. Use Effect for server resources, cancellation, failures, and typed validation.

One typed registry defines tool schemas and catalogue metadata. Validate untrusted model arguments and realtime messages before dispatch. The server derives user identity; models and clients cannot choose another user's data. Model tools may query, guide, classify, or prepare a proposal. Only a human acceptance command commits a reviewed proposal.

Measure send-to-completed-work and accept-to-committed-visible-update. Do not add first-token or first-useful-output metrics. Streaming may improve interaction, but completion is the benchmark.

Prepaid OpenRouter credits with automatic recharge disabled are the spending ceiling. Keep requests, outputs, tool rounds, concurrency, and retries bounded. Preserve audit costs through reset. Keep credentials and authentication headers out of client bundles, logs, model context, and audit bodies.

Use direct, concrete language. Do not use `seam`, `spine`, `shape`, `load-bearing`, or `blast radius` in original software prose or new code names, including plurals, inflections, and compounds. Exact existing source names and quotes are allowed when the work requires them. Name the actual component, API, behavior, or failure case instead.
