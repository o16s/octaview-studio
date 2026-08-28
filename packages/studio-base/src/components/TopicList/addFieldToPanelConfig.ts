// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";

import { PlotPath } from "@foxglove/studio-base/panels/Plot/config";
import { StateTransitionPath } from "@foxglove/studio-base/panels/StateTransitions/types";
import { PanelConfig } from "@foxglove/studio-base/types/panels";

import { FieldPanelType } from "./fieldToPanelType";

function newPathEntry(fullPath: string): PlotPath | StateTransitionPath {
  return { value: fullPath, enabled: true, timestampMethod: "receiveTime" };
}

/** Builds the initial config for a brand-new panel seeded with a single field. */
export function createSeedConfigForField(panelType: FieldPanelType, fullPath: string): PanelConfig {
  switch (panelType) {
    case "Plot":
    case "StateTransitions":
      return { paths: [newPathEntry(fullPath)] };
    case "RawMessages":
      return { topicPath: fullPath };
  }
}

/** Merges a field into an existing panel's config (appending, or replacing for single-path panels). */
export function appendFieldToConfig(
  panelType: FieldPanelType,
  existingConfig: PanelConfig,
  fullPath: string,
): PanelConfig {
  switch (panelType) {
    case "Plot":
    case "StateTransitions": {
      const paths = (existingConfig.paths as (PlotPath | StateTransitionPath)[] | undefined) ?? [];
      return {
        ...existingConfig,
        paths: _.uniqBy([...paths, newPathEntry(fullPath)], (path) => path.value),
      };
    }
    case "RawMessages":
      return { ...existingConfig, topicPath: fullPath };
  }
}
