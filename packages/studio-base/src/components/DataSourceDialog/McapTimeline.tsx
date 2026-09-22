// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import AddIcon from "@mui/icons-material/Add";
import ArrowDropDownIcon from "@mui/icons-material/ArrowDropDown";
import ChevronLeftIcon from "@mui/icons-material/ChevronLeft";
import ChevronRightIcon from "@mui/icons-material/ChevronRight";
import CloseIcon from "@mui/icons-material/Close";
import RefreshIcon from "@mui/icons-material/Refresh";
import RemoveIcon from "@mui/icons-material/Remove";
import {
  Autocomplete,
  Button,
  ButtonGroup,
  Checkbox,
  Chip,
  CircularProgress,
  Divider,
  IconButton,
  LinearProgress,
  Link,
  ListItemText,
  Menu,
  MenuItem,
  Popover,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Typography,
} from "@mui/material";
import { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { makeStyles } from "tss-react/mui";

import Stack from "@foxglove/studio-base/components/Stack";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import { useWorkspaceActions } from "@foxglove/studio-base/context/Workspace/useWorkspaceActions";
import { getApiBase, mcapArchiveUrl, mcapFileUrl } from "@foxglove/studio-base/util/serverConfig";

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

type ParsedSparklinePath = { topic: string; field: string };

function parseUrlParams(): {
  centerTime?: number;
  incidents: Incident[];
  sparklinePaths: ParsedSparklinePath[];
} {
  if (typeof window === "undefined") {
    return { incidents: [], sparklinePaths: [] };
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

  // Parse sparklines param: comma-separated message paths like /topic.field
  const sparklinePaths: ParsedSparklinePath[] = [];
  const splParam = params.get("sparklines");
  if (splParam) {
    for (const raw of splParam.split(",")) {
      const path = raw.trim().replace(/^\//, ""); // strip leading /
      const dotIdx = path.indexOf(".");
      if (dotIdx > 0 && dotIdx < path.length - 1) {
        sparklinePaths.push({
          topic: path.slice(0, dotIdx),
          field: path.slice(dotIdx + 1),
        });
      }
    }
  }

  return {
    centerTime: centerTime != undefined && !isNaN(centerTime) ? centerTime : undefined,
    incidents,
    sparklinePaths,
  };
}

type ViewMode = "day" | "week" | "month";

type SparklineField = { topic: string; field: string; type: string };

/** Merge new segments into existing ones, deduplicating by file and sorting by timestamp. */
function mergeSegments(
  existing: SparklineSegment[],
  incoming: SparklineSegment[],
): SparklineSegment[] {
  const byFile = new Map<string, { timestamps: number[]; values: number[] }>();
  // Error segments (file unreadable / still recording) survive only while no
  // real data exists for that file.
  const errorsByFile = new Map<string, SparklineSegment>();
  for (const seg of [...existing, ...incoming]) {
    if (seg.error != undefined && (seg.timestamps?.length ?? 0) === 0) {
      errorsByFile.set(seg.file, seg);
      continue;
    }
    const ts = seg.timestamps ?? [];
    const vals = seg.values ?? [];
    const entry = byFile.get(seg.file);
    if (entry) {
      entry.timestamps.push(...ts);
      entry.values.push(...vals);
    } else {
      byFile.set(seg.file, { timestamps: [...ts], values: [...vals] });
    }
  }
  const result: SparklineSegment[] = [];
  for (const [file, { timestamps, values }] of byFile) {
    // Deduplicate and sort by timestamp
    const indices = Array.from(timestamps.keys()).sort((a, b) => timestamps[a]! - timestamps[b]!);
    const dedupTs: number[] = [];
    const dedupVals: number[] = [];
    let lastT = -Infinity;
    for (const i of indices) {
      if (timestamps[i]! > lastT) {
        dedupTs.push(timestamps[i]!);
        dedupVals.push(values[i]!);
        lastT = timestamps[i]!;
      }
    }
    result.push({ file, timestamps: dedupTs, values: dedupVals });
  }
  for (const [file, seg] of errorsByFile) {
    if (!byFile.has(file)) {
      result.push(seg);
    }
  }
  result.sort(
    (a, b) => (a.timestamps?.[0] ?? a.startTime ?? 0) - (b.timestamps?.[0] ?? b.startTime ?? 0),
  );
  return result;
}
type SparklineSegment = {
  file: string;
  timestamps?: number[];
  values?: number[];
  /** Present (with startTime/endTime) when the server could not read the file. */
  error?: string;
  startTime?: number;
  endTime?: number;
};

const ROW_HEIGHT = 20;
const SPARKLINE_ROW_HEIGHT = 20;
const HEADER_HEIGHT = 40;
const DEFAULT_LABEL_WIDTH = 180;
const MIN_LABEL_WIDTH = 80;
const BAR_HEIGHT = 10;
const BAR_Y_OFFSET = (ROW_HEIGHT - BAR_HEIGHT) / 2;
const MIN_BAR_WIDTH = 4;
const DEFAULT_SELECTION_SPAN_MIN = 5;
const SPARKLINE_STORAGE_KEY = "mcapTimeline.sparklines";

const VIEW_DURATIONS: Record<ViewMode, number> = {
  day: 24 * 3600,
  week: 7 * 24 * 3600,
  month: 30 * 24 * 3600,
};

const NOW_DURATION = 3600; // 1 hour

// Adaptive tick intervals based on visible duration
const TICK_LEVELS = [
  { maxDuration: 600, interval: 60, format: "time" }, // < 10min → every minute
  { maxDuration: 3600, interval: 300, format: "time" }, // < 1h → every 5 min
  { maxDuration: 6 * 3600, interval: 1800, format: "time" }, // < 6h → every 30 min
  { maxDuration: 2 * 86400, interval: 3600, format: "time" }, // < 2d → every hour
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

  const apiBase = useMemo(() => getApiBase(), []);

  const [files, setFiles] = useState<McapFileIndex[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [indexProgress, setIndexProgress] = useState<
    { indexed: number; total: number } | undefined
  >();
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
    return stored != undefined ? Math.max(MIN_LABEL_WIDTH, Number(stored)) : DEFAULT_LABEL_WIDTH;
  });
  const labelWidthRef = useRef(labelWidth);
  labelWidthRef.current = labelWidth;
  const dragRef = useRef<{ startX: number; startWidth: number } | ReactNull>(ReactNull);
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!dragRef.current) {
        return;
      }
      const delta = e.clientX - dragRef.current.startX;
      setLabelWidth(Math.max(MIN_LABEL_WIDTH, dragRef.current.startWidth + delta));
    };
    const onMouseUp = () => {
      if (dragRef.current) {
        localStorage.setItem(LABEL_WIDTH_KEY, String(labelWidthRef.current));
      }
      dragRef.current = ReactNull;
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
  const svgRef = useRef<SVGSVGElement>(ReactNull);
  const wrapperRef = useRef<HTMLDivElement>(ReactNull);
  const svgColumnRef = useRef<HTMLDivElement>(ReactNull);
  const [svgColumnWidth, setSvgColumnWidth] = useState(0);

  // Sparkline state
  const [sparklineConfigs, setSparklineConfigs] = useState<Map<string, SparklineField[]>>(() => {
    try {
      const stored = localStorage.getItem(SPARKLINE_STORAGE_KEY);
      if (stored) {
        return new Map(JSON.parse(stored) as [string, SparklineField[]][]);
      }
    } catch {
      /* ignore */
    }
    return new Map();
  });
  const [sparklineData, setSparklineData] = useState<Map<string, SparklineSegment[]>>(new Map());
  const [sparklinePopover, setSparklinePopover] = useState<
    | {
        anchorEl: HTMLElement;
        folder: string;
      }
    | ReactNull
  >(ReactNull);
  const [sparklineFields, setSparklineFields] = useState<
    { topic: string; field: string; type: string }[]
  >([]);
  const [sparklineFieldsLoading, setSparklineFieldsLoading] = useState(false);

  // Persist sparkline configs
  useEffect(() => {
    const serialized = JSON.stringify([...sparklineConfigs]);
    if (serialized != undefined) {
      localStorage.setItem(SPARKLINE_STORAGE_KEY, serialized);
    }
  }, [sparklineConfigs]);

  // Fetch field list when popover opens
  useEffect(() => {
    if (!sparklinePopover) {
      return;
    }
    const controller = new AbortController();
    setSparklineFieldsLoading(true);
    setSparklineFields([]);
    const folder = sparklinePopover.folder === "(root)" ? "." : sparklinePopover.folder;
    fetch(`${apiBase}/api/mcap/fields?folder=${encodeURIComponent(folder)}&plottable=true`, {
      signal: controller.signal,
    })
      .then(async (r) => await r.json())
      .then((data: { topic: string; field: string; type: string }[]) => {
        setSparklineFields(data);
        setSparklineFieldsLoading(false);
      })
      .catch((err) => {
        if ((err as Error).name !== "AbortError") {
          setSparklineFieldsLoading(false);
        }
      });
    return () => {
      controller.abort();
    };
  }, [sparklinePopover, apiBase]);

  // Track fetched time ranges per sparkline key to avoid redundant requests
  const sparklineFetchedRanges = useRef<Map<string, { start: number; end: number }[]>>(new Map());

  // Fetch sparkline sample data (debounced on viewport change), merging into cache
  useEffect(() => {
    if (sparklineConfigs.size === 0) {
      return;
    }
    const controller = new AbortController();
    const viewEnd = viewStart + viewDuration;
    const timer = setTimeout(() => {
      for (const [folder, fields] of sparklineConfigs) {
        const folderParam = folder === "(root)" ? "." : folder;
        for (const { topic, field } of fields) {
          const key = `${folder}/${topic}/${field}`;
          // Check if this viewport is already covered by a previous fetch
          const ranges = sparklineFetchedRanges.current.get(key) ?? [];
          const alreadyCovered = ranges.some((r) => r.start <= viewStart && r.end >= viewEnd);
          if (alreadyCovered) {
            continue;
          }
          fetch(
            `${apiBase}/api/mcap/sample?folder=${encodeURIComponent(
              folderParam,
            )}&topic=${encodeURIComponent(topic)}&field=${encodeURIComponent(
              field,
            )}&start=${viewStart}&end=${viewEnd}&maxPoints=500&decimation=10`,
            { signal: controller.signal },
          )
            .then(async (r) => await r.json())
            .then((data: { segments: SparklineSegment[] }) => {
              // Record this fetched range
              const prev = sparklineFetchedRanges.current.get(key) ?? [];
              sparklineFetchedRanges.current.set(key, [
                ...prev,
                { start: viewStart, end: viewEnd },
              ]);
              // Merge new segments into existing data
              setSparklineData((prevData) => {
                const next = new Map(prevData);
                const existing = next.get(key) ?? [];
                const merged = mergeSegments(existing, data.segments);
                next.set(key, merged);
                return next;
              });
            })
            .catch(() => {
              /* ignore aborts */
            });
        }
      }
    }, 400);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [sparklineConfigs, viewStart, viewDuration, apiBase]);

  // Hover tooltip state
  const [tooltipState, setTooltipState] = useState<
    | {
        file?: McapFileIndex;
        incident?: Incident & { timeSec: number };
        sparkline?: { topic: string; field: string; time: number; value: number; type: string };
        x: number;
        y: number;
      }
    | ReactNull
  >(ReactNull);

  // Open button dropdown state
  const [menuAnchorEl, setMenuAnchorEl] = useState<HTMLElement | ReactNull>(ReactNull);
  const [excludedFiles, setExcludedFiles] = useState<Set<string>>(new Set());

  // URL-driven incidents
  const urlParams = useMemo(() => parseUrlParams(), []);
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
    return () => {
      ro.disconnect();
    };
  }, [timelineVisible]);

  // Download state

  // Fetch index from server (streaming NDJSON)
  useEffect(() => {
    const isRefresh = refreshKey > 0;
    const controller = new AbortController();
    setError(undefined);
    if (isRefresh) {
      // Keep the current timeline on screen; the progress bar still shows.
      setRefreshing(true);
      setIndexProgress(undefined);
    } else {
      setLoading(true);
      setIndexProgress(undefined);
      setFiles([]);
    }

    void (async () => {
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
                setIndexProgress({ indexed: 0, total: msg.total as number });
              } else if ("file" in msg) {
                accumulated.push(msg.file as McapFileIndex);
                indexed++;
                if (indexed % 10 === 0) {
                  // Progressively reveal files on initial load only — a
                  // refresh keeps the existing timeline until the swap below.
                  if (!isRefresh) {
                    setFiles([...accumulated]);
                  }
                  const indexedNow = indexed;
                  setIndexProgress((prev) => (prev ? { ...prev, indexed: indexedNow } : undefined));
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

    return () => {
      controller.abort();
    };
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

  // Apply URL sparklines when folders become available
  const urlSparklineApplied = useRef(false);
  useEffect(() => {
    if (
      urlSparklineApplied.current ||
      urlParams.sparklinePaths.length === 0 ||
      folders.length === 0
    ) {
      return;
    }
    urlSparklineApplied.current = true;
    setSparklineConfigs((prev) => {
      const next = new Map(prev);
      for (const [folderName] of folders) {
        const existing = next.get(folderName) ?? [];
        for (const { topic, field } of urlParams.sparklinePaths) {
          if (!existing.some((s) => s.topic === topic && s.field === field)) {
            existing.push({ topic, field, type: "number" });
          }
        }
        if (existing.length > 0) {
          next.set(folderName, existing);
        }
      }
      return next;
    });
  }, [folders, urlParams.sparklinePaths]);

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

    if (urlParams.centerTime != undefined) {
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
  }, [files, urlParams.centerTime, selectionSpan]);

  // Compute lane assignments per folder (for parallel recordings)
  const folderLanes = useMemo(() => {
    return folders.map(([, folderFiles]) => assignLanes(folderFiles));
  }, [folders]);

  // Per-folder sparkline count
  const folderSparklineCounts = useMemo(() => {
    return folders.map(([folderName]) => sparklineConfigs.get(folderName)?.length ?? 0);
  }, [folders, sparklineConfigs]);

  // Cumulative Y offset per folder (each folder may have multiple lanes + sparklines)
  const folderYOffsets = useMemo(() => {
    const offsets: number[] = [];
    let y = 0;
    for (let i = 0; i < folderLanes.length; i++) {
      offsets.push(y);
      y +=
        folderLanes[i]!.laneCount * ROW_HEIGHT + folderSparklineCounts[i]! * SPARKLINE_ROW_HEIGHT;
    }
    return offsets;
  }, [folderLanes, folderSparklineCounts]);

  const totalRowsHeight =
    folderYOffsets.length > 0
      ? folderYOffsets[folderYOffsets.length - 1]! +
        folderLanes[folderLanes.length - 1]!.laneCount * ROW_HEIGHT +
        folderSparklineCounts[folderSparklineCounts.length - 1]! * SPARKLINE_ROW_HEIGHT
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
  }, [
    folders,
    folderLanes,
    folderYOffsets,
    viewStart,
    viewEnd,
    timeToX,
    svgWidth,
    incidentRowOffset,
  ]);

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
  }, [viewStart, viewDuration, maxDuration]);

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
        setTooltipState(ReactNull);
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
        return;
      }

      // Check sparkline regions
      const hoverTime = viewStart + (mx / svgWidth) * viewDuration;
      for (let fi = 0; fi < folders.length; fi++) {
        const [folderName] = folders[fi]!;
        const sparklines = sparklineConfigs.get(folderName) ?? [];
        if (sparklines.length === 0) {
          continue;
        }
        const { laneCount } = folderLanes[fi]!;
        const sparkBaseY = incidentRowOffset + folderYOffsets[fi]! + laneCount * ROW_HEIGHT;
        for (let si = 0; si < sparklines.length; si++) {
          const rowY = sparkBaseY + si * SPARKLINE_ROW_HEIGHT;
          if (my >= rowY && my <= rowY + SPARKLINE_ROW_HEIGHT) {
            const { topic, field, type } = sparklines[si]!;
            const dataKey = `${folderName}/${topic}/${field}`;
            const segments = sparklineData.get(dataKey) ?? [];
            // Find nearest data point across all segments
            let nearest: { time: number; value: number } | undefined;
            let bestDist = Infinity;
            for (const seg of segments) {
              const segTs = seg.timestamps ?? [];
              const segVals = seg.values ?? [];
              for (let j = 0; j < segTs.length; j++) {
                const dist = Math.abs(segTs[j]! - hoverTime);
                if (dist < bestDist) {
                  bestDist = dist;
                  nearest = { time: segTs[j]!, value: segVals[j]! };
                }
              }
            }
            if (nearest) {
              setTooltipState({
                sparkline: { topic, field, time: nearest.time, value: nearest.value, type },
                x: e.clientX - wrapperRect.left + 12,
                y: e.clientY - wrapperRect.top + scrollTop - 10,
              });
              return;
            }
          }
        }
      }

      setTooltipState(ReactNull);
    },
    [
      visibleBars,
      hasIncidents,
      incidentMarkers,
      timeToX,
      folders,
      folderLanes,
      folderYOffsets,
      sparklineConfigs,
      sparklineData,
      viewStart,
      viewDuration,
      svgWidth,
      incidentRowOffset,
    ],
  );

  const handleMouseLeave = useCallback(() => {
    setTooltipState(ReactNull);
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

  // Open the selected recordings straight from the server.
  //
  // The player reads them by byte range (HTTP Range), so playback starts at
  // once instead of after every selected file has been transferred.
  const onOpen = useCallback(() => {
    if (effectiveFiles.length === 0) {
      return;
    }
    const urls = effectiveFiles.map((file) => mcapFileUrl(file.path));
    selectSource("mcap-server", {
      type: "connection",
      params: { urls: JSON.stringify(urls) },
    });
    dialogActions.dataSource.close();
  }, [dialogActions.dataSource, effectiveFiles, selectSource]);

  // Export the selected recordings as one zip, built and streamed by the
  // server.
  //
  // Studio no longer holds these recordings: the player reads them by byte
  // range. Zipping in the page would mean fetching every one of them first,
  // which is the whole transfer that reading by range exists to avoid. The
  // server has them on disk already, so it writes the archive and the browser
  // owns the download, with its own progress and its own cancel.
  const onExport = useCallback(() => {
    if (effectiveFiles.length === 0) {
      return;
    }
    const a = document.createElement("a");
    a.href = mcapArchiveUrl(effectiveFiles.map((file) => file.path));
    a.download = ""; // let the server's Content-Disposition name the archive
    document.body.appendChild(a);
    a.click();
    a.remove();
  }, [effectiveFiles]);

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
        onClick={() => {
          dialogActions.dataSource.open("start");
        }}
      >
        Back
      </Button>

      <Stack direction="column" alignItems="flex-end" gap={0.5}>
        <Stack direction="row" gap={2} alignItems="center">
          <Button
            color="inherit"
            variant="outlined"
            onClick={() => {
              dialogActions.dataSource.close();
            }}
          >
            Cancel
          </Button>
          <ButtonGroup variant="contained">
            <Button onClick={onOpen} disabled={effectiveFiles.length === 0}>
              Open{effectiveFiles.length > 0 ? ` (${effectiveFiles.length})` : ""}
            </Button>
            <Button
              size="small"
              disabled={selectedFiles.length === 0}
              onClick={(e) => {
                setMenuAnchorEl(e.currentTarget);
              }}
              sx={{ px: 0.5, minWidth: 0 }}
            >
              <ArrowDropDownIcon />
            </Button>
          </ButtonGroup>
          <Menu
            anchorEl={menuAnchorEl}
            open={menuAnchorEl != undefined}
            onClose={() => {
              setMenuAnchorEl(ReactNull);
            }}
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
                <Checkbox checked={!excludedFiles.has(f.path)} size="small" sx={{ mr: 1, p: 0 }} />
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
        {effectiveFiles.length > 0 && (
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
        <Stack
          direction="row"
          alignItems="center"
          justifyContent="space-between"
          style={{ marginBottom: 16 }}
        >
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
              onChange={(_e, val: ViewMode | ReactNull) => {
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
              onChange={(e) => {
                handleDateJump(e.target.value);
              }}
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
              onClick={() => {
                setRefreshKey((k) => k + 1);
              }}
              title="Refresh index"
            >
              <RefreshIcon
                sx={
                  refreshing
                    ? {
                        animation: "spin 1s linear infinite",
                        "@keyframes spin": { "100%": { transform: "rotate(360deg)" } },
                      }
                    : undefined
                }
              />
            </ToggleButton>
          </Stack>
        </Stack>

        {loading && indexProgress == undefined && (
          <Stack alignItems="center" padding={4} flex={1} justifyContent="center">
            <CircularProgress />
          </Stack>
        )}

        {indexProgress != undefined && indexProgress.total > 0 && (loading || refreshing) && (
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

        {error != undefined && <Typography color="error">Failed to load index: {error}</Typography>}

        {!loading && error == undefined && files.length === 0 && (
          <Typography color="text.secondary">No MCAP files found on the server.</Typography>
        )}

        {/* Timeline */}
        {files.length > 0 && (
          <div className={classes.timelineWrapper}>
            {/* Fixed header row */}
            <div className={classes.timelineHeader}>
              <div
                className={classes.labelHeader}
                style={{ width: labelWidth, minWidth: labelWidth }}
              >
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
              <div
                className={classes.labelColumn}
                style={{ width: labelWidth, minWidth: labelWidth }}
              >
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
                  const sparklines = sparklineConfigs.get(folderName) ?? [];
                  return (
                    <div key={folderName}>
                      <div
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
                            p: 0,
                            mr: 0.5,
                            color: folderColor,
                            "&.Mui-checked": { color: folderColor },
                          }}
                        />
                        <Typography
                          variant="caption"
                          noWrap
                          title={folderName}
                          sx={{ flexGrow: 1 }}
                        >
                          {folderName}
                        </Typography>
                        <IconButton
                          size="small"
                          sx={{ p: 0, ml: 0.25, opacity: 0.6, "&:hover": { opacity: 1 } }}
                          onClick={(e) => {
                            e.stopPropagation();
                            // Anchor to the parent folder row div, not the tiny icon
                            const row = (e.currentTarget as HTMLElement).parentElement;
                            setSparklinePopover({
                              anchorEl: row ?? e.currentTarget,
                              folder: folderName,
                            });
                          }}
                          title="Add sparkline"
                        >
                          <AddIcon sx={{ fontSize: 14 }} />
                        </IconButton>
                      </div>
                      {/* Sparkline labels */}
                      {sparklines.map(({ topic, field }) => {
                        const dataKey = `${folderName}/${topic}/${field}`;
                        const hasData = sparklineData.has(dataKey);
                        return (
                          <div
                            key={`${topic}/${field}`}
                            className={classes.labelRow}
                            style={{
                              height: SPARKLINE_ROW_HEIGHT,
                              paddingLeft: 20,
                              cursor: "default",
                            }}
                          >
                            {!hasData && (
                              <CircularProgress size={10} sx={{ mr: 0.5, flexShrink: 0 }} />
                            )}
                            <Tooltip
                              title={`${topic}.${field} — downsampled preview (1 in 10 messages)`}
                              placement="right"
                            >
                              <Typography
                                variant="caption"
                                noWrap
                                sx={{ fontSize: 9, opacity: 0.7, flexGrow: 1, color: folderColor }}
                              >
                                <span style={{ opacity: 0.5 }}>{topic}.</span>
                                {field}
                              </Typography>
                            </Tooltip>
                            <IconButton
                              size="small"
                              sx={{ p: 0, opacity: 0.4, "&:hover": { opacity: 1 } }}
                              onClick={() => {
                                setSparklineConfigs((prev) => {
                                  const next = new Map(prev);
                                  const list = (next.get(folderName) ?? []).filter(
                                    (s) => !(s.topic === topic && s.field === field),
                                  );
                                  if (list.length === 0) {
                                    next.delete(folderName);
                                  } else {
                                    next.set(folderName, list);
                                  }
                                  return next;
                                });
                              }}
                              title="Remove sparkline"
                            >
                              <CloseIcon sx={{ fontSize: 10 }} />
                            </IconButton>
                          </div>
                        );
                      })}
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
                    const sparkCount = folderSparklineCounts[i]!;
                    const totalH = laneCount * ROW_HEIGHT + sparkCount * SPARKLINE_ROW_HEIGHT;
                    return (
                      <rect
                        key={folderName}
                        x={0}
                        y={incidentRowOffset + folderYOffsets[i]!}
                        width={svgWidth}
                        height={totalH}
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
                    const divY =
                      incidentRowOffset +
                      folderYOffsets[i]! +
                      folderLanes[i]!.laneCount * ROW_HEIGHT +
                      folderSparklineCounts[i]! * SPARKLINE_ROW_HEIGHT;
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

                  {/* Sparklines */}
                  {folders.map(([folderName], folderIdx) => {
                    const sparklines = sparklineConfigs.get(folderName) ?? [];
                    if (sparklines.length === 0) {
                      return ReactNull;
                    }
                    const { laneCount } = folderLanes[folderIdx]!;
                    const folderColor = COLORS[folderIdx % COLORS.length]!;
                    const sparkBaseY =
                      incidentRowOffset + folderYOffsets[folderIdx]! + laneCount * ROW_HEIGHT;

                    return sparklines.map(({ topic, field, type }, sparkIdx) => {
                      const key = `${folderName}/${topic}/${field}`;
                      const segments = sparklineData.get(key) ?? [];
                      const rowY = sparkBaseY + sparkIdx * SPARKLINE_ROW_HEIGHT;
                      const rowH = SPARKLINE_ROW_HEIGHT - 2; // 1px margin top/bottom

                      const errorSegments = segments.filter((s) => s.error != undefined);
                      // Compute Y range across all segments for auto-scaling
                      let minVal = Infinity;
                      let maxVal = -Infinity;
                      for (const seg of segments) {
                        for (const v of seg.values ?? []) {
                          if (v < minVal) {
                            minVal = v;
                          }
                          if (v > maxVal) {
                            maxVal = v;
                          }
                        }
                      }
                      if (!isFinite(minVal) && errorSegments.length === 0) {
                        return ReactNull;
                      }
                      // For boolean signals, force 0-1 range
                      if (type === "boolean") {
                        minVal = 0;
                        maxVal = 1;
                      }
                      const valSpan = maxVal - minVal;
                      const valRange = valSpan === 0 ? 1 : valSpan;

                      return (
                        <g key={`sparkline-${key}`}>
                          {/* Sparkline background */}
                          <rect
                            x={0}
                            y={rowY}
                            width={svgWidth}
                            height={SPARKLINE_ROW_HEIGHT}
                            fill="transparent"
                          />
                          {/* Unreadable/still-recording files: grey region instead
                          of a silent gap, with the reason as native tooltip. */}
                          {errorSegments.map((seg) => {
                            const x1 = timeToX(seg.startTime ?? 0);
                            const x2 = timeToX(seg.endTime ?? 0);
                            if (x2 < 0 || x1 > svgWidth) {
                              return ReactNull;
                            }
                            return (
                              <rect
                                key={`sparkline-error-${key}-${seg.file}`}
                                x={Math.max(x1, 0)}
                                y={rowY + 1}
                                width={Math.max(Math.min(x2, svgWidth) - Math.max(x1, 0), 2)}
                                height={rowH}
                                fill="currentColor"
                                opacity={0.15}
                              >
                                <title>{`${seg.file}: ${seg.error ?? "unreadable"}`}</title>
                              </rect>
                            );
                          })}
                          {(() => {
                            // Flatten all segments into one continuous polyline
                            const allPoints: string[] = [];
                            let prevVal: number | undefined;
                            for (const seg of segments) {
                              const segTs = seg.timestamps ?? [];
                              const segVals = seg.values ?? [];
                              for (let j = 0; j < segTs.length; j++) {
                                const x = timeToX(segTs[j]!);
                                const yVal =
                                  rowY + 1 + (1 - (segVals[j]! - minVal) / valRange) * rowH;
                                if (type === "boolean" && prevVal != undefined) {
                                  // Step function: horizontal line at previous y to current x
                                  const prevY =
                                    rowY + 1 + (1 - (prevVal - minVal) / valRange) * rowH;
                                  allPoints.push(`${x},${prevY}`);
                                }
                                allPoints.push(`${x},${yVal}`);
                                prevVal = segVals[j]!;
                              }
                            }
                            if (allPoints.length === 0) {
                              return ReactNull;
                            }
                            return (
                              <polyline
                                points={allPoints.join(" ")}
                                fill="none"
                                stroke={folderColor}
                                strokeWidth={type === "boolean" ? 1.5 : 1}
                                opacity={type === "boolean" ? 0.8 : 0.7}
                                style={{ pointerEvents: "none" }}
                              />
                            );
                          })()}
                        </g>
                      );
                    });
                  })}

                  {/* Incident markers */}
                  {hasIncidents &&
                    incidentMarkers.map((inc, idx) => {
                      const ix = timeToX(inc.timeSec);
                      if (ix < -20 || ix > svgWidth + 20) {
                        return ReactNull;
                      }
                      const isCurrent =
                        urlParams.centerTime != undefined &&
                        Math.abs(inc.timeSec - urlParams.centerTime) < 1;
                      const color =
                        SEVERITY_COLORS[inc.severity ?? "info"] ?? SEVERITY_COLORS.info!;
                      const r = isCurrent ? 7 : 5;
                      const cy = INCIDENT_ROW_HEIGHT / 2;
                      return (
                        <g key={`inc-${idx}`}>
                          {isCurrent && (
                            <circle cx={ix} cy={cy} r={12} fill={color} opacity={0.2} />
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
                      return ReactNull;
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

              {/* Sparkline field picker popover */}
              {sparklinePopover && (
                <Popover
                  open
                  anchorEl={sparklinePopover.anchorEl}
                  onClose={() => {
                    setSparklinePopover(ReactNull);
                  }}
                  anchorOrigin={{ vertical: "bottom", horizontal: "left" }}
                  transformOrigin={{ vertical: "top", horizontal: "left" }}
                  slotProps={{ paper: { sx: { p: 1, width: 320, overflow: "visible" } } }}
                >
                  <Typography variant="caption" fontWeight={600} sx={{ mb: 0.5, display: "block" }}>
                    Add sparkline to {sparklinePopover.folder}
                  </Typography>
                  {sparklineFieldsLoading ? (
                    <Stack alignItems="center" padding={2}>
                      <CircularProgress size={20} />
                    </Stack>
                  ) : (
                    <Autocomplete<SparklineField, false, false, true>
                      autoFocus
                      openOnFocus
                      disablePortal
                      freeSolo
                      size="small"
                      options={sparklineFields}
                      getOptionLabel={(opt) =>
                        typeof opt === "string" ? opt : `${opt.topic}.${opt.field}`
                      }
                      filterOptions={(options, state) => {
                        const input = state.inputValue.toLowerCase();
                        if (input.includes("*")) {
                          // Wildcard: convert *pattern* to regex
                          const regex = new RegExp(
                            "^" +
                              input.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") +
                              "$",
                            "i",
                          );
                          return options.filter(
                            (o) => regex.test(`${o.topic}.${o.field}`) || regex.test(o.field),
                          );
                        }
                        return options.filter((o) =>
                          `${o.topic}.${o.field}`.toLowerCase().includes(input),
                        );
                      }}
                      renderOption={(props, opt) =>
                        typeof opt === "string" ? (
                          ReactNull
                        ) : (
                          <li {...props} key={`${opt.topic}/${opt.field}`}>
                            <span style={{ flex: 1, fontSize: 12 }}>
                              <span style={{ opacity: 0.5 }}>{opt.topic}.</span>
                              {opt.field}
                            </span>
                            <Chip
                              label={opt.type === "boolean" ? "bool" : "num"}
                              size="small"
                              sx={{ fontSize: 10, height: 18 }}
                            />
                          </li>
                        )
                      }
                      renderInput={(params) => (
                        <TextField
                          {...params}
                          placeholder="Search or *wildcard*…"
                          helperText="Use * for wildcard, e.g. *opmode*"
                          autoFocus
                          size="small"
                          FormHelperTextProps={{ sx: { fontSize: 10, mt: 0.5, opacity: 0.6 } }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              const input = (e.target as HTMLInputElement).value.trim();
                              if (input.includes("*")) {
                                e.preventDefault();
                                e.stopPropagation();
                                const regex = new RegExp(
                                  "^" +
                                    input
                                      .toLowerCase()
                                      .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                                      .replace(/\*/g, ".*") +
                                    "$",
                                  "i",
                                );
                                const matches = sparklineFields.filter(
                                  (f) => regex.test(`${f.topic}.${f.field}`) || regex.test(f.field),
                                );
                                if (matches.length > 0) {
                                  const folder = sparklinePopover.folder;
                                  setSparklineConfigs((prev) => {
                                    const next = new Map(prev);
                                    const list = [...(next.get(folder) ?? [])];
                                    for (const m of matches) {
                                      if (
                                        !list.some(
                                          (s) => s.topic === m.topic && s.field === m.field,
                                        )
                                      ) {
                                        list.push({ topic: m.topic, field: m.field, type: m.type });
                                      }
                                    }
                                    next.set(folder, list);
                                    return next;
                                  });
                                  setSparklinePopover(ReactNull);
                                }
                              }
                            }
                          }}
                        />
                      )}
                      onChange={(_e, opt) => {
                        const folder = sparklinePopover.folder;
                        if (typeof opt === "string") {
                          // freeSolo: user typed a pattern and hit Enter
                          const input = opt.trim();
                          if (!input.includes("*")) {
                            return;
                          }
                          const regex = new RegExp(
                            "^" +
                              input
                                .toLowerCase()
                                .replace(/[.+^${}()|[\]\\]/g, "\\$&")
                                .replace(/\*/g, ".*") +
                              "$",
                            "i",
                          );
                          const matches = sparklineFields.filter(
                            (f) => regex.test(`${f.topic}.${f.field}`) || regex.test(f.field),
                          );
                          if (matches.length === 0) {
                            return;
                          }
                          setSparklineConfigs((prev) => {
                            const next = new Map(prev);
                            const list = [...(next.get(folder) ?? [])];
                            for (const m of matches) {
                              if (!list.some((s) => s.topic === m.topic && s.field === m.field)) {
                                list.push({ topic: m.topic, field: m.field, type: m.type });
                              }
                            }
                            next.set(folder, list);
                            return next;
                          });
                        } else if (opt) {
                          setSparklineConfigs((prev) => {
                            const next = new Map(prev);
                            const list = next.get(folder) ?? [];
                            if (list.some((s) => s.topic === opt.topic && s.field === opt.field)) {
                              return prev;
                            }
                            next.set(folder, [
                              ...list,
                              { topic: opt.topic, field: opt.field, type: opt.type },
                            ]);
                            return next;
                          });
                        }
                        setSparklinePopover(ReactNull);
                      }}
                      ListboxProps={{ style: { maxHeight: 250, fontSize: 12 } }}
                    />
                  )}
                </Popover>
              )}

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
                  {tooltipState.sparkline && (
                    <>
                      <strong>
                        {tooltipState.sparkline.topic}.{tooltipState.sparkline.field}
                      </strong>
                      <br />
                      {new Date(tooltipState.sparkline.time * 1000).toLocaleString()}
                      <br />
                      {tooltipState.sparkline.type === "boolean"
                        ? tooltipState.sparkline.value === 1
                          ? "true"
                          : "false"
                        : tooltipState.sparkline.value.toFixed(3)}
                      <br />
                      <span style={{ opacity: 0.6, fontSize: 10 }}>Downsampled preview</span>
                    </>
                  )}
                  {tooltipState.incident && (
                    <>
                      <strong>
                        {tooltipState.incident.summary ??
                          tooltipState.incident.dedup_key ??
                          "Incident"}
                      </strong>
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
            </div>
          </div>
        )}

        {/* Selection info */}
        {effectiveFiles.length > 0 && (
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
        {selCenter != undefined && (
          <Stack direction="row" alignItems="center" gap={0.5} className={classes.selectionInfo}>
            <Typography variant="body2" color="text.secondary">
              Duration
            </Typography>
            <IconButton
              size="small"
              onClick={() => {
                setSelectionSpanMin((v) => Math.max(1, v - 1));
              }}
            >
              <RemoveIcon fontSize="small" />
            </IconButton>
            <TextField
              size="small"
              type="number"
              value={selectionSpanMin}
              onChange={(e) => {
                const parsed = Number(e.target.value);
                const v = Math.max(1, Math.min(1440, Number.isNaN(parsed) ? 1 : parsed));
                setSelectionSpanMin(v);
              }}
              inputProps={{
                min: 1,
                max: 1440,
                style: { textAlign: "center", padding: "2px 4px", width: 40 },
              }}
            />
            <IconButton
              size="small"
              onClick={() => {
                setSelectionSpanMin((v) => Math.min(1440, v + 1));
              }}
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
