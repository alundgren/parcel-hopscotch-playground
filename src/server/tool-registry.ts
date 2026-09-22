import { Schema } from "effect";
import type { AgentUiOperation, ReviewedProposal } from "../shared/contracts.js";
import { OrderStatus, ResolutionFamily, ReviewedProposal as ReviewedProposalSchema, TutorialId, TutorialState } from "../shared/contracts.js";
import type { RequestIdentity } from "./identity.js";
import type { WorkspaceRepositoryService } from "./persistence.js";
import { ProviderError, type JevRequest, type JevResult } from "./providers/contracts.js";

const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128));
const ShortText = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2_000));
const EmptyInput = Schema.Record(Schema.String, Schema.Never);
const OrderIdInput = Schema.Struct({ orderId: Identifier });
const ProposalOutput = ReviewedProposalSchema;
const ResultMessage = Schema.Struct({ ok: Schema.Boolean, message: Schema.String });
const exampleChange = {
  orderId: "BB-1042",
  family: "address",
  before: "14 Willow Lane, Bath BA1 2AB",
  after: "41 Willow Lane, Bath BA1 2AB",
  effect: "Ship to the customer-confirmed street number.",
  expectedVersion: 1,
} as const;
const proposalExample = (kind: "resolution" | "batch" | "undo" | "reset", title: string) => ({
  id: "proposal_example",
  generation: 1,
  kind,
  title,
  ready: true,
  changes: kind === "reset" ? [] : [exampleChange],
  omissions: [],
  effects: kind === "reset" ? ["Restore the seeded workspace and keep Audit history."] : [exampleChange.effect],
  createdAt: "2026-09-21T09:14:00.000Z",
});

const orderResult = Schema.Struct({
  id: Schema.String,
  item: Schema.String,
  issue: Schema.String,
  status: OrderStatus,
  family: ResolutionFamily,
  version: Schema.Int,
  businessValue: Schema.String,
  evidence: Schema.Array(Schema.Struct({ label: Schema.String, value: Schema.String, occurredAt: Schema.String, age: Schema.String })),
});
const orderListResult = Schema.Struct({
  id: Schema.String,
  item: Schema.String,
  issue: Schema.String,
  status: OrderStatus,
  family: ResolutionFamily,
});

export type ToolCategory = "Read" | "Guide" | "Prepare" | "Classify";
export interface ToolExample { readonly arguments: unknown; readonly result: unknown }
export interface ToolContext {
  readonly repository: WorkspaceRepositoryService;
  readonly identity: RequestIdentity;
  readonly generation: number;
  readonly turnId: string;
  readonly requestId: string;
  readonly runJev: (request: JevRequest) => Promise<JevResult>;
  readonly requestUi: (operation: AgentUiRequest) => Promise<{ readonly applied: boolean; readonly message: string }>;
}
export type AgentUiRequest =
  | { readonly kind: "navigate"; readonly view: "work" | "explore" | "audit" | "order"; readonly orderId?: string }
  | { readonly kind: "highlight"; readonly targetId: string }
  | { readonly kind: "present_proposal"; readonly proposalId: string };

export class ToolExecutionError extends Error {
  constructor(readonly code: "unknown_tool" | "invalid_arguments" | "invalid_output" | "tool_failed", message: string) {
    super(message);
  }
}

interface ToolSpec {
  readonly description: string;
  readonly category: ToolCategory;
  readonly purpose: string;
  readonly allowedEffects: ReadonlyArray<string>;
  readonly example: ToolExample;
  readonly input: Schema.Top;
  readonly output: Schema.Top;
}

const specs = {
  listOrders: {
    description: "Find the current user's fulfilment orders using bounded application filters.",
    category: "Read", purpose: "Find orders", allowedEffects: ["read_workspace"],
    example: { arguments: { status: "ready" }, result: { count: 1, orders: [{ id: "BB-1051", item: "Stoneware mug", issue: "Blue unavailable", status: "ready", family: "substitution" }] } },
    input: Schema.Struct({ status: Schema.optionalKey(OrderStatus), family: Schema.optionalKey(ResolutionFamily), query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(80))) }),
    output: Schema.Struct({ count: Schema.Int, orders: Schema.Array(orderListResult) }),
  },
  getOrder: {
    description: "Read one current user's order and its evidence by opaque order ID.",
    category: "Read", purpose: "Inspect an order", allowedEffects: ["read_workspace"],
    example: { arguments: { orderId: "BB-1042" }, result: { order: {
      id: "BB-1042", item: "Woven basket", issue: "Street number needs checking.", status: "review", family: "address", version: 1,
      businessValue: "14 Willow Lane, Bath BA1 2AB",
      evidence: [{ label: "Customer", value: "The number is 41, not 14. Everything else is right.", occurredAt: "2026-09-21T08:40:00.000Z", age: "34 min ago" }],
    } } },
    input: OrderIdInput, output: Schema.Struct({ order: orderResult }),
  },
  groupOrders: {
    description: "Group the current queue by status or exception family.",
    category: "Read", purpose: "Group the work", allowedEffects: ["read_workspace"],
    example: { arguments: { groupBy: "status" }, result: { groups: [{ name: "ready", count: 2, orderIds: ["BB-1051"] }] } },
    input: Schema.Struct({ groupBy: Schema.Literals(["status", "family"]) }),
    output: Schema.Struct({ groups: Schema.Array(Schema.Struct({ name: Schema.String, count: Schema.Int, orderIds: Schema.Array(Schema.String) })) }),
  },
  getAuditTrace: {
    description: "Read a bounded owner-scoped provider trace by request or turn ID.",
    category: "Read", purpose: "Inspect an interaction", allowedEffects: ["read_audit"],
    example: { arguments: { requestId: "req_123" }, result: { attempts: [] } },
    input: Schema.Struct({ requestId: Schema.optionalKey(Identifier), turnId: Schema.optionalKey(Identifier) }),
    output: Schema.Struct({ attempts: Schema.Array(Schema.Struct({ id: Schema.String, requestId: Schema.String, turnId: Schema.String, model: Schema.String, actualModel: Schema.NullOr(Schema.String), outcome: Schema.String, durationMs: Schema.NullOr(Schema.Number), inputTokens: Schema.NullOr(Schema.Int), outputTokens: Schema.NullOr(Schema.Int), costUsd: Schema.NullOr(Schema.Number) })) }),
  },
  navigate: {
    description: "Open a registered application view or current order. Arbitrary URLs and selectors are not accepted.",
    category: "Guide", purpose: "Open a view", allowedEffects: ["navigate_registered_view"],
    example: { arguments: { view: "order", orderId: "BB-1042" }, result: { ok: true, message: "Opened BB-1042." } },
    input: Schema.Struct({ view: Schema.Literals(["work", "explore", "audit", "order"]), orderId: Schema.optionalKey(Identifier) }), output: ResultMessage,
  },
  highlight: {
    description: "Highlight one registered application target. Raw selectors and browser code are not accepted.",
    category: "Guide", purpose: "Point to evidence", allowedEffects: ["highlight_registered_target"],
    example: { arguments: { target: "orderEvidence", orderId: "BB-1042" }, result: { ok: true, message: "Highlighted the evidence." } },
    input: Schema.Struct({ target: Schema.Literals(["workQueue", "readyFilter", "chatComposer", "orderRow", "orderEvidence"]), orderId: Schema.optionalKey(Identifier) }), output: ResultMessage,
  },
  startTutorial: {
    description: "Start one bounded application tutorial for the current workspace. Real user actions advance it.",
    category: "Guide", purpose: "Teach a task", allowedEffects: ["start_bounded_tutorial"],
    example: { arguments: { tutorialId: "address-correction" }, result: { id: "address-correction", instanceId: "tutorial_example", title: "Address correction", step: 0, totalSteps: 8, phase: "teaching", instruction: "Open BB-1042 and compare the saved address with the evidence.", targetId: "target-order-BB-1042" } },
    input: Schema.Struct({ tutorialId: TutorialId }), output: TutorialState,
  },
  stopTutorial: {
    description: "Dismiss the current tutorial without changing accepted work.",
    category: "Guide", purpose: "End the guidance", allowedEffects: ["stop_tutorial_guidance"],
    example: { arguments: {}, result: { ok: true, message: "Tutorial dismissed." } },
    input: EmptyInput, output: ResultMessage,
  },
  prepareAddressCorrection: {
    description: "Prepare the authoritative address correction for an address order. The user must accept the preview.",
    category: "Prepare", purpose: "Prepare an address correction", allowedEffects: ["create_reviewed_proposal"],
    example: { arguments: { orderId: "BB-1042" }, result: proposalExample("resolution", "Check address") },
    input: OrderIdInput, output: ProposalOutput,
  },
  prepareSubstitution: {
    description: "Prepare the authoritative substitution for a substitution order. Stock and consent remain application checks.",
    category: "Prepare", purpose: "Prepare a substitution", allowedEffects: ["create_reviewed_proposal"],
    example: { arguments: { orderId: "BB-1051" }, result: proposalExample("resolution", "Review replacement") },
    input: OrderIdInput, output: ProposalOutput,
  },
  prepareResolution: {
    description: "Prepare the existing authoritative resolution for any conventional exception family. The user must accept the preview.",
    category: "Prepare", purpose: "Prepare a reviewed resolution", allowedEffects: ["create_reviewed_proposal"],
    example: { arguments: { orderId: "BB-1090" }, result: proposalExample("resolution", "Review resolution") },
    input: OrderIdInput, output: ProposalOutput,
  },
  prepareBatch: {
    description: "Prepare all currently eligible ready orders with exact inclusions and omissions. The user must accept the preview.",
    category: "Prepare", purpose: "Prepare a batch", allowedEffects: ["create_reviewed_proposal"],
    example: { arguments: {}, result: proposalExample("batch", "Review 1 change") }, input: EmptyInput, output: ProposalOutput,
  },
  prepareUndo: {
    description: "Prepare a checked reversal of a current user's receipt. The user must accept the preview.",
    category: "Prepare", purpose: "Prepare an undo", allowedEffects: ["create_reviewed_proposal"],
    example: { arguments: { receiptId: "receipt_example" }, result: proposalExample("undo", "Undo 1 accepted change") },
    input: Schema.Struct({ receiptId: Identifier }), output: ProposalOutput,
  },
  classifyNote: {
    description: "Use Jev to classify a short note into the application's six exception families plus other.",
    category: "Classify", purpose: "Classify a note", allowedEffects: ["provider_classification", "read_only"],
    example: { arguments: { note: "Carrier missed collection." }, result: { category: "carrier", confidence: 0.98, alternatives: [{ category: "carrier", probability: 0.98 }, { category: "other", probability: 0.02 }] } },
    input: Schema.Struct({ note: ShortText }),
    output: Schema.Struct({ category: Schema.Literals(["address", "substitution", "bundle", "weight", "carrier", "duplicate", "other"]), confidence: Schema.Number, alternatives: Schema.Array(Schema.Struct({ category: Schema.String, probability: Schema.Number })) }),
  },
  checkConsent: {
    description: "Use Jev to assess the selected order's customer evidence against fixed consent alternatives. Conditional or ambiguous input remains unconfirmed.",
    category: "Classify", purpose: "Check replacement consent", allowedEffects: ["provider_classification", "read_only"],
    example: { arguments: { orderId: "BB-1076" }, result: { consent: "conditional", needsReview: true, evidence: "Sage might work, but can you send a picture first?", alternatives: [{ label: "conditional", probability: 0.98 }, { label: "explicit", probability: 0.01 }, { label: "unclear", probability: 0.01 }] } },
    input: OrderIdInput,
    output: Schema.Struct({ consent: Schema.Literals(["explicit", "conditional", "unclear"]), needsReview: Schema.Boolean, evidence: Schema.String, alternatives: Schema.Array(Schema.Struct({ label: Schema.String, probability: Schema.Number })) }),
  },
  prepareReset: {
    description: "Prepare a reset preview for the current workspace. Only the user can accept it.",
    category: "Prepare", purpose: "Prepare a fresh start", allowedEffects: ["create_reviewed_proposal"],
    example: { arguments: {}, result: proposalExample("reset", "Reset my demo") }, input: EmptyInput, output: ProposalOutput,
  },
} as const satisfies Record<string, ToolSpec>;

export type ToolName = keyof typeof specs;
export type ToolHandler = (context: ToolContext, input: never) => Promise<unknown>;
export type ToolHandlers = { readonly [Name in ToolName]: ToolHandler };

const jsonSchema = (schema: Schema.Top): Readonly<Record<string, unknown>> => {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" }) as unknown as { readonly schema: Readonly<Record<string, unknown>> };
  return document.schema;
};

export interface RegisteredTool {
  readonly name: ToolName;
  readonly description: string;
  readonly category: ToolCategory;
  readonly purpose: string;
  readonly allowedEffects: ReadonlyArray<string>;
  readonly example: ToolExample;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly outputSchema: Readonly<Record<string, unknown>>;
  readonly execute: (context: ToolContext, input: unknown) => Promise<unknown>;
}

export const makeToolRegistry = (handlers: ToolHandlers): Readonly<Record<ToolName, RegisteredTool>> => {
  const entries = Object.entries(specs).map(([untypedName, spec]) => {
    const name = untypedName as ToolName;
    const execute = async (context: ToolContext, input: unknown) => {
      let decoded: unknown;
      try {
        decoded = Schema.decodeUnknownSync(spec.input, { onExcessProperty: "error" })(input);
      } catch {
        throw new ToolExecutionError("invalid_arguments", `Arguments for ${name} do not match its schema.`);
      }
      let output: unknown;
      try {
        output = await handlers[name](context, decoded as never);
      } catch (error) {
        if (error instanceof ToolExecutionError || error instanceof ProviderError) throw error;
        throw new ToolExecutionError("tool_failed", error instanceof Error ? error.message : `${name} failed.`);
      }
      try {
        return Schema.decodeUnknownSync(spec.output, { onExcessProperty: "error" })(output);
      } catch {
        throw new ToolExecutionError("invalid_output", `${name} returned an invalid result.`);
      }
    };
    return [name, { name, description: spec.description, category: spec.category, purpose: spec.purpose, allowedEffects: spec.allowedEffects, example: spec.example, parameters: jsonSchema(spec.input), outputSchema: jsonSchema(spec.output), execute }] as const;
  });
  return Object.fromEntries(entries) as unknown as Readonly<Record<ToolName, RegisteredTool>>;
};

export const modelToolsFromRegistry = (registry: Readonly<Record<ToolName, RegisteredTool>>) =>
  Object.values(registry).map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    validateArguments: (value: unknown) => {
      try {
        Schema.decodeUnknownSync(specs[tool.name].input, { onExcessProperty: "error" })(value);
        return true;
      } catch {
        return false;
      }
    },
  }));

const validateToolExample = (id: ToolName, tool: (typeof specs)[ToolName]): void => {
  try {
    Schema.decodeUnknownSync(tool.input, { onExcessProperty: "error" })(tool.example.arguments);
  } catch {
    throw new Error(`The ${id} catalogue input example does not match its runtime schema.`);
  }
  try {
    Schema.decodeUnknownSync(tool.output, { onExcessProperty: "error" })(tool.example.result);
  } catch {
    throw new Error(`The ${id} catalogue result example does not match its runtime schema.`);
  }
};

export const validateToolCatalogueExamples = (): void => {
  for (const [untypedName, tool] of Object.entries(specs)) validateToolExample(untypedName as ToolName, tool);
};

export const toolCatalogueMetadata = Object.entries(specs).map(([untypedName, tool]) => {
  const id = untypedName as ToolName;
  validateToolExample(id, tool);
  return {
    id,
    purpose: tool.purpose,
    category: tool.category,
    description: tool.description,
    allowedEffects: tool.allowedEffects,
    example: tool.example,
    inputSchema: jsonSchema(tool.input),
    outputSchema: jsonSchema(tool.output),
  };
});

export const findRegisteredTool = (
  registry: Readonly<Record<ToolName, RegisteredTool>>,
  name: string,
): RegisteredTool | null =>
  Object.prototype.hasOwnProperty.call(registry, name)
    ? registry[name as ToolName]
    : null;

export type PreparedToolOutput = ReviewedProposal;
