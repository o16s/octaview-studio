// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useEffect, useMemo, useState } from "react";

import {
  refreshEdgeHubConnections,
  useEdgeHubConnections,
} from "@foxglove/studio-base/dataSources/edgeHubConnectionsStore";
import { EdgeHubCredentials } from "@foxglove/studio-base/dataSources/edgeHubCredentials";
import {
  EdgeHubHealth,
  fetchEdgeHubHealth,
} from "@foxglove/studio-base/dataSources/edgeHubHealth";

const HEALTH_POLL_INTERVAL_MS = 10_000;

export type SavedEdgeHubConnection = EdgeHubCredentials & { health: EdgeHubHealth | undefined };

/**
 * Saved Edge Hub connections plus live /healthz status, reactively updated as
 * connections are saved elsewhere (e.g. the "Open connection" dialog) and refreshed
 * periodically. Shared by every place that lists saved connections - the "Connections"
 * sidebar tab and the start screen's "Saved Connections" section - so they always
 * show the same data.
 */
export function useSavedEdgeHubConnections(): SavedEdgeHubConnection[] {
  const connections = useEdgeHubConnections();
  const [health, setHealth] = useState<Record<string, EdgeHubHealth | undefined>>({});

  useEffect(() => {
    void refreshEdgeHubConnections();
  }, []);

  useEffect(() => {
    if (connections.length === 0) {
      return;
    }
    let cancelled = false;
    const poll = () => {
      connections.forEach((connection) => {
        void fetchEdgeHubHealth(connection.ip).then((result) => {
          if (!cancelled) {
            setHealth((prev) => ({ ...prev, [connection.ip]: result }));
          }
        });
      });
    };
    poll();
    const interval = setInterval(poll, HEALTH_POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [connections]);

  return useMemo(
    () => connections.map((connection) => ({ ...connection, health: health[connection.ip] })),
    [connections, health],
  );
}
