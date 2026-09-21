import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";
import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import type { ServerConfig } from "./config.js";
import { resolveIdentity } from "./identity.js";
import { workspacePersistenceLayer } from "./persistence.js";
import {
  realtimeHubLayer,
  runWorkspaceSocket,
  validateOrigin,
} from "./realtime.js";

const jsonError = (status: number, code: string, message: string) =>
  HttpServerResponse.jsonUnsafe(
    { error: { code, message } },
    { status },
  );

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
};

const staticResponse = (url: string) => {
  const root = resolve(process.cwd(), "dist/client");
  const pathname = decodeURIComponent(new URL(url, "http://localhost").pathname);
  const requested = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const candidate = resolve(root, requested);
  const safeCandidate = candidate === root || candidate.startsWith(`${root}${sep}`);
  const selected = safeCandidate ? candidate : resolve(root, "index.html");
  return Effect.tryPromise(() => readFile(selected)).pipe(
    Effect.catch(() => Effect.tryPromise(() => readFile(resolve(root, "index.html")))),
    Effect.map((body) =>
      HttpServerResponse.uint8Array(body, {
        contentType: contentTypes[extname(selected)] ?? "application/octet-stream",
      }),
    ),
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.text("Client build not found. Run pnpm build first.", {
          status: 503,
        }),
      ),
    ),
  );
};

export const serverLayer = (config: ServerConfig) => {
  const routes = Layer.mergeAll(
    HttpRouter.add(
      "GET",
      "/api/health",
      HttpServerResponse.jsonUnsafe({ status: "ok" }),
    ),
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const source = request.source as IncomingMessage;
        const preflight = yield* Effect.result(
          Effect.all([
            resolveIdentity(source.rawHeaders, config),
            validateOrigin(source, config),
          ]),
        );
        if (preflight._tag === "Failure") {
          const error = preflight.failure;
          return jsonError(
            error._tag === "IdentityError" ? 401 : 403,
            error._tag === "IdentityError" ? error.code : "untrusted_origin",
            error.message,
          );
        }
        const identity = preflight.success[0];
        const socket = yield* request.upgrade;
        yield* runWorkspaceSocket(socket, identity);
        return HttpServerResponse.empty();
      }).pipe(
        Effect.catch(() =>
          Effect.succeed(
            jsonError(500, "realtime_failure", "The realtime connection failed."),
          ),
        ),
      ),
    ),
    HttpRouter.add("GET", "/*", (request) => staticResponse(request.url)),
  );

  return HttpRouter.serve(routes, { disableListenLog: true }).pipe(
    Layer.provide([
      workspacePersistenceLayer(config.databasePath),
      realtimeHubLayer,
      NodeHttpServer.layer(createServer, {
        host: config.host,
        port: config.port,
        websocket: { maxPayload: 16 * 1024 },
      }),
    ]),
  );
};
