import { ProviderError, type FetchLike, type ProviderErrorCode } from "./contracts.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

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
  } = {},
) =>
  new ProviderError({
    code,
    message,
    status: options.status ?? null,
    billableUnknown: options.billableUnknown ?? false,
    safeResponse: options.safeResponse ?? null,
    responseBytes: options.responseBytes ?? null,
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
  typeof value === "string" ? value.slice(0, maximum) : null;

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
      size += item.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw error("response_too_large", "The provider response exceeded the configured byte limit.", {
          status: response.status,
          billableUnknown: response.ok,
        });
      }
      chunks.push(item.value);
    }
  } finally {
    reader.releaseLock();
  }
  const joined = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
};

const statusCode = (status: number): ProviderErrorCode => {
  if (status === 402) return "credits_exhausted";
  if (status === 429) return "rate_limited";
  return "provider_error";
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
    });
  }
  return { response, bytes };
};

export const providerFailure = error;
