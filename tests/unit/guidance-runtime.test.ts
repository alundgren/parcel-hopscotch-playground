import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";
import {
  GuidanceContextByteLimit,
  GuidanceOfferRequest,
  GuidanceNoteRequest,
  GuidanceSession,
  guidanceUtf8Bytes,
} from "../../src/guidance/contracts.js";
import { makeGuidanceContext, discoverGuides, validateGuidanceOffer, validateGuidanceNote, type GuidanceModule } from "../../src/guidance/catalog.js";
import { beginGuidance, consentToGuidance, advanceGuidance, decodeSavedGuidance, dismissGuidance, encodeSavedGuidance, pauseGuidance, resumeGuidance } from "../../src/guidance/runtime.js";

const origin = { view: "work", focusKind: "proposal", focusId: "old-proposal", filter: "ready" } as const;
const steps = [
  { id: "inspect", destination: "order", targetId: "item-1-evidence", entityId: "item-1", instruction: "Inspect current evidence.", eventKind: "destination_ready", completion: "target" },
  { id: "prepare", destination: "order", targetId: "item-1-review", entityId: "item-1", instruction: "Request a fresh review.", eventKind: "proposal_prepared", completion: "result" },
  { id: "accept", destination: "work", targetId: "item-1-proposal", entityId: "item-1", instruction: "Accept the reviewed change.", eventKind: "proposal_accepted", completion: "bound_result" },
] as const;

const offered = () => beginGuidance({ sessionId: "browser-session-a", contextRef: "context-1", guideRef: "guide-1", guideId: "test-guide", guideVersion: 1, title: "Test guide", offerText: "I can show you this item.", generation: 3, entityId: "item-1", operationId: "guide-operation-1", origin, steps });
const event = (kind: string, extras: Record<string, unknown> = {}) => ({
  sessionId: "browser-session-a", contextRef: "context-1", generation: 3, entityId: "item-1", operationId: "guide-operation-1", kind, verified: true, ...extras,
});

describe("guidance session", () => {
  it("requires consent and then exact registered target readiness", () => {
    const initial = offered();
    expect(advanceGuidance(initial, event("destination_ready", { targetId: "item-1-evidence" }))).toEqual(initial);
    const active = consentToGuidance(initial);
    expect(advanceGuidance(active, event("destination_ready", { targetId: "other-evidence" }))).toEqual(active);
    expect(advanceGuidance(active, event("destination_ready", { targetId: "item-1-evidence" })).stepIndex).toBe(1);
  });

  it("rejects wrong entity, operation, context, generation, and another browser session", () => {
    const active = consentToGuidance(offered());
    for (const mismatch of [
      { entityId: "item-2" },
      { operationId: "guide-operation-2" },
      { contextRef: "context-2" },
      { generation: 4 },
      { sessionId: "browser-session-b" },
    ]) {
      expect(advanceGuidance(active, event("destination_ready", { targetId: "item-1-evidence", ...mismatch }))).toEqual(active);
    }
  });

  it("binds acceptance to the fresh prepared proposal", () => {
    const afterInspect = advanceGuidance(consentToGuidance(offered()), event("destination_ready", { targetId: "item-1-evidence" }));
    const afterPrepare = advanceGuidance(afterInspect, event("proposal_prepared", { resultId: "fresh-proposal" }));
    expect(afterPrepare.boundResultId).toBe("fresh-proposal");
    expect(advanceGuidance(afterPrepare, event("proposal_accepted", { resultId: "old-proposal" }))).toEqual(afterPrepare);
    expect(advanceGuidance(afterPrepare, event("proposal_accepted", { resultId: "other-proposal" }))).toEqual(afterPrepare);
    expect(advanceGuidance(afterPrepare, event("proposal_accepted", { resultId: "fresh-proposal" })).phase).toBe("complete");
  });

  it("strictly decodes saved sessions, pauses reload, and requires explicit resume", () => {
    const active = consentToGuidance(offered());
    const restored = decodeSavedGuidance(encodeSavedGuidance(active), () => 1);
    expect(restored?.phase).toBe("paused");
    expect(advanceGuidance(restored!, event("destination_ready", { targetId: "item-1-evidence" }))).toEqual(restored);
    expect(resumeGuidance(restored!).phase).toBe("active");
    expect(pauseGuidance(active).phase).toBe("paused");
    expect(dismissGuidance(active)).toBeNull();
    expect(decodeSavedGuidance(JSON.stringify({ ...active, version: 2 }), () => 1)).toBeNull();
    expect(decodeSavedGuidance(JSON.stringify({ ...active, extra: "hidden" }), () => 1)).toBeNull();
    expect(decodeSavedGuidance(encodeSavedGuidance(active), () => 2)).toBeNull();
    expect(decodeSavedGuidance(encodeSavedGuidance(active), () => null)).toBeNull();
    expect(decodeSavedGuidance(JSON.stringify({ ...active, stepIndex: 99 }), () => 1)).toBeNull();
    expect(() => Schema.decodeUnknownSync(GuidanceSession, { onExcessProperty: "error" })({ ...active, steps: [] })).toThrow();
  });
});

describe("guidance catalog", () => {
  const simpleModule: GuidanceModule<null> = {
    id: "test", version: 1, facts: () => ["One bounded fact."],
    targets: () => [{ id: "target", label: "Target", destination: "work", entityId: "item-1", availability: { available: true, reason: null } }],
    guides: () => [{ id: "test-guide", version: 1, title: "Test guide", summary: "Inspect an item.", offerText: "I can show you this item.", entityId: "item-1", primaryTargetId: "target", steps }],
  };
  const revision = { generation: 3, sequence: 1, view: "work", entityId: "item-1", focusId: "item-1", problemId: "problem-1" } as const;

  it("validates opaque exact references and rejects missing targets", () => {
    const context = makeGuidanceContext([simpleModule], null, revision);
    const { contextRef, guides, targets } = context.publicContext;
    expect(validateGuidanceOffer(context, { contextRef, guideRef: guides[0]!.guideRef, targetRef: targets[0]!.targetRef }).kind).toBe("ok");
    expect(validateGuidanceOffer(context, { contextRef: "old", guideRef: guides[0]!.guideRef }).kind).toBe("stale");
    const changed = makeGuidanceContext([simpleModule], null, { ...revision, sequence: 2 });
    expect(validateGuidanceOffer(changed, { contextRef, guideRef: guides[0]!.guideRef }).kind).toBe("stale");
    const unavailable = makeGuidanceContext([{ ...simpleModule, targets: () => [{ id: "target", label: "Target", destination: "work", entityId: "item-1", availability: { available: false, reason: "Unavailable." } }] }], null, revision);
    expect(unavailable.publicContext.contextRef).not.toBe(contextRef);
    expect(validateGuidanceOffer(unavailable, { contextRef, guideRef: guides[0]!.guideRef }).kind).toBe("stale");
    const mounted = makeGuidanceContext([simpleModule], null, revision, ["target"]);
    expect(mounted.publicContext.contextRef).not.toBe(contextRef);
    expect(mounted.publicContext.targets[0]!.mounted).toBe(true);
    expect(validateGuidanceOffer(context, { contextRef, guideRef: "wrong" }).kind).toBe("invalid");
    expect(validateGuidanceNote(context, { contextRef, targetRef: "wrong", text: "Read here." }).kind).toBe("invalid");
    const noTarget = makeGuidanceContext([{ ...simpleModule, targets: () => [] }], null, revision);
    expect(validateGuidanceOffer(noTarget, { contextRef: noTarget.publicContext.contextRef, guideRef: noTarget.publicContext.guides[0]!.guideRef }).kind).toBe("invalid");
    expect(() => Schema.decodeUnknownSync(GuidanceOfferRequest, { onExcessProperty: "error" })({ contextRef, guideRef: guides[0]!.guideRef, selector: "#private" })).toThrow();
    expect(() => Schema.decodeUnknownSync(GuidanceNoteRequest, { onExcessProperty: "error" })({ contextRef, targetRef: targets[0]!.targetRef, text: "<b>hello</b>" })).toThrow();
    expect(JSON.parse(JSON.stringify(context))).toEqual({ publicContext: context.publicContext });
  });

  it("revises references for disabled mounted targets without trusting unknown IDs", () => {
    const mounted = makeGuidanceContext([simpleModule], null, revision, ["target"]);
    const disabled = makeGuidanceContext([simpleModule], null, revision, ["target"], ["target"]);
    expect(disabled.publicContext.targets[0]!.availability).toEqual({ available: false, reason: "This action is currently disabled." });
    expect(disabled.publicContext.contextRef).not.toBe(mounted.publicContext.contextRef);
    expect(validateGuidanceNote(disabled, { contextRef: mounted.publicContext.contextRef, targetRef: mounted.publicContext.targets[0]!.targetRef, text: "Read here." }).kind).toBe("stale");
    expect(validateGuidanceOffer(disabled, { contextRef: disabled.publicContext.contextRef, guideRef: disabled.publicContext.guides[0]!.guideRef }).kind).toBe("invalid");
    expect(makeGuidanceContext([simpleModule], null, revision, ["target"], ["unknown"]).publicContext.contextRef).toBe(mounted.publicContext.contextRef);
    expect(makeGuidanceContext([simpleModule], null, revision, [], ["target"]).publicContext.contextRef).toBe(makeGuidanceContext([simpleModule], null, revision).publicContext.contextRef);
  });

  it("keeps discovery and model context bounded with 1000 modules", () => {
    const modules = Array.from({ length: 1000 }, (_, index): GuidanceModule<null> => ({ ...simpleModule, id: `module-${index}`, guides: () => [{ ...simpleModule.guides(null)[0]!, id: `guide-${index}`, title: `Guide ${index}` }] }));
    const context = makeGuidanceContext(modules, null, revision);
    const found = discoverGuides(context, "Guide", 1000);
    expect(found.guides).toHaveLength(8);
    expect(found.hasMore).toBe(true);
    expect(guidanceUtf8Bytes(context.publicContext)).toBeLessThanOrEqual(GuidanceContextByteLimit);
    expect(context.publicContext.targets.length).toBeLessThanOrEqual(24);
    expect(context.publicContext.guides.length).toBeLessThanOrEqual(16);
  });

  it("caps discovery bytes even when eight entries have maximum-length text", () => {
    const verbose: GuidanceModule<null> = {
      ...simpleModule,
      guides: () => Array.from({ length: 20 }, (_, index) => ({ ...simpleModule.guides(null)[0]!, id: `verbose-${index}`, title: "A".repeat(240), summary: "B".repeat(240) })),
    };
    const result = discoverGuides(makeGuidanceContext([verbose], null, revision), "", 8);
    expect(result.guides.length).toBeLessThan(8);
    expect(result.hasMore).toBe(true);
    expect(guidanceUtf8Bytes(result)).toBeLessThanOrEqual(GuidanceContextByteLimit);
  });

  it("accepts a third module's destination and event without core changes", () => {
    const third = beginGuidance({ sessionId: "browser-session-c", contextRef: "context-c", guideRef: "guide-c", guideId: "third.guide", guideVersion: 7, title: "Third guide", offerText: "I can show you a third result.", generation: 3, entityId: "entity-c", operationId: "operation-c", origin: { view: "third-view", focusKind: null, focusId: null, filter: null }, steps: [{ id: "third-step", destination: "third-detail", targetId: "third-target", entityId: "entity-c", instruction: "Inspect this result.", eventKind: "third.result.verified", completion: "target" }] });
    const done = advanceGuidance(consentToGuidance(third), { sessionId: "browser-session-c", contextRef: "context-c", generation: 3, entityId: "entity-c", operationId: "operation-c", kind: "third.result.verified", targetId: "third-target", verified: true });
    expect(done.phase).toBe("complete");
  });
});
