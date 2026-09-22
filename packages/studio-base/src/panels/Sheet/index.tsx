// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  LOG_TIME_COLUMN,
  MCAPSheet,
  type MCAPSelection,
  type McapWorkbookSource,
  type TopicRowsView,
} from "@o16s/mcap-sheets";
import { useCallback, useEffect, useMemo, useState } from "react";

import "@o16s/mcap-sheets/styles.css";

import { Time } from "@foxglove/rostime";
import { SettingsTreeAction } from "@foxglove/studio";
import { useDataSourceInfo } from "@foxglove/studio-base/PanelAPI";
import EmptyState from "@foxglove/studio-base/components/EmptyState";
import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import Panel from "@foxglove/studio-base/components/Panel";
import PanelToolbar from "@foxglove/studio-base/components/PanelToolbar";
import Stack from "@foxglove/studio-base/components/Stack";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import { usePanelSettingsTreeUpdate } from "@foxglove/studio-base/providers/PanelStateContextProvider";
import { SaveConfig } from "@foxglove/studio-base/types/panels";

import {
  buildTimeIndex,
  makeBaseOpener,
  rowIndexAtTime,
  sheetSourceKey,
  sourceDisplayName,
  visibleTopics,
  type TimeRow,
} from "./model";
import { buildSettingsTree, settingsActionReducer } from "./settings";
import { SheetConfig, defaultSheetConfig } from "./types";

type Props = {
  config: SheetConfig;
  saveConfig: SaveConfig<SheetConfig>;
};

// Translucent accent that reads on the sheet's light rows, in either app theme.
const PLAYBACK_HIGHLIGHT = "rgba(255, 138, 0, 0.22)";

const selectCurrentTime = (ctx: MessagePipelineContext) => ctx.playerState.activeData?.currentTime;
const selectSeekPlayback = (ctx: MessagePipelineContext) => ctx.seekPlayback;

const timeToNanos = (time: Time): bigint => BigInt(time.sec) * 1_000_000_000n + BigInt(time.nsec);
const nanosToTime = (nanos: bigint): Time => ({
  sec: Number(nanos / 1_000_000_000n),
  nsec: Number(nanos % 1_000_000_000n),
});

// The current topic's rows view and a time index into it, for the playback link.
type LoadedTopic = {
  topic: string;
  view: TopicRowsView;
  index: TimeRow[];
};

function SheetPanel({ config, saveConfig }: Props): JSX.Element {
  const { currentSource } = usePlayerSelection();
  const { topics: availableTopicList } = useDataSourceInfo();
  const currentTime = useMessagePipeline(selectCurrentTime);
  const seekPlayback = useMessagePipeline(selectSeekPlayback);

  const availableTopics = useMemo(
    () => availableTopicList.map((topic) => topic.name).sort((a, b) => a.localeCompare(b)),
    [availableTopicList],
  );

  // Publish the settings tree (a per-topic visibility toggle).
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

  // --- Playback <-> row link ---
  // MCAPSheet reports the visible topic's rows; we index them by log_time so we
  // can (a) highlight/scroll to the row under the play bar, and (b) seek when a
  // row is clicked. Reset on remount (new source/topic set) via `key`.
  const [loaded, setLoaded] = useState<LoadedTopic | undefined>();
  const handleRowsLoaded = useCallback((topic: string, view: TopicRowsView) => {
    setLoaded({ topic, view, index: buildTimeIndex(view.column(LOG_TIME_COLUMN) ?? []) });
  }, []);

  // The row the play bar is currently on (latest row at or before now).
  const highlightRowIndex = useMemo(() => {
    if (!currentTime || !loaded) {
      return undefined;
    }
    return rowIndexAtTime(loaded.index, timeToNanos(currentTime));
  }, [currentTime, loaded]);

  const highlights = useMemo(
    () =>
      highlightRowIndex == undefined || !loaded
        ? undefined
        : {
            topic: loaded.topic,
            rows: [{ rowIndex: highlightRowIndex, color: PLAYBACK_HIGHLIGHT }],
          },
    [highlightRowIndex, loaded],
  );

  // Clicking a single cell seeks playback to that row's log_time. A range
  // selection (for copy) leaves playback alone.
  const handleSelectionChange = useCallback(
    (selection: MCAPSelection) => {
      if (selection.cells.length !== 1 || !loaded || !seekPlayback) {
        return;
      }
      const raw = loaded.view.cell(selection.cells[0]!.rowIndex, LOG_TIME_COLUMN);
      if (typeof raw === "string" && raw.length > 0) {
        try {
          seekPlayback(nanosToTime(BigInt(raw)));
        } catch {
          // Non-integer timestamp — nothing to seek to.
        }
      }
    },
    [loaded, seekPlayback],
  );

  const body = baseOpener ? (
    <MCAPSheet
      key={sheetSourceKey(currentSource, hiddenTopics)}
      fill
      url={sourceDisplayName(currentSource)}
      workbookOpener={workbookOpener}
      onRowsLoaded={handleRowsLoaded}
      highlights={highlights}
      scrollToRowIndex={highlightRowIndex}
      selectable
      onSelectionChange={handleSelectionChange}
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
