// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { PerfStatsRegistry, formatPerfLine } from "./perfStats";

describe("PerfStatsRegistry", () => {
  it("accumulates counts and resets them on report", () => {
    const stats = new PerfStatsRegistry();
    stats.count("video.framesIn");
    stats.count("video.framesIn", 2);
    expect(stats.report()).toEqual({ "video.framesIn": 3 });
    expect(stats.report()).toBeUndefined();
  });

  it("tracks the interval max and resets it on report", () => {
    const stats = new PerfStatsRegistry();
    stats.max("video.queueMax", 3);
    stats.max("video.queueMax", 1);
    expect(stats.report()).toEqual({ "video.queueMax": 3 });
    expect(stats.report()).toBeUndefined();
  });

  it("reports a changed gauge, then stays quiet until something changes", () => {
    const stats = new PerfStatsRegistry();
    stats.gauge("blocks.total", 400);
    expect(stats.report()).toEqual({ "blocks.total": 400 });
    // unchanged gauge alone does not produce a report
    expect(stats.report()).toBeUndefined();
    // but any new activity re-includes all gauges for context
    stats.count("blocks.cacheFull");
    expect(stats.report()).toEqual({ "blocks.total": 400, "blocks.cacheFull": 1 });
  });

  it("returns undefined when nothing was recorded", () => {
    expect(new PerfStatsRegistry().report()).toBeUndefined();
  });
});

describe("formatPerfLine", () => {
  it("formats sorted key=value pairs with rounded values", () => {
    expect(formatPerfLine({ b: 2, a: 1.25 })).toBe("[perf] a=1.3 b=2");
  });
});
