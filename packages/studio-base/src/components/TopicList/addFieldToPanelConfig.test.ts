// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { PanelConfig } from "@foxglove/studio-base/types/panels";

import { appendFieldToConfig, createSeedConfigForField } from "./addFieldToPanelConfig";

describe("createSeedConfigForField", () => {
  it("seeds a Plot config with one enabled path", () => {
    expect(createSeedConfigForField("Plot", "/topic.field")).toEqual({
      paths: [{ value: "/topic.field", enabled: true, timestampMethod: "receiveTime" }],
    });
  });

  it("seeds a StateTransitions config with one enabled path", () => {
    expect(createSeedConfigForField("StateTransitions", "/topic.field")).toEqual({
      paths: [{ value: "/topic.field", enabled: true, timestampMethod: "receiveTime" }],
    });
  });

  it("seeds a RawMessages config with topicPath set", () => {
    expect(createSeedConfigForField("RawMessages", "/topic.field")).toEqual({
      topicPath: "/topic.field",
    });
  });
});

describe("appendFieldToConfig", () => {
  it("appends a new path to an existing Plot config", () => {
    const existing: PanelConfig = {
      paths: [{ value: "/topic.other", enabled: true, timestampMethod: "receiveTime" }],
    };
    expect(appendFieldToConfig("Plot", existing, "/topic.field")).toEqual({
      paths: [
        { value: "/topic.other", enabled: true, timestampMethod: "receiveTime" },
        { value: "/topic.field", enabled: true, timestampMethod: "receiveTime" },
      ],
    });
  });

  it("does not duplicate a path that's already present in a Plot config", () => {
    const existing: PanelConfig = {
      paths: [{ value: "/topic.field", enabled: true, timestampMethod: "receiveTime" }],
    };
    expect(appendFieldToConfig("Plot", existing, "/topic.field")).toEqual({
      paths: [{ value: "/topic.field", enabled: true, timestampMethod: "receiveTime" }],
    });
  });

  it("appends a new path to an existing StateTransitions config", () => {
    const existing: PanelConfig = {
      isSynced: true,
      paths: [{ value: "/topic.other", timestampMethod: "receiveTime" }],
    };
    expect(appendFieldToConfig("StateTransitions", existing, "/topic.field")).toEqual({
      isSynced: true,
      paths: [
        { value: "/topic.other", timestampMethod: "receiveTime" },
        { value: "/topic.field", enabled: true, timestampMethod: "receiveTime" },
      ],
    });
  });

  it("replaces the single path on an existing RawMessages config", () => {
    const existing: PanelConfig = { topicPath: "/topic.other", fontSize: 12 };
    expect(appendFieldToConfig("RawMessages", existing, "/topic.field")).toEqual({
      topicPath: "/topic.field",
      fontSize: 12,
    });
  });
});
