import { execFileSync } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import WebSocket from "ws";

const repository = process.cwd();
const suffix = `${Date.now()}-${process.pid}`;
const image = `parcel-hopscotch:verify-${suffix}`;
const prefix = `parcel-hopscotch-verify-${suffix}`;
const createdContainers = new Set();
const createdVolumes = new Set();
const createdDirectories = new Set();
const preparedBindDirectories = new Map();
let localDockerVerified = false;
let imageCreated = false;
let permissionHelperSequence = 0;

const docker = (args, options = {}) => {
  const output = execFileSync("docker", args, {
    cwd: repository,
    encoding: "utf8",
    stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
  });
  return output?.trim() ?? "";
};

const availablePort = () =>
  new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("Could not allocate a loopback port."));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });

export const waitForHealth = async (
  origin,
  { deadlineMilliseconds = 30_000, requestTimeoutMilliseconds = 1_000 } = {},
) => {
  const deadline = Date.now() + deadlineMilliseconds;
  while (Date.now() < deadline) {
    try {
      const remaining = deadline - Date.now();
      const response = await fetch(`${origin}/api/health`, {
        signal: AbortSignal.timeout(Math.max(1, Math.min(requestTimeoutMilliseconds, remaining))),
      });
      if (response.ok && (await response.json()).status === "ok") return;
    } catch {
      // Docker has published the port but the application is still starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Container at ${origin} did not become ready.`);
};

const nextMessage = (socket, predicate = () => true) =>
  new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timed out waiting for WebSocket data.")), 8_000);
    const listener = (data) => {
      const message = JSON.parse(data.toString());
      if (!predicate(message)) return;
      clearTimeout(timeout);
      socket.off("message", listener);
      resolve(message);
    };
    socket.on("message", listener);
  });

export const connect = (port, email, duplicateEmail, { snapshotTimeoutMilliseconds = 8_000 } = {}) =>
  new Promise((resolve, reject) => {
    const headers = email === null
      ? undefined
      : {
          "Cf-Access-Authenticated-User-Email": duplicateEmail === undefined
            ? email
            : [email, duplicateEmail],
        };
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
      origin: `http://127.0.0.1:${port}`,
      headers,
    });
    let settled = false;
    const rejectConnection = (error, terminate = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (terminate) {
        socket.once("error", () => undefined);
        socket.terminate();
      }
      reject(error);
    };
    const timeout = setTimeout(() => {
      rejectConnection(new Error("Timed out waiting for the initial WebSocket snapshot."), true);
    }, snapshotTimeoutMilliseconds);
    socket.once("unexpected-response", (_request, response) => {
      rejectConnection(Object.assign(new Error(`WebSocket rejected with ${response.statusCode}.`), {
        status: response.statusCode,
      }), true);
    });
    socket.once("error", (error) => {
      rejectConnection(error);
    });
    socket.once("message", (data) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({ socket, snapshot: JSON.parse(data.toString()) });
    });
  });

const setBindDirectoryOwner = (directory, uid, gid) => {
  const helperName = `${prefix}-bind-permissions-${permissionHelperSequence += 1}`;
  docker([
    "run",
    "--rm",
    "--name",
    helperName,
    "--user",
    "0:0",
    "--mount",
    `type=bind,source=${directory},target=/data`,
    "--entrypoint",
    "chown",
    image,
    "-R",
    `${uid}:${gid}`,
    "/data",
  ]);
};

const expectRejected = async (promise, status) => {
  try {
    const connection = await promise;
    connection.socket.close();
    throw new Error(`Expected WebSocket rejection ${status}.`);
  } catch (error) {
    if (error?.status !== status) throw error;
  }
};

const closeSocket = (socket) =>
  new Promise((resolve) => {
    if (socket.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }
    const timeout = setTimeout(resolve, 2_000);
    socket.once("close", () => {
      clearTimeout(timeout);
      resolve();
    });
    socket.close();
  });

const startContainer = async (name, mount, port) => {
  docker([
    "run",
    "--detach",
    "--name",
    name,
    "--mount",
    mount,
    "--publish",
    `127.0.0.1:${port}:3000`,
    "--env",
    "NODE_ENV=production",
    "--env",
    "HOST=0.0.0.0",
    "--env",
    "PORT=3000",
    "--env",
    `PUBLIC_ORIGIN=http://127.0.0.1:${port}`,
    "--env",
    "DATABASE_PATH=/data/parcel.sqlite",
    "--env",
    "ENABLE_DEV_IDENTITY=false",
    "--env",
    "AGENT_PROVIDER_MODE=scripted",
    image,
  ]);
  createdContainers.add(name);
  const origin = `http://127.0.0.1:${port}`;
  await waitForHealth(origin);
  return origin;
};

const stopContainer = (name) => {
  const startedAt = Date.now();
  docker(["stop", "--timeout", "10", name]);
  const stopMilliseconds = Date.now() - startedAt;
  const state = JSON.parse(docker(["inspect", "--format", "{{json .State}}", name]));
  if (state.OOMKilled || state.ExitCode === 137 || stopMilliseconds >= 9_500) {
    throw new Error(`${name} did not finish graceful SIGTERM shutdown: ${JSON.stringify({ stopMilliseconds, state })}`);
  }
  const logs = docker(["logs", name]);
  if (logs.includes("container@example.test") || logs.includes("OPENROUTER_API_KEY")) {
    throw new Error(`${name} wrote identity or secret configuration to its logs.`);
  }
  docker(["rm", name]);
  createdContainers.delete(name);
  return { exitCode: state.ExitCode, stopMilliseconds };
};

const mutateWorkspace = async (socket, generation) => {
  const proposalReply = nextMessage(
    socket,
    (message) => message.type === "command_result" && message.requestId === "verify-prepare",
  );
  socket.send(JSON.stringify({
    type: "prepare_resolution",
    requestId: "verify-prepare",
    generation,
    orderId: "BB-1042",
  }));
  const proposal = await proposalReply;
  if (proposal.result?.kind !== "proposal") throw new Error("Container did not prepare BB-1042.");

  const acceptedReply = nextMessage(
    socket,
    (message) => message.type === "command_result" && message.requestId === "verify-accept",
  );
  socket.send(JSON.stringify({
    type: "accept_proposal",
    requestId: "verify-accept",
    generation,
    proposalId: proposal.result.proposal.id,
    idempotencyKey: `container-verification-${suffix}`,
  }));
  const accepted = await acceptedReply;
  if (accepted.result?.kind !== "receipt") throw new Error("Container did not accept BB-1042.");
  const order = accepted.state.orders.find((candidate) => candidate.id === "BB-1042");
  if (order === undefined || order.version <= 1) throw new Error("Accepted BB-1042 was not visible.");
  return order;
};

const verifyMount = async (kind, mount) => {
  const firstName = `${prefix}-${kind}-first`;
  const firstPort = await availablePort();
  const origin = await startContainer(firstName, mount, firstPort);
  const user = docker(["inspect", "--format", "{{.Config.User}}", firstName]);
  if (user !== "node") throw new Error(`Expected image user node, received ${user}.`);
  const portBindings = JSON.parse(docker(["inspect", "--format", "{{json .HostConfig.PortBindings}}", firstName]));
  if (portBindings["3000/tcp"]?.[0]?.HostIp !== "127.0.0.1") {
    throw new Error(`Expected loopback publication: ${JSON.stringify(portBindings)}`);
  }
  const pidOne = docker(["exec", firstName, "node", "-e", "process.stdout.write(require('node:fs').readFileSync('/proc/1/cmdline').toString().replaceAll('\\0', ' ').trim())"]);
  if (!pidOne.startsWith("node dist/server/server/main.js")) {
    throw new Error(`PID 1 is not the application Node process: ${pidOne}`);
  }
  const dataAccess = docker(["exec", firstName, "node", "-e", "const fs=require('node:fs'); const p='/data/.write-check'; fs.writeFileSync(p,'ok'); fs.unlinkSync(p); const s=fs.statSync('/data'); process.stdout.write(`${process.getuid()}:${process.getgid()}:${s.uid}:${s.gid}`)"]);
  const [uid, gid] = dataAccess.split(":").map(Number);
  if (uid !== 1000 || gid !== 1000) throw new Error(`Container process is ${uid}:${gid}, expected 1000:1000.`);
  docker(["exec", firstName, "node", "-e", "const fs=require('node:fs'); for (const p of ['/app/LICENSE','/app/node_modules/react/LICENSE','/app/node_modules/effect/LICENSE']) if (!fs.existsSync(p)) throw new Error(`Missing ${p}`); if (fs.existsSync('/app/node_modules/vitest')) throw new Error('Development dependencies reached runtime')"]);

  const html = await (await fetch(origin)).text();
  if (!html.includes("Bracken &amp; Beam")) throw new Error("Built React application was not served.");
  await expectRejected(connect(firstPort, null), 401);
  await expectRejected(connect(firstPort, "malformed"), 401);
  await expectRejected(connect(firstPort, "one@example.test", "two@example.test"), 401);

  const first = await connect(firstPort, "container@example.test");
  if (first.snapshot.type !== "snapshot") throw new Error("WebSocket did not return a workspace snapshot.");
  const acceptedOrder = await mutateWorkspace(first.socket, first.snapshot.generation);
  await closeSocket(first.socket);
  const firstStop = stopContainer(firstName);

  const secondName = `${prefix}-${kind}-second`;
  const secondPort = await availablePort();
  await startContainer(secondName, mount, secondPort);
  const second = await connect(secondPort, "container@example.test");
  if (second.snapshot.type !== "snapshot") throw new Error("Restarted WebSocket did not return a snapshot.");
  const persistedOrder = second.snapshot.state.orders.find((candidate) => candidate.id === "BB-1042");
  if (persistedOrder?.version !== acceptedOrder.version || persistedOrder?.status !== acceptedOrder.status) {
    throw new Error("Accepted BB-1042 did not survive container replacement.");
  }
  await closeSocket(second.socket);
  const secondStop = stopContainer(secondName);

  return {
    kind,
    firstStop,
    secondStop,
    processUser: `${uid}:${gid}`,
    dataDirectoryOwner: dataAccess.split(":").slice(2).join(":"),
    acceptedOrder: {
      id: acceptedOrder.id,
      status: acceptedOrder.status,
      version: acceptedOrder.version,
    },
  };
};

const cleanup = async () => {
  if (!localDockerVerified) return;
  for (const name of createdContainers) {
    try { docker(["rm", "--force", name]); } catch { /* retain the primary failure */ }
  }
  for (const name of createdVolumes) {
    try { docker(["volume", "rm", name]); } catch { /* retain the primary failure */ }
  }
  for (const directory of createdDirectories) {
    const owner = preparedBindDirectories.get(directory);
    if (owner !== undefined && imageCreated) {
      try {
        setBindDirectoryOwner(directory, owner.uid, owner.gid);
        preparedBindDirectories.delete(directory);
      } catch { /* retain the primary failure */ }
    }
    await rm(directory, { recursive: true, force: true }).catch(() => undefined);
  }
  if (imageCreated) {
    try { docker(["image", "rm", image]); } catch { /* retain the primary failure */ }
  }
};

export const main = async () => {
try {
  const explicitContext = process.env.DOCKER_CONTEXT;
  const context = explicitContext || docker(["context", "show"]);
  const contextEndpoint = () => JSON.parse(
    docker(["context", "inspect", context, "--format", "{{json .Endpoints.docker.Host}}"]),
  );
  const endpoint = explicitContext ? contextEndpoint() : process.env.DOCKER_HOST || contextEndpoint();
  if (!endpoint.startsWith("unix://")) {
    throw new Error(`Refusing to mutate non-local Docker endpoint ${endpoint}.`);
  }
  localDockerVerified = true;
  const localPlatform = docker(["version", "--format", "{{.Server.Os}}/{{.Server.Arch}}"]);

  docker(["build", "--platform", localPlatform, "--tag", image, "."], { inherit: true });
  imageCreated = true;
  const imageId = docker(["image", "inspect", "--format", "{{.Id}}", image]);
  const platform = docker(["image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", image]);
  const configuredUser = docker(["image", "inspect", "--format", "{{.Config.User}}", image]);
  const healthcheck = JSON.parse(docker(["image", "inspect", "--format", "{{json .Config.Healthcheck}}", image]));
  if (!Array.isArray(healthcheck?.Test) || !healthcheck.Test.join(" ").includes("/api/health")) {
    throw new Error("The image does not contain the expected health check.");
  }
  const imageEnvironment = JSON.parse(docker(["image", "inspect", "--format", "{{json .Config.Env}}", image]));
  if (imageEnvironment.some((entry) => entry.startsWith("OPENROUTER_API_KEY="))) {
    throw new Error("The image config contains OPENROUTER_API_KEY.");
  }

  const volume = `${prefix}-data`;
  docker(["volume", "create", volume]);
  createdVolumes.add(volume);
  const named = await verifyMount("named", `type=volume,source=${volume},target=/data`);

  const bindDirectory = await mkdtemp(join(tmpdir(), `${prefix}-bind-`));
  createdDirectories.add(bindDirectory);
  const originalBindOwner = await stat(bindDirectory);
  preparedBindDirectories.set(bindDirectory, {
    uid: originalBindOwner.uid,
    gid: originalBindOwner.gid,
  });
  const originalBindDirectoryOwner = `${originalBindOwner.uid}:${originalBindOwner.gid}`;
  setBindDirectoryOwner(bindDirectory, 1000, 1000);
  const bindDirectoryStat = await stat(bindDirectory);
  if (bindDirectoryStat.uid !== 1000 || bindDirectoryStat.gid !== 1000) {
    throw new Error(`Bind directory is ${bindDirectoryStat.uid}:${bindDirectoryStat.gid}, expected 1000:1000.`);
  }
  const bind = await verifyMount("bind", `type=bind,source=${bindDirectory},target=/data`);
  setBindDirectoryOwner(bindDirectory, originalBindOwner.uid, originalBindOwner.gid);
  preparedBindDirectories.delete(bindDirectory);
  const restoredBindOwner = await stat(bindDirectory);
  if (restoredBindOwner.uid !== originalBindOwner.uid || restoredBindOwner.gid !== originalBindOwner.gid) {
    throw new Error(
      `Bind directory owner restored to ${restoredBindOwner.uid}:${restoredBindOwner.gid}, expected ${originalBindDirectoryOwner}.`,
    );
  }

  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    dockerContext: context,
    dockerEndpoint: endpoint,
    imageId,
    platform,
    requestedPlatform: localPlatform,
    configuredUser,
    healthcheck: "configured and direct HTTP request passed",
    publishedAddress: "127.0.0.1 only",
    bindDirectory: {
      originalOwner: originalBindDirectoryOwner,
      uid: bindDirectoryStat.uid,
      gid: bindDirectoryStat.gid,
      mode: (bindDirectoryStat.mode & 0o777).toString(8).padStart(3, "0"),
      restoredOwner: `${restoredBindOwner.uid}:${restoredBindOwner.gid}`,
    },
    productionIdentity: {
      missing: "rejected 401",
      malformed: "rejected 401",
      duplicate: "rejected 401",
      valid: "accepted",
    },
    mounts: [named, bind],
  }, null, 2));
} finally {
  await cleanup();
}
};

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
