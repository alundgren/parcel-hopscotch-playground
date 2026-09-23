import { Effect } from "effect";
import { targets } from "../shared/targets.js";
import type { OrderSummary, ReviewedProposal } from "../shared/contracts.js";
import { ToolExecutionError, type ToolContext, type ToolHandlers } from "./tool-registry.js";

const orderOutput = (order: OrderSummary) => ({
  id: order.id,
  item: order.item,
  issue: order.issue,
  status: order.status,
  family: order.family,
  version: order.version,
  businessValue: order.businessValue,
  evidence: order.evidence,
});

const snapshot = (context: ToolContext) =>
  Effect.runPromise(context.repository.snapshot(context.identity));

const findOrder = async (context: ToolContext, orderId: string) => {
  const state = await snapshot(context);
  const order = state.orders.find((candidate) => candidate.id === orderId);
  if (order === undefined) {
    throw new ToolExecutionError("tool_failed", "That order is not in this workspace.");
  }
  return order;
};

const present = async (context: ToolContext, proposal: ReviewedProposal) => {
  const shown = await context.requestUi({ kind: "present_proposal", proposalId: proposal.id });
  if (!shown.applied) throw new ToolExecutionError("tool_failed", "The proposal was saved but could not be displayed. Open the saved proposal in Work to review it.");
  return proposal;
};

const prepareResolution = async (context: ToolContext, orderId: string) =>
  present(
    context,
    await Effect.runPromise(
      context.repository.prepareResolution(context.identity, context.generation, orderId),
    ),
  );

const probabilityEntries = (probabilities: Readonly<Record<string, number>>) =>
  Object.entries(probabilities)
    .map(([label, probability]) => ({ label, probability }))
    .sort((left, right) => right.probability - left.probability);

export const toolHandlers: ToolHandlers = {
  listOrders: async (context, input) => {
    const args = input as { status?: OrderSummary["status"] | null; family?: OrderSummary["family"] | null; query?: string | null };
    const state = await snapshot(context);
    const queueTotals = {
      ready: state.orders.filter((order) => order.status === "ready").length,
      review: state.orders.filter((order) => order.status === "review").length,
      waiting: state.orders.filter((order) => order.status === "waiting").length,
    };
    const query = args.query?.trim().toLowerCase();
    const orders = state.orders
      .filter((order) => args.status == null || order.status === args.status)
      .filter((order) => args.family == null || order.family === args.family)
      .filter((order) => query === undefined || [order.id, order.item, order.issue].some((value) => value.toLowerCase().includes(query)))
      .slice(0, 24)
      .map(({ id, item, issue, status, family }) => ({ id, item, issue, status, family }));
    return {
      count: orders.length,
      queueTotals,
      orders,
    };
  },
  getOrder: async (context, input) => ({ order: orderOutput(await findOrder(context, (input as { orderId: string }).orderId)) }),
  groupOrders: async (context, input) => {
    const state = await snapshot(context);
    const groupBy = (input as { groupBy: "status" | "family" }).groupBy;
    const groups = new Map<string, Array<string>>();
    for (const order of state.orders) {
      const name = order[groupBy];
      groups.set(name, [...(groups.get(name) ?? []), order.id]);
    }
    return { groups: [...groups].map(([name, orderIds]) => ({ name, count: orderIds.length, orderIds })) };
  },
  getAuditTrace: async (context, input) => {
    const args = input as { requestId?: string; turnId?: string };
    if (args.requestId === undefined && args.turnId === undefined) {
      throw new ToolExecutionError("invalid_arguments", "Provide a requestId or turnId.");
    }
    const attempts = await Effect.runPromise(context.repository.providerAttempts(context.identity, 12, args));
    return {
      attempts: attempts
        .map((attempt) => ({
          id: attempt.id,
          requestId: attempt.requestId,
          turnId: attempt.turnId,
          model: attempt.requestedModel,
          actualModel: attempt.actualModel,
          outcome: attempt.outcome,
          durationMs: attempt.durationMs,
          inputTokens: attempt.inputTokens,
          outputTokens: attempt.outputTokens,
          costUsd: attempt.costUsd,
        })),
    };
  },
  navigate: async (context, input) => {
    const args = input as { view: "work" | "explore" | "audit" | "order"; orderId?: string };
    if (args.view === "order") {
      if (args.orderId === undefined) throw new ToolExecutionError("invalid_arguments", "An orderId is required for the order view.");
      await findOrder(context, args.orderId);
    } else if (args.orderId !== undefined) {
      throw new ToolExecutionError("invalid_arguments", "orderId is only accepted for the order view.");
    }
    const result = await context.requestUi({ kind: "navigate", view: args.view, ...(args.orderId === undefined ? {} : { orderId: args.orderId }) });
    return { ok: result.applied, message: result.message };
  },
  highlight: async (context, input) => {
    const args = input as { target: "workQueue" | "readyFilter" | "chatComposer" | "orderRow" | "orderEvidence"; orderId?: string };
    const requiresOrder = args.target === "orderRow" || args.target === "orderEvidence";
    if (requiresOrder && args.orderId === undefined) throw new ToolExecutionError("invalid_arguments", "That target requires an orderId.");
    if (!requiresOrder && args.orderId !== undefined) throw new ToolExecutionError("invalid_arguments", "That target does not accept an orderId.");
    if (args.orderId !== undefined) await findOrder(context, args.orderId);
    const targetId = args.target === "workQueue" ? targets.workQueue
      : args.target === "readyFilter" ? targets.readyFilter
        : args.target === "chatComposer" ? targets.chatComposer
          : args.target === "orderRow" ? targets.orderRow(args.orderId!)
            : targets.orderEvidence(args.orderId!);
    const result = await context.requestUi({ kind: "highlight", targetId });
    return { ok: result.applied, message: result.message };
  },
  startTutorial: async (context, input) => Effect.runPromise(context.repository.startTutorial(context.identity, context.generation, (input as { tutorialId: "address-correction" | "substitution-review" | "batch-approval" }).tutorialId)),
  stopTutorial: async (context) => {
    await Effect.runPromise(context.repository.stopTutorial(context.identity, context.generation));
    return { ok: true, message: "Tutorial dismissed. Accepted work is unchanged." };
  },
  prepareAddressCorrection: async (context, input) => {
    const orderId = (input as { orderId: string }).orderId;
    if ((await findOrder(context, orderId)).family !== "address") throw new ToolExecutionError("invalid_arguments", "That order is not an address exception.");
    return prepareResolution(context, orderId);
  },
  prepareSubstitution: async (context, input) => {
    const orderId = (input as { orderId: string }).orderId;
    if ((await findOrder(context, orderId)).family !== "substitution") throw new ToolExecutionError("invalid_arguments", "That order is not a substitution exception.");
    return prepareResolution(context, orderId);
  },
  prepareResolution: async (context, input) => prepareResolution(context, (input as { orderId: string }).orderId),
  prepareBatch: async (context) => present(context, await Effect.runPromise(context.repository.prepareBatch(context.identity, context.generation))),
  prepareUndo: async (context, input) => present(context, await Effect.runPromise(context.repository.prepareUndo(context.identity, context.generation, (input as { receiptId: string }).receiptId))),
  classifyNote: async (context, input) => {
    const note = (input as { note: string }).note;
    const result = await context.runJev({
      state: { note },
      questions: {
        category: {
          type: "choice",
          instructions: "Choose the single fulfilment exception category expressed by this note.",
          criteria: {
            address: "The note concerns a delivery address.", substitution: "The note concerns replacing unavailable stock.",
            bundle: "The note concerns a missing bundle component.", weight: "The note concerns unexpected parcel weight.",
            carrier: "The note concerns a carrier scan or delay.", duplicate: "The note concerns a potential duplicate order.",
            other: "None of the listed exception categories is supported.",
          },
        },
      },
    });
    const answer = result.answers.category;
    if (answer?.type !== "choice" || !["address", "substitution", "bundle", "weight", "carrier", "duplicate", "other"].includes(answer.choice)) {
      throw new ToolExecutionError("invalid_output", "Jev did not return a permitted note category.");
    }
    return { category: answer.choice, confidence: answer.confidence, alternatives: probabilityEntries(answer.probabilities).map(({ label, probability }) => ({ category: label, probability })) };
  },
  checkConsent: async (context, input) => {
    const order = await findOrder(context, (input as { orderId: string }).orderId);
    const evidence = order.evidence.map((item) => item.value).join("\n").slice(0, 2_000);
    const result = await context.runJev({
      state: { evidence, order: { id: order.id, family: order.family, proposedChange: order.businessValue } },
      questions: {
        consent: {
          type: "choice",
          instructions: "Classify the customer's consent to the proposed replacement. Conditional language is not explicit consent.",
          criteria: {
            explicit: "The customer accepted the replacement without a condition.",
            conditional: "The customer accepted only if another condition is met or requested another step first.",
            unclear: "The evidence does not establish acceptance.",
          },
        },
      },
    });
    const answer = result.answers.consent;
    if (answer?.type !== "choice" || !["explicit", "conditional", "unclear"].includes(answer.choice)) {
      throw new ToolExecutionError("invalid_output", "Jev did not return a permitted consent result.");
    }
    const consent = answer.choice as "explicit" | "conditional" | "unclear";
    const conservativeConsent = answer.confidence < 0.6 ? "unclear" : consent;
    return { consent: conservativeConsent, needsReview: conservativeConsent !== "explicit", evidence, alternatives: probabilityEntries(answer.probabilities) };
  },
  prepareReset: async (context) => present(context, await Effect.runPromise(context.repository.prepareReset(context.identity, context.generation))),
};
