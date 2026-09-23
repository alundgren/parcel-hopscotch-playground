import {
  GuidanceContextByteLimit,
  GuidanceContextVersion,
  GuidanceDiscoveryLimit,
  GuidanceNoteRequest,
  GuidanceOfferRequest,
  GuidanceStep,
  PublicGuidanceContext,
  type GuidanceDestination,
  type GuidanceNote,
  type GuidanceOffer,
  type GuidanceValidation,
  decodeStrict,
  guidanceUtf8Bytes,
} from "./contracts.js";

export interface GuidanceTargetDefinition {
  readonly id: string;
  readonly label: string;
  readonly destination: GuidanceDestination;
  readonly entityId: string | null;
  readonly availability: { readonly available: boolean; readonly reason: string | null };
}

export interface GuidanceGuideDefinition {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly summary: string;
  readonly offerText: string;
  readonly entityId: string | null;
  readonly primaryTargetId: string;
  readonly steps: ReadonlyArray<GuidanceStep>;
}

export interface GuidanceModule<Input> {
  readonly id: string;
  readonly version: number;
  readonly facts: (input: Input) => ReadonlyArray<string>;
  readonly targets: (input: Input) => ReadonlyArray<GuidanceTargetDefinition>;
  readonly guides: (input: Input) => ReadonlyArray<GuidanceGuideDefinition>;
}

export interface GuidanceContext {
  readonly publicContext: PublicGuidanceContext;
  readonly guideEntries: ReadonlyArray<{ readonly ref: string; readonly guide: GuidanceGuideDefinition }>;
  readonly targetEntries: ReadonlyArray<{ readonly ref: string; readonly target: GuidanceTargetDefinition }>;
}

export interface GuidanceDiscovery {
  readonly guides: ReadonlyArray<{ readonly guideRef: string; readonly title: string; readonly summary: string; readonly entityId: string | null }>;
  readonly hasMore: boolean;
}

const opaqueRef = (prefix: string, index: number, revision: string): string =>
  `${prefix}_${revision}_${index.toString(36)}`;

const revisionOf = (value: unknown): string => {
  const source = JSON.stringify(value);
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
};

export const makeGuidanceContext = <Input>(
  modules: ReadonlyArray<GuidanceModule<Input>>,
  input: Input,
  revision: { readonly generation: number; readonly sequence: number; readonly view: string; readonly entityId: string | null; readonly focusId: string | null; readonly problemId: string | null },
  observedTargetIds: ReadonlyArray<string> = [],
): GuidanceContext => {
  const moduleVersions = modules.map((module) => [module.id, module.version]);
  const allTargets = modules.flatMap((module) => module.targets(input));
  const allGuides = modules.flatMap((module) => module.guides(input));
  const facts = modules.flatMap((module) => module.facts(input));
  const mounted = new Set(observedTargetIds.slice(0, 24).filter((id) =>
    allTargets.some((target) => target.id === id && (target.entityId === revision.entityId || target.entityId === null))));
  const contextRef = `ctx_${revisionOf({
    ...revision,
    moduleVersions,
    targets: allTargets.map((target) => ({ ...target, mounted: mounted.has(target.id) })),
    guides: allGuides,
    facts,
  })}`;
  const targetEntries = allTargets.map((target, index) => ({ ref: opaqueRef("t", index, contextRef.slice(4)), target }));
  const guideEntries = allGuides.map((guide, index) => ({ ref: opaqueRef("g", index, contextRef.slice(4)), guide }));
  const base = {
    version: GuidanceContextVersion,
    contextRef,
    generation: revision.generation,
    view: revision.view,
    entityId: revision.entityId,
    facts: [] as string[],
    targets: [] as Array<{ targetRef: string; label: string; destination: GuidanceDestination; entityId: string | null; mounted: boolean; availability: { available: boolean; reason: string | null } }>,
    guides: [] as Array<{ guideRef: string; title: string; summary: string; entityId: string | null }>,
  };
  const fits = (): boolean => guidanceUtf8Bytes(base) <= GuidanceContextByteLimit;
  for (const fact of facts.slice(0, 8)) {
    base.facts.push(fact);
    if (!fits()) { base.facts.pop(); break; }
  }
  for (const { ref, target } of targetEntries.slice(0, 24)) {
    base.targets.push({ targetRef: ref, label: target.label, destination: target.destination, entityId: target.entityId, mounted: mounted.has(target.id), availability: target.availability });
    if (!fits()) { base.targets.pop(); break; }
  }
  for (const { ref, guide } of guideEntries.slice(0, 16)) {
    base.guides.push({ guideRef: ref, title: guide.title, summary: guide.summary, entityId: guide.entityId });
    if (!fits()) { base.guides.pop(); break; }
  }
  const publicContext = decodeStrict(PublicGuidanceContext, base);
  const context = { publicContext } as GuidanceContext;
  Object.defineProperties(context, {
    guideEntries: { value: guideEntries },
    targetEntries: { value: targetEntries },
  });
  return context;
};

export const discoverGuides = (context: GuidanceContext, query = "", limit = GuidanceDiscoveryLimit): GuidanceDiscovery => {
  const needle = query.trim().toLocaleLowerCase().slice(0, 80);
  const boundedLimit = Math.min(GuidanceDiscoveryLimit, Math.max(1, Math.floor(limit)));
  const matches = context.guideEntries.filter(({ guide }) =>
    needle === "" || `${guide.title} ${guide.summary}`.toLocaleLowerCase().includes(needle));
  const guides: Array<{ guideRef: string; title: string; summary: string; entityId: string | null }> = [];
  for (const { ref, guide } of matches) {
    if (guides.length === boundedLimit) break;
    guides.push({ guideRef: ref, title: guide.title, summary: guide.summary, entityId: guide.entityId });
    if (guidanceUtf8Bytes({ guides, hasMore: true }) > GuidanceContextByteLimit) { guides.pop(); break; }
  }
  return { guides, hasMore: matches.length > guides.length };
};

export const validateGuidanceOffer = (context: GuidanceContext, request: unknown): GuidanceValidation<GuidanceOffer> => {
  let value: GuidanceOfferRequest;
  try { value = decodeStrict(GuidanceOfferRequest, request); } catch { return { kind: "invalid", reason: "Invalid guidance offer." }; }
  if (value.contextRef !== context.publicContext.contextRef) return { kind: "stale", currentContext: context.publicContext };
  const selected = context.guideEntries.find(({ ref }) => ref === value.guideRef);
  if (selected === undefined) return { kind: "invalid", reason: "Guide reference is unavailable." };
  const target = context.targetEntries.find(({ ref, target }) =>
    ref === (value.targetRef ?? context.targetEntries.find((entry) => entry.target.id === selected.guide.primaryTargetId && entry.target.entityId === selected.guide.entityId)?.ref) &&
    target.id === selected.guide.primaryTargetId && target.entityId === selected.guide.entityId);
  if (target === undefined) return { kind: "invalid", reason: "Guide target is unavailable." };
  if (!target.target.availability.available) return { kind: "invalid", reason: target.target.availability.reason ?? "Guide target is unavailable." };
  return { kind: "ok", value: { guideRef: selected.ref, guideId: selected.guide.id, guideVersion: selected.guide.version, title: selected.guide.title, offerText: selected.guide.offerText, targetRef: target.ref, targetId: target.target.id, entityId: selected.guide.entityId, steps: selected.guide.steps } };
};

export const validateGuidanceNote = (context: GuidanceContext, request: unknown): GuidanceValidation<GuidanceNote> => {
  let value: GuidanceNoteRequest;
  try { value = decodeStrict(GuidanceNoteRequest, request); } catch { return { kind: "invalid", reason: "Invalid guidance note." }; }
  if (value.contextRef !== context.publicContext.contextRef) return { kind: "stale", currentContext: context.publicContext };
  const target = context.targetEntries.find(({ ref }) => ref === value.targetRef);
  if (target === undefined) return { kind: "invalid", reason: "Target reference is unavailable." };
  if (!target.target.availability.available) return { kind: "invalid", reason: target.target.availability.reason ?? "Target is unavailable." };
  return { kind: "ok", value: { targetRef: target.ref, targetId: target.target.id, entityId: target.target.entityId, text: value.text } };
};
