// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Typography } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import EmptyState from "@foxglove/studio-base/components/EmptyState";
import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import Stack from "@foxglove/studio-base/components/Stack";
// Reuses TopicList's row/selected styling so an active connection gets the same
// orange-border treatment used for selected topics/panels elsewhere in the app.
import { useTopicListStyles } from "@foxglove/studio-base/components/TopicList/useTopicListStyles";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import {
  EDGE_HUB_CREDENTIALS_KEY,
  parseEdgeHubCredentials,
} from "@foxglove/studio-base/dataSources/edgeHubCredentials";
import {
  EdgeHubHealth,
  fetchEdgeHubHealth,
} from "@foxglove/studio-base/dataSources/edgeHubHealth";
import { PlayerPresence } from "@foxglove/studio-base/players/types";
import { getSecureStorage } from "@foxglove/studio-base/services/secureStorage";

// Only the Edge Hub source persists credentials today (via secure storage). If more
// sources gain saved-connection support later, this becomes a small list of loaders
// instead of a single one.
const EDGE_HUB_SOURCE_ID = "octaview-edge-hub";
const HEALTH_POLL_INTERVAL_MS = 10_000;

const selectPlayerPresence = ({ playerState }: MessagePipelineContext) => playerState.presence;

type SavedConnection = {
  sourceId: string;
  ip: string;
  params: Record<string, string | undefined>;
};

async function loadSavedConnections(): Promise<SavedConnection[]> {
  const secureStorage = getSecureStorage();
  if (!secureStorage) {
    return [];
  }
  const serialized = await secureStorage.get(EDGE_HUB_CREDENTIALS_KEY);
  const credentials = parseEdgeHubCredentials(serialized);
  if (!credentials) {
    return [];
  }
  return [{ sourceId: EDGE_HUB_SOURCE_ID, ip: credentials.ip, params: credentials }];
}

export function MyConnections(): JSX.Element {
  const { t } = useTranslation("workspace");
  const { classes, cx } = useTopicListStyles();
  const { availableSources, selectedSource, selectSource } = usePlayerSelection();
  const playerPresence = useMessagePipeline(selectPlayerPresence);

  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);
  const [health, setHealth] = useState<Record<string, EdgeHubHealth | undefined>>({});

  useEffect(() => {
    let cancelled = false;
    void loadSavedConnections().then((connections) => {
      if (!cancelled) {
        setSavedConnections(connections);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Periodically check each saved connection's /healthz endpoint so the list shows
  // whether the device is currently reachable, not just what was last saved.
  useEffect(() => {
    if (savedConnections.length === 0) {
      return;
    }
    let cancelled = false;
    const poll = () => {
      savedConnections.forEach((connection) => {
        void fetchEdgeHubHealth(connection.ip).then((result) => {
          if (!cancelled) {
            setHealth((prev) => ({ ...prev, [connection.sourceId]: result }));
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
  }, [savedConnections]);

  if (savedConnections.length === 0) {
    return <EmptyState>{t("noSavedConnections")}</EmptyState>;
  }

  return (
    <Stack overflow="auto">
      {savedConnections.map((connection) => {
        const source = availableSources.find((s) => s.id === connection.sourceId);
        if (!source) {
          return ReactNull;
        }
        // Only one connection can be open at a time, so "active" is simply: this is
        // the currently selected source, and the player has actually connected.
        const isActive =
          selectedSource?.id === connection.sourceId && playerPresence === PlayerPresence.PRESENT;
        const connectionHealth = health[connection.sourceId];

        return (
          <div
            key={connection.sourceId}
            className={cx(classes.row, { [classes.selected]: isActive })}
            style={{ height: 50, cursor: "pointer" }}
            onClick={() => {
              selectSource(connection.sourceId, {
                type: "connection",
                params: connection.params,
              });
            }}
          >
            <Stack flex="auto" overflow="hidden">
              <Typography variant="body2" noWrap>
                {source.displayName}
                {isActive && ` — ${t("connected")}`}
              </Typography>
              <Typography variant="caption" color="text.secondary" noWrap>
                {connection.ip}
                {connectionHealth
                  ? ` · ${connectionHealth.status} · ${connectionHealth.version}`
                  : ` · ${t("unreachable")}`}
              </Typography>
            </Stack>
          </div>
        );
      })}
    </Stack>
  );
}
