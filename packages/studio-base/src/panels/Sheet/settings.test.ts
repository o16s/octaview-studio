// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { SettingsTreeAction } from "@foxglove/studio";

import { settingsActionReducer } from "./settings";

const setVisible = (topic: string, visible: { value: boolean }): SettingsTreeAction => ({
  action: "update",
  payload: { path: ["topics", topic, "visible"], input: "boolean", value: visible.value },
});

describe("settingsActionReducer", () => {
  it("hiding a topic adds it to the hidden set", () => {
    expect(settingsActionReducer({}, setVisible("/b", { value: false }))).toEqual({
      hiddenTopics: ["/b"],
    });
  });

  it("showing a topic removes it from the hidden set", () => {
    expect(
      settingsActionReducer({ hiddenTopics: ["/a", "/b"] }, setVisible("/a", { value: true })),
    ).toEqual({ hiddenTopics: ["/b"] });
  });

  it("does not disturb topics that aren't toggled (later topics stay visible)", () => {
    expect(
      settingsActionReducer({ hiddenTopics: ["/b"] }, setVisible("/c", { value: false })),
    ).toEqual({ hiddenTopics: ["/b", "/c"] });
  });

  it("ignores actions that are not topic-visibility toggles", () => {
    const config = { hiddenTopics: ["/a"] };
    expect(
      settingsActionReducer(config, {
        action: "perform-node-action",
        payload: { id: "x", path: [] },
      }),
    ).toBe(config);
    // A field update at the wrong depth is ignored.
    expect(
      settingsActionReducer(config, {
        action: "update",
        payload: { path: ["topics", "/a"], input: "boolean", value: false },
      }),
    ).toBe(config);
  });
});
