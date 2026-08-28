// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { fieldToPanelType } from "./fieldToPanelType";

describe("fieldToPanelType", () => {
  it("maps bool to StateTransitions", () => {
    expect(fieldToPanelType({ type: "bool", isLeaf: true })).toBe("StateTransitions");
  });

  it.each(["int8", "uint8", "int16", "uint16", "int32", "uint32", "int64", "uint64", "float32", "float64", "time", "duration"])(
    "maps numeric type %s to Plot",
    (type) => {
      expect(fieldToPanelType({ type, isLeaf: true })).toBe("Plot");
    },
  );

  it("maps string to RawMessages", () => {
    expect(fieldToPanelType({ type: "string", isLeaf: true })).toBe("RawMessages");
  });

  it("returns undefined for array types", () => {
    expect(fieldToPanelType({ type: "float64[]", isLeaf: true })).toBeUndefined();
    expect(fieldToPanelType({ type: "string[]", isLeaf: true })).toBeUndefined();
  });

  it("returns undefined for non-leaf (complex/nested) fields", () => {
    expect(fieldToPanelType({ type: "float64", isLeaf: false })).toBeUndefined();
    expect(fieldToPanelType({ type: "foxglove.Point2", isLeaf: false })).toBeUndefined();
  });

  it("returns undefined for unrecognized complex schema types", () => {
    expect(fieldToPanelType({ type: "foxglove.Point2", isLeaf: true })).toBeUndefined();
  });
});
