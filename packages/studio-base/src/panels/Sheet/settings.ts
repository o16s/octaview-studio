// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import { SettingsTreeAction, SettingsTreeNode, SettingsTreeNodes } from "@foxglove/studio";

import { SheetConfig } from "./types";

type SettingsTreeChildren = NonNullable<SettingsTreeNode["children"]>;

/**
 * Settings tree for the Sheet panel: each available topic is a child node with a
 * visibility (eye) toggle, shown when the topic is visible. A node label gets
 * the full row width, unlike a field label — so long topic names aren't
 * truncated and widening the sidebar actually helps. The default (no hidden
 * topics) shows every topic; hiding one adds it to the hidden set.
 */
export function buildSettingsTree(
  config: SheetConfig,
  availableTopics: readonly string[],
): SettingsTreeNodes {
  const hidden = new Set(config.hiddenTopics ?? []);

  const children: SettingsTreeChildren = {};
  for (const topic of availableTopics) {
    children[topic] = { label: topic, visible: !hidden.has(topic) };
  }

  return {
    topics: {
      label: "Topics",
      children: availableTopics.length === 0 ? undefined : children,
    },
  };
}

/**
 * Fold a settings action into the config. Toggling a topic node's visibility off
 * adds it to the hidden set; toggling it on removes it. Only the toggled topic
 * changes, so topics that appear later are unaffected and stay visible.
 */
export function settingsActionReducer(
  config: SheetConfig,
  action: SettingsTreeAction,
): SheetConfig {
  if (action.action !== "update") {
    return config;
  }

  // Node visibility toggles arrive as ["topics", <topic>, "visible"].
  const { path, value } = action.payload;
  if (
    path[0] === "topics" &&
    path.length === 3 &&
    path[2] === "visible" &&
    typeof value === "boolean"
  ) {
    const topic = path[1]!;
    const hidden = new Set(config.hiddenTopics ?? []);
    if (value) {
      hidden.delete(topic);
    } else {
      hidden.add(topic);
    }
    return { ...config, hiddenTopics: [...hidden] };
  }

  return config;
}
