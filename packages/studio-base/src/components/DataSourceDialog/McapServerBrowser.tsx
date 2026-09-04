// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import FolderIcon from "@mui/icons-material/Folder";
import FolderOpenIcon from "@mui/icons-material/FolderOpen";
import {
  Button,
  Checkbox,
  CircularProgress,
  Collapse,
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
import { getApiBase } from "@foxglove/studio-base/util/serverConfig";

import View from "./View";

type McapFileInfo = {
  name: string;
  path: string;
  size: number;
  modTime: string;
};

type FolderNode = {
  name: string;
  path: string;
  folders: Map<string, FolderNode>;
  files: McapFileInfo[];
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

function buildTree(files: McapFileInfo[]): FolderNode {
  const root: FolderNode = { name: "", path: "", folders: new Map(), files: [] };

  for (const file of files) {
    const parts = file.path.split("/");
    let node = root;

    // Navigate/create folder nodes for all but the last segment
    for (let i = 0; i < parts.length - 1; i++) {
      const folderName = parts[i]!;
      const folderPath = parts.slice(0, i + 1).join("/");
      let child = node.folders.get(folderName);
      if (!child) {
        child = { name: folderName, path: folderPath, folders: new Map(), files: [] };
        node.folders.set(folderName, child);
      }
      node = child;
    }

    node.files.push(file);
  }

  return root;
}

function collectFilePaths(node: FolderNode): string[] {
  const paths: string[] = node.files.map((f) => f.path);
  for (const child of node.folders.values()) {
    paths.push(...collectFilePaths(child));
  }
  return paths;
}

function FolderView({
  node,
  depth,
  selected,
  toggleFile,
  expanded,
  toggleFolder,
}: {
  node: FolderNode;
  depth: number;
  selected: Set<string>;
  toggleFile: (path: string) => void;
  expanded: Set<string>;
  toggleFolder: (path: string) => void;
}): JSX.Element {
  const sortedFolders = useMemo(
    () => Array.from(node.folders.values()).sort((a, b) => a.name.localeCompare(b.name)),
    [node.folders],
  );
  const sortedFiles = useMemo(
    () => [...node.files].sort((a, b) => a.name.localeCompare(b.name)),
    [node.files],
  );

  return (
    <>
      {sortedFolders.map((folder) => {
        const isExpanded = expanded.has(folder.path);
        const allPaths = collectFilePaths(folder);
        const allSelected = allPaths.length > 0 && allPaths.every((p) => selected.has(p));
        const someSelected = !allSelected && allPaths.some((p) => selected.has(p));

        return (
          <div key={folder.path}>
            <ListItem disablePadding>
              <ListItemButton
                dense
                sx={{ pl: 2 + depth * 3 }}
                onClick={() => { toggleFolder(folder.path); }}
              >
                <ListItemIcon sx={{ minWidth: 36 }}>
                  <Checkbox
                    edge="start"
                    checked={allSelected}
                    indeterminate={someSelected}
                    disableRipple
                    tabIndex={-1}
                    onClick={(e) => {
                      e.stopPropagation();
                      for (const p of allPaths) {
                        if (allSelected) {
                          if (selected.has(p)) {
                            toggleFile(p);
                          }
                        } else {
                          if (!selected.has(p)) {
                            toggleFile(p);
                          }
                        }
                      }
                    }}
                  />
                </ListItemIcon>
                <ListItemIcon sx={{ minWidth: 32 }}>
                  {isExpanded ? <FolderOpenIcon color="primary" /> : <FolderIcon color="primary" />}
                </ListItemIcon>
                <ListItemText
                  primary={folder.name}
                  primaryTypographyProps={{ fontWeight: 600 }}
                  secondary={`${allPaths.length} file${allPaths.length !== 1 ? "s" : ""}`}
                />
              </ListItemButton>
            </ListItem>
            <Collapse in={isExpanded}>
              <FolderView
                node={folder}
                depth={depth + 1}
                selected={selected}
                toggleFile={toggleFile}
                expanded={expanded}
                toggleFolder={toggleFolder}
              />
            </Collapse>
          </div>
        );
      })}
      {sortedFiles.map((file) => (
        <ListItem key={file.path} disablePadding>
          <ListItemButton
            dense
            sx={{ pl: 2 + depth * 3 }}
            onClick={() => { toggleFile(file.path); }}
          >
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
            <Typography variant="body2" sx={{ color: "text.secondary", whiteSpace: "nowrap", ml: 2 }}>
              {formatFileSize(file.size)}
            </Typography>
          </ListItemButton>
        </ListItem>
      ))}
    </>
  );
}

export default function McapServerBrowser({
  onSwitchView,
}: {
  onSwitchView?: () => void;
}): JSX.Element {
  const { classes } = useStyles();
  const { selectSource } = usePlayerSelection();
  const { dialogActions } = useWorkspaceActions();

  const [files, setFiles] = useState<McapFileInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  const apiBase = useMemo(() => getApiBase(), []);

  const tree = useMemo(() => buildTree(files), [files]);

  // Auto-expand all folders on load
  useEffect(() => {
    const allFolders = new Set<string>();
    const walk = (node: FolderNode) => {
      for (const child of node.folders.values()) {
        allFolders.add(child.path);
        walk(child);
      }
    };
    walk(tree);
    setExpanded(allFolders);
  }, [tree]);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(undefined);
    fetch(`${apiBase}/api/mcap/files`, { signal: controller.signal })
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
        if (err.name === "AbortError") {
          return;
        }
        setError(err.message);
        setLoading(false);
      });
    return () => { controller.abort(); };
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

  const toggleFolder = useCallback((path: string) => {
    setExpanded((prev) => {
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
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Typography variant="h3" fontWeight={600}>
            Browse recordings
          </Typography>
        </Stack>

        {!loading && files.length > 0 && onSwitchView && (
          <Stack direction="row" justifyContent="flex-end">
            <Button size="small" onClick={onSwitchView}>
              Timeline view
            </Button>
          </Stack>
        )}

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
              <FolderView
                node={tree}
                depth={0}
                selected={selected}
                toggleFile={toggleFile}
                expanded={expanded}
                toggleFolder={toggleFolder}
              />
            </List>
          </>
        )}
      </Stack>
    </View>
  );
}
