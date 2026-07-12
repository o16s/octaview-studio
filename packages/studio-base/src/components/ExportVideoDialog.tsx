// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  LinearProgress,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from "@mui/material";
import { ReactElement, useCallback, useMemo, useState } from "react";

import { MessageEvent } from "@foxglove/studio";
import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import Stack from "@foxglove/studio-base/components/Stack";
import { downloadFiles } from "@foxglove/studio-base/util/download";
import {
  ExportVideoProgress,
  getImageTopics,
  exportToWebM,
} from "@foxglove/studio-base/util/videoExporter";

const selectTopics = (ctx: MessagePipelineContext) => ctx.sortedTopics;
const selectBlocks = (ctx: MessagePipelineContext) =>
  ctx.playerState.progress?.messageCache?.blocks;

type ExportState =
  | { status: "idle" }
  | { status: "exporting"; progress: ExportVideoProgress }
  | { status: "done"; blob: Blob; filename: string }
  | { status: "error"; message: string };

export function ExportVideoDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): ReactElement {
  const topics = useMessagePipeline(selectTopics);
  const blocks = useMessagePipeline(selectBlocks);

  const imageTopics = useMemo(
    () =>
      getImageTopics(
        topics.map((t) => ({ name: t.name, schemaName: t.schemaName })),
      ),
    [topics],
  );

  const [selectedTopic, setSelectedTopic] = useState<string | undefined>();
  const [exportState, setExportState] = useState<ExportState>({ status: "idle" });

  const getBlockMessages = useCallback(
    (topic: string): MessageEvent[] => {
      if (!blocks) return [];
      const result: MessageEvent[] = [];
      for (const block of blocks) {
        if (!block) continue;
        const topicMessages = block.messagesByTopic[topic];
        if (topicMessages) {
          result.push(...topicMessages);
        }
      }
      return result;
    },
    [blocks],
  );

  const handleExport = useCallback(async () => {
    if (!selectedTopic) return;

    const topicInfo = imageTopics.find((t) => t.name === selectedTopic);
    if (!topicInfo?.schemaName) return;

    setExportState({ status: "exporting", progress: { framesProcessed: 0, totalFrames: 0 } });

    try {
      const messages = getBlockMessages(selectedTopic);
      if (messages.length === 0) {
        setExportState({ status: "error", message: "No image messages found for this topic. Make sure the recording is fully loaded." });
        return;
      }

      const blob = await exportToWebM(messages, topicInfo.schemaName, (progress) => {
        setExportState({ status: "exporting", progress });
      });

      const filename = `${selectedTopic.replace(/\//g, "_").replace(/^_/, "")}.webm`;
      setExportState({ status: "done", blob, filename });
    } catch (err) {
      setExportState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [selectedTopic, imageTopics, getBlockMessages]);

  const handleDownload = useCallback(() => {
    if (exportState.status === "done") {
      downloadFiles([{ blob: exportState.blob, fileName: exportState.filename }]);
    }
  }, [exportState]);

  const handleClose = useCallback(() => {
    setExportState({ status: "idle" });
    setSelectedTopic(undefined);
    onClose();
  }, [onClose]);

  const isExporting = exportState.status === "exporting";

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth>
      <DialogTitle>Export Video</DialogTitle>
      <DialogContent>
        {imageTopics.length === 0 ? (
          <Typography color="text.secondary">
            No image or video topics found. Open a recording with camera data first.
          </Typography>
        ) : (
          <Stack gap={2}>
            <Typography variant="body2" color="text.secondary">
              Select an image topic to export as WebM video (VP8/VP9, royalty-free):
            </Typography>
            <List dense disablePadding sx={{ border: 1, borderColor: "divider", borderRadius: 1, maxHeight: 240, overflow: "auto" }}>
              {imageTopics.map((topic) => (
                <ListItemButton
                  key={topic.name}
                  selected={selectedTopic === topic.name}
                  onClick={() => setSelectedTopic(topic.name)}
                  disabled={isExporting}
                >
                  <ListItemText
                    primary={topic.name}
                    secondary={topic.schemaName}
                  />
                </ListItemButton>
              ))}
            </List>

            {exportState.status === "exporting" && (
              <Stack gap={0.5}>
                <LinearProgress
                  variant={exportState.progress.totalFrames > 0 ? "determinate" : "indeterminate"}
                  value={
                    exportState.progress.totalFrames > 0
                      ? (exportState.progress.framesProcessed / exportState.progress.totalFrames) * 100
                      : undefined
                  }
                />
                <Typography variant="caption" color="text.secondary">
                  Processing frame {exportState.progress.framesProcessed}
                  {exportState.progress.totalFrames > 0
                    ? ` of ${exportState.progress.totalFrames}`
                    : ""}
                  ...
                </Typography>
              </Stack>
            )}

            {exportState.status === "done" && (
              <Typography variant="body2" color="success.main">
                Export complete! {exportState.filename} ({(exportState.blob.size / 1024 / 1024).toFixed(1)} MB)
              </Typography>
            )}

            {exportState.status === "error" && (
              <Typography variant="body2" color="error.main">
                Error: {exportState.message}
              </Typography>
            )}
          </Stack>
        )}
      </DialogContent>
      <DialogActions>
        <Button onClick={handleClose} disabled={isExporting}>
          {exportState.status === "done" ? "Close" : "Cancel"}
        </Button>
        {exportState.status === "done" ? (
          <Button variant="contained" onClick={handleDownload}>
            Download
          </Button>
        ) : (
          <Button
            variant="contained"
            onClick={() => void handleExport()}
            disabled={!selectedTopic || isExporting || imageTopics.length === 0}
          >
            {isExporting ? "Exporting..." : "Export WebM"}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
