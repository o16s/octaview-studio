// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { Time, toRFC3339String } from "@foxglove/rostime";
import {
  AppURLState,
  layoutLinkParams,
  updateAppURLState,
  parseAppURLState,
  parseLayoutParam,
} from "@foxglove/studio-base/util/appURLState";
import isDesktopApp from "@foxglove/studio-base/util/isDesktopApp";

jest.mock("@foxglove/studio-base/util/isDesktopApp", () => ({
  __esModule: true,
  default: jest.fn(),
}));

const mockIsDesktop = isDesktopApp as jest.MockedFunction<typeof isDesktopApp>;

describe("app state url parser", () => {
  // Note that the foxglove URL here is different from actual foxglove URLs because Node's URL parser
  // interprets foxglove:// URLs differently than the browser does.
  describe.each([
    { isDesktop: true, urlBuilder: () => new URL("foxglove://host/open") },
    { isDesktop: false, urlBuilder: () => new URL("https://studio.octaview.ai/") },
  ])("url tests", ({ isDesktop, urlBuilder }) => {
    beforeEach(() => mockIsDesktop.mockReturnValue(isDesktop));
    it("rejects non data state urls", () => {
      expect(parseAppURLState(urlBuilder())).toBeUndefined();
    });

    it("parses rosbag data state urls", () => {
      const url = urlBuilder();
      url.searchParams.append("ds", "ros1-remote-bagfile");
      url.searchParams.append("ds.url", "http://example.com");

      expect(parseAppURLState(url)).toMatchObject({
        ds: "ros1-remote-bagfile",
        dsParams: {
          url: "http://example.com",
        },
      });
    });

    it("parses data platform state urls", () => {
      const now: Time = { sec: new Date().getTime(), nsec: 0 };
      const time = toRFC3339String({ sec: now.sec + 500, nsec: 0 });
      const start = toRFC3339String(now);
      const end = toRFC3339String({ sec: now.sec + 1000, nsec: 0 });
      const url = urlBuilder();
      url.searchParams.append("ds", "foo");
      url.searchParams.append("time", time);
      url.searchParams.append("ds.bar", "barValue");
      url.searchParams.append("ds.baz", "bazValue");
      url.searchParams.append("ds.start", start);
      url.searchParams.append("ds.end", end);
      url.searchParams.append("ds.eventId", "dummyEventId");

      const parsed = parseAppURLState(url);
      expect(parsed).toMatchObject({
        ds: "foo",
        time: { sec: now.sec + 500, nsec: 0 },
        dsParams: { bar: "barValue", baz: "bazValue" },
      });
    });
  });
});

describe("parseLayoutParam", () => {
  const sampleLayout = {
    configById: { "Plot!abc": { paths: [] } },
    globalVariables: {},
    userNodes: {},
    playbackConfig: { speed: 1 },
    layout: "Plot!abc",
  };

  it("parses base64-encoded layout JSON", () => {
    const encoded = btoa(JSON.stringify(sampleLayout));
    const result = parseLayoutParam(encoded);
    expect(result).toEqual(sampleLayout);
  });

  it("parses raw JSON layout", () => {
    const raw = JSON.stringify(sampleLayout);
    const result = parseLayoutParam(raw);
    expect(result).toEqual(sampleLayout);
  });

  it("returns undefined for invalid input", () => {
    expect(parseLayoutParam("not-json-or-base64!!!")).toBeUndefined();
  });

  it("requires layout field to be present", () => {
    const noLayout = { configById: {} };
    expect(parseLayoutParam(JSON.stringify(noLayout))).toBeUndefined();
  });

  it("fills in defaults for missing optional fields", () => {
    const minimal = { layout: "Plot!abc", configById: { "Plot!abc": {} } };
    const result = parseLayoutParam(JSON.stringify(minimal));
    expect(result).toEqual({
      layout: "Plot!abc",
      configById: { "Plot!abc": {} },
      globalVariables: {},
      userNodes: {},
      playbackConfig: { speed: 1 },
    });
  });
});

describe("parseAppURLState with layout params", () => {
  it("parses layout from URL", () => {
    const layout = { layout: "Plot!abc", configById: {} };
    const url = new URL("https://example.com/");
    url.searchParams.set("layout", btoa(JSON.stringify(layout)));
    const state = parseAppURLState(url);
    expect(state?.layoutParam).toBeDefined();
  });

  it("parses layoutUrl from URL", () => {
    const url = new URL("https://example.com/");
    url.searchParams.set("layoutUrl", "https://example.com/my-layout.json");
    const state = parseAppURLState(url);
    expect(state?.layoutUrl).toBe("https://example.com/my-layout.json");
  });
});

describe("app state encoding", () => {
  const baseURL = () => new URL("http://example.com");

  it("encodes rosbag urls", () => {
    expect(
      updateAppURLState(baseURL(), {
        time: undefined,
        ds: "ros1-remote-bagfile",
        dsParams: {
          url: "http://octaview.ai/test.bag",
        },
      }).href,
    ).toEqual(
      "http://example.com/?ds=ros1-remote-bagfile&ds.url=http%3A%2F%2Foctaview.ai%2Ftest.bag",
    );
  });

  describe("url states", () => {
    const eventId = "dummyEventId";
    const time = undefined;
    it.each<AppURLState>([
      {
        time,
        ds: "ros1",
        dsParams: { url: "http://example.com:11311/test.bag", eventId },
      },
      {
        time,
        ds: "ros2",
        dsParams: { url: "http://example.com:11311/test.bag", eventId },
      },
      {
        time,
        ds: "ros1-remote-bagfile",
        dsParams: { url: "http://example.com/test.bag", eventId },
      },
      {
        time,
        ds: "rosbridge-websocket",
        dsParams: { url: "ws://octaview.ai:9090/test.bag", eventId },
      },
    ])("encodes url state", (state) => {
      const url = state.dsParams?.url;
      const encodededURL = updateAppURLState(baseURL(), state).href;
      expect(encodededURL).toEqual(
        `http://example.com/?ds=${state.ds}&ds.eventId=${eventId}&ds.url=${encodeURIComponent(
          url ?? "",
        )}`,
      );
    });
  });
});

describe("layoutLinkParams", () => {
  it("reads an inline layout and a layout URL", () => {
    expect(layoutLinkParams("?layout=eyJ4IjoxfQ&layoutUrl=/l.json")).toEqual({
      layout: "eyJ4IjoxfQ",
      layoutUrl: "/l.json",
    });
  });

  it("reads a missing parameter as absent", () => {
    expect(layoutLinkParams("")).toEqual({ layout: undefined, layoutUrl: undefined });
    expect(layoutLinkParams("?ds=mcap-server")).toEqual({
      layout: undefined,
      layoutUrl: undefined,
    });
  });

  // edge-hub expands `layout={layout}` and leaves the value empty when no
  // stored layout matches. URLSearchParams.has is true for that, which is what
  // left the workspace with no layout and no way to add a panel.
  it("reads an empty value as absent", () => {
    expect(layoutLinkParams("?layout=")).toEqual({ layout: undefined, layoutUrl: undefined });
    expect(layoutLinkParams("?layoutUrl=")).toEqual({ layout: undefined, layoutUrl: undefined });
  });

  it("reads an empty value as absent in a real hub link", () => {
    const search =
      "?ds=mcap-server&layout=&file=%2Fmnt%2Fdatalog%2Fzed2mqtt%2Fevents%2Fcam1%2Fcam1_event.mcap" +
      "&time=2026-09-11T09%3A44%3A14.340712543Z";

    expect(layoutLinkParams(search).layout).toBeUndefined();
  });
});

describe("parseAppURLState with a bare ds", () => {
  // The guard in Workspace's "Load data source from URL" effect keys on
  // dsParams being undefined, so pin what a link without any `ds.` parameter
  // parses to. edge-hub sends this shape on an event link.
  const eventLink = new URL(
    "https://jetson:8152/?ds=mcap-server&layout=" +
      "&file=%2Fmnt%2Fdatalog%2Fzed2mqtt%2Fevents%2Fcam1%2Fcam1_event.mcap" +
      "&time=2026-09-11T09%3A44%3A14.340712543Z",
  );

  it("names the source but gives it nothing to open", () => {
    const state = parseAppURLState(eventLink);

    expect(state?.ds).toBe("mcap-server");
    expect(state?.dsParams).toBeUndefined();
  });

  it("still reads the time, which the ?file= source seeks to", () => {
    expect(parseAppURLState(eventLink)?.time).toBeDefined();
  });

  it("carries no layout from an empty layout parameter", () => {
    expect(parseAppURLState(eventLink)?.layoutParam).toBeUndefined();
  });
});
