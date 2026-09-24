import { Schema } from "effect";

const Ref = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(240));
const Entity = Schema.NullOr(Ref);
const Version = Schema.Int.check(Schema.isGreaterThan(0));

export const GuidanceContextVersion = 1;
export const GuidanceSessionVersion = 1;
export const GuidanceContextByteLimit = 3_072;
export const GuidanceDiscoveryLimit = 8;

export const GuidanceDestination = Ref;
export type GuidanceDestination = typeof GuidanceDestination.Type;

export const GuidanceAvailability = Schema.Struct({
  available: Schema.Boolean,
  reason: Schema.NullOr(ShortText),
});
export type GuidanceAvailability = typeof GuidanceAvailability.Type;

export const GuidanceTargetSummary = Schema.Struct({
  targetRef: Ref,
  label: ShortText,
  destination: GuidanceDestination,
  entityId: Entity,
  mounted: Schema.Boolean,
  availability: GuidanceAvailability,
});
export type GuidanceTargetSummary = typeof GuidanceTargetSummary.Type;

export const GuidanceGuideSummary = Schema.Struct({
  guideRef: Ref,
  title: ShortText,
  summary: ShortText,
  entityId: Entity,
});
export type GuidanceGuideSummary = typeof GuidanceGuideSummary.Type;

export const PublicGuidanceContext = Schema.Struct({
  version: Schema.Literal(GuidanceContextVersion),
  contextRef: Ref,
  generation: Schema.Int,
  view: Ref,
  entityId: Entity,
  facts: Schema.Array(ShortText).check(Schema.isMaxLength(8)),
  targets: Schema.Array(GuidanceTargetSummary).check(Schema.isMaxLength(24)),
  guides: Schema.Array(GuidanceGuideSummary).check(Schema.isMaxLength(16)),
});
export type PublicGuidanceContext = typeof PublicGuidanceContext.Type;

export const GuidanceOfferRequest = Schema.Struct({
  contextRef: Ref,
  guideRef: Ref,
  targetRef: Schema.optionalKey(Ref),
});
export type GuidanceOfferRequest = typeof GuidanceOfferRequest.Type;

export const GuidanceNoteRequest = Schema.Struct({
  contextRef: Ref,
  targetRef: Ref,
  text: ShortText.check(Schema.isPattern(/^[^<>]*$/u)),
});
export type GuidanceNoteRequest = typeof GuidanceNoteRequest.Type;

export const GuidanceReturnContext = Schema.Struct({
  view: Ref,
  focusKind: Entity,
  focusId: Entity,
  filter: Entity,
});
export type GuidanceReturnContext = typeof GuidanceReturnContext.Type;

export const GuidanceStep = Schema.Struct({
  id: Ref,
  destination: GuidanceDestination,
  targetId: Ref,
  entityId: Entity,
  instruction: ShortText,
  eventKind: Ref,
  completion: Schema.Literals(["target", "result", "bound_result"]),
});
export type GuidanceStep = typeof GuidanceStep.Type;

export const GuidanceOfferSchema = Schema.Struct({
  guideRef: Ref,
  guideId: Ref,
  guideVersion: Version,
  title: ShortText,
  offerText: ShortText,
  targetRef: Ref,
  targetId: Ref,
  entityId: Entity,
  steps: Schema.Array(GuidanceStep).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
});
export type GuidanceOffer = typeof GuidanceOfferSchema.Type;

export const GuidanceNoteSchema = Schema.Struct({
  targetRef: Ref,
  targetId: Ref,
  entityId: Entity,
  text: ShortText.check(Schema.isPattern(/^[^<>]*$/u)),
});
export type GuidanceNote = typeof GuidanceNoteSchema.Type;

export const GuidanceSession = Schema.Struct({
  version: Schema.Literal(GuidanceSessionVersion),
  sessionId: Ref,
  contextRef: Ref,
  guideRef: Ref,
  guideId: Ref,
  guideVersion: Version,
  title: ShortText,
  offerText: ShortText,
  generation: Schema.Int,
  entityId: Entity,
  operationId: Ref,
  phase: Schema.Literals(["offered", "active", "paused", "complete"]),
  stepIndex: Schema.Int,
  steps: Schema.Array(GuidanceStep).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
  boundResultId: Entity,
  origin: GuidanceReturnContext,
});
export type GuidanceSession = typeof GuidanceSession.Type;

export const GuidanceProgressEvent = Schema.Struct({
  sessionId: Ref,
  contextRef: Ref,
  generation: Schema.Int,
  entityId: Entity,
  operationId: Ref,
  kind: Ref,
  targetId: Schema.optionalKey(Ref),
  resultId: Schema.optionalKey(Ref),
  verified: Schema.Literal(true),
});
export type GuidanceProgressEvent = typeof GuidanceProgressEvent.Type;

export type GuidanceValidation<T> =
  | { readonly kind: "ok"; readonly value: T }
  | { readonly kind: "stale"; readonly currentContext: PublicGuidanceContext }
  | { readonly kind: "invalid"; readonly reason: string };

export const decodeStrict = <S extends Schema.ConstraintDecoder<unknown>>(schema: S, value: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema, { onExcessProperty: "error" })(value);

export const guidanceUtf8Bytes = (value: unknown): number =>
  new TextEncoder().encode(JSON.stringify(value)).byteLength;
