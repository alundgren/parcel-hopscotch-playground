import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import type { ServerMessage } from "../../src/shared/contracts";
import {
  RealtimeHub,
  realtimeHubLayer,
} from "../../src/server/realtime";

describe("realtime event isolation", () => {
  it("publishes an ordered event only to matching user and generation connections", async () => {
    const received = new Map<string, Array<ServerMessage>>();
    const closed: Array<string> = [];
    const connection = (id: string, generation: number) => ({
      id,
      generation,
      clientId: null,
      send: (message: ServerMessage) =>
        Effect.sync(() => {
          const messages = received.get(id) ?? [];
          messages.push(message);
          received.set(id, messages);
        }),
      close: () => Effect.sync(() => { closed.push(id); }),
    });

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const hub = yield* RealtimeHub;
          yield* hub.register("user-a", connection("a-current", 1));
          yield* hub.register("user-a", connection("a-old", 0));
          yield* hub.register("user-b", connection("b-current", 1));
          yield* hub.publish("user-a", 1, 4, "workspace.changed", { orderId: "BB-1042" });
        }),
      ).pipe(Effect.provide(realtimeHubLayer)),
    );

    expect(received.get("a-current")).toEqual([
      {
        type: "event",
        generation: 1,
        sequence: 4,
        event: "workspace.changed",
        payload: { orderId: "BB-1042" },
      },
    ]);
    expect(received.has("b-current")).toBe(false);
    expect(closed).toEqual(["a-old"]);
  });
});
