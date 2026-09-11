// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import BrowserHttpReader from "@foxglove/studio-base/util/BrowserHttpReader";
import CachedFilelike from "@foxglove/studio-base/util/CachedFilelike";

/**
 * Byte cache for one open recording, when it is the only one open.
 *
 * CachedFilelike reads ahead to the end of the file whenever its cache is at
 * least the file size, so this number also decides whether a recording is read
 * whole or in windows.
 */
export const DEFAULT_CACHE_SIZE_IN_BYTES = 1024 * 1024 * 200; // 200MiB

/**
 * Smallest cache one source may get when several recordings share the budget.
 * CachedFilelike throws on a read larger than its cache, and one MCAP chunk can
 * be several MB, so the share must not become arbitrarily small.
 */
export const MIN_CACHE_SIZE_IN_BYTES = 1024 * 1024 * 16; // 16MiB

/**
 * Split the cache budget over the recordings that are open together.
 *
 * Each remote source holds its own cache, so N sources at the full size would
 * ask the browser for N times the budget.
 */
export function cacheSizeForSourceCount(sourceCount: number): number {
  if (sourceCount <= 1) {
    return DEFAULT_CACHE_SIZE_IN_BYTES;
  }
  return Math.max(MIN_CACHE_SIZE_IN_BYTES, Math.floor(DEFAULT_CACHE_SIZE_IN_BYTES / sourceCount));
}

export class RemoteFileReadable {
  #remoteReader: CachedFilelike;

  public constructor(url: string, cacheSizeInBytes: number = DEFAULT_CACHE_SIZE_IN_BYTES) {
    const fileReader = new BrowserHttpReader(url);
    this.#remoteReader = new CachedFilelike({ fileReader, cacheSizeInBytes });
  }

  public async open(): Promise<void> {
    await this.#remoteReader.open(); // Important that we call this first, because it might throw an error if the file can't be read.
  }

  public async size(): Promise<bigint> {
    return BigInt(this.#remoteReader.size());
  }
  public async read(offset: bigint, size: bigint): Promise<Uint8Array> {
    if (offset + size > Number.MAX_SAFE_INTEGER) {
      throw new Error(`Read too large: offset ${offset}, size ${size}`);
    }
    return await this.#remoteReader.read(Number(offset), Number(size));
  }
}
