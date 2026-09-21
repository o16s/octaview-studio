// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";

import { LayoutData } from "@foxglove/studio-base/context/CurrentLayoutContext/actions";
import { defaultLayout } from "@foxglove/studio-base/providers/CurrentLayoutProvider/defaultLayout";
import { defaultPlaybackConfig } from "@foxglove/studio-base/providers/CurrentLayoutProvider/reducers";

const SHEET_PANEL_ID = "Sheet!default";

/**
 * True when `data` is still the stock default layout (or absent) — i.e. the user
 * hasn't built their own. Used to decide whether opening an MCAP may replace the
 * layout with a Sheet: a customized layout is preserved. Compares the mosaic
 * tree and the set of panel ids, both untouched by config migrations, rather
 * than panel config values.
 */
export function isPristineDefaultLayout(data: LayoutData | undefined): boolean {
  if (!data) {
    return true;
  }
  return (
    _.isEqual(data.layout, defaultLayout.layout) &&
    _.isEqual(Object.keys(data.configById).sort(), Object.keys(defaultLayout.configById).sort())
  );
}

/**
 * A layout that is a single, full-window Sheet panel. Used as the layout when
 * an MCAP file is opened without one, so the recording lands straight in a
 * spreadsheet view.
 */
export function makeSingleSheetLayout(): LayoutData {
  return {
    configById: { [SHEET_PANEL_ID]: {} },
    globalVariables: {},
    userNodes: {},
    playbackConfig: { ...defaultPlaybackConfig },
    layout: SHEET_PANEL_ID,
  };
}
