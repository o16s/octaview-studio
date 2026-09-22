// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useCallback, useEffect, useState } from "react";

type UpdateStatus =
  | { status: "idle" }
  | { status: "checking" }
  | { status: "available"; version: string }
  | { status: "not-available" }
  | { status: "downloading"; percent: number }
  | { status: "downloaded"; version: string }
  | { status: "error"; message: string };

type DesktopUpdater = {
  check: () => Promise<void>;
  download: () => Promise<void>;
  install: () => Promise<void>;
  getVersion: () => Promise<string>;
  onStatus: (callback: (data: UpdateStatus) => void) => () => void;
};

type DesktopBridge = {
  isDesktop: boolean;
  updater?: DesktopUpdater;
};

function getUpdater(): DesktopUpdater | undefined {
  return (globalThis as unknown as { desktopBridge?: DesktopBridge }).desktopBridge?.updater;
}

export type AutoUpdateState = {
  status: UpdateStatus;
  download: () => void;
  install: () => void;
  check: () => void;
  dismiss: () => void;
};

export function useAutoUpdate(): AutoUpdateState | undefined {
  const updater = getUpdater();
  const [status, setStatus] = useState<UpdateStatus>({ status: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!updater) {
      return;
    }
    return updater.onStatus(setStatus);
  }, [updater]);

  const download = useCallback(() => {
    void updater?.download();
  }, [updater]);

  const install = useCallback(() => {
    void updater?.install();
  }, [updater]);

  const check = useCallback(() => {
    void updater?.check();
  }, [updater]);

  const dismiss = useCallback(() => {
    setDismissed(true);
  }, []);

  if (!updater || dismissed) {
    return undefined;
  }

  return { status, download, install, check, dismiss };
}
