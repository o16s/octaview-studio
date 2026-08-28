// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * "replace" - clear any existing selection and select only this panel.
 * "toggle" - flip this panel's membership in the current (possibly multi-panel) selection.
 */
export type PanelClickSelectionAction = "replace" | "toggle";

/**
 * Decides what a click on a panel's root should do to the panel selection. Selection always
 * follows clicks (it's not gated behind any particular sidebar tab being open) - what the
 * selection is used for is up to whichever sidebar tab is currently active.
 */
export function decidePanelClickSelection({
  metaKey,
  shiftKey,
  isSelected,
}: {
  metaKey: boolean;
  shiftKey: boolean;
  isSelected: boolean;
}): PanelClickSelectionAction {
  if (metaKey || shiftKey || isSelected) {
    return "toggle";
  }
  return "replace";
}
