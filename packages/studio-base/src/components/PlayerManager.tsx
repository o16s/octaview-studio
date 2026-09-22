// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/
//
// This file incorporates work covered by the following copyright and
// permission notice:
//
//   Copyright 2018-2021 Cruise LLC
//
//   This source code is licensed under the Apache License, Version 2.0,
//   found at http://www.apache.org/licenses/LICENSE-2.0
//   You may not use this file except in compliance with the License.

import { useSnackbar } from "notistack";
import { PropsWithChildren, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { useMountedState } from "react-use";

import { useWarnImmediateReRender } from "@foxglove/hooks";
import Logger from "@foxglove/log";
import { Immutable } from "@foxglove/studio";
import { AppSetting } from "@foxglove/studio-base/AppSetting";
import { MessagePipelineProvider } from "@foxglove/studio-base/components/MessagePipeline";
import { useAnalytics } from "@foxglove/studio-base/context/AnalyticsContext";
import { useAppContext } from "@foxglove/studio-base/context/AppContext";
import { ExtensionCatalogContext } from "@foxglove/studio-base/context/ExtensionCatalogContext";
import PlayerSelectionContext, {
  CurrentSourceHandle,
  DataSourceArgs,
  IDataSourceFactory,
  PlayerSelection,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import { useAppConfigurationValue } from "@foxglove/studio-base/hooks/useAppConfigurationValue";
import useIndexedDbRecents, { RecentRecord } from "@foxglove/studio-base/hooks/useIndexedDbRecents";
import AnalyticsMetricsCollector from "@foxglove/studio-base/players/AnalyticsMetricsCollector";
import { blockCacheSizeBytes } from "@foxglove/studio-base/players/IterablePlayer/blockCacheSize";
import {
  TopicAliasFunctions,
  TopicAliasingPlayer,
} from "@foxglove/studio-base/players/TopicAliasingPlayer/TopicAliasingPlayer";
import { Player } from "@foxglove/studio-base/players/types";

const log = Logger.getLogger(__filename);

/**
 * The recording URL(s) a connection source was opened with. `urls` is a JSON
 * array (mcap-server); `url` is a single URL (remote-file). Returns [] when the
 * params carry no readable URL (e.g. a live connection or a downloadId).
 */
function parseSourceUrls(params: Record<string, string | undefined> | undefined): string[] {
  if (!params) {
    return [];
  }
  if (typeof params.urls === "string") {
    try {
      const parsed = JSON.parse(params.urls) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((entry): entry is string => typeof entry === "string");
      }
      // A bare JSON string ("\"x.mcap\"") parses to a string — use it unwrapped
      // rather than passing the quoted form through.
      if (typeof parsed === "string") {
        return [parsed];
      }
    } catch {
      // Not JSON — treat it as a single literal URL below.
    }
    return [params.urls];
  }
  return typeof params.url === "string" ? [params.url] : [];
}

type PlayerManagerProps = {
  playerSources: readonly IDataSourceFactory[];
};

export default function PlayerManager(props: PropsWithChildren<PlayerManagerProps>): JSX.Element {
  const { children, playerSources } = props;

  useWarnImmediateReRender();

  const { wrapPlayer } = useAppContext();

  const isMounted = useMountedState();

  const analytics = useAnalytics();
  const metricsCollector = useMemo(() => new AnalyticsMetricsCollector(analytics), [analytics]);

  // Block-preload cache budget, user-tunable in Preferences. Applies to data
  // sources opened after a change (players read it at construction).
  const [blockCacheMb] = useAppConfigurationValue<number>(AppSetting.BLOCK_CACHE_SIZE_MB);
  const cacheSizeBytes = blockCacheSizeBytes(blockCacheMb);

  const [basePlayer, setBasePlayer] = useState<Player | undefined>();

  const { recents, addRecent } = useIndexedDbRecents();

  const topicAliasPlayer = useMemo(() => {
    if (!basePlayer) {
      return undefined;
    }

    return new TopicAliasingPlayer(basePlayer);
  }, [basePlayer]);

  // Update the alias functions when they change. We do not need to re-render the player manager
  // since nothing in the local state has changed.
  const extensionCatalogContext = useContext(ExtensionCatalogContext);
  useEffect(() => {
    // Stable empty alias functions if we don't have any
    const emptyAliasFunctions: Immutable<TopicAliasFunctions> = [];

    // We only want to set alias functions on the player when the functions have changed
    let topicAliasFunctions =
      extensionCatalogContext.getState().installedTopicAliasFunctions ?? emptyAliasFunctions;
    topicAliasPlayer?.setAliasFunctions(topicAliasFunctions);

    return extensionCatalogContext.subscribe((state) => {
      if (topicAliasFunctions !== state.installedTopicAliasFunctions) {
        topicAliasFunctions = state.installedTopicAliasFunctions ?? emptyAliasFunctions;
        topicAliasPlayer?.setAliasFunctions(topicAliasFunctions);
      }
    });
  }, [extensionCatalogContext, topicAliasPlayer]);

  const player = useMemo(() => {
    if (!topicAliasPlayer) {
      return undefined;
    }

    return wrapPlayer(topicAliasPlayer);
  }, [topicAliasPlayer, wrapPlayer]);

  const { enqueueSnackbar } = useSnackbar();

  const [selectedSource, setSelectedSource] = useState<IDataSourceFactory | undefined>();

  // A re-readable handle to the current source, for panels that read the
  // recording directly (see PlayerSelection.currentSource).
  const [currentSource, setCurrentSource] = useState<CurrentSourceHandle | undefined>();

  const selectSource = useCallback(
    async (sourceId: string, args?: DataSourceArgs) => {
      log.debug(`Select Source: ${sourceId}`);

      const foundSource = playerSources.find(
        (source) => source.id === sourceId || source.legacyIds?.includes(sourceId),
      );
      if (!foundSource) {
        enqueueSnackbar(`Unknown data source: ${sourceId}`, { variant: "warning" });
        return;
      }

      metricsCollector.setProperty("player", sourceId);

      setSelectedSource(foundSource);

      // Sample sources don't need args or prompts to initialize
      if (foundSource.type === "sample") {
        const newPlayer = foundSource.initialize({
          metricsCollector,
          cacheSizeBytes,
        });

        setBasePlayer(newPlayer);
        setCurrentSource(undefined);
        return;
      }

      if (!args) {
        enqueueSnackbar("Unable to initialize player: no args", { variant: "error" });
        setSelectedSource(undefined);
        setCurrentSource(undefined);
        return;
      }

      try {
        switch (args.type) {
          case "connection": {
            const newPlayer = foundSource.initialize({
              metricsCollector,
              params: args.params,
              cacheSizeBytes,
            });
            setBasePlayer(newPlayer);

            // Expose the source URL(s) so panels can re-read the recording. A
            // `urls` param (mcap-server) is a JSON array; `url` is a single URL.
            const urls = parseSourceUrls(args.params);
            setCurrentSource(
              urls.length > 0 ? { kind: "urls", sourceId: foundSource.id, urls } : undefined,
            );

            if (args.params?.url) {
              addRecent({
                type: "connection",
                sourceId: foundSource.id,
                title: args.params.url,
                label: foundSource.displayName,
                extra: args.params,
              });
            }

            return;
          }
          case "file": {
            const handle = args.handle;
            const files = args.files;

            // files we can try loading immediately
            // We do not add these to recents entries because putting File in indexedb results in
            // the entire file being stored in the database.
            if (files) {
              let file = files[0];
              const fileList: File[] = [];

              for (const curFile of files) {
                file ??= curFile;
                fileList.push(curFile);
              }
              const multiFile = foundSource.supportsMultiFile === true && fileList.length > 1;

              const newPlayer = foundSource.initialize({
                file: multiFile ? undefined : file,
                files: multiFile ? fileList : undefined,
                metricsCollector,
                cacheSizeBytes,
              });

              setBasePlayer(newPlayer);
              // Keep the (lazy, on-disk) File references so panels can re-read.
              setCurrentSource({ kind: "files", sourceId: foundSource.id, files: fileList });
              return;
            } else if (handle) {
              const permission = await handle.queryPermission({ mode: "read" });
              if (!isMounted()) {
                return;
              }

              if (permission !== "granted") {
                const newPerm = await handle.requestPermission({ mode: "read" });
                if (newPerm !== "granted") {
                  throw new Error(`Permission denied: ${handle.name}`);
                }
              }

              const file = await handle.getFile();
              if (!isMounted()) {
                return;
              }

              const newPlayer = foundSource.initialize({
                file,
                metricsCollector,
                cacheSizeBytes,
              });

              setBasePlayer(newPlayer);
              setCurrentSource({ kind: "files", sourceId: foundSource.id, files: [file] });
              addRecent({
                type: "file",
                title: handle.name,
                sourceId: foundSource.id,
                handle,
              });

              return;
            }
          }
        }

        // Reached only when a file source had neither files nor a handle.
        setCurrentSource(undefined);
        enqueueSnackbar("Unable to initialize player", { variant: "error" });
      } catch (error) {
        // Initialization failed (e.g. permission denied); don't leave a stale
        // handle pointing at the previous recording.
        setCurrentSource(undefined);
        enqueueSnackbar((error as Error).message, { variant: "error" });
      }
    },
    [playerSources, metricsCollector, cacheSizeBytes, enqueueSnackbar, isMounted, addRecent],
  );

  // Select a recent entry by id
  // necessary to pull out callback creation to avoid capturing the initial player in closure context
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const selectRecent = useCallback(
    createSelectRecentCallback(recents, selectSource, enqueueSnackbar),
    [recents, enqueueSnackbar, selectSource],
  );

  // Make a RecentSources array for the PlayerSelectionContext
  const recentSources = useMemo(() => {
    return recents.map((item) => {
      return { id: item.id, title: item.title, label: item.label };
    });
  }, [recents]);

  const value: PlayerSelection = useMemo(
    () => ({
      selectSource,
      selectRecent,
      selectedSource,
      currentSource,
      availableSources: playerSources,
      recentSources,
    }),
    [selectSource, selectRecent, selectedSource, currentSource, playerSources, recentSources],
  );

  return (
    <>
      <PlayerSelectionContext.Provider value={value}>
        <MessagePipelineProvider player={player}>{children}</MessagePipelineProvider>
      </PlayerSelectionContext.Provider>
    </>
  );
}

/**
 * This was moved out of the PlayerManager function due to a memory leak occurring in memoized state of Start.tsx
 * that was retaining old player instances. Having this callback be defined within the PlayerManager makes it store the
 * player at instantiation within the closure context. That callback is then stored in the memoized state with its closure context.
 * The callback is updated when the player changes but part of the `Start.tsx` holds onto the formerly memoized state for an
 * unknown reason.
 * To make this function safe from storing old closure contexts in old memoized state in components where it
 * is used, it has been moved out of the PlayerManager function.
 */
function createSelectRecentCallback(
  recents: RecentRecord[],
  selectSource: (sourceId: string, dataSourceArgs: DataSourceArgs) => Promise<void>,
  enqueueSnackbar: ReturnType<typeof useSnackbar>["enqueueSnackbar"],
) {
  return (recentId: string) => {
    // find the recent from the list and initialize
    const foundRecent = recents.find((value) => value.id === recentId);
    if (!foundRecent) {
      enqueueSnackbar(`Failed to restore recent: ${recentId}`, { variant: "error" });
      return;
    }

    switch (foundRecent.type) {
      case "connection": {
        void selectSource(foundRecent.sourceId, {
          type: "connection",
          params: foundRecent.extra,
        });
        break;
      }
      case "file": {
        void selectSource(foundRecent.sourceId, {
          type: "file",
          handle: foundRecent.handle,
        });
      }
    }
  };
}
