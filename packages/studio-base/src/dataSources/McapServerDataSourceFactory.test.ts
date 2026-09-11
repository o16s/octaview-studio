// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/** @jest-environment jsdom */

import McapServerDataSourceFactory, {
  getCurrentFiles,
  storeDownloadedFiles,
} from "./McapServerDataSourceFactory";

// The factory launches a web worker only when the player initializes, which
// these tests never reach. Constructing one is enough to exercise the branch
// that decides what "Export recordings as ZIP" can hand out.
jest.mock("@foxglove/studio-base/players/IterablePlayer", () => ({
  IterablePlayer: jest.fn(),
  WorkerIterableSource: jest.fn(),
}));

describe("McapServerDataSourceFactory", () => {
  const factory = new McapServerDataSourceFactory();

  const openDownloaded = (name: string) => {
    const id = `test-${name}`;
    storeDownloadedFiles(id, [new File(["x"], name)]);
    return factory.initialize({ params: { downloadId: id } } as never);
  };

  it("keeps downloaded files for the ZIP export", () => {
    openDownloaded("a.mcap");

    expect(getCurrentFiles()?.map((f) => f.name)).toEqual(["a.mcap"]);
  });

  it("has no files to export after opening by URL", () => {
    openDownloaded("a.mcap");
    factory.initialize({
      params: { urls: JSON.stringify(["/api/mcap/files/b.mcap"]) },
    } as never);

    // Not the stale ["a.mcap"]: a URL source is read by byte range, so no whole
    // file exists, and the export must report that rather than write out the
    // recording opened before this one.
    expect(getCurrentFiles()).toBeUndefined();
  });

  it("returns no player when the parameters name nothing to open", () => {
    expect(factory.initialize({ params: {} } as never)).toBeUndefined();
    expect(factory.initialize({ params: { urls: "[]" } } as never)).toBeUndefined();
  });
});
