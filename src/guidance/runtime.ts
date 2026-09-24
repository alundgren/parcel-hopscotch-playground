import {
  GuidanceProgressEvent,
  GuidanceSession,
  GuidanceStep,
  GuidanceReturnContext,
  GuidanceSessionVersion,
  decodeStrict,
} from "./contracts.js";

export interface BeginGuidanceInput {
  readonly sessionId: string;
  readonly contextRef: string;
  readonly guideRef: string;
  readonly guideId: string;
  readonly guideVersion: number;
  readonly title: string;
  readonly offerText: string;
  readonly generation: number;
  readonly entityId: string | null;
  readonly operationId: string;
  readonly origin: GuidanceReturnContext;
  readonly steps: ReadonlyArray<GuidanceStep>;
}

export const beginGuidance = (input: BeginGuidanceInput): GuidanceSession =>
  decodeStrict(GuidanceSession, {
    version: GuidanceSessionVersion,
    sessionId: input.sessionId,
    contextRef: input.contextRef,
    guideRef: input.guideRef,
    guideId: input.guideId,
    guideVersion: input.guideVersion,
    title: input.title,
    offerText: input.offerText,
    generation: input.generation,
    entityId: input.entityId,
    operationId: input.operationId,
    phase: "offered",
    stepIndex: 0,
    steps: input.steps,
    boundResultId: null,
    origin: input.origin,
  });

export const consentToGuidance = (session: GuidanceSession): GuidanceSession =>
  session.phase === "offered" ? { ...session, phase: "active" } : session;

export const pauseGuidance = (session: GuidanceSession): GuidanceSession =>
  session.phase === "active" ? { ...session, phase: "paused" } : session;

export const resumeGuidance = (session: GuidanceSession): GuidanceSession =>
  session.phase === "paused" ? { ...session, phase: "active" } : session;

export const dismissGuidance = (_session: GuidanceSession): null => null;

export const advanceGuidance = (session: GuidanceSession, untrustedEvent: unknown): GuidanceSession => {
  if (session.phase !== "active") return session;
  let event: GuidanceProgressEvent;
  try { event = decodeStrict(GuidanceProgressEvent, untrustedEvent); } catch { return session; }
  const step = session.steps[session.stepIndex];
  if (step === undefined ||
      event.sessionId !== session.sessionId ||
      event.contextRef !== session.contextRef ||
      event.generation !== session.generation ||
      event.entityId !== session.entityId ||
      event.operationId !== session.operationId ||
      event.kind !== step.eventKind ||
      step.entityId !== event.entityId) return session;
  if (step.completion === "target" && event.targetId !== step.targetId) return session;
  if (step.completion === "result" && event.resultId === undefined) return session;
  if (step.completion === "bound_result" &&
      (session.boundResultId === null || event.resultId !== session.boundResultId)) return session;
  const stepIndex = session.stepIndex + 1;
  return {
    ...session,
    stepIndex,
    phase: stepIndex === session.steps.length ? "complete" : "active",
    boundResultId: step.completion === "result" ? event.resultId! : session.boundResultId,
  };
};

export const encodeSavedGuidance = (session: GuidanceSession): string => JSON.stringify(decodeStrict(GuidanceSession, session));

export const decodeSavedGuidance = (raw: string | null, guideVersion: (guideId: string) => number | null): GuidanceSession | null => {
  if (raw === null || raw.length > 8_192) return null;
  try {
    const value = decodeStrict(GuidanceSession, JSON.parse(raw));
    return value.phase === "complete" || value.stepIndex < 0 || value.stepIndex >= value.steps.length || guideVersion(value.guideId) !== value.guideVersion
      ? null : { ...value, phase: "paused" };
  } catch {
    return null;
  }
};
