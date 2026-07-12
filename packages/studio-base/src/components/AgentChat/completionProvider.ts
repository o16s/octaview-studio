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
    // Adapt messages to WebLLM's stricter validation:
    // 1. Hermes models reject system messages when tools are specified (they inject
    //    their own function-calling system prompt). Convert to user messages.
    // 2. WebLLM requires assistant message content to be a string, but tool-call-only
    //    responses have content=null/undefined. Default to empty string.
    const hasTools = tools.length > 0;
    const adjustedMessages = messages.map((msg) => {
      if (hasTools && msg.role === "system") {
        return { ...msg, role: "user" as const, content: `[Instructions]\n${msg.content ?? ""}` };
      }
      if (msg.role === "assistant" && msg.content == undefined) {
        return { ...msg, content: "" };
      }
      return msg;
    });

    return await engine.chat.completions.create({ messages: adjustedMessages, tools });
  };
}
