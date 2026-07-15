# octaview Studio URL Parameters

Complete reference for all URL query parameters accepted by octaview Studio.

## Server Authentication

| Parameter | Example | Description |
|-----------|---------|-------------|
| `token` | `?token=abc123` | Authenticates the user. The server validates the token, sets a browser cookie (`octaview_token`), and redirects to the clean URL without the token param. Token can also be set via `--token` CLI flag, `OCTAVIEW_TOKEN` env var, or `--generate-token`. |

## App Launch

| Parameter | Example | Description |
|-----------|---------|-------------|
| `openIn` | `?openIn=web` | Controls whether to open in the web app or launch the desktop app. Values: `web`, `desktop`, `ask`. Defaults to `web` if not set. |
| `embed` | `?embed=true` | Embed/kiosk mode — hides the app bar, sidebars, and playback controls. Only the panel layout is shown. Combine with `layout` or `layoutUrl` and a data source for dashboard-style embedding in iframes or kiosks. |

## Recordings View (MCAP Timeline)

These parameters open the Recordings modal and control what it displays. Any of these params being present will auto-open the Recordings view on page load.

| Parameter | Example | Description |
|-----------|---------|-------------|
| `view` | `?view=recordings` | Opens the Recordings modal directly. Only value: `recordings`. |
| `t` | `?t=1720619400` | Unix timestamp in seconds. Centers the timeline on this time and auto-selects nearby recordings. Implies `view=recordings`. |
| `incidents` | `?incidents=<base64>` | JSON array of incidents to overlay on the timeline. Accepts base64 or plain JSON. Implies `view=recordings`. |
| `file` | `?file=/mnt/datalog/test.mcap` | On-disk path of an MCAP file. Looks it up in the server index and opens it directly in the player, skipping the timeline view. |

When no URL params are present and the user opens Recordings manually, the timeline defaults to "Now" (current time, day view).

### Combining Parameters

```
/?t=1720619400&incidents=<base64>
```

Opens the Recordings view centered on the given timestamp with incidents overlaid. The user can then select files and click Open.

```
/?file=/mnt/datalog/sensingcam/live-stream/sick1_2026-07-10.mcap
```

Looks up the file path in the MCAP index, downloads it, and opens it directly in the player.

### Incident Object Schema

```json
[
  {
    "time": "2026-07-10T14:30:00Z",
    "summary": "Motor overtemp",
    "severity": "warning",
    "dedup_key": "alert-123",
    "source": "PLC"
  }
]
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `time` | string | Yes | ISO 8601 timestamp |
| `summary` | string | No | Display label on the timeline |
| `severity` | string | No | `critical`, `error`, `warning`, or `info` — controls color |
| `dedup_key` | string | No | Deduplication identifier |
| `source` | string | No | Source system shown in tooltip |

### Incidents Example

Plain JSON (URL-encoded):
```
/?t=1720619400&incidents=[{"time":"2026-07-10T14:30:00Z","summary":"Motor overtemp","severity":"warning"}]
```

Base64-encoded (recommended for complex payloads):
```
/?t=1720619400&incidents=W3sidGltZSI6IjIwMjYtMDctMTBUMTQ6MzA6MDBaIiwic3VtbWFyeSI6Ik1vdG9yIG92ZXJ0ZW1wIiwic2V2ZXJpdHkiOiJ3YXJuaW5nIn1d
```

## Layout

Load a panel layout from the URL, replacing the current layout on page load.

| Parameter | Example | Description |
|-----------|---------|-------------|
| `layout` | `?layout=<base64 or JSON>` | Inline layout JSON (base64-encoded recommended). Accepts raw JSON or base64. |
| `layoutUrl` | `?layoutUrl=<url>` | URL to a layout JSON file. Fetched on page load. Better for complex layouts. |

If both are present, `layout` takes precedence. `layoutUrl` must use `http:` or `https:` protocol and responses are limited to 1 MB.

### Layout JSON Structure

```json
{
  "layout": {
    "first": "Image!abc",
    "second": "Plot!def",
    "direction": "row",
    "splitPercentage": 50
  },
  "configById": {
    "Image!abc": { "cameraTopic": "/camera/image" },
    "Plot!def": { "paths": [{ "value": "/imu/data.linear_acceleration.x", "enabled": true }] }
  },
  "globalVariables": {},
  "userNodes": {},
  "playbackConfig": { "speed": 1 }
}
```

| Field | Required | Description |
|-------|----------|-------------|
| `layout` | Yes | Mosaic tree — either a panel ID string (single panel) or a `{first, second, direction, splitPercentage}` object |
| `configById` | No | Panel configurations keyed by panel ID. Defaults to `{}` |
| `globalVariables` | No | Global variables. Defaults to `{}` |
| `userNodes` | No | User scripts. Defaults to `{}` |
| `playbackConfig` | No | Playback settings. Defaults to `{ speed: 1 }` |

### Examples

Single panel (inline JSON):
```
/?layout={"layout":"Plot!abc","configById":{"Plot!abc":{"paths":[{"value":"/imu.accel.x","enabled":true}]}}}
```

Base64-encoded (recommended):
```
/?layout=eyJsYXlvdXQiOiJQbG90IWFiYyIsImNvbmZpZ0J5SWQiOnsiUGxvdCFhYmMiOnsicGF0aHMiOlt7InZhbHVlIjoiL2ltdS5hY2NlbC54IiwiZW5hYmxlZCI6dHJ1ZX1dfX19
```

Remote layout file:
```
/?layoutUrl=https://your-server.com/layouts/vibration-dashboard.json
```

Combined with data source:
```
/?ds=foxglove-websocket&ds.url=wss://192.168.1.100:8765&layoutUrl=https://your-server.com/layouts/default.json
```

Embed mode dashboard (no UI chrome, just panels):
```
/?embed=true&ds=foxglove-websocket&ds.url=wss://192.168.1.100:8765&layout=eyJsYXlvdXQiOiJQbG90IWFiYyJ9
```

## Data Source Selection

Use `ds` to auto-connect to a data source on page load. Source-specific parameters are prefixed with `ds.`.

| Parameter | Example | Description |
|-----------|---------|-------------|
| `ds` | `?ds=foxglove-websocket` | Data source ID to connect to automatically. |
| `ds.*` | `?ds.url=wss://...` | Parameters passed to the data source factory. Keys vary per source (see below). |
| `time` | `?time=2026-07-11T08:30:00Z` | RFC 3339 timestamp — seeks the player to this time on load. Synced to the URL bar as you scrub. |

### Data Source IDs and Parameters

#### `foxglove-websocket` — Foxglove WebSocket

| Parameter | Required | Description |
|-----------|----------|-------------|
| `ds.url` | Yes | WebSocket URL, e.g. `wss://localhost:8765` |
| `ds.token` | No | Auth token sent via subprotocol |

```
/?ds=foxglove-websocket&ds.url=wss://localhost:8765
/?ds=foxglove-websocket&ds.url=wss://192.168.1.100:8765&ds.token=abc123
```

#### `octaview-edge-hub` — octaview Edge Hub

| Parameter | Required | Description |
|-----------|----------|-------------|
| `ds.ip` | Yes | IP address or hostname (port defaults to 8443) |
| `ds.token` | Yes | API token from Edge Hub settings |

```
/?ds=octaview-edge-hub&ds.ip=192.168.1.100&ds.token=abc123
```

#### `rosbridge-websocket` — Rosbridge

| Parameter | Required | Description |
|-----------|----------|-------------|
| `ds.url` | Yes | WebSocket URL, e.g. `ws://localhost:9090` |

```
/?ds=rosbridge-websocket&ds.url=ws://localhost:9090
```

#### `remote-file` — Remote File (MCAP/bag over HTTP)

| Parameter | Required | Description |
|-----------|----------|-------------|
| `ds.url` | Yes | HTTP(S) URL to an MCAP or bag file |

```
/?ds=remote-file&ds.url=https://example.com/recording.mcap
```

#### `mcap-server` — MCAP Server (internal)

| Parameter | Required | Description |
|-----------|----------|-------------|
| `ds.urls` | No | JSON array of MCAP file URLs on the server |
| `ds.downloadId` | No | Internal: reference to pre-downloaded files |

These are set automatically when opening files from the MCAP timeline browser.

#### `sample-nuscenes` — Sample Data

No parameters. Opens the built-in sample dataset.

```
/?ds=sample-nuscenes
```

#### File-based sources (not URL-linkable)

These data sources load local files and cannot be triggered via URL:

- `mcap-local-file`
- `ros1-local-bagfile`
- `ros2-local-bagfile`
- `ulog-local-file`

### Event Selection

| Parameter | Description |
|-----------|-------------|
| `ds.eventId` | Selects a specific event in the events panel. Set automatically when clicking events in the UI. |

## Server API Endpoints

These are served by the Go server (`cmd/foxglove-server/main.go`), enabled when `--mcap-path` is set.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/mcap/files` | List all MCAP files (JSON array) |
| GET | `/api/mcap/files/<path>` | Serve an individual MCAP file (supports HTTP Range requests) |
| GET | `/api/mcap/topics/<path>` | List topics in an MCAP file (JSON array with topic, schemaName, messageEncoding, messageCount) |
| GET | `/api/mcap/index` | Stream NDJSON index with time ranges and topic metadata per file. Optional `?start=<unix>&end=<unix>` filters to files overlapping that window. |
| GET | `/api/mcap/fields` | List plottable fields across MCAP files in a folder (from SQLite cache) |
| GET | `/api/mcap/sample` | Sample decimated time series data for a field across files in a folder |
| GET | `/api/mcap/video/<path>` | Remux an H.264 video topic from an MCAP file to streamable MP4 |
| GET | `/api/downloads` | List desktop installer files (JSON array, requires `--downloads-path`) |
| GET | `/api/downloads/<filename>` | Serve a desktop installer file |
| GET | `/` | Serve the web app (SPA with HTML5 history fallback) |

### File Index: `/api/mcap/index`

Streams an NDJSON index of all MCAP files. Each file entry now includes topic and schema metadata alongside time ranges, so clients can filter or display topic information without a separate request per file.

#### Response Format

Each file line is a JSON object with a `file` key:

```json
{"file": {
  "path": "sensingcam/live-stream/sick1_2026-07-13.mcap",
  "folder": "sensingcam/live-stream",
  "filename": "sick1_2026-07-13.mcap",
  "startTime": 1752392876.123,
  "endTime": 1752393000.456,
  "size": 8012345,
  "topics": [
    {"topic": "sensingcam/sick1/video/h264", "schemaName": "foxglove.CompressedVideo", "messageEncoding": "protobuf", "messageCount": 9608},
    {"topic": "sensingcam/sick1/imu", "schemaName": "sensor_msgs/msg/Imu", "messageEncoding": "cdr", "messageCount": 4200}
  ]
}}
```

The `topics` array contains all channels in the file with their topic name, schema name, message encoding, and message count. Topic metadata is cached in SQLite alongside the time range index for fast subsequent lookups.

### Video Streaming: `/api/mcap/video/<path>`

Streams H.264 video from MCAP recordings as browser-playable MP4 — **no re-encoding**. The existing H.264 frames are remuxed into a fragmented MP4 container via ffmpeg (`-c copy`), which uses near-zero CPU. This works on low-power hardware (e.g. ARM single-board computers).

**Requires `ffmpeg` installed on the server** (`apt install ffmpeg` / `brew install ffmpeg`).

#### Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `topic` | Yes | The video topic to extract (e.g. `sensingcam/sick1/video/h264`) |
| `start` | No | Start time as Unix seconds (float). Only include frames at or after this time. |
| `end` | No | End time as Unix seconds (float). Only include frames before this time. |

Response: `Content-Type: video/mp4` — fragmented MP4, streamed progressively (playable before download completes).

#### Workflow

**1. Find MCAP files**

List all recordings, or filter by time range:
```bash
# All files
curl https://HOST:8152/api/mcap/files

# Files overlapping a time window (returns only matching files)
curl 'https://HOST:8152/api/mcap/index?start=1752392876&end=1752393000'
```

**2. List topics in a file**

Find the video topic name and verify it uses `foxglove.CompressedVideo`:
```bash
curl https://HOST:8152/api/mcap/topics/sensingcam/live-stream/sick1_2026-07-13.mcap
```
```json
[
  {
    "topic": "sensingcam/sick1/video/h264",
    "schemaName": "foxglove.CompressedVideo",
    "messageEncoding": "protobuf",
    "messageCount": 9608
  }
]
```

**3. Stream or download the video**

Full file:
```bash
curl -o recording.mp4 \
  'https://HOST:8152/api/mcap/video/sensingcam/live-stream/sick1_2026-07-13.mcap?topic=sensingcam/sick1/video/h264'
```

60-second clip:
```bash
curl -o clip.mp4 \
  'https://HOST:8152/api/mcap/video/sensingcam/live-stream/sick1_2026-07-13.mcap?topic=sensingcam/sick1/video/h264&start=1783932700&end=1783932760'
```

With authentication:
```bash
curl -o clip.mp4 \
  'https://HOST:8152/api/mcap/video/path/to/file.mcap?topic=cam/h264&token=YOUR_TOKEN'
```

#### Browser Playback

Open the URL directly in any browser — the video plays inline. Or embed it:

```html
<video controls autoplay>
  <source src="/api/mcap/video/recording.mcap?topic=cam/h264" type="video/mp4" />
</video>
```

JavaScript (e.g. building a preview gallery):
```javascript
const index = await fetch("/api/mcap/index").then(r => r.text());
const files = index.split("\n")
  .filter(Boolean)
  .map(JSON.parse)
  .filter(l => l.file)
  .map(l => l.file);

for (const file of files) {
  const topics = await fetch(`/api/mcap/topics/${file.path}`).then(r => r.json());
  const video = topics.find(t => t.schemaName === "foxglove.CompressedVideo");
  if (video) {
    const el = document.createElement("video");
    el.src = `/api/mcap/video/${file.path}?topic=${encodeURIComponent(video.topic)}`;
    el.controls = true;
    document.body.appendChild(el);
  }
}
```

#### How It Works

1. Opens the MCAP file and reads messages for the specified topic
2. Extracts raw H.264 NAL units from each `foxglove.CompressedVideo` message
3. Converts AVCC format to Annex B if needed (start-code delimited)
4. Scans ahead for SPS/PPS parameter sets and prepends them so ffmpeg can initialize
5. Estimates FPS from message timestamps (clamped 1–120 fps)
6. Pipes the Annex B stream to `ffmpeg -f h264 -c copy -movflags frag_keyframe+empty_moov -f mp4`
7. Streams ffmpeg's output directly to the HTTP response with progressive flushing

#### Notes

- Supports both `protobuf` and `cdr` (ROS 2) message encodings
- Works with in-progress MCAP files (still being written)
- Multiple parallel requests are safe — each spawns its own ffmpeg process
- If the client disconnects, the ffmpeg process is cleaned up automatically
- `<path>` is relative to the `--mcap-path` directory (absolute paths are also accepted)
- Handles H.264 streams where SPS/PPS are in separate messages from IDR frames

### Signal Sampling: `/api/mcap/fields` and `/api/mcap/sample`

Query plottable signal data from MCAP recordings. Designed for sparkline previews and programmatic signal analysis (e.g., "find recordings where a PLC alarm was active"). Optimized for low-power hardware (ARM, 2GB RAM) — uses streaming reads, decimation, and SQLite caching.

**Field indexing** happens automatically during the first `/api/mcap/index` request. For each JSON-encoded topic, the server reads one message to detect field names and types, then caches them in SQLite.

#### List Fields: `GET /api/mcap/fields`

Returns all plottable fields across MCAP files in a folder.

| Parameter | Required | Description |
|-----------|----------|-------------|
| `folder` | Yes | Folder path relative to `--mcap-path` (use `.` for root) |
| `plottable` | No | If `false`, include string fields too (default: `true`, numbers and booleans only) |

```bash
curl 'https://HOST:8152/api/mcap/fields?folder=recordings'
```

```json
[
  {"topic": "plc1/tags", "field": "ST010_MachineState_AlarmActive", "type": "boolean"},
  {"topic": "plc1/tags", "field": "ST010_VirtMaster_ActualPos", "type": "number"},
  {"topic": "plc1/tags", "field": "ST010_Statistics_TotalNoOfTrays", "type": "number"},
  {"topic": "device", "field": "disk_free_mb", "type": "number"}
]
```

Fields are cached in SQLite (`mcap_fields` table). Subsequent requests are instant — no MCAP file I/O.

#### Sample Data: `GET /api/mcap/sample`

Returns decimated time series values for a single field across all MCAP files in a folder that overlap the requested time range. Results are split into **per-file segments** (gaps between files are preserved).

| Parameter | Required | Description |
|-----------|----------|-------------|
| `folder` | Yes | Folder path relative to `--mcap-path` (use `.` for root) |
| `topic` | Yes | Topic name (e.g., `plc1/tags`) |
| `field` | Yes | Field name (e.g., `ST010_MachineState_AlarmActive`) |
| `start` | Yes | Start time as Unix seconds (float) |
| `end` | Yes | End time as Unix seconds (float) |
| `decimation` | No | Read every Nth message (default: `10`) |
| `maxPoints` | No | Maximum points per segment (default: `500`) — downsampled using min-max bucketing to preserve peaks |

```bash
# Sample alarm signal over a 30-minute window
curl 'https://HOST:8152/api/mcap/sample?folder=recordings&topic=plc1/tags&field=ST010_MachineState_AlarmActive&start=1784099886&end=1784102158&maxPoints=100'
```

```json
{
  "segments": [
    {
      "file": "recordings/2026-07-15T07-18-06Z_0002.mcap",
      "timestamps": [1784099909.6, 1784100117.4, 1784100342.9, ...],
      "values": [0, 0, 1, 1, 0, 0, ...]
    },
    {
      "file": "recordings/2026-07-15T08-00-00Z_0003.mcap",
      "timestamps": [1784102400.1, 1784102622.3, ...],
      "values": [0, 0, ...]
    }
  ]
}
```

**Value mapping:** Numbers are returned as-is. Booleans are mapped to `0` (false) and `1` (true). String fields are skipped.

**Caching:** Sampled values are cached in SQLite (`mcap_samples` table) keyed by `(file, topic, field, decimation)`. Subsequent requests for the same data are served from cache without touching MCAP files.

**Downsampling:** When a segment has more points than `maxPoints / numSegments`, min-max bucketing reduces the output while preserving peaks and troughs — critical for alarm signals where you need to see every transition.

#### Workflow: Find Interesting Time Periods

**1. List available fields:**
```bash
curl 'https://HOST:8152/api/mcap/fields?folder=recordings'
```

**2. Sample a signal across a day:**
```bash
curl 'https://HOST:8152/api/mcap/sample?folder=recordings&topic=plc1/tags&field=ST010_MachineState_AlarmActive&start=1784073600&end=1784160000&maxPoints=500'
```

**3. Find where the alarm was active** (client-side or via MCP):
```javascript
const data = await fetch("/api/mcap/sample?...").then(r => r.json());
const alarmRanges = [];
for (const seg of data.segments) {
  for (let i = 0; i < seg.timestamps.length; i++) {
    if (seg.values[i] === 1) {
      alarmRanges.push({ file: seg.file, time: seg.timestamps[i] });
    }
  }
}
```

**4. Download only the relevant video clips:**
```bash
for range in alarmRanges:
  curl -o "clip_${range.time}.mp4" \
    "https://HOST:8152/api/mcap/video/${range.file}?topic=cam/h264&start=${range.time-30}&end=${range.time+30}"
```

#### UI Integration

In the octaview Studio Recordings timeline, click the **"+"** button next to any folder name to add a sparkline. A searchable field picker shows all plottable fields. Selected signals render as inline SVG polylines below the folder's file bars, sharing the same time axis. Boolean signals use step rendering; numeric signals use linear interpolation.

Sparkline configurations persist to `localStorage` and survive page reloads. Data re-fetches automatically when the viewport is panned or zoomed (debounced 400ms).

#### Performance Notes

- **Streaming reads** — MCAP files are never loaded entirely into memory
- **gjson** — single-field extraction without full JSON unmarshal
- **Concurrent reads capped at 2** — prevents memory exhaustion on low-RAM devices
- **Batch SQLite inserts** — one transaction per file, 1000-row batches
- **Client disconnect** — aborts reading immediately via `r.Context().Done()`
- First request for uncached data takes ~1-3s per file (depending on message count and storage speed). Subsequent requests are instant from SQLite cache.

## Server CLI Flags

```
foxglove-studio [flags]

  --mcap-path <dir>       Directory containing MCAP files (enables /api/mcap/* endpoints)
  --downloads-path <dir>  Directory containing desktop installers (.dmg, .exe)
  --port <int>            HTTP server port (default: 8152)
  --tls                   Enable HTTPS with auto-generated self-signed certificate
  --tls-cert <file>       Path to TLS certificate file (use with --tls-key)
  --tls-key <file>        Path to TLS private key file (use with --tls-cert)
  --token <string>        Authentication token (also: OCTAVIEW_TOKEN env var)
  --generate-token        Auto-generate a random token and print the access URL
```

## Docker

```bash
docker run -p 8152:8152 \
  -v /path/to/mcap:/data/mcap \
  -v /path/to/downloads:/data/downloads \
  ghcr.io/o16s/octaview-studio:latest \
  --mcap-path /data/mcap --port 8152 --generate-token
```

Default CMD: `--mcap-path /data/mcap --port 8152 --generate-token`

Volumes:
- `/data/mcap` — MCAP recordings directory
- `/data/downloads` — Desktop installer files (optional)
