// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import assert from "assert";
import { useEffect, useMemo } from "react";
import { useDebounce } from "use-debounce";

import Log from "@foxglove/log";
import { LOCAL_STORAGE_STUDIO_LAYOUT_KEY } from "@foxglove/studio-base/constants/localStorageKeys";
import {
  LayoutState,
  useCurrentLayoutActions,
  useCurrentLayoutSelector,
} from "@foxglove/studio-base/context/CurrentLayoutContext";
import { LayoutData } from "@foxglove/studio-base/context/CurrentLayoutContext/actions";
import { usePlayerSelection } from "@foxglove/studio-base/context/PlayerSelectionContext";
import { defaultLayout } from "@foxglove/studio-base/providers/CurrentLayoutProvider/defaultLayout";
import { migratePanelsState } from "@foxglove/studio-base/services/migrateLayout";

function selectLayoutData(state: LayoutState) {
  return state.selectedLayout?.data;
}

const log = Log.getLogger(__filename);

/**
 * Check whether the current URL provides a layout via ?layout= or ?layoutUrl=.
 * When true, this tab's layout is URL-driven and should NOT sync with localStorage.
 * This allows multiple browser tabs to each run their own layout independently.
 */
function hasUrlProvidedLayout(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  const params = new URLSearchParams(window.location.search);
  return params.has("layout") || params.has("layoutUrl");
}

export function CurrentLayoutLocalStorageSyncAdapter(): JSX.Element {
  const { selectedSource } = usePlayerSelection();

  const { setCurrentLayout } = useCurrentLayoutActions();
  const currentLayoutData = useCurrentLayoutSelector(selectLayoutData);

  // Computed once on mount — URL params don't change during the tab's lifetime
  const urlProvidesLayout = useMemo(() => hasUrlProvidedLayout(), []);

  useEffect(() => {
    if (selectedSource?.sampleLayout) {
      setCurrentLayout({ data: selectedSource.sampleLayout });
    }
  }, [selectedSource, setCurrentLayout]);

  const [debouncedLayoutData] = useDebounce(currentLayoutData, 250, { maxWait: 500 });

  // Save layout to localStorage (skip if this tab's layout came from URL params)
  useEffect(() => {
    if (urlProvidesLayout || !debouncedLayoutData) {
      return;
    }

    const serializedLayoutData = JSON.stringify(debouncedLayoutData);
    assert(serializedLayoutData);
    localStorage.setItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY, serializedLayoutData);
  }, [debouncedLayoutData, urlProvidesLayout]);

  // Load layout from localStorage on mount (skip if URL provides the layout)
  useEffect(() => {
    if (urlProvidesLayout) {
      log.debug("Layout provided by URL params — skipping localStorage restore");
      return;
    }

    log.debug(`Reading layout from local storage: ${LOCAL_STORAGE_STUDIO_LAYOUT_KEY}`);

    const serializedLayoutData = localStorage.getItem(LOCAL_STORAGE_STUDIO_LAYOUT_KEY);

    if (serializedLayoutData) {
      log.debug("Restoring layout from local storage");
    } else {
      log.debug("No layout found in local storage. Using default layout.");
    }

    const layoutData = migratePanelsState(
      serializedLayoutData ? (JSON.parse(serializedLayoutData) as LayoutData) : defaultLayout,
    );
    setCurrentLayout({ data: layoutData });
  }, [setCurrentLayout, urlProvidesLayout]);

  return <></>;
}
