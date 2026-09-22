// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { compare, isLessThan, isGreaterThan, Time } from "@foxglove/rostime";
import { Immutable, MessageEvent } from "@foxglove/studio";
import { TopicSelection, TopicStats } from "@foxglove/studio-base/players/types";

import { McapIterableSource } from "./McapIterableSource";
import { cacheSizeForSourceCount } from "./RemoteFileReadable";
import {
  GetBackfillMessagesArgs,
  IIterableSource,
  Initalization,
  IteratorResult,
  MessageIteratorArgs,
  SourceRange,
} from "../IIterableSource";

/**
 * Wraps multiple McapIterableSource instances and merges their messages
 * in chronological order. Topics, datatypes, and time ranges from all
 * sources are combined.
 */
export class McapMultiSource implements IIterableSource {
  #sources: McapIterableSource[];
  #sourceNames: string[];
  #sourceFolders: (string | undefined)[];

  public constructor(sources: Blob[] | string[]) {
    // Every remote source keeps its own byte cache, so the budget is shared out
    // rather than taken once per recording.
    const cacheSizeInBytes = cacheSizeForSourceCount(sources.length);
    this.#sources = sources.map((source) =>
      typeof source === "string"
        ? new McapIterableSource({ type: "url", url: source, cacheSizeInBytes })
        : new McapIterableSource({ type: "file", file: source }),
    );
    // Extract name and folder from source paths.
    // URL sources are typically /api/mcap/files/<encoded-path> where the last
    // segment is the full encoded file path (e.g. "subfolder%2Ffile.mcap").
    const parsed = sources.map((source) => {
      if (typeof source === "string") {
        const decoded = decodeURIComponent(source.split("/").pop() ?? source);
        const slashIdx = decoded.lastIndexOf("/");
        if (slashIdx > 0) {
          return { name: decoded.slice(slashIdx + 1), folder: decoded.slice(0, slashIdx) };
        }
        return { name: decoded, folder: undefined };
      }
      const fileName = (source as { name?: string }).name ?? "unknown";
      const fileSlashIdx = fileName.lastIndexOf("/");
      if (fileSlashIdx > 0) {
        return { name: fileName.slice(fileSlashIdx + 1), folder: fileName.slice(0, fileSlashIdx) };
      }
      return { name: fileName, folder: undefined };
    });
    this.#sourceNames = parsed.map((p) => p.name);
    this.#sourceFolders = parsed.map((p) => p.folder);
  }

  public async initialize(): Promise<Initalization> {
    const results = await Promise.all(this.#sources.map(async (s) => await s.initialize()));

    // Merge all initialization results
    let start: Time | undefined;
    let end: Time | undefined;
    const topicStats = new Map<string, TopicStats>();
    const topicsByName = new Map<string, { name: string; schemaName: string | undefined }>();
    const datatypes: Initalization["datatypes"] = new Map();
    const publishersByTopic = new Map<string, Set<string>>();
    const problems: Initalization["problems"] = [];
    let profile: string | undefined;

    const sourceRanges: SourceRange[] = [];

    for (let ri = 0; ri < results.length; ri++) {
      const result = results[ri]!;

      sourceRanges.push({
        name: this.#sourceNames[ri] ?? `source-${ri}`,
        folder: this.#sourceFolders[ri],
        start: result.start,
        end: result.end,
      });

      // Expand time range
      if (start == undefined || isLessThan(result.start, start)) {
        start = result.start;
      }
      if (end == undefined || isGreaterThan(result.end, end)) {
        end = result.end;
      }

      // Merge profile (use first non-undefined)
      profile ??= result.profile;

      // Merge topics
      for (const topic of result.topics) {
        topicsByName.set(topic.name, topic);
      }

      // Merge topic stats
      for (const [name, stats] of result.topicStats) {
        const existing = topicStats.get(name);
        if (existing) {
          topicStats.set(name, {
            numMessages: existing.numMessages + stats.numMessages,
          });
        } else {
          topicStats.set(name, { ...stats });
        }
      }

      // Merge datatypes
      for (const [name, def] of result.datatypes) {
        datatypes.set(name, def);
      }

      // Merge publishers
      for (const [topic, pubs] of result.publishersByTopic) {
        const existing = publishersByTopic.get(topic);
        if (existing) {
          for (const pub of pubs) {
            existing.add(pub);
          }
        } else {
          publishersByTopic.set(topic, new Set(pubs));
        }
      }

      problems.push(...result.problems);
    }

    return {
      start: start ?? { sec: 0, nsec: 0 },
      end: end ?? { sec: 0, nsec: 0 },
      topics: Array.from(topicsByName.values()),
      topicStats,
      datatypes,
      profile,
      publishersByTopic,
      problems,
      sourceRanges: sourceRanges.length > 1 ? sourceRanges : undefined,
    };
  }

  public async *messageIterator(
    args: Immutable<MessageIteratorArgs>,
  ): AsyncIterableIterator<Readonly<IteratorResult>> {
    // Copy args with a mutable topics map for passing to sub-sources
    const mutableArgs: MessageIteratorArgs = {
      ...args,
      topics: new Map(args.topics) as TopicSelection,
    };
    // Create iterators for all sources
    const iterators = this.#sources.map((source) => source.messageIterator(mutableArgs));

    // Initialize the head of each iterator
    type HeadEntry = {
      result: IteratorResult;
      iterator: AsyncIterableIterator<Readonly<IteratorResult>>;
    };
    const heads: HeadEntry[] = [];

    await Promise.all(
      iterators.map(async (iterator) => {
        const next = await iterator.next();
        if (next.done !== true) {
          heads.push({ result: next.value, iterator });
        }
      }),
    );

    // Merge-sort: always yield the entry with the smallest timestamp
    while (heads.length > 0) {
      // Find the head with the earliest timestamp
      let minIdx = 0;
      for (let i = 1; i < heads.length; i++) {
        if (compareResults(heads[i]!.result, heads[minIdx]!.result) < 0) {
          minIdx = i;
        }
      }

      const entry = heads[minIdx]!;
      yield entry.result;

      // Advance that iterator
      const next = await entry.iterator.next();
      if (next.done === true) {
        heads.splice(minIdx, 1);
      } else {
        entry.result = next.value;
      }
    }
  }

  public async getBackfillMessages(
    args: Immutable<GetBackfillMessagesArgs>,
  ): Promise<MessageEvent[]> {
    const mutableArgs: GetBackfillMessagesArgs = {
      ...args,
      topics: new Map(args.topics) as TopicSelection,
    };
    // Get backfill messages from all sources and keep the latest per topic
    const allMessages = await Promise.all(
      this.#sources.map(async (source) => await source.getBackfillMessages(mutableArgs)),
    );

    const latestByTopic = new Map<string, MessageEvent>();
    for (const messages of allMessages) {
      for (const msg of messages) {
        const existing = latestByTopic.get(msg.topic);
        if (!existing || compare(msg.receiveTime, existing.receiveTime) > 0) {
          latestByTopic.set(msg.topic, msg);
        }
      }
    }

    return Array.from(latestByTopic.values());
  }
}

/** Compare two IteratorResults by timestamp for merge-sort ordering. */
function compareResults(a: IteratorResult, b: IteratorResult): number {
  return compare(getResultTime(a), getResultTime(b));
}

function getResultTime(result: IteratorResult): Time {
  switch (result.type) {
    case "message-event":
      return result.msgEvent.receiveTime;
    case "stamp":
      return result.stamp;
    case "problem":
      return { sec: 0, nsec: 0 };
  }
}
