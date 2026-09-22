// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { extractFilesFromZip } from "./extractZip";
import { buildStoreZip } from "./extractZip.test.helpers";

describe("extractFilesFromZip", () => {
  it("extracts files from a Store-mode ZIP", async () => {
    const zip = buildStoreZip([
      { name: "test.mcap", data: new Uint8Array([1, 2, 3]) },
      { name: "other.mcap", data: new Uint8Array([4, 5]) },
    ]);
    const zipFile = new File([zip], "archive.zip");

    const files = await extractFilesFromZip(zipFile);
    expect(files).toHaveLength(2);
    expect(files[0]!.name).toBe("test.mcap");
    expect(new Uint8Array(await files[0]!.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(files[1]!.name).toBe("other.mcap");
    expect(new Uint8Array(await files[1]!.arrayBuffer())).toEqual(new Uint8Array([4, 5]));
  });

  it("strips directory prefixes from filenames", async () => {
    const zip = buildStoreZip([{ name: "folder/sub/recording.mcap", data: new Uint8Array([10]) }]);
    const zipFile = new File([zip], "archive.zip");

    const files = await extractFilesFromZip(zipFile);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("recording.mcap");
  });

  it("skips directory entries (name ends with /)", async () => {
    const zip = buildStoreZip([
      { name: "folder/", data: new Uint8Array(0) },
      { name: "folder/data.mcap", data: new Uint8Array([7]) },
    ]);
    const zipFile = new File([zip], "archive.zip");

    const files = await extractFilesFromZip(zipFile);
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("data.mcap");
  });

  it("returns empty array for ZIP with no entries", async () => {
    const zip = buildStoreZip([]);
    const zipFile = new File([zip], "empty.zip");

    const files = await extractFilesFromZip(zipFile);
    expect(files).toHaveLength(0);
  });

  it("handles large file entries correctly", async () => {
    const bigData = new Uint8Array(100_000);
    for (let i = 0; i < bigData.length; i++) {
      bigData[i] = i % 256;
    }
    const zip = buildStoreZip([{ name: "big.mcap", data: bigData }]);
    const zipFile = new File([zip], "big.zip");

    const files = await extractFilesFromZip(zipFile);
    expect(files).toHaveLength(1);
    expect(new Uint8Array(await files[0]!.arrayBuffer())).toEqual(bigData);
  });
});
