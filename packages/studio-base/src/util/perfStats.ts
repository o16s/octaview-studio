// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Lightweight always-on perf counters, reported as `[perf] key=value …` console
 * lines. Hot paths only increment plain numbers; a lazy 5s reporter logs an
 * interval summary and stays silent while nothing happens. The module is
 * self-contained so it works identically on the main thread and inside workers
 * (each context gets its own instance; DevTools attributes worker lines).
 *
 * To collect a benchmark: open DevTools, filter the console on `[perf]`,
 * reproduce the problem, then right-click → "Save as…" to export the log.
 */

const REPORT_INTERVAL_MS = 5000;

export type PerfReport = Record<string, number>;

export class PerfStatsRegistry {
  #counts = new Map<string, number>();
  #maxes = new Map<string, number>();
  #gauges = new Map<string, number>();
  #gaugesChanged = false;

  /** Add n to an interval counter (reset on every report). */
  public count(key: string, n = 1): void {
    this.#counts.set(key, (this.#counts.get(key) ?? 0) + n);
  }

  /** Track the max of a value over the interval (reset on every report). */
  public max(key: string, value: number): void {
    const prev = this.#maxes.get(key);
    if (prev == undefined || value > prev) {
      this.#maxes.set(key, value);
    }
  }

  /** Set an absolute value (persists across reports; reported when anything changes). */
  public gauge(key: string, value: number): void {
    if (this.#gauges.get(key) !== value) {
      this.#gauges.set(key, value);
      this.#gaugesChanged = true;
    }
  }

  /**
   * Snapshot and reset the interval. Returns undefined when nothing happened
   * this interval, so an idle app produces no log lines.
   */
  public report(): PerfReport | undefined {
    const active = this.#counts.size > 0 || this.#maxes.size > 0 || this.#gaugesChanged;
    if (!active) {
      return undefined;
    }
    const out: PerfReport = {};
    for (const [k, v] of this.#gauges) {
      out[k] = v;
    }
    for (const [k, v] of this.#counts) {
      out[k] = v;
    }
    for (const [k, v] of this.#maxes) {
      out[k] = v;
    }
    this.#counts.clear();
    this.#maxes.clear();
    this.#gaugesChanged = false;
    return out;
  }
}

/** Format a report as a single greppable console line. */
export function formatPerfLine(report: PerfReport): string {
  const parts = Object.keys(report)
    .sort()
    .map((k) => `${k}=${Math.round(report[k]! * 10) / 10}`);
  return `[perf] ${parts.join(" ")}`;
}

let reporterStarted = false;
const registry = new PerfStatsRegistry();

function ensureReporter(): void {
  if (reporterStarted) {
    return;
  }
  reporterStarted = true;
  const timer = setInterval(() => {
    const report = registry.report();
    if (report) {
      // eslint-disable-next-line no-console
      console.log(formatPerfLine(report));
    }
  }, REPORT_INTERVAL_MS);
  // In Node (jest), don't let the reporter keep the process alive. No-op in browsers.
  (timer as unknown as { unref?: () => void }).unref?.();
}

/**
 * The shared instance for instrumentation call sites. The console reporter
 * starts lazily on first use, so contexts that never record stay silent.
 */
export const perfStats = {
  count(key: string, n = 1): void {
    ensureReporter();
    registry.count(key, n);
  },
  max(key: string, value: number): void {
    ensureReporter();
    registry.max(key, value);
  },
  gauge(key: string, value: number): void {
    ensureReporter();
    registry.gauge(key, value);
  },
};
