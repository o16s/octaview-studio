// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export type WebLLMModel = {
  id: string;
  label: string;
  vramGB: number;
};

/**
 * Models with tool-calling support in WebLLM.
 * Only Hermes models support function calling in WebLLM's runtime.
 * See: https://github.com/mlc-ai/web-llm
 */
export const WEBLLM_MODELS: WebLLMModel[] = [
  {
    id: "Hermes-2-Pro-Mistral-7B-q4f16_1-MLC",
    label: "Hermes 2 Pro Mistral 7B (q4f16)",
    vramGB: 4.5,
  },
  {
    id: "Hermes-2-Pro-Llama-3-8B-q4f16_1-MLC",
    label: "Hermes 2 Pro Llama 3 8B (q4f16)",
    vramGB: 5,
  },
  {
    id: "Hermes-2-Pro-Llama-3-8B-q4f32_1-MLC",
    label: "Hermes 2 Pro Llama 3 8B (q4f32)",
    vramGB: 5,
  },
  { id: "Hermes-3-Llama-3.1-8B-q4f16_1-MLC", label: "Hermes 3 Llama 3.1 8B (q4f16)", vramGB: 5 },
  { id: "Hermes-3-Llama-3.1-8B-q4f32_1-MLC", label: "Hermes 3 Llama 3.1 8B (q4f32)", vramGB: 6 },
];

const RAM_TIERS = [8, 16, 24, 64] as const;
export type RAMTier = (typeof RAM_TIERS)[number];

/** Return models that fit in the VRAM budget (75% of stated RAM). */
export function getModelsForRAM(ramGB: number): WebLLMModel[] {
  const vramBudget = ramGB * 0.75;
  return WEBLLM_MODELS.filter((m) => m.vramGB <= vramBudget);
}
