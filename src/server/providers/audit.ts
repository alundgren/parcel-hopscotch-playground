import { Effect } from "effect";
import type { RequestIdentity } from "../identity.js";
import type { WorkspaceRepositoryService } from "../persistence.js";
import type {
  JevAdapter,
  JevRequest,
  JevResult,
  MinistralAdapter,
  MinistralRequest,
  MinistralResult,
  ProviderError,
  ProviderMetadata,
} from "./contracts.js";
import { JEV_MODEL, MINISTRAL_MODEL } from "./contracts.js";
import { jsonBytes } from "./http.js";

export type ProviderAttemptKind = "chat" | "decisions";
export type ProviderAttemptOutcome =
  | "running"
  | "success"
  | "error"
  | "credits_exhausted"
  | "timeout"
  | "cancelled"
  | "interrupted";

export interface ProviderAttemptStart {
  readonly identity: RequestIdentity;
  readonly generation: number;
  readonly requestId: string;
  readonly turnId: string;
  readonly kind: ProviderAttemptKind;
  readonly provider: "OpenRouter";
  readonly model: string;
  readonly request: unknown;
  readonly requestBytes: number;
}

export interface ProviderAttemptFinish {
  readonly outcome: Exclude<ProviderAttemptOutcome, "running">;
  readonly provider: string | null;
  readonly actualModel: string | null;
  readonly providerRequestId: string | null;
  readonly generationId: string | null;
  readonly response: unknown;
  readonly responseBytes: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryCount: number;
}

export interface ProviderAttemptRecord {
  readonly id: string;
  readonly userId: string;
  readonly generation: number;
  readonly requestId: string;
  readonly turnId: string;
  readonly kind: ProviderAttemptKind;
  readonly provider: string;
  readonly requestedModel: string;
  readonly actualModel: string | null;
  readonly providerRequestId: string | null;
  readonly generationId: string | null;
  readonly request: unknown;
  readonly response: unknown;
  readonly requestBytes: number;
  readonly responseBytes: number | null;
  readonly startedAt: string;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
  readonly outcome: ProviderAttemptOutcome;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly retryCount: number;
}

export type ProviderAttemptSummary = Omit<
  ProviderAttemptRecord,
  "request" | "response"
>;

export type ProviderAuditNotification = (
  userId: string,
  attempt: Pick<
    ProviderAttemptRecord,
    | "id"
    | "generation"
    | "kind"
    | "provider"
    | "requestedModel"
    | "actualModel"
    | "outcome"
    | "durationMs"
    | "inputTokens"
    | "outputTokens"
    | "costUsd"
  >,
) => Effect.Effect<void>;

export interface ProviderAttemptRepository {
  readonly startProviderAttempt: (
    input: ProviderAttemptStart,
  ) => Effect.Effect<ProviderAttemptRecord>;
  readonly finishProviderAttempt: (
    identity: RequestIdentity,
    attemptId: string,
    finish: ProviderAttemptFinish,
  ) => Effect.Effect<ProviderAttemptRecord>;
  readonly providerAttempts: (
    identity: RequestIdentity,
    limit?: number,
  ) => Effect.Effect<ReadonlyArray<ProviderAttemptSummary>>;
  readonly providerAttempt: (
    identity: RequestIdentity,
    attemptId: string,
  ) => Effect.Effect<ProviderAttemptRecord | null>;
  readonly recoverProviderAttempts: () => Effect.Effect<number>;
}

export interface AuditedProviderContext {
  readonly repository: WorkspaceRepositoryService & ProviderAttemptRepository;
  readonly identity: RequestIdentity;
  readonly generation: number;
  readonly requestId: string;
  readonly turnId: string;
  readonly notify?: ProviderAuditNotification;
}

const safeMinistralRequest = (request: MinistralRequest) => ({
  model: MINISTRAL_MODEL,
  messages: request.messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
  })),
  stream: true,
  max_tokens: request.maxOutputTokens ?? 256,
  tools: (request.tools ?? []).map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  })),
  ...(request.toolChoice === undefined
    ? {}
    : {
        tool_choice:
          typeof request.toolChoice === "string"
            ? request.toolChoice
            : { type: "function", function: { name: request.toolChoice.name } },
      }),
});

const safeJevRequest = (request: JevRequest) => ({
  model: JEV_MODEL,
  state: request.state,
  questions: request.questions,
});

const resultFinish = (
  result: MinistralResult | JevResult,
): ProviderAttemptFinish => ({
  outcome: "success",
  provider: result.metadata.provider,
  actualModel: result.metadata.actualModel,
  providerRequestId: result.metadata.providerRequestId,
  generationId: result.metadata.generationId,
  response: result.safeResponse,
  responseBytes: result.metadata.responseBytes,
  inputTokens: result.metadata.usage.inputTokens,
  outputTokens: result.metadata.usage.outputTokens,
  totalTokens: result.metadata.usage.totalTokens,
  costUsd: result.metadata.usage.costUsd,
  errorCode: null,
  errorMessage: null,
  retryCount: 0,
});

const errorFinish = (failure: ProviderError): ProviderAttemptFinish => ({
  outcome:
    failure.code === "credits_exhausted"
      ? "credits_exhausted"
      : failure.code === "timeout"
        ? "timeout"
        : failure.code === "cancelled"
          ? "cancelled"
          : "error",
  provider: "OpenRouter",
  actualModel: null,
  providerRequestId: null,
  generationId: null,
  response: failure.safeResponse,
  responseBytes: failure.responseBytes,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  costUsd: null,
  errorCode: failure.code,
  errorMessage: failure.message,
  retryCount: 0,
});

const interruptedFinish: ProviderAttemptFinish = {
  outcome: "interrupted",
  provider: "OpenRouter",
  actualModel: null,
  providerRequestId: null,
  generationId: null,
  response: null,
  responseBytes: null,
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  costUsd: null,
  errorCode: "interrupted",
  errorMessage: "The provider attempt was interrupted before completion.",
  retryCount: 0,
};

const audit = <A extends MinistralResult | JevResult>(
  context: AuditedProviderContext,
  start: Omit<ProviderAttemptStart, "identity" | "generation" | "requestId" | "turnId">,
  effect: Effect.Effect<A, ProviderError>,
) =>
  Effect.gen(function* () {
    const attempt = yield* context.repository.startProviderAttempt({
      ...start,
      identity: context.identity,
      generation: context.generation,
      requestId: context.requestId,
      turnId: context.turnId,
    });
    let finish: ProviderAttemptFinish | null = null;
    const observed = effect.pipe(
      Effect.tap((result) => Effect.sync(() => { finish = resultFinish(result); })),
      Effect.tapError((failure) => Effect.sync(() => { finish = errorFinish(failure); })),
    );
    return yield* observed.pipe(
      Effect.onExit(() =>
        Effect.uninterruptible(
          context.repository
            .finishProviderAttempt(
              context.identity,
              attempt.id,
              finish ?? interruptedFinish,
            )
            .pipe(
              Effect.flatMap((record) =>
                context.notify === undefined
                  ? Effect.void
                  : context.notify(record.userId, record),
              ),
            ),
        ),
      ),
    );
  });

export const runAuditedMinistral = (
  context: AuditedProviderContext,
  adapter: MinistralAdapter,
  request: MinistralRequest,
): Effect.Effect<MinistralResult, ProviderError> => {
  const body = safeMinistralRequest(request);
  return audit(
    context,
    {
      kind: "chat",
      provider: "OpenRouter",
      model: MINISTRAL_MODEL,
      request: body,
      requestBytes: jsonBytes(body),
    },
    adapter.complete(request),
  );
};

export const runAuditedJev = (
  context: AuditedProviderContext,
  adapter: JevAdapter,
  request: JevRequest,
): Effect.Effect<JevResult, ProviderError> => {
  const body = safeJevRequest(request);
  return audit(
    context,
    {
      kind: "decisions",
      provider: "OpenRouter",
      model: JEV_MODEL,
      request: body,
      requestBytes: jsonBytes(body),
    },
    adapter.decide(request),
  );
};

export const unknownMetadata = (
  requestedModel: string,
  requestBytes: number,
): ProviderMetadata => ({
  provider: null,
  requestedModel,
  actualModel: null,
  providerRequestId: null,
  generationId: null,
  requestBytes,
  responseBytes: 0,
  usage: {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
  },
});
