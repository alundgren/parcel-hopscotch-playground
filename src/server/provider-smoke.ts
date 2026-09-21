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
            role: "user",
            content: "Look up order BB-1042. Use the provided tool and do not add prose.",
          },
        ],
        tools: [
          {
            name: "getOrder",
            description: "Read one fictional fulfilment order by its ID.",
            parameters: {
              type: "object",
              properties: { orderId: { type: "string" } },
              required: ["orderId"],
              additionalProperties: false,
            },
            validateArguments: (value) => {
              if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
              const record = value as Record<string, unknown>;
              return Object.keys(record).length === 1 && record.orderId === "BB-1042";
            },
          },
        ],
        toolChoice: { name: "getOrder" },
        maxOutputTokens: 64,
      },
    );
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
    toolCalls: result.chat.toolCalls.map((call) => ({ id: call.id, name: call.name })),
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
