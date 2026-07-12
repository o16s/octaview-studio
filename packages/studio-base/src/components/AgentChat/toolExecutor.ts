// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { MosaicNode } from "react-mosaic-component";

import { Time, add as addTimes, fromSec, subtract as subtractTimes, toSec } from "@foxglove/rostime";
import { Immutable, MessageEvent } from "@foxglove/studio";
import { AddPanelPayload, ChangePanelLayoutPayload, SaveConfigsPayload } from "@foxglove/studio-base/context/CurrentLayoutContext/actions";
import { DataSourceArgs } from "@foxglove/studio-base/context/PlayerSelectionContext";
import { storeDownloadedFiles } from "@foxglove/studio-base/dataSources/McapServerDataSourceFactory";
import { RosDatatypes } from "@foxglove/studio-base/types/RosDatatypes";
import { getPanelIdForType } from "@foxglove/studio-base/util/layout";

export type TopicInfo = {
  name: string;
  schemaName: string | undefined;
};

export type Incident = {
  time: string;
  summary?: string;
  severity?: "critical" | "error" | "warning" | "info";
  dedup_key?: string;
  source?: string;
};

export type StudioContext = {
  topics: TopicInfo[];
  datatypes: Immutable<RosDatatypes>;
  panelTypes: string[];
  currentLayout: { layout: MosaicNode<string> | undefined; configById: Record<string, unknown> };
  addPanel: (payload: AddPanelPayload) => void;
  changePanelLayout: (payload: ChangePanelLayoutPayload) => void;
  savePanelConfigs: (payload: SaveConfigsPayload) => void;
  seekPlayback: ((time: Time) => void) | undefined;
  selectSource: (sourceId: string, args?: DataSourceArgs) => void;
  getBlockMessages: (topic: string) => MessageEvent[];
  incidents: Incident[];
  startTime: Time | undefined;
};

export type ToolExecutorFn = (name: string, args: Record<string, unknown>) => Promise<string>;

type McapFileEntry = {
  path: string;
  folder: string;
  filename: string;
  startTime: number;
  endTime: number;
  size: number;
};

function getFieldPaths(
  schemaName: string,
  datatypes: Immutable<RosDatatypes>,
  prefix: string = "",
  maxDepth: number = 4,
): string[] {
  if (maxDepth <= 0) return [];
  const schema = datatypes.get(schemaName);
  if (!schema) return [];

  const paths: string[] = [];
  for (const field of schema.definitions) {
    const fieldPath = prefix ? `${prefix}.${field.name}` : field.name;
    if (field.isComplex) {
      paths.push(...getFieldPaths(field.type, datatypes, fieldPath, maxDepth - 1));
    } else {
      paths.push(fieldPath);
    }
  }
  return paths;
}

function getNestedValue(obj: unknown, path: string): unknown {
  let current: unknown = obj;
  for (const key of path.split(".")) {
    if (current == undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function extractFieldValues(
  messages: MessageEvent[],
  field: string,
  startTime: Time | undefined,
): Array<{ time: number; value: number }> {
  const results: Array<{ time: number; value: number }> = [];
  for (const msg of messages) {
    const val = getNestedValue(msg.message, field);
    if (typeof val === "number") {
      const elapsed = startTime
        ? toSec(subtractTimes(msg.receiveTime, startTime))
        : toSec(msg.receiveTime);
      results.push({ time: elapsed, value: val });
    }
  }
  return results;
}

function downsample<T>(data: T[], limit: number): T[] {
  if (data.length <= limit) {
    return data;
  }
  const step = Math.ceil(data.length / limit);
  const result: T[] = [];
  for (let i = 0; i < data.length; i += step) {
    result.push(data[i]!);
  }
  return result;
}

export function createToolExecutor(
  ctx: StudioContext,
  fetchFn: typeof fetch = globalThis.fetch,
): ToolExecutorFn {
  const handlers: Record<string, (args: Record<string, unknown>) => Promise<string>> = {
    list_topics: async (): Promise<string> => {
      return JSON.stringify(ctx.topics) as string;
    },

    search_topics: async (args): Promise<string> => {
      const query = (args.query as string ?? "").toLowerCase();
      const matches = ctx.topics.filter(
        (t) =>
          t.name.toLowerCase().includes(query) ||
          (t.schemaName?.toLowerCase().includes(query) ?? false),
      );
      return JSON.stringify(matches) as string;
    },

    get_panel_types: async (): Promise<string> => {
      return JSON.stringify(ctx.panelTypes) as string;
    },

    get_topic_fields: async (args): Promise<string> => {
      const topicName = args.topic as string;
      const topic = ctx.topics.find((t) => t.name === topicName);
      if (!topic?.schemaName) {
        return JSON.stringify([]) as string;
      }
      const paths = getFieldPaths(topic.schemaName, ctx.datatypes);
      return JSON.stringify(paths) as string;
    },

    search_topic_fields: async (args): Promise<string> => {
      const query = (args.query as string ?? "").toLowerCase();
      const results: Array<{ topic: string; path: string }> = [];
      for (const topic of ctx.topics) {
        if (!topic.schemaName) continue;
        const paths = getFieldPaths(topic.schemaName, ctx.datatypes);
        for (const path of paths) {
          if (path.toLowerCase().includes(query)) {
            results.push({ topic: topic.name, path });
          }
        }
      }
      return JSON.stringify(results) as string;
    },

    get_current_layout: async (): Promise<string> => {
      return JSON.stringify(ctx.currentLayout) as string;
    },

    add_panel: async (args) => {
      const panelType = args.type as string;
      const config = (args.config as Record<string, unknown>) ?? {};
      const id = getPanelIdForType(panelType);
      ctx.addPanel({ id, config });
      return id;
    },

    set_layout: async (args) => {
      const layout = args.layout as MosaicNode<string>;
      const configs = (args.configs as Record<string, Record<string, unknown>>) ?? {};
      ctx.changePanelLayout({ layout });
      ctx.savePanelConfigs({
        configs: Object.entries(configs).map(([id, config]) => ({
          id,
          config,
          override: true,
        })),
      });
      return "Layout updated";
    },

    seek_to_time: async (args) => {
      if (!ctx.seekPlayback) {
        return "Seek is not available — no active playback source.";
      }
      const elapsedSec = args.time as number;
      const absoluteTime = ctx.startTime
        ? addTimes(ctx.startTime, fromSec(elapsedSec))
        : fromSec(elapsedSec);
      ctx.seekPlayback(absoluteTime);
      return `Seeked to ${elapsedSec}s`;
    },

    get_incidents: async (): Promise<string> => {
      return JSON.stringify(ctx.incidents) as string;
    },

    read_field_values: async (args): Promise<string> => {
      const topic = args.topic as string;
      const field = args.field as string;
      const limit = (args.limit as number | undefined) ?? 5000;

      const messages = ctx.getBlockMessages(topic);
      const values = extractFieldValues(messages, field, ctx.startTime);
      return JSON.stringify(downsample(values, limit)) as string;
    },

    get_statistics: async (args): Promise<string> => {
      const topic = args.topic as string;
      const field = args.field as string;

      const messages = ctx.getBlockMessages(topic);
      const values = extractFieldValues(messages, field, ctx.startTime);

      if (values.length === 0) {
        return "No data found for this topic/field.";
      }

      let sum = 0;
      let min = Infinity;
      let max = -Infinity;
      for (const { value } of values) {
        sum += value;
        if (value < min) min = value;
        if (value > max) max = value;
      }
      const mean = sum / values.length;

      let sumSqDiff = 0;
      for (const { value } of values) {
        sumSqDiff += (value - mean) ** 2;
      }
      const stddev = Math.sqrt(sumSqDiff / values.length);

      return JSON.stringify({
        count: values.length,
        min,
        max,
        mean,
        stddev,
        startTime: values[0]!.time,
        endTime: values[values.length - 1]!.time,
      }) as string;
    },

    find_peaks: async (args): Promise<string> => {
      const topic = args.topic as string;
      const field = args.field as string;

      const messages = ctx.getBlockMessages(topic);
      const values = extractFieldValues(messages, field, ctx.startTime);

      if (values.length === 0) {
        return "[]";
      }

      let threshold = args.threshold as number | undefined;

      if (threshold == undefined && args.stddev != undefined) {
        const stddevMultiple = args.stddev as number;
        let sum = 0;
        for (const { value } of values) {
          sum += value;
        }
        const mean = sum / values.length;
        let sumSqDiff = 0;
        for (const { value } of values) {
          sumSqDiff += (value - mean) ** 2;
        }
        const stddev = Math.sqrt(sumSqDiff / values.length);
        threshold = mean + stddevMultiple * stddev;
      }

      if (threshold == undefined) {
        return "Either threshold or stddev parameter is required.";
      }

      const peaks: Array<{ time: number; value: number }> = [];
      for (let i = 0; i < values.length; i++) {
        const val = values[i]!.value;
        if (val <= threshold) continue;
        const prev = i > 0 ? values[i - 1]!.value : -Infinity;
        const next = i < values.length - 1 ? values[i + 1]!.value : -Infinity;
        if (val >= prev && val >= next) {
          peaks.push(values[i]!);
        }
      }

      peaks.sort((a, b) => b.value - a.value);
      return JSON.stringify(peaks.slice(0, 50)) as string;
    },

    search_recordings: async (args): Promise<string> => {
      const from = args.from as number | undefined;
      const to = args.to as number | undefined;
      const pattern = (args.pattern as string | undefined)?.toLowerCase();

      const response = await fetchFn(`${globalThis.location?.origin ?? ""}/api/mcap/index`);
      if (!response.ok) {
        return `Error fetching recording index: ${response.status} ${response.statusText}`;
      }

      const text = await response.text();
      const lines = text.split("\n").filter((l) => l.trim().length > 0);
      const files: McapFileEntry[] = [];

      for (const line of lines) {
        try {
          const parsed = JSON.parse(line) as Record<string, unknown>;
          if (parsed.file) {
            files.push(parsed.file as McapFileEntry);
          }
        } catch {
          // skip unparseable lines
        }
      }

      const filtered = files.filter((f) => {
        if (from != undefined && f.endTime < from) return false;
        if (to != undefined && f.startTime > to) return false;
        if (pattern && !f.path.toLowerCase().includes(pattern) && !f.filename.toLowerCase().includes(pattern)) {
          return false;
        }
        return true;
      });

      return JSON.stringify(filtered) as string;
    },

    load_recordings: async (args): Promise<string> => {
      const filePaths = args.files as string[];
      if (!filePaths || filePaths.length === 0) {
        return "No files specified.";
      }

      const downloadedFiles: File[] = [];
      for (const filePath of filePaths) {
        const url = `${globalThis.location?.origin ?? ""}/api/mcap/files/${encodeURIComponent(filePath)}`;
        const response = await fetchFn(url);
        if (!response.ok) {
          return `Error downloading ${filePath}: ${response.status} ${response.statusText}`;
        }
        const blob = await response.blob();
        const filename = filePath.split("/").pop() ?? filePath;
        downloadedFiles.push(new File([blob], filename));
      }

      const downloadId = `agent-${Date.now()}`;
      storeDownloadedFiles(downloadId, downloadedFiles);
      ctx.selectSource("mcap-server", {
        type: "connection",
        params: { downloadId },
      });

      return `Loaded ${downloadedFiles.length} recording(s).`;
    },

    annotate_plot: async (args): Promise<string> => {
      const panelId = args.panelId as string;
      const annotations = args.annotations as Array<{
        startTime: number;
        endTime: number;
        label: string;
        color?: string;
      }>;

      ctx.savePanelConfigs({
        configs: [
          {
            id: panelId,
            config: {
              annotations: annotations.map((a) => ({
                ...a,
                enabled: true,
              })),
            },
            override: false,
          },
        ],
      });

      return `Added ${annotations.length} annotation(s) to ${panelId}.`;
    },
  };

  return async (name: string, args: Record<string, unknown>): Promise<string> => {
    const handler = handlers[name];
    if (!handler) {
      throw new Error(`Unknown tool: ${name}`);
    }
    return handler(args);
  };
}
