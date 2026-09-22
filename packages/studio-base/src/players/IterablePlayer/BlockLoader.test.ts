// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Immutable, MessageEvent } from "@foxglove/studio";
import PlayerProblemManager from "@foxglove/studio-base/players/PlayerProblemManager";
import { MessageBlock } from "@foxglove/studio-base/players/types";
import { mockTopicSelection } from "@foxglove/studio-base/test/mocks/mockTopicSelection";

import { BlockLoader, MEMORY_INFO_PRELOADED_MSGS } from "./BlockLoader";
import {
  GetBackfillMessagesArgs,
  IIterableSource,
  Initalization,
  IteratorResult,
  MessageIteratorArgs,
} from "./IIterableSource";

class TestSource implements IIterableSource {
  public async initialize(): Promise<Initalization> {
    return {
      start: { sec: 0, nsec: 0 },
      end: { sec: 10, nsec: 0 },
      topics: [],
      topicStats: new Map(),
      problems: [],
      profile: undefined,
      datatypes: new Map(),
      publishersByTopic: new Map(),
    };
  }

  public async *messageIterator(
    _args: MessageIteratorArgs,
  ): AsyncIterableIterator<Readonly<IteratorResult>> {}

  public async getBackfillMessages(_args: GetBackfillMessagesArgs): Promise<MessageEvent[]> {
    return [];
  }
}

const consoleErrorMock = console.error as ReturnType<typeof jest.fn>;

describe("BlockLoader", () => {
  it("should make an empty block loader", async () => {
    const loader = new BlockLoader({
      maxBlocks: 4,
      cacheSizeBytes: 1,
      minBlockDurationNs: 1,
      source: new TestSource(),
      start: { sec: 0, nsec: 0 },
      end: { sec: 2, nsec: 0 },
      problemManager: new PlayerProblemManager(),
    });

    await loader.startLoading({
      progress: async (progress) => {
        expect(progress).toEqual({
          fullyLoadedFractionRanges: [],
          messageCache: {
            blocks: [undefined, undefined, undefined, undefined],
            startTime: { sec: 0, nsec: 0 },
          },
          memoryInfo: {
            [MEMORY_INFO_PRELOADED_MSGS]: 0,
          },
        });
        await loader.stopLoading();
      },
    });

    expect.assertions(1);
  });

  it("should load the source into blocks", async () => {
    const source = new TestSource();

    const loader = new BlockLoader({
      maxBlocks: 5,
      cacheSizeBytes: 5,
      minBlockDurationNs: 1,
      source,
      start: { sec: 0, nsec: 0 },
      end: { sec: 9, nsec: 0 },
      problemManager: new PlayerProblemManager(),
    });

    const msgEvents: MessageEvent[] = [];
    for (let i = 0; i < 10; i += 3) {
      msgEvents.push({
        topic: "a",
        receiveTime: { sec: i, nsec: 0 },
        message: undefined,
        sizeInBytes: 1,
        schemaName: "foo",
      });
    }

    source.messageIterator = async function* messageIterator(
      _args: MessageIteratorArgs,
    ): AsyncIterableIterator<Readonly<IteratorResult>> {
      for (const msgEvent of msgEvents) {
        yield {
          type: "message-event",
          msgEvent,
        };
      }
    };

    loader.setTopics(mockTopicSelection("a"));
    let count = 0;
    await loader.startLoading({
      progress: async (progress) => {
        if (++count < 5) {
          return;
        }

        expect(progress).toEqual({
          fullyLoadedFractionRanges: [
            {
              start: 0,
              end: 1,
            },
          ],
          messageCache: {
            blocks: [
              {
                messagesByTopic: {
                  a: [msgEvents[0]],
                },
                needTopics: new Map(),
                sizeInBytes: 1,
              },
              {
                messagesByTopic: {
                  a: [msgEvents[1]],
                },
                needTopics: new Map(),
                sizeInBytes: 1,
              },
              {
                messagesByTopic: {
                  a: [],
                },
                needTopics: new Map(),
                sizeInBytes: 0,
              },
              {
                messagesByTopic: {
                  a: [msgEvents[2]],
                },
                needTopics: new Map(),
                sizeInBytes: 1,
              },
              {
                messagesByTopic: {
                  a: [msgEvents[3]],
                },
                needTopics: new Map(),
                sizeInBytes: 1,
              },
            ],
            startTime: { sec: 0, nsec: 0 },
          },
          memoryInfo: {
            [MEMORY_INFO_PRELOADED_MSGS]: 4,
          },
        });

        await loader.stopLoading();
      },
    });

    expect.assertions(1);
  });

  it("should not load messages past max cache size", async () => {
    const source = new TestSource();

    const loader = new BlockLoader({
      maxBlocks: 2,
      cacheSizeBytes: 3,
      minBlockDurationNs: 1,
      source,
      start: { sec: 0, nsec: 0 },
      end: { sec: 9, nsec: 0 },
      problemManager: new PlayerProblemManager(),
    });

    const msgEvents: MessageEvent[] = [];
    for (let i = 0; i < 10; i += 3) {
      msgEvents.push({
        topic: "a",
        receiveTime: { sec: i, nsec: 0 },
        message: undefined,
        sizeInBytes: 1,
        schemaName: "foo",
      });
    }

    source.messageIterator = async function* messageIterator(
      _args: MessageIteratorArgs,
    ): AsyncIterableIterator<Readonly<IteratorResult>> {
      for (const msgEvent of msgEvents) {
        yield {
          type: "message-event",
          msgEvent,
        };
      }
    };

    loader.setTopics(mockTopicSelection("a"));
    let progressCount = 0;
    await loader.startLoading({
      progress: async (progress) => {
        expect(progress).toMatchObject({
          fullyLoadedFractionRanges: [
            {
              start: 0,
              end: 0.5,
            },
          ],
          messageCache: {
            blocks: [
              {
                messagesByTopic: {
                  a: [msgEvents[0], msgEvents[1]],
                },
                needTopics: new Map(),
                sizeInBytes: 2,
              },
            ],
            startTime: { sec: 0, nsec: 0 },
          },
        });
        // need to wait for second progress call to receive cache full error
        if (++progressCount > 1) {
          await loader.stopLoading();
        }
      },
    });
    expect(consoleErrorMock.mock.calls[0] ?? []).toContain("cache-full");
    consoleErrorMock.mockClear();
    expect.assertions(3);
  });

  it("should remove unused topics on blocks if cache is full", async () => {
    const source = new TestSource();

    const loader = new BlockLoader({
      maxBlocks: 2,
      cacheSizeBytes: 6,
      minBlockDurationNs: 1,
      source,
      start: { sec: 0, nsec: 0 },
      end: { sec: 5, nsec: 0 },
      problemManager: new PlayerProblemManager(),
    });

    const msgEvents: MessageEvent[] = [];
    for (let i = 0; i < 4; ++i) {
      msgEvents.push({
        topic: "a",
        receiveTime: { sec: i, nsec: 0 },
        message: undefined,
        sizeInBytes: 1,
        schemaName: "foo",
      });
      msgEvents.push({
        topic: "b",
        receiveTime: { sec: i, nsec: 0 },
        message: undefined,
        sizeInBytes: 1,
        schemaName: "foo",
      });
    }

    source.messageIterator = async function* messageIterator(
      _args: MessageIteratorArgs,
    ): AsyncIterableIterator<Readonly<IteratorResult>> {
      for (const msgEvent of msgEvents) {
        // need to filter iterator by requested topics since there's messages from more than 1 topic in here
        if (_args.topics.has(msgEvent.topic)) {
          yield {
            type: "message-event",
            msgEvent,
          };
        }
      }
    };

    loader.setTopics(mockTopicSelection("a"));
    let count = 0;
    await loader.startLoading({
      progress: async (progress) => {
        count++;
        if (count === 2) {
          // eslint-disable-next-line jest/no-conditional-expect
          expect(progress).toEqual({
            fullyLoadedFractionRanges: [
              {
                start: 0,
                end: 1,
              },
            ],
            messageCache: {
              blocks: [
                {
                  messagesByTopic: {
                    a: [msgEvents[0], msgEvents[2], msgEvents[4]],
                  },
                  sizeInBytes: 3,
                  needTopics: new Map(),
                },
                {
                  messagesByTopic: {
                    a: [msgEvents[6]],
                  },
                  sizeInBytes: 1,
                  needTopics: new Map(),
                },
              ],
              startTime: { sec: 0, nsec: 0 },
            },
            memoryInfo: {
              [MEMORY_INFO_PRELOADED_MSGS]: 4,
            },
          });
          await loader.stopLoading();
        }
      },
    });

    loader.setTopics(mockTopicSelection("b"));

    count = 0;
    // at the end of loading "b" topic it should have removed the "a" topic as its no longer used.
    await loader.startLoading({
      progress: async (progress) => {
        count += 1;
        if (count === 2) {
          // eslint-disable-next-line jest/no-conditional-expect
          expect(progress).toEqual({
            fullyLoadedFractionRanges: [
              {
                start: 0,
                end: 1,
              },
            ],
            messageCache: {
              blocks: [
                {
                  messagesByTopic: {
                    b: [msgEvents[1], msgEvents[3], msgEvents[5]],
                  },
                  sizeInBytes: 3,
                  needTopics: new Map(),
                },
                {
                  messagesByTopic: {
                    b: [msgEvents[7]],
                  },
                  sizeInBytes: 1,
                  needTopics: new Map(),
                },
              ],
              startTime: { sec: 0, nsec: 0 },
            },
            memoryInfo: {
              [MEMORY_INFO_PRELOADED_MSGS]: 4,
            },
          });
          await loader.stopLoading();
        }
      },
    });
    expect.assertions(2);
  });

  it("should avoid emitting progress when nothing changed", async () => {
    const source = new TestSource();

    const loader = new BlockLoader({
      maxBlocks: 2,
      cacheSizeBytes: 1,
      minBlockDurationNs: 1,
      source,
      start: { sec: 0, nsec: 0 },
      end: { sec: 5, nsec: 0 },
      problemManager: new PlayerProblemManager(),
    });

    const msgEvents: MessageEvent[] = [];
    for (let i = 0; i < 4; ++i) {
      msgEvents.push({
        topic: "a",
        receiveTime: { sec: i, nsec: 0 },
        message: undefined,
        sizeInBytes: 0,
        schemaName: "foo",
      });
    }

    source.messageIterator = async function* messageIterator(
      _args: MessageIteratorArgs,
    ): AsyncIterableIterator<Readonly<IteratorResult>> {
      for (const msgEvent of msgEvents) {
        yield {
          type: "message-event",
          msgEvent,
        };
      }
    };

    loader.setTopics(mockTopicSelection("a"));
    let count = 0;
    await loader.startLoading({
      progress: async (progress) => {
        count += 1;
        if (count > 2) {
          throw new Error("Too many progress callbacks");
        }

        if (count === 2) {
          // eslint-disable-next-line jest/no-conditional-expect
          expect(progress).toEqual({
            fullyLoadedFractionRanges: [
              {
                start: 0,
                end: 1,
              },
            ],
            messageCache: {
              blocks: [
                {
                  messagesByTopic: {
                    a: [msgEvents[0], msgEvents[1], msgEvents[2]],
                  },
                  sizeInBytes: 0,
                  needTopics: new Map(),
                },
                {
                  messagesByTopic: {
                    a: [msgEvents[3]],
                  },
                  sizeInBytes: 0,
                  needTopics: new Map(),
                },
              ],
              startTime: { sec: 0, nsec: 0 },
            },
            memoryInfo: {
              [MEMORY_INFO_PRELOADED_MSGS]: 0,
            },
          });

          // eslint-disable-next-line require-yield
          source.messageIterator = async function* messageIterator(
            _args: MessageIteratorArgs,
          ): AsyncIterableIterator<Readonly<IteratorResult>> {
            throw new Error("Should not call iterator");
          };

          setTimeout(async () => {
            await loader.stopLoading();
          }, 500);
        }
      },
    });
  });

  it("should drop preloaded topics when subscription options change", async () => {
    const source = new TestSource();
    const maxBlockCount = 2;
    const loader = new BlockLoader({
      maxBlocks: maxBlockCount,
      cacheSizeBytes: 60,
      minBlockDurationNs: 1,
      source,
      start: { sec: 0, nsec: 0 },
      end: { sec: 9, nsec: 0 },
      problemManager: new PlayerProblemManager(),
    });

    const msgEvents: MessageEvent[] = [];
    for (let i = 0; i < 10; i += 1) {
      msgEvents.push({
        topic: "a",
        receiveTime: { sec: i, nsec: 0 },
        message: undefined,
        sizeInBytes: 10,
        schemaName: "foo",
      });
    }
    const slicedMsgEvents = msgEvents.map((msgEvent) => ({ ...msgEvent, sizeInBytes: 1 }));

    source.messageIterator = async function* messageIterator(
      args: MessageIteratorArgs,
    ): AsyncIterableIterator<Readonly<IteratorResult>> {
      const fields = args.topics.get("a")?.fields;
      const events = fields ? slicedMsgEvents : msgEvents;
      for (const msgEvent of events) {
        yield {
          type: "message-event",
          msgEvent,
        };
      }
    };

    loader.setTopics(mockTopicSelection("a"));
    let progressCount = 0;
    await loader.startLoading({
      progress: async (progress) => {
        expect(progress).toMatchObject({
          fullyLoadedFractionRanges: [
            {
              start: 0,
              end: 0.5,
            },
          ],
          messageCache: {
            blocks: [
              {
                messagesByTopic: {
                  a: msgEvents.slice(0, 5),
                },
                needTopics: new Map(),
                sizeInBytes: 50,
              },
            ],
            startTime: { sec: 0, nsec: 0 },
          },
        });

        // need to wait for second progress call to receive cache full error
        if (++progressCount > 1) {
          await loader.stopLoading();
        }
      },
    });
    expect(consoleErrorMock.mock.calls[0] ?? []).toContain("cache-full");
    consoleErrorMock.mockClear();

    // Load the same topic but with message slicing. Since messages are much smaller then,
    // we expect that we can preload the full range.
    loader.setTopics(new Map([["a", { topic: "a", fields: ["some_field"] }]]));
    let count = 0;
    await loader.startLoading({
      progress: async (progress) => {
        count += 1;
        if (count > maxBlockCount) {
          throw new Error("Too many progress callbacks");
        }

        if (count === maxBlockCount) {
          // eslint-disable-next-line jest/no-conditional-expect
          expect(progress).toEqual({
            fullyLoadedFractionRanges: [
              {
                start: 0,
                end: 1.0,
              },
            ],
            messageCache: {
              blocks: [
                {
                  messagesByTopic: {
                    a: slicedMsgEvents.slice(0, 5),
                  },
                  needTopics: new Map(),
                  sizeInBytes: 5,
                },
                {
                  messagesByTopic: {
                    a: slicedMsgEvents.slice(5, 10),
                  },
                  needTopics: new Map(),
                  sizeInBytes: 5,
                },
              ],
              startTime: { sec: 0, nsec: 0 },
            },
            memoryInfo: {
              [MEMORY_INFO_PRELOADED_MSGS]: 10,
            },
          });

          await loader.stopLoading();
        }
      },
    });
  });

  it("should keep existing topic message references when removing another topic", async () => {
    const source = new TestSource();
    const maxBlockCount = 2;
    const loader = new BlockLoader({
      maxBlocks: maxBlockCount,
      cacheSizeBytes: 1_000,
      minBlockDurationNs: 1,
      source,
      start: { sec: 0, nsec: 0 },
      end: { sec: 9, nsec: 0 },
      problemManager: new PlayerProblemManager(),
    });

    const msgEvents: MessageEvent[] = [];
    for (let i = 0; i < 10; i += 1) {
      msgEvents.push({
        topic: "a",
        receiveTime: { sec: i, nsec: 0 },
        message: undefined,
        sizeInBytes: 10,
        schemaName: "foo",
      });
    }

    source.messageIterator = async function* messageIterator(
      args: MessageIteratorArgs,
    ): AsyncIterableIterator<Readonly<IteratorResult>> {
      for (let i = 0; i < 10; ++i) {
        for (const [topic] of args.topics) {
          yield {
            type: "message-event",
            msgEvent: {
              topic,
              receiveTime: { sec: i, nsec: 0 },
              message: undefined,
              sizeInBytes: 10,
              schemaName: "foo",
            },
          };
        }
      }
    };

    loader.setTopics(mockTopicSelection("a", "b"));
    let lastBlocks: Immutable<(MessageBlock | undefined)[]> | undefined;
    await loader.startLoading({
      progress: async (progress) => {
        lastBlocks = progress.messageCache?.blocks;

        if (
          progress.fullyLoadedFractionRanges?.[0]?.start === 0 &&
          progress.fullyLoadedFractionRanges[0].end === 1
        ) {
          await loader.stopLoading();
        }
      },
    });

    const firstBlockLoad = lastBlocks;

    loader.setTopics(mockTopicSelection("a"));
    let count = 0;

    setTimeout(async () => {
      await loader.stopLoading();
    }, 1000);
    await loader.startLoading({
      progress: async (progress) => {
        lastBlocks = progress.messageCache?.blocks;
        count += 1;
      },
    });

    // There should not be any loading calls because the topic is already loaded
    expect(count).toEqual(0);

    // Topic _a_ does not change and should not be re-loaded into the blocks. The existing message
    // arrays should be unchanged.
    expect(firstBlockLoad?.[0]?.messagesByTopic["a"]).toBe(lastBlocks?.[0]?.messagesByTopic["a"]);
    expect(firstBlockLoad?.[1]?.messagesByTopic["a"]).toBe(lastBlocks?.[1]?.messagesByTopic["a"]);
  });
});

describe("BlockLoader two-phase (plot-topics-first)", () => {
  // A source holding two topics across the whole range, recording every
  // messageIterator call so tests can assert fetch ordering. Messages respect
  // args.topics and args.start/end like a real indexed source.
  function makeRecordingSource(msgEvents: MessageEvent[]) {
    const source = new TestSource();
    const calls: Array<{ topics: string[]; startSec: number }> = [];
    source.messageIterator = async function* messageIterator(
      args: MessageIteratorArgs,
    ): AsyncIterableIterator<Readonly<IteratorResult>> {
      calls.push({
        topics: Array.from(args.topics.keys()).sort(),
        startSec: args.start?.sec ?? 0,
      });
      // Emit in receiveTime order, like a real indexed source — IteratorCursor
      // depends on time-ordered yields.
      const selected = msgEvents
        .filter(
          (m) =>
            args.topics.has(m.topic) &&
            (!args.start || m.receiveTime.sec >= args.start.sec) &&
            (!args.end || m.receiveTime.sec <= args.end.sec),
        )
        .sort((a, b) => a.receiveTime.sec - b.receiveTime.sec);
      for (const msgEvent of selected) {
        yield { type: "message-event", msgEvent };
      }
    };
    return { source, calls };
  }

  function makeMessages(topic: string, sizeInBytes: number, schemaName: string): MessageEvent[] {
    const out: MessageEvent[] = [];
    for (let i = 0; i < 10; i += 3) {
      out.push({
        topic,
        receiveTime: { sec: i, nsec: 0 },
        message: undefined,
        sizeInBytes,
        schemaName,
      });
    }
    return out;
  }

  it("loads priority topics across the whole range before any deferred topic", async () => {
    const msgs = [...makeMessages("plot", 1, "foo"), ...makeMessages("video", 1, "cv")];
    const { source, calls } = makeRecordingSource(msgs);

    const loader = new BlockLoader({
      maxBlocks: 5,
      cacheSizeBytes: 100,
      minBlockDurationNs: 1,
      source,
      start: { sec: 0, nsec: 0 },
      end: { sec: 9, nsec: 0 },
      problemManager: new PlayerProblemManager(),
      deferredTopics: new Set(["video"]),
    });

    loader.setTopics(mockTopicSelection("plot", "video"));
    await loader.startLoading({
      progress: async (progress) => {
        const blocks = progress.messageCache?.blocks ?? [];
        const complete = blocks.every(
          (b) => b?.messagesByTopic["plot"] && b.messagesByTopic["video"],
        );
        if (complete) {
          await loader.stopLoading();
        }
      },
    });

    // Pass 1 fetched only the priority topic; deferred topic came strictly after.
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls[0]!.topics).toEqual(["plot"]);
    const firstVideoCall = calls.findIndex((c) => c.topics.includes("video"));
    expect(firstVideoCall).toBeGreaterThan(0);
    for (const call of calls.slice(firstVideoCall)) {
      expect(call.topics).toEqual(["video"]);
    }
  });

  it("keeps single-pass behavior when no topics are deferred", async () => {
    const msgs = [...makeMessages("a", 1, "foo"), ...makeMessages("b", 1, "bar")];
    const { source, calls } = makeRecordingSource(msgs);

    const loader = new BlockLoader({
      maxBlocks: 5,
      cacheSizeBytes: 100,
      minBlockDurationNs: 1,
      source,
      start: { sec: 0, nsec: 0 },
      end: { sec: 9, nsec: 0 },
      problemManager: new PlayerProblemManager(),
    });

    loader.setTopics(mockTopicSelection("a", "b"));
    await loader.startLoading({
      progress: async (progress) => {
        const blocks = progress.messageCache?.blocks ?? [];
        const complete = blocks.every((b) => b?.messagesByTopic["a"] && b.messagesByTopic["b"]);
        if (complete) {
          await loader.stopLoading();
        }
      },
    });

    // Both topics fetched together, exactly as the single-phase loader does.
    expect(calls[0]!.topics).toEqual(["a", "b"]);
  });

  it("keeps completed priority data when the deferred pass fills the cache", async () => {
    const msgs = [...makeMessages("plot", 1, "foo"), ...makeMessages("video", 10, "cv")];
    const { source } = makeRecordingSource(msgs);
    const problemManager = new PlayerProblemManager();

    const loader = new BlockLoader({
      maxBlocks: 5,
      cacheSizeBytes: 8, // fits the 4 plot bytes; first 10-byte video message overflows
      minBlockDurationNs: 1,
      source,
      start: { sec: 0, nsec: 0 },
      end: { sec: 9, nsec: 0 },
      problemManager,
      deferredTopics: new Set(["video"]),
    });

    loader.setTopics(mockTopicSelection("plot", "video"));
    let sawCacheFull = false;
    let lastBlocks: Immutable<(MessageBlock | undefined)[]> = [];
    await loader.startLoading({
      progress: async (progress) => {
        lastBlocks = progress.messageCache?.blocks ?? [];
        if (problemManager.problems().some((p) => p.message.startsWith("Cache is full"))) {
          sawCacheFull = true;
          await loader.stopLoading();
        }
      },
    });
    expect(sawCacheFull).toBe(true);
    // Plot data from pass 1 must still be present in the blocks.
    const plotBlocks = lastBlocks.filter((b) => (b?.messagesByTopic["plot"]?.length ?? 0) > 0);
    expect(plotBlocks.length).toBeGreaterThan(0);
    consoleErrorMock.mockClear();
  });

  it("anchors the deferred pass at the active time", async () => {
    const msgs = [...makeMessages("plot", 1, "foo"), ...makeMessages("video", 1, "cv")];
    const { source, calls } = makeRecordingSource(msgs);

    const loader = new BlockLoader({
      maxBlocks: 5,
      cacheSizeBytes: 100,
      minBlockDurationNs: 1,
      source,
      start: { sec: 0, nsec: 0 },
      end: { sec: 9, nsec: 0 },
      problemManager: new PlayerProblemManager(),
      deferredTopics: new Set(["video"]),
    });

    loader.setActiveTime({ sec: 5, nsec: 0 });
    loader.setTopics(mockTopicSelection("plot", "video"));
    await loader.startLoading({
      progress: async (progress) => {
        const blocks = progress.messageCache?.blocks ?? [];
        const complete = blocks.every(
          (b) => b?.messagesByTopic["plot"] && b.messagesByTopic["video"],
        );
        if (complete) {
          await loader.stopLoading();
        }
      },
    });

    // The first deferred fetch starts at the anchor block (the block holding
    // sec 5), not at the beginning of the range.
    const videoCalls = calls.filter((c) => c.topics.includes("video"));
    expect(videoCalls.length).toBeGreaterThanOrEqual(2);
    expect(videoCalls[0]!.startSec).toBeGreaterThan(0);
    expect(videoCalls[0]!.startSec).toBeLessThanOrEqual(5);
    // The earlier region is still filled by a later wrap-around fetch.
    expect(videoCalls.some((c) => c.startSec === 0)).toBe(true);
  });
});
