// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

export enum AppSetting {
  // General
  COLOR_SCHEME = "colorScheme",
  TIMEZONE = "timezone",
  TIME_FORMAT = "time.format",
  MESSAGE_RATE = "messageRate",
  UPDATES_ENABLED = "updates.enabled",
  LANGUAGE = "language",

  // ROS
  ROS_PACKAGE_PATH = "ros.ros_package_path",

  // Edge Hub
  EDGE_HUB_LAYOUTS = "edgeHub.layoutsByIp",

  // Experimental features
  SHOW_DEBUG_PANELS = "showDebugPanels",
  ENABLE_VIDEO_EXPORT = "experimental.videoExport",

  // Miscellaneous
  HIDE_SIGN_IN_PROMPT = "hideSignInPrompt",
  LAUNCH_PREFERENCE = "launchPreference",
  SHOW_OPEN_DIALOG_ON_STARTUP = "ui.open-dialog-startup",
  ENABLE_UNIFIED_NAVIGATION = "ui.new-app-menu",

  // Agent / AI assistant
  AGENT_BACKEND = "agent.backend",
  AGENT_API_ENDPOINT = "agent.apiEndpoint",
  AGENT_API_KEY = "agent.apiKey",
  AGENT_MODEL = "agent.model",
  AGENT_WEBLLM_MODEL = "agent.webllm.model",
  AGENT_WEBLLM_CTX_SIZE = "agent.webllm.contextSize",

  // Dev only
  ENABLE_LAYOUT_DEBUGGING = "enableLayoutDebugging",
}
