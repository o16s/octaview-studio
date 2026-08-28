// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { create } from "zustand";

import { getSecureStorage } from "@foxglove/studio-base/services/secureStorage";

import {
  EDGE_HUB_CONNECTIONS_KEY,
  EdgeHubCredentials,
  parseEdgeHubConnections,
  serializeEdgeHubConnections,
  upsertEdgeHubConnection,
} from "./edgeHubCredentials";

/**
 * Shared, reactive cache of saved Edge Hub connections. This exists so that the
 * "Connections" sidebar tab updates immediately when a connection is saved via the
 * "Open connection" dialog, rather than only reflecting whatever was on disk the one
 * time the tab happened to mount - both read/write through this same store.
 */
const useStore = create<{ connections: EdgeHubCredentials[] }>(() => ({ connections: [] }));

/** Reactively subscribes to the saved Edge Hub connections list. */
export function useEdgeHubConnections(): EdgeHubCredentials[] {
  return useStore((state) => state.connections);
}

/** Reloads the saved connections list from secure storage into the reactive store. */
export async function refreshEdgeHubConnections(): Promise<void> {
  const secureStorage = getSecureStorage();
  if (!secureStorage) {
    return;
  }
  const serialized = await secureStorage.get(EDGE_HUB_CONNECTIONS_KEY);
  useStore.setState({ connections: parseEdgeHubConnections(serialized) });
}

/**
 * Saves a connection (adding it, or updating an existing entry with the same ip) and
 * updates the reactive store so any mounted "Connections" tab reflects it immediately.
 *
 * Always re-reads the current list from secure storage first rather than upserting
 * against the in-memory store's (possibly stale/not-yet-loaded) state, so this can't
 * clobber a connection that was saved before this store was ever refreshed.
 */
export async function saveEdgeHubConnection(connection: EdgeHubCredentials): Promise<void> {
  const secureStorage = getSecureStorage();
  if (!secureStorage) {
    return;
  }
  const serialized = await secureStorage.get(EDGE_HUB_CONNECTIONS_KEY);
  const next = upsertEdgeHubConnection(parseEdgeHubConnections(serialized), connection);
  await secureStorage.set(EDGE_HUB_CONNECTIONS_KEY, serializeEdgeHubConnections(next));
  useStore.setState({ connections: next });
}
