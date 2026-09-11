// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  IDataSourceFactory,
  DataSourceFactoryInitializeArgs,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import { IterablePlayer, WorkerIterableSource } from "@foxglove/studio-base/players/IterablePlayer";
import { Player } from "@foxglove/studio-base/players/types";

// Module-level store for pre-downloaded files passed from McapTimeline
const pendingDownloads = new Map<string, File[]>();

/**
 * Store downloaded files so the factory can pick them up by ID.
 * Called by McapTimeline after sequential download completes.
 */
export function storeDownloadedFiles(id: string, files: File[]): void {
  pendingDownloads.set(id, files);
}

class McapServerDataSourceFactory implements IDataSourceFactory {
  public id = "mcap-server";
  public type: IDataSourceFactory["type"] = "connection";
  public displayName = "MCAP Server";
  public iconName: IDataSourceFactory["iconName"] = "OpenFile";
  public description = "Browse and open MCAP files from the server.";
  public hidden = true; // Hidden from the Connection tab; accessed via "Browse recordings" button

  public initialize(args: DataSourceFactoryInitializeArgs): Player | undefined {
    const initWorker = () => {
      return new Worker(
        // foxglove-depcheck-used: babel-plugin-transform-import-meta
        new URL(
          "@foxglove/studio-base/players/IterablePlayer/Mcap/McapIterableSourceWorker.worker",
          import.meta.url,
        ),
      );
    };

    // Check for pre-downloaded files first
    const downloadId = args.params?.downloadId;
    if (downloadId) {
      const files = pendingDownloads.get(downloadId);
      pendingDownloads.delete(downloadId);
      if (files && files.length > 0) {
        const name = files.length === 1
          ? (files[0]!.name)
          : `${files.length} files`;

        const source = new WorkerIterableSource({
          initWorker,
          initArgs: files.length === 1 ? { file: files[0] } : { files },
        });

        return new IterablePlayer({
          metricsCollector: args.metricsCollector,
          source,
          name,
          sourceId: this.id,
        });
      }
    }

    // URL-based loading. The player reads these by byte range (HTTP Range), so
    // it starts at once and never holds a whole recording in the page.
    const urlsParam = args.params?.urls;
    if (!urlsParam) {
      return;
    }

    let urls: string[];
    try {
      urls = JSON.parse(urlsParam) as string[];
    } catch {
      urls = [urlsParam];
    }
    if (urls.length === 0) {
      return;
    }

    const name = urls.length === 1
      ? decodeURIComponent(urls[0]!.split("/").pop() ?? urls[0]!)
      : `${urls.length} files`;

    const source = new WorkerIterableSource({
      initWorker,
      initArgs: urls.length === 1 ? { url: urls[0] } : { urls },
    });

    return new IterablePlayer({
      metricsCollector: args.metricsCollector,
      source,
      name,
      sourceId: this.id,
    });
  }
}

export default McapServerDataSourceFactory;
