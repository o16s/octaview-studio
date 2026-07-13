// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { findNalUnits, containsKeyframe } from "./H264Decoder";

// Helper to build an Annex B byte stream with the given NAL types
function buildAnnexB(...nalTypes: number[]): Uint8Array {
  const parts: number[] = [];
  for (const type of nalTypes) {
    // 4-byte start code
    parts.push(0, 0, 0, 1);
    // NAL header byte: forbidden_zero_bit(0) + nal_ref_idc(3) + nal_unit_type
    parts.push((3 << 5) | (type & 0x1f));
    // A few payload bytes
    parts.push(0xaa, 0xbb);
  }
  return new Uint8Array(parts);
}

describe("findNalUnits", () => {
  it("parses NAL units with 4-byte start codes", () => {
    const data = buildAnnexB(7, 8, 5); // SPS, PPS, IDR
    const nals = findNalUnits(data);
    expect(nals).toHaveLength(3);
    expect(nals.map((n) => n.type)).toEqual([7, 8, 5]);
  });

  it("parses NAL units with 3-byte start codes", () => {
    const parts = [0, 0, 1, (3 << 5) | 1, 0xaa, 0, 0, 1, (3 << 5) | 5, 0xbb];
    const data = new Uint8Array(parts);
    const nals = findNalUnits(data);
    expect(nals).toHaveLength(2);
    expect(nals.map((n) => n.type)).toEqual([1, 5]);
  });

  it("returns empty array for data with no start codes", () => {
    const data = new Uint8Array([0x41, 0x42, 0x43]);
    expect(findNalUnits(data)).toEqual([]);
  });
});

describe("containsKeyframe", () => {
  it("returns true when data contains an IDR NAL unit (type 5)", () => {
    const data = buildAnnexB(7, 8, 5); // SPS + PPS + IDR
    expect(containsKeyframe(data)).toBe(true);
  });

  it("returns false when data contains only delta frames (type 1)", () => {
    const data = buildAnnexB(1);
    expect(containsKeyframe(data)).toBe(false);
  });

  it("returns false when data contains only SPS/PPS (types 7, 8)", () => {
    const data = buildAnnexB(7, 8);
    expect(containsKeyframe(data)).toBe(false);
  });

  it("returns false for empty data", () => {
    expect(containsKeyframe(new Uint8Array([]))).toBe(false);
  });

  it("returns true when IDR is mixed with delta frames", () => {
    const data = buildAnnexB(7, 8, 5, 1, 1); // SPS + PPS + IDR + delta + delta
    expect(containsKeyframe(data)).toBe(true);
  });
});
