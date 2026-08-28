/** @jest-environment jsdom */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { act, renderHook, waitFor } from "@testing-library/react";

import { getSecureStorage, SecureStorage } from "@foxglove/studio-base/services/secureStorage";

import {
  refreshEdgeHubConnections,
  saveEdgeHubConnection,
  useEdgeHubConnections,
} from "./edgeHubConnectionsStore";

jest.mock("@foxglove/studio-base/services/secureStorage");

function makeFakeSecureStorage(initial: Record<string, string> = {}): SecureStorage {
  const data = { ...initial };
  return {
    get: async (key) => data[key],
    set: async (key, value) => {
      data[key] = value;
      return true;
    },
    delete: async (key) => {
      delete data[key];
    },
  };
}

describe("edgeHubConnectionsStore", () => {
  beforeEach(async () => {
    // Reset the shared store between tests.
    (getSecureStorage as jest.Mock).mockReturnValue(makeFakeSecureStorage());
    await refreshEdgeHubConnections();
  });

  it("starts empty when there's nothing saved", () => {
    const { result } = renderHook(() => useEdgeHubConnections());
    expect(result.current).toEqual([]);
  });

  it("refreshEdgeHubConnections loads what's on disk into the reactive store", async () => {
    const storage = makeFakeSecureStorage({
      "edge-hub-connections": JSON.stringify([{ ip: "192.168.1.100", token: "abc123" }]) ?? "",
    });
    (getSecureStorage as jest.Mock).mockReturnValue(storage);

    const { result } = renderHook(() => useEdgeHubConnections());
    await act(async () => {
      await refreshEdgeHubConnections();
    });

    await waitFor(() => {
      expect(result.current).toEqual([{ ip: "192.168.1.100", token: "abc123" }]);
    });
  });

  it("saveEdgeHubConnection updates the reactive store immediately, without a remount", async () => {
    const { result } = renderHook(() => useEdgeHubConnections());
    expect(result.current).toEqual([]);

    await act(async () => {
      await saveEdgeHubConnection({ ip: "10.0.0.1", token: "xyz789" });
    });

    await waitFor(() => {
      expect(result.current).toEqual([{ ip: "10.0.0.1", token: "xyz789" }]);
    });
  });

  it("saveEdgeHubConnection reads fresh from disk before upserting, so it never clobbers a connection saved by another tab/session that the in-memory store hasn't loaded yet", async () => {
    // Simulate: disk already has a connection that this session's in-memory store
    // has never loaded (e.g. saved from a previous app run).
    const storage = makeFakeSecureStorage({
      "edge-hub-connections": JSON.stringify([{ ip: "192.168.1.100", token: "abc123" }]) ?? "",
    });
    (getSecureStorage as jest.Mock).mockReturnValue(storage);

    // Note: no refreshEdgeHubConnections() call here - the in-memory store is still empty.
    await saveEdgeHubConnection({ ip: "10.0.0.1", token: "xyz789" });

    const onDisk = await storage.get("edge-hub-connections");
    expect(JSON.parse(onDisk!)).toEqual([
      { ip: "192.168.1.100", token: "abc123" },
      { ip: "10.0.0.1", token: "xyz789" },
    ]);
  });
});
