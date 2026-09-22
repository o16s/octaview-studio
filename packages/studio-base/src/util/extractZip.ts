// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/**
 * Extract files from a ZIP archive. Supports Store (no compression) and Deflate
 * compressed entries. Returns an array of File objects with directory prefixes stripped.
 *
 * This is a minimal ZIP reader — it reads the central directory to find entries,
 * then extracts each file's data from its local file header.
 */
export async function extractFilesFromZip(zipFile: File): Promise<File[]> {
  const buffer = await zipFile.arrayBuffer();
  const data = new Uint8Array(buffer);
  const view = new DataView(buffer);

  // Find End of Central Directory record (search backwards from end)
  let eocdOffset = -1;
  for (let i = data.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) {
    throw new Error("Invalid ZIP file: End of Central Directory not found");
  }

  const entryCount = view.getUint16(eocdOffset + 10, true);
  const cdOffset = view.getUint32(eocdOffset + 16, true);

  const files: File[] = [];
  let pos = cdOffset;
  const decoder = new TextDecoder();

  for (let i = 0; i < entryCount; i++) {
    if (view.getUint32(pos, true) !== 0x02014b50) {
      throw new Error("Invalid ZIP file: bad central directory entry signature");
    }

    const compressionMethod = view.getUint16(pos + 10, true);
    const compressedSize = view.getUint32(pos + 20, true);
    const nameLength = view.getUint16(pos + 28, true);
    const extraLength = view.getUint16(pos + 30, true);
    const commentLength = view.getUint16(pos + 32, true);
    const localHeaderOffset = view.getUint32(pos + 42, true);

    const fullName = decoder.decode(data.subarray(pos + 46, pos + 46 + nameLength));
    pos += 46 + nameLength + extraLength + commentLength;

    // Skip directory entries
    if (fullName.endsWith("/")) {
      continue;
    }

    // Read local file header to find where file data starts
    const localNameLength = view.getUint16(localHeaderOffset + 26, true);
    const localExtraLength = view.getUint16(localHeaderOffset + 28, true);
    const fileDataOffset = localHeaderOffset + 30 + localNameLength + localExtraLength;

    let fileData: Uint8Array;
    if (compressionMethod === 0) {
      // Store — no compression
      fileData = data.slice(fileDataOffset, fileDataOffset + compressedSize);
    } else if (compressionMethod === 8) {
      // Deflate — use browser's DecompressionStream
      const compressed = data.slice(fileDataOffset, fileDataOffset + compressedSize);
      fileData = await decompressDeflateRaw(compressed);
    } else {
      throw new Error(`Unsupported compression method ${compressionMethod} for ${fullName}`);
    }

    // Strip directory prefix, keep only the filename
    const basename = fullName.split("/").pop() ?? fullName;
    files.push(new File([fileData], basename));
  }

  return files;
}

async function decompressDeflateRaw(compressed: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream("deflate-raw");
  const writer = ds.writable.getWriter();
  const reader = ds.readable.getReader();

  void writer.write(compressed);
  void writer.close();

  const chunks: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    chunks.push(value as Uint8Array);
  }

  const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
  const result = new Uint8Array(totalLength);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}
