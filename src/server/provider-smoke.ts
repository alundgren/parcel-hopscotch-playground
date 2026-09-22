import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { Effect } from "effect";
import { resolveIdentity } from "./identity.js";
import { runWithWorkspaceRepository, WorkspaceRepository } from "./persistence.js";
import {
  makeJevAdapter,
  makeMinistralAdapter,
  runAuditedJev,
  runAuditedMinistral,
} from "./providers/index.js";
import { makeToolRegistry, modelToolsFromRegistry } from "./tool-registry.js";
import { toolHandlers } from "./tool-handlers.js";

const localKey = async (): Promise<string | null> => {
  if (process.env.OPENROUTER_API_KEY?.trim()) {
    return process.env.OPENROUTER_API_KEY.trim();
  }
  try {
    const contents = await readFile(".env.local", "utf8");
    for (const line of contents.split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*)\s*$/.exec(line);
      if (match === null) continue;
      const value = match[1]!.replace(/^(['"])(.*)\1$/, "$2").trim();
      return value.length === 0 ? null : value;
    }
  } catch {
    return null;
  }
  return null;
};

const key = await localKey();
if (key === null) {
  throw new Error(
    "OPENROUTER_API_KEY is required in the environment or ignored .env.local file.",
  );
}

await mkdir(".tmp", { recursive: true });

const identity = await Effect.runPromise(
  resolveIdentity([], {
    environment: "development",
    host: "127.0.0.1",
    port: 0,
    publicOrigin: "http://127.0.0.1",
    databasePath: ".tmp/provider-smoke.sqlite",
    allowDevelopmentIdentity: true,
    developmentEmail: "provider-smoke@example.test",
    agentMode: "live",
    openRouterApiKey: key,
  }),
);

const ministral = makeMinistralAdapter({
  apiKey: key,
  timeoutMs: 20_000,
  maximumConcurrency: 1,
});
const jev = makeJevAdapter({
  apiKey: key,
  timeoutMs: 20_000,
  maximumConcurrency: 1,
});
const registry = makeToolRegistry(toolHandlers);
const modelTools = modelToolsFromRegistry(registry);

const result = await runWithWorkspaceRepository(
  process.env.DATABASE_PATH ?? ".tmp/provider-smoke.sqlite",
  Effect.gen(function* () {
    const repository = yield* WorkspaceRepository;
    const workspace = yield* repository.snapshot(identity);
    const turnId = `smoke_${randomUUID()}`;
    const chat = yield* runAuditedMinistral(
      {
        repository,
        identity,
        generation: workspace.generation,
        requestId: `chat_${randomUUID()}`,
        turnId,
      },
      ministral,
      {
        messages: [
          {
            role: "system",
            content: "Use the registered tools for fulfilment work. Never accept or commit a proposal.",
          },
          {
            role: "user",
            content: "Look up order BB-1042. Choose the correct registered tool and do not add prose.",
          },
        ],
        tools: modelTools,
        toolChoice: "auto",
        maxOutputTokens: 64,
      },
    );
    const selected = chat.toolCalls.find((call) => call.name === "getOrder");
    const getOrder = modelTools.find((tool) => tool.name === "getOrder");
    if (selected === undefined || getOrder === undefined || !getOrder.validateArguments(selected.arguments)) {
      throw new Error("Ministral did not select getOrder with valid bounded arguments.");
    }
    const decisions = yield* runAuditedJev(
      {
        repository,
        identity,
        generation: workspace.generation,
        requestId: `jev_${randomUUID()}`,
        turnId,
      },
      jev,
      {
        state: {
          note: "The customer accepts the sage mug only if the blue mug is unavailable.",
          proposal: { original: "blue mug", replacement: "sage mug", unavailable: true },
        },
        questions: {
          replacement_allowed: {
            type: "noul",
            instructions: "Does the stated condition allow this replacement?",
          },
          consent_kind: {
            type: "choice",
            instructions: "Classify how the customer expressed consent for this replacement.",
            criteria: {
              explicit: "The customer agreed without any condition.",
              conditional: "The customer agreed only if another stated fact is true.",
              unclear: "The note does not establish whether the customer agreed.",
            },
          },
        },
      },
    );
    const attempts = yield* repository.providerAttempts(identity, 2);
    return { chat, decisions, attempts };
  }),
);

const safe = {
  ministral: {
    provider: result.chat.metadata.provider,
    requestedModel: result.chat.metadata.requestedModel,
    actualModel: result.chat.metadata.actualModel,
    finishReason: result.chat.finishReason,
    toolCalls: result.chat.toolCalls.map((call) => ({ name: call.name })),
    inputTokens: result.chat.metadata.usage.inputTokens,
    outputTokens: result.chat.metadata.usage.outputTokens,
    costUsd: result.chat.metadata.usage.costUsd,
    completeDurationMs: result.attempts.find((attempt) => attempt.kind === "chat")?.durationMs ?? null,
  },
  jev: {
    provider: result.decisions.metadata.provider,
    requestedModel: result.decisions.metadata.requestedModel,
    actualModel: result.decisions.metadata.actualModel,
    answers: result.decisions.answers,
    inputTokens: result.decisions.metadata.usage.inputTokens,
    outputTokens: result.decisions.metadata.usage.outputTokens,
    costUsd: result.decisions.metadata.usage.costUsd,
    completeDurationMs: result.attempts.find((attempt) => attempt.kind === "decisions")?.durationMs ?? null,
  },
};

process.stdout.write(`${JSON.stringify(safe, null, 2)}\n`);
