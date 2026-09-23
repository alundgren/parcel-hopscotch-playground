import type { AgentViewContext, WorkspaceSnapshot } from "../shared/contracts.js";
import type { GuidanceProblem, GuidanceInput, GuidanceLocation } from "./input.js";
import {
  makeGuidanceContext,
  discoverGuides,
  validateGuidanceOffer,
  validateGuidanceNote,
} from "../guidance/catalog.js";
import { workGuidanceModule, workGuidanceTargets, workGuides, workGuideVersion } from "./work/index.js";
import { auditGuidanceModule, auditGuidanceTargets, auditGuides, auditGuideVersion } from "./audit/index.js";

export { discoverGuides, validateGuidanceOffer, validateGuidanceNote };
export { workGuidanceTargets, workGuides, auditGuidanceTargets, auditGuides };
export { reviewChangeAvailability, workGuideNote } from "./work/index.js";
export type { GuidanceContext, GuidanceDiscovery } from "../guidance/catalog.js";
export { GuidanceProblem } from "./input.js";

export const guidanceModules = [workGuidanceModule, auditGuidanceModule] as const;
export const guidanceGuideVersion = (guideId: string): number | null =>
  guideId === workGuides.staleReview ? workGuideVersion : guideId === auditGuides.inspectRequest ? auditGuideVersion : null;
export type GuidanceGuideId = (typeof workGuides)[keyof typeof workGuides] | (typeof auditGuides)[keyof typeof auditGuides];
export type GuidanceTargetId = typeof workGuidanceTargets.queue |
  ReturnType<typeof workGuidanceTargets.orderRow> |
  ReturnType<typeof workGuidanceTargets.orderEvidence> |
  ReturnType<typeof workGuidanceTargets.reviewChange> |
  ReturnType<typeof workGuidanceTargets.proposalReview> |
  (typeof auditGuidanceTargets)[keyof typeof auditGuidanceTargets];

export interface CreateGuidanceContextInput {
  readonly snapshot: Pick<WorkspaceSnapshot, "generation" | "sequence" | "orders">;
  readonly location: AgentViewContext;
  readonly presentedProposal?: GuidanceInput["presentedProposal"];
  readonly problem?: GuidanceProblem | null;
  readonly connected?: boolean;
  readonly observedTargetIds?: ReadonlyArray<string>;
  readonly disabledTargetIds?: ReadonlyArray<string>;
}

const locationFocus = (location: AgentViewContext): GuidanceLocation["focus"] => {
  if (location.focus === null) return null;
  if (location.focus.kind === "order") return { kind: "order", id: location.focus.orderId };
  if (location.focus.kind === "proposal") return { kind: "proposal", id: location.focus.proposalId };
  return { kind: "receipt", id: location.focus.receiptId };
};

export const createGuidanceContext = ({ snapshot, location, presentedProposal = null, problem = null, connected = true, observedTargetIds = [], disabledTargetIds = [] }: CreateGuidanceContextInput) => {
  const focus = locationFocus(location);
  const entityId = problem?.orderId ?? (focus?.kind === "order" ? focus.id : null);
  const focusedProposal = location.view === "work" && focus?.kind === "proposal" && presentedProposal?.id === focus.id ? presentedProposal : null;
  const input: GuidanceInput = {
    generation: snapshot.generation,
    sequence: snapshot.sequence,
    orders: snapshot.orders,
    presentedProposal: focusedProposal,
    location: { view: location.view, focus },
    problem,
    connected,
  };
  return makeGuidanceContext(guidanceModules, input, {
    generation: snapshot.generation,
    sequence: snapshot.sequence,
    view: location.view,
    entityId,
    focusId: focus?.id ?? null,
    problemId: problem === null ? null : `${problem.proposalId}:${problem.reason}:${problem.currentVersion ?? "unknown"}:${problem.resolved}`,
  }, observedTargetIds, disabledTargetIds);
};
