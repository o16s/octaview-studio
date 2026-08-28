// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { parseEdgeHubCredentials, serializeEdgeHubCredentials } from "./edgeHubCredentials";

describe("serializeEdgeHubCredentials / parseEdgeHubCredentials", () => {
  it("round-trips a valid ip/token pair", () => {
    const serialized = serializeEdgeHubCredentials({ ip: "192.168.1.100", token: "abc123" });
    expect(parseEdgeHubCredentials(serialized)).toEqual({ ip: "192.168.1.100", token: "abc123" });
  });

  it("returns undefined for malformed JSON", () => {
    expect(parseEdgeHubCredentials("not json")).toBeUndefined();
  });

  it("returns undefined when required fields are missing", () => {
    expect(parseEdgeHubCredentials(JSON.stringify({ ip: "192.168.1.100" }))).toBeUndefined();
    expect(parseEdgeHubCredentials(JSON.stringify({ token: "abc123" }))).toBeUndefined();
    expect(parseEdgeHubCredentials("{}")).toBeUndefined();
  });

  it("returns undefined when fields are the wrong type", () => {
    expect(parseEdgeHubCredentials(JSON.stringify({ ip: 1, token: "abc123" }))).toBeUndefined();
  });

  it("returns undefined for undefined input", () => {
    expect(parseEdgeHubCredentials(undefined)).toBeUndefined();
  });
});
