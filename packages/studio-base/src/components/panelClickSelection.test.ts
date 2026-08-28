// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { decidePanelClickSelection } from "./panelClickSelection";

describe("decidePanelClickSelection", () => {
  it("toggles when meta key is held", () => {
    expect(decidePanelClickSelection({ metaKey: true, shiftKey: false, isSelected: false })).toBe(
      "toggle",
    );
  });

  it("toggles when shift key is held", () => {
    expect(decidePanelClickSelection({ metaKey: false, shiftKey: true, isSelected: false })).toBe(
      "toggle",
    );
  });

  it("toggles (deselects) a plain click on an already-selected panel", () => {
    expect(decidePanelClickSelection({ metaKey: false, shiftKey: false, isSelected: true })).toBe(
      "toggle",
    );
  });

  it("replaces the selection with just this panel on a plain click of an unselected panel", () => {
    expect(
      decidePanelClickSelection({ metaKey: false, shiftKey: false, isSelected: false }),
    ).toBe("replace");
  });
});
