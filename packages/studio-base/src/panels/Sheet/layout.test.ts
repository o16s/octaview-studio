// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { defaultLayout } from "@foxglove/studio-base/providers/CurrentLayoutProvider/defaultLayout";
import { getPanelTypeFromId } from "@foxglove/studio-base/util/layout";

import { isPristineDefaultLayout, makeSingleSheetLayout } from "./layout";

describe("makeSingleSheetLayout", () => {
  it("is a single Sheet panel filling the window", () => {
    const data = makeSingleSheetLayout();
    expect(typeof data.layout).toBe("string");
    const rootId = data.layout as string;
    expect(getPanelTypeFromId(rootId)).toBe("Sheet");
    expect(Object.keys(data.configById)).toEqual([rootId]);
    expect(data.globalVariables).toEqual({});
    expect(data.playbackConfig).toBeDefined();
  });
});

describe("isPristineDefaultLayout", () => {
  it("treats the stock default (or absence) as pristine", () => {
    expect(isPristineDefaultLayout(undefined)).toBe(true);
    expect(isPristineDefaultLayout(defaultLayout)).toBe(true);
    // Panel config values may migrate without counting as customization.
    expect(
      isPristineDefaultLayout({ ...defaultLayout, configById: { ...defaultLayout.configById } }),
    ).toBe(true);
  });

  it("treats a changed arrangement or panel set as customized", () => {
    // A single Sheet layout is not the default.
    expect(isPristineDefaultLayout(makeSingleSheetLayout())).toBe(false);
    // A resized default (different split) is customized.
    expect(
      isPristineDefaultLayout({
        ...defaultLayout,
        layout: { first: "a", second: "b", direction: "row", splitPercentage: 42 },
      }),
    ).toBe(false);
  });
});
