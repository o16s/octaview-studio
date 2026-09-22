// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { WebLLMEngine } from "./completionProvider";

export type WebLLMStatus =
  | { state: "idle" }
  | { state: "loading"; progress?: number; text?: string }
  | { state: "ready" }
  | { state: "error"; error: string };

type EngineWithUnload = WebLLMEngine & { unload: () => void };

let currentEngine: EngineWithUnload | undefined;
let currentModelId: string | undefined;
let currentContextSize: number | undefined;
let currentStatus: WebLLMStatus = { state: "idle" };
const listeners = new Set<(status: WebLLMStatus) => void>();

// Guard against concurrent init calls
let loadingPromise: Promise<EngineWithUnload> | undefined;
let loadingModelId: string | undefined;
let loadingContextSize: number | undefined;

// Monotonically increasing generation counter to detect stale loads
let initGeneration = 0;

function setStatus(status: WebLLMStatus) {
  currentStatus = status;
  for (const listener of listeners) {
    listener(status);
  }
}

export function getWebLLMStatus(): WebLLMStatus {
  return currentStatus;
}

export function subscribeWebLLMStatus(listener: (status: WebLLMStatus) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export async function initWebLLMEngine(
  modelId: string,
  contextSize?: number,
): Promise<EngineWithUnload> {
  if (currentEngine && currentModelId === modelId && currentContextSize === contextSize) {
    return currentEngine;
  }

  // Deduplicate concurrent calls for the same model+context
  if (loadingPromise && loadingModelId === modelId && loadingContextSize === contextSize) {
    return await loadingPromise;
  }

  if (currentEngine) {
    currentEngine.unload();
    currentEngine = undefined;
    currentModelId = undefined;
    currentContextSize = undefined;
  }

  setStatus({ state: "loading" });

  const generation = ++initGeneration;

  const promise = (async () => {
    const { CreateMLCEngine } = await import("@mlc-ai/web-llm");
    const chatOpts =
      contextSize != undefined && Number.isFinite(contextSize) && contextSize !== 0
        ? { context_window_size: contextSize }
        : undefined;
    const engine = (await CreateMLCEngine(
      modelId,
      {
        initProgressCallback: (progress: { text: string; progress: number }) => {
          // Only update status if this load is still the current one
          if (initGeneration === generation) {
            setStatus({ state: "loading", progress: progress.progress, text: progress.text });
          }
        },
      },
      chatOpts,
    )) as EngineWithUnload;

    // If unload was called (or a different model started) while we were loading,
    // don't install this engine — it's stale.
    if (initGeneration !== generation) {
      engine.unload();
      return engine;
    }

    currentEngine = engine;
    currentModelId = modelId;
    currentContextSize = contextSize;
    setStatus({ state: "ready" });
    return engine;
  })();

  loadingPromise = promise;
  loadingModelId = modelId;
  loadingContextSize = contextSize;

  try {
    return await promise;
  } catch (err) {
    setStatus({ state: "error", error: err instanceof Error ? err.message : String(err) });
    throw err;
  } finally {
    loadingPromise = undefined;
    loadingModelId = undefined;
    loadingContextSize = undefined;
  }
}

/** Unload the engine to release GPU memory. */
export function unloadWebLLMEngine(): void {
  // Bump generation so any in-flight load won't install its engine
  initGeneration++;
  if (currentEngine) {
    currentEngine.unload();
    currentEngine = undefined;
    currentModelId = undefined;
    currentContextSize = undefined;
  }
  setStatus({ state: "idle" });
}

/** Reset singleton state — for testing only. */
export function resetWebLLMEngine(): void {
  currentEngine = undefined;
  currentModelId = undefined;
  currentContextSize = undefined;
  currentStatus = { state: "idle" };
  loadingPromise = undefined;
  loadingModelId = undefined;
  loadingContextSize = undefined;
  initGeneration = 0;
  listeners.clear();
}
