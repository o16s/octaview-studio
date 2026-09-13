// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * A recording the desktop shell asked us to open, e.g. after the user
 * double-clicked an `.mcap` file the app is registered for. `url` is served by
 * the desktop's own `mcap-local://` protocol, which supports HTTP Range, so the
 * player reads it by byte range instead of holding the whole recording.
 */
export type DesktopOpenFilePayload = {
  url: string;
  /** The bare file name, for the "Opening …" overlay. */
  name?: string;
};

/** The subset of the desktop preload bridge used to open handed-off files. */
export type DesktopFileBridge = {
  /**
   * Subscribe to files opened while the app is already running. Returns an
   * unsubscribe function.
   */
  onOpenFile: (callback: (payload: DesktopOpenFilePayload) => void) => () => void;
  /**
   * Claim a file the OS queued before the renderer subscribed (the launch
   * case). Resolves to undefined when there was none.
   */
  takeInitialOpenFile?: () => Promise<DesktopOpenFilePayload | undefined>;
};

/** The arguments to pass to `selectSource` to open a desktop-handed file. */
export type DesktopFileSourceSelection = {
  sourceId: "mcap-server";
  args: {
    type: "connection";
    // `string | undefined` because this repo types JSON.stringify as possibly
    // undefined; at runtime it is always the encoded URL list.
    params: { urls: string | undefined };
  };
};

/**
 * Turn a desktop open-file payload into a `selectSource` call. Reuses the
 * URL-based `mcap-server` player path, so the recording is read by byte range
 * rather than loaded whole. Returns undefined when there is nothing to open.
 */
export function desktopFileSourceSelection(
  payload: DesktopOpenFilePayload | undefined,
): DesktopFileSourceSelection | undefined {
  const url = payload?.url.trim();
  if (url == undefined || url === "") {
    return undefined;
  }

  return {
    sourceId: "mcap-server",
    args: {
      type: "connection",
      params: { urls: JSON.stringify([url]) },
    },
  };
}
