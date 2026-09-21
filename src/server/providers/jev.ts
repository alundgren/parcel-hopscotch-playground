import { Effect, Semaphore } from "effect";
import {
  JEV_MODEL,
  ProviderError,
  providerBounds,
  type DecisionAnswer,
  type DecisionQuestion,
  type FetchLike,
  type JevAdapter,
  type JevRequest,
  type JevResult,
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
  providerBodyReadFailure,
  providerFailure,
} from "./http.js";
import { redactProviderAudit, redactProviderString } from "./redaction.js";

const own = (value: object, key: string): boolean =>
  Object.prototype.hasOwnProperty.call(value, key);

const finiteRange = (
  value: unknown,
  minimum: number,
  maximum: number,
): number | null =>
  typeof value === "number" &&
  Number.isFinite(value) &&
  value >= minimum &&
  value <= maximum
    ? value
    : null;

const tokenCount = (value: unknown): number | null =>
  typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : null;

const normalizeUsage = (value: unknown): ProviderUsage => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null };
  }
  const usage = value as Record<string, unknown>;
  const inputTokens = tokenCount(usage.input_tokens);
  const outputTokens = tokenCount(usage.output_tokens);
  return {
    inputTokens,
    outputTokens,
    totalTokens:
      inputTokens === null || outputTokens === null
        ? null
        : inputTokens + outputTokens,
    costUsd:
      typeof usage.cost === "number" && Number.isFinite(usage.cost) && usage.cost >= 0
        ? usage.cost
        : null,
  };
};

const validateProbabilityMap = (
  value: unknown,
  expectedKeys: ReadonlyArray<string>,
  description: string,
): Readonly<Record<string, number>> => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformedResponse(`${description} probabilities were malformed.`);
  }
  const source = value as Record<string, unknown>;
  const actualKeys = Object.keys(source).sort();
  const expected = [...expectedKeys].sort();
  if (
    actualKeys.length !== expected.length ||
    actualKeys.some((key, index) => key !== expected[index])
  ) {
    throw malformedResponse(`${description} probabilities did not match the submitted criteria.`);
  }
  const probabilities: Record<string, number> = Object.create(null) as Record<string, number>;
  let total = 0;
  for (const key of expectedKeys) {
    const probability = finiteRange(source[key], 0, 1);
    if (probability === null) {
      throw malformedResponse(`${description} contained an invalid probability.`);
    }
    probabilities[key] = probability;
    total += probability;
  }
  if (Math.abs(total - 1) > 0.02) {
    throw malformedResponse(`${description} probabilities did not total one within provider rounding.`);
  }
  return probabilities;
};

const validateQuestion = (name: string, question: DecisionQuestion): void => {
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(name)) {
    throw invalidRequest("Decision question names must be safe identifiers.");
  }
  if (question.type === "choice") {
    const labels = Object.keys(question.criteria);
    if (labels.length < 2 || labels.length > 16) {
      throw invalidRequest("Choice questions require between 2 and 16 criteria.");
    }
    if (
      labels.some((item) => item.length === 0 || item.length > 128) ||
      labels.some((item) => !/^[A-Za-z0-9][A-Za-z0-9 _-]{0,127}$/.test(item)) ||
      labels.some((item) => question.criteria[item]!.trim().length === 0 || question.criteria[item]!.length > 1_024)
    ) {
      throw invalidRequest("Choice criteria require safe labels and bounded descriptions.");
    }
  }
  if (
    question.type === "score" &&
    (question.criteria.length < 2 || question.criteria.length > 10)
  ) {
    throw invalidRequest("Score questions require between 2 and 10 criteria.");
  }
};

export const buildJevWireRequest = (request: JevRequest) => ({
  model: JEV_MODEL,
  state: request.state,
  questions: request.questions,
});

const validateRequest = (request: JevRequest, maximumContextBytes: number) => {
  const names = Object.keys(request.questions);
  if (names.length === 0 || names.length > providerBounds.maximumQuestions) {
    throw invalidRequest(
      `Decision requests require between 1 and ${providerBounds.maximumQuestions} questions.`,
    );
  }
  for (const name of names) validateQuestion(name, request.questions[name]!);
  if (jsonBytes(buildJevWireRequest(request)) > maximumContextBytes) {
    throw invalidRequest("The decision request exceeded the configured context byte limit.");
  }
};

const validateNoul = (value: Record<string, unknown>): DecisionAnswer => {
  const noul = finiteRange(value.noul, 0, 1);
  if (noul === null) throw malformedResponse("A noul answer was outside 0 to 1.");
  return { type: "noul", noul };
};

const validateChoice = (
  value: Record<string, unknown>,
  criteria: Readonly<Record<string, string>>,
): DecisionAnswer => {
  const labels = Object.keys(criteria);
  if (typeof value.choice !== "string" || !labels.includes(value.choice)) {
    throw malformedResponse("A choice answer was not one of the submitted criteria.");
  }
  const confidence = finiteRange(value.confidence, 0, 1);
  if (confidence === null) {
    throw malformedResponse("A choice confidence was outside 0 to 1.");
  }
  return {
    type: "choice",
    choice: value.choice,
    confidence,
    probabilities: validateProbabilityMap(value.probabilities, labels, "A choice answer"),
  };
};

const validateScore = (
  value: Record<string, unknown>,
  criteria: ReadonlyArray<unknown>,
): DecisionAnswer => {
  const top = criteria.length - 1;
  const score = finiteRange(value.score, 0, top);
  const confidence = finiteRange(value.confidence, 0, 1);
  if (score === null) throw malformedResponse("A score answer was outside its submitted range.");
  if (confidence === null) throw malformedResponse("A score confidence was outside 0 to 1.");
  const keys = criteria.map((_, index) => String(index));
  if (typeof value.legend !== "object" || value.legend === null || Array.isArray(value.legend)) {
    throw malformedResponse("A score legend was malformed.");
  }
  const legend = value.legend as Record<string, unknown>;
  if (
    Object.keys(legend).length !== keys.length ||
    keys.some((key, index) => !own(legend, key) || JSON.stringify(legend[key]) !== JSON.stringify(criteria[index]))
  ) {
    throw malformedResponse("A score legend did not match the submitted criteria.");
  }
  return {
    type: "score",
    score,
    confidence,
    probabilities: validateProbabilityMap(value.probabilities, keys, "A score answer"),
    legend: Object.fromEntries(keys.map((key) => [key, legend[key]])),
  };
};

const safeIdentifier = (value: string | null): string | null =>
  value === null ? null : redactProviderString(value, 256);

export const parseJevResponse = (
  bytes: Uint8Array,
  request: JevRequest,
  requestBytes: number,
  generationId: string | null,
): JevResult => {
  let provider: string | null = null;
  let actualModel: string | null = null;
  let providerRequestId: string | null = null;
  let usage: ProviderUsage = { inputTokens: null, outputTokens: null, totalTokens: null, costUsd: null };
  let payload: Record<string, unknown> | null = null;
  try {
    const value = parseJson(bytes);
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw malformedResponse("The Decisions response was not an object.");
    }
    payload = value as Record<string, unknown>;
    for (const key of ["provider", "model", "id"] as const) {
      if (payload[key] !== undefined && typeof payload[key] !== "string") {
        throw malformedResponse(`The Decisions ${key} was malformed.`);
      }
    }
    provider = typeof payload.provider === "string" ? payload.provider : null;
    actualModel = typeof payload.model === "string" ? payload.model : null;
    providerRequestId = typeof payload.id === "string" ? payload.id : null;
    usage = normalizeUsage(payload.usage);
    if (payload.error !== undefined) {
      throw providerFailure("provider_error", "The Decisions API returned an error.", {
        billableUnknown: usage.costUsd === null,
      });
    }
    if (typeof payload.answers !== "object" || payload.answers === null || Array.isArray(payload.answers)) {
      throw malformedResponse("The Decisions response did not contain answers.");
    }
    const responseAnswers = payload.answers as Record<string, unknown>;
    const questionNames = Object.keys(request.questions).sort();
    const answerNames = Object.keys(responseAnswers).sort();
    if (questionNames.length !== answerNames.length || questionNames.some((name, index) => name !== answerNames[index])) {
      throw malformedResponse("Decision answers did not match the submitted question names.");
    }
    const answers: Record<string, DecisionAnswer> = Object.create(null) as Record<string, DecisionAnswer>;
    for (const name of questionNames) {
      const question = request.questions[name]!;
      const unknownAnswer = responseAnswers[name];
      if (typeof unknownAnswer !== "object" || unknownAnswer === null || Array.isArray(unknownAnswer)) {
        throw malformedResponse(`Decision answer ${redactProviderString(name, 64)} was malformed.`);
      }
      const answer = unknownAnswer as Record<string, unknown>;
      if (answer.type !== question.type) {
        throw malformedResponse(`Decision answer ${redactProviderString(name, 64)} had the wrong result kind.`);
      }
      answers[name] = question.type === "noul"
        ? validateNoul(answer)
        : question.type === "choice"
          ? validateChoice(answer, question.criteria)
          : validateScore(answer, question.criteria);
    }
    const safeProvider = safeIdentifier(provider);
    const safeModel = safeIdentifier(actualModel);
    const safeRequestId = safeIdentifier(providerRequestId);
    const safeGenerationId = safeIdentifier(generationId);
    const requestPayload = buildJevWireRequest(request);
    return {
      kind: "decisions",
      answers,
      metadata: {
        provider: safeProvider,
        requestedModel: JEV_MODEL,
        actualModel: safeModel,
        providerRequestId: safeRequestId,
        generationId: safeGenerationId,
        requestBytes,
        responseBytes: bytes.byteLength,
        usage,
      },
      safeRequest: redactProviderAudit(requestPayload),
      safeResponse: redactProviderAudit({ provider: safeProvider, model: safeModel, providerRequestId: safeRequestId, generationId: safeGenerationId, answers, usage }),
    };
  } catch (cause) {
    const failure = cause instanceof ProviderError ? cause : malformedResponse("The Decisions response could not be validated.");
    throw new ProviderError({
      code: failure.code,
      message: redactProviderString(failure.message, 1_024),
      status: failure.status,
      billableUnknown: usage.costUsd === null ? failure.billableUnknown : false,
      safeResponse: redactProviderAudit(failure.safeResponse ?? {
        provider: safeIdentifier(provider),
        model: safeIdentifier(actualModel),
        providerRequestId: safeIdentifier(providerRequestId),
        generationId: safeIdentifier(generationId),
        answers: payload?.answers ?? null,
        usage,
      }),
      responseBytes: failure.responseBytes ?? bytes.byteLength,
      provider: failure.provider ?? safeIdentifier(provider),
      actualModel: failure.actualModel ?? safeIdentifier(actualModel),
      providerRequestId: failure.providerRequestId ?? safeIdentifier(providerRequestId),
      generationId: failure.generationId ?? safeIdentifier(generationId),
      inputTokens: failure.inputTokens ?? usage.inputTokens,
      outputTokens: failure.outputTokens ?? usage.outputTokens,
      totalTokens: failure.totalTokens ?? usage.totalTokens,
      costUsd: failure.costUsd ?? usage.costUsd,
    });
  }
};

export const makeJevAdapter = (
  config: OpenRouterAdapterConfig,
  fetcher: FetchLike = fetch,
): JevAdapter => {
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
    decide: (request) => {
      const run = Effect.tryPromise({
        try: async (signal) => {
          if (config.apiKey.trim().length === 0) {
            throw providerFailure("configuration", "OPENROUTER_API_KEY is required for live provider requests.");
          }
          validateRequest(request, maximumContextBytes);
          const payload = buildJevWireRequest(request);
          const body = JSON.stringify(payload);
          const requestBytes = new TextEncoder().encode(body).byteLength;
          let result: Awaited<ReturnType<typeof fetchOpenRouter>>;
          try {
            result = await fetchOpenRouter(fetcher, `${baseUrl}/api/alpha/decisions`, config.apiKey, body, maximumResponseBytes, signal);
          } catch (cause) {
            if (!(cause instanceof ProviderBodyReadError)) throw cause;
            let partial: JevResult;
            try {
              partial = parseJevResponse(
                cause.bytes,
                request,
                requestBytes,
                cause.generationId,
              );
            } catch (partialCause) {
              if (!(partialCause instanceof ProviderError)) throw cause;
              throw providerBodyReadFailure(cause, {
                safeResponse: partialCause.safeResponse,
                provider: partialCause.provider,
                actualModel: partialCause.actualModel,
                providerRequestId: partialCause.providerRequestId,
                generationId: partialCause.generationId,
                inputTokens: partialCause.inputTokens,
                outputTokens: partialCause.outputTokens,
                totalTokens: partialCause.totalTokens,
                costUsd: partialCause.costUsd,
              });
            }
            throw providerBodyReadFailure(cause, {
              safeResponse: partial.safeResponse,
              provider: partial.metadata.provider,
              actualModel: partial.metadata.actualModel,
              providerRequestId: partial.metadata.providerRequestId,
              generationId: partial.metadata.generationId,
              inputTokens: partial.metadata.usage.inputTokens,
              outputTokens: partial.metadata.usage.outputTokens,
              totalTokens: partial.metadata.usage.totalTokens,
              costUsd: partial.metadata.usage.costUsd,
            });
          }
          return parseJevResponse(result.bytes, request, requestBytes, result.response.headers.get("x-generation-id"));
        },
        catch: (cause) => cause instanceof ProviderError
          ? cause
          : providerFailure("transport_error", "The Decisions request did not complete.", { billableUnknown: true }),
      });
      return semaphore.withPermit(run).pipe(
        Effect.timeout(timeoutMs),
        Effect.mapError((cause) => cause instanceof ProviderError
          ? cause
          : providerFailure("timeout", "The Decisions request timed out.", { billableUnknown: true })),
      );
    },
  };
};
