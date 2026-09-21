import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ChatTool, FetchLike, JevRequest } from "../../src/server/providers/contracts";
import { buildMinistralWireRequest } from "../../src/server/providers/chat-request";
import { readBoundedBody } from "../../src/server/providers/http";
import { makeJevAdapter, parseJevResponse } from "../../src/server/providers/jev";
import { makeMinistralAdapter, parseMinistralStream } from "../../src/server/providers/ministral";
import { redactProviderAudit } from "../../src/server/providers/redaction";

const encoder = new TextEncoder();
const sse = (...events: ReadonlyArray<unknown | "[DONE]">) =>
  encoder.encode(
    events
      .map((event) => `data: ${event === "[DONE]" ? event : JSON.stringify(event)}\r\n\r\n`)
      .join(""),
  );

const response = (
  bytes: Uint8Array,
  chunks: ReadonlyArray<Uint8Array> = [bytes],
  init: ResponseInit = {},
) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(chunk);
        controller.close();
      },
    }),
    init,
  );

const responseThenError = (bytes: Uint8Array, status = 200) =>
  new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes);
        setTimeout(() => controller.error(new Error("connection lost")), 0);
      },
    }),
    { status, headers: { "x-generation-id": "header-generation" } },
  );

const contentStream = (content = "Done 🪵") =>
  sse(
    {
      id: "gen_chat",
      model: "mistralai/ministral-3b-2512",
      provider: "Mistral",
      choices: [{ index: 0, delta: { role: "assistant", content }, finish_reason: null }],
    },
    {
      id: "gen_chat",
      model: "mistralai/ministral-3b-2512",
      provider: "Mistral",
      choices: [{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: "stop" }],
    },
    {
      id: "gen_chat",
      model: "mistralai/ministral-3b-2512",
      provider: "Mistral",
      choices: [{ index: 0, delta: { content: "", role: "assistant" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
    },
    "[DONE]",
  );

const request = { messages: [{ role: "user" as const, content: "Finish." }] };

describe("Ministral OpenRouter adapter", () => {
  it("accepts every byte split, multibyte content, CRLF, and the documented repeated terminal usage frame", async () => {
    const bytes = contentStream();
    for (let split = 1; split < bytes.byteLength; split += 1) {
      const fetcher: FetchLike = async () =>
        response(bytes, [bytes.slice(0, split), bytes.slice(split)], {
          headers: { "x-generation-id": "header-generation" },
        });
      const result = await Effect.runPromise(
        makeMinistralAdapter({ apiKey: "synthetic-key" }, fetcher).complete(request),
      );
      expect(result.content).toBe("Done 🪵");
      expect(result.metadata).toMatchObject({
        provider: "Mistral",
        actualModel: "mistralai/ministral-3b-2512",
        generationId: "header-generation",
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11, costUsd: null },
      });
    }
  });

  it("assembles interleaved tool calls and validates arguments only after the complete stream", () => {
    const tools: ReadonlyArray<ChatTool> = [
      {
        name: "getOrder",
        description: "Get one order.",
        parameters: { type: "object" },
        validateArguments: (value) =>
          typeof value === "object" && value !== null &&
          Object.keys(value).length === 1 && "orderId" in value,
      },
      {
        name: "findOrders",
        description: "Find orders.",
        parameters: { type: "object" },
        validateArguments: (value) =>
          typeof value === "object" && value !== null &&
          Object.keys(value).length === 1 && "status" in value,
      },
    ];
    const bytes = sse(
      {
        id: "gen_tools", model: "mistralai/ministral-3b-2512", provider: "Mistral",
        choices: [{ index: 0, delta: { tool_calls: [
          { index: 0, id: "call_", type: "function", function: { name: "get", arguments: "{\"order" } },
          { index: 1, id: "call_", type: "function", function: { name: "find", arguments: "{\"sta" } },
        ] }, finish_reason: null }],
      },
      {
        id: "gen_tools", model: "mistralai/ministral-3b-2512", provider: "Mistral",
        choices: [{ index: 0, delta: { tool_calls: [
          { index: 1, id: "2", function: { name: "Orders", arguments: "tus\":\"ready\"}" } },
          { index: 0, id: "1", function: { name: "Order", arguments: "Id\":\"BB-1042\"}" } },
        ] }, finish_reason: null }],
      },
      {
        id: "gen_tools", model: "mistralai/ministral-3b-2512", provider: "Mistral",
        choices: [{ index: 0, delta: { content: "" }, finish_reason: "tool_calls" }],
      },
      "[DONE]",
    );
    const result = parseMinistralStream(bytes, { ...request, tools }, 123, null);
    expect(result.toolCalls).toEqual([
      { id: "call_1", name: "getOrder", arguments: { orderId: "BB-1042" } },
      { id: "call_2", name: "findOrders", arguments: { status: "ready" } },
    ]);
    expect(result.metadata.usage.costUsd).toBeNull();
  });

  it("preserves distinct bounded opaque call IDs even when audit redaction would collide", () => {
    const tools: ReadonlyArray<ChatTool> = [{
      name: "getOrder",
      description: "Get an order.",
      parameters: { type: "object" },
      validateArguments: () => true,
    }];
    const bytes = sse(
      { id: "x", model: "m", choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "first@example.test", type: "function", function: { name: "getOrder", arguments: "{}" } },
        { index: 1, id: "second@example.test", type: "function", function: { name: "getOrder", arguments: "{}" } },
      ] }, finish_reason: "tool_calls" }] },
      "[DONE]",
    );
    const result = parseMinistralStream(bytes, { ...request, tools }, 1, null);
    expect(result.toolCalls.map((call) => call.id)).toEqual(["first@example.test", "second@example.test"]);
    expect(JSON.stringify(result.safeResponse)).not.toContain("first@example.test");
    expect(JSON.stringify(result.safeResponse)).not.toContain("second@example.test");
  });

  it("uses the same 128-character call ID bound for parsing and subsequent history", () => {
    const tools: ReadonlyArray<ChatTool> = [{
      name: "getOrder",
      description: "Get an order.",
      parameters: { type: "object" },
      validateArguments: () => true,
    }];
    const callId = "x".repeat(128);
    const valid = sse(
      { id: "x", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: callId, type: "function", function: { name: "getOrder", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      "[DONE]",
    );
    const parsed = parseMinistralStream(valid, { ...request, tools }, 1, null);
    expect(parsed.toolCalls[0]?.id).toBe(callId);
    expect(() => buildMinistralWireRequest({ messages: [
      ...request.messages,
      { role: "assistant", content: null, toolCalls: parsed.toolCalls },
      { role: "tool", toolCallId: callId, content: "{}" },
    ] })).not.toThrow();

    const oversizedId = "x".repeat(129);
    const invalid = sse(
      { id: "x", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: oversizedId, type: "function", function: { name: "getOrder", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      "[DONE]",
    );
    expect(() => parseMinistralStream(invalid, { ...request, tools }, 1, null)).toThrow(/invalid tool call identifier/i);
    expect(() => buildMinistralWireRequest({ messages: [
      ...request.messages,
      { role: "assistant", content: null, toolCalls: [{ id: oversizedId, name: "getOrder", arguments: {} }] },
      { role: "tool", toolCallId: oversizedId, content: "{}" },
    ] })).toThrow(/invalid metadata/i);
  });

  it.each([
    ["malformed arguments", sse(
      { id: "x", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", type: "function", function: { name: "getOrder", arguments: "{" } }] }, finish_reason: null }] },
      { id: "x", model: "m", choices: [{ index: 0, delta: { content: "" }, finish_reason: "tool_calls" }] },
      "[DONE]",
    )],
    ["length termination", sse(
      { id: "x", model: "m", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "length" }] },
      "[DONE]",
    )],
    ["missing terminal marker", sse(
      { id: "x", model: "m", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "stop" }] },
    ).slice(0, -2)],
  ])("rejects %s without yielding executable tool calls", (_name, bytes) => {
    const tools: ReadonlyArray<ChatTool> = [{
      name: "getOrder",
      description: "Get an order.",
      parameters: { type: "object" },
      validateArguments: () => true,
    }];
    expect(() => parseMinistralStream(bytes, { ...request, tools }, 1, null)).toThrow();
  });

  it.each([
    ["unsupported finish", sse(
      { id: "x", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "getOrder", arguments: "{}" } }] }, finish_reason: "content_filter" }] },
      "[DONE]",
    )],
    ["post-terminal tool fragment", sse(
      { id: "x", model: "m", choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] },
      { id: "x", model: "m", choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "getOrder", arguments: "{}" } }] }, finish_reason: null }] },
      "[DONE]",
    )],
    ["duplicate tool call IDs", sse(
      { id: "x", model: "m", choices: [{ index: 0, delta: { tool_calls: [
        { index: 0, id: "same", type: "function", function: { name: "getOrder", arguments: "{}" } },
        { index: 1, id: "same", type: "function", function: { name: "getOrder", arguments: "{}" } },
      ] }, finish_reason: "tool_calls" }] },
      "[DONE]",
    )],
    ["choice-level error", sse(
      { id: "x", model: "m", choices: [{ index: 0, error: { code: "blocked", message: "No result" }, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "getOrder", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
      "[DONE]",
    )],
  ])("rejects %s before returning calls", (_name, bytes) => {
    const tools: ReadonlyArray<ChatTool> = [{
      name: "getOrder",
      description: "Get an order.",
      parameters: { type: "object" },
      validateArguments: () => true,
    }];
    expect(() => parseMinistralStream(bytes, { ...request, tools }, 1, null)).toThrow();
  });

  it("retains known usage and cost when terminal validation fails", () => {
    const bytes = sse(
      {
        id: "charged", model: "m", provider: "Mistral",
        choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "length" }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, cost: 0.00042 },
      },
      "[DONE]",
    );
    expect(() => parseMinistralStream(bytes, request, 1, "generation")).toThrowError(
      expect.objectContaining({
        code: "incomplete_response",
        billableUnknown: false,
        inputTokens: 9,
        outputTokens: 4,
        totalTokens: 13,
        costUsd: 0.00042,
        providerRequestId: "charged",
      }),
    );
  });

  it("retains complete-frame usage when the following SSE event is truncated", () => {
    const complete = sse({
      id: "charged-before-truncation",
      model: "m",
      provider: "Mistral",
      choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, cost: 0.0042 },
    });
    const partial = encoder.encode("data: [DO");
    const bytes = new Uint8Array(complete.byteLength + partial.byteLength);
    bytes.set(complete);
    bytes.set(partial, complete.byteLength);
    expect(() => parseMinistralStream(bytes, request, 1, "header-generation")).toThrowError(
      expect.objectContaining({
        code: "malformed_response",
        provider: "Mistral",
        actualModel: "m",
        providerRequestId: "charged-before-truncation",
        generationId: "header-generation",
        inputTokens: 9,
        outputTokens: 4,
        totalTokens: 13,
        costUsd: 0.0042,
        billableUnknown: false,
      }),
    );
  });

  it("retains complete-frame usage before an invalid UTF-8 tail", () => {
    const complete = sse({
      id: "charged-before-invalid-utf8",
      model: "m",
      provider: "Mistral",
      choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, cost: 0.0042 },
    });
    const bytes = new Uint8Array(complete.byteLength + 1);
    bytes.set(complete);
    bytes[complete.byteLength] = 0xff;
    expect(() => parseMinistralStream(bytes, request, 1, "header-generation")).toThrowError(
      expect.objectContaining({
        code: "malformed_response",
        providerRequestId: "charged-before-invalid-utf8",
        inputTokens: 9,
        outputTokens: 4,
        totalTokens: 13,
        costUsd: 0.0042,
        billableUnknown: false,
      }),
    );
  });

  it("retains complete-frame usage when a later body read fails", async () => {
    const complete = sse({
      id: "charged-before-read-error",
      model: "m",
      provider: "Mistral",
      choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, cost: 0.0042 },
    });
    const adapter = makeMinistralAdapter({ apiKey: "synthetic-key" }, async () =>
      responseThenError(complete));
    await expect(Effect.runPromise(adapter.complete(request))).rejects.toMatchObject({
      code: "transport_error",
      billableUnknown: false,
      provider: "Mistral",
      actualModel: "m",
      providerRequestId: "charged-before-read-error",
      generationId: "header-generation",
      inputTokens: 9,
      outputTokens: 4,
      totalTokens: 13,
      costUsd: 0.0042,
    });
  });

  it.each([
    [200, "transport_error"],
    [402, "credits_exhausted"],
    [429, "rate_limited"],
    [500, "provider_error"],
  ])("never returns a complete parsed chat after a status %i body read failure", async (status, code) => {
    const tools: ReadonlyArray<ChatTool> = [{
      name: "getOrder",
      description: "Get an order.",
      parameters: { type: "object" },
      validateArguments: () => true,
    }];
    const complete = sse(
      {
        id: "charged-complete",
        model: "m",
        provider: "Mistral",
        choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "call-1", type: "function", function: { name: "getOrder", arguments: "{}" } }] }, finish_reason: "tool_calls" }],
        usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13, cost: 0.0042 },
      },
      "[DONE]",
    );
    const adapter = makeMinistralAdapter({ apiKey: "synthetic-key" }, async () =>
      responseThenError(complete, status));
    await expect(Effect.runPromise(adapter.complete({ ...request, tools }))).rejects.toMatchObject({
      code,
      costUsd: 0.0042,
      providerRequestId: "charged-complete",
    });
  });

  it("serializes an assistant tool-call turn and correlated tool result in the live request", async () => {
    let sent: Record<string, unknown> | null = null;
    const adapter = makeMinistralAdapter({ apiKey: "synthetic-key" }, async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return response(contentStream("next"));
    });
    const history = {
      messages: [
        { role: "user" as const, content: "Find BB-1042." },
        { role: "assistant" as const, content: null, toolCalls: [{ id: "call-1", name: "getOrder", arguments: { orderId: "BB-1042" } }] },
        { role: "tool" as const, toolCallId: "call-1", content: "{\"status\":\"ready\"}" },
        { role: "user" as const, content: "What next?" },
      ],
    };
    await Effect.runPromise(adapter.complete(history));
    expect(sent).toMatchObject({
      messages: [
        { role: "user", content: "Find BB-1042." },
        { role: "assistant", content: null, tool_calls: [{ id: "call-1", type: "function", function: { name: "getOrder", arguments: "{\"orderId\":\"BB-1042\"}" } }] },
        { role: "tool", tool_call_id: "call-1", content: "{\"status\":\"ready\"}" },
        { role: "user", content: "What next?" },
      ],
    });
    expect(buildMinistralWireRequest(history)).toEqual(sent);
  });

  it("expires operations while they wait for a concurrency permit", async () => {
    let fetches = 0;
    const adapter = makeMinistralAdapter(
      { apiKey: "synthetic-key", maximumConcurrency: 1, timeoutMs: 10 },
      (_url, init) => {
        fetches += 1;
        return new Promise((_resolve, reject) => init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }));
      },
    );
    const outcomes = await Effect.runPromise(Effect.all([
      Effect.result(adapter.complete(request)),
      Effect.result(adapter.complete(request)),
    ], { concurrency: 2 }));
    expect(outcomes.every((outcome) => outcome._tag === "Failure")).toBe(true);
    expect(fetches).toBe(1);
  });

  it("rejects a completed stream with no content or tool call", () => {
    const bytes = sse(
      { id: "empty", model: "m", choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }] },
      "[DONE]",
    );
    expect(() => parseMinistralStream(bytes, request, 1, null)).toThrow(/no chat output/i);
  });

  it("reports provider cancellation without executing partial output", () => {
    const bytes = sse(
      { id: "cancelled", model: "m", choices: [{ index: 0, delta: { content: "partial" }, finish_reason: "cancelled" }] },
      "[DONE]",
    );
    expect(() => parseMinistralStream(bytes, request, 1, null)).toThrowError(
      expect.objectContaining({ code: "cancelled", billableUnknown: true }),
    );
  });

  it("treats an HTTP-200 stream error as a failure", async () => {
    const bytes = sse({
      id: "failed",
      error: { code: "provider_error", message: "Disconnected" },
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "error" }],
    });
    const adapter = makeMinistralAdapter(
      { apiKey: "synthetic-key" },
      async () => response(bytes),
    );
    await expect(Effect.runPromise(adapter.complete(request))).rejects.toMatchObject({
      code: "provider_error",
      billableUnknown: true,
    });
  });

  it("stops on exhausted credits without retrying", async () => {
    const fetcher = vi.fn(async () =>
      new Response(JSON.stringify({ error: { code: 402, message: "Insufficient credits" } }), {
        status: 402,
      }));
    const adapter = makeMinistralAdapter({ apiKey: "synthetic-key" }, fetcher);
    await expect(Effect.runPromise(adapter.complete(request))).rejects.toMatchObject({
      code: "credits_exhausted",
      billableUnknown: false,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps billing unknown after an ambiguous transport failure and does not retry", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("connection dropped");
    });
    const adapter = makeMinistralAdapter({ apiKey: "synthetic-key" }, fetcher);
    await expect(Effect.runPromise(adapter.complete(request))).rejects.toMatchObject({
      code: "transport_error",
      billableUnknown: true,
      responseBytes: null,
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("aborts a stalled transport when the request times out", async () => {
    let aborted = false;
    const fetcher: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("Aborted", "AbortError"));
        }, { once: true });
      });
    const adapter = makeMinistralAdapter(
      { apiKey: "synthetic-key", timeoutMs: 5 },
      fetcher,
    );
    await expect(Effect.runPromise(adapter.complete(request))).rejects.toMatchObject({ code: "timeout" });
    expect(aborted).toBe(true);
  });

  it("bounds concurrent live requests and releases the permit after each completion", async () => {
    let active = 0;
    let maximumActive = 0;
    const fetcher: FetchLike = async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return response(contentStream());
    };
    const adapter = makeMinistralAdapter(
      { apiKey: "synthetic-key", maximumConcurrency: 1 },
      fetcher,
    );
    await Effect.runPromise(
      Effect.all([adapter.complete(request), adapter.complete(request)], { concurrency: 2 }),
    );
    expect(maximumActive).toBe(1);
  });

  it("rejects a response above the configured byte limit", async () => {
    const adapter = makeMinistralAdapter(
      { apiKey: "synthetic-key", maximumResponseBytes: 16 },
      async () => response(contentStream()),
    );
    await expect(Effect.runPromise(adapter.complete(request))).rejects.toMatchObject({
      code: "response_too_large",
      billableUnknown: true,
    });
  });

  it("fails clearly without a key before calling the provider", async () => {
    const fetcher = vi.fn(async () => response(contentStream()));
    const adapter = makeMinistralAdapter({ apiKey: " " }, fetcher);
    await expect(Effect.runPromise(adapter.complete(request))).rejects.toMatchObject({
      code: "configuration",
      billableUnknown: false,
    });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("provider audit redaction", () => {
  it("removes auth fields, provider keys, bearer values, and email addresses recursively", () => {
    const sanitized = redactProviderAudit({
      Authorization: "Bearer synthetic-header-secret",
      nested: {
        OPENROUTER_API_KEY: "sk-or-v1-synthetic-key",
        Cookie: "session=synthetic-cookie",
        note: "Contact login-person@example.test and use sk-or-v1-another-secret",
        safe: "BB-1042",
      },
    });
    expect(sanitized).toEqual({
      Authorization: "[redacted]",
      nested: {
        OPENROUTER_API_KEY: "[redacted]",
        Cookie: "[redacted]",
        note: "Contact [redacted-email] and use [redacted]",
        safe: "BB-1042",
      },
    });
    const serialized = JSON.stringify(sanitized);
    expect(serialized).not.toContain("synthetic-header-secret");
    expect(serialized).not.toContain("synthetic-key");
    expect(serialized).not.toContain("synthetic-cookie");
    expect(serialized).not.toContain("login-person@example.test");
  });

  it("redacts sensitive fields inside serialized JSON without changing the live wire", () => {
    const history = {
      messages: [
        {
          role: "assistant" as const,
          content: null,
          toolCalls: [{ id: "call-1", name: "getOrder", arguments: { password: "synthetic-password-canary" } }],
        },
        {
          role: "tool" as const,
          toolCallId: "call-1",
          content: JSON.stringify({ cookie: "synthetic-cookie-canary", status: "ready" }),
        },
      ],
    };
    const wire = buildMinistralWireRequest(history);
    expect(JSON.stringify(wire)).toContain("synthetic-password-canary");
    expect(JSON.stringify(wire)).toContain("synthetic-cookie-canary");
    const sanitized = redactProviderAudit(wire);
    expect(JSON.stringify(sanitized)).not.toContain("synthetic-password-canary");
    expect(JSON.stringify(sanitized)).not.toContain("synthetic-cookie-canary");
    const messages = (sanitized as { messages: Array<Record<string, unknown>> }).messages;
    const toolCalls = messages[0]?.tool_calls as Array<{ function: { arguments: string } }>;
    expect(JSON.parse(toolCalls[0]!.function.arguments)).toEqual({ password: "[redacted]" });
    expect(JSON.parse(messages[1]!.content as string)).toEqual({ cookie: "[redacted]", status: "ready" });
  });
});

describe("bounded provider response bodies", () => {
  it("cancels a body rejected by Content-Length", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; } });
    await expect(readBoundedBody(new Response(body, { headers: { "content-length": "100" } }), 10)).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancelled).toBe(true);
  });

  it("cancels a body that crosses the cumulative limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(6));
        controller.enqueue(new Uint8Array(6));
      },
      cancel: () => { cancelled = true; },
    });
    await expect(readBoundedBody(new Response(body), 10)).rejects.toMatchObject({ code: "response_too_large" });
    expect(cancelled).toBe(true);
  });

  it("preserves the byte-limit failure when cancellation also fails", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(1_024));
      },
      cancel: () => {
        throw new Error("cancel failed");
      },
    });
    await expect(readBoundedBody(new Response(body), 16)).rejects.toMatchObject({
      code: "response_too_large",
    });
  });
});

describe("Jev Decisions adapter", () => {
  const decisions: JevRequest = {
    state: { note: "Customer agrees if blue is unavailable." },
    questions: {
      consent: { type: "noul", instructions: "Is replacement allowed?" },
      route: { type: "choice", instructions: "Choose route.", criteria: { hold: "Keep the order on hold.", replace: "Use the available replacement." } },
      urgency: { type: "score", instructions: "Score urgency.", criteria: ["low", "medium", "high"] },
    },
  };

  const valid = {
    id: "decision_1",
    model: "typesafe/jev-1.13-20260917",
    provider: "TypeSafe",
    answers: {
      consent: { type: "noul", noul: 0.75 },
      route: { type: "choice", choice: "replace", confidence: 0.6, probabilities: { hold: 0.2, replace: 0.8 } },
      urgency: { type: "score", score: 1.4, confidence: 0.55, probabilities: { "0": 0.1, "1": 0.4, "2": 0.5 }, legend: { "0": "low", "1": "medium", "2": "high" } },
    },
    usage: { input_tokens: 30, output_tokens: 12, cost: 0 },
  };

  it("preserves noul, fractional score, choice probabilities, and the dated actual model", () => {
    const result = parseJevResponse(encoder.encode(JSON.stringify(valid)), decisions, 100, "generation_1");
    expect(result.answers).toEqual(valid.answers);
    expect(result.metadata).toMatchObject({
      requestedModel: "typesafe/jev-1.13",
      actualModel: "typesafe/jev-1.13-20260917",
      provider: "TypeSafe",
      usage: { inputTokens: 30, outputTokens: 12, totalTokens: 42, costUsd: 0 },
    });
  });

  it("sends Choice criteria as a label-description map", async () => {
    let sent: Record<string, unknown> | null = null;
    const adapter = makeJevAdapter({ apiKey: "synthetic-key" }, async (_url, init) => {
      sent = JSON.parse(String(init?.body));
      return response(encoder.encode(JSON.stringify(valid)));
    });
    await Effect.runPromise(adapter.decide(decisions));
    expect(sent).toMatchObject({
      questions: {
        route: {
          type: "choice",
          criteria: { hold: "Keep the order on hold.", replace: "Use the available replacement." },
        },
      },
    });
  });

  it.each([
    [200, "transport_error"],
    [402, "credits_exhausted"],
    [429, "rate_limited"],
    [500, "provider_error"],
  ])("never returns a complete Decisions answer after a status %i body read failure", async (status, code) => {
    const bytes = encoder.encode(JSON.stringify(valid));
    const adapter = makeJevAdapter({ apiKey: "synthetic-key" }, async () =>
      responseThenError(bytes, status));
    await expect(Effect.runPromise(adapter.decide(decisions))).rejects.toMatchObject({
      code,
      provider: "TypeSafe",
      actualModel: "typesafe/jev-1.13-20260917",
      providerRequestId: "decision_1",
      inputTokens: 30,
      outputTokens: 12,
      totalTokens: 42,
      costUsd: 0,
    });
  });

  it.each([
    ["missing answer", { ...valid, answers: { consent: valid.answers.consent, route: valid.answers.route } }],
    ["wrong answer kind", { ...valid, answers: { ...valid.answers, consent: { type: "choice", choice: "yes" } } }],
    ["unknown choice", { ...valid, answers: { ...valid.answers, route: { ...valid.answers.route, choice: "refund" } } }],
    ["out of range noul", { ...valid, answers: { ...valid.answers, consent: { type: "noul", noul: 2 } } }],
    ["fractional score outside range", { ...valid, answers: { ...valid.answers, urgency: { ...valid.answers.urgency, score: 2.1 } } }],
    ["bad probability total", { ...valid, answers: { ...valid.answers, route: { ...valid.answers.route, probabilities: { hold: 0.1, replace: 0.1 } } } }],
  ])("rejects %s", (_name, payload) => {
    expect(() => parseJevResponse(encoder.encode(JSON.stringify(payload)), decisions, 1, null)).toThrow();
  });

  it("retains Decisions usage and metadata when an answer fails validation", () => {
    const invalid = {
      ...valid,
      answers: { ...valid.answers, route: { ...valid.answers.route, choice: "refund" } },
      usage: { input_tokens: 30, output_tokens: 12, cost: 0.0042 },
    };
    expect(() => parseJevResponse(encoder.encode(JSON.stringify(invalid)), decisions, 100, "generation_1")).toThrowError(
      expect.objectContaining({
        code: "malformed_response",
        provider: "TypeSafe",
        actualModel: "typesafe/jev-1.13-20260917",
        providerRequestId: "decision_1",
        generationId: "generation_1",
        inputTokens: 30,
        outputTokens: 12,
        totalTokens: 42,
        costUsd: 0.0042,
        billableUnknown: false,
      }),
    );
  });

  it("rejects empty Choice descriptions before transport", async () => {
    const invalid: JevRequest = {
      state: {},
      questions: { route: { type: "choice", instructions: "Choose.", criteria: { hold: "", replace: "Replace." } } },
    };
    const fetcher = vi.fn(async () => response(encoder.encode(JSON.stringify(valid))));
    await expect(Effect.runPromise(makeJevAdapter({ apiKey: "synthetic-key" }, fetcher).decide(invalid))).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("enforces request bytes before calling the provider", async () => {
    const fetcher = vi.fn(async () => response(encoder.encode(JSON.stringify(valid))));
    const adapter = makeJevAdapter(
      { apiKey: "synthetic-key", maximumContextBytes: 64 },
      fetcher,
    );
    await expect(Effect.runPromise(adapter.decide(decisions))).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
