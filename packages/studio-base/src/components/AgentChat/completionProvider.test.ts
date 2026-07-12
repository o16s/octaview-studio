// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { createRemoteProvider, createWebLLMProvider, ChatCompletionProvider } from "./completionProvider";
import { ChatMessage, ToolDefinition } from "./types";

describe("createRemoteProvider", () => {
  const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];
  const tools: ToolDefinition[] = [];

  it("sends correct request and returns parsed response", async () => {
    const responseBody = {
      choices: [{ message: { role: "assistant", content: "Hi!" } }],
    };
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => responseBody,
    });

    const provider: ChatCompletionProvider = createRemoteProvider(
      mockFetch,
      "https://api.openai.com/v1",
      "sk-test",
      "gpt-4o",
    );
    const result = await provider({ messages, tools });

    expect(result).toEqual(responseBody);
    expect(mockFetch).toHaveBeenCalledWith("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer sk-test",
      },
      body: JSON.stringify({ model: "gpt-4o", messages }),
    });
  });

  it("includes tools in request body when provided", async () => {
    const toolDefs: ToolDefinition[] = [
      { type: "function", function: { name: "foo", description: "bar", parameters: {} } },
    ];
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "ok" } }] }),
    });

    const provider = createRemoteProvider(mockFetch, "https://api.example.com/v1", "key", "model");
    await provider({ messages, tools: toolDefs });

    const body = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(body.tools).toEqual(toolDefs);
  });

  it("throws with error message from response body on failure", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 401,
      json: async () => ({ error: { message: "Invalid API key" } }),
    });

    const provider = createRemoteProvider(mockFetch, "https://api.openai.com/v1", "bad", "gpt-4o");
    await expect(provider({ messages, tools })).rejects.toThrow("Invalid API key");
  });

  it("throws with status code when error body is not parseable", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => { throw new Error("not json"); },
    });

    const provider = createRemoteProvider(mockFetch, "https://api.openai.com/v1", "key", "gpt-4o");
    await expect(provider({ messages, tools })).rejects.toThrow("500");
  });
});

describe("createWebLLMProvider", () => {
  it("calls engine.chat.completions.create and returns the result", async () => {
    const responseBody = {
      choices: [{ message: { role: "assistant", content: "Hello from local!" } }],
    };
    const mockEngine = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue(responseBody),
        },
      },
    };

    const provider = createWebLLMProvider(mockEngine as any);
    const messages: ChatMessage[] = [{ role: "user", content: "Hi" }];
    const tools: ToolDefinition[] = [
      { type: "function", function: { name: "test", description: "test", parameters: {} } },
    ];

    const result = await provider({ messages, tools });

    expect(result).toEqual(responseBody);
    expect(mockEngine.chat.completions.create).toHaveBeenCalledWith({
      messages,
      tools,
    });
  });

  it("converts system messages to user messages when tools are present", async () => {
    const mockEngine = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] }),
        },
      },
    };

    const provider = createWebLLMProvider(mockEngine as any);
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];
    const tools: ToolDefinition[] = [
      { type: "function", function: { name: "foo", description: "bar", parameters: {} } },
    ];

    await provider({ messages, tools });

    const sentMessages = mockEngine.chat.completions.create.mock.calls[0][0].messages;
    // System message should be converted to user with [Instructions] prefix
    expect(sentMessages[0].role).toBe("user");
    expect(sentMessages[0].content).toContain("You are helpful.");
    expect(sentMessages[1].role).toBe("user");
    expect(sentMessages[1].content).toBe("Hi");
  });

  it("keeps system messages when no tools are present", async () => {
    const mockEngine = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] }),
        },
      },
    };

    const provider = createWebLLMProvider(mockEngine as any);
    const messages: ChatMessage[] = [
      { role: "system", content: "You are helpful." },
      { role: "user", content: "Hi" },
    ];

    await provider({ messages, tools: [] });

    const sentMessages = mockEngine.chat.completions.create.mock.calls[0][0].messages;
    expect(sentMessages[0].role).toBe("system");
  });

  it("passes empty tools array without omitting", async () => {
    const mockEngine = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({ choices: [{ message: { content: "ok" } }] }),
        },
      },
    };

    const provider = createWebLLMProvider(mockEngine as any);
    await provider({ messages: [{ role: "user", content: "test" }], tools: [] });

    expect(mockEngine.chat.completions.create).toHaveBeenCalledWith({
      messages: [{ role: "user", content: "test" }],
      tools: [],
    });
  });
});
