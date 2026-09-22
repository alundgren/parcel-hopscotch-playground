import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { WebSocketServer } from "ws";

// The verifier stays plain JavaScript so it can run without a build step.
// @ts-expect-error The executable JavaScript module intentionally has no declaration file.
import { connect, waitForHealth } from "../../scripts/verify-container.mjs";

const servers: Server[] = [];

const listen = async (server: Server): Promise<number> => {
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Missing test server port.");
  return address.port;
};

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

describe("container verifier network deadlines", () => {
  it("abandons a health request when the server never responds", async () => {
    const port = await listen(createServer(() => undefined));

    await expect(waitForHealth(`http://127.0.0.1:${port}`, {
      deadlineMilliseconds: 100,
      requestTimeoutMilliseconds: 40,
    })).rejects.toThrow("did not become ready");
  });

  it("closes a WebSocket that never sends its initial snapshot", async () => {
    const server = createServer();
    const webSockets = new WebSocketServer({ server });
    const port = await listen(server);

    await expect(connect(port, "container@example.test", undefined, {
      snapshotTimeoutMilliseconds: 100,
    })).rejects.toThrow("Timed out waiting for the initial WebSocket snapshot");

    webSockets.close();
  });
});
