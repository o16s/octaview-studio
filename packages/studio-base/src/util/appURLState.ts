// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import * as _ from "lodash-es";

import { fromRFC3339String, toRFC3339String, Time } from "@foxglove/rostime";

import { LayoutData } from "@foxglove/studio-base/context/CurrentLayoutContext/actions";

export type AppURLState = {
  ds?: string;
  dsParams?: Record<string, string>;
  time?: Time;
  layoutParam?: LayoutData;
  layoutUrl?: string;
};

/** The layout parameters of a deep link, with an empty value read as absent. */
export type LayoutLinkParams = {
  /** An inline layout, base64 or raw JSON. */
  layout?: string;
  /** A URL to fetch the layout JSON from. */
  layoutUrl?: string;
};

/**
 * Read the layout parameters of a deep link.
 *
 * An empty value counts as absent. edge-hub expands `layout={layout}` in its
 * link template and leaves the value empty when no stored layout matches the
 * view or the file, so `?layout=` arrives on ordinary links.
 *
 * `URLSearchParams.has` is true for an empty value, so a caller that only asks
 * whether the parameter is present concludes that the URL supplies a layout
 * when it does not. One reader that decided it this way and one that tested the
 * value left the workspace with no layout at all.
 */
export function layoutLinkParams(search: string): LayoutLinkParams {
  const params = new URLSearchParams(search);
  const nonEmpty = (name: string): string | undefined => {
    const value = params.get(name);
    return value == undefined || value === "" ? undefined : value;
  };
  return { layout: nonEmpty("layout"), layoutUrl: nonEmpty("layoutUrl") };
}

/**
 * Parse a layout parameter value (base64 or raw JSON) into LayoutData.
 * Returns undefined if parsing fails or the result is not a valid layout.
 */
export function parseLayoutParam(value: string): LayoutData | undefined {
  let parsed: unknown;

  // Try base64 first, then raw JSON
  try {
    parsed = JSON.parse(atob(value));
  } catch {
    try {
      parsed = JSON.parse(value);
    } catch {
      return undefined;
    }
  }

  if (typeof parsed !== "object" || parsed == undefined) {
    return undefined;
  }

  const obj = parsed as Record<string, unknown>;

  // layout field is required
  if (!("layout" in obj) || obj.layout == undefined) {
    return undefined;
  }

  return {
    layout: obj.layout as LayoutData["layout"],
    configById: (obj.configById ?? {}) as LayoutData["configById"],
    globalVariables: (obj.globalVariables ?? {}) as LayoutData["globalVariables"],
    userNodes: (obj.userNodes ?? {}) as LayoutData["userNodes"],
    playbackConfig: (obj.playbackConfig ?? { speed: 1 }) as LayoutData["playbackConfig"],
  };
}

/**
 * Encodes app state in a URL's query params.
 *
 * @param url The base URL to encode params into.
 * @param urlState The player state to encode.
 * @returns A url with all app state stored as query pararms.
 */
export function updateAppURLState(url: URL, urlState: AppURLState): URL {
  const newURL = new URL(url.href);

  if ("time" in urlState) {
    if (urlState.time) {
      newURL.searchParams.set("time", toRFC3339String(urlState.time));
    } else {
      newURL.searchParams.delete("time");
    }
  }

  if ("ds" in urlState) {
    if (urlState.ds) {
      newURL.searchParams.set("ds", urlState.ds);
    } else {
      newURL.searchParams.delete("ds");
    }
  }

  if ("dsParams" in urlState) {
    [...newURL.searchParams].forEach(([k]) => {
      if (k.startsWith("ds.")) {
        newURL.searchParams.delete(k);
      }
    });

    Object.entries(urlState.dsParams ?? "").forEach(([k, v]) => {
      newURL.searchParams.set("ds." + k, v);
    });
  }

  newURL.searchParams.sort();

  return newURL;
}

/**
 * Tries to parse a state url into one of the types we know how to open.
 *
 * @param url URL to try to parse.
 * @returns Parsed URL type or undefined if the url is not a valid URL.
 * @throws Error if URL parsing fails.
 */
export function parseAppURLState(url: URL): AppURLState | undefined {
  const ds = url.searchParams.get("ds") ?? undefined;
  const timeString = url.searchParams.get("time");
  const time = timeString == undefined ? undefined : fromRFC3339String(timeString);
  const dsParams: Record<string, string> = {};
  url.searchParams.forEach((v, k) => {
    if (k && v && k.startsWith("ds.")) {
      const cleanKey = k.replace(/^ds./, "");
      dsParams[cleanKey] = v;
    }
  });

  const layoutParamValue = url.searchParams.get("layout") ?? undefined;
  const layoutParam = layoutParamValue ? parseLayoutParam(layoutParamValue) : undefined;
  const layoutUrl = url.searchParams.get("layoutUrl") ?? undefined;

  const state: AppURLState = _.omitBy(
    {
      time,
      ds,
      dsParams: _.isEmpty(dsParams) ? undefined : dsParams,
      layoutParam,
      layoutUrl,
    },
    _.isEmpty,
  );

  return _.isEmpty(state) ? undefined : state;
}
