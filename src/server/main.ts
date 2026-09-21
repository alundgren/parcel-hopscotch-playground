import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { serverLayer } from "./app.js";
import { loadConfig } from "./config.js";

const program = Effect.gen(function* () {
  const config = yield* loadConfig();
  yield* Effect.tryPromise(() => mkdir(dirname(config.databasePath), { recursive: true }));
  yield* Effect.sync(() => {
    console.log(`Bracken & Beam listening on http://${config.host}:${config.port}`);
  });
  yield* Layer.launch(serverLayer(config));
});

NodeRuntime.runMain(program);
