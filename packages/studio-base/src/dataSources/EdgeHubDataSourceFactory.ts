// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

import {
  IDataSourceFactory,
  DataSourceFactoryInitializeArgs,
} from "@foxglove/studio-base/context/PlayerSelectionContext";
import { buildEdgeHubHost } from "@foxglove/studio-base/dataSources/edgeHubHost";
import FoxgloveWebSocketPlayer from "@foxglove/studio-base/players/FoxgloveWebSocketPlayer";
import { Player } from "@foxglove/studio-base/players/types";

// QR Code schema for octaview Edge Hub:
//   octaview://<ip>:<port>/<token>
//
// Example:
//   octaview://192.168.123.185:8443/abc123def456
//
// The app parses the QR code and fills in the IP and token fields automatically.

export default class EdgeHubDataSourceFactory implements IDataSourceFactory {
  public id = "octaview-edge-hub";
  public type: IDataSourceFactory["type"] = "connection";
  public displayName = "octaview Edge Hub";
  public iconName: IDataSourceFactory["iconName"] = "Flow";
  public description = "Connect to an octaview Edge Hub on your local network.";
  public docsLinks = [];

  public formConfig = {
    fields: [
      {
        id: "ip",
        label: "IP Address",
        defaultValue: "",
        placeholder: "192.168.1.100",
        validate: (newValue: string): Error | undefined => {
          const trimmed = newValue.trim();
          if (!trimmed) {
            return new Error("Enter the Edge Hub IP address");
          }
          // Accept IP or hostname, optionally with port
          if (!/^[\w.-]+(:\d+)?$/.test(trimmed)) {
            return new Error("Enter a valid IP address or hostname");
          }
          return undefined;
        },
      },
      {
        id: "token",
        label: "API Token",
        defaultValue: "",
        placeholder: "Find this in Edge Hub Settings → API Tokens",
        validate: (newValue: string): Error | undefined => {
          if (!newValue.trim()) {
            return new Error("API token is required");
          }
          return undefined;
        },
      },
    ],
  };

  public initialize(args: DataSourceFactoryInitializeArgs): Player | undefined {
    const ip = args.params?.ip?.trim();
    const token = args.params?.token?.trim();
    if (!ip || !token) {
      return;
    }

    const url = `wss://${buildEdgeHubHost(ip)}/api/v1/ws`;

    return new FoxgloveWebSocketPlayer({
      url,
      token,
      metricsCollector: args.metricsCollector,
      sourceId: this.id,
    });
  }
}
