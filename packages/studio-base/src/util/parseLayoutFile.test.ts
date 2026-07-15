// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { parseLayoutFile } from "./parseLayoutFile";

function makeFile(content: string, name = "layout.json"): File {
  return new File([content], name, { type: "application/json" });
}

function json(obj: unknown): string {
  return JSON.stringify(obj) ?? "";
}

describe("parseLayoutFile", () => {
  it("parses a valid layout with configById and layout fields", async () => {
    const layout = { configById: {}, layout: "Panel!abc", globalVariables: {}, userNodes: {}, playbackConfig: { speed: 1 } };
    const result = await parseLayoutFile(makeFile(json(layout)));
    expect(result).toEqual(layout);
  });

  it("parses a layout with only configById", async () => {
    const layout = { configById: { "Panel!abc": { key: "val" } } };
    const result = await parseLayoutFile(makeFile(json(layout)));
    expect(result).toEqual(layout);
  });

  it("parses a layout with only layout field", async () => {
    const layout = { layout: "Panel!abc" };
    const result = await parseLayoutFile(makeFile(json(layout)));
    expect(result).toEqual(layout);
  });

  it("returns undefined for invalid JSON", async () => {
    const result = await parseLayoutFile(makeFile("not json"));
    expect(result).toBeUndefined();
  });

  it("returns undefined for a JSON array", async () => {
    const result = await parseLayoutFile(makeFile("[1, 2, 3]"));
    expect(result).toBeUndefined();
  });

  it("returns undefined for a JSON object without layout fields", async () => {
    const result = await parseLayoutFile(makeFile(json({ unrelated: true })));
    expect(result).toBeUndefined();
  });

  it("returns undefined for null JSON", async () => {
    const result = await parseLayoutFile(makeFile("null"));
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty string", async () => {
    const result = await parseLayoutFile(makeFile(""));
    expect(result).toBeUndefined();
  });
});
