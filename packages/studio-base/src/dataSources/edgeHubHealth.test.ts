// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { fetchEdgeHubHealth } from "./edgeHubHealth";

describe("fetchEdgeHubHealth", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("fetches the healthz endpoint at the expected url and returns parsed status/version", async () => {
    const mockFetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => await Promise.resolve({ status: "ok", version: "main" }),
    });
    global.fetch = mockFetch as unknown as typeof fetch;

    const health = await fetchEdgeHubHealth("192.168.1.100");

    expect(mockFetch).toHaveBeenCalledWith(
      "https://192.168.1.100:8443/healthz",
      expect.objectContaining({ signal: expect.anything() }),
    );
    expect(health).toEqual({ status: "ok", version: "main" });
  });

  it("returns undefined when the response is not ok", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false }) as unknown as typeof fetch;
    expect(await fetchEdgeHubHealth("192.168.1.100")).toBeUndefined();
  });

  it("returns undefined when fetch rejects (device unreachable)", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("network error")) as unknown as typeof fetch;
    expect(await fetchEdgeHubHealth("192.168.1.100")).toBeUndefined();
  });

  it("returns undefined when the response body is malformed", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => await Promise.resolve({ status: "ok" }), // missing version
    }) as unknown as typeof fetch;
    expect(await fetchEdgeHubHealth("192.168.1.100")).toBeUndefined();
  });
});
