# Continue Parcel Hopscotch

## Verified continuation on 2026-09-22

The stopped-session account below remains as historical context. A later headless Linux VM session completed the pending review and continued the agreed sequence:

- Tutorial PR [#15](https://github.com/alundgren/parcel-hopscotch-playground/pull/15) passed round 4 at `fd9dba2b03a98404573a53fd383d1ead9debe87a` and merged as `e025db2eb267dd1e8da07db9d8b51351a659265d`. All 130 unit/integration tests, 18 browser tests, PR CI and post-merge CI passed.
- Audit PR [#17](https://github.com/alundgren/parcel-hopscotch-playground/pull/17) passed round 3 at `0e04e507dd678c447957b0d3ee721d19731aed30` and merged as `f5a5920b4e411b97296de39d6fea41b95b1d5e1d`. All 136 unit/integration tests, 20 browser tests, PR CI and post-merge CI passed.
- Explore PR [#18](https://github.com/alundgren/parcel-hopscotch-playground/pull/18) passed round 3 at `0c6cc01de598bf312581fcce27459c52b3d77154` and merged as `58d62cfcbd76d01b576bed738cf767bef1fd88ee`. All 141 unit/integration tests, 26 browser tests, PR CI and post-merge CI passed.
- Acceptance PR [#19](https://github.com/alundgren/parcel-hopscotch-playground/pull/19) passed round 2 at `1d54970d1ef38e46e15317909fe74979556234af` and merged as `71842a5dc4a25f3d9ef80bd773a34e6c974c9cb8`. All 148 unit/integration tests, 36 browser tests, review-fix acceptance, PR CI and post-merge CI passed. Its six comparisons and four videos were retained. The live benchmark made 28 requests for $0.000600186; one of two tool scenarios remained incomplete and is reported accurately.

The current packaging work starts from merge `71842a5dc4a25f3d9ef80bd773a34e6c974c9cb8`. [The owner handoff](owner-handoff.md) and [operator guide](operator-guide.md) replace this historical file for current local operation and the post-audit deployment contract.

Repository: https://github.com/alundgren/parcel-hopscotch-playground. The owner's final instruction was to stop the fix cycle, record remaining findings, and leave tutorial issue #6's PR open for a fresh session on another machine. This supersedes the earlier request to merge before stopping. Check out the open draft PR for branch `feat/06-tutorials`, rather than starting from `main`. No private files from the previous machine are required.

The implementation is committed through `6a6d2f5b69168bee474580581287030e27e712de`, based on `341e7abe1506121ca9a62374f9aaec93bd1ba487`. Later handoff commits change documentation only. Two combined review rounds completed. Round 2's final-practice receipt finding has a tested correction, but its confirmation review was interrupted at the owner's stopping point. There is no final approval. Read [the portable review record](reviews/issue-6.md) for every finding, disposition, remaining check and the retained role settings. No further findings had arrived when that review stopped.

Read [AGENTS.md](../AGENTS.md), [the build agreement](build-agreement.md), [architecture](architecture.md), and [UX guidance](../ux.md). They contain the agreed product, engineering, identity, measurement and visual requirements. For UI work, inspect [the approved prototype](design/approved-prototype.html) in a browser. Its approved source is the file at bootstrap commit `3ce3912accaee54f2c353ff9b00d6e8022eeec72`; preserve it as the comparison reference.

Keep the repository private. Public release and production deployment belong to the owner after their audit. Prepare and verify local packaging only. Production, tunnel and Tailnet changes are outside the remaining implementation work.

Before starting, use `gh` to inspect #6's open PR, head, checks and existing claim. This is continuation of an already claimed issue, so preserve its claim and existing branch. Read #6's full body and comments, complete the pending combined review and any supported correction, verify the final head and CI, then merge when ready. Only then select #7, checking its full body, comments and every native blocking-dependency page. Preserve existing work if the remote state differs from this handoff. The epic is [#1](https://github.com/alundgren/parcel-hopscotch-playground/issues/1).

| Issue | State when preparing this handoff | Result or next work |
| --- | --- | --- |
| [#2](https://github.com/alundgren/parcel-hopscotch-playground/issues/2) | Merged, PR #11 | Personal seeded workspace and realtime transport |
| [#3](https://github.com/alundgren/parcel-hopscotch-playground/issues/3) | Merged, PR #12 | Human-reviewed commands, atomic acceptance, Undo and reset |
| [#4](https://github.com/alundgren/parcel-hopscotch-playground/issues/4) | Merged, PR #13 | Bounded OpenRouter adapters and attempt audit storage |
| [#5](https://github.com/alundgren/parcel-hopscotch-playground/issues/5) | Merged, PR #14 | Typed tools, agent turns, UI acknowledgements and recovery |
| [#6](https://github.com/alundgren/parcel-hopscotch-playground/issues/6) | Open draft PR, pending final review | Address, substitution and batch tutorials, real independent practice |
| [#7](https://github.com/alundgren/parcel-hopscotch-playground/issues/7) | After #6 merges | Complete Audit page and retained application outcomes |
| [#8](https://github.com/alundgren/parcel-hopscotch-playground/issues/8) | After #6 and #7 | Explore cards and actual-tool catalogue |
| [#9](https://github.com/alundgren/parcel-hopscotch-playground/issues/9) | After #7 and #8 | End-to-end acceptance, real completion benchmarks and recordings |
| [#10](https://github.com/alundgren/parcel-hopscotch-playground/issues/10) | After #9 | Verified local container and later Piploy handoff |

The owner authorized unattended implementation owners using `gpt-5.6-sol` with `high` reasoning, configured scouts, independent reviewers, issue PRs and the orchestrator's verified merges. Continue one issue at a time in a fresh branch/worktree. Follow `implement-issue`, `github-use`, `code-guidance`, `ux-design`, and `codex-model-settings`. Capture one valid local settings snapshot per issue before claiming or launching delegates; use the new machine's configured reviewer/scout pairs. Keep one persistent independent combined reviewer per issue, include Plan, code and UX together, freeze each reviewed target, and follow the four-round and Ready/Draft rules. Reviewers receive complete requirements and evidence independently of implementation scout findings. Verify the exact reviewed PR head, closing link and CI before merging. Stop GitHub writes after an uncertain or failed write and reconcile through read-only checks before retrying.

Every UI PR needs labeled, same-state, same-viewport approved/actual comparisons and Playwright video attached with `gh --attach`. The previous machine's private screenshots are unnecessary: recreate them from the committed approved prototype. Keep the distinct paper work area, blue chat and dark tutorial instruction. Chat needs no title or explanatory subheadings. Set recording size explicitly to the tested viewport; default Playwright video can shrink a desktop viewport. Give demonstration states time to be read, outside any benchmark clock.

Use the pinned package manager in `package.json`, install with the committed lockfile, and install Playwright Chromium. Run the repository's `pnpm check` and `pnpm test:e2e` scripts. CI uses deterministic providers and real transport/persistence without paid credentials. Inspect `.env.example` and `src/server/config.ts` for current local configuration. `pnpm start` and `dev:server` currently do not automatically read `.env.local`; inject server environment explicitly until #10 supplies and verifies the documented startup flow.

A new machine needs its own server-side `OPENROUTER_API_KEY` for explicit live checks. The key was stored only in an ignored local file on the previous machine and is not transferred through GitHub. Keep it out of chat, command arguments, client build variables, fixtures, audit and Git. Unit/UI work can continue without it. Prepaid credits with Auto Recharge disabled are the spending ceiling; the owner declined an additional app/key spending cap. Keep request/output sizes, rounds, concurrency, time and retries bounded, and stop on credit exhaustion.

Use only `mistralai/ministral-3b-2512` and `typesafe/jev-1.13` through OpenRouter. The existing Ministral completion adapter and Jev alpha Decisions adapter have passed real compatibility checks. Jev returned the dated alias `typesafe/jev-1.13-20260917`; store the actual returned version. Those probes are not app latency benchmarks. Check current official provider documentation when changing adapter behavior.

All business commits remain human acceptance of a concrete proposal. Models can read, guide, classify and prepare. Preserve server-derived ownership, generation checks, atomic stale rejection, idempotency and checked Undo. Trust the valid `Cf-Access-Authenticated-User-Email` header as agreed, with no JWT requirement. Keep login email out of model input and inference audit. Each user owns their seeded work, chat, proposals, tutorials and audit. Reset returns work to first-login state while retaining Audit and costs.

For #7, these details need particular attention:

- `getAuditTrace` currently fetches recent attempts before filtering. Apply owner and selected request/turn filters in SQL before limits so older retained traces remain reachable.
- Keep one row per attempt and separate whole-turn correlation. Preserve tiny positive costs with enough precision; missing usage or billing is unknown. Label actual measured UTF-8 bytes accurately.
- Retain bounded, redacted tool/UI/terminal outcomes independently of resettable `agent_turns` and chat. A later model request incidentally containing an earlier result is insufficient audit retention.
- Keep provider-request, server-turn, browser Send-to-complete and Accept-to-visible durations separate. Use each process's monotonic clock and exclude incomplete delivery from successful completion aggregates.
- Audit updates need an owner-scoped notification identity independent of workspace sequence. An old-generation attempt finishing must not retire current sockets. Store live/scripted mode at attempt start, including cancellation before result metadata.
- Search all allowed retained text, load details on demand within the transport bound, render them as text, and test paging and cross-user isolation. Distinguish a prepared proposal from an accepted receipt.

For #8, validate every catalogue example against the real registry schemas; early examples have partial outputs. Use the existing audited Jev path directly for a card whose constrained action is already known, without paying for chat just to rediscover that action. Link the exact produced attempt/turn to Audit. Handle already-completed cases with a suitable remaining case or an explicit reset proposal, never silent reseeding.

For #9, compare both models using identical constrained inputs and choices, with expected labels outside model input. Record every attempted sample, correctness, failures, actual usage/cost, returned model and run conditions. Separate provider completion, multi-call turn completion and browser completed-work latency. Report p50/p95 with sample counts and explicit denominators. The user rejected first-token and first-useful metrics. A fast invalid answer is not completed work. Human Accept-to-visible-commit is measured separately.

The candidate cases in the JSON below were written before model results. Before running them, reconcile their labels with the actual task schema: the current consent tool has three choices, while these candidates distinguish declined from unclear. Fix the comparison contract before viewing outputs. Explicit means unqualified agreement, conditional means an explicit prerequisite, declined means rejection of that replacement, and unclear means no decision. A general product question is unclear; a picture-first request is conditional. Report unsafe approval separately from exact-label accuracy.

```json
[
  { "id": "consent-explicit", "task": "consent", "note": "Yes, please send the sage mug instead of the blue one.", "expected": "explicit" },
  { "id": "consent-picture", "task": "consent", "note": "Sage might work, but send a picture first.", "expected": "conditional" },
  { "id": "consent-price", "task": "consent", "note": "The sage one is fine if it costs the same. Please confirm the price first.", "expected": "conditional" },
  { "id": "consent-declined", "task": "consent", "note": "No, please keep the blue one on back order. I do not want sage.", "expected": "declined" },
  { "id": "consent-question", "task": "consent", "note": "How tall is the sage mug?", "expected": "unclear" },
  { "id": "consent-negation", "task": "consent", "note": "I am not saying yes to the replacement yet.", "expected": "unclear" },
  { "id": "address-number", "task": "exception", "note": "The house number is 41, not 14. The street and postcode are right.", "expected": "address" },
  { "id": "stock-sold-out", "task": "exception", "note": "The blue mugs are sold out. There are six sage mugs in the stockroom.", "expected": "stock" },
  { "id": "bundle-component", "task": "exception", "note": "The lamp bundle contains a base but no shade.", "expected": "bundle" },
  { "id": "weight-mismatch", "task": "exception", "note": "This parcel weighs 4.2 kg but the expected packed weight is 1.1 kg.", "expected": "weight" },
  { "id": "carrier-scan", "task": "exception", "note": "The parcel was collected two days ago, but the carrier has recorded no further scan.", "expected": "carrier" },
  { "id": "duplicate-order", "task": "exception", "note": "Two orders arrived one minute apart with the same items and address. Please check whether both were intended.", "expected": "duplicate" }
]
```

For #10, the starting Dockerfile has a confirmed build failure: its Node 26 image has no `corepack`. Install the pinned pnpm explicitly or use another verified bootstrap, and pin external base images by SHA-256 digest. Verify the local Docker engine before mutations; the new machine's context may differ. Test the complete container, SQLite persistence, trusted-header behavior and ordinary local secret loading. Existing `.env*` and data exclusions must remain effective.

Read Piploy's current [public registration guide](https://github.com/alundgren/Irudd.Piploy/blob/main/docs/agents/registering-an-application.md) for the offline payload. It uses a root Dockerfile/context, a persistent SQLite volume, `hostPort:containerPort` mappings that bind to localhost, and exact `${hostEnv:NAME}` secret references. The future public URL is https://parcel.irudd.net behind the owner's Cloudflare Access and tunnel. Label any proposed port as an example until the deployment owner chooses it. Production status, registration, polling and deployment wait for the owner's post-audit request and applicable approvals.

The #5 PR records four review rounds, 123 unit/integration tests, 12 browser tests, and successful PR and main CI. A Linux CI failure was corrected in the reconnect test by giving its independent SQLite connection a bounded busy wait and closing both database and socket in `finally`; product assertions were preserved. The #6 draft PR carries side-by-side comparisons and six Playwright recordings. At implementation commit `6a6d2f5`, `pnpm check` passed TypeScript, 130 unit/integration tests and the production build; `pnpm test:e2e` passed all 18 desktop/narrow tests. Root also independently passed three real-browser recovery checks, including the final-practice receipt correction. These checks do not replace the pending independent review. Read the PR checks for current CI results; CI had not completed when this handoff was written.
