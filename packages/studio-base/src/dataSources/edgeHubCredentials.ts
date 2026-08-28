// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/** Key used to store the Edge Hub ip/token pair via the desktop app's secure storage bridge. */
export const EDGE_HUB_CREDENTIALS_KEY = "edge-hub-credentials";

export type EdgeHubCredentials = {
  ip: string;
  token: string;
};

/** Serializes Edge Hub credentials for storage. */
export function serializeEdgeHubCredentials(credentials: EdgeHubCredentials): string {
  const serialized = JSON.stringify(credentials);
  if (serialized == undefined) {
    throw new Error("Failed to serialize Edge Hub credentials");
  }
  return serialized;
}

/** Parses previously-stored Edge Hub credentials, returning `undefined` if the data is missing or malformed. */
export function parseEdgeHubCredentials(serialized: string | undefined): EdgeHubCredentials | undefined {
  if (serialized == undefined) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    return undefined;
  }
  if (
    typeof parsed !== "object" ||
    parsed == undefined ||
    typeof (parsed as Partial<EdgeHubCredentials>).ip !== "string" ||
    typeof (parsed as Partial<EdgeHubCredentials>).token !== "string"
  ) {
    return undefined;
  }
  return parsed as EdgeHubCredentials;
}
