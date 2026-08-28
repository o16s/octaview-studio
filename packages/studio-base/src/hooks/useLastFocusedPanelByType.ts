// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { create } from "zustand";

type LastFocusedPanelState = {
  lastFocusedPanelIdByType: Partial<Record<string, string>>;
};

const useStore = create<LastFocusedPanelState>(() => ({
  lastFocusedPanelIdByType: {},
}));

/** Records that the panel with the given id (of the given panel type) was just focused/clicked. */
export function setLastFocusedPanel(panelType: string, panelId: string): void {
  useStore.setState((state) => ({
    lastFocusedPanelIdByType: { ...state.lastFocusedPanelIdByType, [panelType]: panelId },
  }));
}

/** The id of the most recently focused panel of the given type, if any. */
export function useLastFocusedPanelByType(panelType: string): string | undefined {
  return useStore((state) => state.lastFocusedPanelIdByType[panelType]);
}
