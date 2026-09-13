// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { desktopFileSourceSelection } from "./desktopFileSource";

describe("desktopFileSourceSelection", () => {
  it("turns a desktop open-file payload into an mcap-server URL selection", () => {
    const selection = desktopFileSourceSelection({
      url: "mcap-local://file/%2Fhome%2Fsam%2Frun.mcap",
      name: "run.mcap",
    });

    expect(selection).toEqual({
      sourceId: "mcap-server",
      args: {
        type: "connection",
        params: { urls: JSON.stringify(["mcap-local://file/%2Fhome%2Fsam%2Frun.mcap"]) },
      },
    });
  });

  it("returns undefined when there is no url to open", () => {
    expect(desktopFileSourceSelection(undefined)).toBeUndefined();
    expect(desktopFileSourceSelection({ url: "" })).toBeUndefined();
    expect(desktopFileSourceSelection({ url: "   " })).toBeUndefined();
  });
});
