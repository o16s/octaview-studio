// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { plotableRosTypes } from "@foxglove/studio-base/panels/Plot/plotableRosTypes";

/** Panel types that a single message path field can be added to via one click. */
export type FieldPanelType = "Plot" | "StateTransitions" | "RawMessages";

const numericPlotTypes = new Set(plotableRosTypes.filter((type) => type !== "bool" && type !== "string"));

/**
 * Given a message path field's schema type (e.g. `"float64"`, `"bool"`, `"string[]"`) and
 * whether it's a leaf (no children), decides which panel type is best suited to display it,
 * or `undefined` if there's no good one-click panel for this field (arrays, nested messages).
 */
export function fieldToPanelType({
  type,
  isLeaf,
}: {
  type: string;
  isLeaf: boolean;
}): FieldPanelType | undefined {
  if (!isLeaf) {
    return undefined;
  }
  if (type === "bool") {
    return "StateTransitions";
  }
  if (type === "string") {
    return "RawMessages";
  }
  if (numericPlotTypes.has(type)) {
    return "Plot";
  }
  return undefined;
}
