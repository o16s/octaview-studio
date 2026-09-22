// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import CloseIcon from "@mui/icons-material/Close";
import QrCodeScannerIcon from "@mui/icons-material/QrCodeScanner";
import { Button, IconButton, Typography } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import { makeStyles } from "tss-react/mui";

import Stack from "@foxglove/studio-base/components/Stack";

// Type declaration for the BarcodeDetector API (not in all TS libs)
declare class BarcodeDetector {
  public constructor(options?: { formats?: string[] });
  public detect(
    source: HTMLVideoElement | HTMLCanvasElement | ImageBitmap,
  ): Promise<Array<{ rawValue: string }>>;
  public static getSupportedFormats(): Promise<string[]>;
}

const useStyles = makeStyles()((theme) => ({
  overlay: {
    position: "fixed",
    inset: 0,
    zIndex: 1300,
    backgroundColor: "rgba(0,0,0,0.9)",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
  },
  video: {
    maxWidth: "100%",
    maxHeight: "60vh",
    borderRadius: 8,
    border: `2px solid ${theme.palette.primary.main}`,
  },
  closeButton: {
    position: "absolute",
    top: 16,
    right: 16,
    color: theme.palette.common.white,
  },
  viewfinder: {
    position: "relative",
  },
  corners: {
    position: "absolute",
    inset: "15%",
    border: `3px solid ${theme.palette.primary.main}`,
    borderRadius: 12,
    pointerEvents: "none",
  },
}));

type QrScannerProps = {
  onScan: (data: { ip: string; token: string }) => void;
};

function parseEdgeHubQr(raw: string): { ip: string; token: string } | undefined {
  // Format: octaview://edgehub/<ip>:<port>/<token>
  const match = raw.match(/^octaview:\/\/edgehub\/([^/]+)\/(.*)/);
  if (!match) {
    return undefined;
  }
  const ip = match[1]!;
  const token = match[2]!;
  if (!ip || !token) {
    return undefined;
  }
  return { ip, token };
}

function isBarcodeDetectorAvailable(): boolean {
  return typeof globalThis !== "undefined" && "BarcodeDetector" in globalThis;
}

export function ScanQrButton({ onScan }: QrScannerProps): JSX.Element | ReactNull {
  const { classes } = useStyles();
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const videoRef = useRef<HTMLVideoElement>(ReactNull);
  const streamRef = useRef<MediaStream | undefined>();
  const scanningRef = useRef(false);

  const stopCamera = useCallback(() => {
    scanningRef.current = false;
    if (streamRef.current) {
      for (const track of streamRef.current.getTracks()) {
        track.stop();
      }
      streamRef.current = undefined;
    }
    setScanning(false);
  }, []);

  const startScanning = useCallback(async () => {
    setError(undefined);
    setScanning(true);
    scanningRef.current = true;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1280 }, height: { ideal: 720 } },
      });
      streamRef.current = stream;

      const video = videoRef.current;
      if (!video) {
        stopCamera();
        return;
      }
      video.srcObject = stream;
      await video.play();

      const detector = new BarcodeDetector({ formats: ["qr_code"] });

      const detect = async () => {
        if (!scanningRef.current || video.readyState < 2) {
          if (scanningRef.current) {
            requestAnimationFrame(() => void detect());
          }
          return;
        }

        try {
          const barcodes = await detector.detect(video);
          for (const barcode of barcodes) {
            const parsed = parseEdgeHubQr(barcode.rawValue);
            if (parsed) {
              onScan(parsed);
              stopCamera();
              return;
            }
          }
        } catch {
          // Detection can fail on some frames — ignore and retry
        }

        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- the ref can flip to false during the awaited detect() above
        if (scanningRef.current) {
          requestAnimationFrame(() => void detect());
        }
      };

      // Small delay to let the camera stabilize
      setTimeout(() => void detect(), 500);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Camera access denied");
      setScanning(false);
    }
  }, [onScan, stopCamera]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      scanningRef.current = false;
      if (streamRef.current) {
        for (const track of streamRef.current.getTracks()) {
          track.stop();
        }
      }
    };
  }, []);

  if (!isBarcodeDetectorAvailable()) {
    return ReactNull;
  }

  return (
    <>
      <Button
        variant="outlined"
        color="inherit"
        startIcon={<QrCodeScannerIcon />}
        onClick={() => void startScanning()}
        fullWidth
      >
        Scan QR Code
      </Button>
      {error && (
        <Typography variant="body2" color="error">
          {error}
        </Typography>
      )}
      {scanning && (
        <div className={classes.overlay}>
          <IconButton className={classes.closeButton} onClick={stopCamera}>
            <CloseIcon fontSize="large" />
          </IconButton>
          <Stack alignItems="center" gap={2}>
            <Typography variant="h6" color="common.white">
              Point camera at Edge Hub QR code
            </Typography>
            <div className={classes.viewfinder}>
              <video ref={videoRef} className={classes.video} playsInline muted />
              <div className={classes.corners} />
            </div>
            <Typography variant="body2" color="grey.400">
              Looking for: octaview://edgehub/...
            </Typography>
          </Stack>
        </div>
      )}
    </>
  );
}
