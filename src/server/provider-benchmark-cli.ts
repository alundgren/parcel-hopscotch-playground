import { execFileSync } from "node:child_process";
import { availableParallelism, platform, arch, totalmem } from "node:os";
import { mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";
import { isDeepStrictEqual } from "node:util";
import { Effect } from "effect";
import { resolveIdentity } from "./identity.js";
import { runWithWorkspaceRepository, WorkspaceRepository, type WorkspaceRepositoryService } from "./persistence.js";
import {
  benchmarkLimits,
  buildJevBenchmarkRequest,
  buildMinistralBenchmarkRequest,
  emptyUsage,
  extractJevPrediction,
  extractMinistralPrediction,
  isAllowedPrediction,
  parseFixtureSet,
  sanitizeMetadata,
  scenarioResponseHasExpectedFacts,
  summarizeBenchmark,
  type BenchmarkAttempt,
  type BenchmarkInput,
  type BenchmarkModel,
  type BenchmarkOutcome,
  type FixtureSet,
  type SanitizedProviderMetadata,
  type ScenarioResult,
} from "./provider-benchmark.js";
import {
  JEV_MODEL,
  MINISTRAL_MODEL,
  ProviderError,
  type JevAdapter,
  type JevResult,
  type MinistralAdapter,
  type MinistralRequest,
  type MinistralResult,
  type ProviderMetadata,
} from "./providers/contracts.js";
import { makeJevAdapter } from "./providers/jev.js";
import { makeMinistralAdapter } from "./providers/ministral.js";
import { makeToolRegistry, modelToolsFromRegistry } from "./tool-registry.js";
import { toolHandlers } from "./tool-handlers.js";

type BenchmarkMode = "fixture" | "live";

interface CliOptions {
  readonly mode: BenchmarkMode;
  readonly outputDir: string;
  readonly confirmLive: boolean;
}

interface Adapters {
  readonly jev: JevAdapter;
  readonly ministral: MinistralAdapter;
}

const requestedModel = (model: BenchmarkModel) => model === "jev" ? JEV_MODEL : MINISTRAL_MODEL;

const parseArguments = (args: ReadonlyArray<string>): CliOptions => {
  let mode: BenchmarkMode | null = null;
  let outputDir: string | null = null;
  let confirmLive = false;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === "--") {
      continue;
    } else if (value === "--mode") {
      const next = args[++index];
      if (next !== "fixture" && next !== "live") throw new Error("--mode must be fixture or live.");
      mode = next;
    } else if (value === "--output-dir") {
      outputDir = args[++index] ?? null;
    } else if (value === "--confirm-live") {
      confirmLive = true;
    } else {
      throw new Error(`Unknown benchmark argument: ${value ?? ""}`);
    }
  }
  if (mode === null) throw new Error("--mode is required.");
  if (outputDir === null || outputDir.trim().length === 0) throw new Error("--output-dir is required.");
  return { mode, outputDir: resolve(outputDir), confirmLive };
};

const isProviderError = (error: unknown): error is ProviderError =>
  error instanceof ProviderError || (typeof error === "object" && error !== null && "_tag" in error && error._tag === "ProviderError");

const failureMetadata = (model: BenchmarkModel, error: ProviderError): SanitizedProviderMetadata => ({
  provider: error.provider,
  requestedModel: requestedModel(model),
  actualModel: error.actualModel,
  providerRequestId: error.providerRequestId,
  generationId: error.generationId,
  requestBytes: null,
  responseBytes: error.responseBytes,
  usage: {
    inputTokens: error.inputTokens,
    outputTokens: error.outputTokens,
    totalTokens: error.totalTokens,
    costUsd: error.costUsd,
  },
});

const errorRecord = (error: unknown) => isProviderError(error)
  ? { code: error.code, status: error.status, billableUnknown: error.billableUnknown }
  : { code: "benchmark_error", status: null, billableUnknown: true };

const fixtureMetadata = (requested: string, suffix: string, request: unknown, response: unknown): ProviderMetadata => ({
  provider: "Fixture",
  requestedModel: requested,
  actualModel: `fixture/${suffix}`,
  providerRequestId: null,
  generationId: null,
  requestBytes: new TextEncoder().encode(JSON.stringify(request)).byteLength,
  responseBytes: new TextEncoder().encode(JSON.stringify(response)).byteLength,
  usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0, costUsd: 0 },
});

const fixtureScenarioResponse = (request: MinistralRequest): string => {
  const toolMessage = [...request.messages].reverse().find((message) => message.role === "tool");
  if (toolMessage?.role !== "tool") return "The fixture scenario did not include a tool result.";
  try {
    const payload = JSON.parse(toolMessage.content) as { result?: unknown };
    if (!isRecord(payload.result)) return "The fixture tool result was invalid.";
    if (isRecord(payload.result.order) && typeof payload.result.order.id === "string") {
      return `${payload.result.order.id} needs review because the address evidence says the house number is 41.`;
    }
    if (Array.isArray(payload.result.orders) && isRecord(payload.result.orders[0]) && typeof payload.result.orders[0].id === "string") {
      return `${payload.result.orders[0].id} is ready for the operator to review.`;
    }
  } catch {
    return "The fixture tool result could not be read.";
  }
  return "The fixture tool result did not contain the expected facts.";
};

const fixtureAdapters = (fixtures: FixtureSet): Adapters => {
  const predictionFor = (serialized: string) => {
    const input = fixtures.inputs.find((candidate) => serialized.includes(candidate.note));
    if (input === undefined) throw new Error("The fixture adapter received an unknown constrained input.");
    return fixtures.expectations[input.caseId]!.expected;
  };
  return {
    jev: {
      decide: (request) => Effect.sync((): JevResult => {
        const choice = predictionFor(JSON.stringify(request));
        const response = {
          answers: {
            classification: { type: "choice" as const, choice, confidence: 1, probabilities: { [choice]: 1 } },
          },
        };
        return {
          kind: "decisions",
          answers: response.answers,
          metadata: fixtureMetadata(JEV_MODEL, "jev-1.13", request, response),
          safeRequest: request,
          safeResponse: response,
        };
      }),
    },
    ministral: {
      complete: (request) => Effect.sync((): MinistralResult => {
        const forced = typeof request.toolChoice === "object" ? request.toolChoice.name : null;
        const constrained = forced === "recordClassification";
        const scenarioTool = request.tools?.find((tool) => tool.name === forced);
        const response = constrained
          ? { content: "", toolCalls: [{ id: "fixture-call", name: "recordClassification", arguments: { choice: predictionFor(JSON.stringify(request)) } }] }
          : scenarioTool !== undefined
            ? { content: "", toolCalls: [{ id: "fixture-call", name: scenarioTool.name, arguments: scenarioTool.name === "getOrder" ? { orderId: "BB-1042" } : { status: "ready" } }] }
            : { content: fixtureScenarioResponse(request), toolCalls: [] };
        return {
          kind: "chat",
          content: response.content,
          toolCalls: response.toolCalls,
          finishReason: response.toolCalls.length === 0 ? "stop" : "tool_calls",
          metadata: fixtureMetadata(MINISTRAL_MODEL, "ministral-3b-2512", request, response),
          safeRequest: request,
          safeResponse: response,
        };
      }),
    },
  };
};

const liveAdapters = (apiKey: string): Adapters => {
  const config = {
    apiKey,
    timeoutMs: benchmarkLimits.requestTimeoutMs,
    maximumConcurrency: benchmarkLimits.concurrency,
  };
  return { jev: makeJevAdapter(config), ministral: makeMinistralAdapter(config) };
};

const atomicJson = async (path: string, value: unknown) => {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
};

const providerAttempt = async <Result>(run: () => Promise<Result>): Promise<{
  readonly result: Result | null;
  readonly error: unknown;
  readonly durationMs: number;
}> => {
  const started = performance.now();
  try {
    return { result: await run(), error: null, durationMs: performance.now() - started };
  } catch (error) {
    return { result: null, error, durationMs: performance.now() - started };
  }
};

const constrainedAttempt = async (
  sequence: number,
  model: BenchmarkModel,
  input: BenchmarkInput,
  fixtureSet: FixtureSet,
  adapters: Adapters,
): Promise<{ readonly attempt: BenchmarkAttempt; readonly creditsExhausted: boolean }> => {
  const measured = model === "jev"
    ? await providerAttempt(() => Effect.runPromise(adapters.jev.decide(buildJevBenchmarkRequest(input))))
    : await providerAttempt(() => Effect.runPromise(adapters.ministral.complete(buildMinistralBenchmarkRequest(input))));
  const expectation = fixtureSet.expectations[input.caseId]!;
  const result = measured.result;
  const prediction = result === null
    ? null
    : model === "jev"
      ? extractJevPrediction((result as JevResult).answers)
      : extractMinistralPrediction((result as MinistralResult).toolCalls);
  const valid = prediction !== null && isAllowedPrediction(input, prediction);
  const outcome: BenchmarkOutcome = measured.error !== null ? "failure" : valid ? "success" : "invalid";
  const providerError = isProviderError(measured.error) ? measured.error : null;
  const correct = outcome === "success" && prediction === expectation.expected;
  return {
    attempt: {
      sequence,
      kind: "constrained",
      model,
      caseId: input.caseId,
      scenarioId: null,
      phase: "classification",
      outcome,
      completedWork: correct,
      durationMs: measured.durationMs,
      prediction,
      expected: expectation.expected,
      semanticSubtype: expectation.semanticSubtype ?? null,
      correct,
      unsafeExplicitApproval: input.task === "consent" && expectation.expected !== "explicit" && prediction === "explicit",
      metadata: result !== null
        ? sanitizeMetadata((result as JevResult | MinistralResult).metadata)
        : providerError === null ? null : failureMetadata(model, providerError),
      error: measured.error === null ? null : errorRecord(measured.error),
    },
    creditsExhausted: providerError?.code === "credits_exhausted",
  };
};

const scenarioDefinitions = [
  {
    scenarioId: "s01",
    toolName: "getOrder",
    expectedArguments: { orderId: "BB-1042" },
    prompt: "Inspect order BB-1042 and summarize the evidence that needs review.",
  },
  {
    scenarioId: "s02",
    toolName: "listOrders",
    expectedArguments: { status: "ready" },
    prompt: "List the orders that are ready, then summarize what the operator can review.",
  },
] as const;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const runScenario = async (
  definition: (typeof scenarioDefinitions)[number],
  startSequence: number,
  adapters: Adapters,
  repository: WorkspaceRepositoryService,
  onAttempt: (attempt: BenchmarkAttempt) => Promise<void>,
): Promise<{ readonly result: ScenarioResult; readonly creditsExhausted: boolean; readonly requestCount: number }> => {
  const registry = makeToolRegistry(toolHandlers);
  const modelTool = modelToolsFromRegistry(registry).find((candidate) => candidate.name === definition.toolName)!;
  const registered = registry[definition.toolName];
  const identity = Effect.runSync(resolveIdentity([], {
    environment: "development",
    host: "127.0.0.1",
    port: 0,
    publicOrigin: "http://127.0.0.1",
    databasePath: ":memory:",
    allowDevelopmentIdentity: true,
    developmentEmail: "provider-benchmark@example.invalid",
    agentMode: "scripted",
    openRouterApiKey: null,
  }));
  const scenarioStarted = performance.now();
  const firstRequest: MinistralRequest = {
    messages: [
      { role: "system", content: "Use the requested registered tool. Never accept or commit a proposal." },
      { role: "user", content: definition.prompt },
    ],
    tools: [modelTool],
    toolChoice: { name: definition.toolName },
    maxOutputTokens: benchmarkLimits.scenarioMaximumOutputTokens,
  };
  const first = await providerAttempt(() => Effect.runPromise(adapters.ministral.complete(firstRequest)));
  const firstError = isProviderError(first.error) ? first.error : null;
  const firstCall = first.result?.toolCalls.length === 1 ? first.result.toolCalls[0] : null;
  const firstValid = firstCall?.name === definition.toolName
    && modelTool.validateArguments(firstCall.arguments)
    && isDeepStrictEqual(firstCall.arguments, definition.expectedArguments);
  await onAttempt({
    sequence: startSequence,
    kind: "scenario_request",
    model: "ministral",
    caseId: null,
    scenarioId: definition.scenarioId,
    phase: "tool_request",
    outcome: first.error !== null ? "failure" : firstValid ? "success" : "invalid",
    completedWork: first.error === null && firstValid,
    durationMs: first.durationMs,
    prediction: firstCall?.name ?? null,
    expected: definition.toolName,
    semanticSubtype: null,
    correct: first.error === null && firstValid,
    unsafeExplicitApproval: false,
    metadata: first.result !== null ? sanitizeMetadata(first.result.metadata) : firstError === null ? null : failureMetadata("ministral", firstError),
    error: first.error === null ? null : errorRecord(first.error),
  });
  if (firstError?.code === "credits_exhausted") {
    return {
      result: { scenarioId: definition.scenarioId, outcome: "incomplete", durationMs: performance.now() - scenarioStarted, attemptedRequests: 1, completedRequests: 0, expectedTool: definition.toolName, expectedArguments: definition.expectedArguments, selectedTool: firstCall?.name ?? null, selectedArguments: firstCall?.arguments ?? null, toolOutput: null, finalResponse: null, failure: "credits_exhausted" },
      creditsExhausted: true,
      requestCount: 1,
    };
  }
  if (!firstValid || firstCall === null) {
    return {
      result: { scenarioId: definition.scenarioId, outcome: "incomplete", durationMs: performance.now() - scenarioStarted, attemptedRequests: 1, completedRequests: 0, expectedTool: definition.toolName, expectedArguments: definition.expectedArguments, selectedTool: firstCall?.name ?? null, selectedArguments: firstCall?.arguments ?? null, toolOutput: null, finalResponse: null, failure: first.error === null ? "invalid_tool_request" : "provider_failure" },
      creditsExhausted: false,
      requestCount: 1,
    };
  }

  let toolOutput: unknown;
  try {
    toolOutput = await registered.execute({
      repository,
      identity,
      generation: 1,
      turnId: "benchmark-turn",
      requestId: "benchmark-request",
      runJev: async () => { throw new Error("The selected read-only benchmark tool must not call Jev."); },
      requestUi: async () => ({ applied: false, message: "The benchmark has no browser UI." }),
    }, firstCall.arguments);
  } catch {
    return {
      result: { scenarioId: definition.scenarioId, outcome: "incomplete", durationMs: performance.now() - scenarioStarted, attemptedRequests: 1, completedRequests: 1, expectedTool: definition.toolName, expectedArguments: definition.expectedArguments, selectedTool: firstCall.name, selectedArguments: firstCall.arguments, toolOutput: null, finalResponse: null, failure: "tool_execution_failed" },
      creditsExhausted: false,
      requestCount: 1,
    };
  }

  const secondRequest: MinistralRequest = {
    messages: [
      ...firstRequest.messages,
      { role: "assistant", content: first.result!.content, toolCalls: first.result!.toolCalls },
      { role: "tool", toolCallId: firstCall.id, content: JSON.stringify({ ok: true, result: toolOutput }) },
    ],
    maxOutputTokens: benchmarkLimits.scenarioMaximumOutputTokens,
  };
  const second = await providerAttempt(() => Effect.runPromise(adapters.ministral.complete(secondRequest)));
  const secondError = isProviderError(second.error) ? second.error : null;
  const secondValid = second.result !== null
    && second.result.toolCalls.length === 0
    && scenarioResponseHasExpectedFacts(definition.toolName, second.result.content, toolOutput);
  await onAttempt({
    sequence: startSequence + 1,
    kind: "scenario_request",
    model: "ministral",
    caseId: null,
    scenarioId: definition.scenarioId,
    phase: "final_response",
    outcome: second.error !== null ? "failure" : secondValid ? "success" : "invalid",
    completedWork: second.error === null && secondValid,
    durationMs: second.durationMs,
    prediction: null,
    expected: null,
    semanticSubtype: null,
    correct: second.error === null && secondValid,
    unsafeExplicitApproval: false,
    metadata: second.result !== null ? sanitizeMetadata(second.result.metadata) : secondError === null ? null : failureMetadata("ministral", secondError),
    error: second.error === null ? null : errorRecord(second.error),
  });
  return {
    result: {
      scenarioId: definition.scenarioId,
      outcome: secondValid ? "success" : "incomplete",
      durationMs: performance.now() - scenarioStarted,
      attemptedRequests: 2,
      completedRequests: 1 + (secondValid ? 1 : 0),
      expectedTool: definition.toolName,
      expectedArguments: definition.expectedArguments,
      selectedTool: firstCall.name,
      selectedArguments: firstCall.arguments,
      toolOutput,
      finalResponse: second.result?.content ?? null,
      failure: secondValid ? null : secondError?.code ?? "invalid_final_response",
    },
    creditsExhausted: secondError?.code === "credits_exhausted",
    requestCount: 2,
  };
};

const percent = (value: number | null) => value === null ? "unknown" : `${(value * 100).toFixed(1)}%`;
const milliseconds = (value: number | null) => value === null ? "unknown" : value.toFixed(1);

const markdownReport = (
  manifest: Record<string, unknown>,
  fixtureSet: FixtureSet,
  attempts: ReadonlyArray<BenchmarkAttempt>,
  scenarios: ReadonlyArray<ScenarioResult>,
  stopReason: string,
) => {
  const summary = summarizeBenchmark(fixtureSet, attempts, scenarios);
  const lines = [
    "# Bounded provider benchmark",
    "",
    `Mode: ${manifest.mode}`,
    "",
    `Measured revision: ${manifest.revision}`,
    "",
    `Fixture digest: ${fixtureSet.digest}`,
    "",
    `Stop reason: ${stopReason}`,
    "",
    `Attempted requests: ${attempts.length} of at most ${benchmarkLimits.maximumTotalRequests}`,
    "",
    "This deliberate sample covers only the listed synthetic cases. It does not establish broad model speed or quality.",
    "",
    "The fixed order was Jev followed by Ministral. Order effects were not randomized in this run.",
    "",
    "The tool results below measure a two-request benchmark sequence with real registry validation and local read-only tool execution. They are not app server-turn or browser Send-to-completed-work timings. Live browser timing was not measured by this command.",
    "",
    "## Constrained classifications",
    "",
    "| Model | Attempted / planned | Valid | Failed or invalid | Accuracy over attempts | Accuracy over valid responses | Unsafe explicit approvals | Provider response p50 / p95, ms | Correct work p50 / p95, ms | Input / output tokens | Cost known / unknown |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const model of benchmarkLimits.constrainedModels) {
    const value = summary.constrainedByModel[model]!;
    lines.push(`| ${model} | ${value.attempted} / ${value.plannedFixtures} | ${value.validResponses} | ${value.failures + value.invalidResponses} | ${percent(value.attemptedAccuracy)} (${value.correct}/${value.attempted}) | ${percent(value.responseOnlyAccuracy)} (${value.correct}/${value.validResponses}) | ${value.unsafeExplicitApprovals.count}/${value.unsafeExplicitApprovals.denominator}, missing or invalid ${value.unsafeExplicitApprovals.missingOrInvalid} | ${milliseconds(value.validProviderResponseLatencyMs.p50)} / ${milliseconds(value.validProviderResponseLatencyMs.p95)} (n=${value.validProviderResponseLatencyMs.sampleCount}, nearest-rank) | ${milliseconds(value.correctCompletedWorkLatencyMs.p50)} / ${milliseconds(value.correctCompletedWorkLatencyMs.p95)} (n=${value.correctCompletedWorkLatencyMs.sampleCount}, nearest-rank) | ${value.usage.inputTokens.knownSubtotal} / ${value.usage.outputTokens.knownSubtotal} (${value.usage.inputTokens.unknownCount} / ${value.usage.outputTokens.unknownCount} unknown) | $${value.usage.costUsd.knownSubtotal.toFixed(8)} / ${value.usage.costUsd.unknownCount} |`);
  }
  const scenario = summary.scenarioSequences;
  lines.push(
    "",
    "## Tool scenario sequences",
    "",
    `Completed sequences: ${scenario.completed}/${scenario.attempted} attempted, ${scenario.planned} planned.`,
    "",
    `Valid provider-response latency: p50 ${milliseconds(scenario.validProviderResponseLatencyMs.p50)} ms, p95 ${milliseconds(scenario.validProviderResponseLatencyMs.p95)} ms, n=${scenario.validProviderResponseLatencyMs.sampleCount}, nearest-rank.`,
    "",
    `Completed sequence latency: p50 ${milliseconds(scenario.completedSequenceLatencyMs.p50)} ms, p95 ${milliseconds(scenario.completedSequenceLatencyMs.p95)} ms, n=${scenario.completedSequenceLatencyMs.sampleCount}, nearest-rank.`,
    "",
    `Known scenario cost subtotal: $${scenario.usage.costUsd.knownSubtotal.toFixed(8)}. Unknown cost count: ${scenario.usage.costUsd.unknownCount}.`,
    "",
    `Known scenario input/output token subtotals: ${scenario.usage.inputTokens.knownSubtotal}/${scenario.usage.outputTokens.knownSubtotal}. Unknown input/output counts: ${scenario.usage.inputTokens.unknownCount}/${scenario.usage.outputTokens.unknownCount}.`,
    "",
    "Every attempted request and failure is in `attempts.json`. Machine-readable summaries are in `report.json`.",
    "",
  );
  return lines.join("\n");
};

const main = async () => {
  const options = parseArguments(process.argv.slice(2));
  const repositoryRoot = process.cwd();
  const outputRelative = relative(repositoryRoot, options.outputDir);
  if (options.mode === "live") {
    if (!options.confirmLive) throw new Error("Live mode requires --confirm-live.");
    if (process.env.CI) throw new Error("Live mode is disabled in CI.");
    if (outputRelative === "" || (!outputRelative.startsWith("..") && !outputRelative.includes(":"))) {
      throw new Error("Live benchmark output must be outside the repository.");
    }
  }
  await mkdir(options.outputDir, { recursive: true, mode: 0o700 });
  if ((await readdir(options.outputDir)).length !== 0) throw new Error("Benchmark output directory must be empty.");

  const inputPath = resolve(repositoryRoot, "benchmarks/constrained-inputs.json");
  const expectationPath = resolve(repositoryRoot, "benchmarks/constrained-expectations.json");
  const [inputBytes, expectationBytes] = await Promise.all([
    readFile(inputPath, "utf8"),
    readFile(expectationPath, "utf8"),
  ]);
  const fixtureSet = parseFixtureSet(inputBytes, expectationBytes);
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const dirty = execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim().length > 0;
  if (options.mode === "live" && dirty) throw new Error("Live mode requires a clean checkout so the fixture digest and measured revision are fixed.");

  const manifest = {
    schemaVersion: 1,
    mode: options.mode,
    revision,
    dirty,
    fixtureDigest: fixtureSet.digest,
    inputFiles: ["benchmarks/constrained-inputs.json", "benchmarks/constrained-expectations.json"],
    fixedModelOrder: benchmarkLimits.constrainedModels,
    fixedFixtureOrder: fixtureSet.inputs.map((input) => input.caseId),
    limits: benchmarkLimits,
    environment: {
      platform: platform(),
      architecture: arch(),
      availableCpus: availableParallelism(),
      totalMemoryBytes: totalmem(),
      node: process.version,
      browser: null,
    },
    startedAt: new Date().toISOString(),
  } as const;
  await atomicJson(join(options.outputDir, "manifest.json"), manifest);

  const key = options.mode === "live" ? process.env.OPENROUTER_API_KEY?.trim() : null;
  if (options.mode === "live" && !key) throw new Error("OPENROUTER_API_KEY is required in the process environment for live mode.");
  const adapters = options.mode === "live" ? liveAdapters(key!) : fixtureAdapters(fixtureSet);
  const attempts: Array<BenchmarkAttempt> = [];
  const scenarios: Array<ScenarioResult> = [];
  const attemptsPath = join(options.outputDir, "attempts.json");
  const persistAttempts = async () => atomicJson(attemptsPath, { schemaVersion: 1, fixtureDigest: fixtureSet.digest, attempts });
  await persistAttempts();
  const runStarted = performance.now();
  let stopReason = "completed";
  let sequence = 1;

  constrained: for (const model of benchmarkLimits.constrainedModels) {
    for (const input of fixtureSet.inputs) {
      if (performance.now() - runStarted >= benchmarkLimits.maximumRunDurationMs) {
        stopReason = "run_timeout";
        break constrained;
      }
      const measured = await constrainedAttempt(sequence++, model, input, fixtureSet, adapters);
      attempts.push(measured.attempt);
      await persistAttempts();
      if (measured.creditsExhausted) {
        stopReason = "credits_exhausted";
        break constrained;
      }
    }
  }

  const temporaryDatabase = await mkdtemp(join(tmpdir(), "parcel-hopscotch-benchmark-"));
  try {
    if (stopReason === "completed") {
      await runWithWorkspaceRepository(join(temporaryDatabase, "workspace.sqlite"), Effect.gen(function* () {
        const repository = yield* WorkspaceRepository;
        for (const definition of scenarioDefinitions) {
          if (performance.now() - runStarted >= benchmarkLimits.maximumRunDurationMs) {
            stopReason = "run_timeout";
            break;
          }
          const run = yield* Effect.promise(() => runScenario(definition, sequence, adapters, repository, async (attempt) => {
            attempts.push(attempt);
            await persistAttempts();
          }));
          scenarios.push(run.result);
          sequence += run.requestCount;
          if (run.creditsExhausted) {
            stopReason = "credits_exhausted";
            break;
          }
        }
      }));
    }
  } finally {
    await rm(temporaryDatabase, { recursive: true, force: true });
  }

  const summary = summarizeBenchmark(fixtureSet, attempts, scenarios);
  const completedAt = new Date().toISOString();
  await atomicJson(join(options.outputDir, "report.json"), {
    schemaVersion: 1,
    manifest,
    completedAt,
    stopReason,
    attemptedRequests: attempts.length,
    maximumRequests: benchmarkLimits.maximumTotalRequests,
    scenarios,
    summary,
  });
  await writeFile(
    join(options.outputDir, "report.md"),
    markdownReport(manifest, fixtureSet, attempts, scenarios, stopReason),
    { encoding: "utf8", mode: 0o600 },
  );
  process.stdout.write(`${JSON.stringify({ outputDir: options.outputDir, revision, fixtureDigest: fixtureSet.digest, attemptedRequests: attempts.length, stopReason })}\n`);

  const constrainedComplete = benchmarkLimits.constrainedModels.every((model) => summary.constrainedByModel[model]!.attempted === fixtureSet.inputs.length);
  if (stopReason !== "completed" || !constrainedComplete || summary.scenarioSequences.completed !== benchmarkLimits.scenarioCount) process.exitCode = 2;
};

await main();
