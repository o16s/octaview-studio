// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import AddIcon from "@mui/icons-material/Add";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import RefreshIcon from "@mui/icons-material/Refresh";
import RemoveIcon from "@mui/icons-material/Remove";
import {
  Button,
  ButtonGroup,
  Checkbox,
  CircularProgress,
  Divider,
  IconButton,
  LinearProgress,
  Link,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from "@mui/material";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeStyles } from "tss-react/mui";

import Stack from "@foxglove/studio-base/components/Stack";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import { useWorkspaceActions } from "@foxglove/studio-base/context/Workspace/useWorkspaceActions";
import { storeDownloadedFiles } from "@foxglove/studio-base/dataSources/McapServerDataSourceFactory";
import { exportFilesAsZip } from "@foxglove/studio-base/util/exportZip";

import View from "./View";

type McapFileIndex = {
  path: string;
  folder: string;
  filename: string;
  startTime: number; // unix seconds
  endTime: number; // unix seconds
  size: number;
};

type Incident = {
  time: string; // ISO 8601
  summary?: string;
  severity?: "critical" | "error" | "warning" | "info";
  dedup_key?: string;
  source?: string;
};

const SEVERITY_COLORS: Record<string, string> = {
  critical: "#E5484D",
  error: "#FF5C00",
  warning: "#F5B82E",
  info: "#3E63DD",
};

const INCIDENT_ROW_HEIGHT = 28;

function parseUrlIncidents(): { centerTime?: number; incidents: Incident[] } {
  if (typeof window === "undefined") {
    return { incidents: [] };
  }
  const params = new URLSearchParams(window.location.search);
  const tParam = params.get("t");
  const incParam = params.get("incidents");

  const centerTime = tParam ? Number(tParam) : undefined;
  let incidents: Incident[] = [];

  if (incParam) {
    try {
      incidents = JSON.parse(atob(incParam)) as Incident[];
    } catch {
      // Try URL-decoded JSON as fallback
      try {
        incidents = JSON.parse(incParam) as Incident[];
      } catch {
        // ignore
      }
    }
  }

  return { centerTime: centerTime != null && !isNaN(centerTime) ? centerTime : undefined, incidents };
}

type ViewMode = "day" | "week" | "month";

type DownloadProgress = {
  fileIndex: number;
  totalFiles: number;
  currentFilename: string;
  currentLoaded: number;
  currentTotal: number;
  completedBytes: number;
  grandTotal: number;
};

const ROW_HEIGHT = 12;
const HEADER_HEIGHT = 40;
const DEFAULT_LABEL_WIDTH = 180;
const MIN_LABEL_WIDTH = 80;
const BAR_HEIGHT = 10;
const BAR_Y_OFFSET = (ROW_HEIGHT - BAR_HEIGHT) / 2;
const MIN_BAR_WIDTH = 4;
const DEFAULT_SELECTION_SPAN_MIN = 5;
const DOWNLOAD_CONCURRENCY = 4; // number of parallel file downloads
const PROGRESS_THROTTLE_MS = 100; // minimum interval between progress UI updates

const VIEW_DURATIONS: Record<ViewMode, number> = {
  day: 24 * 3600,
  week: 7 * 24 * 3600,
  month: 30 * 24 * 3600,
};

const NOW_DURATION = 3600; // 1 hour

// Adaptive tick intervals based on visible duration
const TICK_LEVELS = [
  { maxDuration: 600, interval: 60, format: "time" },         // < 10min → every minute
  { maxDuration: 3600, interval: 300, format: "time" },        // < 1h → every 5 min
  { maxDuration: 6 * 3600, interval: 1800, format: "time" },   // < 6h → every 30 min
  { maxDuration: 2 * 86400, interval: 3600, format: "time" },  // < 2d → every hour
  { maxDuration: 7 * 86400, interval: 86400, format: "date" }, // < 1w → every day
  { maxDuration: 30 * 86400, interval: 3 * 86400, format: "date" }, // < 1m → every 3 days
  { maxDuration: 90 * 86400, interval: 7 * 86400, format: "date" }, // < 3m → every week
  { maxDuration: Infinity, interval: 30 * 86400, format: "month" }, // else → every month
] as const;

function getTickConfig(duration: number): { interval: number; format: string } {
  for (const level of TICK_LEVELS) {
    if (duration <= level.maxDuration) {
      return { interval: level.interval, format: level.format };
    }
  }
  return { interval: 30 * 86400, format: "month" };
}

function formatTickLabel(time: number, format: string): string {
  const d = new Date(time * 1000);
  switch (format) {
    case "time":
      return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    case "date":
      return d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
    case "month":
      return d.toLocaleDateString([], { month: "short", year: "numeric" });
    default:
      return d.toLocaleDateString();
  }
}

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

const useStyles = makeStyles()((theme) => ({
  container: {
    padding: theme.spacing(4),
    overflow: "hidden",
    display: "flex",
    flexDirection: "column",
    height: "100%",
  },
  toolbar: {
    marginBottom: theme.spacing(2),
  },
  timelineWrapper: {
    display: "flex",
    flexDirection: "column",
    border: `1px solid ${theme.palette.divider}`,
    borderRadius: theme.shape.borderRadius,
    flex: 1,
    minHeight: 200,
  },
  timelineHeader: {
    display: "flex",
    flexShrink: 0,
    borderBottom: `1px solid ${theme.palette.divider}`,
    backgroundColor: theme.palette.background.paper,
  },
  timelineBody: {
    display: "flex",
    overflowX: "hidden",
    overflowY: "auto",
    flex: 1,
    position: "relative",
  },
  labelColumn: {
    flexShrink: 0,
    position: "relative" as const,
  },
  labelDragHandle: {
    position: "absolute" as const,
    top: 0,
    right: 0,
    width: 4,
    height: "100%",
    cursor: "col-resize",
    borderRight: `1px solid ${theme.palette.divider}`,
    "&:hover": {
      borderRight: `2px solid ${theme.palette.primary.main}`,
    },
  },
  labelHeader: {
    height: HEADER_HEIGHT,
    display: "flex",
    alignItems: "center",
    padding: theme.spacing(0, 1.5),
    boxSizing: "border-box" as const,
    borderRight: `1px solid ${theme.palette.divider}`,
  },
  labelRow: {
    height: ROW_HEIGHT,
    display: "flex",
    alignItems: "center",
    padding: theme.spacing(0, 1.5),
    borderBottom: `1px solid ${theme.palette.divider}`,
    "&:last-child": {
      borderBottom: "none",
    },
  },
  svgColumn: {
    flex: 1,
    minWidth: 0,
  },
  selectionInfo: {
    marginTop: theme.spacing(1),
  },
  tooltip: {
    position: "absolute",
    pointerEvents: "none",
    backgroundColor: theme.palette.grey[900],
    color: theme.palette.common.white,
    padding: theme.spacing(0.75, 1.5),
    borderRadius: theme.shape.borderRadius,
    fontSize: 12,
    lineHeight: 1.4,
    zIndex: 10,
    maxWidth: 300,
    whiteSpace: "nowrap",
  },
  dateInput: {
    height: 31,
    fontSize: 13,
    borderRadius: 4,
    border: `1px solid ${theme.palette.action.disabled}`,
    padding: "0 8px",
    background: "transparent",
    color: theme.palette.text.primary,
    outline: "none",
    "&:hover": {
      borderColor: theme.palette.text.primary,
    },
    "&:focus": {
      borderColor: theme.palette.primary.main,
    },
  },
  downloadOverlay: {
    position: "absolute",
    inset: 0,
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: theme.palette.background.paper,
    zIndex: 20,
    gap: theme.spacing(2),
    padding: theme.spacing(4),
  },
}));

// Data visualization palette (octaview design system, colorblind-aware)
const COLORS = [
  "#3E63DD",
  "#30A46C",
  "#FF5C00",
  "#8E4EC6",
  "#00A2C7",
  "#E5484D",
  "#F5B82E",
  "#6E6E7C",
];

type VisibleBar = {
  file: McapFileIndex;
  x: number;
  width: number;
  y: number;
  color: string;
  folderIdx: number;
};

// Assign files to lanes so overlapping recordings don't stack on top of each other.
// Returns a Map from file path to lane index (0-based), and the total number of lanes.
function assignLanes(files: McapFileIndex[]): { laneMap: Map<string, number>; laneCount: number } {
  // files should already be sorted by startTime
  const laneEnds: number[] = []; // end time of the last file in each lane
  const laneMap = new Map<string, number>();
  for (const file of files) {
    let assigned = -1;
    for (let i = 0; i < laneEnds.length; i++) {
      if (laneEnds[i]! <= file.startTime) {
        assigned = i;
        laneEnds[i] = file.endTime;
        break;
      }
    }
    if (assigned === -1) {
      assigned = laneEnds.length;
      laneEnds.push(file.endTime);
    }
    laneMap.set(file.path, assigned);
  }
  return { laneMap, laneCount: Math.max(1, laneEnds.length) };
}

export default function McapTimeline(): JSX.Element {
  const { classes, theme } = useStyles();
  const { selectSource } = usePlayerSelection();
  const { dialogActions } = useWorkspaceActions();

  const [viewDuration, setViewDuration] = useState(VIEW_DURATIONS.week);
  const [viewStart, setViewStart] = useState<number>(() => {
    const now = Date.now() / 1000;
    return now - VIEW_DURATIONS.week;
  });
  const [dateInput, setDateInput] = useState("");

  const apiBase = useMemo(() => {
    const serverConfig = (globalThis as Record<string, unknown>).OCTAVIEW_STUDIO_SERVER as
      | { apiBase?: string }
      | undefined;
    return serverConfig?.apiBase ?? "";
  }, []);

  const [files, setFiles] = useState<McapFileIndex[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [indexProgress, setIndexProgress] = useState<{ indexed: number; total: number } | undefined>();
  const [refreshKey, setRefreshKey] = useState(0);

  // Folder selection state — initialized with all folders, togglable via checkboxes
  const [selectedRows, setSelectedRows] = useState<Set<string>>(new Set());
  const allFolders = useMemo(() => new Set(files.map((f) => f.folder || "(root)")), [files]);
  useEffect(() => {
    setSelectedRows(new Set(allFolders));
  }, [allFolders]);

  // Resizable label column (persisted to localStorage)
  const LABEL_WIDTH_KEY = "mcapTimeline.labelWidth";
  const [labelWidth, setLabelWidth] = useState(() => {
    const stored = localStorage.getItem(LABEL_WIDTH_KEY);
    return stored != null ? Math.max(MIN_LABEL_WIDTH, Number(stored)) : DEFAULT_LABEL_WIDTH;
  });
  const labelWidthRef = useRef(labelWidth);
  labelWidthRef.current = labelWidth;
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      const delta = e.clientX - dragRef.current.startX;
      setLabelWidth(Math.max(MIN_LABEL_WIDTH, dragRef.current.startWidth + delta));
    };
    const onMouseUp = () => {
      if (dragRef.current) {
        localStorage.setItem(LABEL_WIDTH_KEY, String(labelWidthRef.current));
      }
      dragRef.current = null;
    };
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
    return () => {
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };
  }, []);

  // Click selection state
  const [selCenter, setSelCenter] = useState<number | undefined>();
  const [selectionSpanMin, setSelectionSpanMin] = useState(DEFAULT_SELECTION_SPAN_MIN);
  const selectionSpan = selectionSpanMin * 60; // seconds
  const svgRef = useRef<SVGSVGElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgColumnRef = useRef<HTMLDivElement>(null);
  const [svgColumnWidth, setSvgColumnWidth] = useState(0);

  // Hover tooltip state
  const [tooltipState, setTooltipState] = useState<{
    file?: McapFileIndex;
    incident?: Incident & { timeSec: number };
    x: number;
    y: number;
  } | null>(null);

  // Open button dropdown state
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | null>(null);
  const [excludedFiles, setExcludedFiles] = useState<Set<string>>(new Set());

  // URL-driven incidents
  const urlParams = useMemo(() => parseUrlIncidents(), []);
  const incidents = urlParams.incidents;
  const hasIncidents = incidents.length > 0;

  // Convert incident times to unix seconds for rendering
  const incidentMarkers = useMemo(() => {
    return incidents.map((inc) => ({
      ...inc,
      timeSec: new Date(inc.time).getTime() / 1000,
    }));
  }, [incidents]);

  // Measure SVG column width with ResizeObserver
  // Re-run when files appear (the div mounts) or disappear
  const timelineVisible = files.length > 0;
  useEffect(() => {
    const el = svgColumnRef.current;
    if (!el) {
      return;
    }
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setSvgColumnWidth(entry.contentRect.width);
      }
    });
    ro.observe(el);
    setSvgColumnWidth(el.clientWidth);
    return () => { ro.disconnect(); };
  }, [timelineVisible]);

  // Download state
  const [downloadProgress, setDownloadProgress] = useState<DownloadProgress | undefined>();
  const downloadAbortRef = useRef<AbortController | undefined>();
  const downloadStartRef = useRef<number>(0);

  // Fetch index from server (streaming NDJSON)
  useEffect(() => {
    const isRefresh = refreshKey > 0;
    const controller = new AbortController();
    setError(undefined);
    if (isRefresh) {
      setRefreshing(true);
    } else {
      setLoading(true);
      setIndexProgress(undefined);
      setFiles([]);
    }

    (async () => {
      try {
        const res = await fetch(`${apiBase}/api/mcap/index`, { signal: controller.signal });
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const reader = res.body?.getReader();
        if (!reader) {
          throw new Error("No response body");
        }

        const decoder = new TextDecoder();
        let buffer = "";
        let indexed = 0;
        const accumulated: McapFileIndex[] = [];

        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });

          // Process complete lines
          let newlineIdx: number;
          while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
            const line = buffer.slice(0, newlineIdx).trim();
            buffer = buffer.slice(newlineIdx + 1);
            if (line.length === 0) {
              continue;
            }
            try {
              const msg = JSON.parse(line) as Record<string, unknown>;
              if ("total" in msg) {
                if (!isRefresh) {
                  setIndexProgress({ indexed: 0, total: msg.total as number });
                }
              } else if ("file" in msg) {
                accumulated.push(msg.file as McapFileIndex);
                indexed++;
                // Stream progress to UI on initial load only
                if (!isRefresh && indexed % 10 === 0) {
                  setFiles([...accumulated]);
                  setIndexProgress((prev) => prev ? { ...prev, indexed } : undefined);
                }
              }
            } catch {
              // skip unparseable lines
            }
          }
        }

        // Swap in final results
        setFiles([...accumulated]);
        setLoading(false);
        setRefreshing(false);
        setIndexProgress(undefined);
      } catch (err: unknown) {
        if ((err as Error).name === "AbortError") {
          return;
        }
        setError((err as Error).message);
        setLoading(false);
        setRefreshing(false);
      }
    })();

    return () => { controller.abort(); };
  }, [apiBase, refreshKey]);

  // Group files by folder
  const folders = useMemo(() => {
    const map = new Map<string, McapFileIndex[]>();
    for (const file of files) {
      const key = file.folder || "(root)";
      const list = map.get(key) ?? [];
      list.push(file);
      map.set(key, list);
    }
    const sorted = Array.from(map.entries()).sort(([a], [b]) => a.localeCompare(b));
    for (const [, list] of sorted) {
      list.sort((a, b) => a.startTime - b.startTime);
    }
    return sorted;
  }, [files]);

  const viewEnd = viewStart + viewDuration;

  const activePreset = useMemo((): ViewMode | undefined => {
    for (const [key, val] of Object.entries(VIEW_DURATIONS) as [ViewMode, number][]) {
      if (Math.abs(viewDuration - val) < 1) {
        return key;
      }
    }
    return undefined;
  }, [viewDuration]);

  // Auto-fit: center view when files first load
  const hasAutoFit = useRef(false);
  useEffect(() => {
    if (files.length === 0 || hasAutoFit.current) {
      return;
    }
    hasAutoFit.current = true;

    if (urlParams.centerTime != null) {
      // URL-driven: zoom to 5-minute window around the specified time
      const dur = selectionSpan * 2; // 10 min visible, 5 min selection centered
      setViewDuration(dur);
      setViewStart(urlParams.centerTime - dur / 2);
      setSelCenter(urlParams.centerTime);
    } else {
      // Default: center on "now" with day view, selection at now
      const now = Date.now() / 1000;
      setViewDuration(VIEW_DURATIONS.day);
      setViewStart(now - VIEW_DURATIONS.day / 2);
      setSelCenter(now);
    }
  }, [files, urlParams.centerTime]);

  // Compute lane assignments per folder (for parallel recordings)
  const folderLanes = useMemo(() => {
    return folders.map(([, folderFiles]) => assignLanes(folderFiles));
  }, [folders]);

  // Cumulative Y offset per folder (each folder may have multiple lanes)
  const folderYOffsets = useMemo(() => {
    const offsets: number[] = [];
    let y = 0;
    for (const { laneCount } of folderLanes) {
      offsets.push(y);
      y += laneCount * ROW_HEIGHT;
    }
    return offsets;
  }, [folderLanes]);

  const totalRowsHeight = folderYOffsets.length > 0
    ? folderYOffsets[folderYOffsets.length - 1]! + folderLanes[folderLanes.length - 1]!.laneCount * ROW_HEIGHT
    : 0;

  // SVG dimensions — add an incident row at top when incidents are present
  const svgWidth = Math.max(svgColumnWidth, 200);
  const incidentRowOffset = hasIncidents ? INCIDENT_ROW_HEIGHT : 0;
  const svgBodyHeight = incidentRowOffset + totalRowsHeight;
  const svgHeight = svgBodyHeight; // body SVG only (header is separate)

  // Time-to-pixel conversion
  const timeToX = useCallback(
    (t: number) => ((t - viewStart) / viewDuration) * svgWidth,
    [viewStart, viewDuration, svgWidth],
  );

  // Compute visible bars with viewport culling
  const visibleBars = useMemo((): VisibleBar[] => {
    const bars: VisibleBar[] = [];
    for (let folderIdx = 0; folderIdx < folders.length; folderIdx++) {
      const [, folderFiles] = folders[folderIdx]!;
      const { laneMap } = folderLanes[folderIdx]!;
      const color = COLORS[folderIdx % COLORS.length]!;
      const folderBaseY = incidentRowOffset + folderYOffsets[folderIdx]!;

      for (const file of folderFiles) {
        if (file.endTime < viewStart || file.startTime > viewEnd) {
          continue;
        }
        const lane = laneMap.get(file.path) ?? 0;
        const rowY = folderBaseY + lane * ROW_HEIGHT + BAR_Y_OFFSET;
        const x1 = Math.max(0, timeToX(file.startTime));
        const x2 = Math.min(svgWidth, timeToX(file.endTime));
        const barWidth = Math.max(MIN_BAR_WIDTH, x2 - x1);
        bars.push({ file, x: x1, width: barWidth, y: rowY, color, folderIdx });
      }
    }
    return bars;
  }, [folders, folderLanes, folderYOffsets, viewStart, viewEnd, timeToX, svgWidth]);

  // Generate tick marks
  const tickConfig = useMemo(() => getTickConfig(viewDuration), [viewDuration]);
  const ticks = useMemo(() => {
    const firstTick = Math.ceil(viewStart / tickConfig.interval) * tickConfig.interval;
    const result: number[] = [];
    for (let t = firstTick; t <= viewEnd; t += tickConfig.interval) {
      result.push(t);
    }
    return result;
  }, [viewStart, viewEnd, tickConfig.interval]);

  // Jump to now
  const jumpToNow = useCallback(() => {
    const now = Date.now() / 1000;
    setViewDuration(NOW_DURATION);
    setViewStart(now - NOW_DURATION / 2);
    setSelCenter(now);
  }, []);

  // Pan handlers
  const panAmount = viewDuration * 0.25;
  const panLeft = useCallback(() => {
    setViewStart((prev) => prev - panAmount);
  }, [panAmount]);
  const panRight = useCallback(() => {
    setViewStart((prev) => prev + panAmount);
  }, [panAmount]);

  // Zoom buttons — zoom around the view center
  const minDuration = 60;
  const maxDuration = 365 * 86400;
  const zoomIn = useCallback(() => {
    const center = viewStart + viewDuration / 2;
    const newDuration = Math.max(minDuration, viewDuration / 1.5);
    setViewDuration(newDuration);
    setViewStart(center - newDuration / 2);
  }, [viewStart, viewDuration]);
  const zoomOut = useCallback(() => {
    const center = viewStart + viewDuration / 2;
    const newDuration = Math.min(maxDuration, viewDuration * 1.5);
    setViewDuration(newDuration);
    setViewStart(center - newDuration / 2);
  }, [viewStart, viewDuration]);

  // Jump to a specific date
  const handleDateJump = useCallback(
    (dateStr: string) => {
      setDateInput(dateStr);
      if (!dateStr) {
        return;
      }
      const date = new Date(dateStr);
      if (isNaN(date.getTime())) {
        return;
      }
      const timeSec = date.getTime() / 1000;
      setViewStart(timeSec - viewDuration / 2);
    },
    [viewDuration],
  );

  // Click handler — place a 5-minute selection window
  const handleSvgClick = useCallback(
    (e: React.MouseEvent) => {
      const svg = svgRef.current;
      if (!svg) {
        return;
      }
      const rect = svg.getBoundingClientRect();
      const y = e.clientY - rect.top;
      if (y < incidentRowOffset) {
        return;
      }
      const x = e.clientX - rect.left;
      const time = viewStart + (x / svgWidth) * viewDuration;

      // Place time selection cursor
      startTransition(() => {
        if (selCenter != undefined && Math.abs(time - selCenter) < selectionSpan / 2) {
          setSelCenter(undefined);
        } else {
          setSelCenter(time);
        }
      });
    },
    [viewStart, viewDuration, svgWidth, selCenter, selectionSpan, incidentRowOffset],
  );

  // Hover handler — hit-test visible bars
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const svg = svgRef.current;
      const wrapper = wrapperRef.current;
      if (!svg || !wrapper) {
        setTooltipState(null);
        return;
      }
      const svgRect = svg.getBoundingClientRect();
      const mx = e.clientX - svgRect.left;
      const my = e.clientY - svgRect.top;

      const wrapperRect = wrapper.getBoundingClientRect();
      const scrollTop = wrapper.scrollTop;

      // Check incident markers first
      if (hasIncidents) {
        const incidentY = INCIDENT_ROW_HEIGHT / 2;
        for (const inc of incidentMarkers) {
          const ix = timeToX(inc.timeSec);
          const dist = Math.sqrt((mx - ix) ** 2 + (my - incidentY) ** 2);
          if (dist <= 10) {
            setTooltipState({
              incident: inc,
              x: e.clientX - wrapperRect.left + 12,
              y: e.clientY - wrapperRect.top + scrollTop - 10,
            });
            return;
          }
        }
      }

      let found: McapFileIndex | undefined;
      for (const bar of visibleBars) {
        if (mx >= bar.x && mx <= bar.x + bar.width && my >= bar.y && my <= bar.y + BAR_HEIGHT) {
          found = bar.file;
          break;
        }
      }

      if (found) {
        setTooltipState({
          file: found,
          x: e.clientX - wrapperRect.left + 12,
          y: e.clientY - wrapperRect.top + scrollTop - 10,
        });
      } else {
        setTooltipState(null);
      }
    },
    [visibleBars, hasIncidents, incidentMarkers, timeToX],
  );

  const handleMouseLeave = useCallback(() => {
    setTooltipState(null);
  }, []);

  // Compute selection
  const selectionRange = useMemo(() => {
    if (selCenter == undefined) {
      return undefined;
    }
    return { start: selCenter - selectionSpan / 2, end: selCenter + selectionSpan / 2 };
  }, [selCenter, selectionSpan]);

  const selectedFiles = useMemo(() => {
    if (!selectionRange || selectedRows.size === 0) {
      return [];
    }
    return files.filter((f) => {
      const folder = f.folder || "(root)";
      return (
        selectedRows.has(folder) &&
        f.startTime < selectionRange.end &&
        f.endTime > selectionRange.start
      );
    });
  }, [files, selectionRange, selectedRows]);

  // Reset excluded files when the time selection or folder selection changes
  useEffect(() => {
    setExcludedFiles(new Set());
  }, [selCenter, selectedRows]);

  // Files after user exclusions via dropdown
  const effectiveFiles = useMemo(
    () => selectedFiles.filter((f) => !excludedFiles.has(f.path)),
    [selectedFiles, excludedFiles],
  );

  const totalSize = useMemo(
    () => effectiveFiles.reduce((sum, f) => sum + f.size, 0),
    [effectiveFiles],
  );

  const selectedPaths = useMemo(() => new Set(selectedFiles.map((f) => f.path)), [selectedFiles]);

  // Download effective files in parallel with throttled progress updates.
  // Returns the downloaded File[] or undefined if aborted/failed.
  const downloadFiles = useCallback(async (): Promise<File[] | undefined> => {
    if (effectiveFiles.length === 0) {
      return undefined;
    }

    const abortController = new AbortController();
    downloadAbortRef.current = abortController;

    const grandTotal = effectiveFiles.reduce((sum, f) => sum + f.size, 0);

    // Per-file progress tracking (shared across parallel workers)
    const fileLoaded = new Array<number>(effectiveFiles.length).fill(0);
    const fileComplete = new Array<boolean>(effectiveFiles.length).fill(false);
    let lastProgressUpdate = 0;

    const flushProgress = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastProgressUpdate < PROGRESS_THROTTLE_MS) {
        return;
      }
      lastProgressUpdate = now;

      const totalLoaded = fileLoaded.reduce((a, b) => a + b, 0);
      // Find the first incomplete file for the label
      let activeIdx = effectiveFiles.length - 1;
      for (let j = 0; j < effectiveFiles.length; j++) {
        if (!fileComplete[j]) {
          activeIdx = j;
          break;
        }
      }
      const completedCount = fileComplete.filter(Boolean).length;

      setDownloadProgress({
        fileIndex: completedCount,
        totalFiles: effectiveFiles.length,
        currentFilename: effectiveFiles[activeIdx]!.filename,
        currentLoaded: 0,
        currentTotal: 0,
        completedBytes: totalLoaded,
        grandTotal,
      });
    };

    // Download a single file, updating shared progress
    const downloadOne = async (idx: number): Promise<File> => {
      const fileInfo = effectiveFiles[idx]!;
      const url = `${apiBase}/api/mcap/files/${encodeURIComponent(fileInfo.path)}`;

      const response = await fetch(url, { signal: abortController.signal });
      if (!response.ok) {
        throw new Error(`Failed to download ${fileInfo.filename}: HTTP ${response.status}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error(`No response body for ${fileInfo.filename}`);
      }

      const chunks: Uint8Array[] = [];
      for (;;) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        chunks.push(value);
        fileLoaded[idx] += value.byteLength;
        flushProgress(false);
      }

      fileComplete[idx] = true;
      flushProgress(false);

      const blob = new Blob(chunks);
      const fileName = fileInfo.folder ? `${fileInfo.folder}/${fileInfo.filename}` : fileInfo.filename;
      return new File([blob], fileName);
    };

    try {
      downloadStartRef.current = Date.now();
      flushProgress(true);

      // Run downloads with bounded concurrency
      const results = new Array<File>(effectiveFiles.length);
      let nextIdx = 0;

      const worker = async () => {
        while (nextIdx < effectiveFiles.length) {
          if (abortController.signal.aborted) {
            return;
          }
          const idx = nextIdx++;
          results[idx] = await downloadOne(idx);
        }
      };

      const workers = Array.from(
        { length: Math.min(DOWNLOAD_CONCURRENCY, effectiveFiles.length) },
        () => worker(),
      );
      await Promise.all(workers);

      if (abortController.signal.aborted) {
        return undefined;
      }

      flushProgress(true);
      return results.filter((f): f is File => f != undefined);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return undefined;
      }
      setError(err instanceof Error ? err.message : String(err));
      return undefined;
    } finally {
      setDownloadProgress(undefined);
      downloadAbortRef.current = undefined;
    }
  }, [apiBase, effectiveFiles]);

  // Download files and open in player
  const onOpen = useCallback(async () => {
    const downloaded = await downloadFiles();
    if (!downloaded || downloaded.length === 0) {
      return;
    }
    const downloadId = `dl-${Date.now()}`;
    storeDownloadedFiles(downloadId, downloaded);
    selectSource("mcap-server", {
      type: "connection",
      params: { downloadId },
    });
    dialogActions.dataSource.close();
  }, [downloadFiles, dialogActions.dataSource, selectSource]);

  // Download files and export as ZIP to disk (client-side)
  const onExport = useCallback(async () => {
    const downloaded = await downloadFiles();
    if (!downloaded || downloaded.length === 0) {
      return;
    }
    await exportFilesAsZip(downloaded);
  }, [downloadFiles]);

  // Cancel download on unmount
  useEffect(() => {
    return () => { downloadAbortRef.current?.abort(); };
  }, []);

  const isDownloading = downloadProgress != undefined;

  const customFooter = (
    <Stack
      direction="row"
      justifyContent="space-between"
      alignItems="center"
      paddingX={4}
      paddingBottom={4}
      paddingTop={2}
    >
      <Button
        startIcon={<ChevronLeftIcon fontSize="large" />}
        onClick={() => { dialogActions.dataSource.open("start"); }}
      >
        Back
      </Button>

      <Stack direction="column" alignItems="flex-end" gap={0.5}>
        <Stack direction="row" gap={2} alignItems="center">
          <Button
            color="inherit"
            variant="outlined"
            onClick={() => { dialogActions.dataSource.close(); }}
          >
            Cancel
          </Button>
          <ButtonGroup variant="contained">
            <Button
              onClick={onOpen}
              disabled={isDownloading || effectiveFiles.length === 0}
            >
              Open{effectiveFiles.length > 0 ? ` (${effectiveFiles.length})` : ""}
            </Button>
            <Button
              size="small"
              disabled={isDownloading || selectedFiles.length === 0}
              onClick={(e) => { setMenuAnchorEl(e.currentTarget); }}
              sx={{ px: 0.5, minWidth: 0 }}
            >
              <ArrowDropDownIcon />
            </Button>
          </ButtonGroup>
          <Menu
            anchorEl={menuAnchorEl}
            open={menuAnchorEl != null}
            onClose={() => { setMenuAnchorEl(null); }}
            anchorOrigin={{ vertical: "top", horizontal: "right" }}
            transformOrigin={{ vertical: "bottom", horizontal: "right" }}
            slotProps={{ paper: { sx: { maxHeight: 300, minWidth: 280 } } }}
          >
            {selectedFiles.map((f) => (
              <MenuItem
                key={f.path}
                dense
                onClick={() => {
                  setExcludedFiles((prev) => {
                    const next = new Set(prev);
                    if (next.has(f.path)) {
                      next.delete(f.path);
                    } else {
                      next.add(f.path);
                    }
                    return next;
                  });
                }}
              >
                <Checkbox
                  checked={!excludedFiles.has(f.path)}
                  size="small"
                  sx={{ mr: 1, p: 0 }}
                />
                <ListItemText
                  primary={f.filename}
                  primaryTypographyProps={{ variant: "body2", noWrap: true }}
                />
              </MenuItem>
            ))}
            {selectedFiles.length > 0 && <Divider />}
            <MenuItem
              dense
              onClick={() => {
                if (excludedFiles.size === 0) {
                  setExcludedFiles(new Set(selectedFiles.map((f) => f.path)));
                } else {
                  setExcludedFiles(new Set());
                }
              }}
            >
              <ListItemText
                primary={excludedFiles.size === 0 ? "Deselect all" : "Select all"}
                primaryTypographyProps={{ variant: "body2", fontWeight: 500 }}
              />
            </MenuItem>
          </Menu>
        </Stack>
        {effectiveFiles.length > 0 && !isDownloading && (
          <Link
            component="button"
            variant="caption"
            underline="hover"
            color="text.secondary"
            onClick={onExport}
          >
            or export as ZIP
          </Link>
        )}
      </Stack>
    </Stack>
  );

  return (
    <View footer={customFooter}>
      <Stack className={classes.container} style={{ position: "relative" }}>
        <Stack direction="row" alignItems="center" justifyContent="space-between" style={{ marginBottom: 16 }}>
          <Typography variant="h3" fontWeight={600}>
            Recordings
          </Typography>
        </Stack>

        {/* Toolbar */}
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          className={classes.toolbar}
        >
          <Stack direction="row" alignItems="center" gap={2}>
            <ToggleButton value="now" size="small" selected={false} onClick={jumpToNow}>
              Now
            </ToggleButton>

            <ToggleButtonGroup
              value={activePreset ?? false}
              exclusive
              onChange={(_e, val: ViewMode | null) => {
                if (val) {
                  const center = viewStart + viewDuration / 2;
                  const newDur = VIEW_DURATIONS[val];
                  setViewDuration(newDur);
                  setViewStart(center - newDur / 2);
                }
              }}
              size="small"
            >
              <ToggleButton value="day">Day</ToggleButton>
              <ToggleButton value="week">Week</ToggleButton>
              <ToggleButton value="month">Month</ToggleButton>
            </ToggleButtonGroup>

            <input
              type="date"
              value={dateInput}
              onChange={(e) => { handleDateJump(e.target.value); }}
              className={classes.dateInput}
            />
          </Stack>

          <Stack direction="row" alignItems="center" gap={2}>
            <Stack direction="row" gap={0.5}>
              <ToggleButton value="zoomIn" size="small" onClick={zoomIn} title="Zoom in">
                <AddIcon />
              </ToggleButton>
              <ToggleButton value="zoomOut" size="small" onClick={zoomOut} title="Zoom out">
                <RemoveIcon />
              </ToggleButton>
            </Stack>

            <Stack direction="row" gap={0.5}>
              <ToggleButton value="left" size="small" onClick={panLeft}>
                <ChevronLeftIcon />
              </ToggleButton>
              <ToggleButton value="right" size="small" onClick={panRight}>
                <ChevronRightIcon />
              </ToggleButton>
            </Stack>

            <ToggleButton
              value="refresh"
              size="small"
              selected={false}
              disabled={refreshing}
              onClick={() => { setRefreshKey((k) => k + 1); }}
              title="Refresh index"
            >
              <RefreshIcon sx={refreshing ? { animation: "spin 1s linear infinite", "@keyframes spin": { "100%": { transform: "rotate(360deg)" } } } : undefined} />
            </ToggleButton>
          </Stack>
        </Stack>

        {loading && indexProgress == undefined && (
          <Stack alignItems="center" padding={4} flex={1} justifyContent="center">
            <CircularProgress />
          </Stack>
        )}

        {indexProgress != null && indexProgress.total > 0 && loading && (
          <Stack direction="row" alignItems="center" gap={1.5} paddingBottom={1}>
            <LinearProgress
              variant="determinate"
              value={(indexProgress.indexed / indexProgress.total) * 100}
              sx={{ flex: 1, height: 6, borderRadius: 3 }}
            />
            <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: "nowrap" }}>
              Indexing {indexProgress.indexed} / {indexProgress.total} recordings
            </Typography>
          </Stack>
        )}

        {error != undefined && (
          <Typography color="error">Failed to load index: {error}</Typography>
        )}

        {!loading && error == undefined && files.length === 0 && (
          <Typography color="text.secondary">No MCAP files found on the server.</Typography>
        )}

        {/* Timeline */}
        {files.length > 0 && <div className={classes.timelineWrapper}>
          {/* Fixed header row */}
          <div className={classes.timelineHeader}>
            <div className={classes.labelHeader} style={{ width: labelWidth, minWidth: labelWidth }}>
              <Typography variant="caption" fontWeight={600} sx={{ flexGrow: 1 }}>
                Folder
              </Typography>
              <Link
                component="button"
                variant="caption"
                underline="hover"
                onClick={() => {
                  if (selectedRows.size === allFolders.size) {
                    setSelectedRows(new Set());
                  } else {
                    setSelectedRows(new Set(allFolders));
                  }
                }}
              >
                {selectedRows.size === allFolders.size ? "Deselect all" : "Select all"}
              </Link>
            </div>
            {/* Header time axis SVG */}
            <div ref={svgColumnRef} className={classes.svgColumn}>
              <svg
                width={svgWidth}
                height={HEADER_HEIGHT}
                style={{ display: "block", userSelect: "none" }}
              >
                {/* Tick labels */}
                {ticks.map((t) => {
                  const x = timeToX(t);
                  return (
                    <text
                      key={t}
                      x={x}
                      y={HEADER_HEIGHT - 14}
                      textAnchor="middle"
                      fontSize={11}
                      fill={theme.palette.text.secondary}
                      fontFamily={theme.typography.fontFamily}
                    >
                      {formatTickLabel(t, tickConfig.format)}
                    </text>
                  );
                })}
              </svg>
            </div>
          </div>

          {/* Scrollable body */}
          <div ref={wrapperRef} className={classes.timelineBody}>
            {/* Left: folder labels */}
            <div className={classes.labelColumn} style={{ width: labelWidth, minWidth: labelWidth }}>
            {hasIncidents && (
              <div
                className={classes.labelRow}
                style={{ height: INCIDENT_ROW_HEIGHT, cursor: "default" }}
              >
                <span
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    backgroundColor: "#E5484D",
                    marginRight: 8,
                    flexShrink: 0,
                    display: "inline-block",
                  }}
                />
                <Typography variant="body2" noWrap fontWeight={600}>
                  Incidents
                </Typography>
              </div>
            )}
            {folders.map(([folderName], i) => {
              const { laneCount } = folderLanes[i]!;
              const folderColor = COLORS[i % COLORS.length]!;
              const isChecked = selectedRows.has(folderName);
              return (
                <div
                  key={folderName}
                  className={classes.labelRow}
                  style={{ height: laneCount * ROW_HEIGHT, cursor: "pointer" }}
                  onClick={() => {
                    setSelectedRows((prev) => {
                      const next = new Set(prev);
                      if (next.has(folderName)) {
                        next.delete(folderName);
                      } else {
                        next.add(folderName);
                      }
                      return next;
                    });
                  }}
                >
                  <Checkbox
                    checked={isChecked}
                    size="small"
                    sx={{
                      p: 0, mr: 0.5, color: folderColor,
                      "&.Mui-checked": { color: folderColor },
                    }}
                  />
                  <Typography variant="caption" noWrap title={folderName}>
                    {folderName}
                  </Typography>
                </div>
              );
            })}
            <div
              className={classes.labelDragHandle}
              onMouseDown={(e) => {
                dragRef.current = { startX: e.clientX, startWidth: labelWidth };
                e.preventDefault();
              }}
            />
          </div>

          {/* Right: SVG timeline (body) */}
          <div className={classes.svgColumn}>
            <svg
              ref={svgRef}
              width={svgWidth}
              height={svgHeight}
              style={{ display: "block", cursor: "pointer", userSelect: "none" }}
              onClick={handleSvgClick}
              onMouseMove={handleMouseMove}
              onMouseLeave={handleMouseLeave}
            >
              {/* Incidents row background */}
              {hasIncidents && (
                <rect
                  x={0}
                  y={0}
                  width={svgWidth}
                  height={INCIDENT_ROW_HEIGHT}
                  fill={theme.palette.action.hover}
                />
              )}

              {/* Row backgrounds */}
              {folders.map(([folderName], i) => {
                const { laneCount } = folderLanes[i]!;
                return (
                  <rect
                    key={folderName}
                    x={0}
                    y={incidentRowOffset + folderYOffsets[i]!}
                    width={svgWidth}
                    height={laneCount * ROW_HEIGHT}
                    fill={i % 2 === 0 ? "transparent" : theme.palette.action.hover}
                  />
                );
              })}

              {/* Incidents row divider */}
              {hasIncidents && (
                <line
                  x1={0}
                  y1={INCIDENT_ROW_HEIGHT}
                  x2={svgWidth}
                  y2={INCIDENT_ROW_HEIGHT}
                  stroke={theme.palette.divider}
                  strokeWidth={1}
                />
              )}

              {/* Row dividers */}
              {folders.map(([folderName], i) => {
                const divY = incidentRowOffset + folderYOffsets[i]! + folderLanes[i]!.laneCount * ROW_HEIGHT;
                return (
                  <line
                    key={`div-${folderName}`}
                    x1={0}
                    y1={divY}
                    x2={svgWidth}
                    y2={divY}
                    stroke={theme.palette.divider}
                    strokeWidth={1}
                  />
                );
              })}

              {/* Tick grid lines */}
              {ticks.map((t) => {
                const x = timeToX(t);
                return (
                  <line
                    key={t}
                    x1={x}
                    y1={0}
                    x2={x}
                    y2={svgHeight}
                    stroke={theme.palette.divider}
                    strokeWidth={1}
                    strokeDasharray="2,2"
                  />
                );
              })}

              {/* File bars */}
              {visibleBars.map((bar) => {
                const isFileSelected = selectedPaths.has(bar.file.path);
                return (
                  <rect
                    key={bar.file.path}
                    x={bar.x}
                    y={bar.y}
                    width={bar.width}
                    height={BAR_HEIGHT}
                    rx={3}
                    ry={3}
                    fill={bar.color}
                    opacity={isFileSelected ? 1 : 0.7}
                    stroke={isFileSelected ? theme.palette.common.white : "none"}
                    strokeWidth={isFileSelected ? 2 : 0}
                  />
                );
              })}

              {/* Incident markers */}
              {hasIncidents &&
                incidentMarkers.map((inc, idx) => {
                  const ix = timeToX(inc.timeSec);
                  if (ix < -20 || ix > svgWidth + 20) {
                    return null;
                  }
                  const isCurrent =
                    urlParams.centerTime != null &&
                    Math.abs(inc.timeSec - urlParams.centerTime) < 1;
                  const color = SEVERITY_COLORS[inc.severity ?? "info"] ?? SEVERITY_COLORS.info!;
                  const r = isCurrent ? 7 : 5;
                  const cy = INCIDENT_ROW_HEIGHT / 2;
                  return (
                    <g key={`inc-${idx}`}>
                      {isCurrent && (
                        <circle
                          cx={ix}
                          cy={cy}
                          r={12}
                          fill={color}
                          opacity={0.2}
                        />
                      )}
                      <circle
                        cx={ix}
                        cy={cy}
                        r={r}
                        fill={color}
                        stroke={isCurrent ? theme.palette.common.white : "none"}
                        strokeWidth={isCurrent ? 2 : 0}
                      />
                    </g>
                  );
                })}

              {/* "Now" marker line */}
              {(() => {
                const nowX = timeToX(Date.now() / 1000);
                if (nowX < 0 || nowX > svgWidth) {
                  return null;
                }
                return (
                  <line
                    x1={nowX}
                    y1={0}
                    x2={nowX}
                    y2={svgHeight}
                    stroke="#E5484D"
                    strokeWidth={1.5}
                    style={{ pointerEvents: "none" }}
                  />
                );
              })()}

              {/* Selection overlay */}
              {selectionRange && (
                <rect
                  x={timeToX(selectionRange.start)}
                  y={incidentRowOffset}
                  width={timeToX(selectionRange.end) - timeToX(selectionRange.start)}
                  height={svgHeight - incidentRowOffset}
                  fill={theme.palette.primary.main}
                  opacity={0.15}
                  stroke={theme.palette.primary.main}
                  strokeWidth={1}
                  strokeDasharray="4,2"
                  style={{ pointerEvents: "none" }}
                />
              )}
            </svg>
          </div>

          {/* Single hover tooltip */}
          {tooltipState && (
            <div
              className={classes.tooltip}
              style={{ left: tooltipState.x, top: tooltipState.y }}
            >
              {tooltipState.file && (
                <>
                  <strong>{tooltipState.file.filename}</strong>
                  <br />
                  {new Date(tooltipState.file.startTime * 1000).toLocaleString()} —{" "}
                  {new Date(tooltipState.file.endTime * 1000).toLocaleString()}
                  <br />
                  {formatFileSize(tooltipState.file.size)}
                </>
              )}
              {tooltipState.incident && (
                <>
                  <strong>{tooltipState.incident.summary ?? tooltipState.incident.dedup_key ?? "Incident"}</strong>
                  <br />
                  {new Date(tooltipState.incident.time).toLocaleString()}
                  {tooltipState.incident.severity && (
                    <>
                      {" · "}
                      <span style={{ color: SEVERITY_COLORS[tooltipState.incident.severity] }}>
                        {tooltipState.incident.severity}
                      </span>
                    </>
                  )}
                  {tooltipState.incident.source && (
                    <>
                      <br />
                      Source: {tooltipState.incident.source}
                    </>
                  )}
                </>
              )}
            </div>
          )}

          {/* Download progress overlay */}
          {downloadProgress && (
            <div className={classes.downloadOverlay}>
              <Typography variant="h5" fontWeight={600}>
                Downloading recordings
              </Typography>
              <Typography variant="body2" color="text.secondary">
                {downloadProgress.fileIndex} of {downloadProgress.totalFiles} files complete
              </Typography>
              <LinearProgress
                variant="determinate"
                value={
                  downloadProgress.grandTotal > 0
                    ? (downloadProgress.completedBytes / downloadProgress.grandTotal) * 100
                    : 0
                }
                sx={{ width: "100%", maxWidth: 400, height: 8, borderRadius: 4 }}
              />
              <Typography variant="body2" color="text.secondary">
                {formatFileSize(downloadProgress.completedBytes)}
                {" / "}
                {formatFileSize(downloadProgress.grandTotal)}
                {(() => {
                  const elapsed = (Date.now() - downloadStartRef.current) / 1000;
                  if (elapsed < 0.5 || downloadProgress.completedBytes === 0) {
                    return null;
                  }
                  const bytesPerSec = downloadProgress.completedBytes / elapsed;
                  return ` · ${formatFileSize(bytesPerSec)}/s`;
                })()}
              </Typography>
            </div>
          )}
        </div>
        </div>}

        {/* Selection info */}
        {effectiveFiles.length > 0 && !isDownloading && (
          <Stack direction="row" alignItems="center" gap={2} className={classes.selectionInfo}>
            <Typography variant="body2" color="text.secondary">
              {effectiveFiles.length} file{effectiveFiles.length !== 1 ? "s" : ""} selected
              {" · "}
              {formatFileSize(totalSize)}
              {selectionRange && (
                <>
                  {" · "}
                  {new Date(selectionRange.start * 1000).toLocaleString()} —{" "}
                  {new Date(selectionRange.end * 1000).toLocaleString()}
                </>
              )}
            </Typography>
            {totalSize > 1024 * 1024 * 1024 && (
              <Typography variant="body2" color="warning.main" fontWeight={600}>
                Warning: Large selection — loading may be slow
              </Typography>
            )}
          </Stack>
        )}

        {/* Duration control */}
        {selCenter != undefined && !isDownloading && (
          <Stack direction="row" alignItems="center" gap={0.5} className={classes.selectionInfo}>
            <Typography variant="body2" color="text.secondary">
              Duration
            </Typography>
            <IconButton
              size="small"
              onClick={() => { setSelectionSpanMin((v) => Math.max(1, v - 1)); }}
            >
              <RemoveIcon fontSize="small" />
            </IconButton>
            <TextField
              size="small"
              type="number"
              value={selectionSpanMin}
              onChange={(e) => {
                const v = Math.max(1, Math.min(1440, Number(e.target.value) || 1));
                setSelectionSpanMin(v);
              }}
              inputProps={{ min: 1, max: 1440, style: { textAlign: "center", padding: "2px 4px", width: 40 } }}
            />
            <IconButton
              size="small"
              onClick={() => { setSelectionSpanMin((v) => Math.min(1440, v + 1)); }}
            >
              <AddIcon fontSize="small" />
            </IconButton>
            <Typography variant="body2" color="text.secondary">
              min
            </Typography>
          </Stack>
        )}
      </Stack>
    </View>
  );
}
