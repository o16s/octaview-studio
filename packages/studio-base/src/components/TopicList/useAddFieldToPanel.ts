// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useCallback } from "react";

import {
  useCurrentLayoutActions,
  useCurrentLayoutSelector,
} from "@foxglove/studio-base/context/CurrentLayoutContext";
import useAddPanel from "@foxglove/studio-base/hooks/useAddPanel";
import { useLastFocusedPanelByType } from "@foxglove/studio-base/hooks/useLastFocusedPanelByType";

import { appendFieldToConfig, createSeedConfigForField } from "./addFieldToPanelConfig";
import { FieldPanelType, fieldToPanelType } from "./fieldToPanelType";

export function useAddFieldToPanel({
  type,
  isLeaf,
  fullPath,
}: {
  type: string;
  isLeaf: boolean;
  fullPath: string;
}): {
  panelType: FieldPanelType | undefined;
  addToNewPanel: () => void;
  addToExistingPanel: () => void;
  canAddToExisting: boolean;
} {
  const panelType = fieldToPanelType({ type, isLeaf });

  const addPanel = useAddPanel();
  const { savePanelConfigs, getCurrentLayoutState } = useCurrentLayoutActions();

  const existingPanelId = useLastFocusedPanelByType(panelType ?? "");

  const existingPanelConfig = useCurrentLayoutSelector(
    useCallback(
      (layoutState) =>
        existingPanelId == undefined
          ? undefined
          : layoutState.selectedLayout?.data?.configById[existingPanelId],
      [existingPanelId],
    ),
  );

  const addToNewPanel = useCallback(() => {
    if (!panelType) {
      return;
    }
    addPanel({ type: panelType, config: createSeedConfigForField(panelType, fullPath) });
  }, [addPanel, fullPath, panelType]);

  const addToExistingPanel = useCallback(() => {
    if (!panelType || existingPanelId == undefined) {
      return;
    }
    // Re-read the latest config at click time in case it changed since the last render.
    const currentConfig =
      getCurrentLayoutState().selectedLayout?.data?.configById[existingPanelId] ?? {};
    savePanelConfigs({
      configs: [{ id: existingPanelId, config: appendFieldToConfig(panelType, currentConfig, fullPath) }],
    });
  }, [existingPanelId, fullPath, getCurrentLayoutState, panelType, savePanelConfigs]);

  return {
    panelType,
    addToNewPanel,
    addToExistingPanel,
    canAddToExisting: existingPanelId != undefined && existingPanelConfig != undefined,
  };
}
