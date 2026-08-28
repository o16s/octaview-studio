// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import DownloadIcon from "@mui/icons-material/Download";
import {
  Button,
  Chip,
  CircularProgress,
  List,
  ListItem,
  ListItemButton,
  SvgIcon,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { makeStyles } from "tss-react/mui";

import FoxgloveLogoText from "@foxglove/studio-base/components/FoxgloveLogoText";
import Stack from "@foxglove/studio-base/components/Stack";
import { useAnalytics } from "@foxglove/studio-base/context/AnalyticsContext";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import { useWorkspaceActions } from "@foxglove/studio-base/context/Workspace/useWorkspaceActions";
import { useSavedEdgeHubConnections } from "@foxglove/studio-base/dataSources/useSavedEdgeHubConnections";
import { AppEvent } from "@foxglove/studio-base/services/IAnalytics";

const EDGE_HUB_SOURCE_ID = "octaview-edge-hub";

type DownloadFile = {
  name: string;
  size: number;
  platform: "mac-arm64" | "mac-x64" | "windows";
};

const PLATFORM_LABELS: Record<string, string> = {
  "mac-arm64": "macOS (Apple Silicon)",
  "mac-x64": "macOS (Intel)",
  windows: "Windows",
};

function formatSize(bytes: number): string {
  if (bytes >= 1e9) {
    return `${(bytes / 1e9).toFixed(1)} GB`;
  }
  return `${(bytes / 1e6).toFixed(1)} MB`;
}

function detectPlatform(): string | undefined {
  const ua = navigator.userAgent.toLowerCase();
  if (ua.includes("win")) {
    return "windows";
  }
  if (ua.includes("mac")) {
    // Check for Apple Silicon via platform or GPU
    // navigator.platform is "MacIntel" even on AS in some browsers,
    // but we can use a rough heuristic
    return undefined; // show both mac options
  }
  return undefined;
}

const useStyles = makeStyles()((theme) => ({
  logo: {
    width: 212,
    height: "auto",
    marginLeft: theme.spacing(-1),
  },
  content: {
    padding: theme.spacing(6),
    overflow: "hidden",

    [theme.breakpoints.down("md")]: {
      padding: theme.spacing(4),
    },
  },
  connectionButton: {
    textAlign: "left",
    justifyContent: "flex-start",
    padding: theme.spacing(2, 3),
    gap: theme.spacing(1.5),
    borderColor: theme.palette.divider,

    ".MuiButton-startIcon .MuiSvgIcon-fontSizeLarge": {
      fontSize: 28,
    },
  },
  recentListItemButton: {
    overflow: "hidden",
    color: theme.palette.primary.main,

    "&:hover": {
      backgroundColor: "transparent",
      color: theme.palette.primary[theme.palette.mode === "dark" ? "light" : "dark"],
    },
  },
  recentSourceSecondary: {
    color: "inherit",
  },
  downloadButton: {
    justifyContent: "space-between",
    padding: theme.spacing(1.5, 2),
    borderColor: theme.palette.divider,
  },
  downloadHighlight: {
    borderColor: theme.palette.primary.main,
    borderWidth: 2,
  },
}));

const serverConfig = (globalThis as Record<string, unknown>).OCTAVIEW_STUDIO_SERVER as
  | { apiBase?: string; hasDownloads?: boolean }
  | undefined;
const isServerMode = typeof serverConfig === "object";
const hasDownloads = isServerMode && serverConfig?.hasDownloads === true;

export default function Start(): JSX.Element {
  const { availableSources, selectSource } = usePlayerSelection();
  const savedConnections = useSavedEdgeHubConnections();
  const { classes, cx } = useStyles();
  const analytics = useAnalytics();
  const { t } = useTranslation("openDialog");
  const { dialogActions } = useWorkspaceActions();

  const edgeHubSource = useMemo(
    () => availableSources.find((source) => source.id === EDGE_HUB_SOURCE_ID),
    [availableSources],
  );

  const [downloads, setDownloads] = useState<DownloadFile[]>([]);
  const [downloadsLoading, setDownloadsLoading] = useState(false);

  useEffect(() => {
    if (!hasDownloads) {
      return;
    }
    setDownloadsLoading(true);
    fetch("/api/downloads")
      .then(async (res) => {
        if (res.ok) {
          setDownloads((await res.json()) as DownloadFile[]);
        }
      })
      .catch(() => {
        // silently ignore
      })
      .finally(() => {
        setDownloadsLoading(false);
      });
  }, []);

  const userPlatform = useMemo(() => detectPlatform(), []);

  const handleDownload = useCallback((file: DownloadFile) => {
    const a = document.createElement("a");
    a.href = `/api/downloads/${encodeURIComponent(file.name)}`;
    a.download = file.name;
    a.click();
  }, []);

  const startItems = useMemo(() => {
    const items: Array<{
      key: string;
      text: string;
      secondaryText: string;
      icon: JSX.Element;
      onClick: () => void;
    }> = [];

    if (isServerMode) {
      items.push({
        key: "browse-recordings",
        text: "Browse recordings",
        secondaryText: "Open MCAP files from the server",
        icon: (
          <SvgIcon fontSize="large" color="primary" viewBox="0 0 2048 2048">
            <path d="M1792 384v128H256V384h1536zM256 1664V640h1536v1024H256zm128-896v768h1280V768H384zm1024 128v512H640V896h768zM768 1280V1024h512v256H768z" />
          </SvgIcon>
        ),
        onClick: () => {
          dialogActions.dataSource.open("server");
          void analytics.logEvent(AppEvent.DIALOG_SELECT_VIEW, { type: "server" });
        },
      });
    }

    items.push(
      {
        key: "open-local-file",
        text: t("openLocalFile"),
        secondaryText: t("openLocalFileDescription"),
        icon: (
          <SvgIcon fontSize="large" color="primary" viewBox="0 0 2048 2048">
            <path d="M1955 1533l-163-162v677h-128v-677l-163 162-90-90 317-317 317 317-90 90zM256 1920h1280v128H128V0h1115l549 549v475h-128V640h-512V128H256v1792zM1280 512h293l-293-293v293z" />
          </SvgIcon>
        ),
        onClick: () => {
          dialogActions.dataSource.open("file");
          void analytics.logEvent(AppEvent.DIALOG_SELECT_VIEW, { type: "local" });
        },
      },
      {
        key: "open-connection",
        text: t("openConnection"),
        secondaryText: t("openConnectionDescription"),
        icon: (
          <SvgIcon fontSize="large" color="primary" viewBox="0 0 2048 2048">
            <path d="M1408 256h640v640h-640V640h-120l-449 896H640v256H0v-640h640v256h120l449-896h199V256zM512 1664v-384H128v384h384zm1408-896V384h-384v384h384z" />
          </SvgIcon>
        ),
        onClick: () => {
          dialogActions.dataSource.open("connection");
          void analytics.logEvent(AppEvent.DIALOG_SELECT_VIEW, { type: "live" });
        },
      },
    );

    return items;
  }, [analytics, dialogActions.dataSource, t]);

  return (
    <Stack>
      <header className={classes.content}>
        <FoxgloveLogoText color="primary" className={classes.logo} />
      </header>
      <Stack className={classes.content} paddingTop={0}>
        <Stack gap={4}>
          <Stack gap={1}>
            <Typography variant="h5" gutterBottom>
              {t("openDataSource")}
            </Typography>
            {startItems.map((item) => (
              <Button
                key={item.key}
                className={classes.connectionButton}
                fullWidth
                color="inherit"
                variant="outlined"
                startIcon={item.icon}
                onClick={item.onClick}
              >
                <Stack flex="auto" zeroMinWidth>
                  <Typography variant="subtitle1" color="text.primary">
                    {item.text}
                  </Typography>
                  <Typography variant="body2" color="text.secondary" noWrap>
                    {item.secondaryText}
                  </Typography>
                </Stack>
              </Button>
            ))}
          </Stack>
          {savedConnections.length > 0 && edgeHubSource && (
            <Stack gap={1}>
              <Typography variant="h5" gutterBottom>
                {t("savedConnections")}
              </Typography>
              <List disablePadding>
                {savedConnections.map((connection) => (
                  <ListItem disablePadding key={connection.ip}>
                    <ListItemButton
                      disableGutters
                      onClick={() => {
                        selectSource(EDGE_HUB_SOURCE_ID, {
                          type: "connection",
                          params: { ip: connection.ip, token: connection.token },
                        });
                        void analytics.logEvent(AppEvent.DIALOG_CLOSE, {
                          activeDataSource: EDGE_HUB_SOURCE_ID,
                        });
                        dialogActions.dataSource.close();
                      }}
                      className={classes.recentListItemButton}
                    >
                      <Stack flex="auto" zeroMinWidth>
                        <Typography
                          variant="body2"
                          className={classes.recentSourceSecondary}
                          noWrap
                        >
                          {edgeHubSource.displayName}
                        </Typography>
                        <Typography variant="caption" color="text.secondary" noWrap>
                          {connection.ip}
                          {connection.health
                            ? ` · ${connection.health.status} · ${connection.health.version}`
                            : ` · ${t("unreachable")}`}
                        </Typography>
                      </Stack>
                    </ListItemButton>
                  </ListItem>
                ))}
              </List>
            </Stack>
          )}
          {hasDownloads && (
            <Stack gap={1}>
              <Typography variant="h5" gutterBottom>
                Download Desktop App
              </Typography>
              {downloadsLoading && <CircularProgress size={24} />}
              {downloads.length === 0 && !downloadsLoading && (
                <Typography variant="body2" color="text.secondary">
                  No installers available on this server.
                </Typography>
              )}
              {downloads.map((file) => {
                const isMatch = userPlatform === file.platform;
                return (
                  <Button
                    key={file.name}
                    className={cx(classes.downloadButton, isMatch && classes.downloadHighlight)}
                    fullWidth
                    color="inherit"
                    variant="outlined"
                    startIcon={<DownloadIcon color="primary" />}
                    onClick={() => {
                      handleDownload(file);
                    }}
                  >
                    <Stack direction="row" alignItems="center" gap={1} flex="auto">
                      <Typography variant="subtitle2" color="text.primary">
                        {PLATFORM_LABELS[file.platform] ?? file.platform}
                      </Typography>
                      {isMatch && <Chip label="Recommended" size="small" color="primary" />}
                    </Stack>
                    <Typography variant="body2" color="text.secondary">
                      {formatSize(file.size)}
                    </Typography>
                  </Button>
                );
              })}
            </Stack>
          )}
        </Stack>
      </Stack>
    </Stack>
  );
}
