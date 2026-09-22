// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  blockCacheSizeBytes,
  DEFAULT_BLOCK_CACHE_SIZE_MB,
  MAX_BLOCK_CACHE_SIZE_MB,
  MIN_BLOCK_CACHE_SIZE_MB,
} from "./blockCacheSize";

describe("blockCacheSizeBytes", () => {
  it("returns the default when the setting is unset", () => {
    expect(blockCacheSizeBytes(undefined)).toBe(DEFAULT_BLOCK_CACHE_SIZE_MB * 1e6);
  });

  it("converts a valid MB setting to bytes", () => {
    expect(blockCacheSizeBytes(1500)).toBe(1500 * 1e6);
  });

  it("clamps below the minimum", () => {
    expect(blockCacheSizeBytes(10)).toBe(MIN_BLOCK_CACHE_SIZE_MB * 1e6);
  });

  it("clamps above the maximum", () => {
    expect(blockCacheSizeBytes(999999)).toBe(MAX_BLOCK_CACHE_SIZE_MB * 1e6);
  });

  it("falls back to the default for non-finite values", () => {
    expect(blockCacheSizeBytes(NaN)).toBe(DEFAULT_BLOCK_CACHE_SIZE_MB * 1e6);
    expect(blockCacheSizeBytes(Infinity)).toBe(DEFAULT_BLOCK_CACHE_SIZE_MB * 1e6);
  });
});
