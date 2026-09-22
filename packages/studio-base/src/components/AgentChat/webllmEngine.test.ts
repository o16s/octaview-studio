// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  initWebLLMEngine,
  getWebLLMStatus,
  subscribeWebLLMStatus,
  resetWebLLMEngine,
  unloadWebLLMEngine,
} from "./webllmEngine";

jest.mock("@mlc-ai/web-llm", () => {
  const engines = new Map<string, { unload: jest.Mock }>();

  return {
    CreateMLCEngine: jest.fn(
      async (
        modelId: string,
        opts?: { initProgressCallback?: (progress: { text: string; progress: number }) => void },
      ) => {
        // Simulate progress callback
        opts?.initProgressCallback?.({ text: "Downloading...", progress: 0.5 });
        opts?.initProgressCallback?.({ text: "Ready", progress: 1.0 });

        const engine = {
          chat: { completions: { create: jest.fn() } },
          unload: jest.fn(),
        };
        engines.set(modelId, engine);
        return engine;
      },
    ),
    _engines: engines,
  };
});

beforeEach(() => {
  resetWebLLMEngine();
  const webllm = jest.requireMock("@mlc-ai/web-llm");
  webllm.CreateMLCEngine.mockClear();
});

describe("WebLLM engine singleton", () => {
  it("starts in idle status", () => {
    expect(getWebLLMStatus()).toEqual({ state: "idle" });
  });

  it("transitions to loading and then ready when initialized", async () => {
    const states: string[] = [];
    const unsub = subscribeWebLLMStatus((status) => {
      states.push(status.state);
    });

    const engine = await initWebLLMEngine("test-model-1");
    unsub();

    expect(engine).toBeDefined();
    expect(engine.chat).toBeDefined();
    expect(getWebLLMStatus()).toEqual({ state: "ready" });
    expect(states).toContain("loading");
    expect(states).toContain("ready");
  });

  it("reuses engine when same model requested", async () => {
    const engine1 = await initWebLLMEngine("test-model-1");
    const engine2 = await initWebLLMEngine("test-model-1");

    expect(engine1).toBe(engine2);

    // CreateMLCEngine should only be called once
    const webllm = jest.requireMock("@mlc-ai/web-llm");
    expect(webllm.CreateMLCEngine).toHaveBeenCalledTimes(1);
  });

  it("unloads old engine and creates new one when model changes", async () => {
    const engine1 = await initWebLLMEngine("model-a");
    const engine2 = await initWebLLMEngine("model-b");

    expect(engine1).not.toBe(engine2);
    expect(engine1.unload).toHaveBeenCalled();
  });

  it("sets error status when engine creation fails", async () => {
    const webllm = jest.requireMock("@mlc-ai/web-llm");
    webllm.CreateMLCEngine.mockRejectedValueOnce(new Error("WebGPU not available"));

    await expect(initWebLLMEngine("bad-model")).rejects.toThrow("WebGPU not available");
    expect(getWebLLMStatus()).toEqual({ state: "error", error: "WebGPU not available" });
  });

  it("deduplicates concurrent calls for the same model", async () => {
    const webllm = jest.requireMock("@mlc-ai/web-llm");

    // Start two loads concurrently for the same model
    const promise1 = initWebLLMEngine("concurrent-model");
    const promise2 = initWebLLMEngine("concurrent-model");

    const [engine1, engine2] = await Promise.all([promise1, promise2]);

    expect(engine1).toBe(engine2);
    expect(webllm.CreateMLCEngine).toHaveBeenCalledTimes(1);
  });

  it("unload during loading prevents engine from being set", async () => {
    const webllm = jest.requireMock("@mlc-ai/web-llm");

    // Make CreateMLCEngine return a promise we control
    let resolveEngine!: (engine: unknown) => void;
    const enginePromise = new Promise((resolve) => {
      resolveEngine = resolve;
    });
    webllm.CreateMLCEngine.mockImplementationOnce(async () => await enginePromise);

    const loadPromise = initWebLLMEngine("slow-model");

    // Wait a tick so the async function reaches the await
    await Promise.resolve();

    // Unload while loading is in-flight
    unloadWebLLMEngine();
    expect(getWebLLMStatus()).toEqual({ state: "idle" });

    // Now resolve the engine creation
    const mockEngine = {
      chat: { completions: { create: jest.fn() } },
      unload: jest.fn(),
    };
    resolveEngine(mockEngine);

    // The load should complete but NOT install the engine as singleton
    const engine = await loadPromise;
    expect(engine).toBeDefined();
    // The stale engine should have been unloaded
    expect(mockEngine.unload).toHaveBeenCalled();

    // Re-requesting the same model should create a new one (not reuse)
    webllm.CreateMLCEngine.mockClear();
    await initWebLLMEngine("slow-model");
    expect(webllm.CreateMLCEngine).toHaveBeenCalledTimes(1);
  });

  it("unloadWebLLMEngine releases GPU memory and resets to idle", async () => {
    const engine = await initWebLLMEngine("model-to-unload");
    expect(getWebLLMStatus()).toEqual({ state: "ready" });

    unloadWebLLMEngine();

    expect(engine.unload).toHaveBeenCalled();
    expect(getWebLLMStatus()).toEqual({ state: "idle" });

    // Next init should create a new engine (not reuse)
    const webllm = jest.requireMock("@mlc-ai/web-llm");
    webllm.CreateMLCEngine.mockClear();
    await initWebLLMEngine("model-to-unload");
    expect(webllm.CreateMLCEngine).toHaveBeenCalledTimes(1);
  });
});
