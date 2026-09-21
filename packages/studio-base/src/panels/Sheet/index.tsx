// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { MCAPSheet, type McapWorkbookSource } from "@o16s/mcap-sheets";
import { useCallback, useEffect, useMemo } from "react";

import "@o16s/mcap-sheets/styles.css";

import { SettingsTreeAction } from "@foxglove/studio";
import { useDataSourceInfo } from "@foxglove/studio-base/PanelAPI";
import EmptyState from "@foxglove/studio-base/components/EmptyState";
import Panel from "@foxglove/studio-base/components/Panel";
import PanelToolbar from "@foxglove/studio-base/components/PanelToolbar";
import Stack from "@foxglove/studio-base/components/Stack";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import { usePanelSettingsTreeUpdate } from "@foxglove/studio-base/providers/PanelStateContextProvider";
import { SaveConfig } from "@foxglove/studio-base/types/panels";

import { makeBaseOpener, sheetSourceKey, sourceDisplayName, visibleTopics } from "./model";
import { buildSettingsTree, settingsActionReducer } from "./settings";
import { SheetConfig, defaultSheetConfig } from "./types";

type Props = {
  config: SheetConfig;
  saveConfig: SaveConfig<SheetConfig>;
};

function SheetPanel({ config, saveConfig }: Props): JSX.Element {
  const { currentSource } = usePlayerSelection();
  const { topics: availableTopicList } = useDataSourceInfo();

  const availableTopics = useMemo(
    () => availableTopicList.map((topic) => topic.name).sort((a, b) => a.localeCompare(b)),
    [availableTopicList],
  );

  // Publish the settings tree (one checkbox per available topic).
  const updatePanelSettingsTree = usePanelSettingsTreeUpdate();
  useEffect(() => {
    updatePanelSettingsTree({
      actionHandler: (action: SettingsTreeAction) => {
        saveConfig(settingsActionReducer(config, action));
      },
      nodes: buildSettingsTree(config, availableTopics),
    });
  }, [availableTopics, config, saveConfig, updatePanelSettingsTree]);

  const baseOpener = useMemo(() => makeBaseOpener(currentSource), [currentSource]);

  // Wrap the opener to drop the topics the user has hidden. The workbook stays
  // lazy — topic rows are still read on demand when a tab is opened. MCAPSheet
  // is remounted via `key` (below) when the source or hidden set changes, which
  // re-opens with the current filter and resets its tab/column state —
  // acceptable, since the visible topic set changed. (A mcap-sheets prop to hide
  // tabs in-place would avoid the re-open; a follow-up.)
  const hiddenTopics = config.hiddenTopics;
  const workbookOpener = useCallback(async (): Promise<McapWorkbookSource> => {
    if (!baseOpener) {
      throw new Error("No MCAP source to open");
    }
    const workbook = await baseOpener();
    return { ...workbook, topics: visibleTopics(workbook.topics, hiddenTopics) };
  }, [baseOpener, hiddenTopics]);

  const body = baseOpener ? (
    <MCAPSheet
      key={sheetSourceKey(currentSource, hiddenTopics)}
      fill
      url={sourceDisplayName(currentSource)}
      workbookOpener={workbookOpener}
    />
  ) : (
    <EmptyState>
      The Sheet panel opens an MCAP recording. Open an .mcap file (or MCAP URL) to see it here.
    </EmptyState>
  );

  return (
    <Stack fullHeight>
      <PanelToolbar />
      <Stack fullHeight style={{ minHeight: 0 }}>
        {body}
      </Stack>
    </Stack>
  );
}

SheetPanel.displayName = "SheetPanel";

export default Panel(
  Object.assign(SheetPanel, {
    panelType: "Sheet",
    defaultConfig: defaultSheetConfig,
  }),
);
