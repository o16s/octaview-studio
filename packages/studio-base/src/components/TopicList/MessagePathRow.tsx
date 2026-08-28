// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  AddSquare16Regular,
  AddSquareMultiple16Regular,
  ReOrderDotsVertical16Regular,
} from "@fluentui/react-icons";
import { Badge, IconButton, Tooltip, Typography } from "@mui/material";
import { FzfResultItem } from "fzf";
import { useCallback, useMemo } from "react";
import { useTranslation } from "react-i18next";

import { HighlightChars } from "@foxglove/studio-base/components/HighlightChars";
import { DraggedMessagePath } from "@foxglove/studio-base/components/PanelExtensionAdapter";
import Stack from "@foxglove/studio-base/components/Stack";
import { useMessagePathDrag } from "@foxglove/studio-base/services/messagePathDragging";

import { MessagePathSearchItem } from "./getMessagePathSearchItems";
import { useAddFieldToPanel } from "./useAddFieldToPanel";
import { useTopicListStyles } from "./useTopicListStyles";

export function MessagePathRow({
  messagePathResult,
  style,
  selected,
  onClick,
  onContextMenu,
}: {
  messagePathResult: FzfResultItem<MessagePathSearchItem>;
  style: React.CSSProperties;
  selected: boolean;
  onClick: React.MouseEventHandler<HTMLDivElement>;
  onContextMenu: React.MouseEventHandler<HTMLDivElement>;
}): JSX.Element {
  const { cx, classes } = useTopicListStyles();
  const { t } = useTranslation("topicList");

  const {
    fullPath,
    suffix: { pathSuffix, type, isLeaf },
    topic,
  } = messagePathResult.item;

  const { panelType, addToNewPanel, addToExistingPanel, canAddToExisting } = useAddFieldToPanel({
    type,
    isLeaf,
    fullPath,
  });

  const item: DraggedMessagePath = useMemo(
    () => ({
      path: fullPath,
      rootSchemaName: topic.schemaName,
      isTopic: false,
      isLeaf,
      topicName: topic.name,
    }),
    [fullPath, isLeaf, topic.name, topic.schemaName],
  );

  const { connectDragSource, connectDragPreview, cursor, isDragging, draggedItemCount } =
    useMessagePathDrag({
      item,
      selected,
    });

  const combinedRef: React.Ref<HTMLDivElement> = useCallback(
    (el) => {
      connectDragSource(el);
      connectDragPreview(el);
    },
    [connectDragPreview, connectDragSource],
  );

  return (
    <div
      ref={combinedRef}
      className={cx(classes.row, classes.fieldRow, {
        [classes.isDragging]: isDragging,
        [classes.selected]: selected,
      })}
      style={{ ...style, cursor }}
      onClick={onClick}
      onContextMenu={onContextMenu}
    >
      {draggedItemCount > 1 && (
        <Badge color="primary" className={classes.countBadge} badgeContent={draggedItemCount} />
      )}
      <Stack flex="auto" direction="row" gap={2} overflow="hidden">
        <Typography variant="body2" noWrap>
          <HighlightChars
            str={pathSuffix}
            indices={messagePathResult.positions}
            offset={messagePathResult.item.offset}
          />
        </Typography>
        <Typography variant="caption" color="text.secondary" noWrap>
          {type}
        </Typography>
      </Stack>
      {panelType != undefined && (
        <div className={classes.fieldActions}>
          <Tooltip title={t("addToNewPanel")}>
            <IconButton
              size="small"
              data-testid="MessagePathRowAddToNewPanel"
              className={classes.fieldActionButton}
              onClick={(event) => {
                event.stopPropagation();
                addToNewPanel();
              }}
            >
              <AddSquare16Regular />
            </IconButton>
          </Tooltip>
          <Tooltip title={t("addToExistingPanel")}>
            <span>
              <IconButton
                size="small"
                data-testid="MessagePathRowAddToExistingPanel"
                className={classes.fieldActionButton}
                disabled={!canAddToExisting}
                onClick={(event) => {
                  event.stopPropagation();
                  addToExistingPanel();
                }}
              >
                <AddSquareMultiple16Regular />
              </IconButton>
            </span>
          </Tooltip>
        </div>
      )}
      <div data-testid="TopicListDragHandle" style={{ cursor }} className={classes.dragHandle}>
        <ReOrderDotsVertical16Regular />
      </div>
    </div>
  );
}
