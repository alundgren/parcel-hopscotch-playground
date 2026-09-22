import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  buildJevBenchmarkRequest,
  buildMinistralBenchmarkRequest,
  fixtureDigest,
  isAllowedPrediction,
  nearestRankPercentile,
  parseFixtureSet,
  scenarioResponseHasExpectedFacts,
  summarizeBenchmark,
  taskText,
  type BenchmarkAttempt,
  type FixtureSet,
  type SanitizedProviderMetadata,
} from "../../src/server/provider-benchmark";

const inputBytes = readFileSync("benchmarks/constrained-inputs.json", "utf8");
const expectationBytes = readFileSync("benchmarks/constrained-expectations.json", "utf8");
const fixtures = parseFixtureSet(inputBytes, expectationBytes);

const metadata = (costUsd: number | null): SanitizedProviderMetadata => ({
  provider: "Fixture",
  requestedModel: "fixture/requested",
  actualModel: "fixture/actual",
  providerRequestId: null,
  generationId: null,
  requestBytes: 10,
  responseBytes: 10,
  usage: { inputTokens: 4, outputTokens: 2, totalTokens: 6, costUsd },
});

const attempt = (overrides: Partial<BenchmarkAttempt>): BenchmarkAttempt => ({
  sequence: 1,
  kind: "constrained",
  model: "jev",
  caseId: "c01",
  scenarioId: null,
  phase: "classification",
  outcome: "success",
  completedWork: true,
  durationMs: 10,
  prediction: "explicit",
  expected: "explicit",
  semanticSubtype: null,
  correct: true,
  unsafeExplicitApproval: false,
  metadata: metadata(0.1),
  error: null,
  ...overrides,
});

describe("provider benchmark fixtures", () => {
  it("freezes the reconciled twelve-case contract with neutral correlation IDs", () => {
    expect(fixtures.inputs).toHaveLength(12);
    expect(fixtures.inputs.map((input) => input.caseId)).toEqual([
      "c01", "c02", "c03", "c04", "c05", "c06", "c07", "c08", "c09", "c10", "c11", "c12",
    ]);
    expect(fixtures.expectations.c04).toEqual({ expected: "unclear", semanticSubtype: "declined" });
    expect(fixtures.expectations.c08).toEqual({ expected: "substitution", semanticSubtype: "stock" });
    expect(fixtures.digest).toBe(fixtureDigest(inputBytes, expectationBytes));
  });

  it("builds equivalent task text without sending IDs or expectations", () => {
    for (const input of fixtures.inputs) {
      const jev = buildJevBenchmarkRequest(input);
      const ministral = buildMinistralBenchmarkRequest(input);
      expect((jev.state as { task: string }).task).toBe(taskText(input));
      expect(ministral.messages[1]).toEqual({ role: "user", content: taskText(input) });
      expect(JSON.stringify(jev)).not.toContain(input.caseId);
      expect(JSON.stringify(ministral)).not.toContain(input.caseId);
      expect(JSON.stringify(jev)).not.toContain("semanticSubtype");
      expect(JSON.stringify(ministral)).not.toContain("semanticSubtype");
    }
  });

  it("rejects inherited object keys as model choices and fixture expectations", () => {
    expect(isAllowedPrediction(fixtures.inputs[0]!, "constructor")).toBe(false);
    const malicious = JSON.parse(expectationBytes) as Record<string, { expected: string }>;
    malicious.c01 = { expected: "constructor" };
    expect(() => parseFixtureSet(inputBytes, JSON.stringify(malicious))).toThrow("not an allowed choice");
  });
});

describe("provider benchmark reporting", () => {
  it("keeps response latency, correct work, failures, unsafe approvals, and unknown cost separate", () => {
    const attempts = [
      attempt({ sequence: 1, caseId: "c01", durationMs: 10 }),
      attempt({
        sequence: 2,
        caseId: "c02",
        durationMs: 20,
        prediction: "explicit",
        expected: "conditional",
        correct: false,
        completedWork: false,
        unsafeExplicitApproval: true,
        metadata: metadata(null),
      }),
      attempt({
        sequence: 3,
        caseId: "c03",
        durationMs: 30,
        outcome: "failure",
        prediction: null,
        expected: "conditional",
        correct: false,
        completedWork: false,
        metadata: null,
        error: { code: "timeout", status: null, billableUnknown: true },
      }),
    ];
    const summary = summarizeBenchmark(fixtures, attempts, []);
    const jev = summary.constrainedByModel.jev!;
    expect(jev.attemptedAccuracy).toBeCloseTo(1 / 3);
    expect(jev.responseOnlyAccuracy).toBe(0.5);
    expect(jev.unsafeExplicitApprovals).toEqual({ count: 1, denominator: 2, rate: 0.5, missingOrInvalid: 1 });
    expect(jev.validProviderResponseLatencyMs).toEqual({ sampleCount: 2, percentileMethod: "nearest-rank", p50: 10, p95: 20 });
    expect(jev.correctCompletedWorkLatencyMs).toEqual({ sampleCount: 1, percentileMethod: "nearest-rank", p50: 10, p95: 10 });
    expect(jev.usage.costUsd).toEqual({ knownSubtotal: 0.1, unknownCount: 2 });
  });

  it("uses nearest-rank percentiles with the reported sample count", () => {
    expect(nearestRankPercentile([40, 10, 30, 20], 0.5)).toBe(20);
    expect(nearestRankPercentile([40, 10, 30, 20], 0.95)).toBe(40);
    expect(nearestRankPercentile([], 0.95)).toBeNull();
  });

  it("requires expected facts in the final scenario response", () => {
    const orderOutput = { order: { id: "BB-1042" } };
    expect(scenarioResponseHasExpectedFacts("getOrder", "BB-1042 needs review because the number is 41.", orderOutput)).toBe(true);
    expect(scenarioResponseHasExpectedFacts("getOrder", "The order is ready.", orderOutput)).toBe(false);
    const listOutput = { orders: [{ id: "BB-1051" }, { id: "BB-1063" }] };
    expect(scenarioResponseHasExpectedFacts("listOrders", "BB-1051 and BB-1063 are ready for review.", listOutput)).toBe(true);
    expect(scenarioResponseHasExpectedFacts("listOrders", "BB-1051 is ready for review.", listOutput)).toBe(false);
    expect(scenarioResponseHasExpectedFacts("listOrders", "BB-1051 and BB-1063 need attention.", listOutput)).toBe(false);
  });
});
