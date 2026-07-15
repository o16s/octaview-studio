// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Menu, PaperProps, PopoverPosition, PopoverReference } from "@mui/material";
import { useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { makeStyles } from "tss-react/mui";

import TextMiddleTruncate from "@foxglove/studio-base/components/TextMiddleTruncate";
import { useCurrentLayoutActions } from "@foxglove/studio-base/context/CurrentLayoutContext";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import { getCurrentFiles } from "@foxglove/studio-base/dataSources/McapServerDataSourceFactory";
import { exportFilesAsZip } from "@foxglove/studio-base/util/exportZip";
import {
  WorkspaceContextStore,
  useWorkspaceStore,
} from "@foxglove/studio-base/context/Workspace/WorkspaceContext";
import { useWorkspaceActions } from "@foxglove/studio-base/context/Workspace/useWorkspaceActions";

import { NestedMenuItem } from "./NestedMenuItem";
import { AppBarMenuItem } from "./types";

export type AppMenuProps = {
  handleClose: () => void;
  anchorEl?: HTMLElement;
  anchorReference?: PopoverReference;
  anchorPosition?: PopoverPosition;
  disablePortal?: boolean;
  open: boolean;
};

const useStyles = makeStyles()({
  menuList: {
    minWidth: 180,
    maxWidth: 220,
  },
  truncate: {
    alignSelf: "center !important",
  },
});

const selectLeftSidebarOpen = (store: WorkspaceContextStore) => store.sidebars.left.open;
const selectRightSidebarOpen = (store: WorkspaceContextStore) => store.sidebars.right.open;

export function AppMenu(props: AppMenuProps): JSX.Element {
  const { open, handleClose, anchorEl, anchorReference, anchorPosition, disablePortal } = props;
  const { classes } = useStyles();
  const { t } = useTranslation("appBar");

  const [nestedMenu, setNestedMenu] = useState<string | undefined>();

  const { recentSources, selectRecent } = usePlayerSelection();

  const leftSidebarOpen = useWorkspaceStore(selectLeftSidebarOpen);
  const rightSidebarOpen = useWorkspaceStore(selectRightSidebarOpen);
  const { sidebarActions, dialogActions, layoutActions } = useWorkspaceActions();
  const { getCurrentLayoutState } = useCurrentLayoutActions();

  const handleNestedMenuClose = useCallback(() => {
    setNestedMenu(undefined);
    handleClose();
  }, [handleClose]);

  const handleItemPointerEnter = useCallback((id: string) => {
    setNestedMenu(id);
  }, []);

  // FILE

  const hasOpenFiles = open && getCurrentFiles() != undefined;

  const fileItems = useMemo(() => {
    const items: AppBarMenuItem[] = [
      {
        type: "item",
        label: t("open"),
        key: "open",
        onClick: () => {
          dialogActions.dataSource.open("start");
          handleNestedMenuClose();
        },
      },
      {
        type: "item",
        label: t("openLocalFile"),
        key: "open-file",
        onClick: () => {
          handleNestedMenuClose();
          dialogActions.openFile.open().catch(console.error);
        },
      },
      {
        type: "item",
        label: t("openConnection"),
        key: "open-connection",
        onClick: () => {
          dialogActions.dataSource.open("connection");
          handleNestedMenuClose();
        },
      },
      { type: "divider" },
      {
        type: "item",
        label: t("exportRecordings", { defaultValue: "Export recordings as ZIP" }),
        key: "export-zip",
        disabled: !hasOpenFiles,
        onClick: () => {
          const files = getCurrentFiles();
          if (files) {
            const allFiles = [...files];
            const layoutData = getCurrentLayoutState().selectedLayout?.data;
            if (layoutData) {
              const layoutJson = JSON.stringify(layoutData, undefined, 2) ?? "";
              allFiles.push(new File([layoutJson], "layout.json", { type: "application/json" }));
            }
            void exportFilesAsZip(allFiles);
          }
          handleNestedMenuClose();
        },
      },
      {
        type: "item",
        label: "Export Video...",
        key: "export-video",
        onClick: () => {
          dialogActions.exportVideo.open();
          handleNestedMenuClose();
        },
      },
      { type: "divider" },
      { type: "item", label: t("recentDataSources"), key: "recent-sources", disabled: true },
    ];

    recentSources.slice(0, 5).map((recent) => {
      items.push({
        type: "item",
        key: recent.id,
        onClick: () => {
          selectRecent(recent.id);
          handleNestedMenuClose();
        },
        label: <TextMiddleTruncate text={recent.title} className={classes.truncate} />,
      });
    });

    return items;
  }, [
    classes.truncate,
    dialogActions.dataSource,
    dialogActions.openFile,
    dialogActions.exportVideo,
    getCurrentLayoutState,
    handleNestedMenuClose,
    hasOpenFiles,
    recentSources,
    selectRecent,
    t,
  ]);

  // VIEW

  const viewItems = useMemo<AppBarMenuItem[]>(
    () => [
      {
        type: "item",
        label: leftSidebarOpen ? t("hideLeftSidebar") : t("showLeftSidebar"),
        key: "left-sidebar",
        shortcut: "[",
        onClick: () => {
          sidebarActions.left.setOpen(!leftSidebarOpen);
          handleNestedMenuClose();
        },
      },
      {
        type: "item",
        label: rightSidebarOpen ? t("hideRightSidebar") : t("showRightSidebar"),
        key: "right-sidebar",
        shortcut: "]",
        onClick: () => {
          sidebarActions.right.setOpen(!rightSidebarOpen);
          handleNestedMenuClose();
        },
      },
      {
        type: "divider",
      },
      {
        type: "item",
        label: t("importLayoutFromFile"),
        key: "import-layout",
        onClick: () => {
          layoutActions.importFromFile();
          handleNestedMenuClose();
        },
      },
      {
        type: "item",
        label: t("exportLayoutToFile"),
        key: "export-layout",
        onClick: () => {
          layoutActions.exportToFile();
          handleNestedMenuClose();
        },
      },
    ],
    [
      handleNestedMenuClose,
      layoutActions,
      leftSidebarOpen,
      rightSidebarOpen,
      sidebarActions.left,
      sidebarActions.right,
      t,
    ],
  );

  // HELP

  const onAboutClick = useCallback(() => {
    dialogActions.preferences.open("about");
    handleNestedMenuClose();
  }, [dialogActions.preferences, handleNestedMenuClose]);

  const helpItems = useMemo<AppBarMenuItem[]>(
    () => [
      { type: "item", key: "about", label: t("about"), onClick: onAboutClick },
    ],
    [onAboutClick, t],
  );

  return (
    <>
      <Menu
        anchorEl={anchorEl}
        anchorReference={anchorReference}
        anchorPosition={anchorPosition}
        disablePortal={disablePortal}
        id="app-menu"
        open={open}
        disableAutoFocusItem
        onClose={handleNestedMenuClose}
        MenuListProps={{
          "aria-labelledby": "app-menu-button",
          dense: true,
          className: classes.menuList,
        }}
        PaperProps={
          {
            "data-tourid": "app-menu",
          } as Partial<PaperProps & { "data-tourid"?: string }>
        }
      >
        <NestedMenuItem
          onPointerEnter={handleItemPointerEnter}
          items={fileItems}
          open={nestedMenu === "app-menu-file"}
          id="app-menu-file"
        >
          {t("file")}
        </NestedMenuItem>
        <NestedMenuItem
          onPointerEnter={handleItemPointerEnter}
          items={viewItems}
          open={nestedMenu === "app-menu-view"}
          id="app-menu-view"
        >
          {t("view")}
        </NestedMenuItem>
        <NestedMenuItem
          onPointerEnter={handleItemPointerEnter}
          items={helpItems}
          open={nestedMenu === "app-menu-help"}
          id="app-menu-help"
        >
          {t("help")}
        </NestedMenuItem>
      </Menu>
    </>
  );
}
