// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { buildEdgeHubHost } from "@foxglove/studio-base/dataSources/edgeHubHost";

export type EdgeHubHealth = {
  status: string;
  version: string;
};

const FETCH_TIMEOUT_MS = 5_000;

/**
 * Queries an Edge Hub's `/healthz` endpoint for status/version metadata. Returns `undefined`
 * on any failure (unreachable, non-200, malformed body) rather than throwing, since this is
 * used to render an optional metadata hint, not something callers should need to handle.
 */
export async function fetchEdgeHubHealth(ip: string): Promise<EdgeHubHealth | undefined> {
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(`https://${buildEdgeHubHost(ip)}/healthz`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return undefined;
    }
    const body: unknown = await response.json();
    if (
      typeof body !== "object" ||
      body == undefined ||
      typeof (body as Partial<EdgeHubHealth>).status !== "string" ||
      typeof (body as Partial<EdgeHubHealth>).version !== "string"
    ) {
      return undefined;
    }
    return body as EdgeHubHealth;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timeout);
  }
}
