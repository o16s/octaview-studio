// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { apiUrl, getApiBase, getServerConfig, hasDownloads, isServerMode } from "./serverConfig";

type Mutable = Record<string, unknown>;

function setServerConfig(value: unknown): void {
  if (value === undefined) {
    delete (globalThis as Mutable).OCTAVIEW_STUDIO_SERVER;
  } else {
    (globalThis as Mutable).OCTAVIEW_STUDIO_SERVER = value;
  }
}

describe("serverConfig", () => {
  const original = (globalThis as Mutable).OCTAVIEW_STUDIO_SERVER;
  afterEach(() => {
    setServerConfig(original);
  });

  it("reports browser-only mode when the server injected nothing", () => {
    setServerConfig(undefined);
    expect(getServerConfig()).toBeUndefined();
    expect(isServerMode()).toBe(false);
    expect(getApiBase()).toBe("");
    expect(hasDownloads()).toBe(false);
  });

  it("reads the injected config", () => {
    setServerConfig({ apiBase: "", hasDownloads: true });
    expect(isServerMode()).toBe(true);
    expect(getApiBase()).toBe("");
    expect(hasDownloads()).toBe(true);
  });

  it("returns the path prefix the server is mounted under", () => {
    setServerConfig({ apiBase: "/svc/octaview-studio" });
    expect(getApiBase()).toBe("/svc/octaview-studio");
  });

  it("ignores a non-object config", () => {
    setServerConfig("nonsense");
    expect(isServerMode()).toBe(false);
    expect(getApiBase()).toBe("");
  });

  describe("apiUrl", () => {
    it("is root-absolute when served at the root", () => {
      setServerConfig({ apiBase: "" });
      expect(apiUrl("/api/mcap/index")).toBe("/api/mcap/index");
    });

    it("carries the path prefix when served behind a proxy", () => {
      setServerConfig({ apiBase: "/svc/octaview-studio" });
      expect(apiUrl("/api/mcap/index")).toBe("/svc/octaview-studio/api/mcap/index");
    });

    it("works with no injected config at all", () => {
      setServerConfig(undefined);
      expect(apiUrl("/api/downloads")).toBe("/api/downloads");
    });
  });
});
