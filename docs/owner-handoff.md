# Owner handoff

Parcel Hopscotch remains private. The implementation epic is [#1](https://github.com/alundgren/parcel-hopscotch-playground/issues/1). Production registration, deployment, Cloudflare configuration, publication and repository visibility remain owner actions after the audit.

## Delivered source

| Work | Reviewed source PR | Result |
| --- | --- | --- |
| Personal workspace and realtime transport | [#11](https://github.com/alundgren/parcel-hopscotch-playground/pull/11) | 24 seeded orders, personal SQLite workspaces and WebSocket transport |
| Reviewed actions | [#12](https://github.com/alundgren/parcel-hopscotch-playground/pull/12) | Atomic proposals, acceptance, Undo and reset |
| Provider adapters | [#13](https://github.com/alundgren/parcel-hopscotch-playground/pull/13) | Bounded Ministral/Jev adapters and retained provider attempts |
| Agent tools | [#14](https://github.com/alundgren/parcel-hopscotch-playground/pull/14) | Typed registry, bounded agent turns and user-visible completion |
| Tutorials | [#15](https://github.com/alundgren/parcel-hopscotch-playground/pull/15) | Address, substitution and batch teaching with independent practice |
| Audit | [#17](https://github.com/alundgren/parcel-hopscotch-playground/pull/17) | Retained inference and application records, search and correlation |
| Explore | [#18](https://github.com/alundgren/parcel-hopscotch-playground/pull/18) | Real tool catalogue and four working scenarios |
| Acceptance and benchmark | [#19](https://github.com/alundgren/parcel-hopscotch-playground/pull/19) | Complete-flow browser proof and one bounded live comparison |
| Packaging | [#10](https://github.com/alundgren/parcel-hopscotch-playground/issues/10) | The reviewed source PR that closes this issue contains the local image and offline deployment contract |

Issues #6 through #9 each passed an independent combined Plan, code and UX review with no unresolved finding. PR #15 was reviewed at `fd9dba2b03a98404573a53fd383d1ead9debe87a`; PR #17 at `0e04e507dd678c447957b0d3ee721d19731aed30`; PR #18 at `0c6cc01de598bf312581fcce27459c52b3d77154`; and PR #19 at `1d54970d1ef38e46e15317909fe74979556234af`. Their PR and post-merge CI checks passed.

## Visual and flow evidence

PR [#19](https://github.com/alundgren/parcel-hopscotch-playground/pull/19) retains six labeled comparisons against the unchanged approved prototype:

- [Work, 1440 by 1000](https://github.com/user-attachments/assets/5a4df6c1-e7ce-4bfa-84be-2d784194438c)
- [Work, 320 by 900](https://github.com/user-attachments/assets/c16c4cc5-eeda-4cac-8466-5cf921f2790c)
- [Explore, 1440 by 1000](https://github.com/user-attachments/assets/9b72b8f9-e976-4278-b0c3-51590e5e78ab)
- [Explore, 320 by 900](https://github.com/user-attachments/assets/5c8c5cbe-f0e7-4a61-b843-ac9812e5f6d7)
- [Audit, 1440 by 1000](https://github.com/user-attachments/assets/7b391c6b-ed30-481f-91ee-a5ad6051f5b9)
- [Audit, 320 by 900](https://github.com/user-attachments/assets/c6dd219e-6e39-460b-abfe-6df53ee77580)

The same PR retains four readable complete-flow recordings:

- [Desktop completed batch](https://github.com/user-attachments/assets/771f56b6-e5eb-4bc7-a037-dd4048a6a13d)
- [Narrow completed batch](https://github.com/user-attachments/assets/18aa299f-618e-4ad0-a2e1-2414cb3397f5)
- [Desktop stale-review recovery](https://github.com/user-attachments/assets/1cc6b709-eaa0-40a6-98f2-6e91c32359f0)
- [Narrow stale-review recovery](https://github.com/user-attachments/assets/805e899f-f35b-4d37-a352-a0a40113872d)

The accepted prototype remains `docs/design/approved-prototype.html` from bootstrap commit `3ce3912accaee54f2c353ff9b00d6e8022eeec72`. Packaging does not alter app UI, so this work reuses the reviewed issue #9 comparisons and videos.

## Packaging evidence

Current development and validation use Vite Plus 0.3.0 with managed Node 24.19.0 and pnpm 12.5.0. Bootstrap and active commands are in the root [README](../README.md); the exact image choice and deferred production checks are in the [operator guide](operator-guide.md). The older commands and artifact identifiers below remain dated evidence for the earlier Node 26 packaging work. They are not instructions for rebuilding the current image.

The Vite Plus migration's local AMD64 verifier built image `sha256:ea7bac75be27e17af84224f024608dfd5df3384f7f101f56047d37669d3d7d05`. It inspected 6,192 production dependency files and found no native addon, ELF package, Vite Plus, Vite, Vitest, Rolldown, esbuild or second managed Node installation. Both persistence modes passed with Node 24.19.0, UID/GID 1000, trusted-header checks, accepted work and four SIGTERM shutdowns from 236 to 295 milliseconds. A credential-free HTTPS request from the final image also passed.

The migration's ARM64 OCI archive was 93,425,152 bytes with SHA-256 `a0bf36f1ead4d60a0e605efd25c3aca9a51106e247e0d21a1f6b66fbf4fcf2b9`. Its index declares `linux/arm64`, manifest `sha256:e85b496d99d5a18137553f4a9ffe8f7eba9784494683af798ee8bcbb7b8dd0b0` and config `sha256:d75b2530580e84dbb876b85565de9e504e3402b08b68e349eca5590d90116ba0`. Inspection found an ARM AArch64 Node executable, Node 24.19.0 in the image config, compiled client and server files, and the same production-only dependency checks. This host did not execute the ARM64 artifact.

The container and application artifact inputs were tested at source revision `489139312fc1dddf91c0df0319ada27d5541e527` on a headless Linux x86_64 VM. Later review corrections only changed the verifier, its tests and this documentation; they did not change the Dockerfile, package manifests, client/server source or runtime configuration used to produce these images.

`pnpm verify:container` built `linux/amd64` image `sha256:93d36163faa394ad9c879d0edb49630d314c9b532efdb7ba5a08911c0cd50f90`. The production process ran as UID/GID 1000, served the React build and real health endpoint, enforced the trusted email header on WebSocket connections, accepted the `BB-1042` update and retained it after container replacement. Both a Docker named volume and an owner-only mode-0700 bind directory passed. Four SIGTERM checks closed through Effect in 227 to 260 milliseconds with its expected interruption exit 130. The verifier also confirmed loopback-only publication, PID 1, license files and the absence of development dependencies and baked OpenRouter credentials.

An independent production-container browser check at the same revision observed Docker health `healthy`, completed a scripted agent turn through the trusted-header WebSocket, accepted the proposal and displayed the committed address with no page error. Its uniquely named local resources were removed after the check.

The ARM64 build command was:

```bash
docker buildx build --platform linux/arm64 \
  --output type=oci,dest=parcel-hopscotch-4891393-linux-arm64.oci.tar .
```

The resulting 96,363,008-byte OCI archive has SHA-256 `1b1117b585193393070f1ef5d7fbe61c18fbf7a9e47ae64cc2680459d9697b5a`. Its index declares `linux/arm64`, manifest `sha256:68a478c0c4cb08cdbe72e86032133feb2349c4595b10386e3ef7d04213bf1f2c` and config `sha256:a2e280965c2e0595fa2f3c4c0033b7f4d22a12a6317762b78c2d80a6d9576361`. Independent inspection verified every layer digest, the nonroot runtime user, an AArch64 Node executable, production dependency pruning and compiled server output. The AMD64 VM did not execute this ARM64 image, so the owner must run `pnpm verify:container` on the target architecture before public traffic.

The packaging source PR retains the final reviewed revision, review dispositions, validation commands and CI results. These identifiers allow the owner to compare that record with the exact local artifacts summarized here.

## Measured results

The [acceptance report](acceptance-report.md) covers 36 Playwright cases on a headless Linux x86_64 VM with four available CPUs, Node 24.21.0 and Chromium 151.0.7922.34. The browser and server ran on that same VM. Deterministic batch samples were:

| Viewport | Server turn | Send to completed work | Accept to committed visible update |
| --- | ---: | ---: | ---: |
| 1440 by 1000 | 337 ms | 420 ms | 43.1 ms |
| 320 by 900 | 194 ms | 240 ms | 70.8 ms |

These are individual scripted-provider regression samples, not live model latency claims. Earlier measurements from the first MacBook session remain historical and are not pooled with these VM results.

The retained [live benchmark](benchmarks/2026-09-22-live/README.md) made 28 requests and cost exactly $0.000600186. Jev completed 12 of 12 constrained cases with no unsafe explicit approval among five non-explicit fixtures. Ministral completed 11 of 12 and produced one unsafe explicit approval. One of two tool scenarios completed. The second ended with `incomplete_response` at the 256-token scenario cap, so the run is not a complete pass. Raw measured artifacts remain unchanged; [CORRECTION.md](benchmarks/2026-09-22-live/CORRECTION.md) records that the historical 64-token field was Ministral-only and documents Jev's actual non-token bounds.

The separate compatibility smoke check used the application adapters once per model. Ministral completed a forced `getOrder` tool call in 532 ms with 114 tokens and $0.0000114 cost. Jev returned the dated provider model `typesafe/jev-1.13-20260917`, classified conditional consent in 411 ms with 477 tokens and $0.000017598 cost. These are single compatibility checks, not benchmark samples.

## Security and operating assumptions

The server derives identity from exactly one Cloudflare Access email header. Production disables development fallback. Loopback host-port publication and Cloudflare Access/Tunnel are part of the trust decision. A direct non-loopback route to the container is outside that model.

Model tools can query, guide, classify and prepare. A human click accepts a concrete proposal before any business mutation. The server checks owner, generation and record versions in the transaction. Reset restores seeded work and clears chat, tutorials and proposals while retaining provider attempts, application audit and cost.

Inference is bounded by model allowlists, request and response byte limits, output limits where the provider API supports one, timeouts, concurrency, retry and tool-round limits. CI and deterministic browser tests use scripted providers. Live work requires explicit invocation and the server-only OpenRouter key. Prepaid credits with automatic recharge disabled remain the spending ceiling.

## Reuse and licenses

The following modules are adaptation starting points. Some import current workspace or tool types, so extraction requires replacing those contracts rather than copying them unchanged:

- `src/server/providers/` contains bounded provider transport, adapters, parsing, redaction and audit normalization.
- `src/server/realtime.ts` contains the validated WebSocket protocol, backpressure, reconnect and owner-scoped publishing.
- `src/server/tool-registry.ts` contains the typed tool schema and catalogue metadata contract.
- `src/server/agent-runtime.ts` contains bounded turn coordination and validated tool dispatch.
- `src/server/identity.ts` contains trusted-header parsing and internal identity derivation.
- The Audit correlation and duration records in `src/server/persistence.ts` separate provider requests, complete turns and accepted commands.

Original repository code and tracked image assets use the root [MIT license](../LICENSE). The UI uses system fonts and has no downloaded font files. Third-party npm packages retain their own licenses and notices under their package directories. The runtime image includes production dependency directories and the repository license. Reusing a dependency remains subject to that dependency's license; the repository MIT license does not replace it.

## Remaining owner work

1. Audit the final reviewed source PR and keep the repository private until publication is approved.
2. Run `vp run verify:container` on the target architecture. The current VM cannot execute ARM64 containers.
3. Give Piploy access to clone the private repository and make its managed `/data` directory writable by UID 1000.
4. Select an actual host port after checking current Piploy mappings and other host processes. The offline payload's 8089 is only an unallocated example.
5. Put `OPENROUTER_API_KEY` in the Piploy daemon environment and review the exact registration payload.
6. Approve registration and a later poll as separate production changes.
7. Configure the Cloudflare Access allowlist and Tunnel hostname `parcel.irudd.net`, then repeat health, identity, WebSocket and persistence checks before public traffic.

The exact offline payload and permission details are in [operator-guide.md](operator-guide.md).
