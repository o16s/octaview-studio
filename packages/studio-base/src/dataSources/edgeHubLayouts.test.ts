// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { LayoutData } from "@foxglove/studio-base/context/CurrentLayoutContext/actions";

import { parseEdgeHubLayouts, serializeEdgeHubLayouts, setEdgeHubLayout } from "./edgeHubLayouts";

const layoutA = { layout: "A", configById: {} } as unknown as LayoutData;
const layoutB = { layout: "B", configById: {} } as unknown as LayoutData;

describe("serializeEdgeHubLayouts / parseEdgeHubLayouts", () => {
  it("round-trips a map of layouts keyed by ip", () => {
    const layouts = { "192.168.1.100": layoutA, bl335: layoutB };
    expect(parseEdgeHubLayouts(serializeEdgeHubLayouts(layouts))).toEqual(layouts);
  });

  it("returns an empty map for undefined input", () => {
    expect(parseEdgeHubLayouts(undefined)).toEqual({});
  });

  it("returns an empty map for malformed JSON", () => {
    expect(parseEdgeHubLayouts("not json")).toEqual({});
  });

  it("returns an empty map when the top-level value isn't an object", () => {
    expect(parseEdgeHubLayouts(JSON.stringify([1, 2, 3]))).toEqual({});
    expect(parseEdgeHubLayouts(JSON.stringify("hello"))).toEqual({});
    expect(parseEdgeHubLayouts(JSON.stringify(ReactNull))).toEqual({});
  });

  it("drops individually malformed entries rather than discarding the whole map", () => {
    const serialized = JSON.stringify({
      "192.168.1.100": layoutA,
      "10.0.0.1": "not an object",
      bl335: layoutB,
    });
    expect(parseEdgeHubLayouts(serialized)).toEqual({
      "192.168.1.100": layoutA,
      bl335: layoutB,
    });
  });
});

describe("setEdgeHubLayout", () => {
  it("adds a layout for a new ip without touching existing entries", () => {
    const existing = { "192.168.1.100": layoutA };
    expect(setEdgeHubLayout(existing, "bl335", layoutB)).toEqual({
      "192.168.1.100": layoutA,
      bl335: layoutB,
    });
    // existing map is not mutated
    expect(existing).toEqual({ "192.168.1.100": layoutA });
  });

  it("overwrites the layout for an existing ip", () => {
    const existing = { "192.168.1.100": layoutA };
    expect(setEdgeHubLayout(existing, "192.168.1.100", layoutB)).toEqual({
      "192.168.1.100": layoutB,
    });
  });
});
