// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Configuration the Go server injects into index.html when it serves the web
 * app. It is absent when Studio runs as a plain static site, which is how the
 * app tells server mode from browser-only mode.
 *
 * `apiBase` is the path prefix the server is mounted under — empty at the root,
 * and something like `/svc/octaview-studio` behind edge-hub's reverse proxy.
 * Every request the app makes to its own server must go through {@link apiUrl},
 * or it escapes that prefix and hits the hub instead.
 */
export type ServerConfig = {
  apiBase?: string;
  hasDownloads?: boolean;
};

export function getServerConfig(): ServerConfig | undefined {
  const config = (globalThis as Record<string, unknown>).OCTAVIEW_STUDIO_SERVER;
  return typeof config === "object" && config != undefined ? (config as ServerConfig) : undefined;
}

/** True when the web app is served by the Go server rather than as a static site. */
export function isServerMode(): boolean {
  return getServerConfig() != undefined;
}

/** The path prefix to put in front of every server route. "" at the root. */
export function getApiBase(): string {
  return getServerConfig()?.apiBase ?? "";
}

/** True when the server was started with --downloads-path. */
export function hasDownloads(): boolean {
  return getServerConfig()?.hasDownloads === true;
}

/**
 * Builds a URL for one of the server's own routes.
 *
 * @param path a root-absolute server path, e.g. `/api/mcap/index`
 */
export function apiUrl(path: string): string {
  return `${getApiBase()}${path}`;
}

/**
 * The route that serves one recording. The player reads it by byte range.
 *
 * The path goes through as one encoded segment, so an absolute host path from
 * edge-hub's Files page survives intact.
 */
export function mcapFileUrl(path: string): string {
  return apiUrl(`/api/mcap/files/${encodeURIComponent(path)}`);
}

/**
 * The route that serves several recordings as one zip, built and streamed by
 * the server. Give the browser this URL rather than fetching the recordings and
 * zipping them here: the page does not hold them any more.
 */
export function mcapArchiveUrl(paths: readonly string[]): string {
  const query = new URLSearchParams();
  for (const path of paths) {
    query.append("path", path);
  }
  return apiUrl(`/api/mcap/archive?${query.toString()}`);
}
