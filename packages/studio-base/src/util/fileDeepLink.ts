// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/** One recording named by a `?file=` deep link. */
export type FileDeepLink = {
  /** The absolute host path, exactly as edge-hub wrote it into the link. */
  filePath: string;
  /** The file name on its own, for the "Opening …" overlay. */
  displayName: string;
  /** The route the MCAP reader asks byte ranges from. */
  fileUrl: string;
};

/**
 * Read the `?file=` deep link that edge-hub's Files page opens.
 *
 * edge-hub passes an absolute host path (`/mnt/datalog/tsend2mqtt/x.mcap`). The
 * server strips its own `--mcap-path` prefix again, so the path goes through
 * whole, encoded as one segment.
 *
 * @param search The query string, including the leading "?".
 * @param toFileUrl Builds the route that serves one recording, normally
 * {@link mcapFileUrl}. Passed in so this stays a pure function.
 */
export function parseFileDeepLink(
  search: string,
  toFileUrl: (path: string) => string,
): FileDeepLink | undefined {
  const filePath = new URLSearchParams(search).get("file");
  if (filePath == undefined || filePath === "") {
    return undefined;
  }

  // A trailing slash leaves nothing after the last one, so keep the whole path
  // rather than show an empty name.
  const afterLastSlash = filePath.slice(filePath.lastIndexOf("/") + 1);
  const displayName = afterLastSlash === "" ? filePath : afterLastSlash;

  return {
    filePath,
    displayName,
    fileUrl: toFileUrl(filePath),
  };
}
