// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { MessageEvent } from "@foxglove/studio";
import {
  H264Decoder,
  NoFrameError,
} from "@foxglove/studio-base/panels/ThreeDeeRender/renderables/Images/H264Decoder";

export type TopicInfo = {
  name: string;
  schemaName: string | undefined;
};

/** All schema names that represent exportable image/video topics (ROS1, ROS2, Foxglove). */
export const EXPORTABLE_TOPIC_SCHEMAS = [
  // ROS 1
  "sensor_msgs/Image",
  "sensor_msgs/CompressedImage",
  // ROS 2
  "sensor_msgs/msg/Image",
  "sensor_msgs/msg/CompressedImage",
  // Foxglove images
  "foxglove.RawImage",
  "foxglove.CompressedImage",
  "foxglove_msgs/RawImage",
  "foxglove_msgs/msg/RawImage",
  "foxglove_msgs/CompressedImage",
  "foxglove_msgs/msg/CompressedImage",
  // Foxglove compressed video (H.264)
  "foxglove.CompressedVideo",
  "foxglove_msgs/CompressedVideo",
  "foxglove_msgs/msg/CompressedVideo",
  "foxglove::CompressedVideo",
] as const;

const EXPORTABLE_SCHEMAS_SET = new Set<string>(EXPORTABLE_TOPIC_SCHEMAS);

/** Filter topics to only those with exportable image/video schemas. */
export function getImageTopics(topics: TopicInfo[]): TopicInfo[] {
  return topics.filter((t) => t.schemaName != undefined && EXPORTABLE_SCHEMAS_SET.has(t.schemaName));
}

export type ExportVideoProgress = {
  framesProcessed: number;
  totalFrames: number;
};

type RawImageMessage = {
  width: number;
  height: number;
  encoding: string;
  step: number;
  data: Uint8Array;
  is_bigendian?: boolean;
};

type CompressedImageMessage = {
  format: string;
  data: Uint8Array;
};

function isCompressedImage(schemaName: string): boolean {
  return schemaName.includes("CompressedImage") || (schemaName.includes("Compressed") && !schemaName.includes("Video"));
}

function isCompressedVideo(schemaName: string): boolean {
  return schemaName.includes("CompressedVideo");
}

/**
 * Export image messages to a WebM video file.
 * Uses the browser's MediaRecorder API with canvas.captureStream().
 * WebM/VP8 is royalty-free.
 */
export async function exportToWebM(
  messages: MessageEvent[],
  schemaName: string,
  onProgress?: (progress: ExportVideoProgress) => void,
): Promise<Blob> {
  if (messages.length === 0) {
    throw new Error("No image messages to export");
  }

  // Create H264Decoder for compressed video topics
  const videoDecoder = isCompressedVideo(schemaName) ? new H264Decoder() : undefined;

  try {
    // Decode first decodable frame to determine dimensions
    let firstFrame: ImageBitmap | undefined;
    let firstFrameIdx = 0;
    for (; firstFrameIdx < messages.length; firstFrameIdx++) {
      try {
        firstFrame = await decodeFrame(messages[firstFrameIdx]!, schemaName, videoDecoder);
        break;
      } catch (err) {
        // H.264 streams may start with parameter-only NAL units — skip them
        if (err instanceof NoFrameError) {
          continue;
        }
        throw err;
      }
    }
    if (!firstFrame) {
      throw new Error("No decodable frames found in messages");
    }

    const width = firstFrame.width;
    const height = firstFrame.height;
    firstFrame.close();

    // MediaRecorder uses wall-clock time between requestFrame() calls to determine
    // frame duration. We sleep briefly per frame so timestamps are distinct, but cap
    // the delay to keep export much faster than real-time.
    const fps = estimateFps(messages);
    const frameDelay = Math.max(1, Math.min(10, Math.round(1000 / fps)));

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d")!;

    const stream = canvas.captureStream(0); // 0 = manual frame control
    const recorder = new MediaRecorder(stream, {
      mimeType: getSupportedMimeType(),
      videoBitsPerSecond: 8_000_000,
    });

    const chunks: Blob[] = [];
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunks.push(e.data);
      }
    };

    const done = new Promise<Blob>((resolve, reject) => {
      recorder.onstop = () => {
        resolve(new Blob(chunks, { type: recorder.mimeType }));
      };
      recorder.onerror = (e) => {
        reject(new Error(`MediaRecorder error: ${(e as ErrorEvent).message ?? "unknown"}`));
      };
    });

    // Request data frequently to avoid buffering everything in memory
    recorder.start(1000);

    const track = stream.getVideoTracks()[0];
    const requestFrame = track && "requestFrame" in track
      ? () => { (track as unknown as { requestFrame: () => void }).requestFrame(); }
      : undefined;

    try {
      let framesEncoded = 0;
      for (let i = 0; i < messages.length; i++) {
        let bitmap: ImageBitmap;
        try {
          bitmap = await decodeFrame(messages[i]!, schemaName, videoDecoder);
        } catch (err) {
          if (err instanceof NoFrameError) {
            // Skip non-decodable frames (SPS/PPS only, waiting for keyframe)
            onProgress?.({ framesProcessed: i + 1, totalFrames: messages.length });
            continue;
          }
          throw err;
        }

        ctx.drawImage(bitmap, 0, 0, width, height);
        bitmap.close();

        requestFrame?.();

        framesEncoded++;
        onProgress?.({ framesProcessed: i + 1, totalFrames: messages.length });

        await new Promise((resolve) => setTimeout(resolve, frameDelay));
      }

      if (framesEncoded === 0) {
        throw new Error("No decodable video frames found");
      }

      recorder.stop();
      return await done;
    } catch (err) {
      // Ensure recorder is stopped on any error to prevent resource leaks
      try {
        recorder.stop();
      } catch {
        // Recorder may already be in an error state
      }
      for (const t of stream.getTracks()) {
        t.stop();
      }
      throw err;
    }
  } finally {
    videoDecoder?.close();
  }
}

function getSupportedMimeType(): string {
  const types = [
    "video/webm;codecs=vp9",
    "video/webm;codecs=vp8",
    "video/webm",
  ];
  for (const type of types) {
    if (MediaRecorder.isTypeSupported(type)) {
      return type;
    }
  }
  throw new Error("No supported video MIME type found. WebM encoding requires a modern browser.");
}

type CompressedVideoMessage = {
  timestamp: { sec: number; nsec: number };
  format: string;
  data: Uint8Array;
};

async function decodeFrame(
  msg: MessageEvent,
  schemaName: string,
  videoDecoder?: H264Decoder,
): Promise<ImageBitmap> {
  const message = msg.message as Record<string, unknown>;

  if (isCompressedVideo(schemaName)) {
    if (!videoDecoder) {
      throw new Error("H264Decoder required for CompressedVideo");
    }
    const video = message as unknown as CompressedVideoMessage;
    const data = video.data instanceof Uint8Array ? video.data : new Uint8Array(video.data as ArrayBuffer);
    const timestampNanos =
      BigInt(video.timestamp.sec) * 1_000_000_000n + BigInt(video.timestamp.nsec);
    const bitmap = await videoDecoder.decode(data, timestampNanos);
    if (!bitmap) {
      // decode() only returns undefined for stale-marked frames, which the
      // exporter never uses — guard for the type system.
      throw new Error("Video frame decode returned no bitmap");
    }
    return bitmap;
  }

  if (isCompressedImage(schemaName)) {
    const compressed = message as unknown as CompressedImageMessage;
    const blob = new Blob([compressed.data], {
      type: `image/${compressed.format}`,
    });
    return await createImageBitmap(blob);
  }

  // Raw image
  const raw = message as unknown as RawImageMessage;
  const rgba = decodeRawToRGBA(raw);
  const imageData = new ImageData(rgba, raw.width, raw.height);
  return await createImageBitmap(imageData);
}

function decodeRawToRGBA(raw: RawImageMessage): Uint8ClampedArray {
  const { width, height, encoding, step, data } = raw;
  const output = new Uint8ClampedArray(width * height * 4);

  switch (encoding) {
    case "rgb8":
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const srcIdx = y * step + x * 3;
          const dstIdx = (y * width + x) * 4;
          output[dstIdx] = data[srcIdx]!;
          output[dstIdx + 1] = data[srcIdx + 1]!;
          output[dstIdx + 2] = data[srcIdx + 2]!;
          output[dstIdx + 3] = 255;
        }
      }
      break;
    case "rgba8":
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const srcIdx = y * step + x * 4;
          const dstIdx = (y * width + x) * 4;
          output[dstIdx] = data[srcIdx]!;
          output[dstIdx + 1] = data[srcIdx + 1]!;
          output[dstIdx + 2] = data[srcIdx + 2]!;
          output[dstIdx + 3] = data[srcIdx + 3]!;
        }
      }
      break;
    case "bgr8":
    case "8UC3":
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const srcIdx = y * step + x * 3;
          const dstIdx = (y * width + x) * 4;
          output[dstIdx] = data[srcIdx + 2]!;
          output[dstIdx + 1] = data[srcIdx + 1]!;
          output[dstIdx + 2] = data[srcIdx]!;
          output[dstIdx + 3] = 255;
        }
      }
      break;
    case "bgra8":
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const srcIdx = y * step + x * 4;
          const dstIdx = (y * width + x) * 4;
          output[dstIdx] = data[srcIdx + 2]!;
          output[dstIdx + 1] = data[srcIdx + 1]!;
          output[dstIdx + 2] = data[srcIdx]!;
          output[dstIdx + 3] = data[srcIdx + 3]!;
        }
      }
      break;
    case "mono8":
    case "8UC1":
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const srcIdx = y * step + x;
          const dstIdx = (y * width + x) * 4;
          const v = data[srcIdx]!;
          output[dstIdx] = v;
          output[dstIdx + 1] = v;
          output[dstIdx + 2] = v;
          output[dstIdx + 3] = 255;
        }
      }
      break;
    default:
      throw new Error(`Unsupported raw image encoding for export: ${encoding}`);
  }
  return output;
}

function estimateFps(messages: MessageEvent[]): number {
  if (messages.length < 2) return 10;
  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  const durationSec =
    last.receiveTime.sec - first.receiveTime.sec +
    (last.receiveTime.nsec - first.receiveTime.nsec) / 1e9;
  if (durationSec <= 0) return 10;
  const fps = (messages.length - 1) / durationSec;
  // Clamp to reasonable range
  return Math.max(1, Math.min(60, Math.round(fps)));
}
