// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export type SheetConfig = {
  /**
   * Topics to hide. Empty/undefined means "show every topic in the recording" —
   * the default, so a freshly-added panel shows everything and the user hides
   * topics from panel settings. Storing the hidden set (rather than the shown
   * set) means topics that load later stay visible by default.
   */
  hiddenTopics?: string[];
};

export const defaultSheetConfig: SheetConfig = {};
