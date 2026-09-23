import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import { ClientMessage } from "../../src/shared/contracts";
import { exploreScenarios } from "../../src/shared/explore";
import { isRegisteredTarget, targets } from "../../src/shared/targets";
import { findRegisteredTool, makeToolRegistry, modelToolsFromRegistry, toolCatalogueMetadata, validateToolCatalogueExamples } from "../../src/server/tool-registry";
import { toolHandlers } from "../../src/server/tool-handlers";
import { safeToolResult } from "../../src/server/agent-runtime";
import { GuidanceContextByteLimit, PublicGuidanceContext, guidanceUtf8Bytes } from "../../src/guidance/contracts";
import type { GuidanceContext } from "../../src/guidance/catalog";
import type { ToolContext } from "../../src/server/tool-registry";

describe("agent tool registry", () => {
  const registry = makeToolRegistry(toolHandlers);

  it("derives model tools and catalogue metadata from one strict registry", () => {
    const tools = modelToolsFromRegistry(registry);
    expect(tools.map((tool) => tool.name)).toEqual(toolCatalogueMetadata.map((tool) => tool.id));
    expect(tools).toHaveLength(20);
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["readGuidanceContext", "findGuides", "offerGuide", "showNote"]));
    expect(tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(["startTutorial", "stopTutorial"]));
    expect(tools.map((tool) => tool.name)).toContain("prepareReset");
    expect(tools.map((tool) => String(tool.name))).not.toContain("acceptProposal");
    expect(toolCatalogueMetadata.every((tool) => tool.allowedEffects.length > 0 && tool.example !== undefined)).toBe(true);
    expect(() => validateToolCatalogueExamples()).not.toThrow();
    const proposalExamples = Object.fromEntries(toolCatalogueMetadata
      .filter((tool) => ["prepareAddressCorrection", "prepareSubstitution", "prepareResolution", "prepareBatch", "prepareUndo"].includes(tool.id))
      .map((tool) => [tool.id, tool.example.result as { readonly changes: ReadonlyArray<{ readonly orderId: string; readonly family: string; readonly before: string; readonly after: string }> }]));
    expect(proposalExamples.prepareAddressCorrection?.changes[0]).toMatchObject({ orderId: "BB-1042", family: "address" });
    expect(proposalExamples.prepareSubstitution?.changes[0]).toMatchObject({ orderId: "BB-1051", family: "substitution", after: expect.stringContaining("Sage") });
    expect(proposalExamples.prepareResolution?.changes[0]).toMatchObject({ orderId: "BB-1090", family: "bundle" });
    expect(proposalExamples.prepareBatch?.changes[0]).toMatchObject({ orderId: "BB-1051", family: "substitution" });
    expect(proposalExamples.prepareUndo?.changes[0]).toMatchObject({ orderId: "BB-1051", family: "substitution", before: expect.stringContaining("Sage"), after: expect.stringContaining("Blue") });
    const groupResult = toolCatalogueMetadata.find((tool) => tool.id === "groupOrders")?.example.result as { readonly groups: ReadonlyArray<{ readonly count: number; readonly orderIds: ReadonlyArray<string> }> };
    expect(groupResult.groups.every((group) => group.count === group.orderIds.length)).toBe(true);
    const names = new Set(tools.map((tool) => tool.name));
    expect(exploreScenarios.flatMap((scenario) => scenario.tools).every((name) => names.has(name as never))).toBe(true);
  });

  it("rejects injected identity, arbitrary selectors, extra fields, and inherited names", () => {
    const tools = Object.fromEntries(modelToolsFromRegistry(registry).map((tool) => [tool.name, tool]));
    expect(tools.getOrder?.validateArguments({ orderId: "BB-1042" })).toBe(true);
    expect(tools.listOrders?.validateArguments({ status: "review", family: null })).toBe(true);
    expect(tools.listOrders?.validateArguments({ status: null, family: null, query: null })).toBe(true);
    expect(tools.listOrders?.validateArguments({ status: "invented", family: null })).toBe(false);
    expect(tools.listOrders?.validateArguments({ query: 12 })).toBe(false);
    expect(tools.getOrder?.validateArguments({ orderId: null })).toBe(false);
    expect(tools.getOrder?.validateArguments({ orderId: "BB-1042", userId: "another-user" })).toBe(false);
    expect(tools.navigate?.validateArguments({ view: "work", url: "https://example.test" })).toBe(false);
    expect(tools.highlight?.validateArguments({ target: "#app", selector: "body" })).toBe(false);
    expect(tools.prepareBatch?.validateArguments({ commit: true })).toBe(false);
    expect(tools.startTutorial?.validateArguments({ tutorialId: "address-correction" })).toBe(true);
    expect(tools.startTutorial?.validateArguments({ tutorialId: "invented-lesson", orderId: "BB-1042" })).toBe(false);
    expect(tools.offerGuide?.validateArguments({ contextRef: "ctx_1", guideRef: "g_1" })).toBe(true);
    expect(tools.offerGuide?.validateArguments({ contextRef: "ctx_1", guideRef: "g_1", route: "/orders/BB-1042" })).toBe(false);
    expect(tools.findGuides?.validateArguments({ query: "review", limit: 9 })).toBe(false);
    expect(tools.showNote?.validateArguments({ contextRef: "ctx_1", targetRef: "t_1", text: "Check this order." })).toBe(true);
    expect(tools.showNote?.validateArguments({ contextRef: "ctx_1", targetRef: "#order", text: "<b>Act</b>", selector: "#order" })).toBe(false);
    expect(tools.showNote?.validateArguments({ contextRef: "ctx_1", targetRef: "#order", text: "Check this order." })).toBe(false);
    expect(tools.showNote?.validateArguments({ contextRef: "ctx_1", targetRef: "t_1", text: "<b>Act</b>" })).toBe(false);
    expect(findRegisteredTool(registry, "constructor")).toBeNull();
    expect(findRegisteredTool(registry, "accept_proposal")).toBeNull();
  });

  it("keeps near-limit guidance context and stale results parseable in the existing tool budget", async () => {
    const targets: Array<{ targetRef: string; label: string; destination: "work"; entityId: null; mounted: boolean; availability: { available: boolean; reason: null } }> = [];
    const base = { version: 1 as const, contextRef: "ctx_current", generation: 1, view: "work" as const, entityId: null, facts: [] as string[], targets, guides: [] as Array<{ guideRef: string; title: string; summary: string; entityId: null }> };
    for (let index = 0; index < 24; index += 1) {
      const candidate = { targetRef: `t_ref_${index}`, label: "Current registered control ".padEnd(210, "x"), destination: "work" as const, entityId: null, mounted: true, availability: { available: true, reason: null } };
      targets.push(candidate);
      if (guidanceUtf8Bytes(base) > GuidanceContextByteLimit) { targets.pop(); break; }
    }
    expect(guidanceUtf8Bytes(base)).toBeGreaterThan(GuidanceContextByteLimit - 300);
    const publicContext = Schema.decodeUnknownSync(PublicGuidanceContext)(base);
    const guidance = { publicContext, guideEntries: [], targetEntries: [] } satisfies GuidanceContext;
    const toolContext = { getGuidanceContext: async () => guidance } as unknown as ToolContext;
    const read = await registry.readGuidanceContext.execute(toolContext, {});
    const wrappedRead = JSON.parse(safeToolResult("readGuidanceContext", read)) as { truncated?: boolean; result?: { contextRef?: string } };
    expect(wrappedRead).toMatchObject({ result: { contextRef: "ctx_current" } });
    expect(wrappedRead.truncated).toBeUndefined();
    const stale = await registry.offerGuide.execute(toolContext, { contextRef: "ctx_old", guideRef: "g_old" });
    const wrappedStale = JSON.parse(safeToolResult("offerGuide", stale)) as { truncated?: boolean; result?: { kind?: string; currentContext?: { contextRef?: string } } };
    expect(wrappedStale).toMatchObject({ result: { kind: "stale_context", currentContext: { contextRef: "ctx_current" } } });
    expect(wrappedStale.truncated).toBeUndefined();
  });

  it("rejects excess realtime fields before dispatch", () => {
    expect(() => Schema.decodeUnknownSync(ClientMessage, { onExcessProperty: "error" })({
      type: "send_agent_turn",
      requestId: "req",
      generation: 1,
      turnId: "turn_12345678",
      message: "Show my work",
      context: { view: "work", focus: null },
      userId: "another-user",
    })).toThrow();
    expect(() => Schema.decodeUnknownSync(ClientMessage, { onExcessProperty: "error" })({
      type: "send_agent_turn", requestId: "req-guidance", generation: 1, turnId: "turn_12345678-guidance", message: "Help",
      context: { view: "work", focus: null, guidance: { problem: { kind: "stale_review", proposalId: "proposal_1", reason: "stock_changed" } } },
    })).toThrow();
    expect(() => Schema.decodeUnknownSync(ClientMessage, { onExcessProperty: "error" })({
      type: "send_agent_turn", requestId: "req-guidance", generation: 1, turnId: "turn_12345678-guidance", message: "Help",
      context: { view: "work", focus: null, guidance: { visibleTargetIds: Array.from({ length: 25 }, (_, index) => `target_${index}`) } },
    })).toThrow();
    expect(() => Schema.decodeUnknownSync(ClientMessage, { onExcessProperty: "error" })({
      type: "send_agent_turn",
      requestId: "req-context",
      generation: 1,
      turnId: "turn_12345678-context",
      message: "Show this",
      context: { view: "work", focus: { kind: "order", orderId: "BB-1042", selector: "#app" } },
    })).toThrow();
    expect(() => Schema.decodeUnknownSync(ClientMessage)({
      type: "send_agent_turn",
      requestId: "req-missing-context",
      generation: 1,
      turnId: "turn_12345678-missing-context",
      message: "Show this",
    })).toThrow();
    expect(() => Schema.decodeUnknownSync(ClientMessage, { onExcessProperty: "error" })({
      type: "tutorial_action",
      requestId: "tutorial-injection",
      generation: 1,
      action: "order_selected",
      orderId: "BB-1042",
      userId: "another-user",
    })).toThrow();
  });

  it("recognizes only application-owned targets", () => {
    expect(isRegisteredTarget(targets.orderEvidence("BB-1042"), ["BB-1042"])).toBe(true);
    expect(isRegisteredTarget("#target-order-BB-1042-evidence", ["BB-1042"])).toBe(false);
    expect(isRegisteredTarget("javascript:alert(1)", ["BB-1042"])).toBe(false);
  });
});
