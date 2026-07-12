// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ChatMessage, ToolDefinition } from "./types";

export type ChatCompletionRequest = {
  messages: ChatMessage[];
  tools: ToolDefinition[];
};

export type ChatCompletionResponse = {
  choices: {
    message: {
      role?: string;
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }[];
};

export type ChatCompletionProvider = (
  request: ChatCompletionRequest,
) => Promise<ChatCompletionResponse>;

const MAX_TOOL_RESULT_LENGTH = 2000;

/**
 * Trim the conversation to avoid exceeding the model's context limit.
 * Truncates tool result messages from older turns, keeping recent messages intact.
 */
export function trimConversation(conversation: ChatMessage[]): ChatMessage[] {
  const KEEP_RECENT = 20;
  return conversation.map((msg, i) => {
    if (
      msg.role === "tool" &&
      msg.content != undefined &&
      msg.content.length > MAX_TOOL_RESULT_LENGTH &&
      i < conversation.length - KEEP_RECENT
    ) {
      return {
        ...msg,
        content: msg.content.slice(0, MAX_TOOL_RESULT_LENGTH) + "\n...[truncated]",
      };
    }
    return msg;
  });
}

export function createRemoteProvider(
  fetchFn: typeof fetch,
  apiEndpoint: string,
  apiKey: string,
  model: string,
): ChatCompletionProvider {
  return async ({ messages, tools }: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
    const response = await fetchFn(`${apiEndpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages,
        ...(tools.length > 0 ? { tools } : {}),
      }),
    });

    if (!response.ok) {
      let detail = `${response.status}`;
      try {
        const body = await response.json();
        if (body?.error?.message) {
          detail = body.error.message;
        }
      } catch {
        // use status code
      }
      throw new Error(detail);
    }

    return response.json() as Promise<ChatCompletionResponse>;
  };
}

export interface WebLLMEngine {
  chat: {
    completions: {
      create: (request: {
        messages: ChatMessage[];
        tools: ToolDefinition[];
      }) => Promise<ChatCompletionResponse>;
    };
  };
}

export function createWebLLMProvider(engine: WebLLMEngine): ChatCompletionProvider {
  return async ({ messages, tools }: ChatCompletionRequest): Promise<ChatCompletionResponse> => {
    // WebLLM Hermes models reject custom system prompts when tools are specified
    // (they use a built-in system prompt for function calling).
    // Convert system messages to user messages so the instructions still reach the model.
    const adjustedMessages =
      tools.length > 0
        ? messages.map((msg) =>
            msg.role === "system"
              ? { ...msg, role: "user" as const, content: `[Instructions]\n${msg.content ?? ""}` }
              : msg,
          )
        : messages;

    return await engine.chat.completions.create({ messages: adjustedMessages, tools });
  };
}
