import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ChatTool, FetchLike, JevRequest } from "../../src/server/providers/contracts";
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
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
    },
    {
      id: "gen_chat",
      model: "mistralai/ministral-3b-2512",
      provider: "Mistral",
      choices: [{ index: 0, delta: { content: "" }, finish_reason: "stop" }],
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
});

describe("Jev Decisions adapter", () => {
  const decisions: JevRequest = {
    state: { note: "Customer agrees if blue is unavailable." },
    questions: {
      consent: { type: "noul", instructions: "Is replacement allowed?" },
      route: { type: "choice", instructions: "Choose route.", criteria: ["hold", "replace"] },
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
