# Operator guide

This document is the offline deployment contract for the repository owner. It does not register, poll or deploy an application. It does not change Piploy, Cloudflare, Tailscale, the production host, repository visibility or a published image.

## Runtime contract

Piploy builds the root `Dockerfile` with the repository root as its context and creates one container. The application build and fresh production-dependency stages use `ghcr.io/voidzero-dev/vite-plus:1.0.0-rc.0@sha256:2777dc87ed4d842688af87d20e8452561609d20d78927c6c9544aa011b9b4e8f` on `$BUILDPLATFORM`. The runtime uses `node:24-bookworm-slim@sha256:3638d9a6fe4030bd716be989438248074489337ba3275657f93595428be4fc03`. Both are multi-platform OCI index references. Literal references matter because the current Piploy parser rejects unresolved Dockerfile variables in image references.

Both dependency stages use Vite Plus to select Node 24.19.0 and the project-pinned pnpm 12.5.0. They mount the same BuildKit cache at `/pnpm/store`, so the production install and later builds can reuse downloaded package content without putting the store in an image layer. UID/GID 1000 matches the Vite Plus `vp` user, and `sharing=locked` prevents concurrent builds from writing the store at the same time. Each install limits registry concurrency to four requests and allows five minutes per fetch, giving slow Pi downloads more time to finish.

The production-dependency stage starts without the development install and runs `vp install --prod --frozen-lockfile`, with the pnpm-only cache and network options after `--`. Installing with `--prod` over a full dependency tree does not remove packages already present, so this separate stage remains necessary. The current production graph has no native addon or target-dependent binary, so its builder-platform install can be copied into either selected runtime architecture. The pnpm store is content-addressed and can hold packages for more than one architecture, but `node_modules` contains packages selected for `$BUILDPLATFORM`. Recheck the final install and install for the target architecture if the production graph gains a target-dependent package.

The Debian candidate `debian:bookworm-slim@sha256:88200866dfff7ea7f5cbcb6ec7c8a701889efe6fe859fe64d6990e4b07ea4171` was evaluated and not selected. Its ARM64 base layer differs from both selected images, and it needs a separately supplied Node binary. The Node image keeps the exact runtime used by the owner's other repository without copying Vite Plus or a second Node installation into the final image.

The container runs `node dist/server/server/main.js` as user `node`, UID/GID 1000. That single process serves the built React files, `/api/health` and `/ws` on port 3000. `DATABASE_PATH=/data/parcel.sqlite` keeps SQLite on the mounted path. The Docker health check makes a real request to `/api/health`; a successful request is possible only after startup recovery and the persistence/server layers have opened. The earlier startup log says that startup has begun and is not a readiness receipt.

An empty Docker named volume receives `/data` with ownership 1000:1000 from the image. Piploy maps a volume to a managed host directory. Its public guide does not promise that directory's ownership or mode. Before the first container starts, the owner must make the resulting directory writable by UID 1000. An owner-controlled local equivalent is:

```bash
install -d -m 0700 -o 1000 -g 1000 /path/to/parcel-hopscotch-data
```

Do not change unrelated host directories, containers or volumes while checking this prerequisite.

## Authentication and secrets

Production sets `NODE_ENV=production` and `ENABLE_DEV_IDENTITY=false`. Every WebSocket handshake must contain exactly one valid `Cf-Access-Authenticated-User-Email` header and the configured public Origin. Missing, duplicate and malformed identity headers are rejected. The app trusts the header because Piploy publishes the host port on loopback and the owner places Cloudflare Access and Tunnel in front of that endpoint. Direct access to a non-loopback published port would let a caller forge the trusted header and violates this contract.

The server hashes the normalized email into its internal user identity. It does not put the login email in provider prompts or inference audit bodies. `OPENROUTER_API_KEY` is a server-only environment value. The client build uses no secret-prefixed variable, and `.env*` files are outside the Docker build context.

## Offline Piploy payload

The current public registration guide requires one repository per container, a Dockerfile path relative to the repository root, string port mappings, named persistent paths and complete `${hostEnv:NAME}` references for secrets. The tracked [example payload](piploy-application.example.json) is documentation only:

```json
{
  "Name": "parcel-hopscotch-playground",
  "GitRepositoryUrl": "https://github.com/alundgren/parcel-hopscotch-playground.git",
  "DockerfilePath": "Dockerfile",
  "PortMappings": ["8089:3000"],
  "Volumes": ["parcel-hopscotch-playground-data:/data"],
  "EnvironmentVariables": {
    "NODE_ENV": "production",
    "HOST": "0.0.0.0",
    "PORT": "3000",
    "PUBLIC_ORIGIN": "https://parcel.irudd.net",
    "DATABASE_PATH": "/data/parcel.sqlite",
    "ENABLE_DEV_IDENTITY": "false",
    "AGENT_PROVIDER_MODE": "live",
    "OPENROUTER_API_KEY": "${hostEnv:OPENROUTER_API_KEY}"
  }
}
```

Port 8089 is an unallocated example. No Piploy status call or host-wide port check was made in this work. At deployment time, the owner must read current Piploy status, choose an unused application port in the documented 8080 to 8999 range, and separately confirm that no other host process owns it. Piploy binds the chosen host side to loopback. If the owner later selects `8089:3000`, the Cloudflare Tunnel service points to `http://localhost:8089`.

Before registration, the owner must also:

1. Finish the private source audit and keep or change the application name.
2. Give Piploy clone access to the private repository.
3. Put the real key in the Piploy daemon environment as `OPENROUTER_API_KEY`; keep the payload's exact `${hostEnv:OPENROUTER_API_KEY}` reference.
4. Set the managed `/data` directory permissions for UID 1000.
5. Check the current public registration guide and registered port mappings.
6. Review the exact payload and approve registration. Polling needs a separate approval because it reconciles every registered application.
7. Configure the Cloudflare Access allowlist and public hostname manually after the container is running.

Registration and polling remain owner actions after the audit. The repository contains no automatic production workflow.

## Local verification and architecture limit

Run `vp run verify:container` against a local Unix-socket Docker engine. The verifier uses unique resource names and refuses a TCP endpoint before any Docker mutation. It checks Node 24.19.0, production-only dependencies, the absence of build tools and extra managed runtimes, and the production identity contract with the scripted provider. It makes no paid request.

The verifier uses a short-lived root helper container to prepare only its own mode-0700 bind directory for UID/GID 1000. It restores the invoking host user's ownership before removing that directory. The application containers continue to run as the nonroot `node` user.

The selected builder index contains `linux/amd64` and `linux/arm64` manifests. The runtime index also contains those architectures. For ARM64, the builder resolves to manifest `sha256:3816074488e07f2fdb470b9e39827aa32cec3d01b847eb9f327831187c9e3a91` and the Node runtime resolves to `sha256:c133efe216ffb6e785ed9a8be55a29fcb86775e8008ae0a9f0ed6af4f175bb03`. Their current ARM64 manifests do not share a compressed layer.

Registry layer sizes describe compressed transfer bytes. They do not establish local disk use. BuildKit's pnpm cache is separate from layers retained by a running image and persists only while the selected builder keeps that cache. No production-host inventory was taken. Actual Pi image presence and incremental build savings remain unknown until the owner checks them during the deployment audit.

Runtime SQLite uses Node's built-in `node:sqlite`; it does not use a native npm SQLite addon. This AMD64 VM cannot execute ARM64 containers. An ARM64 OCI build proves Dockerfile resolution, architecture and included artifacts, but it does not prove that the application executes on ARM64. The owner should run the same verifier on that architecture after the audit and before public traffic.

## Recovery and backup

Docker sends SIGTERM to the Node PID 1. Effect interrupts the server layers, closes WebSocket and database resources, and exits before Docker's grace period expires. A replacement container that mounts the same `/data` resumes accepted work and recovers interrupted provider attempts and turns.

Back up the mounted directory while the application is stopped or with a SQLite-aware backup procedure. Copying a live database file without its write-ahead-log files is not a valid backup. Restoring a backup replaces every user's retained work and audit in that database, so keep the source and target explicit.
