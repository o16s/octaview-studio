// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * How much to read from the underlying Blob per miss. Indexed MCAP reading is
 * dominated by thousands of small, mostly-sequential chunk reads (a profiled
 * recording had 33k chunks of ~13 KB); each `Blob.slice().arrayBuffer()` call
 * carries fixed browser overhead, so serving them from one readahead window
 * removes ~all of that cost for one window's worth of memory per open file.
 */
const READAHEAD_SIZE = 4 * 1024 * 1024;

export class BlobReadable {
  #buf: Uint8Array | undefined;
  #bufStart = 0;

  public constructor(private file: Blob) {}
  public async size(): Promise<bigint> {
    return BigInt(this.file.size);
  }
  public async read(offset: bigint, size: bigint): Promise<Uint8Array> {
    if (offset + size > this.file.size) {
      throw new Error(
        `Read of ${size} bytes at offset ${offset} exceeds file size ${this.file.size}`,
      );
    }
    const start = Number(offset);
    const length = Number(size);

    // Oversized reads bypass the window (and would only thrash it).
    if (length > READAHEAD_SIZE) {
      return new Uint8Array(await this.file.slice(start, start + length).arrayBuffer());
    }

    const win = this.#buf;
    if (
      win == undefined ||
      start < this.#bufStart ||
      start + length > this.#bufStart + win.length
    ) {
      const end = Math.min(this.file.size, start + Math.max(length, READAHEAD_SIZE));
      this.#buf = new Uint8Array(await this.file.slice(start, end).arrayBuffer());
      this.#bufStart = start;
    }

    // Copy out so callers never hold references into the (reused) window.
    return this.#buf!.slice(start - this.#bufStart, start - this.#bufStart + length);
  }
}
