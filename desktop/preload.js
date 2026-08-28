// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("desktopBridge", {
  isDesktop: true,
  platform: process.platform,

  // Auto-updater API
  updater: {
    check: () => ipcRenderer.invoke("updater:check"),
    download: () => ipcRenderer.invoke("updater:download"),
    install: () => ipcRenderer.invoke("updater:install"),
    getVersion: () => ipcRenderer.invoke("updater:get-version"),
    onStatus: (callback) => {
      const handler = (_event, data) => callback(data);
      ipcRenderer.on("update-status", handler);
      return () => ipcRenderer.removeListener("update-status", handler);
    },
  },

  // OS-keychain-backed secure storage (see main.js) - for secrets like Edge Hub API
  // tokens that must never be written in plaintext.
  secureStorage: {
    get: (key) => ipcRenderer.invoke("secure-storage:get", key),
    set: (key, value) => ipcRenderer.invoke("secure-storage:set", key, value),
    delete: (key) => ipcRenderer.invoke("secure-storage:delete", key),
  },
});
