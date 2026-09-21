import { ProviderError, type FetchLike, type ProviderErrorCode } from "./contracts.js";
import { redactProviderString } from "./redaction.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export class ProviderBodyReadError extends Error {
  readonly name = "ProviderBodyReadError";

  constructor(
    readonly bytes: Uint8Array,
    readonly status: number,
    readonly billableUnknown: boolean,
    readonly generationId: string | null,
  ) {
    super("The provider response body ended before it could be read completely.");
  }
}

const joinChunks = (chunks: ReadonlyArray<Uint8Array>, size: number): Uint8Array => {
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
};

export const jsonBytes = (value: unknown): number => {
  try {
    const encoded = JSON.stringify(value);
    if (encoded === undefined) throw new TypeError("JSON value is undefined.");
    return encoder.encode(encoded).byteLength;
  } catch {
    throw new ProviderError({
      code: "invalid_request",
      message: "The provider request was not valid JSON data.",
      status: null,
      billableUnknown: false,
      safeResponse: null,
      responseBytes: null,
      provider: null,
      actualModel: null,
      providerRequestId: null,
      generationId: null,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      costUsd: null,
    });
  }
};

const error = (
  code: ProviderErrorCode,
  message: string,
  options: {
    readonly status?: number | null;
    readonly billableUnknown?: boolean;
    readonly safeResponse?: unknown;
    readonly responseBytes?: number | null;
    readonly provider?: string | null;
    readonly actualModel?: string | null;
    readonly providerRequestId?: string | null;
    readonly generationId?: string | null;
    readonly inputTokens?: number | null;
    readonly outputTokens?: number | null;
    readonly totalTokens?: number | null;
    readonly costUsd?: number | null;
  } = {},
) =>
  new ProviderError({
    code,
    message,
    status: options.status ?? null,
    billableUnknown: options.billableUnknown ?? false,
    safeResponse: options.safeResponse ?? null,
    responseBytes: options.responseBytes ?? null,
    provider: options.provider ?? null,
    actualModel: options.actualModel ?? null,
    providerRequestId: options.providerRequestId ?? null,
    generationId: options.generationId ?? null,
    inputTokens: options.inputTokens ?? null,
    outputTokens: options.outputTokens ?? null,
    totalTokens: options.totalTokens ?? null,
    costUsd: options.costUsd ?? null,
  });

export const invalidRequest = (message: string): ProviderError =>
  error("invalid_request", message);

export const malformedResponse = (
  message: string,
  safeResponse: unknown = null,
): ProviderError =>
  error("malformed_response", message, {
    billableUnknown: true,
    safeResponse,
  });

const text = (value: unknown, maximum = 512): string | null =>
  typeof value === "string" ? redactProviderString(value, maximum) : null;

const integer = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) ? value : null;

export const safeProviderError = (value: unknown): unknown => {
  if (typeof value !== "object" || value === null) return null;
  const source = value as Record<string, unknown>;
  const candidate =
    typeof source.error === "object" && source.error !== null
      ? (source.error as Record<string, unknown>)
      : source;
  const metadata =
    typeof candidate.metadata === "object" && candidate.metadata !== null
      ? (candidate.metadata as Record<string, unknown>)
      : null;
  return {
    code: text(candidate.code, 128) ?? integer(candidate.code),
    message: text(candidate.message),
    metadata:
      metadata === null
        ? null
        : {
            reason: text(metadata.reason, 128),
            limitSource: text(metadata.limit_source, 128),
          },
  };
};

export const parseJson = (bytes: Uint8Array): unknown => {
  try {
    return JSON.parse(decoder.decode(bytes));
  } catch {
    throw malformedResponse("The provider returned invalid JSON.");
  }
};

export const readBoundedBody = async (
  response: Response,
  maximumBytes: number,
): Promise<Uint8Array> => {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    if (response.body !== null) {
      try {
        await response.body.cancel();
      } catch {
        // The response is rejected regardless of cancellation support.
      }
    }
    throw error("response_too_large", "The provider response exceeded the configured byte limit.", {
      status: response.status,
      billableUnknown: response.ok,
    });
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      const nextSize = size + item.value.byteLength;
      if (nextSize > maximumBytes) {
        throw error("response_too_large", "The provider response exceeded the configured byte limit.", {
          status: response.status,
          billableUnknown: response.ok,
        });
      }
      size = nextSize;
      chunks.push(item.value);
    }
  } catch (cause) {
    try {
      await reader.cancel(cause);
    } catch {
      // Preserve the original read or validation failure.
    }
    if (cause instanceof ProviderError) throw cause;
    throw new ProviderBodyReadError(
      joinChunks(chunks, size),
      response.status,
      response.ok,
      text(response.headers.get("x-generation-id"), 256),
    );
  } finally {
    reader.releaseLock();
  }
  return joinChunks(chunks, size);
};

const statusCode = (status: number): ProviderErrorCode => {
  if (status === 402) return "credits_exhausted";
  if (status === 429) return "rate_limited";
  return "provider_error";
};

export const providerBodyReadFailure = (
  failure: ProviderBodyReadError,
  evidence: {
    readonly safeResponse?: unknown;
    readonly provider?: string | null;
    readonly actualModel?: string | null;
    readonly providerRequestId?: string | null;
    readonly generationId?: string | null;
    readonly inputTokens?: number | null;
    readonly outputTokens?: number | null;
    readonly totalTokens?: number | null;
    readonly costUsd?: number | null;
  } = {},
): ProviderError => {
  const httpFailed = failure.status < 200 || failure.status >= 300;
  return error(
    httpFailed ? statusCode(failure.status) : "transport_error",
    httpFailed
      ? `The provider returned HTTP ${failure.status} before its response body completed.`
      : "The provider response body ended before it could be read completely.",
    {
      status: failure.status,
      billableUnknown:
        evidence.costUsd === undefined || evidence.costUsd === null
          ? failure.billableUnknown
          : false,
      safeResponse: evidence.safeResponse ?? null,
      responseBytes: failure.bytes.byteLength,
      provider: evidence.provider ?? null,
      actualModel: evidence.actualModel ?? null,
      providerRequestId: evidence.providerRequestId ?? null,
      generationId: evidence.generationId ?? failure.generationId,
      inputTokens: evidence.inputTokens ?? null,
      outputTokens: evidence.outputTokens ?? null,
      totalTokens: evidence.totalTokens ?? null,
      costUsd: evidence.costUsd ?? null,
    },
  );
};

export const fetchOpenRouter = async (
  fetcher: FetchLike,
  url: string,
  apiKey: string,
  body: string,
  maximumResponseBytes: number,
  signal: AbortSignal,
): Promise<{ readonly response: Response; readonly bytes: Uint8Array }> => {
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body,
      signal,
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw error("transport_error", "The provider request failed before a complete response arrived.", {
      billableUnknown: true,
    });
  }
  const bytes = await readBoundedBody(response, maximumResponseBytes);
  if (!response.ok) {
    let parsed: unknown = null;
    try {
      parsed = bytes.byteLength === 0 ? null : parseJson(bytes);
    } catch {
      parsed = null;
    }
    throw error(statusCode(response.status), `The provider returned HTTP ${response.status}.`, {
      status: response.status,
      safeResponse: safeProviderError(parsed),
      responseBytes: bytes.byteLength,
      generationId: text(response.headers.get("x-generation-id"), 256),
    });
  }
  return { response, bytes };
};

export const providerFailure = error;
