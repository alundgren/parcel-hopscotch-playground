import { Effect, Semaphore } from "effect";
import {
  MINISTRAL_MODEL,
  ProviderError,
  providerBounds,
  type ChatToolCall,
  type FetchLike,
  type MinistralAdapter,
  type MinistralRequest,
  type MinistralResult,
  type OpenRouterAdapterConfig,
  type ProviderUsage,
} from "./contracts.js";
import {
  fetchOpenRouter,
  invalidRequest,
  jsonBytes,
  malformedResponse,
  parseJson,
  providerFailure,
  safeProviderError,
} from "./http.js";
import { redactProviderAudit } from "./redaction.js";

interface ChatUsagePayload {
  readonly prompt_tokens?: unknown;
  readonly completion_tokens?: unknown;
  readonly total_tokens?: unknown;
  readonly cost?: unknown;
}

interface AssembledToolCall {
  id: string;
  name: string;
  arguments: string;
}

const integerOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;

const numberOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : null;

const normalizeUsage = (value: unknown): ProviderUsage => {
  if (typeof value !== "object" || value === null) {
    return { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null };
  }
  const usage = value as ChatUsagePayload;
  return {
    inputTokens: integerOrNull(usage.prompt_tokens),
    outputTokens: integerOrNull(usage.completion_tokens),
    totalTokens: integerOrNull(usage.total_tokens),
    costUsd: numberOrNull(usage.cost),
  };
};

export const parseSseData = (bytes: Uint8Array): ReadonlyArray<string> => {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw malformedResponse("The provider stream was not valid UTF-8.");
  }
  const normalized = decoded.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const blocks = normalized.split("\n\n");
  const trailing = blocks.pop() ?? "";
  if (trailing.trim().length > 0) {
    throw malformedResponse("The provider stream ended in a partial SSE event.");
  }
  const events: Array<string> = [];
  for (const block of blocks) {
    const data: Array<string> = [];
    for (const line of block.split("\n")) {
      if (line === "" || line.startsWith(":")) continue;
      const separator = line.indexOf(":");
      const field = separator === -1 ? line : line.slice(0, separator);
      let value = separator === -1 ? "" : line.slice(separator + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") data.push(value);
    }
    if (data.length > 0) events.push(data.join("\n"));
  }
  return events;
};

const validateRequest = (
  request: MinistralRequest,
  maximumContextBytes: number,
): void => {
  if (request.messages.length === 0 || request.messages.length > 32) {
    throw invalidRequest("Chat requests require between 1 and 32 messages.");
  }
  const maxOutputTokens = request.maxOutputTokens ?? 256;
  if (
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > providerBounds.maximumOutputTokens
  ) {
    throw invalidRequest(
      `Chat output is limited to ${providerBounds.maximumOutputTokens} tokens.`,
    );
  }
  const tools = request.tools ?? [];
  if (tools.length > providerBounds.maximumTools) {
    throw invalidRequest(`Chat requests are limited to ${providerBounds.maximumTools} tools.`);
  }
  const names = new Set<string>();
  for (const tool of tools) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name)) {
      throw invalidRequest("Chat tool names must be unique safe identifiers.");
    }
    names.add(tool.name);
  }
  if (
    typeof request.toolChoice === "object" &&
    !names.has(request.toolChoice.name)
  ) {
    throw invalidRequest("The forced chat tool was not declared.");
  }
  const safe = safeRequest(request);
  if (jsonBytes(safe) > maximumContextBytes) {
    throw invalidRequest("The chat request exceeded the configured context byte limit.");
  }
};

const safeRequest = (request: MinistralRequest) => ({
  model: MINISTRAL_MODEL,
  messages: request.messages.map((message) => ({
    role: message.role,
    content: message.content,
    ...(message.toolCallId === undefined
      ? {}
      : { tool_call_id: message.toolCallId }),
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
            : {
                type: "function",
                function: { name: request.toolChoice.name },
              },
      }),
});

const appendString = (
  target: AssembledToolCall,
  field: "id" | "name" | "arguments",
  value: unknown,
) => {
  if (value === undefined) return;
  if (typeof value !== "string") {
    throw malformedResponse(`A streamed tool ${field} fragment was not a string.`);
  }
  target[field] += value;
};

export const parseMinistralStream = (
  bytes: Uint8Array,
  request: MinistralRequest,
  requestBytes: number,
  generationId: string | null,
): MinistralResult => {
  const events = parseSseData(bytes);
  const toolFragments = new Map<number, AssembledToolCall>();
  const content: Array<string> = [];
  let provider: string | null = null;
  let actualModel: string | null = null;
  let providerRequestId: string | null = null;
  let usage: ProviderUsage = {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    costUsd: null,
  };
  let finishReason: string | null = null;
  let sawDone = false;
  let sawUsage = false;

  for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
    const event = events[eventIndex]!;
    if (event === "[DONE]") {
      if (eventIndex !== events.length - 1) {
        throw malformedResponse("The provider sent data after the terminal SSE marker.");
      }
      sawDone = true;
      continue;
    }
    const value = parseJson(new TextEncoder().encode(event));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw malformedResponse("A provider stream event was not an object.");
    }
    const chunk = value as Record<string, unknown>;
    if (chunk.error !== undefined) {
      throw providerFailure(
        "provider_error",
        "The provider returned an error inside the stream.",
        { billableUnknown: true, safeResponse: safeProviderError(chunk) },
      );
    }
    if (chunk.provider !== undefined) {
      if (typeof chunk.provider !== "string") {
        throw malformedResponse("The provider name was malformed.");
      }
      provider = provider ?? chunk.provider;
      if (provider !== chunk.provider) {
        throw malformedResponse("The provider changed during one chat stream.");
      }
    }
    if (chunk.model !== undefined) {
      if (typeof chunk.model !== "string") {
        throw malformedResponse("The returned model identifier was malformed.");
      }
      actualModel = actualModel ?? chunk.model;
      if (actualModel !== chunk.model) {
        throw malformedResponse("The model changed during one chat stream.");
      }
    }
    if (chunk.id !== undefined) {
      if (typeof chunk.id !== "string") {
        throw malformedResponse("The provider request identifier was malformed.");
      }
      providerRequestId = providerRequestId ?? chunk.id;
      if (providerRequestId !== chunk.id) {
        throw malformedResponse("The request identifier changed during one chat stream.");
      }
    }
    if (chunk.usage !== undefined) {
      usage = normalizeUsage(chunk.usage);
      sawUsage = true;
    }
    if (!Array.isArray(chunk.choices) || chunk.choices.length !== 1) {
      throw malformedResponse("A chat stream event must contain one choice.");
    }
    const choice = chunk.choices[0];
    if (typeof choice !== "object" || choice === null) {
      throw malformedResponse("A chat stream choice was malformed.");
    }
    const selected = choice as Record<string, unknown>;
    if (selected.index !== 0) {
      throw malformedResponse("Only the requested chat choice can be streamed.");
    }
    const delta = selected.delta;
    if (typeof delta !== "object" || delta === null || Array.isArray(delta)) {
      throw malformedResponse("A chat stream delta was malformed.");
    }
    const fields = delta as Record<string, unknown>;
    const hasContent = typeof fields.content === "string" && fields.content.length > 0;
    const hasToolFragments = Array.isArray(fields.tool_calls) && fields.tool_calls.length > 0;
    if (fields.content !== undefined && fields.content !== null) {
      if (typeof fields.content !== "string") {
        throw malformedResponse("A chat content fragment was malformed.");
      }
      content.push(fields.content);
    }
    if (fields.tool_calls !== undefined) {
      if (!Array.isArray(fields.tool_calls)) {
        throw malformedResponse("Streamed tool calls were malformed.");
      }
      for (const unknownCall of fields.tool_calls) {
        if (typeof unknownCall !== "object" || unknownCall === null) {
          throw malformedResponse("A streamed tool call was malformed.");
        }
        const call = unknownCall as Record<string, unknown>;
        if (
          !Number.isInteger(call.index) ||
          (call.index as number) < 0 ||
          (call.index as number) >= providerBounds.maximumToolCalls
        ) {
          throw malformedResponse("A streamed tool call index was out of bounds.");
        }
        if (call.type !== undefined && call.type !== "function") {
          throw malformedResponse("Only function tool calls are supported.");
        }
        const index = call.index as number;
        const assembled = toolFragments.get(index) ?? { id: "", name: "", arguments: "" };
        appendString(assembled, "id", call.id);
        if (call.function !== undefined) {
          if (typeof call.function !== "object" || call.function === null) {
            throw malformedResponse("A streamed tool function was malformed.");
          }
          const fn = call.function as Record<string, unknown>;
          appendString(assembled, "name", fn.name);
          appendString(assembled, "arguments", fn.arguments);
        }
        toolFragments.set(index, assembled);
      }
    }
    if (selected.finish_reason !== undefined && selected.finish_reason !== null) {
      if (typeof selected.finish_reason !== "string") {
        throw malformedResponse("The chat finish reason was malformed.");
      }
      if (finishReason === null) finishReason = selected.finish_reason;
      else if (
        finishReason !== selected.finish_reason ||
        !sawUsage ||
        hasContent ||
        hasToolFragments
      ) {
        throw malformedResponse("The chat stream had conflicting terminal events.");
      }
    }
  }

  if (!sawDone) throw malformedResponse("The provider stream did not include [DONE].");
  if (finishReason === null) {
    throw malformedResponse("The provider stream did not include a finish reason.");
  }
  if (finishReason === "length") {
    throw providerFailure(
      "incomplete_response",
      "The provider stopped because the output limit was reached.",
      { billableUnknown: !sawUsage },
    );
  }
  if (finishReason === "error") {
    throw providerFailure(
      "provider_error",
      "The provider ended the chat with an error.",
      { billableUnknown: !sawUsage },
    );
  }
  if (finishReason === "cancelled") {
    throw providerFailure(
      "cancelled",
      "The provider reported that the chat was cancelled.",
      { billableUnknown: !sawUsage },
    );
  }
  const toolsByName = new Map((request.tools ?? []).map((tool) => [tool.name, tool]));
  const toolCalls: Array<ChatToolCall> = [];
  for (const [index, assembled] of [...toolFragments.entries()].sort((a, b) => a[0] - b[0])) {
    if (assembled.id.length === 0 || assembled.name.length === 0 || assembled.arguments.length === 0) {
      throw malformedResponse(`Tool call ${index} was incomplete.`);
    }
    const declared = toolsByName.get(assembled.name);
    if (declared === undefined) {
      throw malformedResponse(`The provider requested undeclared tool ${assembled.name}.`);
    }
    let args: unknown;
    try {
      args = JSON.parse(assembled.arguments);
    } catch {
      throw malformedResponse(`Tool call ${assembled.name} had malformed JSON arguments.`);
    }
    if (!declared.validateArguments(args)) {
      throw malformedResponse(`Tool call ${assembled.name} did not match its declared input.`);
    }
    toolCalls.push({ id: assembled.id, name: assembled.name, arguments: args });
  }
  const joinedContent = content.join("");
  if (joinedContent.length === 0 && toolCalls.length === 0) {
    throw providerFailure("incomplete_response", "The provider returned no chat output.", {
      billableUnknown: !sawUsage,
    });
  }
  if (finishReason === "tool_calls" && toolCalls.length === 0) {
    throw malformedResponse("The provider reported tool calls without a complete call.");
  }

  const requestPayload = safeRequest(request);
  return {
    kind: "chat",
    content: joinedContent,
    toolCalls,
    finishReason,
    metadata: {
      provider,
      requestedModel: MINISTRAL_MODEL,
      actualModel,
      providerRequestId,
      generationId,
      requestBytes,
      responseBytes: bytes.byteLength,
      usage,
    },
    safeRequest: redactProviderAudit(requestPayload),
    safeResponse: redactProviderAudit({
      provider,
      model: actualModel,
      providerRequestId,
      generationId,
      content: joinedContent,
      toolCalls,
      finishReason,
      usage,
    }),
  };
};

export const makeMinistralAdapter = (
  config: OpenRouterAdapterConfig,
  fetcher: FetchLike = fetch,
): MinistralAdapter => {
  const bounded = (value: number | undefined, fallback: number, maximum: number) => {
    const candidate = value === undefined || !Number.isFinite(value) ? fallback : value;
    return Math.max(1, Math.min(maximum, Math.floor(candidate)));
  };
  const timeoutMs = bounded(config.timeoutMs, providerBounds.timeoutMs, 60_000);
  const maximumContextBytes = bounded(
    config.maximumContextBytes,
    providerBounds.maximumContextBytes,
    64 * 1024,
  );
  const maximumResponseBytes = bounded(
    config.maximumResponseBytes,
    providerBounds.maximumResponseBytes,
    512 * 1024,
  );
  const semaphore = Semaphore.makeUnsafe(
    bounded(config.maximumConcurrency, providerBounds.maximumConcurrency, 4),
  );
  const baseUrl = config.baseUrl ?? "https://openrouter.ai";

  return {
    complete: (request) => {
      const run = Effect.tryPromise({
        try: async (signal) => {
          if (config.apiKey.trim().length === 0) {
            throw providerFailure(
              "configuration",
              "OPENROUTER_API_KEY is required for live provider requests.",
            );
          }
          validateRequest(request, maximumContextBytes);
          const payload = safeRequest(request);
          const body = JSON.stringify(payload);
          const result = await fetchOpenRouter(
            fetcher,
            `${baseUrl}/api/v1/chat/completions`,
            config.apiKey,
            body,
            maximumResponseBytes,
            signal,
          );
          try {
            return parseMinistralStream(
              result.bytes,
              request,
              new TextEncoder().encode(body).byteLength,
              result.response.headers.get("x-generation-id"),
            );
          } catch (cause) {
            if (cause instanceof ProviderError && cause.responseBytes === null) {
              throw new ProviderError({
                code: cause.code,
                message: cause.message,
                status: cause.status,
                billableUnknown: cause.billableUnknown,
                safeResponse: cause.safeResponse,
                responseBytes: result.bytes.byteLength,
              });
            }
            throw cause;
          }
        },
        catch: (cause) =>
          cause instanceof ProviderError
            ? cause
            : providerFailure(
                "transport_error",
                "The provider request did not complete.",
                { billableUnknown: true },
              ),
      }).pipe(
        Effect.timeout(timeoutMs),
        Effect.mapError((cause) =>
          cause instanceof ProviderError
            ? cause
            : providerFailure("timeout", "The provider request timed out.", {
                billableUnknown: true,
              }),
        ),
      );
      return semaphore.withPermit(run);
    },
  };
};
