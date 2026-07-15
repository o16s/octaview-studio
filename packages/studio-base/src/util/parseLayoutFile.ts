// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import type { LayoutData } from "@foxglove/studio-base/context/CurrentLayoutContext";

/**
 * Attempts to parse a File as a Studio layout JSON.
 * Returns the parsed LayoutData if valid, or undefined if the file
 * is not a valid layout (invalid JSON, missing layout fields, etc.).
 */
export async function parseLayoutFile(file: File): Promise<LayoutData | undefined> {
  let content: string;
  try {
    content = await file.text();
  } catch {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return undefined;
  }

  if (typeof parsed !== "object" || parsed == undefined || Array.isArray(parsed)) {
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;
  if (!("layout" in obj) && !("configById" in obj)) {
    return undefined;
  }

  return parsed as LayoutData;
}
