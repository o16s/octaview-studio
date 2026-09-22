// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Default block-preload cache budget. When still-subscribed preloaded data
 * (plot history) exceeds the budget, preloading stops with a "cache is full"
 * problem — so large multi-file recordings may need a bigger budget, while
 * low-memory machines may want a smaller one. Users tune it in Preferences.
 */
export const DEFAULT_BLOCK_CACHE_SIZE_MB = 1000;
export const MIN_BLOCK_CACHE_SIZE_MB = 100;
/** Chromium's renderer heap tops out around 4 GB; leave room for everything else. */
export const MAX_BLOCK_CACHE_SIZE_MB = 3000;

/** Convert the user's cache-size setting (MB) to a safe byte budget. */
export function blockCacheSizeBytes(settingMb: number | undefined): number {
  const mb =
    settingMb != undefined && Number.isFinite(settingMb) ? settingMb : DEFAULT_BLOCK_CACHE_SIZE_MB;
  return Math.min(Math.max(mb, MIN_BLOCK_CACHE_SIZE_MB), MAX_BLOCK_CACHE_SIZE_MB) * 1e6;
}
