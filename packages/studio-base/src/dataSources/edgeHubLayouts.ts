// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { LayoutData } from "@foxglove/studio-base/context/CurrentLayoutContext/actions";

/** Each saved Edge Hub connection's last-used layout, keyed by ip. */
export type EdgeHubLayouts = Record<string, LayoutData>;

/** Serializes the per-connection layout map for storage. */
export function serializeEdgeHubLayouts(layouts: EdgeHubLayouts): string {
  const serialized = JSON.stringify(layouts);
  if (serialized == undefined) {
    throw new Error("Failed to serialize Edge Hub layouts");
  }
  return serialized;
}

/**
 * Parses the previously-stored per-connection layout map. Returns an empty map if the
 * data is missing or entirely malformed, and drops individually malformed entries
 * rather than discarding every other connection's saved layout.
 */
export function parseEdgeHubLayouts(serialized: string | undefined): EdgeHubLayouts {
  if (serialized == undefined) {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return {};
  }
  if (typeof parsed !== "object" || parsed == undefined || Array.isArray(parsed)) {
    return {};
  }
  const result: EdgeHubLayouts = {};
  for (const [ip, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value === "object" && value != undefined && !Array.isArray(value)) {
      result[ip] = value as LayoutData;
    }
  }
  return result;
}

/** Returns a new layout map with the given ip's layout set (added or overwritten). */
export function setEdgeHubLayout(
  layouts: EdgeHubLayouts,
  ip: string,
  layout: LayoutData,
): EdgeHubLayouts {
  return { ...layouts, [ip]: layout };
}
