// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

const CLOSE_CODE_DESCRIPTIONS: Record<number, string> = {
  1000: "Normal closure",
  1001: "Server going away",
  1002: "Protocol error",
  1003: "Unsupported data",
  1005: "No status received",
  1006: "Abnormal closure (network error)",
  1007: "Invalid frame payload data",
  1008: "Policy violation",
  1009: "Message too big",
  1010: "Missing extension",
  1011: "Internal server error",
  1012: "Service restart",
  1013: "Try again later",
  1014: "Bad gateway",
  1015: "TLS handshake failure",
};

/**
 * Builds a human-readable error message from a WebSocket close code and reason.
 */
export function websocketCloseMessage(
  code: number | undefined,
  reason: string | undefined,
): string {
  if (code == undefined) {
    return "Connection closed unexpectedly";
  }

  const description = CLOSE_CODE_DESCRIPTIONS[code] ?? "Unknown error";
  const base = `Connection closed (${code}: ${description})`;

  if (reason && reason.length > 0) {
    return `${base} — ${reason}`;
  }

  return base;
}
