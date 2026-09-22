# Perf benchmark: video FPS + plot preload

Studio logs always-on `[perf]` counter lines to the DevTools console every 5 s
(only while something is happening). No HUD, no build flags.

## Collecting a run

1. Open octaview Studio (desktop) and open the recording files.
2. Open DevTools: menu **View → Toggle Developer Tools** (Ctrl+Shift+I on
   Windows, Cmd+Option+I on macOS) → **Console** tab.
3. In the console filter box type `[perf]`.
4. Reproduce the problem (e.g. play with 4 camera panels for ≥1 minute).
5. Right-click the console → **Save as…** and send the log file.

Worker lines (block loader / byte cache) appear in the same console, attributed
to their worker.

## Reading the counters

All values are per 5 s interval unless it's a gauge.

| Key | Meaning | Bad sign |
|---|---|---|
| `pipeline.emits` | player frames emitted (÷5 = real playback fps) | ≪ 30/s |
| `pipeline.renderMsSum` / `Max` | main-thread cost of emits across all panels | Sum near 5000 = saturated |
| `video.framesIn` / `framesOut` | frames submitted vs decoded | Out ≪ In |
| `video.queueMax` | max `VideoDecoder.decodeQueueSize` | growing ⇒ decoder can't keep up (software decode) |
| `video.decodeErrors` | decoder hard errors | any sustained rate |
| `video.reprime`, `reprimeFrames`, `reprimeMs` | full-GOP re-decodes | recurring during steady playback = dropped-reference collapse loop |
| `blocks.loaded` / `blocks.total` (gauges) | preload progress | loaded stalls below total ⇒ plots fill only via playback |
| `blocks.cacheMB` (gauge) | block cache size | near 1000 = at cap |
| `blocks.cacheFull`, `blocks.abort` | preload stopped at cap / restarted by subscription churn | any |
| `mcapCache.readBytesMB` vs `fetchBytesMB` | bytes served vs re-downloaded | fetch ≫ read growth = byte-cache thrash (too many files sharing the 200 MiB budget) |

## Emulating the slow laptop on a fast machine

- Force software H.264: launch with `--disable-accelerated-video-decode`
  (works as a command-line switch on the packaged exe/app too).
- DevTools → Performance tab → gear icon → CPU throttling 4×–6×.
