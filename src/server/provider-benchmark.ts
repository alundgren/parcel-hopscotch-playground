import { createHash } from "node:crypto";
import type {
  JevRequest,
  MinistralRequest,
  ProviderMetadata,
  ProviderUsage,
} from "./providers/contracts.js";

export type BenchmarkTask = "consent" | "exception";
export type BenchmarkModel = "jev" | "ministral";
export type BenchmarkOutcome = "success" | "invalid" | "failure";

export interface BenchmarkInput {
  readonly caseId: string;
  readonly task: BenchmarkTask;
  readonly note: string;
}

export interface BenchmarkExpectation {
  readonly expected: string;
  readonly semanticSubtype?: string;
}

export interface FixtureSet {
  readonly inputs: ReadonlyArray<BenchmarkInput>;
  readonly expectations: Readonly<Record<string, BenchmarkExpectation>>;
  readonly digest: string;
}

export interface SanitizedProviderMetadata {
  readonly provider: string | null;
  readonly requestedModel: string;
  readonly actualModel: string | null;
  readonly providerRequestId: string | null;
  readonly generationId: string | null;
  readonly requestBytes: number | null;
  readonly responseBytes: number | null;
  readonly usage: ProviderUsage;
}

export interface BenchmarkAttempt {
  readonly sequence: number;
  readonly kind: "constrained" | "scenario_request";
  readonly model: BenchmarkModel;
  readonly caseId: string | null;
  readonly scenarioId: string | null;
  readonly phase: string;
  readonly outcome: BenchmarkOutcome;
  readonly completedWork: boolean;
  readonly durationMs: number;
  readonly prediction: string | null;
  readonly expected: string | null;
  readonly semanticSubtype: string | null;
  readonly correct: boolean;
  readonly unsafeExplicitApproval: boolean;
  readonly metadata: SanitizedProviderMetadata | null;
  readonly error: {
    readonly code: string;
    readonly status: number | null;
    readonly billableUnknown: boolean;
  } | null;
}

export interface ScenarioResult {
  readonly scenarioId: string;
  readonly outcome: "success" | "incomplete";
  readonly durationMs: number;
  readonly attemptedRequests: number;
  readonly completedRequests: number;
  readonly expectedTool: string;
  readonly expectedArguments: unknown;
  readonly selectedTool: string | null;
  readonly selectedArguments: unknown;
  readonly toolOutput: unknown;
  readonly finalResponse: string | null;
  readonly failure: string | null;
}

export const benchmarkLimits = {
  constrainedFixtures: 12,
  constrainedModels: ["jev", "ministral"] as const,
  constrainedRequests: 24,
  scenarioCount: 2,
  scenarioRequestsPerScenario: 2,
  maximumScenarioRequests: 4,
  maximumTotalRequests: 28,
  concurrency: 1,
  retries: 0,
  requestTimeoutMs: 20_000,
  constrainedMaximumOutputTokens: 64,
  scenarioMaximumOutputTokens: 256,
  maximumRunDurationMs: 10 * 60_000,
} as const;

const contracts = {
  consent: {
    title: "Replacement consent",
    choices: {
      explicit: "The note gives unqualified agreement to the replacement.",
      conditional: "The note agrees only after a stated condition or prerequisite.",
      unclear: "The note does not establish acceptance, including questions or rejection.",
    },
  },
  exception: {
    title: "Fulfilment exception",
    choices: {
      address: "The delivery address needs correction or confirmation.",
      substitution: "Stock availability or a product substitution needs attention.",
      bundle: "A bundle is missing a component or contains the wrong component.",
      weight: "The measured parcel weight conflicts with the expected weight.",
      carrier: "Carrier collection or tracking progress needs attention.",
      duplicate: "Two orders may represent the same intended purchase.",
      other: "The note does not match another listed exception category.",
    },
  },
} as const;

export const classificationInstruction =
  "Return exactly one allowed choice that is supported by the evidence. Do not add facts that the evidence does not state.";

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const fixtureDigest = (inputBytes: string, expectationBytes: string): string =>
  createHash("sha256")
    .update("parcel-hopscotch-benchmark-v1\0", "utf8")
    .update(inputBytes, "utf8")
    .update("\0", "utf8")
    .update(expectationBytes, "utf8")
    .digest("hex");

export const parseFixtureSet = (
  inputBytes: string,
  expectationBytes: string,
): FixtureSet => {
  const rawInputs: unknown = JSON.parse(inputBytes);
  const rawExpectations: unknown = JSON.parse(expectationBytes);
  if (!Array.isArray(rawInputs) || rawInputs.length !== benchmarkLimits.constrainedFixtures) {
    throw new Error(`The benchmark requires exactly ${benchmarkLimits.constrainedFixtures} constrained inputs.`);
  }
  if (!isObject(rawExpectations)) throw new Error("Benchmark expectations must be an object keyed by case ID.");

  const seen = new Set<string>();
  const inputs = rawInputs.map((raw, index): BenchmarkInput => {
    if (!isObject(raw)) throw new Error(`Benchmark input ${index + 1} is not an object.`);
    const keys = Object.keys(raw).sort();
    if (keys.join(",") !== "caseId,note,task") throw new Error(`Benchmark input ${index + 1} has unexpected fields.`);
    if (typeof raw.caseId !== "string" || !/^c\d{2}$/.test(raw.caseId) || seen.has(raw.caseId)) {
      throw new Error(`Benchmark input ${index + 1} has an invalid or duplicate case ID.`);
    }
    if (raw.task !== "consent" && raw.task !== "exception") throw new Error(`Benchmark input ${raw.caseId} has an invalid task.`);
    if (typeof raw.note !== "string" || raw.note.length === 0 || raw.note.length > 500) throw new Error(`Benchmark input ${raw.caseId} has an invalid note.`);
    seen.add(raw.caseId);
    return { caseId: raw.caseId, task: raw.task, note: raw.note };
  });

  const expectations: Record<string, BenchmarkExpectation> = {};
  for (const input of inputs) {
    const raw = rawExpectations[input.caseId];
    if (!isObject(raw)) throw new Error(`Benchmark input ${input.caseId} has no expectation.`);
    const keys = Object.keys(raw).sort();
    if (keys.some((key) => key !== "expected" && key !== "semanticSubtype")) {
      throw new Error(`Benchmark expectation ${input.caseId} has unexpected fields.`);
    }
    if (typeof raw.expected !== "string" || !Object.prototype.hasOwnProperty.call(contracts[input.task].choices, raw.expected)) {
      throw new Error(`Benchmark expectation ${input.caseId} is not an allowed choice.`);
    }
    if (raw.semanticSubtype !== undefined && typeof raw.semanticSubtype !== "string") {
      throw new Error(`Benchmark expectation ${input.caseId} has an invalid semantic subtype.`);
    }
    expectations[input.caseId] = {
      expected: raw.expected,
      ...(raw.semanticSubtype === undefined ? {} : { semanticSubtype: raw.semanticSubtype }),
    };
  }
  const extraExpectations = Object.keys(rawExpectations).filter((caseId) => !seen.has(caseId));
  if (extraExpectations.length > 0) throw new Error(`Unexpected benchmark expectations: ${extraExpectations.join(", ")}.`);

  return { inputs, expectations, digest: fixtureDigest(inputBytes, expectationBytes) };
};

export const taskText = (input: BenchmarkInput): string => {
  const contract = contracts[input.task];
  const choices = Object.entries(contract.choices)
    .map(([choice, description]) => `- ${choice}: ${description}`)
    .join("\n");
  return `Task: ${contract.title}\nEvidence:\n${input.note}\nAllowed choices:\n${choices}`;
};

export const isAllowedPrediction = (input: BenchmarkInput, prediction: string): boolean =>
  Object.prototype.hasOwnProperty.call(contracts[input.task].choices, prediction);

export const buildJevBenchmarkRequest = (input: BenchmarkInput): JevRequest => ({
  state: { task: taskText(input) },
  questions: {
    classification: {
      type: "choice",
      instructions: classificationInstruction,
      criteria: contracts[input.task].choices,
    },
  },
});

export const buildMinistralBenchmarkRequest = (input: BenchmarkInput): MinistralRequest => {
  const choices = Object.keys(contracts[input.task].choices);
  return {
    messages: [
      { role: "system", content: classificationInstruction },
      { role: "user", content: taskText(input) },
    ],
    tools: [{
      name: "recordClassification",
      description: "Record the single classification for this constrained task.",
      parameters: {
        type: "object",
        properties: {
          choice: {
            type: "string",
            enum: choices,
            description: "The selected allowed choice.",
          },
        },
        required: ["choice"],
        additionalProperties: false,
      },
      validateArguments: (value: unknown) =>
        isObject(value) && Object.keys(value).length === 1 && typeof value.choice === "string" && choices.includes(value.choice),
    }],
    toolChoice: { name: "recordClassification" },
    maxOutputTokens: benchmarkLimits.constrainedMaximumOutputTokens,
  };
};

export const extractJevPrediction = (answers: Readonly<Record<string, unknown>>): string | null => {
  const answer = answers.classification;
  if (!isObject(answer) || answer.type !== "choice" || typeof answer.choice !== "string") return null;
  return answer.choice;
};

export const extractMinistralPrediction = (
  toolCalls: ReadonlyArray<{ readonly name: string; readonly arguments: unknown }>,
): string | null => {
  if (toolCalls.length !== 1) return null;
  const call = toolCalls[0];
  if (call?.name !== "recordClassification" || !isObject(call.arguments) || typeof call.arguments.choice !== "string") return null;
  return call.arguments.choice;
};

export const sanitizeMetadata = (metadata: ProviderMetadata): SanitizedProviderMetadata => ({
  provider: metadata.provider,
  requestedModel: metadata.requestedModel,
  actualModel: metadata.actualModel,
  providerRequestId: metadata.providerRequestId,
  generationId: metadata.generationId,
  requestBytes: metadata.requestBytes,
  responseBytes: metadata.responseBytes,
  usage: metadata.usage,
});

export const emptyUsage = (): ProviderUsage => ({
  inputTokens: null,
  outputTokens: null,
  totalTokens: null,
  costUsd: null,
});

export const scenarioResponseHasExpectedFacts = (
  toolName: "getOrder" | "listOrders",
  content: string,
  toolOutput: unknown,
): boolean => {
  const normalized = content.toLowerCase();
  if (!isObject(toolOutput)) return false;
  if (toolName === "getOrder") {
    const order = toolOutput.order;
    return isObject(order)
      && typeof order.id === "string"
      && normalized.includes(order.id.toLowerCase())
      && normalized.includes("41");
  }
  const orders = toolOutput.orders;
  if (!Array.isArray(orders) || orders.length === 0) return false;
  const orderIds = orders.flatMap((order) => isObject(order) && typeof order.id === "string" ? [order.id] : []);
  return orderIds.length === orders.length
    && orderIds.every((orderId) => normalized.includes(orderId.toLowerCase()))
    && normalized.includes("ready");
};

export const nearestRankPercentile = (values: ReadonlyArray<number>, percentile: number): number | null => {
  if (values.length === 0) return null;
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) throw new Error("Percentile must be greater than 0 and at most 1.");
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(percentile * sorted.length) - 1] ?? null;
};

const ratio = (numerator: number, denominator: number): number | null =>
  denominator === 0 ? null : numerator / denominator;

const aggregateUsage = (attempts: ReadonlyArray<BenchmarkAttempt>) => {
  const fields = ["inputTokens", "outputTokens", "totalTokens", "costUsd"] as const;
  return Object.fromEntries(fields.map((field) => {
    const values = attempts.map((attempt) => attempt.metadata?.usage[field] ?? null);
    return [field, {
      knownSubtotal: values.reduce<number>((total, value) => total + (value ?? 0), 0),
      unknownCount: values.filter((value) => value === null).length,
    }];
  }));
};

export const summarizeBenchmark = (
  fixtureSet: FixtureSet,
  attempts: ReadonlyArray<BenchmarkAttempt>,
  scenarios: ReadonlyArray<ScenarioResult>,
) => {
  const constrainedByModel = Object.fromEntries(benchmarkLimits.constrainedModels.map((model) => {
    const modelAttempts = attempts.filter((attempt) => attempt.kind === "constrained" && attempt.model === model);
    const valid = modelAttempts.filter((attempt) => attempt.outcome === "success");
    const correct = modelAttempts.filter((attempt) => attempt.correct).length;
    const nonExplicitConsent = modelAttempts.filter((attempt) => {
      if (attempt.caseId === null) return false;
      const input = fixtureSet.inputs.find((candidate) => candidate.caseId === attempt.caseId);
      return input?.task === "consent" && attempt.expected !== "explicit";
    });
    const unsafe = nonExplicitConsent.filter((attempt) => attempt.unsafeExplicitApproval).length;
    const validDurations = valid.map((attempt) => attempt.durationMs);
    const correctDurations = modelAttempts.filter((attempt) => attempt.completedWork).map((attempt) => attempt.durationMs);
    return [model, {
      plannedFixtures: fixtureSet.inputs.length,
      attempted: modelAttempts.length,
      skipped: fixtureSet.inputs.length - modelAttempts.length,
      validResponses: valid.length,
      invalidResponses: modelAttempts.filter((attempt) => attempt.outcome === "invalid").length,
      failures: modelAttempts.filter((attempt) => attempt.outcome === "failure").length,
      correct,
      attemptedAccuracy: ratio(correct, modelAttempts.length),
      responseOnlyAccuracy: ratio(correct, valid.length),
      unsafeExplicitApprovals: {
        count: unsafe,
        denominator: nonExplicitConsent.length,
        rate: ratio(unsafe, nonExplicitConsent.length),
        missingOrInvalid: nonExplicitConsent.filter((attempt) => attempt.outcome !== "success").length,
      },
      validProviderResponseLatencyMs: {
        sampleCount: validDurations.length,
        percentileMethod: "nearest-rank",
        p50: nearestRankPercentile(validDurations, 0.5),
        p95: nearestRankPercentile(validDurations, 0.95),
      },
      correctCompletedWorkLatencyMs: {
        sampleCount: correctDurations.length,
        percentileMethod: "nearest-rank",
        p50: nearestRankPercentile(correctDurations, 0.5),
        p95: nearestRankPercentile(correctDurations, 0.95),
      },
      usage: aggregateUsage(modelAttempts),
    }];
  }));

  const scenarioAttempts = attempts.filter((attempt) => attempt.kind === "scenario_request");
  const completedScenarioAttempts = scenarioAttempts.filter((attempt) => attempt.outcome === "success");
  const completedScenarios = scenarios.filter((scenario) => scenario.outcome === "success");
  return {
    constrainedByModel,
    scenarioSequences: {
      planned: benchmarkLimits.scenarioCount,
      attempted: scenarios.length,
      completed: completedScenarios.length,
      attemptedRequests: scenarioAttempts.length,
      completedRequests: completedScenarioAttempts.length,
      validProviderResponseLatencyMs: {
        sampleCount: completedScenarioAttempts.length,
        percentileMethod: "nearest-rank",
        p50: nearestRankPercentile(completedScenarioAttempts.map((attempt) => attempt.durationMs), 0.5),
        p95: nearestRankPercentile(completedScenarioAttempts.map((attempt) => attempt.durationMs), 0.95),
      },
      completedSequenceLatencyMs: {
        sampleCount: completedScenarios.length,
        percentileMethod: "nearest-rank",
        p50: nearestRankPercentile(completedScenarios.map((scenario) => scenario.durationMs), 0.5),
        p95: nearestRankPercentile(completedScenarios.map((scenario) => scenario.durationMs), 0.95),
      },
      usage: aggregateUsage(scenarioAttempts),
    },
  };
};
