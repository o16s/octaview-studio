# Octaview Studio URL Parameters

Complete reference for all URL query parameters accepted by Octaview Studio.

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

#### `octaview-edge-hub` — Octaview Edge Hub

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
| GET | `/api/mcap/index` | Stream NDJSON index with time ranges per file |
| GET | `/api/downloads` | List desktop installer files (JSON array, requires `--downloads-path`) |
| GET | `/api/downloads/<filename>` | Serve a desktop installer file |
| GET | `/` | Serve the web app (SPA with HTML5 history fallback) |

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
