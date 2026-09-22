// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useCallback, useEffect, useRef } from "react";

import {
  AlertType,
  PerformanceMonitor,
  PerformanceSnapshot,
} from "@foxglove/studio-base/util/PerformanceMonitor";
import sendNotification from "@foxglove/studio-base/util/sendNotification";

const ALERT_COOLDOWN_MS = 60_000;

const ALERT_MESSAGES: Record<AlertType, (snap: PerformanceSnapshot) => string> = {
  "low-fps": (snap) => `Performance: low frame rate (${snap.fps} FPS)`,
  "high-memory": (snap) =>
    `Performance: high memory usage (${snap.heapUsedMB!}/${snap.heapLimitMB!} MB, ${snap.heapPercent!}%)`,
  "long-tasks": (snap) =>
    `Performance: UI thread blocked (${snap.longTaskCount} long tasks, worst ${snap.longestTaskMs}ms)`,
};

export function usePerformanceMonitor(): void {
  const lastAlertTimes = useRef(new Map<AlertType, number>());

  const onAlert = useCallback((type: AlertType, snap: PerformanceSnapshot) => {
    const now = Date.now();
    const lastTime = lastAlertTimes.current.get(type) ?? 0;
    if (now - lastTime < ALERT_COOLDOWN_MS) {
      return;
    }
    lastAlertTimes.current.set(type, now);
    sendNotification(ALERT_MESSAGES[type](snap), "", "app", "warn");
  }, []);

  useEffect(() => {
    const monitor = new PerformanceMonitor({ onAlert });
    monitor.start();
    return () => {
      monitor.stop();
    };
  }, [onAlert]);
}
