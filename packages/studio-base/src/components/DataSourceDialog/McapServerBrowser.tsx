// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  Button,
  Checkbox,
  CircularProgress,
  List,
  ListItem,
  ListItemButton,
  ListItemIcon,
  ListItemText,
  Typography,
} from "@mui/material";
import { useCallback, useEffect, useMemo, useState } from "react";
import { makeStyles } from "tss-react/mui";

import Stack from "@foxglove/studio-base/components/Stack";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import { useWorkspaceActions } from "@foxglove/studio-base/context/Workspace/useWorkspaceActions";

import View from "./View";

type McapFileInfo = {
  name: string;
  path: string;
  size: number;
  modTime: string;
};

const useStyles = makeStyles()((theme) => ({
  container: {
    padding: theme.spacing(4),
  },
  list: {
    overflow: "auto",
    maxHeight: 400,
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: theme.shape.borderRadius,
  },
  fileSize: {
    color: theme.palette.text.secondary,
    whiteSpace: "nowrap",
    marginLeft: theme.spacing(2),
  },
}));

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  } else if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  } else if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function formatDate(isoString: string): string {
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return isoString;
  }
}

export default function McapServerBrowser(): JSX.Element {
  const { classes } = useStyles();
  const { selectSource } = usePlayerSelection();
  const { dialogActions } = useWorkspaceActions();

  const [files, setFiles] = useState<McapFileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const apiBase = useMemo(() => {
    const serverConfig = (globalThis as Record<string, unknown>).FOXGLOVE_STUDIO_SERVER as
      | { apiBase?: string }
      | undefined;
    return serverConfig?.apiBase ?? "";
  }, []);

  useEffect(() => {
    setLoading(true);
    setError(undefined);
    fetch(`${apiBase}/api/mcap/files`)
      .then(async (res) => {
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        return (await res.json()) as McapFileInfo[];
      })
      .then((data) => {
        setFiles(data);
        setLoading(false);
      })
      .catch((err: Error) => {
        setError(err.message);
        setLoading(false);
      });
  }, [apiBase]);

  const toggleFile = useCallback((path: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const selectAll = useCallback(() => {
    if (selected.size === files.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(files.map((f) => f.path)));
    }
  }, [files, selected.size]);

  const onOpen = useCallback(() => {
    if (selected.size === 0) {
      return;
    }
    const urls = Array.from(selected)
      .map((filePath) => `${apiBase}/api/mcap/files/${encodeURIComponent(filePath)}`);
    selectSource("mcap-server", { type: "connection", params: { urls: JSON.stringify(urls) } });
    dialogActions.dataSource.close();
  }, [apiBase, dialogActions.dataSource, selectSource, selected]);

  return (
    <View onOpen={selected.size > 0 ? onOpen : undefined}>
      <Stack className={classes.container} gap={2}>
        <Typography variant="h3" fontWeight={600} gutterBottom>
          Browse recordings
        </Typography>

        {loading && (
          <Stack alignItems="center" padding={4}>
            <CircularProgress />
          </Stack>
        )}

        {error != undefined && (
          <Typography color="error">Failed to load file list: {error}</Typography>
        )}

        {!loading && error == undefined && files.length === 0 && (
          <Typography color="text.secondary">
            No MCAP files found on the server.
          </Typography>
        )}

        {!loading && files.length > 0 && (
          <>
            <Stack direction="row" justifyContent="space-between" alignItems="center">
              <Typography variant="body2" color="text.secondary">
                {files.length} file{files.length !== 1 ? "s" : ""} found
                {selected.size > 0 ? ` — ${selected.size} selected` : ""}
              </Typography>
              <Button size="small" onClick={selectAll}>
                {selected.size === files.length ? "Deselect all" : "Select all"}
              </Button>
            </Stack>
            <List disablePadding className={classes.list}>
              {files.map((file) => (
                <ListItem key={file.path} disablePadding>
                  <ListItemButton dense onClick={() => { toggleFile(file.path); }}>
                    <ListItemIcon sx={{ minWidth: 36 }}>
                      <Checkbox
                        edge="start"
                        checked={selected.has(file.path)}
                        disableRipple
                        tabIndex={-1}
                      />
                    </ListItemIcon>
                    <ListItemText
                      primary={file.name}
                      secondary={formatDate(file.modTime)}
                    />
                    <Typography variant="body2" className={classes.fileSize}>
                      {formatFileSize(file.size)}
                    </Typography>
                  </ListItemButton>
                </ListItem>
              ))}
            </List>
          </>
        )}
      </Stack>
    </View>
  );
}
