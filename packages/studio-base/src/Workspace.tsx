// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2018-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import { LinearProgress, Typography } from "@mui/material";
import { useSnackbar } from "notistack";
import { extname } from "path";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { makeStyles } from "tss-react/mui";

import Logger from "@foxglove/log";
import { AppSetting } from "@foxglove/studio-base/AppSetting";
import { extractFilesFromZip } from "@foxglove/studio-base/util/extractZip";
import { parseLayoutFile } from "@foxglove/studio-base/util/parseLayoutFile";
import { AppBarProps, AppBar } from "@foxglove/studio-base/components/AppBar";
import { CustomWindowControlsProps } from "@foxglove/studio-base/components/AppBar/CustomWindowControls";
import {
  DataSourceDialog,
  DataSourceDialogItem,
} from "@foxglove/studio-base/components/DataSourceDialog";
import DocumentDropListener from "@foxglove/studio-base/components/DocumentDropListener";
import AgentChat from "@foxglove/studio-base/components/AgentChat";
import { EventsList } from "@foxglove/studio-base/components/EventsList";
import KeyListener from "@foxglove/studio-base/components/KeyListener";
import {
  MessagePipelineContext,
  useMessagePipeline,
  useMessagePipelineGetter,
} from "@foxglove/studio-base/components/MessagePipeline";
import PanelLayout from "@foxglove/studio-base/components/PanelLayout";
import PanelSettings from "@foxglove/studio-base/components/PanelSettings";
import PlaybackControls from "@foxglove/studio-base/components/PlaybackControls";
import { ProblemsList } from "@foxglove/studio-base/components/ProblemsList";
import RemountOnValueChange from "@foxglove/studio-base/components/RemountOnValueChange";
import { Sidebars, SidebarItem } from "@foxglove/studio-base/components/Sidebars";
import Stack from "@foxglove/studio-base/components/Stack";
import { StudioLogsSettings } from "@foxglove/studio-base/components/StudioLogsSettings";
import { SyncAdapters } from "@foxglove/studio-base/components/SyncAdapters";
import { TopicList } from "@foxglove/studio-base/components/TopicList";
import VariablesList from "@foxglove/studio-base/components/VariablesList";
import { WorkspaceDialogs } from "@foxglove/studio-base/components/WorkspaceDialogs";
import { useAppContext } from "@foxglove/studio-base/context/AppContext";
import { useCurrentUser } from "@foxglove/studio-base/context/BaseUserContext";
import { EventsStore, useEvents } from "@foxglove/studio-base/context/EventsContext";
import { useExtensionCatalog } from "@foxglove/studio-base/context/ExtensionCatalogContext";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import {
  LeftSidebarItemKey,
  RightSidebarItemKey,
  WorkspaceContextStore,
  useWorkspaceStore,
} from "@foxglove/studio-base/context/Workspace/WorkspaceContext";
import {
  type LayoutData,
  useCurrentLayoutActions,
} from "@foxglove/studio-base/context/CurrentLayoutContext";
import { useAppConfigurationValue } from "@foxglove/studio-base/hooks";
import { useConfirm } from "@foxglove/studio-base/hooks/useConfirm";
import { useDefaultWebLaunchPreference } from "@foxglove/studio-base/hooks/useDefaultWebLaunchPreference";
import useElectronFilesToOpen from "@foxglove/studio-base/hooks/useElectronFilesToOpen";
import { usePerformanceMonitor } from "@foxglove/studio-base/hooks/usePerformanceMonitor";
import { PlayerPresence } from "@foxglove/studio-base/players/types";
import { PanelStateContextProvider } from "@foxglove/studio-base/providers/PanelStateContextProvider";
import WorkspaceContextProvider from "@foxglove/studio-base/providers/WorkspaceContextProvider";
import { storeDownloadedFiles } from "@foxglove/studio-base/dataSources/McapServerDataSourceFactory";
import { parseAppURLState, parseLayoutParam } from "@foxglove/studio-base/util/appURLState";

import { useWorkspaceActions } from "./context/Workspace/useWorkspaceActions";

const log = Logger.getLogger(__filename);

const useStyles = makeStyles()({
  container: {
    width: "100%",
    height: "100%",
    display: "flex",
    flexDirection: "column",
    position: "relative",
    flex: "1 1 100%",
    outline: "none",
    overflow: "hidden",
  },
});

type WorkspaceProps = CustomWindowControlsProps & {
  deepLinks?: readonly string[];
  appBarLeftInset?: number;
  onAppBarDoubleClick?: () => void;
  // eslint-disable-next-line react/no-unused-prop-types
  disablePersistenceForStorybook?: boolean;
  AppBarComponent?: (props: AppBarProps) => JSX.Element;
};

function useIsEmbedMode(): boolean {
  return useMemo(() => {
    if (typeof window === "undefined") {
      return false;
    }
    return new URLSearchParams(window.location.search).get("embed") === "true";
  }, []);
}

const selectPlayerPresence = ({ playerState }: MessagePipelineContext) => playerState.presence;
const selectPlayerIsPresent = ({ playerState }: MessagePipelineContext) =>
  playerState.presence !== PlayerPresence.NOT_PRESENT;
const selectPlayerProblems = ({ playerState }: MessagePipelineContext) => playerState.problems;
const selectIsPlaying = (ctx: MessagePipelineContext) =>
  ctx.playerState.activeData?.isPlaying === true;
const selectPause = (ctx: MessagePipelineContext) => ctx.pausePlayback;
const selectPlay = (ctx: MessagePipelineContext) => ctx.startPlayback;
const selectSeek = (ctx: MessagePipelineContext) => ctx.seekPlayback;
const selectPlayUntil = (ctx: MessagePipelineContext) => ctx.playUntil;
const selectPlayerId = (ctx: MessagePipelineContext) => ctx.playerState.playerId;
const selectEventsSupported = (store: EventsStore) => store.eventsSupported;
const selectSelectEvent = (store: EventsStore) => store.selectEvent;

const selectWorkspaceDataSourceDialog = (store: WorkspaceContextStore) => store.dialogs.dataSource;
const selectWorkspaceLeftSidebarItem = (store: WorkspaceContextStore) => store.sidebars.left.item;
const selectWorkspaceLeftSidebarOpen = (store: WorkspaceContextStore) => store.sidebars.left.open;
const selectWorkspaceLeftSidebarSize = (store: WorkspaceContextStore) => store.sidebars.left.size;
const selectWorkspaceRightSidebarItem = (store: WorkspaceContextStore) => store.sidebars.right.item;
const selectWorkspaceRightSidebarOpen = (store: WorkspaceContextStore) => store.sidebars.right.open;
const selectWorkspaceRightSidebarSize = (store: WorkspaceContextStore) => store.sidebars.right.size;

function WorkspaceContent(props: WorkspaceProps): JSX.Element {
  usePerformanceMonitor();
  const { PerformanceSidebarComponent } = useAppContext();
  const { classes } = useStyles();
  const containerRef = useRef<HTMLDivElement>(ReactNull);
  const { availableSources, selectSource } = usePlayerSelection();
  const playerPresence = useMessagePipeline(selectPlayerPresence);
  const playerProblems = useMessagePipeline(selectPlayerProblems);
  const embedMode = useIsEmbedMode();
  const [fileDownloadState, setFileDownloadState] = useState<
    { filename: string; loaded: number; total: number; phase?: string } | undefined
  >();

  const dataSourceDialog = useWorkspaceStore(selectWorkspaceDataSourceDialog);
  const leftSidebarItem = useWorkspaceStore(selectWorkspaceLeftSidebarItem);
  const leftSidebarOpen = useWorkspaceStore(selectWorkspaceLeftSidebarOpen);
  const leftSidebarSize = useWorkspaceStore(selectWorkspaceLeftSidebarSize);
  const rightSidebarItem = useWorkspaceStore(selectWorkspaceRightSidebarItem);
  const rightSidebarOpen = useWorkspaceStore(selectWorkspaceRightSidebarOpen);
  const rightSidebarSize = useWorkspaceStore(selectWorkspaceRightSidebarSize);
  const { t } = useTranslation("workspace");
  const { AppBarComponent = AppBar } = props;

  const { dialogActions, sidebarActions, setPendingLayoutConfirmation } = useWorkspaceActions();

  // Handle pending layout confirmation from ZIP import or .json drop
  const [confirm, confirmModal] = useConfirm();
  const pendingLayout = useWorkspaceStore(
    (store: WorkspaceContextStore) => store.pendingLayoutConfirmation,
  );
  const { setCurrentLayout } = useCurrentLayoutActions();
  const pendingLayoutHandled = useRef(false);

  useEffect(() => {
    if (!pendingLayout || pendingLayoutHandled.current) {
      return;
    }
    pendingLayoutHandled.current = true;
    void (async () => {
      const result = await confirm({
        title: t("applyLayoutTitle", { defaultValue: "Apply Layout" }),
        prompt: t("applyLayoutPrompt", {
          defaultValue:
            "This file includes a saved layout. Would you like to reset the current layout?",
        }),
        ok: t("applyLayoutOk", { defaultValue: "Apply Layout" }),
      });
      if (result === "ok") {
        setCurrentLayout({ data: pendingLayout.data as LayoutData, name: pendingLayout.name });
      }
      setPendingLayoutConfirmation(undefined);
      pendingLayoutHandled.current = false;
    })();
  }, [confirm, pendingLayout, setCurrentLayout, setPendingLayoutConfirmation, t]);

  // file types we support for drag/drop
  const allowedDropExtensions = useMemo(() => {
    const extensions = [".foxe", ".zip", ".json"];
    for (const source of availableSources) {
      if (source.type === "file" && source.supportedFileTypes) {
        extensions.push(...source.supportedFileTypes);
      }
    }
    return extensions;
  }, [availableSources]);

  // We use playerId to detect when a player changes for RemountOnValueChange below
  // see comment below above the RemountOnValueChange component
  const playerId = useMessagePipeline(selectPlayerId);

  const { currentUserType } = useCurrentUser();

  useDefaultWebLaunchPreference();

  const [enableDebugMode = false] = useAppConfigurationValue<boolean>(AppSetting.SHOW_DEBUG_PANELS);

  const { workspaceExtensions = [] } = useAppContext();

  // When a player is first activated, hide the open dialog.
  const prevPlayerPresence = useRef(playerPresence);
  useLayoutEffect(() => {
    const wasAbsent =
      prevPlayerPresence.current !== PlayerPresence.PRESENT &&
      prevPlayerPresence.current !== PlayerPresence.INITIALIZING;
    prevPlayerPresence.current = playerPresence;

    if (
      wasAbsent &&
      (playerPresence === PlayerPresence.PRESENT ||
        playerPresence === PlayerPresence.INITIALIZING)
    ) {
      dialogActions.dataSource.close();
    }
  }, [dialogActions.dataSource, playerPresence]);

  useEffect(() => {
    // Focus on page load to enable keyboard interaction.
    if (containerRef.current) {
      containerRef.current.focus();
    }
  }, []);

  const { enqueueSnackbar } = useSnackbar();

  const installExtension = useExtensionCatalog((state) => state.installExtension);

  const openFiles = useCallback(
    async (files: File[]) => {
      const otherFiles: File[] = [];
      log.debug("open files", files);

      // Extract ZIP files first, replacing them with their contents
      const expandedFiles: File[] = [];
      for (const file of files) {
        if (extname(file.name) === ".zip") {
          try {
            const extracted = await extractFilesFromZip(file);
            expandedFiles.push(...extracted);
          } catch (err) {
            log.error(err);
            enqueueSnackbar(`Failed to extract ZIP ${file.name}: ${err instanceof Error ? err.message : String(err)}`, {
              variant: "error",
            });
          }
        } else {
          expandedFiles.push(file);
        }
      }

      for (const file of expandedFiles) {
        if (file.name.endsWith(".foxe")) {
          // Extension installation
          try {
            const arrayBuffer = await file.arrayBuffer();
            const data = new Uint8Array(arrayBuffer);
            const extension = await installExtension("local", data);
            enqueueSnackbar(`Installed extension ${extension.id}`, { variant: "success" });
          } catch (err) {
            log.error(err);
            enqueueSnackbar(`Failed to install extension ${file.name}: ${err.message}`, {
              variant: "error",
            });
          }
        } else if (file.name.endsWith(".json")) {
          // Layout file — parse and offer to apply
          const layoutData = await parseLayoutFile(file);
          if (layoutData) {
            setPendingLayoutConfirmation(layoutData, file.name);
          }
        } else {
          otherFiles.push(file);
        }
      }

      if (otherFiles.length > 0) {
        // Look for a source that supports the dragged file extensions
        for (const source of availableSources) {
          const filteredFiles = otherFiles.filter((file) => {
            const ext = extname(file.name);
            return source.supportedFileTypes?.includes(ext);
          });

          // select the first source that has files that match the supported extensions
          if (filteredFiles.length > 0) {
            selectSource(source.id, { type: "file", files: otherFiles });
            break;
          }
        }
      }
    },
    [availableSources, enqueueSnackbar, installExtension, selectSource, setPendingLayoutConfirmation],
  );

  const openHandle = useCallback(
    async (
      handle: FileSystemFileHandle /* foxglove-depcheck-used: @types/wicg-file-system-access */,
    ) => {
      log.debug("open handle", handle);
      const file = await handle.getFile();

      // ZIP files: extract and open the inner files
      if (extname(file.name) === ".zip") {
        try {
          const extracted = await extractFilesFromZip(file);
          if (extracted.length === 0) {
            enqueueSnackbar("ZIP file contains no supported files.", { variant: "warning" });
            return;
          }
          await openFiles(extracted);
        } catch (err) {
          log.error(err);
          enqueueSnackbar(`Failed to extract ZIP: ${err instanceof Error ? err.message : String(err)}`, {
            variant: "error",
          });
        }
        return;
      }

      if (file.name.endsWith(".foxe")) {
        // Extension installation
        try {
          const arrayBuffer = await file.arrayBuffer();
          const data = new Uint8Array(arrayBuffer);
          const extension = await installExtension("local", data);
          enqueueSnackbar(`Installed extension ${extension.id}`, { variant: "success" });
        } catch (err) {
          log.error(err);
          enqueueSnackbar(`Failed to install extension ${file.name}: ${err.message}`, {
            variant: "error",
          });
        }
        return;
      }

      if (file.name.endsWith(".json")) {
        // Layout file — parse and offer to apply
        const layoutData = await parseLayoutFile(file);
        if (layoutData) {
          setPendingLayoutConfirmation(layoutData, file.name);
        }
        return;
      }

      // Look for a source that supports the file extensions
      const matchedSource = availableSources.find((source) => {
        const ext = extname(file.name);
        return source.supportedFileTypes?.includes(ext);
      });
      if (matchedSource) {
        selectSource(matchedSource.id, { type: "file", handle });
      }
    },
    [availableSources, enqueueSnackbar, installExtension, openFiles, selectSource, setPendingLayoutConfirmation],
  );

  // files the main thread told us to open
  const filesToOpen = useElectronFilesToOpen();
  useEffect(() => {
    if (filesToOpen) {
      void openFiles(Array.from(filesToOpen));
    }
  }, [filesToOpen, openFiles]);

  const dropHandler = useCallback(
    (event: { files?: File[]; handles?: FileSystemFileHandle[] }) => {
      const handle = event.handles?.[0];
      // When selecting sources with handles we can only select with a single handle since we haven't
      // written the code to store multiple handles for recents. When there are multiple handles, we
      // fall back to opening regular files.
      if (handle && event.handles?.length === 1) {
        void openHandle(handle);
      } else if (event.files) {
        void openFiles(event.files);
      }
    },
    [openFiles, openHandle],
  );

  const eventsSupported = useEvents(selectEventsSupported);
  const showEventsTab = currentUserType !== "unauthenticated" && eventsSupported;

  const leftSidebarItems = useMemo(() => {
    const items = new Map<LeftSidebarItemKey, SidebarItem>([
      ["panel-settings", { title: t("panel"), component: PanelSettings }],
      ["topics", { title: t("topics"), component: TopicList }],
      [
        "problems",
        {
          title: t("problems"),
          component: ProblemsList,
          badge:
            playerProblems && playerProblems.length > 0
              ? {
                  count: playerProblems.length,
                  color: "error",
                }
              : undefined,
        },
      ],
    ]);
    return items;
  }, [playerProblems, t]);

  const rightSidebarItems = useMemo(() => {
    const items = new Map<RightSidebarItemKey, SidebarItem>([
      ["agent", { title: "Agent", component: AgentChat }],
      ["variables", { title: t("variables"), component: VariablesList }],
    ]);
    if (enableDebugMode) {
      if (PerformanceSidebarComponent) {
        items.set("performance", {
          title: t("performance"),
          component: PerformanceSidebarComponent,
        });
      }
      items.set("studio-logs-settings", { title: t("studioLogs"), component: StudioLogsSettings });
    }
    if (showEventsTab) {
      items.set("events", { title: t("events"), component: EventsList });
    }
    return items;
  }, [enableDebugMode, showEventsTab, t, PerformanceSidebarComponent]);

  const keyboardEventHasModifier = (event: KeyboardEvent) =>
    navigator.userAgent.includes("Mac") ? event.metaKey : event.ctrlKey;

  const keyDownHandlers = useMemo(() => {
    return {
      "[": () => {
        sidebarActions.left.setOpen((oldValue) => !oldValue);
      },
      "]": () => {
        sidebarActions.right.setOpen((oldValue) => !oldValue);
      },
      o: (ev: KeyboardEvent) => {
        if (!keyboardEventHasModifier(ev)) {
          return;
        }
        ev.preventDefault();
        if (ev.shiftKey) {
          dialogActions.dataSource.open("connection");
          return;
        }
        void dialogActions.openFile.open().catch(console.error);
      },
    };
  }, [dialogActions.dataSource, dialogActions.openFile, sidebarActions.left, sidebarActions.right]);

  const play = useMessagePipeline(selectPlay);
  const playUntil = useMessagePipeline(selectPlayUntil);
  const pause = useMessagePipeline(selectPause);
  const seek = useMessagePipeline(selectSeek);
  const isPlaying = useMessagePipeline(selectIsPlaying);
  const getMessagePipeline = useMessagePipelineGetter();
  const getTimeInfo = useCallback(
    () => getMessagePipeline().playerState.activeData ?? {},
    [getMessagePipeline],
  );

  const targetUrlState = useMemo(() => {
    const deepLinks = props.deepLinks ?? [];
    return deepLinks[0] ? parseAppURLState(new URL(deepLinks[0])) : undefined;
  }, [props.deepLinks]);

  const [unappliedSourceArgs, setUnappliedSourceArgs] = useState(
    targetUrlState ? { ds: targetUrlState.ds, dsParams: targetUrlState.dsParams } : undefined,
  );

  const selectEvent = useEvents(selectSelectEvent);
  // Load data source from URL.
  useEffect(() => {
    if (!unappliedSourceArgs) {
      return;
    }

    // Apply any available data source args
    if (unappliedSourceArgs.ds) {
      log.debug("Initialising source from url", unappliedSourceArgs);
      selectSource(unappliedSourceArgs.ds, {
        type: "connection",
        params: unappliedSourceArgs.dsParams,
      });
      selectEvent(unappliedSourceArgs.dsParams?.eventId);
      setUnappliedSourceArgs({ ds: undefined, dsParams: undefined });
    }
  }, [selectEvent, selectSource, unappliedSourceArgs, setUnappliedSourceArgs]);

  const [unappliedTime, setUnappliedTime] = useState(
    targetUrlState ? { time: targetUrlState.time } : undefined,
  );
  // Seek to time in URL.
  useEffect(() => {
    if (unappliedTime?.time == undefined || !seek) {
      return;
    }

    // Wait until player is ready before we try to seek.
    if (playerPresence !== PlayerPresence.PRESENT) {
      return;
    }

    log.debug(`Seeking to url time:`, unappliedTime.time);
    seek(unappliedTime.time);
    setUnappliedTime({ time: undefined });
  }, [playerPresence, seek, unappliedTime]);

  // Apply layout from ?layout= or ?layoutUrl= URL params.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);

    // ?layout= takes inline base64 or JSON
    const layoutParam = params.get("layout");
    if (layoutParam) {
      const layoutData = parseLayoutParam(layoutParam);
      if (layoutData) {
        log.debug("Applying layout from URL param");
        setCurrentLayout({ data: layoutData });
      } else {
        log.error("Invalid layout parameter in URL");
        enqueueSnackbar("Invalid layout parameter in URL", { variant: "error" });
      }
      return;
    }

    // ?layoutUrl= fetches layout JSON from a URL
    const layoutUrl = params.get("layoutUrl");
    if (!layoutUrl) {
      return;
    }

    // Validate URL protocol to prevent SSRF (file://, data://, etc.)
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(layoutUrl, window.location.origin);
    } catch {
      enqueueSnackbar("Invalid layout URL", { variant: "error" });
      return;
    }
    if (parsedUrl.protocol !== "http:" && parsedUrl.protocol !== "https:") {
      enqueueSnackbar("Layout URL must use http or https", { variant: "error" });
      return;
    }

    const MAX_LAYOUT_SIZE = 1_000_000; // 1 MB
    const abortController = new AbortController();

    (async () => {
      try {
        log.debug("Fetching layout from URL");
        const res = await fetch(parsedUrl.href, { signal: abortController.signal });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const contentLength = res.headers.get("content-length");
        if (contentLength && parseInt(contentLength, 10) > MAX_LAYOUT_SIZE) {
          throw new Error("Layout response too large");
        }
        const text = await res.text();
        if (text.length > MAX_LAYOUT_SIZE) {
          throw new Error("Layout response too large");
        }
        const layoutData = parseLayoutParam(text);
        if (layoutData) {
          setCurrentLayout({ data: layoutData });
        } else {
          throw new Error("Invalid layout JSON");
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        log.error(`Failed to load layout from URL: ${err}`);
        enqueueSnackbar("Failed to load layout from URL", { variant: "error" });
      }
    })();

    return () => {
      abortController.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open a specific file directly via ?file= URL param.
  // Matches the path against the server MCAP index, downloads, and opens it.
  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }
    const params = new URLSearchParams(window.location.search);
    const filePath = params.get("file");
    if (!filePath) {
      return;
    }

    const serverConfig = (globalThis as Record<string, unknown>).OCTAVIEW_STUDIO_SERVER as
      | { apiBase?: string }
      | undefined;
    if (typeof serverConfig !== "object") {
      return;
    }
    const apiBase = serverConfig?.apiBase ?? "";

    const abortController = new AbortController();

    const displayName = filePath.includes("/")
      ? filePath.slice(filePath.lastIndexOf("/") + 1)
      : filePath;
    setFileDownloadState({ filename: displayName, loaded: 0, total: 0, phase: "Downloading…" });

    (async () => {
      try {
        // Fetch the file directly — no index lookup needed
        const fileUrl = `${apiBase}/api/mcap/files/${encodeURIComponent(filePath)}`;
        const fileRes = await fetch(fileUrl, { signal: abortController.signal });
        if (!fileRes.ok) {
          setFileDownloadState(undefined);
          log.error(`File not found: ${filePath} (HTTP ${fileRes.status})`);
          enqueueSnackbar(`Recording not found: ${filePath}`, { variant: "error" });
          return;
        }

        const contentLength = parseInt(fileRes.headers.get("Content-Length") ?? "0", 10);
        const fileReader = fileRes.body?.getReader();
        if (!fileReader) {
          throw new Error("No response body for file download");
        }

        setFileDownloadState({ filename: displayName, loaded: 0, total: contentLength });
        const chunks: Uint8Array[] = [];
        let loaded = 0;
        for (;;) {
          const { done, value: chunk } = await fileReader.read();
          if (done) {
            break;
          }
          chunks.push(chunk);
          loaded += chunk.byteLength;
          setFileDownloadState({ filename: displayName, loaded, total: contentLength });
        }
        setFileDownloadState(undefined);

        const blob = new Blob(chunks);
        const file = new File([blob], displayName);

        const downloadId = `file-${Date.now()}`;
        storeDownloadedFiles(downloadId, [file]);
        selectSource("mcap-server", {
          type: "connection",
          params: { downloadId },
        });
      } catch (err) {
        setFileDownloadState(undefined);
        if (err instanceof Error && err.name === "AbortError") {
          return;
        }
        log.error(`Failed to open file from URL: ${err}`);
        enqueueSnackbar(`Failed to open recording: ${filePath}`, { variant: "error" });
      }
    })();

    return () => {
      abortController.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const appBar = useMemo(
    () => (
      <AppBarComponent
        leftInset={props.appBarLeftInset}
        onDoubleClick={props.onAppBarDoubleClick}
        showCustomWindowControls={props.showCustomWindowControls}
        isMaximized={props.isMaximized}
        initialZoomFactor={props.initialZoomFactor}
        onMinimizeWindow={props.onMinimizeWindow}
        onMaximizeWindow={props.onMaximizeWindow}
        onUnmaximizeWindow={props.onUnmaximizeWindow}
        onCloseWindow={props.onCloseWindow}
      />
    ),
    [
      AppBarComponent,
      props.appBarLeftInset,
      props.isMaximized,
      props.initialZoomFactor,
      props.onAppBarDoubleClick,
      props.onCloseWindow,
      props.onMaximizeWindow,
      props.onMinimizeWindow,
      props.onUnmaximizeWindow,
      props.showCustomWindowControls,
    ],
  );

  return (
    <PanelStateContextProvider>
      {dataSourceDialog.open && <DataSourceDialog />}
      {confirmModal}
      <DocumentDropListener onDrop={dropHandler} allowedExtensions={allowedDropExtensions} />
      <SyncAdapters />
      <KeyListener global keyDownHandlers={keyDownHandlers} />
      <div className={classes.container} ref={containerRef} tabIndex={0}>
        {fileDownloadState && (
          <Stack
            alignItems="center"
            justifyContent="center"
            style={{
              position: "absolute",
              inset: 0,
              zIndex: 10000,
              backgroundColor: "rgba(0,0,0,0.7)",
            }}
          >
            <Stack alignItems="center" gap={1} style={{ width: 320 }}>
              <Typography variant="subtitle1" color="white">
                {fileDownloadState.phase ?? `Downloading ${fileDownloadState.filename}`}
              </Typography>
              {fileDownloadState.phase != null ? (
                <LinearProgress variant="indeterminate" style={{ width: "100%" }} />
              ) : fileDownloadState.total > 0 ? (
                <>
                  <LinearProgress
                    variant="determinate"
                    value={(fileDownloadState.loaded / fileDownloadState.total) * 100}
                    style={{ width: "100%" }}
                  />
                  <Typography variant="caption" color="grey.400">
                    {(fileDownloadState.loaded / 1024 / 1024).toFixed(1)} /{" "}
                    {(fileDownloadState.total / 1024 / 1024).toFixed(1)} MB
                  </Typography>
                </>
              ) : (
                <LinearProgress variant="indeterminate" style={{ width: "100%" }} />
              )}
            </Stack>
          </Stack>
        )}
        {!embedMode && appBar}
        {embedMode ? (
          <RemountOnValueChange value={playerId}>
            <Stack>
              <PanelLayout />
            </Stack>
          </RemountOnValueChange>
        ) : (
          <Sidebars
            leftItems={leftSidebarItems}
            selectedLeftKey={leftSidebarOpen ? leftSidebarItem : undefined}
            onSelectLeftKey={sidebarActions.left.selectItem}
            leftSidebarSize={leftSidebarSize}
            setLeftSidebarSize={sidebarActions.left.setSize}
            rightItems={rightSidebarItems}
            selectedRightKey={rightSidebarOpen ? rightSidebarItem : undefined}
            onSelectRightKey={sidebarActions.right.selectItem}
            rightSidebarSize={rightSidebarSize}
            setRightSidebarSize={sidebarActions.right.setSize}
          >
            {/* To ensure no stale player state remains, we unmount all panels when players change */}
            <RemountOnValueChange value={playerId}>
              <Stack>
                <PanelLayout />
              </Stack>
            </RemountOnValueChange>
          </Sidebars>
        )}
        {play && pause && seek && !embedMode && (
          <div style={{ flexShrink: 0 }}>
            <PlaybackControls
              play={play}
              pause={pause}
              seek={seek}
              playUntil={playUntil}
              isPlaying={isPlaying}
              getTimeInfo={getTimeInfo}
            />
          </div>
        )}
      </div>
      {/* Splat to avoid requiring unique a `key` on each item in workspaceExtensions */}
      {...workspaceExtensions}
      <WorkspaceDialogs />
    </PanelStateContextProvider>
  );
}

export default function Workspace(props: WorkspaceProps): JSX.Element {
  const [showOpenDialogOnStartup = true] = useAppConfigurationValue<boolean>(
    AppSetting.SHOW_OPEN_DIALOG_ON_STARTUP,
  );

  const { workspaceStoreCreator } = useAppContext();

  const isPlayerPresent = useMessagePipeline(selectPlayerIsPresent);

  const initialItem: undefined | DataSourceDialogItem = useMemo(() => {
    if (isPlayerPresent || !showOpenDialogOnStartup) {
      return undefined;
    }
    // Auto-open recordings view when URL has relevant params
    if (typeof window !== "undefined") {
      const params = new URLSearchParams(window.location.search);
      // ?file= opens directly — don't show any dialog
      if (params.has("file")) {
        return undefined;
      }
      if (
        params.get("view") === "recordings" ||
        params.has("t") ||
        params.has("incidents")
      ) {
        return "server";
      }
    }
    return "start";
  }, [isPlayerPresent, showOpenDialogOnStartup]);

  const initialState: Pick<WorkspaceContextStore, "dialogs"> = {
    dialogs: {
      dataSource: {
        activeDataSource: undefined,
        open: initialItem != undefined,
        item: initialItem,
      },
      exportVideo: {
        open: false,
      },
      preferences: {
        initialTab: undefined,
        open: false,
      },
    },
  };

  return (
    <WorkspaceContextProvider
      initialState={initialState}
      workspaceStoreCreator={workspaceStoreCreator}
      disablePersistenceForStorybook={props.disablePersistenceForStorybook}
    >
      <WorkspaceContent {...props} />
    </WorkspaceContextProvider>
  );
}
