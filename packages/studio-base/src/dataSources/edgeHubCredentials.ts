// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Key used to store the list of saved Edge Hub connections via the desktop app's secure
 * storage bridge. Storage holds an array (not a single {ip, token} pair) so that multiple
 * Edge Hubs can be saved at once - see upsertEdgeHubConnection.
 */
export const EDGE_HUB_CONNECTIONS_KEY = "edge-hub-connections";

export type EdgeHubCredentials = {
  ip: string;
  token: string;
};

function isEdgeHubCredentials(value: unknown): value is EdgeHubCredentials {
  return (
    typeof value === "object" &&
    value != undefined &&
    typeof (value as Partial<EdgeHubCredentials>).ip === "string" &&
    typeof (value as Partial<EdgeHubCredentials>).token === "string"
  );
}

/** Serializes the list of saved Edge Hub connections for storage. */
export function serializeEdgeHubConnections(connections: EdgeHubCredentials[]): string {
  const serialized = JSON.stringify(connections);
  if (serialized == undefined) {
    throw new Error("Failed to serialize Edge Hub connections");
  }
  return serialized;
}

/**
 * Parses previously-stored Edge Hub connections. Returns an empty array if the data is
 * missing or entirely malformed, and silently drops individually malformed entries rather
 * than discarding the whole list (a single corrupted entry shouldn't hide every other
 * saved connection).
 */
export function parseEdgeHubConnections(serialized: string | undefined): EdgeHubCredentials[] {
  if (serialized == undefined) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  return parsed.filter(isEdgeHubCredentials);
}

/**
 * Adds a connection to the saved list, or updates the existing entry's token in place
 * (keeping its position) if one with the same ip already exists.
 */
export function upsertEdgeHubConnection(
  connections: EdgeHubCredentials[],
  connection: EdgeHubCredentials,
): EdgeHubCredentials[] {
  const existingIndex = connections.findIndex((c) => c.ip === connection.ip);
  if (existingIndex === -1) {
    return [...connections, connection];
  }
  const next = [...connections];
  next[existingIndex] = connection;
  return next;
}
