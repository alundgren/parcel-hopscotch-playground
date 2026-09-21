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
  providerFailure,
} from "./http.js";
import { redactProviderAudit } from "./redaction.js";

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
    if (question.criteria.length < 2 || question.criteria.length > 16) {
      throw invalidRequest("Choice questions require between 2 and 16 criteria.");
    }
    if (
      new Set(question.criteria).size !== question.criteria.length ||
      question.criteria.some((item) => item.length === 0 || item.length > 128)
    ) {
      throw invalidRequest("Choice criteria must be unique non-empty labels.");
    }
  }
  if (
    question.type === "score" &&
    (question.criteria.length < 2 || question.criteria.length > 10)
  ) {
    throw invalidRequest("Score questions require between 2 and 10 criteria.");
  }
};

const safeRequest = (request: JevRequest) => ({
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
  if (jsonBytes(safeRequest(request)) > maximumContextBytes) {
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
  criteria: ReadonlyArray<string>,
): DecisionAnswer => {
  if (typeof value.choice !== "string" || !criteria.includes(value.choice)) {
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
    probabilities: validateProbabilityMap(value.probabilities, criteria, "A choice answer"),
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

export const parseJevResponse = (
  bytes: Uint8Array,
  request: JevRequest,
  requestBytes: number,
  generationId: string | null,
): JevResult => {
  const value = parseJson(bytes);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw malformedResponse("The Decisions response was not an object.");
  }
  const payload = value as Record<string, unknown>;
  if (payload.error !== undefined) {
    throw providerFailure("provider_error", "The Decisions API returned an error.", {
      billableUnknown: true,
    });
  }
  if (typeof payload.answers !== "object" || payload.answers === null || Array.isArray(payload.answers)) {
    throw malformedResponse("The Decisions response did not contain answers.");
  }
  const responseAnswers = payload.answers as Record<string, unknown>;
  const questionNames = Object.keys(request.questions).sort();
  const answerNames = Object.keys(responseAnswers).sort();
  if (
    questionNames.length !== answerNames.length ||
    questionNames.some((name, index) => name !== answerNames[index])
  ) {
    throw malformedResponse("Decision answers did not match the submitted question names.");
  }
  const answers: Record<string, DecisionAnswer> = Object.create(null) as Record<string, DecisionAnswer>;
  for (const name of questionNames) {
    const question = request.questions[name]!;
    const unknownAnswer = responseAnswers[name];
    if (typeof unknownAnswer !== "object" || unknownAnswer === null || Array.isArray(unknownAnswer)) {
      throw malformedResponse(`Decision answer ${name} was malformed.`);
    }
    const answer = unknownAnswer as Record<string, unknown>;
    if (answer.type !== question.type) {
      throw malformedResponse(`Decision answer ${name} had the wrong result kind.`);
    }
    answers[name] =
      question.type === "noul"
        ? validateNoul(answer)
        : question.type === "choice"
          ? validateChoice(answer, question.criteria)
          : validateScore(answer, question.criteria);
  }
  const provider = typeof payload.provider === "string" ? payload.provider : null;
  const actualModel = typeof payload.model === "string" ? payload.model : null;
  const providerRequestId = typeof payload.id === "string" ? payload.id : null;
  const usage = normalizeUsage(payload.usage);
  const requestPayload = safeRequest(request);
  return {
    kind: "decisions",
    answers,
    metadata: {
      provider,
      requestedModel: JEV_MODEL,
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
      answers,
      usage,
    }),
  };
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
    decide: (request) => {
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
            `${baseUrl}/api/alpha/decisions`,
            config.apiKey,
            body,
            maximumResponseBytes,
            signal,
          );
          try {
            return parseJevResponse(
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
                "The Decisions request did not complete.",
                { billableUnknown: true },
              ),
      }).pipe(
        Effect.timeout(timeoutMs),
        Effect.mapError((cause) =>
          cause instanceof ProviderError
            ? cause
            : providerFailure("timeout", "The Decisions request timed out.", {
                billableUnknown: true,
              }),
        ),
      );
      return semaphore.withPermit(run);
    },
  };
};
