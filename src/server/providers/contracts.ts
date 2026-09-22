import { Schema } from "effect";

export const MINISTRAL_MODEL = "mistralai/ministral-3b-2512";
export const JEV_MODEL = "typesafe/jev-1.13";

export const providerBounds = {
  maximumContextBytes: 32 * 1024,
  maximumResponseBytes: 256 * 1024,
  maximumOutputTokens: 4_096,
  maximumTools: 16,
  maximumToolCalls: 16,
  maximumQuestions: 16,
  timeoutMs: 20_000,
  maximumConcurrency: 2,
} as const;

// Streaming includes an SSE envelope per fragment, beyond the generated text.
export const chatBounds = {
  maximumResponseBytes: 2 * 1024 * 1024,
  timeoutMs: 120_000,
} as const;

export type ProviderErrorCode =
  | "configuration"
  | "invalid_request"
  | "credits_exhausted"
  | "rate_limited"
  | "timeout"
  | "cancelled"
  | "transport_error"
  | "provider_error"
  | "response_too_large"
  | "malformed_response"
  | "incomplete_response";

export class ProviderError extends Schema.TaggedError<ProviderError>()(
  "ProviderError",
  {
    code: Schema.String,
    message: Schema.String,
    status: Schema.NullOr(Schema.Int),
    billableUnknown: Schema.Boolean,
    safeResponse: Schema.NullOr(Schema.Unknown),
    responseBytes: Schema.NullOr(Schema.Int),
    provider: Schema.NullOr(Schema.String),
    actualModel: Schema.NullOr(Schema.String),
    providerRequestId: Schema.NullOr(Schema.String),
    generationId: Schema.NullOr(Schema.String),
    inputTokens: Schema.NullOr(Schema.Int),
    outputTokens: Schema.NullOr(Schema.Int),
    totalTokens: Schema.NullOr(Schema.Int),
    costUsd: Schema.NullOr(Schema.Number),
  },
) {
  declare readonly code: ProviderErrorCode;
}

export interface ProviderUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly costUsd: number | null;
}

export interface ProviderMetadata {
  readonly provider: string | null;
  readonly requestedModel: string;
  readonly actualModel: string | null;
  readonly providerRequestId: string | null;
  readonly generationId: string | null;
  readonly requestBytes: number;
  readonly responseBytes: number;
  readonly usage: ProviderUsage;
}

export interface AssistantToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export type ChatMessage =
  | { readonly role: "system" | "user"; readonly content: string }
  | {
      readonly role: "assistant";
      readonly content: string | null;
      readonly toolCalls?: ReadonlyArray<AssistantToolCall>;
    }
  | {
      readonly role: "tool";
      readonly content: string;
      readonly toolCallId: string;
    };

export interface ChatTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly validateArguments: (value: unknown) => boolean;
}

export interface MinistralRequest {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly tools?: ReadonlyArray<ChatTool>;
  readonly toolChoice?: "auto" | "required" | { readonly name: string };
  readonly maxOutputTokens?: number;
}

export interface ChatToolCall {
  readonly id: string;
  readonly name: string;
  readonly arguments: unknown;
}

export interface MinistralResult {
  readonly kind: "chat";
  readonly content: string;
  readonly toolCalls: ReadonlyArray<ChatToolCall>;
  readonly finishReason: string;
  readonly metadata: ProviderMetadata;
  readonly safeRequest: unknown;
  readonly safeResponse: unknown;
}

export interface NoulQuestion {
  readonly type: "noul";
  readonly instructions: unknown;
}

export interface ChoiceQuestion {
  readonly type: "choice";
  readonly instructions: unknown;
  readonly criteria: Readonly<Record<string, string>>;
}

export interface ScoreQuestion {
  readonly type: "score";
  readonly instructions: unknown;
  readonly criteria: ReadonlyArray<unknown>;
}

export type DecisionQuestion = NoulQuestion | ChoiceQuestion | ScoreQuestion;

export interface JevRequest {
  readonly state: unknown;
  readonly questions: Readonly<Record<string, DecisionQuestion>>;
}

export type DecisionAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
    }
  | {
      readonly type: "score";
      readonly score: number;
      readonly confidence: number;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly legend: Readonly<Record<string, unknown>>;
    };

export interface JevResult {
  readonly kind: "decisions";
  readonly answers: Readonly<Record<string, DecisionAnswer>>;
  readonly metadata: ProviderMetadata;
  readonly safeRequest: unknown;
  readonly safeResponse: unknown;
}

export interface OpenRouterAdapterConfig {
  readonly apiKey: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly maximumContextBytes?: number;
  readonly maximumResponseBytes?: number;
  readonly maximumConcurrency?: number;
}

export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface MinistralAdapter {
  readonly complete: (
    request: MinistralRequest,
  ) => import("effect").Effect.Effect<MinistralResult, ProviderError>;
}

export interface JevAdapter {
  readonly decide: (
    request: JevRequest,
  ) => import("effect").Effect.Effect<JevResult, ProviderError>;
}
