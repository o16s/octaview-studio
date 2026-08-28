// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

/** Appends the default Edge Hub port (8443) to a bare ip/hostname, if it doesn't already have one. */
export function buildEdgeHubHost(ip: string): string {
  return ip.includes(":") ? ip : `${ip}:8443`;
}
