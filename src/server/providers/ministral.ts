import { Effect, Semaphore } from "effect";
import { buildMinistralWireRequest, isValidToolCallId } from "./chat-request.js";
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
  ProviderBodyReadError,
  providerFailure,
  safeProviderError,
} from "./http.js";
import { redactProviderAudit, redactProviderString } from "./redaction.js";

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

const emptyUsage = (): ProviderUsage => ({ inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null });
const integerOrNull = (value: unknown): number | null => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
const numberOrNull = (value: unknown): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;

const normalizeUsage = (value: unknown): ProviderUsage => {
  if (typeof value !== "object" || value === null) return emptyUsage();
  const usage = value as ChatUsagePayload;
  return {
    inputTokens: integerOrNull(usage.prompt_tokens),
    outputTokens: integerOrNull(usage.completion_tokens),
    totalTokens: integerOrNull(usage.total_tokens),
    costUsd: numberOrNull(usage.cost),
  };
};

const splitSseData = (bytes: Uint8Array): {
  readonly events: ReadonlyArray<string>;
  readonly terminalError: string | null;
} => {
  const normalized: Array<number> = [];
  for (let index = 0; index < bytes.byteLength; index += 1) {
    const byte = bytes[index]!;
    if (byte === 13) {
      if (bytes[index + 1] === 10) index += 1;
      normalized.push(10);
    } else {
      normalized.push(byte);
    }
  }
  const source = Uint8Array.from(normalized);
  const events: Array<string> = [];
  let blockStart = 0;
  let terminalError: string | null = null;
  const readBlock = (blockBytes: Uint8Array): boolean => {
    let block: string;
    try {
      block = new TextDecoder("utf-8", { fatal: true }).decode(blockBytes);
    } catch {
      terminalError = "The provider stream was not valid UTF-8.";
      return false;
    }
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
    return true;
  };
  for (let index = 0; index < source.byteLength - 1; index += 1) {
    if (source[index] !== 10 || source[index + 1] !== 10) continue;
    if (!readBlock(source.slice(blockStart, index))) break;
    blockStart = index + 2;
    index += 1;
  }
  if (terminalError === null) {
    const trailing = source.slice(blockStart);
    if (trailing.byteLength > 0) {
      let decodedTrailing: string;
      try {
        decodedTrailing = new TextDecoder("utf-8", { fatal: true }).decode(trailing);
      } catch {
        decodedTrailing = "";
        terminalError = "The provider stream was not valid UTF-8.";
      }
      if (terminalError === null && decodedTrailing.trim().length > 0) {
        terminalError = "The provider stream ended in a partial SSE event.";
      }
    }
  }
  return { events, terminalError };
};

export const parseSseData = (bytes: Uint8Array): ReadonlyArray<string> => {
  const parsed = splitSseData(bytes);
  if (parsed.terminalError !== null) throw malformedResponse(parsed.terminalError);
  return parsed.events;
};

const validateRequest = (request: MinistralRequest, maximumContextBytes: number): void => {
  if (request.messages.length === 0 || request.messages.length > 32) throw invalidRequest("Chat requests require between 1 and 32 messages.");
  const maxOutputTokens = request.maxOutputTokens ?? 256;
  if (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1 || maxOutputTokens > providerBounds.maximumOutputTokens) {
    throw invalidRequest(`Chat output is limited to ${providerBounds.maximumOutputTokens} tokens.`);
  }
  const tools = request.tools ?? [];
  if (tools.length > providerBounds.maximumTools) throw invalidRequest(`Chat requests are limited to ${providerBounds.maximumTools} tools.`);
  const names = new Set<string>();
  for (const tool of tools) {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(tool.name) || names.has(tool.name)) throw invalidRequest("Chat tool names must be unique safe identifiers.");
    names.add(tool.name);
  }
  if (typeof request.toolChoice === "object" && !names.has(request.toolChoice.name)) throw invalidRequest("The forced chat tool was not declared.");
  if (jsonBytes(buildMinistralWireRequest(request)) > maximumContextBytes) throw invalidRequest("The chat request exceeded the configured context byte limit.");
};

const appendString = (target: AssembledToolCall, field: "id" | "name" | "arguments", value: unknown) => {
  if (value === undefined) return;
  if (typeof value !== "string") throw malformedResponse(`A streamed tool ${field} fragment was not a string.`);
  target[field] += value;
};

const safeIdentifier = (value: string | null): string | null => value === null ? null : redactProviderString(value, 256);

const enrichFailure = (
  failure: ProviderError,
  evidence: {
    readonly provider: string | null;
    readonly actualModel: string | null;
    readonly providerRequestId: string | null;
    readonly generationId: string | null;
    readonly usage: ProviderUsage;
    readonly responseBytes: number;
    readonly partial: unknown;
  },
): ProviderError => new ProviderError({
  code: failure.code,
  message: redactProviderString(failure.message, 1_024),
  status: failure.status,
  billableUnknown: evidence.usage.costUsd === null ? failure.billableUnknown : false,
  safeResponse: failure.safeResponse === null ? redactProviderAudit(evidence.partial) : redactProviderAudit(failure.safeResponse),
  responseBytes: failure.responseBytes ?? evidence.responseBytes,
  provider: failure.provider ?? safeIdentifier(evidence.provider),
  actualModel: failure.actualModel ?? safeIdentifier(evidence.actualModel),
  providerRequestId: failure.providerRequestId ?? safeIdentifier(evidence.providerRequestId),
  generationId: failure.generationId ?? safeIdentifier(evidence.generationId),
  inputTokens: failure.inputTokens ?? evidence.usage.inputTokens,
  outputTokens: failure.outputTokens ?? evidence.usage.outputTokens,
  totalTokens: failure.totalTokens ?? evidence.usage.totalTokens,
  costUsd: failure.costUsd ?? evidence.usage.costUsd,
});

export const parseMinistralStream = (
  bytes: Uint8Array,
  request: MinistralRequest,
  requestBytes: number,
  generationId: string | null,
): MinistralResult => {
  const toolFragments = new Map<number, AssembledToolCall>();
  const content: Array<string> = [];
  let provider: string | null = null;
  let actualModel: string | null = null;
  let providerRequestId: string | null = null;
  let usage = emptyUsage();
  let finishReason: string | null = null;
  let sawDone = false;
  let sawUsage = false;
  let sawAccountingFrame = false;

  try {
    const parsed = splitSseData(bytes);
    const events = parsed.events;
    for (let eventIndex = 0; eventIndex < events.length; eventIndex += 1) {
      const event = events[eventIndex]!;
      if (event === "[DONE]") {
        if (eventIndex !== events.length - 1) throw malformedResponse("The provider sent data after the terminal SSE marker.");
        sawDone = true;
        continue;
      }
      const value = parseJson(new TextEncoder().encode(event));
      if (typeof value !== "object" || value === null || Array.isArray(value)) throw malformedResponse("A provider stream event was not an object.");
      const chunk = value as Record<string, unknown>;
      const readStableField = (key: "provider" | "model" | "id", current: string | null): string | null => {
        const field = chunk[key];
        if (field === undefined) return current;
        if (typeof field !== "string") throw malformedResponse(`The returned ${key} was malformed.`);
        if (current !== null && current !== field) throw malformedResponse(`The returned ${key} changed during one chat stream.`);
        return field;
      };
      provider = readStableField("provider", provider);
      actualModel = readStableField("model", actualModel);
      providerRequestId = readStableField("id", providerRequestId);
      if (chunk.usage !== undefined) {
        usage = normalizeUsage(chunk.usage);
        sawUsage = true;
      }
      if (chunk.error !== undefined) {
        throw providerFailure("provider_error", "The provider returned an error inside the stream.", { billableUnknown: usage.costUsd === null, safeResponse: safeProviderError(chunk) });
      }

      if (!Array.isArray(chunk.choices) || chunk.choices.length !== 1) throw malformedResponse("A chat stream event must contain one choice.");
      const choice = chunk.choices[0];
      if (typeof choice !== "object" || choice === null || Array.isArray(choice)) throw malformedResponse("A chat stream choice was malformed.");
      const selected = choice as Record<string, unknown>;
      if (selected.index !== 0) throw malformedResponse("Only the requested chat choice can be streamed.");
      if (selected.error !== undefined) {
        throw providerFailure("provider_error", "The provider returned an error for the streamed choice.", {
          billableUnknown: usage.costUsd === null,
          safeResponse: safeProviderError(selected),
        });
      }
      const delta = selected.delta;
      if (typeof delta !== "object" || delta === null || Array.isArray(delta)) throw malformedResponse("A chat stream delta was malformed.");
      const fields = delta as Record<string, unknown>;
      if (fields.content !== undefined && fields.content !== null && typeof fields.content !== "string") throw malformedResponse("A chat content fragment was malformed.");
      if (fields.tool_calls !== undefined && !Array.isArray(fields.tool_calls)) throw malformedResponse("Streamed tool calls were malformed.");
      const contentFragment = typeof fields.content === "string" ? fields.content : "";
      const streamedCalls = Array.isArray(fields.tool_calls) ? fields.tool_calls : [];
      const finish = selected.finish_reason;
      if (finish !== undefined && finish !== null && typeof finish !== "string") throw malformedResponse("The chat finish reason was malformed.");

      if (finishReason !== null) {
        const allowedDelta =
          Object.keys(fields).every((key) => key === "content" || key === "role") &&
          contentFragment.length === 0 &&
          (fields.role === undefined || fields.role === "assistant");
        if (sawAccountingFrame || finish !== finishReason || chunk.usage === undefined || !allowedDelta || streamedCalls.length > 0) {
          throw malformedResponse("The chat stream contained data after its terminal result.");
        }
        sawAccountingFrame = true;
        continue;
      }

      if (contentFragment.length > 0) content.push(contentFragment);
      for (const unknownCall of streamedCalls) {
        if (typeof unknownCall !== "object" || unknownCall === null || Array.isArray(unknownCall)) throw malformedResponse("A streamed tool call was malformed.");
        const call = unknownCall as Record<string, unknown>;
        if (!Number.isInteger(call.index) || (call.index as number) < 0 || (call.index as number) >= providerBounds.maximumToolCalls) throw malformedResponse("A streamed tool call index was out of bounds.");
        if (call.type !== undefined && call.type !== "function") throw malformedResponse("Only function tool calls are supported.");
        const index = call.index as number;
        const assembled = toolFragments.get(index) ?? { id: "", name: "", arguments: "" };
        appendString(assembled, "id", call.id);
        if (call.function !== undefined) {
          if (typeof call.function !== "object" || call.function === null || Array.isArray(call.function)) throw malformedResponse("A streamed tool function was malformed.");
          const fn = call.function as Record<string, unknown>;
          appendString(assembled, "name", fn.name);
          appendString(assembled, "arguments", fn.arguments);
        }
        toolFragments.set(index, assembled);
      }
      if (typeof finish === "string") finishReason = finish;
    }

    if (parsed.terminalError !== null) throw malformedResponse(parsed.terminalError);

    if (!sawDone) throw malformedResponse("The provider stream did not include [DONE].");
    if (finishReason === null) throw malformedResponse("The provider stream did not include a finish reason.");
    if (finishReason === "length") throw providerFailure("incomplete_response", "The provider stopped because the output limit was reached.", { billableUnknown: !sawUsage });
    if (finishReason === "error") throw providerFailure("provider_error", "The provider ended the chat with an error.", { billableUnknown: !sawUsage });
    if (finishReason === "cancelled") throw providerFailure("cancelled", "The provider reported that the chat was cancelled.", { billableUnknown: !sawUsage });
    if (finishReason !== "stop" && finishReason !== "tool_calls") throw malformedResponse("The provider returned an unsupported chat finish reason.");

    const toolsByName = new Map((request.tools ?? []).map((tool) => [tool.name, tool]));
    const toolCalls: Array<ChatToolCall> = [];
    const callIds = new Set<string>();
    for (const [index, assembled] of [...toolFragments.entries()].sort((a, b) => a[0] - b[0])) {
      if (assembled.id.length === 0 || assembled.name.length === 0 || assembled.arguments.length === 0) throw malformedResponse(`Tool call ${index} was incomplete.`);
      if (!isValidToolCallId(assembled.id)) throw malformedResponse("The provider returned an invalid tool call identifier.");
      if (callIds.has(assembled.id)) throw malformedResponse("The provider returned duplicate tool call identifiers.");
      callIds.add(assembled.id);
      const declared = toolsByName.get(assembled.name);
      if (declared === undefined) throw malformedResponse("The provider requested an undeclared tool.");
      let args: unknown;
      try {
        args = JSON.parse(assembled.arguments);
      } catch {
        throw malformedResponse(`Tool call ${redactProviderString(assembled.name, 64)} had malformed JSON arguments.`);
      }
      if (!declared.validateArguments(args)) throw malformedResponse(`Tool call ${redactProviderString(assembled.name, 64)} did not match its declared input.`);
      toolCalls.push({ id: assembled.id, name: assembled.name, arguments: args });
    }
    if (toolCalls.length > 0 && finishReason !== "tool_calls") throw malformedResponse("The provider returned tool calls without the tool_calls finish reason.");
    if (finishReason === "tool_calls" && toolCalls.length === 0) throw malformedResponse("The provider reported tool calls without a complete call.");
    const joinedContent = content.join("");
    if (joinedContent.length === 0 && toolCalls.length === 0) throw providerFailure("incomplete_response", "The provider returned no chat output.", { billableUnknown: !sawUsage });

    const safeProvider = safeIdentifier(provider);
    const safeModel = safeIdentifier(actualModel);
    const safeRequestId = safeIdentifier(providerRequestId);
    const safeGenerationId = safeIdentifier(generationId);
    const requestPayload = buildMinistralWireRequest(request);
    return {
      kind: "chat",
      content: joinedContent,
      toolCalls,
      finishReason,
      metadata: {
        provider: safeProvider,
        requestedModel: MINISTRAL_MODEL,
        actualModel: safeModel,
        providerRequestId: safeRequestId,
        generationId: safeGenerationId,
        requestBytes,
        responseBytes: bytes.byteLength,
        usage,
      },
      safeRequest: redactProviderAudit(requestPayload),
      safeResponse: redactProviderAudit({ provider: safeProvider, model: safeModel, providerRequestId: safeRequestId, generationId: safeGenerationId, content: joinedContent, toolCalls, finishReason, usage }),
    };
  } catch (cause) {
    const failure = cause instanceof ProviderError ? cause : malformedResponse("The provider stream could not be validated.");
    throw enrichFailure(failure, {
      provider,
      actualModel,
      providerRequestId,
      generationId,
      usage,
      responseBytes: bytes.byteLength,
      partial: {
        provider: safeIdentifier(provider),
        model: safeIdentifier(actualModel),
        providerRequestId: safeIdentifier(providerRequestId),
        generationId: safeIdentifier(generationId),
        content: content.join(""),
        toolCalls: [...toolFragments.values()].map((call) => ({ id: call.id, name: call.name })),
        finishReason,
        usage,
      },
    });
  }
};

export const makeMinistralAdapter = (config: OpenRouterAdapterConfig, fetcher: FetchLike = fetch): MinistralAdapter => {
  const bounded = (value: number | undefined, fallback: number, maximum: number) => {
    const candidate = value === undefined || !Number.isFinite(value) ? fallback : value;
    return Math.max(1, Math.min(maximum, Math.floor(candidate)));
  };
  const timeoutMs = bounded(config.timeoutMs, providerBounds.timeoutMs, 60_000);
  const maximumContextBytes = bounded(config.maximumContextBytes, providerBounds.maximumContextBytes, 64 * 1024);
  const maximumResponseBytes = bounded(config.maximumResponseBytes, providerBounds.maximumResponseBytes, 512 * 1024);
  const semaphore = Semaphore.makeUnsafe(bounded(config.maximumConcurrency, providerBounds.maximumConcurrency, 4));
  const baseUrl = config.baseUrl ?? "https://openrouter.ai";

  return {
    complete: (request) => {
      const run = Effect.tryPromise({
        try: async (signal) => {
          if (config.apiKey.trim().length === 0) throw providerFailure("configuration", "OPENROUTER_API_KEY is required for live provider requests.");
          validateRequest(request, maximumContextBytes);
          const payload = buildMinistralWireRequest(request);
          const body = JSON.stringify(payload);
          const requestBytes = new TextEncoder().encode(body).byteLength;
          let result: Awaited<ReturnType<typeof fetchOpenRouter>>;
          try {
            result = await fetchOpenRouter(fetcher, `${baseUrl}/api/v1/chat/completions`, config.apiKey, body, maximumResponseBytes, signal);
          } catch (cause) {
            if (!(cause instanceof ProviderBodyReadError)) throw cause;
            try {
              return parseMinistralStream(
                cause.bytes,
                request,
                requestBytes,
                cause.generationId,
              );
            } catch (partialCause) {
              if (!(partialCause instanceof ProviderError)) throw cause;
              throw providerFailure(
                "transport_error",
                "The provider response body ended before it could be read completely.",
                {
                  status: cause.status,
                  billableUnknown:
                    partialCause.costUsd === null
                      ? cause.billableUnknown
                      : false,
                  safeResponse: partialCause.safeResponse,
                  responseBytes: cause.bytes.byteLength,
                  provider: partialCause.provider,
                  actualModel: partialCause.actualModel,
                  providerRequestId: partialCause.providerRequestId,
                  generationId: partialCause.generationId ?? cause.generationId,
                  inputTokens: partialCause.inputTokens,
                  outputTokens: partialCause.outputTokens,
                  totalTokens: partialCause.totalTokens,
                  costUsd: partialCause.costUsd,
                },
              );
            }
          }
          return parseMinistralStream(result.bytes, request, requestBytes, result.response.headers.get("x-generation-id"));
        },
        catch: (cause) => cause instanceof ProviderError ? cause : providerFailure("transport_error", "The provider request did not complete.", { billableUnknown: true }),
      });
      return semaphore.withPermit(run).pipe(
        Effect.timeout(timeoutMs),
        Effect.mapError((cause) => cause instanceof ProviderError ? cause : providerFailure("timeout", "The provider request timed out.", { billableUnknown: true })),
      );
    },
  };
};
