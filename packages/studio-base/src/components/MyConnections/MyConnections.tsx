// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import ClearIcon from "@mui/icons-material/Clear";
import SearchIcon from "@mui/icons-material/Search";
import { Chip, IconButton, Paper, TextField, Typography } from "@mui/material";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { makeStyles } from "tss-react/mui";

import { BuiltinIcon } from "@foxglove/studio-base/components/BuiltinIcon";
import EmptyState from "@foxglove/studio-base/components/EmptyState";
import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import Stack from "@foxglove/studio-base/components/Stack";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import {
  refreshEdgeHubConnections,
  useEdgeHubConnections,
} from "@foxglove/studio-base/dataSources/edgeHubConnectionsStore";
import {
  EdgeHubHealth,
  fetchEdgeHubHealth,
} from "@foxglove/studio-base/dataSources/edgeHubHealth";
import { buildEdgeHubWebSocketUrl } from "@foxglove/studio-base/dataSources/edgeHubHost";
import { PlayerPresence } from "@foxglove/studio-base/players/types";

// Only the Edge Hub source persists credentials today (via secure storage). If more
// sources gain saved-connection support later, this becomes a small list of loaders
// instead of a single one.
const EDGE_HUB_SOURCE_ID = "octaview-edge-hub";
const HEALTH_POLL_INTERVAL_MS = 10_000;

const selectPlayerPresence = ({ playerState }: MessagePipelineContext) => playerState.presence;
const selectUrlState = ({ playerState }: MessagePipelineContext) => playerState.urlState;

const useStyles = makeStyles()((theme) => ({
  root: {
    height: "100%",
    display: "flex",
    flexDirection: "column",
  },
  filterBar: {
    position: "sticky",
    top: 0,
    zIndex: theme.zIndex.appBar,
    padding: theme.spacing(0.5),
    backgroundColor: theme.palette.background.paper,
  },
  filterStartAdornment: {
    display: "flex",
  },
  list: {
    flex: "auto",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: theme.spacing(1),
    padding: theme.spacing(1),
  },
  row: {
    display: "flex",
    alignItems: "center",
    gap: theme.spacing(1.5),
    padding: theme.spacing(1.5),
    cursor: "pointer",
    borderLeft: `3px solid transparent`,

    "&:hover": {
      backgroundColor: theme.palette.action.hover,
    },
  },
  rowActive: {
    borderLeftColor: theme.palette.primary.main,
    backgroundColor: theme.palette.action.selected,

    "&:hover": {
      backgroundColor: theme.palette.action.selected,
    },
  },
  icon: {
    display: "flex",
    flexShrink: 0,
    color: theme.palette.text.secondary,
    fontSize: 20,
  },
  textContent: {
    flex: "auto",
    minWidth: 0,
  },
}));

type SavedConnection = {
  sourceId: string;
  ip: string;
  params: Record<string, string | undefined>;
};

export function MyConnections(): JSX.Element {
  const { t } = useTranslation("workspace");
  const { classes, cx } = useStyles();
  const { availableSources, selectSource } = usePlayerSelection();
  const playerPresence = useMessagePipeline(selectPlayerPresence);
  const activeUrlState = useMessagePipeline(selectUrlState);

  const [filterText, setFilterText] = useState("");
  const [health, setHealth] = useState<Record<string, EdgeHubHealth | undefined>>({});

  // Reactive: also updates immediately if a connection is saved elsewhere (e.g. the
  // "Open connection" dialog) while this tab is already mounted, not just on mount.
  const edgeHubConnections = useEdgeHubConnections();
  const savedConnections = useMemo<SavedConnection[]>(
    () =>
      edgeHubConnections.map((credentials) => ({
        sourceId: EDGE_HUB_SOURCE_ID,
        ip: credentials.ip,
        params: credentials,
      })),
    [edgeHubConnections],
  );

  useEffect(() => {
    void refreshEdgeHubConnections();
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
  }, [savedConnections]);

  const filteredConnections = useMemo(() => {
    const needle = filterText.trim().toLowerCase();
    if (!needle) {
      return savedConnections;
    }
    return savedConnections.filter((connection) => connection.ip.toLowerCase().includes(needle));
  }, [filterText, savedConnections]);

  return (
    <div className={classes.root}>
      <div className={classes.filterBar}>
        <TextField
          variant="filled"
          fullWidth
          placeholder={t("filterByHostname")}
          value={filterText}
          onChange={(event) => {
            setFilterText(event.target.value);
          }}
          InputProps={{
            size: "small",
            startAdornment: (
              <div className={classes.filterStartAdornment}>
                <SearchIcon fontSize="small" />
              </div>
            ),
            endAdornment: filterText && (
              <IconButton
                size="small"
                title={t("clearFilter")}
                edge="end"
                onClick={() => {
                  setFilterText("");
                }}
              >
                <ClearIcon fontSize="small" />
              </IconButton>
            ),
          }}
        />
      </div>

      {filteredConnections.length === 0 ? (
        <EmptyState>
          {savedConnections.length === 0 ? t("noSavedConnections") : t("noConnectionsMatching")}
        </EmptyState>
      ) : (
        <div className={classes.list}>
          {filteredConnections.map((connection) => {
            const source = availableSources.find((s) => s.id === connection.sourceId);
            if (!source) {
              return ReactNull;
            }
            // Only one connection can be open at a time. Multiple saved connections
            // share the same sourceId (they're all Edge Hubs), so "active" has to be
            // determined by comparing the actual connection url, not just the source.
            const isActive =
              playerPresence === PlayerPresence.PRESENT &&
              activeUrlState?.sourceId === connection.sourceId &&
              activeUrlState.parameters?.url === buildEdgeHubWebSocketUrl(connection.ip);
            const connectionHealth = health[connection.ip];

            return (
              <Paper
                key={connection.ip}
                variant="outlined"
                className={cx(classes.row, { [classes.rowActive]: isActive })}
                onClick={() => {
                  selectSource(connection.sourceId, {
                    type: "connection",
                    params: connection.params,
                  });
                }}
              >
                <div className={classes.icon}>
                  <BuiltinIcon name={source.iconName ?? "Flow"} />
                </div>
                <Stack className={classes.textContent}>
                  <Typography variant="body2" noWrap>
                    {source.displayName}
                  </Typography>
                  <Typography variant="caption" color="text.secondary" noWrap>
                    {connection.ip}
                    {connectionHealth
                      ? ` · ${connectionHealth.status} · ${connectionHealth.version}`
                      : ` · ${t("unreachable")}`}
                  </Typography>
                </Stack>
                {isActive && <Chip size="small" color="primary" label={t("connected")} />}
              </Paper>
            );
          })}
        </div>
      )}
    </div>
  );
}
