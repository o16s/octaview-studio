// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

const { app, BrowserWindow, shell } = require("electron");
const path = require("path");

// Allow self-signed certificates for local network connections (WSS to Edge Hubs, etc.)
app.on("certificate-error", (event, _webContents, url, _error, _certificate, callback) => {
  const parsed = new URL(url);
  const host = parsed.hostname;

  // Allow self-signed certs for localhost and private network IPs
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);

  if (isLocal) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "Octaview Studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const appPath = app.isPackaged
    ? path.join(process.resourcesPath, "app-web", "index.html")
    : path.join(__dirname, "..", "web", ".webpack", "index.html");

  win.loadFile(appPath);

  // Open external links in the system browser instead of a new Electron window
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
