// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { BlobReadable } from "./BlobReadable";

/** Blob-like backed by a byte array, counting how many underlying reads occur. */
function makeFakeBlob(bytes: Uint8Array): { blob: Blob; reads: () => number } {
  let reads = 0;
  const blob = {
    size: bytes.length,
    slice(start: number, end: number) {
      return {
        async arrayBuffer() {
          reads++;
          return bytes.slice(start, end).buffer;
        },
      };
    },
  } as unknown as Blob;
  return { blob, reads: () => reads };
}

function pattern(len: number): Uint8Array {
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    out[i] = i % 251;
  }
  return out;
}

describe("BlobReadable", () => {
  it("returns correct bytes for arbitrary reads", async () => {
    const data = pattern(100_000);
    const { blob } = makeFakeBlob(data);
    const readable = new BlobReadable(blob);

    expect(await readable.size()).toBe(100_000n);
    expect(await readable.read(0n, 10n)).toEqual(data.slice(0, 10));
    expect(await readable.read(99_990n, 10n)).toEqual(data.slice(99_990, 100_000));
    expect(await readable.read(12_345n, 6_789n)).toEqual(data.slice(12_345, 12_345 + 6_789));
  });

  it("serves many small sequential reads from one underlying read", async () => {
    const data = pattern(1_000_000);
    const { blob, reads } = makeFakeBlob(data);
    const readable = new BlobReadable(blob);

    // 100 sequential 10 KB reads — the mcap chunk-read pattern.
    for (let i = 0; i < 100; i++) {
      const offset = i * 10_000;
      const got = await readable.read(BigInt(offset), 10_000n);
      expect(Buffer.from(got).equals(Buffer.from(data.slice(offset, offset + 10_000)))).toBe(true);
    }
    expect(reads()).toBe(1);
  });

  it("still answers correctly after a far seek", async () => {
    const data = pattern(20_000_000);
    const { blob } = makeFakeBlob(data);
    const readable = new BlobReadable(blob);

    expect(await readable.read(0n, 100n)).toEqual(data.slice(0, 100));
    // Seek far past any readahead window
    expect(await readable.read(19_000_000n, 100n)).toEqual(data.slice(19_000_000, 19_000_100));
    // And back
    expect(await readable.read(50n, 100n)).toEqual(data.slice(50, 150));
  });

  it("handles reads larger than the readahead window", async () => {
    const data = pattern(10_000_000);
    const { blob } = makeFakeBlob(data);
    const readable = new BlobReadable(blob);

    const big = await readable.read(1_000n, 8_000_000n);
    expect(big.length).toBe(8_000_000);
    expect(Buffer.from(big).equals(Buffer.from(data.slice(1_000, 8_001_000)))).toBe(true);
  });

  it("clamps the readahead window at end of file", async () => {
    const data = pattern(5_000);
    const { blob } = makeFakeBlob(data);
    const readable = new BlobReadable(blob);

    expect(await readable.read(4_000n, 1_000n)).toEqual(data.slice(4_000, 5_000));
  });

  it("rejects reads past the end of the file", async () => {
    const { blob } = makeFakeBlob(pattern(1_000));
    const readable = new BlobReadable(blob);
    await expect(readable.read(500n, 1_000n)).rejects.toThrow(/exceeds file size/);
  });
});
