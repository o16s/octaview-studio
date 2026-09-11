// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/** @jest-environment jsdom */

import McapServerDataSourceFactory, { storeDownloadedFiles } from "./McapServerDataSourceFactory";

// The factory launches a web worker only when the player initializes, which
// these tests never reach. Constructing one is enough to exercise the branch
// that picks between pre-downloaded files and remote URLs.
jest.mock("@foxglove/studio-base/players/IterablePlayer", () => ({
  IterablePlayer: jest.fn(),
  WorkerIterableSource: jest.fn(),
}));

describe("McapServerDataSourceFactory", () => {
  const factory = new McapServerDataSourceFactory();

  const initialize = (params: Record<string, string>) => factory.initialize({ params } as never);

  it("opens files that were downloaded beforehand", () => {
    storeDownloadedFiles("dl-1", [new File(["x"], "a.mcap")]);

    expect(initialize({ downloadId: "dl-1" })).toBeDefined();
  });

  it("uses each download id once", () => {
    storeDownloadedFiles("dl-2", [new File(["x"], "a.mcap")]);
    initialize({ downloadId: "dl-2" });

    // The second open finds nothing under that id and has no urls to fall back
    // on, so it must not give back a player for files that are already gone.
    expect(initialize({ downloadId: "dl-2" })).toBeUndefined();
  });

  it("opens one remote URL", () => {
    expect(initialize({ urls: `["/api/mcap/files/a.mcap"]` })).toBeDefined();
  });

  it("opens several remote URLs together", () => {
    const urls = `["/api/mcap/files/a.mcap","/api/mcap/files/b.mcap"]`;

    expect(initialize({ urls })).toBeDefined();
  });

  it("accepts a bare URL that is not a JSON array", () => {
    expect(initialize({ urls: "/api/mcap/files/a.mcap" })).toBeDefined();
  });

  it("returns no player when the parameters name nothing to open", () => {
    expect(initialize({})).toBeUndefined();
    expect(initialize({ urls: "[]" })).toBeUndefined();
  });
});
