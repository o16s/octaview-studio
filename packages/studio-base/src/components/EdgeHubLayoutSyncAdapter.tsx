// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { useEffect, useRef } from "react";
import { useDebounce } from "use-debounce";

import { AppSetting } from "@foxglove/studio-base/AppSetting";
import {
  LayoutState,
  useCurrentLayoutActions,
  useCurrentLayoutSelector,
} from "@foxglove/studio-base/context/CurrentLayoutContext";
import {
  parseEdgeHubLayouts,
  serializeEdgeHubLayouts,
  setEdgeHubLayout,
} from "@foxglove/studio-base/dataSources/edgeHubLayouts";
import { useActiveEdgeHubIp } from "@foxglove/studio-base/dataSources/useActiveEdgeHubIp";
import { useAppConfigurationValue } from "@foxglove/studio-base/hooks/useAppConfigurationValue";

function selectLayoutData(state: LayoutState) {
  return state.selectedLayout?.data;
}

/**
 * Each saved Edge Hub connection remembers its own last-used layout: when you
 * reconnect to a hub you've connected to before, its layout is restored; while
 * connected, layout changes are saved for that specific hub (not the global
 * layout). This coexists with CurrentLayoutLocalStorageSyncAdapter, which keeps
 * handling the single global "current layout" fallback for everything else (local
 * files, connections that were never saved, etc.) - this adapter only acts while
 * there's an active *saved* Edge Hub connection.
 */
export function EdgeHubLayoutSyncAdapter(): JSX.Element {
  const activeIp = useActiveEdgeHubIp();
  const { setCurrentLayout } = useCurrentLayoutActions();
  const currentLayoutData = useCurrentLayoutSelector(selectLayoutData);
  const [serializedLayouts, setSerializedLayouts] = useAppConfigurationValue<string>(
    AppSetting.EDGE_HUB_LAYOUTS,
  );

  // Latest value for the restore effect below to read without needing to
  // re-run every time the config value changes (e.g. right after this same
  // adapter just wrote to it) - only actual ip changes should trigger a restore.
  const serializedLayoutsRef = useRef(serializedLayouts);
  serializedLayoutsRef.current = serializedLayouts;

  const previousIpRef = useRef<string | undefined>();
  useEffect(() => {
    if (activeIp == undefined || activeIp === previousIpRef.current) {
      return;
    }
    previousIpRef.current = activeIp;
    const saved = parseEdgeHubLayouts(serializedLayoutsRef.current)[activeIp];
    if (saved) {
      setCurrentLayout({ data: saved });
    }
  }, [activeIp, setCurrentLayout]);

  const [debouncedLayoutData] = useDebounce(currentLayoutData, 250, { maxWait: 500 });
  useEffect(() => {
    if (activeIp == undefined || !debouncedLayoutData) {
      return;
    }
    const layouts = parseEdgeHubLayouts(serializedLayoutsRef.current);
    void setSerializedLayouts(
      serializeEdgeHubLayouts(setEdgeHubLayout(layouts, activeIp, debouncedLayoutData)),
    );
  }, [activeIp, debouncedLayoutData, setSerializedLayouts]);

  return <></>;
}
