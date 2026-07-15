// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { websocketCloseMessage } from "./websocketCloseMessage";

describe("websocketCloseMessage", () => {
  it("returns a specific message for code 1008 (policy violation / auth)", () => {
    const msg = websocketCloseMessage(1008, "token expired");
    expect(msg).toContain("token expired");
  });

  it("returns a specific message for code 1000 (normal closure)", () => {
    const msg = websocketCloseMessage(1000, "");
    expect(msg).toContain("1000");
  });

  it("includes the close code in the message", () => {
    const msg = websocketCloseMessage(1006, "");
    expect(msg).toContain("1006");
  });

  it("includes the reason when provided", () => {
    const msg = websocketCloseMessage(1001, "server shutting down");
    expect(msg).toContain("server shutting down");
  });

  it("handles undefined code gracefully", () => {
    const msg = websocketCloseMessage(undefined, undefined);
    expect(msg).toMatch(/connection/i);
  });

  it("returns a meaningful message for code 1003 (unsupported data)", () => {
    const msg = websocketCloseMessage(1003, "");
    expect(msg).toContain("1003");
  });
});
