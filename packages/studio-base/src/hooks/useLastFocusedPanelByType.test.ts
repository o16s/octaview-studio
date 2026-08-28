/** @jest-environment jsdom */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { renderHook } from "@testing-library/react";

import {
  setLastFocusedPanel,
  useLastFocusedPanelByType,
} from "./useLastFocusedPanelByType";

describe("useLastFocusedPanelByType", () => {
  it("returns undefined for a type that has never been focused", () => {
    const { result } = renderHook(() => useLastFocusedPanelByType("Plot"));
    expect(result.current).toBeUndefined();
  });

  it("returns the most recently focused panel id for that type", () => {
    setLastFocusedPanel("Plot", "Plot!abc");
    const { result } = renderHook(() => useLastFocusedPanelByType("Plot"));
    expect(result.current).toBe("Plot!abc");
  });

  it("tracks each panel type independently", () => {
    setLastFocusedPanel("Plot", "Plot!abc");
    setLastFocusedPanel("StateTransitions", "StateTransitions!def");

    const { result: plotResult } = renderHook(() => useLastFocusedPanelByType("Plot"));
    const { result: stateTransitionsResult } = renderHook(() =>
      useLastFocusedPanelByType("StateTransitions"),
    );

    expect(plotResult.current).toBe("Plot!abc");
    expect(stateTransitionsResult.current).toBe("StateTransitions!def");
  });

  it("overwrites the previous focused panel id for the same type", () => {
    setLastFocusedPanel("Plot", "Plot!abc");
    setLastFocusedPanel("Plot", "Plot!xyz");
    const { result } = renderHook(() => useLastFocusedPanelByType("Plot"));
    expect(result.current).toBe("Plot!xyz");
  });
});
