import { Effect } from "effect";
import { targets } from "../shared/targets.js";
import type { OrderSummary, ReviewedProposal } from "../shared/contracts.js";
import { ToolExecutionError, type ToolContext, type ToolHandlers } from "./tool-registry.js";
import { discoverGuides, validateGuidanceNote, validateGuidanceOffer } from "../guidance/catalog.js";
import type { GuidanceNoteRequest, GuidanceOfferRequest } from "../guidance/contracts.js";
import { describeOrderProgress, workGuidanceTargets } from "../modules/work/index.js";

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

const guidanceContext = (context: ToolContext) => {
  if (context.getGuidanceContext === undefined) throw new ToolExecutionError("tool_failed", "Guidance is unavailable for this turn.");
  return context.getGuidanceContext();
};

const guidanceUiResult = async (context: ToolContext, result: Awaited<ReturnType<ToolContext["requestUi"]>>, appliedKind: "offered" | "shown") => {
  if (result.applied) return { kind: appliedKind, message: result.message };
  return {
    kind: result.outcome === "stale_context" ? "stale_context" : "missing_target",
    message: result.message,
    currentContext: result.currentContext ?? (await guidanceContext(context)).publicContext,
  };
};

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
  readGuidanceContext: async (context) => (await guidanceContext(context)).publicContext,
  findGuides: async (context, input) => {
    const args = input as { query?: string; limit?: number };
    return discoverGuides(await guidanceContext(context), args.query, args.limit);
  },
  offerGuide: async (context, input) => {
    const request = input as GuidanceOfferRequest;
    const validation = validateGuidanceOffer(await guidanceContext(context), request);
    if (validation.kind === "stale") return { kind: "stale_context", message: "The application context changed. Read the current context and choose again.", currentContext: validation.currentContext };
    if (validation.kind === "invalid") return { kind: "invalid", message: validation.reason };
    return guidanceUiResult(context, await context.requestUi({ kind: "offer_guide", contextRef: request.contextRef, offer: validation.value }), "offered");
  },
  showNote: async (context, input) => {
    const request = input as GuidanceNoteRequest;
    if (/[<>]/.test(request.text)) throw new ToolExecutionError("invalid_arguments", "Notes must be plain text.");
    const validation = validateGuidanceNote(await guidanceContext(context), request);
    if (validation.kind === "stale") return { kind: "stale_context", message: "The application context changed. Read the current context and choose again.", currentContext: validation.currentContext };
    if (validation.kind === "invalid") return { kind: "invalid", message: validation.reason };
    return guidanceUiResult(context, await context.requestUi({ kind: "show_note", contextRef: request.contextRef, note: validation.value }), "shown");
  },
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
  getOrder: async (context, input) => {
    const orderId = (input as { orderId: string }).orderId;
    const progress = await Effect.runPromise(context.repository.orderProgress(context.identity, context.generation, orderId));
    if (progress === null) throw new ToolExecutionError("tool_failed", "That order is not in this workspace.");
    const latestReceipt = progress.latestReceipt === null ? null : (() => {
      const { id: _receiptId, proposalKind, kind: _receiptKind, ...receipt } = progress.latestReceipt;
      return { ...receipt, kind: proposalKind };
    })();
    return { order: { ...orderOutput(progress.order), completed: progress.completed, resolved: progress.resolved,
      progress: describeOrderProgress({ status: progress.order.status, completed: progress.completed, resolved: progress.resolved }),
    }, latestReceipt };
  },
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
      throw new ToolExecutionError("invalid_arguments", "Choose the recorded request or conversation turn to inspect in Audit.");
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
    const args = input as { view: "work" | "explore" | "audit" | "order"; orderId?: string; filter?: "ready" };
    if (args.filter !== undefined && args.view !== "work") throw new ToolExecutionError("invalid_arguments", "The Ready filter belongs to Work.");
    if (args.view === "order") {
      if (args.orderId === undefined) throw new ToolExecutionError("invalid_arguments", "Choose an order before opening its details.");
      await findOrder(context, args.orderId);
    } else if (args.orderId !== undefined) {
      throw new ToolExecutionError("invalid_arguments", "An order can only be selected when opening order details.");
    }
    const result = await context.requestUi({ kind: "navigate", view: args.view, ...(args.orderId === undefined ? {} : { orderId: args.orderId }), ...(args.filter === undefined ? {} : { filter: args.filter }) });
    return { ok: result.applied, message: result.message };
  },
  highlight: async (context, input) => {
    const args = input as { target: "workQueue" | "readyFilter" | "batchReview" | "chatComposer" | "orderRow" | "orderEvidence"; orderId?: string };
    const requiresOrder = args.target === "orderRow" || args.target === "orderEvidence";
    if (requiresOrder && args.orderId === undefined) throw new ToolExecutionError("invalid_arguments", "Choose an order before pointing to its details or evidence.");
    if (!requiresOrder && args.orderId !== undefined) throw new ToolExecutionError("invalid_arguments", "Choose an order detail or evidence control when pointing to a specific order.");
    if (args.orderId !== undefined) await findOrder(context, args.orderId);
    const targetId = args.target === "workQueue" ? targets.workQueue
      : args.target === "readyFilter" ? targets.readyFilter
        : args.target === "batchReview" ? workGuidanceTargets.batchReview
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
  prepareUndo: async (context, input) => {
    const args = input as { orderId: string; expectedKind: "resolution" | "batch"; expectedChanges: number };
    const latest = (await Effect.runPromise(context.repository.orderProgress(context.identity, context.generation, args.orderId)))?.latestReceipt;
    const receiptId = latest?.id;
    if (receiptId === undefined) throw new ToolExecutionError("tool_failed", "That order has no accepted receipt available for Undo in this workspace.");
    return present(context, await Effect.runPromise(context.repository.prepareUndo(context.identity, context.generation, receiptId, { kind: args.expectedKind, totalChanges: args.expectedChanges })));
  },
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
      throw new ToolExecutionError("invalid_output", "The note check did not return a usable result.");
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
      throw new ToolExecutionError("invalid_output", "The consent check did not return a usable result.");
    }
    const consent = answer.choice as "explicit" | "conditional" | "unclear";
    const conservativeConsent = answer.confidence < 0.6 ? "unclear" : consent;
    return { consent: conservativeConsent, needsReview: conservativeConsent !== "explicit", evidence, alternatives: probabilityEntries(answer.probabilities) };
  },
  prepareReset: async (context) => present(context, await Effect.runPromise(context.repository.prepareReset(context.identity, context.generation))),
};
