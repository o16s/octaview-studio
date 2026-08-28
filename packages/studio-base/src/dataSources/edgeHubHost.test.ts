// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { buildEdgeHubHost, buildEdgeHubWebSocketUrl } from "./edgeHubHost";

describe("buildEdgeHubHost", () => {
  it("appends the default port when the ip has none", () => {
    expect(buildEdgeHubHost("192.168.1.100")).toBe("192.168.1.100:8443");
  });

  it("appends the default port for a bare hostname", () => {
    expect(buildEdgeHubHost("bl335")).toBe("bl335:8443");
  });

  it("leaves an explicit port untouched", () => {
    expect(buildEdgeHubHost("192.168.1.100:9000")).toBe("192.168.1.100:9000");
  });
});

describe("buildEdgeHubWebSocketUrl", () => {
  it("builds the wss url with the default port", () => {
    expect(buildEdgeHubWebSocketUrl("192.168.1.100")).toBe(
      "wss://192.168.1.100:8443/api/v1/ws",
    );
  });

  it("respects an explicit port", () => {
    expect(buildEdgeHubWebSocketUrl("bl335:9000")).toBe("wss://bl335:9000/api/v1/ws");
  });
});
