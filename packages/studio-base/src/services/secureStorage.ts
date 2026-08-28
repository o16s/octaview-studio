// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * OS-keychain-backed secure storage, bridged from the Electron main process via
 * desktop/preload.js. Only present when running inside the desktop app - in the
 * browser build `window.desktopBridge` doesn't exist, so {@link getSecureStorage}
 * returns `undefined` and callers must not attempt to persist secrets there.
 */
export type SecureStorage = {
  get: (key: string) => Promise<string | undefined>;
  set: (key: string, value: string) => Promise<boolean>;
  delete: (key: string) => Promise<void>;
};

type DesktopBridge = {
  isDesktop: boolean;
  secureStorage?: SecureStorage;
};

export function getSecureStorage(): SecureStorage | undefined {
  return (globalThis as unknown as { desktopBridge?: DesktopBridge }).desktopBridge
    ?.secureStorage;
}
