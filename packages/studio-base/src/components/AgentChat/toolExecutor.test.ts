// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { MessageEvent } from "@foxglove/studio";

import { createToolExecutor, StudioContext } from "./toolExecutor";

describe("createToolExecutor", () => {
  const makeContext = (overrides?: Partial<StudioContext>): StudioContext => ({
    topics: [
      { name: "/camera/image", schemaName: "sensor_msgs/Image" },
      { name: "/imu/data", schemaName: "sensor_msgs/Imu" },
      { name: "/odom", schemaName: "nav_msgs/Odometry" },
    ],
    datatypes: new Map(),
    panelTypes: ["3D", "Image", "Plot", "RawMessages"],
    currentLayout: { layout: "3D!abc123", configById: {} },
    addPanel: jest.fn(),
    changePanelLayout: jest.fn(),
    savePanelConfigs: jest.fn(),
    setCurrentLayout: jest.fn(),
    seekPlayback: jest.fn(),
    selectSource: jest.fn(),
    getBlockMessages: jest.fn().mockReturnValue([]),
    incidents: [],
    startTime: { sec: 0, nsec: 0 },
    ...overrides,
  });

  it("list_topics returns all topics as JSON", async () => {
    const ctx = makeContext();
    const execute = createToolExecutor(ctx);

    const result = await execute("list_topics", {});
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ name: "/camera/image", schemaName: "sensor_msgs/Image" });
  });

  it("search_topics filters by query", async () => {
    const ctx = makeContext();
    const execute = createToolExecutor(ctx);

    const result = await execute("search_topics", { query: "camera" });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.name).toBe("/camera/image");
  });

  it("get_panel_types returns available panel types", async () => {
    const ctx = makeContext();
    const execute = createToolExecutor(ctx);

    const result = await execute("get_panel_types", {});
    const parsed = JSON.parse(result);

    expect(parsed).toEqual(["3D", "Image", "Plot", "RawMessages"]);
  });

  it("get_current_layout returns layout and configs", async () => {
    const ctx = makeContext({
      currentLayout: {
        layout: {
          direction: "row",
          first: "Image!abc",
          second: "Plot!def",
          splitPercentage: 50,
        },
        configById: { "Image!abc": { topic: "/camera/image" } },
      },
    });
    const execute = createToolExecutor(ctx);

    const result = await execute("get_current_layout", {});
    const parsed = JSON.parse(result);

    expect(parsed.layout.direction).toBe("row");
    expect(parsed.configById["Image!abc"]).toEqual({ topic: "/camera/image" });
  });

  it("add_panel calls addPanel with correct payload", async () => {
    const addPanel = jest.fn();
    const ctx = makeContext({ addPanel });
    const execute = createToolExecutor(ctx);

    const result = await execute("add_panel", {
      type: "Plot",
      config: { paths: [{ value: "/imu/data.linear_acceleration.x", enabled: true }] },
    });

    expect(addPanel).toHaveBeenCalledTimes(1);
    const payload = addPanel.mock.calls[0]![0];
    expect(payload.id).toMatch(/^Plot!/);
    expect(payload.config).toEqual({
      paths: [{ value: "/imu/data.linear_acceleration.x", enabled: true }],
    });
    expect(result).toContain("Plot!");
  });

  it("set_layout generates unique panel IDs and remaps layout and configs", async () => {
    const setCurrentLayout = jest.fn();
    const ctx = makeContext({ setCurrentLayout });
    const execute = createToolExecutor(ctx);

    const layout = { direction: "row", first: "Image!x1", second: "Plot!x2" };
    const configs = {
      "Image!x1": { topic: "/camera/image" },
      "Plot!x2": { paths: [] },
    };

    const result = await execute("set_layout", { layout, configs });

    const call = setCurrentLayout.mock.calls[0]![0];
    const appliedLayout = call.layout;
    expect(appliedLayout.first).toMatch(/^Image!/);
    expect(appliedLayout.second).toMatch(/^Plot!/);
    expect(appliedLayout.first).not.toBe("Image!x1");
    expect(appliedLayout.second).not.toBe("Plot!x2");

    // Configs should use the new IDs
    expect(call.configById[appliedLayout.first]).toEqual({ topic: "/camera/image" });
    expect(call.configById[appliedLayout.second]).toEqual({ paths: [] });
    expect(result).toBe("Layout updated");
  });

  it("set_layout assigns unique IDs to duplicate panel types", async () => {
    const setCurrentLayout = jest.fn();
    const ctx = makeContext({ setCurrentLayout });
    const execute = createToolExecutor(ctx);

    // 4 Image panels in a 2x2 grid — LLM uses distinct placeholder IDs
    const layout = {
      direction: "column",
      first: { direction: "row", first: "Image!a", second: "Image!b" },
      second: { direction: "row", first: "Image!c", second: "Image!d" },
    };
    const configs = {
      "Image!a": { imageTopic: "/cam1" },
      "Image!b": { imageTopic: "/cam2" },
      "Image!c": { imageTopic: "/cam3" },
      "Image!d": { imageTopic: "/cam4" },
    };

    await execute("set_layout", { layout, configs });

    const call = setCurrentLayout.mock.calls[0]![0];
    const appliedLayout = call.layout;
    const allIds = [
      appliedLayout.first.first,
      appliedLayout.first.second,
      appliedLayout.second.first,
      appliedLayout.second.second,
    ];

    // All IDs should be unique
    expect(new Set(allIds).size).toBe(4);
    // All should be Image panel type
    allIds.forEach((id: string) => expect(id).toMatch(/^Image!/));

    // Each config should map to the correct topic
    expect(call.configById[allIds[0]]).toEqual({ imageTopic: "/cam1" });
    expect(call.configById[allIds[1]]).toEqual({ imageTopic: "/cam2" });
    expect(call.configById[allIds[2]]).toEqual({ imageTopic: "/cam3" });
    expect(call.configById[allIds[3]]).toEqual({ imageTopic: "/cam4" });
  });

  it("get_topic_fields returns field paths for a topic", async () => {
    const ctx = makeContext({
      datatypes: new Map([
        [
          "sensor_msgs/Imu",
          {
            name: "sensor_msgs/Imu",
            definitions: [
              { name: "linear_acceleration", type: "geometry_msgs/Vector3", isComplex: true },
              { name: "angular_velocity", type: "geometry_msgs/Vector3", isComplex: true },
            ],
          },
        ],
        [
          "geometry_msgs/Vector3",
          {
            name: "geometry_msgs/Vector3",
            definitions: [
              { name: "x", type: "float64" },
              { name: "y", type: "float64" },
              { name: "z", type: "float64" },
            ],
          },
        ],
      ]),
    });
    const execute = createToolExecutor(ctx);

    const result = await execute("get_topic_fields", { topic: "/imu/data" });
    const parsed = JSON.parse(result) as string[];

    expect(parsed).toContain("linear_acceleration.x");
    expect(parsed).toContain("linear_acceleration.y");
    expect(parsed).toContain("linear_acceleration.z");
    expect(parsed).toContain("angular_velocity.x");
  });

  it("search_topic_fields finds fields matching a query across all topics", async () => {
    const ctx = makeContext({
      datatypes: new Map([
        [
          "sensor_msgs/Imu",
          {
            name: "sensor_msgs/Imu",
            definitions: [
              { name: "linear_acceleration", type: "geometry_msgs/Vector3", isComplex: true },
            ],
          },
        ],
        [
          "geometry_msgs/Vector3",
          {
            name: "geometry_msgs/Vector3",
            definitions: [
              { name: "x", type: "float64" },
              { name: "y", type: "float64" },
              { name: "z", type: "float64" },
            ],
          },
        ],
        [
          "custom/Vibration",
          {
            name: "custom/Vibration",
            definitions: [
              { name: "alert_acc_peak", type: "float64" },
              { name: "temperature", type: "float64" },
            ],
          },
        ],
      ]),
      topics: [
        { name: "/imu/data", schemaName: "sensor_msgs/Imu" },
        { name: "iolink/vibration1/pdin", schemaName: "custom/Vibration" },
      ],
    });
    const execute = createToolExecutor(ctx);

    const result = await execute("search_topic_fields", { query: "alert_acc_peak" });
    const parsed = JSON.parse(result) as Array<{ topic: string; path: string }>;

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toEqual({ topic: "iolink/vibration1/pdin", path: "alert_acc_peak" });
  });

  it("throws on unknown tool name", async () => {
    const ctx = makeContext();
    const execute = createToolExecutor(ctx);

    await expect(execute("nonexistent_tool", {})).rejects.toThrow("Unknown tool: nonexistent_tool");
  });

  // --- seek_to_time ---

  it("seek_to_time converts elapsed seconds to absolute time", async () => {
    const seekPlayback = jest.fn();
    const ctx = makeContext({ seekPlayback, startTime: { sec: 1000, nsec: 0 } });
    const execute = createToolExecutor(ctx);

    await execute("seek_to_time", { time: 5.5 });

    expect(seekPlayback).toHaveBeenCalledTimes(1);
    // 1000 + 5.5 = 1005.5 → { sec: 1005, nsec: 500000000 }
    expect(seekPlayback).toHaveBeenCalledWith({ sec: 1005, nsec: 500000000 });
  });

  it("seek_to_time returns error when seekPlayback is unavailable", async () => {
    const ctx = makeContext({ seekPlayback: undefined });
    const execute = createToolExecutor(ctx);

    const result = await execute("seek_to_time", { time: 100 });
    expect(result).toContain("not available");
  });

  // --- read_field_values ---

  it("read_field_values extracts nested field values from block messages", async () => {
    const messages: MessageEvent[] = [
      { topic: "/imu/data", schemaName: "sensor_msgs/Imu", receiveTime: { sec: 10, nsec: 0 }, message: { linear_acceleration: { x: 1.5, y: 2.0, z: 9.8 } }, sizeInBytes: 100 },
      { topic: "/imu/data", schemaName: "sensor_msgs/Imu", receiveTime: { sec: 11, nsec: 0 }, message: { linear_acceleration: { x: 1.6, y: 2.1, z: 9.7 } }, sizeInBytes: 100 },
      { topic: "/imu/data", schemaName: "sensor_msgs/Imu", receiveTime: { sec: 12, nsec: 0 }, message: { linear_acceleration: { x: 1.7, y: 2.2, z: 9.6 } }, sizeInBytes: 100 },
    ];
    const ctx = makeContext({ getBlockMessages: jest.fn().mockReturnValue(messages) });
    const execute = createToolExecutor(ctx);

    const result = await execute("read_field_values", { topic: "/imu/data", field: "linear_acceleration.x" });
    const parsed = JSON.parse(result) as Array<{ time: number; value: number }>;

    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toEqual({ time: 10, value: 1.5 });
    expect(parsed[1]).toEqual({ time: 11, value: 1.6 });
    expect(parsed[2]).toEqual({ time: 12, value: 1.7 });
  });

  it("read_field_values downsamples when exceeding limit", async () => {
    const messages: MessageEvent[] = Array.from({ length: 100 }, (_, i) => ({
      topic: "/sensor",
      schemaName: "Sensor",
      receiveTime: { sec: i, nsec: 0 },
      message: { value: i * 1.0 },
      sizeInBytes: 10,
    }));
    const ctx = makeContext({ getBlockMessages: jest.fn().mockReturnValue(messages) });
    const execute = createToolExecutor(ctx);

    const result = await execute("read_field_values", { topic: "/sensor", field: "value", limit: 10 });
    const parsed = JSON.parse(result) as Array<{ time: number; value: number }>;

    expect(parsed.length).toBeLessThanOrEqual(10);
  });

  it("read_field_values returns elapsed time relative to recording start", async () => {
    const messages: MessageEvent[] = [
      { topic: "/s", schemaName: "S", receiveTime: { sec: 1000, nsec: 0 }, message: { v: 1 }, sizeInBytes: 10 },
      { topic: "/s", schemaName: "S", receiveTime: { sec: 1005, nsec: 0 }, message: { v: 2 }, sizeInBytes: 10 },
    ];
    const ctx = makeContext({
      getBlockMessages: jest.fn().mockReturnValue(messages),
      startTime: { sec: 1000, nsec: 0 },
    });
    const execute = createToolExecutor(ctx);

    const result = await execute("read_field_values", { topic: "/s", field: "v" });
    const parsed = JSON.parse(result) as Array<{ time: number; value: number }>;

    expect(parsed[0]!.time).toBe(0);
    expect(parsed[1]!.time).toBe(5);
  });

  it("read_field_values returns empty array for no messages", async () => {
    const ctx = makeContext({ getBlockMessages: jest.fn().mockReturnValue([]) });
    const execute = createToolExecutor(ctx);

    const result = await execute("read_field_values", { topic: "/missing", field: "x" });
    const parsed = JSON.parse(result);

    expect(parsed).toEqual([]);
  });

  // --- get_statistics ---

  it("get_statistics computes correct statistics", async () => {
    const values = [10, 20, 30, 40, 50];
    const messages: MessageEvent[] = values.map((v, i) => ({
      topic: "/sensor",
      schemaName: "Sensor",
      receiveTime: { sec: i, nsec: 0 },
      message: { value: v },
      sizeInBytes: 10,
    }));
    const ctx = makeContext({ getBlockMessages: jest.fn().mockReturnValue(messages) });
    const execute = createToolExecutor(ctx);

    const result = await execute("get_statistics", { topic: "/sensor", field: "value" });
    const stats = JSON.parse(result);

    expect(stats.count).toBe(5);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(50);
    expect(stats.mean).toBe(30);
    expect(stats.startTime).toBe(0);
    expect(stats.endTime).toBe(4);
    // stddev of [10,20,30,40,50] = sqrt(200) ≈ 14.142
    expect(stats.stddev).toBeCloseTo(14.142, 2);
  });

  it("get_statistics returns error when no data", async () => {
    const ctx = makeContext({ getBlockMessages: jest.fn().mockReturnValue([]) });
    const execute = createToolExecutor(ctx);

    const result = await execute("get_statistics", { topic: "/missing", field: "x" });
    expect(result).toContain("No data");
  });

  // --- find_peaks ---

  it("find_peaks finds values above threshold", async () => {
    const values = [1, 2, 10, 3, 20, 4, 15, 2];
    const messages: MessageEvent[] = values.map((v, i) => ({
      topic: "/sensor",
      schemaName: "Sensor",
      receiveTime: { sec: i, nsec: 0 },
      message: { value: v },
      sizeInBytes: 10,
    }));
    const ctx = makeContext({ getBlockMessages: jest.fn().mockReturnValue(messages) });
    const execute = createToolExecutor(ctx);

    const result = await execute("find_peaks", { topic: "/sensor", field: "value", threshold: 9 });
    const peaks = JSON.parse(result) as Array<{ time: number; value: number }>;

    // Local maxima above threshold=9: 10 (at t=2, neighbors 2,3), 20 (at t=4, neighbors 3,4), 15 (at t=6, neighbors 4,2)
    expect(peaks).toHaveLength(3);
    // Sorted by value descending
    expect(peaks[0]!.value).toBe(20);
    expect(peaks[0]!.time).toBe(4);
    expect(peaks[1]!.value).toBe(15);
    expect(peaks[2]!.value).toBe(10);
  });

  it("find_peaks uses stddev-based threshold", async () => {
    // Mean=5, stddev≈2.83, threshold at 2σ ≈ 10.66
    const values = [1, 3, 5, 7, 9, 5, 3, 12, 5, 3];
    const messages: MessageEvent[] = values.map((v, i) => ({
      topic: "/sensor",
      schemaName: "Sensor",
      receiveTime: { sec: i, nsec: 0 },
      message: { value: v },
      sizeInBytes: 10,
    }));
    const ctx = makeContext({ getBlockMessages: jest.fn().mockReturnValue(messages) });
    const execute = createToolExecutor(ctx);

    const result = await execute("find_peaks", { topic: "/sensor", field: "value", stddev: 2 });
    const peaks = JSON.parse(result) as Array<{ time: number; value: number }>;

    // 12 is the only value > mean + 2*stddev and is a local maximum
    expect(peaks).toHaveLength(1);
    expect(peaks[0]!.value).toBe(12);
    expect(peaks[0]!.time).toBe(7);
  });

  // --- search_recordings ---

  it("search_recordings fetches and parses NDJSON index", async () => {
    const ndjson = [
      '{"total": 2}',
      '{"file": {"path": "data/run1.mcap", "folder": "data", "filename": "run1.mcap", "startTime": 1000, "endTime": 2000, "size": 5000}}',
      '{"file": {"path": "data/run2.mcap", "folder": "data", "filename": "run2.mcap", "startTime": 3000, "endTime": 4000, "size": 8000}}',
      '{"done": true}',
    ].join("\n");

    const mockFetch = jest.fn().mockResolvedValue(new Response(ndjson, { status: 200 }));
    const ctx = makeContext();
    const execute = createToolExecutor(ctx, mockFetch);

    const result = await execute("search_recordings", {});
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].path).toBe("data/run1.mcap");
    expect(parsed[1].path).toBe("data/run2.mcap");
  });

  it("search_recordings filters by time range overlap", async () => {
    const ndjson = [
      '{"total": 2}',
      '{"file": {"path": "early.mcap", "folder": ".", "filename": "early.mcap", "startTime": 1000, "endTime": 2000, "size": 100}}',
      '{"file": {"path": "late.mcap", "folder": ".", "filename": "late.mcap", "startTime": 3000, "endTime": 4000, "size": 100}}',
      '{"done": true}',
    ].join("\n");

    const mockFetch = jest.fn().mockResolvedValue(new Response(ndjson, { status: 200 }));
    const ctx = makeContext();
    const execute = createToolExecutor(ctx, mockFetch);

    const result = await execute("search_recordings", { from: 2500, to: 3500 });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe("late.mcap");
  });

  it("search_recordings filters by pattern", async () => {
    const ndjson = [
      '{"total": 2}',
      '{"file": {"path": "data/vibration_test.mcap", "folder": "data", "filename": "vibration_test.mcap", "startTime": 1000, "endTime": 2000, "size": 100}}',
      '{"file": {"path": "data/gps_log.mcap", "folder": "data", "filename": "gps_log.mcap", "startTime": 1000, "endTime": 2000, "size": 100}}',
      '{"done": true}',
    ].join("\n");

    const mockFetch = jest.fn().mockResolvedValue(new Response(ndjson, { status: 200 }));
    const ctx = makeContext();
    const execute = createToolExecutor(ctx, mockFetch);

    const result = await execute("search_recordings", { pattern: "vibration" });
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(1);
    expect(parsed[0].path).toBe("data/vibration_test.mcap");
  });

  // --- load_recordings ---

  it("load_recordings downloads files and opens them", async () => {
    const fileContent = new ArrayBuffer(10);
    const mockFetch = jest.fn().mockResolvedValue(
      new Response(fileContent, {
        status: 200,
        headers: { "Content-Type": "application/octet-stream" },
      }),
    );
    const selectSource = jest.fn();
    const ctx = makeContext({ selectSource });
    const execute = createToolExecutor(ctx, mockFetch);

    const result = await execute("load_recordings", { files: ["data/run1.mcap"] });

    // Should have fetched the file
    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/mcap/files/"),
    );
    // Should have called selectSource
    expect(selectSource).toHaveBeenCalledTimes(1);
    expect(selectSource).toHaveBeenCalledWith("mcap-server", {
      type: "connection",
      params: { downloadId: expect.any(String) },
    });
    expect(result).toContain("Loaded");
  });

  // --- get_incidents ---

  it("get_incidents returns incidents from URL parameters", async () => {
    const ctx = makeContext({
      incidents: [
        { time: "2026-07-10T14:30:00Z", summary: "Motor overtemp", severity: "warning" as const, source: "PLC" },
        { time: "2026-07-10T15:00:00Z", summary: "Vibration spike", severity: "critical" as const, dedup_key: "vib-1" },
      ],
    });
    const execute = createToolExecutor(ctx);

    const result = await execute("get_incidents", {});
    const parsed = JSON.parse(result);

    expect(parsed).toHaveLength(2);
    expect(parsed[0].summary).toBe("Motor overtemp");
    expect(parsed[0].severity).toBe("warning");
    expect(parsed[0].source).toBe("PLC");
    expect(parsed[1].summary).toBe("Vibration spike");
    expect(parsed[1].dedup_key).toBe("vib-1");
  });

  it("get_incidents returns empty array when no incidents", async () => {
    const ctx = makeContext({ incidents: [] });
    const execute = createToolExecutor(ctx);

    const result = await execute("get_incidents", {});
    const parsed = JSON.parse(result);

    expect(parsed).toEqual([]);
  });

  // --- annotate_plot ---

  it("annotate_plot updates Plot panel config with annotations", async () => {
    const savePanelConfigs = jest.fn();
    const ctx = makeContext({
      savePanelConfigs,
      currentLayout: {
        layout: "Plot!abc",
        configById: { "Plot!abc": { paths: [] } },
      },
    });
    const execute = createToolExecutor(ctx);

    const annotations = [
      { startTime: 10.0, endTime: 20.0, label: "Anomaly", color: "#ff0000" },
    ];
    const result = await execute("annotate_plot", { panelId: "Plot!abc", annotations });

    expect(savePanelConfigs).toHaveBeenCalledWith({
      configs: [
        {
          id: "Plot!abc",
          config: {
            annotations: [
              { startTime: 10.0, endTime: 20.0, label: "Anomaly", color: "#ff0000", enabled: true },
            ],
          },
          override: false,
        },
      ],
    });
    expect(result).toContain("annotation");
  });

  it("find_peaks returns error when neither threshold nor stddev provided", async () => {
    const messages: MessageEvent[] = [
      { topic: "/s", schemaName: "S", receiveTime: { sec: 0, nsec: 0 }, message: { v: 5 }, sizeInBytes: 10 },
    ];
    const ctx = makeContext({ getBlockMessages: jest.fn().mockReturnValue(messages) });
    const execute = createToolExecutor(ctx);

    const result = await execute("find_peaks", { topic: "/s", field: "v" });
    expect(result).toContain("threshold");
    expect(result).toContain("stddev");
  });

  it("search_recordings returns error on HTTP failure", async () => {
    const mockFetch = jest.fn().mockResolvedValue(new Response("", { status: 500, statusText: "Internal Server Error" }));
    const ctx = makeContext();
    const execute = createToolExecutor(ctx, mockFetch);

    const result = await execute("search_recordings", {});
    expect(result).toContain("Error");
    expect(result).toContain("500");
  });

  it("load_recordings returns error on download failure", async () => {
    const mockFetch = jest.fn().mockResolvedValue(new Response("", { status: 404, statusText: "Not Found" }));
    const ctx = makeContext();
    const execute = createToolExecutor(ctx, mockFetch);

    const result = await execute("load_recordings", { files: ["missing.mcap"] });
    expect(result).toContain("Error");
    expect(result).toContain("missing.mcap");
  });

  it("load_recordings returns error for empty files array", async () => {
    const ctx = makeContext();
    const execute = createToolExecutor(ctx);

    const result = await execute("load_recordings", { files: [] });
    expect(result).toContain("No files");
  });

  // --- zoom_plot ---

  it("zoom_plot sets axis bounds on a Plot panel", async () => {
    const savePanelConfigs = jest.fn();
    const ctx = makeContext({ savePanelConfigs });
    const execute = createToolExecutor(ctx);

    const result = await execute("zoom_plot", {
      panelId: "Plot!abc",
      minX: 10,
      maxX: 20,
      minY: -5,
      maxY: 5,
    });

    expect(savePanelConfigs).toHaveBeenCalledWith({
      configs: [
        {
          id: "Plot!abc",
          config: { minXValue: 10, maxXValue: 20, minYValue: -5, maxYValue: 5 },
          override: false,
        },
      ],
    });
    expect(result).toContain("Plot!abc");
  });

  it("zoom_plot sets only X bounds when Y is omitted", async () => {
    const savePanelConfigs = jest.fn();
    const ctx = makeContext({ savePanelConfigs });
    const execute = createToolExecutor(ctx);

    await execute("zoom_plot", { panelId: "Plot!abc", minX: 5, maxX: 15 });

    const config = savePanelConfigs.mock.calls[0][0].configs[0].config;
    expect(config.minXValue).toBe(5);
    expect(config.maxXValue).toBe(15);
    expect(config).not.toHaveProperty("minYValue");
    expect(config).not.toHaveProperty("maxYValue");
  });

  it("zoom_plot sets only Y bounds when X is omitted", async () => {
    const savePanelConfigs = jest.fn();
    const ctx = makeContext({ savePanelConfigs });
    const execute = createToolExecutor(ctx);

    await execute("zoom_plot", { panelId: "Plot!abc", minY: 0, maxY: 100 });

    const config = savePanelConfigs.mock.calls[0][0].configs[0].config;
    expect(config).not.toHaveProperty("minXValue");
    expect(config).not.toHaveProperty("maxXValue");
    expect(config.minYValue).toBe(0);
    expect(config.maxYValue).toBe(100);
  });

  it("zoom_plot sets followingViewWidth for rolling window", async () => {
    const savePanelConfigs = jest.fn();
    const ctx = makeContext({ savePanelConfigs });
    const execute = createToolExecutor(ctx);

    const result = await execute("zoom_plot", { panelId: "Plot!abc", rangeSeconds: 10 });

    const config = savePanelConfigs.mock.calls[0][0].configs[0].config;
    expect(config.followingViewWidth).toBe(10);
    expect(result).toContain("Plot!abc");
  });

  // --- reset_plot_view ---

  it("reset_plot_view clears axis bounds and followingViewWidth", async () => {
    const savePanelConfigs = jest.fn();
    const ctx = makeContext({ savePanelConfigs });
    const execute = createToolExecutor(ctx);

    const result = await execute("reset_plot_view", { panelId: "Plot!abc" });

    expect(savePanelConfigs).toHaveBeenCalledWith({
      configs: [
        {
          id: "Plot!abc",
          config: {
            minXValue: undefined,
            maxXValue: undefined,
            minYValue: undefined,
            maxYValue: undefined,
            followingViewWidth: undefined,
          },
          override: false,
        },
      ],
    });
    expect(result).toContain("Reset");
  });

  it("annotate_plot works even when panel was just created (not in configById snapshot)", async () => {
    const savePanelConfigs = jest.fn();
    const ctx = makeContext({
      savePanelConfigs,
      currentLayout: { layout: "Plot!abc", configById: {} },
    });
    const execute = createToolExecutor(ctx);

    const result = await execute("annotate_plot", {
      panelId: "Plot!new",
      annotations: [{ startTime: 0, endTime: 1, label: "test" }],
    });

    expect(savePanelConfigs).toHaveBeenCalledTimes(1);
    expect(result).toContain("annotation");
  });

  it("annotate_plot returns error when annotations is not an array", async () => {
    const savePanelConfigs = jest.fn();
    const ctx = makeContext({ savePanelConfigs });
    const execute = createToolExecutor(ctx);

    const result = await execute("annotate_plot", {
      panelId: "Plot!abc",
      annotations: "not an array",
    });

    expect(savePanelConfigs).not.toHaveBeenCalled();
    expect(result).toContain("must be an array");
  });

  // --- get_panel_config ---

  it("get_panel_config returns config for a panel", async () => {
    const ctx = makeContext({
      currentLayout: {
        layout: "Plot!abc",
        configById: {
          "Plot!abc": {
            paths: [{ value: "/imu.accel.x", enabled: true }],
            showLegend: true,
            followingViewWidth: 10,
          },
        },
      },
    });
    const execute = createToolExecutor(ctx);

    const result = await execute("get_panel_config", { panelId: "Plot!abc" });
    const parsed = JSON.parse(result);
    expect(parsed.showLegend).toBe(true);
    expect(parsed.followingViewWidth).toBe(10);
    expect(parsed.paths).toHaveLength(1);
  });

  it("get_panel_config returns empty object for unknown panel", async () => {
    const ctx = makeContext();
    const execute = createToolExecutor(ctx);

    const result = await execute("get_panel_config", { panelId: "Plot!unknown" });
    expect(JSON.parse(result)).toEqual({});
  });

  // --- configure_panel ---

  it("configure_panel merges config into existing panel config", async () => {
    const savePanelConfigs = jest.fn();
    const ctx = makeContext({ savePanelConfigs });
    const execute = createToolExecutor(ctx);

    const result = await execute("configure_panel", {
      panelId: "Plot!abc",
      config: { showLegend: false, followingViewWidth: 30 },
    });

    expect(savePanelConfigs).toHaveBeenCalledWith({
      configs: [
        {
          id: "Plot!abc",
          config: { showLegend: false, followingViewWidth: 30 },
          override: false,
        },
      ],
    });
    expect(result).toContain("Plot!abc");
  });
});
