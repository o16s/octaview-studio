// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export type PerformanceSnapshot = {
  fps: number;
  droppedFrames: number;
  longTaskCount: number;
  longestTaskMs: number;
  heapUsedMB: number | undefined;
  heapLimitMB: number | undefined;
  heapPercent: number | undefined;
};

export type AlertType = "low-fps" | "high-memory" | "long-tasks";

export type PerformanceMonitorOptions = {
  /** How often to log metrics to the console, in milliseconds. Default: 5000 */
  reportIntervalMs?: number;
  /** Called when a metric crosses an alert threshold */
  onAlert?: (type: AlertType, snapshot: PerformanceSnapshot) => void;
  /** FPS below this for a full report interval triggers an alert. Default: 10 */
  fpsAlertThreshold?: number;
  /** Heap usage above this percentage triggers an alert. Default: 85 */
  heapAlertPercent?: number;
  /** More than this many long tasks in a report interval triggers an alert. Default: 5 */
  longTaskAlertCount?: number;
};

const REPORT_INTERVAL_MS = 5000;
const DROPPED_FRAME_THRESHOLD_MS = 50;

export class PerformanceMonitor {
  #rafId: number | undefined;
  #observer: PerformanceObserver | undefined;
  #reportTimer: ReturnType<typeof setInterval> | undefined;
  #onAlert: ((type: AlertType, snapshot: PerformanceSnapshot) => void) | undefined;

  // Thresholds
  #fpsThreshold: number;
  #heapThreshold: number;
  #longTaskThreshold: number;

  // Frame tracking
  #lastFrameTime = 0;
  #frameCount = 0;
  #droppedFrames = 0;

  // Long task tracking
  #longTaskCount = 0;
  #longestTaskMs = 0;

  #started = false;

  public constructor(options: PerformanceMonitorOptions = {}) {
    this.#onAlert = options.onAlert;
    this.#fpsThreshold = options.fpsAlertThreshold ?? 10;
    this.#heapThreshold = options.heapAlertPercent ?? 85;
    this.#longTaskThreshold = options.longTaskAlertCount ?? 5;
  }

  public start(): void {
    if (this.#started) {
      return;
    }
    this.#started = true;

    // Frame rate tracking via RAF
    this.#lastFrameTime = performance.now();
    const onFrame = (now: number) => {
      const delta = now - this.#lastFrameTime;
      this.#lastFrameTime = now;
      this.#frameCount++;
      if (delta > DROPPED_FRAME_THRESHOLD_MS) {
        this.#droppedFrames++;
      }
      this.#rafId = requestAnimationFrame(onFrame);
    };
    this.#rafId = requestAnimationFrame(onFrame);

    // Long task detection (Chromium only)
    if (typeof PerformanceObserver !== "undefined") {
      try {
        this.#observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            this.#longTaskCount++;
            if (entry.duration > this.#longestTaskMs) {
              this.#longestTaskMs = entry.duration;
            }
          }
        });
        this.#observer.observe({ type: "longtask", buffered: false });
      } catch {
        // longtask not supported in this browser
      }
    }

    // Periodic console report
    this.#reportTimer = setInterval(() => {
      this.#report();
    }, REPORT_INTERVAL_MS);
  }

  public stop(): void {
    if (!this.#started) {
      return;
    }
    this.#started = false;

    if (this.#rafId != undefined) {
      cancelAnimationFrame(this.#rafId);
      this.#rafId = undefined;
    }
    this.#observer?.disconnect();
    this.#observer = undefined;
    if (this.#reportTimer != undefined) {
      clearInterval(this.#reportTimer);
      this.#reportTimer = undefined;
    }
  }

  public snapshot(): PerformanceSnapshot {
    const elapsedSec = REPORT_INTERVAL_MS / 1000;
    const fps = elapsedSec > 0 ? Math.round(this.#frameCount / elapsedSec) : 0;

    const mem = (performance as { memory?: MemoryInfo }).memory;
    const heapUsedMB = mem ? Math.round(mem.usedJSHeapSize / 1024 / 1024) : undefined;
    const heapLimitMB = mem ? Math.round(mem.jsHeapSizeLimit / 1024 / 1024) : undefined;
    const heapPercent =
      heapUsedMB != undefined && heapLimitMB != undefined && heapLimitMB > 0
        ? Math.round((heapUsedMB / heapLimitMB) * 100)
        : undefined;

    return {
      fps,
      droppedFrames: this.#droppedFrames,
      longTaskCount: this.#longTaskCount,
      longestTaskMs: Math.round(this.#longestTaskMs),
      heapUsedMB,
      heapLimitMB,
      heapPercent,
    };
  }

  #report(): void {
    const snap = this.snapshot();

    // Console output
    const parts = [`fps=${snap.fps}`, `droppedFrames=${snap.droppedFrames}`];
    if (snap.longTaskCount > 0) {
      parts.push(`longTasks=${snap.longTaskCount}`, `longestTask=${snap.longestTaskMs}ms`);
    }
    if (snap.heapUsedMB != undefined && snap.heapLimitMB != undefined) {
      parts.push(`heap=${snap.heapUsedMB}/${snap.heapLimitMB}MB (${snap.heapPercent!}%)`);
    }
    // eslint-disable-next-line no-restricted-syntax -- [perf] lines must show at the console's default verbosity (debug is hidden)
    console.log(`[perf] ${parts.join(" ")}`);

    // Alert checks
    if (this.#onAlert) {
      if (snap.fps < this.#fpsThreshold) {
        this.#onAlert("low-fps", snap);
      }
      if (snap.heapPercent != undefined && snap.heapPercent > this.#heapThreshold) {
        this.#onAlert("high-memory", snap);
      }
      if (snap.longTaskCount > this.#longTaskThreshold) {
        this.#onAlert("long-tasks", snap);
      }
    }

    // Reset counters for next interval
    this.#frameCount = 0;
    this.#droppedFrames = 0;
    this.#longTaskCount = 0;
    this.#longestTaskMs = 0;
  }
}
