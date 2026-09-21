// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  openMcapWorkbook,
  openMcapWorkbookFromBlob,
  type McapWorkbookSource,
} from "@o16s/mcap-sheets";

import { CurrentSourceHandle } from "@foxglove/studio-base/context/PlayerSelectionContext";

/** The path portion of a URL or filename — query string and fragment removed. */
function urlPath(nameOrUrl: string): string {
  return nameOrUrl.split("#")[0]!.split("?")[0]!;
}

const isMcap = (nameOrUrl: string): boolean => urlPath(nameOrUrl).toLowerCase().endsWith(".mcap");

/**
 * An opener that reads the current source as a mcap-sheets workbook, or
 * undefined when it isn't a readable MCAP file. Reads the recording directly
 * (byte-range for URLs, Blob slicing for local files) rather than through the
 * player's stream, so it isn't bounded by the player's preload cache.
 *
 * Multi-file recordings open their first part for now (mcap-sheets reads one
 * file per workbook).
 */
export function makeBaseOpener(
  source: CurrentSourceHandle | undefined,
): (() => Promise<McapWorkbookSource>) | undefined {
  if (!source) {
    return undefined;
  }
  if (source.kind === "urls") {
    const url = source.urls[0];
    return url != undefined && isMcap(url) ? async () => await openMcapWorkbook(url) : undefined;
  }
  const file = source.files[0];
  return file != undefined && isMcap(file.name)
    ? async () => await openMcapWorkbookFromBlob(file)
    : undefined;
}

/**
 * Canonical topic name for cross-source comparison. The player normalizes topic
 * names with a leading slash (`/foo`) while mcap-sheets reads the raw MCAP
 * channel names (`foo`), so we compare without a leading slash.
 */
const canonicalTopic = (topic: string): string => (topic.startsWith("/") ? topic.slice(1) : topic);

/**
 * Drop the topics the user has hidden. Hiding (rather than an allow-list) is
 * deliberate: the settings checkboxes come from the player's topic names while
 * this filters the workbook's raw topic names, so an unmatched hidden name
 * simply hides nothing — it can never blank the whole sheet, and topics that
 * appear later stay visible by default. Names are canonicalized so the player's
 * leading-slash form still matches the workbook's raw form.
 */
export function visibleTopics<T extends { topic: string }>(
  topics: readonly T[],
  hiddenTopics: readonly string[] | undefined,
): T[] {
  if (!hiddenTopics || hiddenTopics.length === 0) {
    return [...topics];
  }
  const hidden = new Set(hiddenTopics.map(canonicalTopic));
  return topics.filter((entry) => !hidden.has(canonicalTopic(entry.topic)));
}

/**
 * A key that changes when the recording or the visible topic set changes.
 * MCAPSheet (v0.2+) only re-opens the workbook when its `url` changes, so a
 * change to the topic filter (a new `workbookOpener`) alone won't take effect —
 * we use this as a React `key` to remount, forcing a fresh open with the current
 * filter. It stays stable across unrelated re-renders so those don't reload.
 */
export function sheetSourceKey(
  source: CurrentSourceHandle | undefined,
  hiddenTopics: readonly string[] | undefined,
): string {
  const src = !source
    ? "none"
    : source.kind === "urls"
      ? source.urls.join("|")
      : source.files.map((file) => `${file.name}:${file.size}`).join("|");
  const hidden = hiddenTopics ? [...hiddenTopics].sort((a, b) => a.localeCompare(b)).join(" ") : "";
  return `${src}::${hidden}`;
}

/**
 * A short, stable, human-readable name for the current source (the recording's
 * base filename), shown in the sheet's header. Stable because it comes from the
 * source handle rather than the player, which avoids reloading the grid when the
 * player's name resolves a moment after the source is selected.
 */
export function sourceDisplayName(source: CurrentSourceHandle | undefined): string {
  if (!source) {
    return "MCAP";
  }
  if (source.kind === "files") {
    return source.files[0]?.name ?? "MCAP";
  }
  const url = source.urls[0];
  if (url == undefined) {
    return "MCAP";
  }
  try {
    const path = urlPath(decodeURIComponent(url));
    const base = path.substring(path.lastIndexOf("/") + 1);
    return base.length > 0 ? base : path;
  } catch {
    return url;
  }
}
