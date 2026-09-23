// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import path from "path";

import { ConfigParams, devServerConfig, mainConfig } from "@foxglove/studio-web/src/webpackConfigs";

import packageJson from "../package.json";

const params: ConfigParams = {
  outputPath: path.resolve(__dirname, ".webpack"),
  contextPath: path.resolve(__dirname, "src"),
  entrypoint: "./entrypoint.tsx",
  prodSourceMap: "source-map",
  // Desktop releases bump desktop/package.json, not this root package.json, so
  // the packaged UI would otherwise show a frozen dev version. The desktop
  // release workflow sets OCTAVIEW_STUDIO_VERSION from the git tag; plain
  // web/dev builds fall back to the root package.json version.
  version: process.env.OCTAVIEW_STUDIO_VERSION ?? packageJson.version,
};

// foxglove-depcheck-used: webpack-dev-server
export default [devServerConfig(params), mainConfig(params)];
