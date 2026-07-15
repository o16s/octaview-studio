// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import path from "path";
import { useCallback, useMemo } from "react";

import type { LayoutData } from "@foxglove/studio-base/context/CurrentLayoutContext";
import {
  IDataSourceFactory,
  usePlayerSelection,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import { extractFilesFromZip } from "@foxglove/studio-base/util/extractZip";
import { parseLayoutFile } from "@foxglove/studio-base/util/parseLayoutFile";
import showOpenFilePicker from "@foxglove/studio-base/util/showOpenFilePicker";

export function useOpenFile(
  sources: readonly IDataSourceFactory[],
  onLayoutFound?: (data: LayoutData, name: string) => void,
): () => Promise<void> {
  const { selectSource } = usePlayerSelection();

  const allExtensions = useMemo(() => {
    const exts = sources.reduce<string[]>((all, source) => {
      if (!source.supportedFileTypes) {
        return all;
      }

      return [...all, ...source.supportedFileTypes];
    }, []);
    exts.push(".zip", ".json");
    return exts;
  }, [sources]);

  return useCallback(async () => {
    const fileHandles = await showOpenFilePicker({
      multiple: true,
      types: [
        {
          description: allExtensions.join(", "),
          accept: { "application/octet-stream": allExtensions },
        },
      ],
    });
    if (fileHandles.length === 0) {
      return;
    }

    let files = await Promise.all(fileHandles.map((h) => h.getFile()));

    // Extract ZIP files, replacing them with their contents
    const expanded: File[] = [];
    for (const file of files) {
      if (path.extname(file.name) === ".zip") {
        const extracted = await extractFilesFromZip(file);
        expanded.push(...extracted);
      } else {
        expanded.push(file);
      }
    }
    // Separate layout JSON files from data files
    const dataFiles: File[] = [];
    for (const file of expanded) {
      if (file.name.endsWith(".json")) {
        const layoutData = await parseLayoutFile(file);
        if (layoutData && onLayoutFound) {
          onLayoutFound(layoutData, file.name);
          continue;
        }
      }
      dataFiles.push(file);
    }
    files = dataFiles;

    if (files.length === 0) {
      return;
    }

    const firstFile = files[0]!;

    // Find the first _file_ source which can load our extension
    const matchingSources = sources.filter((source) => {
      if (!source.supportedFileTypes || source.type !== "file") {
        return false;
      }

      const extension = path.extname(firstFile.name);
      return source.supportedFileTypes.includes(extension);
    });

    if (matchingSources.length > 1) {
      throw new Error(`Multiple source matched ${firstFile.name}. This is not supported.`);
    }

    const foundSource = matchingSources[0];
    if (!foundSource) {
      throw new Error(`Cannot find source to handle ${firstFile.name}`);
    }

    selectSource(foundSource.id, { type: "file", files });
  }, [allExtensions, onLayoutFound, selectSource, sources]);
}
