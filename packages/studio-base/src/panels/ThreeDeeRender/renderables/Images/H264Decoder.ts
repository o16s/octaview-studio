// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { perfStats } from "@foxglove/studio-base/util/perfStats";

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
  resolve: (bitmap: ImageBitmap | undefined) => void;
  reject: (error: Error) => void;
  /**
   * When set and true at output time, the decoded frame is discarded without
   * the (expensive) ImageBitmap conversion and the promise resolves undefined.
   * Lets a caller submit every frame — preserving the P-frame reference chain —
   * while only paying for the frames it will actually display.
   */
  isStale?: () => boolean;
};

type HardwarePreference = "no-preference" | "prefer-hardware" | "prefer-software";

const hwAccelByCodec = new Map<string, Promise<HardwarePreference>>();

/**
 * Probe (once per codec string) whether the platform can hardware-decode this
 * codec, so VideoDecoder can be configured with "prefer-hardware" where it
 * helps and safely fall back to "no-preference" everywhere else.
 */
export async function preferredHardwareAcceleration(codec: string): Promise<HardwarePreference> {
  let probe = hwAccelByCodec.get(codec);
  if (!probe) {
    probe = (async () => {
      try {
        const decoderCtor = (globalThis as { VideoDecoder?: typeof VideoDecoder }).VideoDecoder;
        if (!decoderCtor) {
          return "no-preference";
        }
        const result = await decoderCtor.isConfigSupported({
          codec,
          hardwareAcceleration: "prefer-hardware",
        });
        return result.supported === true ? "prefer-hardware" : "no-preference";
      } catch {
        return "no-preference";
      }
    })();
    hwAccelByCodec.set(codec, probe);
  }
  return await probe;
}

/**
 * Parses H.264 Annex B byte stream to find NAL unit boundaries and types.
 */
export function findNalUnits(
  data: Uint8Array,
): Array<{ offset: number; length: number; type: number }> {
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
 * Returns true if the given H.264 Annex B data contains an IDR (keyframe) NAL unit.
 */
export function containsKeyframe(data: Uint8Array): boolean {
  return findNalUnits(data).some((nal) => nal.type === 5);
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
  return `avc1.${profileIdc.toString(16).padStart(2, "0")}${constraintFlags
    .toString(16)
    .padStart(2, "0")}${levelIdc.toString(16).padStart(2, "0")}`;
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
   * @param isStale - When provided and true at output time, the frame is
   *   decoded (keeping the reference chain intact) but not converted to an
   *   ImageBitmap; the promise resolves undefined instead.
   * @returns Decoded frame as ImageBitmap, or undefined for stale frames
   * @throws NoFrameError if the data contains only parameter sets (no slice)
   */
  public async decode(
    data: Uint8Array,
    timestampNanos: bigint,
    isStale?: () => boolean,
  ): Promise<ImageBitmap | undefined> {
    const nalUnits = findNalUnits(data);

    let hasSlice = false;
    let isKeyframe = false;

    for (const nal of nalUnits) {
      if (nal.type === 7) {
        // SPS - extract codec string and reconfigure decoder if needed
        const spsData = data.subarray(nal.offset, nal.offset + nal.length);
        const codecString = extractCodecString(spsData);
        if (codecString !== this.#codecString) {
          await this.#configure(codecString);
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
      throw new NoFrameError("Waiting for keyframe with SPS");
    }

    // Drop delta frames until we've seen a keyframe
    if (!isKeyframe && !this.#keyframeSeen) {
      throw new NoFrameError("Waiting for keyframe");
    }

    if (isKeyframe) {
      this.#keyframeSeen = true;
    }

    const timestampMicros = Number(timestampNanos / 1000n);

    // A queue that keeps growing means the decoder can't keep up (software
    // decode / too many concurrent streams) — the definitive slowness signal.
    perfStats.count("video.framesIn");
    perfStats.max("video.queueMax", this.#decoder.decodeQueueSize);

    return await new Promise<ImageBitmap | undefined>((resolve, reject) => {
      this.#pendingFrames.push({ resolve, reject, isStale });

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

  async #configure(codecString: string): Promise<void> {
    this.#codecString = codecString;
    this.#keyframeSeen = false;

    // Ask for hardware decode where the platform has it; concurrent software
    // decode of several streams is what flattens older machines.
    const hardwareAcceleration = await preferredHardwareAcceleration(codecString);
    perfStats.gauge("video.hwAccel", hardwareAcceleration === "prefer-hardware" ? 1 : 0);

    // Reject any pending frames from the old decoder
    this.#rejectAllPending("Decoder reconfigured");

    if (this.#decoder && this.#decoder.state !== "closed") {
      this.#decoder.close();
    }

    // Capture decoder reference so callbacks can detect if they belong to a
    // superseded decoder (stale error/output callbacks from a closed decoder
    // can fire as already-scheduled microtasks and corrupt shared state).
    const decoder = new VideoDecoder({
      output: (frame: VideoFrame) => {
        if (this.#decoder !== decoder) {
          frame.close();
          return;
        }
        const pending = this.#pendingFrames.shift();
        if (!pending) {
          frame.close();
          return;
        }
        perfStats.count("video.framesOut");
        // A frame superseded while queued keeps the decoder's reference chain
        // warm but skips the expensive bitmap conversion and display.
        if (pending.isStale?.() === true) {
          perfStats.count("video.bitmapSkipped");
          frame.close();
          pending.resolve(undefined);
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
        if (this.#decoder !== decoder) {
          return;
        }
        perfStats.count("video.decodeErrors");
        this.#rejectAllPending(err.message);
        // WebCodecs closes the decoder on error. Reset state so the decoder
        // can recover automatically when the next keyframe with SPS arrives.
        this.#codecString = undefined;
        this.#keyframeSeen = false;
      },
    });

    this.#decoder = decoder;
    this.#decoder.configure({ codec: codecString, hardwareAcceleration });
  }

  #rejectAllPending(reason: string): void {
    const pending = this.#pendingFrames;
    this.#pendingFrames = [];
    for (const entry of pending) {
      entry.reject(new NoFrameError(reason));
    }
  }

  public close(): void {
    this.#rejectAllPending("Decoder closed");
    if (this.#decoder && this.#decoder.state !== "closed") {
      this.#decoder.close();
    }
    this.#decoder = undefined;
    this.#codecString = undefined;
    this.#keyframeSeen = false;
  }
}
