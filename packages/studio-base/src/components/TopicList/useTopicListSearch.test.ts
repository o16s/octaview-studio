/** @jest-environment jsdom */
// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { renderHook } from "@testing-library/react";

import { TopicListItem, UseTopicListSearchParams, useTopicListSearch } from "./useTopicListSearch";

function itemToString(topicListItem: TopicListItem): string {
  switch (topicListItem.type) {
    case "topic":
      return topicListItem.item.item.name;
    case "schema":
      return topicListItem.item.item.fullPath;
  }
}

describe("useTopicListSearch", () => {
  it("sorts topics with matches above matching paths", () => {
    const topics: UseTopicListSearchParams["topics"] = [
      { name: "abc", schemaName: "ABCD" },
      { name: "xyz", schemaName: "XYZW" },
    ];
    const datatypes: UseTopicListSearchParams["datatypes"] = new Map([
      ["ABCD", { definitions: [{ name: "xyz", type: "string" }] }],
      ["XYZW", { definitions: [{ name: "abcd", type: "string" }] }],
    ]);
    const { result } = renderHook(() =>
      useTopicListSearch({ topics, datatypes, filterText: "xyz" }),
    );
    expect(result.current.items.map(itemToString)).toEqual(["xyz", "abc", "abc.xyz"]);
  });

  it("sorts topics with matching schema names above matching paths", () => {
    const topics: UseTopicListSearchParams["topics"] = [
      { name: "abc", schemaName: "ABCD" },
      { name: "xyz", schemaName: "XYZW" },
    ];
    const datatypes: UseTopicListSearchParams["datatypes"] = new Map([
      ["ABCD", { definitions: [{ name: "xyz", type: "string" }] }],
      ["XYZW", { definitions: [{ name: "abcd", type: "string" }] }],
    ]);
    const { result } = renderHook(() => useTopicListSearch({ topics, datatypes, filterText: "d" }));
    expect(result.current.items.map(itemToString)).toEqual(["abc", "xyz", "xyz.abcd"]);
  });

  it("sorts better matches to the top", () => {
    const topics: UseTopicListSearchParams["topics"] = [
      { name: "footballer", schemaName: "ABCD" },
      { name: "xyz", schemaName: "XYZW" },
    ];
    const datatypes: UseTopicListSearchParams["datatypes"] = new Map([
      ["ABCD", { definitions: [{ name: "lmnop", type: "string" }] }],
      ["XYZW", { definitions: [{ name: "foobar", type: "string" }] }],
    ]);
    const { result } = renderHook(() =>
      useTopicListSearch({ topics, datatypes, filterText: "foobar" }),
    );
    expect(result.current.items.map(itemToString)).toEqual(["xyz", "xyz.foobar", "footballer"]);
  });

  it("returns fieldsByTopic for expand/collapse", () => {
    const topics: UseTopicListSearchParams["topics"] = [
      { name: "/abc", schemaName: "ABCD" },
      { name: "/empty", schemaName: undefined },
    ];
    const datatypes: UseTopicListSearchParams["datatypes"] = new Map([
      [
        "ABCD",
        {
          definitions: [
            { name: "x", type: "float64" },
            { name: "y", type: "float64" },
          ],
        },
      ],
    ]);
    const { result } = renderHook(() => useTopicListSearch({ topics, datatypes, filterText: "" }));
    const fields = result.current.fieldsByTopic.get("/abc");
    expect(fields).toBeDefined();
    expect(fields!.map(itemToString)).toEqual(["/abc.x", "/abc.y"]);

    // Topic with no schema has no fields
    expect(result.current.fieldsByTopic.get("/empty")).toBeUndefined();
  });

  it("includes topic matches when there's a trailing dot", () => {
    const topics: UseTopicListSearchParams["topics"] = [
      { name: "abc", schemaName: "ABCD" },
      { name: "abc2", schemaName: "ABCD" },
      { name: "xyz", schemaName: "XYZW" },
    ];
    const datatypes: UseTopicListSearchParams["datatypes"] = new Map([
      ["ABCD", { definitions: [{ name: "xyz", type: "string" }] }],
      ["XYZW", { definitions: [{ name: "abcd", type: "string" }] }],
    ]);
    const { result } = renderHook(() =>
      useTopicListSearch({ topics, datatypes, filterText: "abc." }),
    );
    expect(result.current.items.map(itemToString)).toEqual(["abc", "abc.xyz", "abc2", "abc2.xyz"]);
  });
});
