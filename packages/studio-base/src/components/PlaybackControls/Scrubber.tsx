// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Fade, PopperProps, Tooltip } from "@mui/material";
import type { Instance } from "@popperjs/core";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useLatest } from "react-use";
import { makeStyles } from "tss-react/mui";
import { v4 as uuidv4 } from "uuid";

import {
  subtract as subtractTimes,
  add as addTimes,
  toSec,
  fromSec,
  Time,
} from "@foxglove/rostime";
import {
  MessagePipelineContext,
  useMessagePipeline,
} from "@foxglove/studio-base/components/MessagePipeline";
import Stack from "@foxglove/studio-base/components/Stack";
import {
  useClearHoverValue,
  useSetHoverValue,
} from "@foxglove/studio-base/context/TimelineInteractionStateContext";
import { PlayerPresence } from "@foxglove/studio-base/players/types";

import { EventsOverlay } from "./EventsOverlay";
import PlaybackBarHoverTicks from "./PlaybackBarHoverTicks";
import { PlaybackControlsTooltipContent } from "./PlaybackControlsTooltipContent";
import { ProgressPlot } from "./ProgressPlot";
import Slider, { HoverOverEvent } from "./Slider";

const useStyles = makeStyles()((theme) => ({
  outerContainer: {
    position: "relative",
    display: "flex",
    flexDirection: "column",
    flexGrow: 1,
  },
  cursor: {
    position: "absolute",
    top: 0,
    bottom: 0,
    width: 2,
    backgroundColor: theme.palette.text.primary,
    borderRadius: 1,
    transform: "translate(-50%, 0)",
    pointerEvents: "none",
    zIndex: 2,
  },
  marker: {
    backgroundColor: theme.palette.text.primary,
    position: "absolute",
    height: 16,
    borderRadius: 1,
    width: 2,
    transform: "translate(-50%, 0)",
  },
  track: {
    position: "absolute",
    left: 0,
    right: 0,
    height: 6,
    backgroundColor: theme.palette.action.focus,
  },
  trackDisabled: {
    opacity: theme.palette.action.disabledOpacity,
  },
  sourceRangesLane: {
    position: "relative",
    width: "100%",
    height: 5,
    backgroundColor: theme.palette.action.hover,
    cursor: "pointer",
  },
  sourceRangeBar: {
    position: "absolute",
    height: 4,
    top: 0,
    borderRadius: 0,
    backgroundColor: theme.palette.text.primary,
    opacity: 0.12,
    cursor: "pointer",
    "&:hover": {
      opacity: 0.25,
    },
  },
}));

const selectStartTime = (ctx: MessagePipelineContext) => ctx.playerState.activeData?.startTime;
const selectCurrentTime = (ctx: MessagePipelineContext) => ctx.playerState.activeData?.currentTime;
const selectEndTime = (ctx: MessagePipelineContext) => ctx.playerState.activeData?.endTime;
const selectRanges = (ctx: MessagePipelineContext) =>
  ctx.playerState.progress.fullyLoadedFractionRanges;
const selectPresence = (ctx: MessagePipelineContext) => ctx.playerState.presence;
const selectSourceRanges = (ctx: MessagePipelineContext) =>
  ctx.playerState.activeData?.sourceRanges;

type Props = {
  onSeek: (seekTo: Time) => void;
};

export default function Scrubber(props: Props): JSX.Element {
  const { onSeek } = props;
  const { classes, cx } = useStyles();

  const [hoverComponentId] = useState<string>(() => uuidv4());

  const startTime = useMessagePipeline(selectStartTime);
  const currentTime = useMessagePipeline(selectCurrentTime);
  const endTime = useMessagePipeline(selectEndTime);
  const presence = useMessagePipeline(selectPresence);
  const ranges = useMessagePipeline(selectRanges);
  const sourceRanges = useMessagePipeline(selectSourceRanges);

  const setHoverValue = useSetHoverValue();

  type HoverInfo = {
    stamp: Time;
    clientX: number;
    clientY: number;
  };
  const [hoverInfo, setHoverInfo] = useState<HoverInfo | undefined>();
  const latestHoverInfo = useLatest(hoverInfo);

  const latestStartTime = useLatest(startTime);
  const latestEndTime = useLatest(endTime);

  const onChange = useCallback(
    (fraction: number) => {
      if (!latestStartTime.current || !latestEndTime.current) {
        return;
      }
      onSeek(
        addTimes(
          latestStartTime.current,
          fromSec(fraction * toSec(subtractTimes(latestEndTime.current, latestStartTime.current))),
        ),
      );
    },
    [onSeek, latestEndTime, latestStartTime],
  );

  const onHoverOver = useCallback(
    ({ fraction, clientX, clientY }: HoverOverEvent) => {
      if (!latestStartTime.current || !latestEndTime.current) {
        return;
      }
      const duration = toSec(subtractTimes(latestEndTime.current, latestStartTime.current));
      const timeFromStart = fromSec(fraction * duration);
      setHoverInfo({ stamp: addTimes(latestStartTime.current, timeFromStart), clientX, clientY });
      setHoverValue({
        componentId: hoverComponentId,
        type: "PLAYBACK_SECONDS",
        value: toSec(timeFromStart),
      });
    },
    [hoverComponentId, latestEndTime, latestStartTime, setHoverValue],
  );

  const clearHoverValue = useClearHoverValue();

  const onHoverOut = useCallback(() => {
    clearHoverValue(hoverComponentId);
    setHoverInfo(undefined);
  }, [clearHoverValue, hoverComponentId]);

  // Clean up the hover value when we are unmounted -- important for storybook.
  useEffect(() => onHoverOut, [onHoverOut]);

  const renderSlider = useCallback(
    (val?: number) => {
      if (val == undefined) {
        return undefined;
      }
      return <div className={classes.marker} style={{ left: `${val * 100}%` }} />;
    },
    [classes.marker],
  );

  const min = startTime && toSec(startTime);
  const max = endTime && toSec(endTime);
  const fraction =
    currentTime && startTime && endTime
      ? toSec(subtractTimes(currentTime, startTime)) / toSec(subtractTimes(endTime, startTime))
      : undefined;

  const loading = presence === PlayerPresence.INITIALIZING || presence === PlayerPresence.BUFFERING;

  const popperRef = React.useRef<Instance>(ReactNull);
  const outerContainerRef = React.useRef<HTMLDivElement>(ReactNull);

  const isHovered = hoverInfo != undefined;
  const popperProps: Partial<PopperProps> = useMemo(
    () => ({
      open: isHovered, // Keep the tooltip visible while dragging even when the mouse is outside the playback bar
      popperRef,
      modifiers: [
        {
          name: "computeStyles",
          options: {
            gpuAcceleration: false, // Fixes hairline seam on arrow in chrome.
          },
        },
        {
          name: "offset",
          options: {
            // Offset popper to hug the track better.
            offset: [0, 4],
          },
        },
      ],
      anchorEl: {
        getBoundingClientRect: () => {
          // Anchor tooltip at the top of the seeker line (top of outerContainer)
          // instead of at the mouse cursor, so it doesn't obscure source range bars.
          const containerTop = outerContainerRef.current?.getBoundingClientRect().top ?? 0;
          return new DOMRect(latestHoverInfo.current?.clientX ?? 0, containerTop, 0, 0);
        },
      },
    }),
    [isHovered, latestHoverInfo],
  );

  useEffect(() => {
    if (popperRef.current != undefined) {
      void popperRef.current.update();
    }
  }, [hoverInfo]);

  const totalDuration = startTime && endTime ? toSec(subtractTimes(endTime, startTime)) : 0;

  // Assign lanes for overlapping source ranges (greedy interval scheduling)
  const hasSourceRanges =
    sourceRanges != undefined &&
    sourceRanges.length > 1 &&
    startTime != undefined &&
    totalDuration > 0;

  const sourceLanes = useMemo(() => {
    if (!sourceRanges || sourceRanges.length <= 1) {
      return { laneCount: 0, laneMap: new Map<number, number>() };
    }
    const laneEnds: number[] = [];
    const laneMap = new Map<number, number>();
    for (let i = 0; i < sourceRanges.length; i++) {
      const sr = sourceRanges[i]!;
      const srStart = toSec(sr.start);
      const srEnd = toSec(sr.end);
      let assigned = -1;
      for (let l = 0; l < laneEnds.length; l++) {
        if (laneEnds[l]! <= srStart) {
          assigned = l;
          laneEnds[l] = srEnd;
          break;
        }
      }
      if (assigned === -1) {
        assigned = laneEnds.length;
        laneEnds.push(srEnd);
      }
      laneMap.set(i, assigned);
    }
    return { laneCount: laneEnds.length, laneMap };
  }, [sourceRanges]);

  // When source ranges are visible, suppress the in-Slider marker —
  // the outer cursor handles it instead.
  const renderSliderForMultiSource = useCallback(() => undefined, []);

  return (
    <div ref={outerContainerRef} className={classes.outerContainer}>
      {/* Full-height cursor spanning source lanes + scrubber */}
      {hasSourceRanges && fraction != undefined && (
        <div className={classes.cursor} style={{ left: `${fraction * 100}%` }} />
      )}

      {/* Source range lanes (above main scrubber) */}
      {hasSourceRanges && (
        <>
          {Array.from({ length: sourceLanes.laneCount }, (_, lane) => (
            <div
              key={lane}
              className={classes.sourceRangesLane}
              onClick={(e) => {
                const rect = e.currentTarget.getBoundingClientRect();
                const clickFraction = (e.clientX - rect.left) / rect.width;
                onChange(Math.max(0, Math.min(1, clickFraction)));
              }}
            >
              {sourceRanges.map((sr, i) => {
                if (sourceLanes.laneMap.get(i) !== lane) {
                  return undefined;
                }
                const leftFrac = toSec(subtractTimes(sr.start, startTime)) / totalDuration;
                const widthFrac = toSec(subtractTimes(sr.end, sr.start)) / totalDuration;
                const label = sr.folder ? `${sr.folder}/${sr.name}` : sr.name;
                return (
                  <Tooltip key={i} title={label} placement="top" disableInteractive>
                    <div
                      className={classes.sourceRangeBar}
                      style={{
                        left: `${leftFrac * 100}%`,
                        width: `${Math.max(widthFrac * 100, 0.5)}%`,
                      }}
                    />
                  </Tooltip>
                );
              })}
            </div>
          ))}
        </>
      )}

      {/* Main scrubber */}
      <Stack direction="row" alignItems="center" position="relative" flexGrow={1}>
        <Tooltip
          title={
            hoverInfo != undefined ? <PlaybackControlsTooltipContent stamp={hoverInfo.stamp} /> : ""
          }
          placement="top"
          disableInteractive
          TransitionComponent={Fade}
          TransitionProps={{ timeout: 0 }}
          PopperProps={popperProps}
        >
          <Stack
            direction="row"
            flexGrow={1}
            alignItems="center"
            position="relative"
            style={{ height: 32 }}
          >
            <div className={cx(classes.track, { [classes.trackDisabled]: !startTime })} />
            <Stack position="absolute" flex="auto" fullWidth style={{ height: 6 }}>
              <ProgressPlot loading={loading} availableRanges={ranges} />
            </Stack>
            <Stack fullHeight fullWidth position="absolute" flex={1}>
              <Slider
                disabled={min == undefined || max == undefined}
                fraction={fraction}
                onHoverOver={onHoverOver}
                onHoverOut={onHoverOut}
                onChange={onChange}
                renderSlider={hasSourceRanges ? renderSliderForMultiSource : renderSlider}
              />
            </Stack>
            <EventsOverlay />
            <PlaybackBarHoverTicks componentId={hoverComponentId} />
          </Stack>
        </Tooltip>
      </Stack>
    </div>
  );
}
