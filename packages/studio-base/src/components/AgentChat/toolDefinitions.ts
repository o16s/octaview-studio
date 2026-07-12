// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { ToolDefinition } from "./types";

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "list_topics",
      description:
        "List all available topics in the current data source with their schema names.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "search_topics",
      description:
        "Search topics by name or schema type. Returns matching topics.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query to match against topic name or schema" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_panel_types",
      description:
        "List all available panel types that can be added to the layout (e.g. 3D, Image, Plot, RawMessages).",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "get_topic_fields",
      description:
        "Get all plottable field paths for a specific topic. Returns dot-separated paths like 'linear_acceleration.x'.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Exact topic name from list_topics" },
        },
        required: ["topic"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_topic_fields",
      description:
        "Search all topics for fields matching a query. Useful when the user mentions a field name but not the full topic path. Returns [{topic, path}] matches.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Field name or partial match to search for" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_current_layout",
      description:
        "Get the current layout structure (mosaic tree) and panel configurations.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "add_panel",
      description:
        "Add a new panel to the current layout. Returns the new panel ID.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "Panel type (e.g. 'Image', 'Plot', '3D', 'RawMessages')",
          },
          config: {
            type: "object",
            description:
              "Panel configuration. For Image: { imageTopic: 'exact_topic_name' }. For Plot: { paths: [{ value: 'topic.field', enabled: true, timestampMethod: 'receiveTime' }] }. For 3D: {}. For RawMessages: { topicPath: 'exact_topic_name' }. Use exact topic names from list_topics — do NOT add a leading slash.",
          },
        },
        required: ["type"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "set_layout",
      description:
        "Replace the entire layout with a new mosaic tree and panel configs. Use this to arrange multiple panels side by side or stacked.",
      parameters: {
        type: "object",
        properties: {
          layout: {
            description:
              "Mosaic layout tree. A leaf is a panel ID string (e.g. 'Image!abc'). A branch is { direction: 'row'|'column', first: node, second: node, splitPercentage?: number }.",
          },
          configs: {
            type: "object",
            description:
              "Map of panel ID to panel config. Each panel ID in the layout tree must have a config entry.",
          },
        },
        required: ["layout", "configs"],
      },
    },
  },

  // --- Incident Context ---

  {
    type: "function",
    function: {
      name: "get_incidents",
      description:
        "Get the list of incidents passed via URL parameters. Incidents have a time (ISO 8601), summary, severity (critical/error/warning/info), source, and dedup_key. Use this to understand what events triggered this session and correlate them with data. Returns an empty array if no incidents were provided.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },

  // --- Data Analysis Tools ---

  {
    type: "function",
    function: {
      name: "seek_to_time",
      description:
        "Jump playback to a specific timestamp. Time is in seconds (unix epoch or relative to recording start, depending on source).",
      parameters: {
        type: "object",
        properties: {
          time: { type: "number", description: "Time in seconds to seek to" },
        },
        required: ["time"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_field_values",
      description:
        "Read numeric values of a specific field from loaded MCAP data. Returns [{time, value}] pairs. Data is read from the block loader cache — only works with MCAP files, not live streams.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Exact topic name" },
          field: { type: "string", description: "Dot-separated field path, e.g. 'linear_acceleration.x'" },
          limit: { type: "number", description: "Max number of points to return (default 5000). Data is downsampled if exceeded." },
        },
        required: ["topic", "field"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_statistics",
      description:
        "Compute summary statistics (min, max, mean, stddev, count, startTime, endTime) for a numeric field from loaded MCAP data.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Exact topic name" },
          field: { type: "string", description: "Dot-separated field path" },
        },
        required: ["topic", "field"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "find_peaks",
      description:
        "Find peak values (local maxima above a threshold) in a numeric field. Specify either an absolute threshold or a stddev multiplier (mean + N*stddev). Returns [{time, value}] sorted by value descending, max 50 results.",
      parameters: {
        type: "object",
        properties: {
          topic: { type: "string", description: "Exact topic name" },
          field: { type: "string", description: "Dot-separated field path" },
          threshold: { type: "number", description: "Absolute threshold — peaks must exceed this value" },
          stddev: { type: "number", description: "Standard deviation multiplier — threshold = mean + N*stddev. Use instead of absolute threshold." },
        },
        required: ["topic", "field"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_recordings",
      description:
        "Search for MCAP recordings on the server. Requires the Go server with --mcap-path. Returns file metadata including path, time range, and size. Use load_recordings to open results.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "number", description: "Start of time range filter (unix seconds). Files ending before this are excluded." },
          to: { type: "number", description: "End of time range filter (unix seconds). Files starting after this are excluded." },
          pattern: { type: "string", description: "Substring match on file path/name" },
        },
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_recordings",
      description:
        "Download and open MCAP recording files in the player. Pass file paths from search_recordings results.",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            items: { type: "string" },
            description: "Array of file paths from search_recordings results",
          },
        },
        required: ["files"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "annotate_plot",
      description:
        "Add annotation regions (highlighted time ranges with labels) to a Plot panel. Use the panel ID returned by add_panel or from get_current_layout. Annotations appear as shaded colored rectangles on the chart. Times are elapsed seconds from recording start.",
      parameters: {
        type: "object",
        properties: {
          panelId: { type: "string", description: "Panel ID of the Plot panel (e.g. 'Plot!abc123')" },
          annotations: {
            type: "array",
            items: {
              type: "object",
              properties: {
                startTime: { type: "number", description: "Start time in seconds" },
                endTime: { type: "number", description: "End time in seconds" },
                label: { type: "string", description: "Label for the annotation" },
                color: { type: "string", description: "Color in hex format (e.g. '#ff0000')" },
              },
              required: ["startTime", "endTime", "label"],
            },
            description: "Array of annotation regions",
          },
        },
        required: ["panelId", "annotations"],
      },
    },
  },
];
