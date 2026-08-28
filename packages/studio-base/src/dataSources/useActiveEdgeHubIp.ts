// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import { useEdgeHubConnections } from "@foxglove/studio-base/dataSources/edgeHubConnectionsStore";
import { buildEdgeHubWebSocketUrl } from "@foxglove/studio-base/dataSources/edgeHubHost";
import { PlayerPresence } from "@foxglove/studio-base/players/types";

const EDGE_HUB_SOURCE_ID = "octaview-edge-hub";

const selectPlayerPresence = ({ playerState }: MessagePipelineContext) => playerState.presence;
const selectUrlState = ({ playerState }: MessagePipelineContext) => playerState.urlState;

/**
 * The ip of the saved Edge Hub connection that's currently active, or undefined if
 * there's no active connection, it's not an Edge Hub, or it doesn't match any saved
 * connection (e.g. a fresh connect via the dialog that hasn't been saved as this
 * exact ip string - not expected in practice since Connection.tsx saves on connect,
 * but this hook doesn't assume it).
 *
 * Matches by comparing each saved connection's *derived* url against the active
 * connection's url, rather than trying to parse the ip back out of the url - the
 * saved ip and the url-embedded host can differ in ways that don't round-trip
 * (e.g. a saved ip with no explicit port vs. the url's default-port-appended host).
 */
export function useActiveEdgeHubIp(): string | undefined {
  const playerPresence = useMessagePipeline(selectPlayerPresence);
  const urlState = useMessagePipeline(selectUrlState);
  const connections = useEdgeHubConnections();

  if (playerPresence !== PlayerPresence.PRESENT || urlState?.sourceId !== EDGE_HUB_SOURCE_ID) {
    return undefined;
  }
  return connections.find(
    (connection) => urlState.parameters?.url === buildEdgeHubWebSocketUrl(connection.ip),
  )?.ip;
}
