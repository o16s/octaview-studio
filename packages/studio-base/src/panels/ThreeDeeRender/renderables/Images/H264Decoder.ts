// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

const VIDEO_FORMATS = new Set(["h264"]);

/** Returns true if the given format string is a video codec handled by H264Decoder. */
export function isVideoFormat(format: string): boolean {
  return VIDEO_FORMATS.has(format);
}

/** Error thrown when a message contains only parameter sets (SPS/PPS) and no decodable frame. */
export class NoFrameError extends Error {
  public override name = "NoFrameError";
}

type PendingFrame = {
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: Error) => void;
};

/**
 * Parses H.264 Annex B byte stream to find NAL unit boundaries and types.
 */
function findNalUnits(data: Uint8Array): Array<{ offset: number; length: number; type: number }> {
  const nalUnits: Array<{ offset: number; length: number; type: number }> = [];
  let i = 0;

  while (i < data.length - 2) {
    if (data[i] === 0 && data[i + 1] === 0) {
      let startCodeLen: number;
      if (data[i + 2] === 1) {
        startCodeLen = 3;
      } else if (data[i + 2] === 0 && i + 3 < data.length && data[i + 3] === 1) {
        startCodeLen = 4;
      } else {
        i++;
        continue;
      }

      const nalStart = i + startCodeLen;
      if (nalStart >= data.length) {
        break;
      }

      const nalType = data[nalStart]! & 0x1f;

      if (nalUnits.length > 0) {
        const prev = nalUnits[nalUnits.length - 1]!;
        prev.length = i - prev.offset;
      }

      nalUnits.push({ offset: nalStart, length: data.length - nalStart, type: nalType });
      i = nalStart + 1;
    } else {
      i++;
    }
  }

  return nalUnits;
}

/**
 * Extracts the AVC codec string from an SPS NAL unit.
 * Format: avc1.{profile_idc}{constraint_flags}{level_idc} (hex)
 */
function extractCodecString(spsData: Uint8Array): string {
  if (spsData.length < 4) {
    return "avc1.42001e";
  }
  const profileIdc = spsData[1]!;
  const constraintFlags = spsData[2]!;
  const levelIdc = spsData[3]!;
  return `avc1.${profileIdc.toString(16).padStart(2, "0")}${constraintFlags.toString(16).padStart(2, "0")}${levelIdc.toString(16).padStart(2, "0")}`;
}

/**
 * WebCodecs-based H.264 video frame decoder.
 *
 * Decodes H.264 Annex B access units into ImageBitmap frames.
 * Uses a FIFO queue to correctly match decoded outputs to input promises,
 * even when multiple frames are in-flight concurrently.
 */
export class H264Decoder {
  #decoder: VideoDecoder | undefined;
  #codecString: string | undefined;
  #pendingFrames: PendingFrame[] = [];
  #keyframeSeen = false;

  /**
   * Decode an H.264 Annex B access unit into an ImageBitmap.
   *
   * @param data - Raw H.264 Annex B data (with start codes)
   * @param timestampNanos - Frame timestamp in nanoseconds
   * @returns Decoded frame as ImageBitmap
   * @throws NoFrameError if the data contains only parameter sets (no slice)
   */
  async decode(data: Uint8Array, timestampNanos: bigint): Promise<ImageBitmap> {
    const nalUnits = findNalUnits(data);

    let hasSlice = false;
    let isKeyframe = false;

    for (const nal of nalUnits) {
      if (nal.type === 7) {
        // SPS - extract codec string and reconfigure decoder if needed
        const spsData = data.subarray(nal.offset, nal.offset + nal.length);
        const codecString = extractCodecString(spsData);
        if (codecString !== this.#codecString) {
          this.#configure(codecString);
        }
      } else if (nal.type === 5) {
        // IDR slice (keyframe)
        hasSlice = true;
        isKeyframe = true;
      } else if (nal.type === 1) {
        // Non-IDR slice (delta frame)
        hasSlice = true;
      }
    }

    if (!hasSlice) {
      throw new NoFrameError("No video frame data (parameter sets only)");
    }

    if (!this.#decoder || this.#decoder.state !== "configured") {
      throw new Error("H.264 decoder not configured - waiting for keyframe with SPS");
    }

    // Drop delta frames until we've seen a keyframe
    if (!isKeyframe && !this.#keyframeSeen) {
      throw new NoFrameError("Waiting for keyframe");
    }

    if (isKeyframe) {
      this.#keyframeSeen = true;
    }

    const timestampMicros = Number(timestampNanos / 1000n);

    return new Promise<ImageBitmap>((resolve, reject) => {
      this.#pendingFrames.push({ resolve, reject });

      try {
        this.#decoder!.decode(
          new EncodedVideoChunk({
            type: isKeyframe ? "key" : "delta",
            timestamp: timestampMicros,
            data,
          }),
        );
      } catch (err) {
        // Remove the entry we just pushed since decode failed synchronously
        this.#pendingFrames.pop();
        reject(err as Error);
      }
    });
  }

  #configure(codecString: string): void {
    this.#codecString = codecString;
    this.#keyframeSeen = false;

    // Reject any pending frames from the old decoder
    this.#rejectAllPending("Decoder reconfigured");

    if (this.#decoder && this.#decoder.state !== "closed") {
      this.#decoder.close();
    }

    this.#decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        const pending = this.#pendingFrames.shift();
        if (!pending) {
          frame.close();
          return;
        }
        createImageBitmap(frame)
          .then((bitmap) => {
            frame.close();
            pending.resolve(bitmap);
          })
          .catch((err: Error) => {
            frame.close();
            pending.reject(err);
          });
      },
      error: (err: DOMException) => {
        this.#rejectAllPending(err.message);
      },
    });

    this.#decoder.configure({ codec: codecString });
  }

  #rejectAllPending(reason: string): void {
    const pending = this.#pendingFrames;
    this.#pendingFrames = [];
    for (const entry of pending) {
      entry.reject(new Error(reason));
    }
  }

  close(): void {
    this.#rejectAllPending("Decoder closed");
    if (this.#decoder && this.#decoder.state !== "closed") {
      this.#decoder.close();
    }
    this.#decoder = undefined;
    this.#codecString = undefined;
    this.#keyframeSeen = false;
  }
}
