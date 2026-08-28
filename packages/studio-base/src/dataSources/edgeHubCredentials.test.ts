// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  parseEdgeHubConnections,
  serializeEdgeHubConnections,
  upsertEdgeHubConnection,
} from "./edgeHubCredentials";

describe("serializeEdgeHubConnections / parseEdgeHubConnections", () => {
  it("round-trips multiple connections", () => {
    const connections = [
      { ip: "192.168.1.100", token: "abc123" },
      { ip: "bl335", token: "def456" },
    ];
    expect(parseEdgeHubConnections(serializeEdgeHubConnections(connections))).toEqual(
      connections,
    );
  });

  it("round-trips an empty list", () => {
    expect(parseEdgeHubConnections(serializeEdgeHubConnections([]))).toEqual([]);
  });

  it("returns an empty array for undefined input", () => {
    expect(parseEdgeHubConnections(undefined)).toEqual([]);
  });

  it("returns an empty array for malformed JSON", () => {
    expect(parseEdgeHubConnections("not json")).toEqual([]);
  });

  it("returns an empty array when the top-level value isn't an array", () => {
    expect(parseEdgeHubConnections(JSON.stringify({ ip: "1.2.3.4", token: "x" }))).toEqual([]);
  });

  it("filters out individually malformed entries rather than discarding the whole list", () => {
    const serialized = JSON.stringify([
      { ip: "192.168.1.100", token: "abc123" },
      { ip: "missing-token" },
      "not an object",
      { ip: "10.0.0.1", token: "xyz789" },
    ]);
    expect(parseEdgeHubConnections(serialized)).toEqual([
      { ip: "192.168.1.100", token: "abc123" },
      { ip: "10.0.0.1", token: "xyz789" },
    ]);
  });
});

describe("upsertEdgeHubConnection", () => {
  it("appends a new connection for a new ip", () => {
    const existing = [{ ip: "192.168.1.100", token: "abc123" }];
    expect(upsertEdgeHubConnection(existing, { ip: "10.0.0.1", token: "xyz789" })).toEqual([
      { ip: "192.168.1.100", token: "abc123" },
      { ip: "10.0.0.1", token: "xyz789" },
    ]);
  });

  it("updates the token in place for an existing ip, without reordering", () => {
    const existing = [
      { ip: "192.168.1.100", token: "old-token" },
      { ip: "10.0.0.1", token: "xyz789" },
    ];
    expect(upsertEdgeHubConnection(existing, { ip: "192.168.1.100", token: "new-token" })).toEqual(
      [
        { ip: "192.168.1.100", token: "new-token" },
        { ip: "10.0.0.1", token: "xyz789" },
      ],
    );
  });

  it("starts a new list when given an empty one", () => {
    expect(upsertEdgeHubConnection([], { ip: "192.168.1.100", token: "abc123" })).toEqual([
      { ip: "192.168.1.100", token: "abc123" },
    ]);
  });
});
