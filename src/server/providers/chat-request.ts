import {
  MINISTRAL_MODEL,
  providerBounds,
  type ChatMessage,
  type MinistralRequest,
} from "./contracts.js";
import { invalidRequest, jsonBytes } from "./http.js";

const toolName = /^[A-Za-z0-9_-]{1,64}$/;

export const isValidToolCallId = (value: string): boolean =>
  value.length >= 1 && value.length <= 128;

const serializeMessage = (message: ChatMessage): Record<string, unknown> => {
  if (message.role === "tool") {
    return {
      role: message.role,
      content: message.content,
      tool_call_id: message.toolCallId,
    };
  }
  if (message.role === "assistant") {
    return {
      role: message.role,
      content: message.content,
      ...(message.toolCalls === undefined
        ? {}
        : {
            tool_calls: message.toolCalls.map((call) => ({
              id: call.id,
              type: "function",
              function: {
                name: call.name,
                arguments: JSON.stringify(call.arguments),
              },
            })),
          }),
    };
  }
  return { role: message.role, content: message.content };
};

const validateHistory = (messages: ReadonlyArray<ChatMessage>) => {
  const pending = new Set<string>();
  for (const message of messages) {
    if (pending.size > 0 && message.role !== "tool") {
      throw invalidRequest("Every assistant tool call must be followed by its correlated tool result.");
    }
    if (message.role === "assistant" && message.toolCalls !== undefined) {
      if (message.toolCalls.length === 0 || message.toolCalls.length > 16) {
        throw invalidRequest("Assistant tool-call history must contain between 1 and 16 calls.");
      }
      for (const call of message.toolCalls) {
        if (!isValidToolCallId(call.id) || !toolName.test(call.name)) {
          throw invalidRequest("Assistant tool-call history contains invalid metadata.");
        }
        if (pending.has(call.id)) {
          throw invalidRequest("Assistant tool-call history contains a duplicate call ID.");
        }
        jsonBytes(call.arguments);
        pending.add(call.id);
      }
    }
    if (message.role === "tool") {
      if (!isValidToolCallId(message.toolCallId)) {
        throw invalidRequest("A tool result contains invalid call metadata.");
      }
      if (!pending.delete(message.toolCallId)) {
        throw invalidRequest("A tool result does not match a preceding assistant tool call.");
      }
    }
  }
  if (pending.size > 0) {
    throw invalidRequest("Every assistant tool call must have a correlated tool result before the next request.");
  }
};

export const buildMinistralWireRequest = (
  request: MinistralRequest,
): Record<string, unknown> => {
  validateHistory(request.messages);
  return {
    model: MINISTRAL_MODEL,
    messages: request.messages.map(serializeMessage),
    stream: true,
    max_tokens: request.maxOutputTokens ?? providerBounds.maximumOutputTokens,
    temperature: 0.1,
    provider: { require_parameters: true },
    tools: (request.tools ?? []).map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    })),
    ...(request.toolChoice === undefined
      ? {}
      : {
          tool_choice:
            typeof request.toolChoice === "string"
              ? request.toolChoice
              : {
                  type: "function",
                  function: { name: request.toolChoice.name },
                },
        }),
  };
};
