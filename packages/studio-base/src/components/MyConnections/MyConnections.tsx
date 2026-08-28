// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { List, ListItemButton, ListItemText } from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import EmptyState from "@foxglove/studio-base/components/EmptyState";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import {
  EDGE_HUB_CREDENTIALS_KEY,
  parseEdgeHubCredentials,
} from "@foxglove/studio-base/dataSources/edgeHubCredentials";
import { getSecureStorage } from "@foxglove/studio-base/services/secureStorage";

// Only the Edge Hub source persists credentials today (via secure storage). If more
// sources gain saved-connection support later, this becomes a small list of loaders
// instead of a single one.
const EDGE_HUB_SOURCE_ID = "octaview-edge-hub";

type SavedConnection = {
  sourceId: string;
  subtitle: string;
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
  return [{ sourceId: EDGE_HUB_SOURCE_ID, subtitle: credentials.ip, params: credentials }];
}

export function MyConnections(): JSX.Element {
  const { t } = useTranslation("workspace");
  const { availableSources, selectSource } = usePlayerSelection();
  const [savedConnections, setSavedConnections] = useState<SavedConnection[]>([]);

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

  if (savedConnections.length === 0) {
    return <EmptyState>{t("noSavedConnections")}</EmptyState>;
  }

  return (
    <List dense disablePadding>
      {savedConnections.map((connection) => {
        const source = availableSources.find((s) => s.id === connection.sourceId);
        if (!source) {
          return ReactNull;
        }
        return (
          <ListItemButton
            key={connection.sourceId}
            onClick={() => {
              selectSource(connection.sourceId, { type: "connection", params: connection.params });
            }}
          >
            <ListItemText primary={source.displayName} secondary={connection.subtitle} />
          </ListItemButton>
        );
      })}
    </List>
  );
}
