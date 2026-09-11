// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { parseFileDeepLink } from "./fileDeepLink";

// Stand-ins for mcapFileUrl at the root and behind edge-hub's reverse proxy.
const atRoot = (path: string) => `/api/mcap/files/${encodeURIComponent(path)}`;
const behindProxy = (path: string) =>
  `/svc/octaview-studio/api/mcap/files/${encodeURIComponent(path)}`;

describe("parseFileDeepLink", () => {
  it("returns undefined when the link names no file", () => {
    expect(parseFileDeepLink("", atRoot)).toBeUndefined();
    expect(parseFileDeepLink("?layout=abc", atRoot)).toBeUndefined();
    expect(parseFileDeepLink("?file=", atRoot)).toBeUndefined();
  });

  it("encodes the absolute path as one segment", () => {
    const link = parseFileDeepLink(
      "?file=%2Fmnt%2Fdatalog%2Ftsend2mqtt%2F2026-09-01T04-08-37Z_0081.mcap",
      atRoot,
    );

    expect(link?.filePath).toBe("/mnt/datalog/tsend2mqtt/2026-09-01T04-08-37Z_0081.mcap");
    expect(link?.fileUrl).toBe(
      "/api/mcap/files/%2Fmnt%2Fdatalog%2Ftsend2mqtt%2F2026-09-01T04-08-37Z_0081.mcap",
    );
  });

  it("names the recording by its file name alone", () => {
    expect(parseFileDeepLink("?file=%2Fmnt%2Fdatalog%2Fa%2Fb.mcap", atRoot)?.displayName).toBe(
      "b.mcap",
    );
    expect(parseFileDeepLink("?file=b.mcap", atRoot)?.displayName).toBe("b.mcap");
  });

  it("keeps the whole path when it ends with a slash", () => {
    expect(parseFileDeepLink("?file=%2Fmnt%2Fdatalog%2F", atRoot)?.displayName).toBe(
      "/mnt/datalog/",
    );
  });

  it("keeps a space in the file name", () => {
    const link = parseFileDeepLink("?file=%2Fmnt%2Fdatalog%2Fa%20b.mcap", atRoot);

    expect(link?.displayName).toBe("a b.mcap");
    expect(link?.fileUrl).toBe("/api/mcap/files/%2Fmnt%2Fdatalog%2Fa%20b.mcap");
  });

  it("puts the server base path in front of the route", () => {
    expect(parseFileDeepLink("?file=%2Fmnt%2Fdatalog%2Fb.mcap", behindProxy)?.fileUrl).toBe(
      "/svc/octaview-studio/api/mcap/files/%2Fmnt%2Fdatalog%2Fb.mcap",
    );
  });

  it("ignores the other parameters the hub sends", () => {
    const link = parseFileDeepLink(
      "?file=%2Fmnt%2Fdatalog%2Fb.mcap&layout=eyJ4IjoxfQ&token=s3cr",
      atRoot,
    );

    expect(link?.filePath).toBe("/mnt/datalog/b.mcap");
    expect(link?.fileUrl).toBe("/api/mcap/files/%2Fmnt%2Fdatalog%2Fb.mcap");
  });
});
