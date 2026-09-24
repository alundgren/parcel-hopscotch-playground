import type { GuidanceModule, GuidanceGuideDefinition, GuidanceTargetDefinition } from "../../guidance/catalog.js";
import type { GuidanceInput } from "../input.js";

export const auditGuidanceTargets = {
  search: "audit.search",
  results: "audit.results",
} as const;
export type AuditGuidanceTargetId = (typeof auditGuidanceTargets)[keyof typeof auditGuidanceTargets];

export const auditGuides = {
  inspectRequest: "audit.inspect-request",
} as const;
export type AuditGuideId = (typeof auditGuides)[keyof typeof auditGuides];
export const auditGuideVersion = 1;

const auditTargets = (_input: GuidanceInput): ReadonlyArray<GuidanceTargetDefinition> => [
  { id: auditGuidanceTargets.search, label: "Audit search", destination: "audit", entityId: null, availability: { available: true, reason: null } },
  { id: auditGuidanceTargets.results, label: "Audit request results", destination: "audit", entityId: null, availability: { available: true, reason: null } },
];

const auditGuideDefinitions = (_input: GuidanceInput): ReadonlyArray<GuidanceGuideDefinition> => [{
  id: auditGuides.inspectRequest,
  version: auditGuideVersion,
  title: "Find a request in Audit",
  summary: "Open Audit, search for a request, and inspect its recorded result.",
  offerText: "I can show you the Audit search and the recorded result for a request.",
  entityId: null,
  primaryTargetId: auditGuidanceTargets.search,
  steps: [
    { id: "open", destination: "audit", targetId: auditGuidanceTargets.search, entityId: null, instruction: "Open Audit and search for the request you want to inspect.", eventKind: "destination_ready", completion: "target" },
    { id: "result", destination: "audit", targetId: auditGuidanceTargets.results, entityId: null, instruction: "Open the matching request and inspect its recorded result.", eventKind: "audit_result_ready", completion: "target" },
  ],
}];

export const auditGuidanceModule: GuidanceModule<GuidanceInput> = {
  id: "audit",
  version: 1,
  facts: () => [],
  targets: auditTargets,
  guides: auditGuideDefinitions,
};
