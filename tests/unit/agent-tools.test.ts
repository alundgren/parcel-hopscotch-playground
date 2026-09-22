import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { ClientMessage } from "../../src/shared/contracts";
import { isRegisteredTarget, targets } from "../../src/shared/targets";
import { findRegisteredTool, makeToolRegistry, modelToolsFromRegistry, toolCatalogueMetadata } from "../../src/server/tool-registry";
import { toolHandlers } from "../../src/server/tool-handlers";

describe("agent tool registry", () => {
  const registry = makeToolRegistry(toolHandlers);

  it("derives model tools and catalogue metadata from one strict registry", () => {
    const tools = modelToolsFromRegistry(registry);
    expect(tools.map((tool) => tool.name)).toEqual(toolCatalogueMetadata.map((tool) => tool.id));
    expect(tools).toHaveLength(14);
    expect(tools.map((tool) => String(tool.name))).not.toContain("acceptProposal");
    expect(toolCatalogueMetadata.every((tool) => tool.allowedEffects.length > 0 && tool.example !== undefined)).toBe(true);
  });

  it("rejects injected identity, arbitrary selectors, extra fields, and inherited names", () => {
    const tools = Object.fromEntries(modelToolsFromRegistry(registry).map((tool) => [tool.name, tool]));
    expect(tools.getOrder?.validateArguments({ orderId: "BB-1042" })).toBe(true);
    expect(tools.getOrder?.validateArguments({ orderId: "BB-1042", userId: "another-user" })).toBe(false);
    expect(tools.navigate?.validateArguments({ view: "work", url: "https://example.test" })).toBe(false);
    expect(tools.highlight?.validateArguments({ target: "#app", selector: "body" })).toBe(false);
    expect(tools.prepareBatch?.validateArguments({ commit: true })).toBe(false);
    expect(findRegisteredTool(registry, "constructor")).toBeNull();
    expect(findRegisteredTool(registry, "accept_proposal")).toBeNull();
  });

  it("rejects excess realtime fields before dispatch", () => {
    expect(() => Schema.decodeUnknownSync(ClientMessage, { onExcessProperty: "error" })({
      type: "send_agent_turn",
      requestId: "req",
      generation: 1,
      turnId: "turn_12345678",
      message: "Show my work",
      userId: "another-user",
    })).toThrow();
  });

  it("recognizes only application-owned targets", () => {
    expect(isRegisteredTarget(targets.orderEvidence("BB-1042"), ["BB-1042"])).toBe(true);
    expect(isRegisteredTarget("#target-order-BB-1042-evidence", ["BB-1042"])).toBe(false);
    expect(isRegisteredTarget("javascript:alert(1)", ["BB-1042"])).toBe(false);
  });
});
