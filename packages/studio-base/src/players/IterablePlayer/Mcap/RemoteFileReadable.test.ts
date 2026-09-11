// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  DEFAULT_CACHE_SIZE_IN_BYTES,
  MIN_CACHE_SIZE_IN_BYTES,
  cacheSizeForSourceCount,
} from "./RemoteFileReadable";

describe("cacheSizeForSourceCount", () => {
  it("gives one recording the whole budget", () => {
    expect(cacheSizeForSourceCount(1)).toBe(DEFAULT_CACHE_SIZE_IN_BYTES);
  });

  it("gives one recording the whole budget when the count is not known", () => {
    expect(cacheSizeForSourceCount(0)).toBe(DEFAULT_CACHE_SIZE_IN_BYTES);
  });

  it("shares the budget between recordings that are open together", () => {
    expect(cacheSizeForSourceCount(2)).toBe(DEFAULT_CACHE_SIZE_IN_BYTES / 2);
    expect(cacheSizeForSourceCount(4)).toBe(DEFAULT_CACHE_SIZE_IN_BYTES / 4);
  });

  it("keeps the total at the budget for any count", () => {
    for (const count of [2, 3, 5, 8, 12]) {
      expect(cacheSizeForSourceCount(count) * count).toBeLessThanOrEqual(
        DEFAULT_CACHE_SIZE_IN_BYTES,
      );
    }
  });

  it("stops sharing at the floor, because a read larger than the cache throws", () => {
    // 200 MiB over 100 recordings is 2 MiB, which one MCAP chunk can exceed.
    expect(cacheSizeForSourceCount(100)).toBe(MIN_CACHE_SIZE_IN_BYTES);
    expect(cacheSizeForSourceCount(1000)).toBe(MIN_CACHE_SIZE_IN_BYTES);
  });
});
