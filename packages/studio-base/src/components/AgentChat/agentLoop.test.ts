// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { runAgentLoop } from "./agentLoop";
import { ChatCompletionProvider, ChatCompletionResponse } from "./completionProvider";
import { ChatMessage, ToolDefinition } from "./types";

function mockProvider(responses: ChatCompletionResponse[]): ChatCompletionProvider {
  let callIndex = 0;
  const fn = jest.fn(async () => {
    const response = responses[callIndex] ?? responses[responses.length - 1]!;
    callIndex++;
    return response;
  });
  return fn;
}

describe("runAgentLoop", () => {
  it("returns assistant text when model responds without tool calls", async () => {
    const messages: ChatMessage[] = [{ role: "user", content: "Hello" }];
    const tools: ToolDefinition[] = [];

    const provider = mockProvider([
      {
        choices: [{ message: { role: "assistant", content: "Hi there!" }, finish_reason: "stop" }],
      },
    ]);

    const result = await runAgentLoop({
      messages,
      tools,
      completionProvider: provider,
      executeTool: jest.fn(),
    });

    expect(result.messages).toHaveLength(2);
    expect(result.messages[1]).toEqual({
      role: "assistant",
      content: "Hi there!",
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });

  it("executes tool calls and loops until model responds with text", async () => {
    const messages: ChatMessage[] = [{ role: "user", content: "List topics" }];
    const tools: ToolDefinition[] = [
      {
        type: "function",
        function: {
          name: "list_topics",
          description: "List available topics",
          parameters: { type: "object", properties: {} },
        },
      },
    ];

    const provider = mockProvider([
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: ReactNull,
              tool_calls: [{ id: "call_1", function: { name: "list_topics", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
      {
        choices: [
          {
            message: { role: "assistant", content: "Here are the topics: /cam, /imu" },
            finish_reason: "stop",
          },
        ],
      },
    ]);

    const executeTool = jest.fn().mockResolvedValue('["/cam", "/imu"]');

    const result = await runAgentLoop({
      messages,
      tools,
      completionProvider: provider,
      executeTool,
    });

    expect(provider).toHaveBeenCalledTimes(2);
    expect(executeTool).toHaveBeenCalledWith("list_topics", {});
    expect(result.messages).toHaveLength(4); // user, assistant(tool_call), tool_result, assistant(text)
    expect(result.messages[2]).toEqual({
      role: "tool",
      content: '["/cam", "/imu"]',
      tool_call_id: "call_1",
    });
    expect(result.messages[3]!.content).toBe("Here are the topics: /cam, /imu");
  });

  it("throws on API error with error message from response body", async () => {
    const provider: ChatCompletionProvider = jest
      .fn()
      .mockRejectedValue(new Error("Invalid API key"));

    await expect(
      runAgentLoop({
        messages: [{ role: "user", content: "Hi" }],
        tools: [],
        completionProvider: provider,
        executeTool: jest.fn(),
      }),
    ).rejects.toThrow("Invalid API key");
  });

  it("stops after max iterations to prevent infinite loops", async () => {
    // Model always returns tool calls, never stops
    const provider = mockProvider([
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: ReactNull,
              tool_calls: [{ id: "call_x", function: { name: "noop", arguments: "{}" } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "loop forever" }],
      tools: [
        {
          type: "function",
          function: {
            name: "noop",
            description: "does nothing",
            parameters: { type: "object", properties: {} },
          },
        },
      ],
      completionProvider: provider,
      executeTool: jest.fn().mockResolvedValue("ok"),
    });

    // 10 iterations: each adds 1 assistant + 1 tool message = 20, plus the initial user message = 21
    expect(provider).toHaveBeenCalledTimes(10);
    expect(result.messages).toHaveLength(21);
  });

  it("handles malformed tool call JSON gracefully", async () => {
    const provider = mockProvider([
      {
        choices: [
          {
            message: {
              role: "assistant",
              content: ReactNull,
              tool_calls: [
                {
                  id: "call_bad",
                  function: { name: "list_topics", arguments: "not valid json{{{" },
                },
              ],
            },
            finish_reason: "tool_calls",
          },
        ],
      },
    ]);

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "test" }],
      tools: [],
      completionProvider: provider,
      executeTool: jest.fn(),
    });

    // Should not throw — the tool result should contain the parse error
    const toolMsg = result.messages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg!.content).toContain("Error");
  });

  it("handles empty choices array gracefully", async () => {
    const provider = mockProvider([{ choices: [] }]);

    const result = await runAgentLoop({
      messages: [{ role: "user", content: "test" }],
      tools: [],
      completionProvider: provider,
      executeTool: jest.fn(),
    });

    // Should terminate without crashing
    expect(result.messages.length).toBeGreaterThanOrEqual(2);
    const lastMsg = result.messages[result.messages.length - 1]!;
    expect(lastMsg.role).toBe("assistant");
  });
});
