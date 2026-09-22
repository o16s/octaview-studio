// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  buildTimeIndex,
  makeBaseOpener,
  rowIndexAtTime,
  sheetSourceKey,
  sourceDisplayName,
  visibleTopics,
} from "./model";

describe("buildTimeIndex / rowIndexAtTime", () => {
  // The topic's log_time column, column-major (as TopicRowsView.column returns).
  const logTimes = [
    "300",
    "100", // out of order on purpose
    "", // missing timestamp -> skipped
    "200",
  ];

  it("indexes rows sorted by time but keyed to their original index", () => {
    expect(buildTimeIndex(logTimes)).toEqual([
      { time: 100n, rowIndex: 1 },
      { time: 200n, rowIndex: 3 },
      { time: 300n, rowIndex: 0 },
    ]);
  });

  it("finds the latest row at or before the target time", () => {
    const index = buildTimeIndex(logTimes);
    expect(rowIndexAtTime(index, 50n)).toBeUndefined(); // before everything
    expect(rowIndexAtTime(index, 100n)).toBe(1);
    expect(rowIndexAtTime(index, 250n)).toBe(3); // between 200 and 300 -> row at t=200
    expect(rowIndexAtTime(index, 9999n)).toBe(0); // after everything -> last (t=300)
  });

  it("preserves nanosecond precision beyond Number range", () => {
    const index = buildTimeIndex(["1700000000123456789"]);
    expect(rowIndexAtTime(index, 1700000000123456789n)).toBe(0);
    expect(rowIndexAtTime(index, 1700000000123456788n)).toBeUndefined();
  });
});

const t = (topic: string) => ({ topic });

describe("visibleTopics", () => {
  it("shows every topic when nothing is hidden (default)", () => {
    expect(visibleTopics([t("/b"), t("/a")], undefined)).toEqual([t("/b"), t("/a")]);
    expect(visibleTopics([t("/a")], [])).toEqual([t("/a")]);
  });

  it("drops only the hidden topics, preserving order", () => {
    expect(visibleTopics([t("/a"), t("/b"), t("/c")], ["/b"])).toEqual([t("/a"), t("/c")]);
  });

  it("matches the player's leading-slash names against the workbook's raw names", () => {
    // Settings store "/iolink/x" (player); the workbook has "iolink/x" (raw).
    expect(visibleTopics([t("iolink/x"), t("iolink/y")], ["/iolink/x"])).toEqual([t("iolink/y")]);
    // ...and vice-versa.
    expect(visibleTopics([t("/iolink/x"), t("/iolink/y")], ["iolink/x"])).toEqual([t("/iolink/y")]);
  });

  it("ignores hidden names that aren't present (never blanks the sheet)", () => {
    // A truly unmatched name (e.g. aliased) hides nothing rather than all.
    expect(visibleTopics([t("raw")], ["something-else"])).toEqual([t("raw")]);
  });
});

describe("sourceDisplayName", () => {
  it("uses the file name for file sources", () => {
    expect(
      sourceDisplayName({ kind: "files", sourceId: "x", files: [new File([], "run.mcap")] }),
    ).toBe("run.mcap");
  });

  it("uses the decoded base name for url sources", () => {
    expect(sourceDisplayName({ kind: "urls", sourceId: "x", urls: ["http://h/a/b/run.mcap"] })).toBe(
      "run.mcap",
    );
    // Encoded absolute path in one segment (desktop mcap-local:// style).
    expect(
      sourceDisplayName({
        kind: "urls",
        sourceId: "x",
        urls: ["mcap-local://file/%2Fmnt%2Fdata%2Frun.mcap"],
      }),
    ).toBe("run.mcap");
  });

  it("falls back to a placeholder when there is no source", () => {
    expect(sourceDisplayName(undefined)).toBe("MCAP");
  });
});

describe("sheetSourceKey", () => {
  const src = { kind: "urls", sourceId: "x", urls: ["http://h/run.mcap"] } as const;

  it("changes when the source or the hidden set changes, stable otherwise", () => {
    expect(sheetSourceKey(src, undefined)).toBe(sheetSourceKey(src, undefined));
    expect(sheetSourceKey(src, [])).toBe(sheetSourceKey(src, undefined)); // both "show all"
    expect(sheetSourceKey(src, ["/a"])).not.toBe(sheetSourceKey(src, undefined));
    expect(
      sheetSourceKey({ kind: "urls", sourceId: "x", urls: ["http://h/other.mcap"] }, undefined),
    ).not.toBe(sheetSourceKey(src, undefined));
  });

  it("is order-independent for the hidden set", () => {
    expect(sheetSourceKey(src, ["/a", "/b"])).toBe(sheetSourceKey(src, ["/b", "/a"]));
  });
});

describe("makeBaseOpener", () => {
  it("returns an opener for an MCAP url source", () => {
    expect(
      typeof makeBaseOpener({ kind: "urls", sourceId: "remote-file", urls: ["http://x/run.mcap"] }),
    ).toBe("function");
  });

  it("returns an opener for an MCAP file source", () => {
    const file = new File([], "run.MCAP");
    expect(typeof makeBaseOpener({ kind: "files", sourceId: "mcap-local-file", files: [file] })).toBe(
      "function",
    );
  });

  it("is undefined for no source or a non-MCAP source", () => {
    expect(makeBaseOpener(undefined)).toBeUndefined();
    expect(
      makeBaseOpener({ kind: "urls", sourceId: "remote-file", urls: ["http://x/run.bag"] }),
    ).toBeUndefined();
    expect(makeBaseOpener({ kind: "urls", sourceId: "remote-file", urls: [] })).toBeUndefined();
    expect(
      makeBaseOpener({ kind: "files", sourceId: "x", files: [new File([], "a.bag")] }),
    ).toBeUndefined();
  });
});
