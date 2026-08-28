// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

const { app, BrowserWindow, ipcMain, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const path = require("path");

// Allow self-signed certificates for local network connections (WSS to Edge Hubs, etc.)
app.on("certificate-error", (event, _webContents, url, _error, _certificate, callback) => {
  const parsed = new URL(url);
  const host = parsed.hostname;

  // Allow self-signed certs for localhost, private network IPs, and bare
  // local hostnames (e.g. mDNS/.local names or LAN device names like
  // "bl335" - single-label hostnames are never publicly routable, only
  // resolvable via mDNS/hosts/local DNS)
  const isLocal =
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host.startsWith("192.168.") ||
    host.startsWith("10.") ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
    host.endsWith(".local") ||
    !host.includes(".");

  if (isLocal) {
    event.preventDefault();
    callback(true);
  } else {
    callback(false);
  }
});

/** @type {BrowserWindow | undefined} */
let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: "octaview Studio",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const appPath = app.isPackaged
    ? path.join(process.resourcesPath, "app-web", "index.html")
    : path.join(__dirname, "..", "web", ".webpack", "index.html");

  mainWindow.loadFile(appPath);

  // Open external links in the system browser instead of a new Electron window
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("https://") || url.startsWith("http://")) {
      shell.openExternal(url);
    }
    return { action: "deny" };
  });
}

// --- Auto-updater ---

function sendUpdateStatus(status, info) {
  mainWindow?.webContents.send("update-status", { status, ...info });
}

function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("checking-for-update", () => {
    sendUpdateStatus("checking");
  });

  autoUpdater.on("update-available", (info) => {
    sendUpdateStatus("available", { version: info.version });
  });

  autoUpdater.on("update-not-available", () => {
    sendUpdateStatus("not-available");
  });

  autoUpdater.on("download-progress", (progress) => {
    sendUpdateStatus("downloading", { percent: Math.round(progress.percent) });
  });

  autoUpdater.on("update-downloaded", (info) => {
    sendUpdateStatus("downloaded", { version: info.version });
  });

  autoUpdater.on("error", (err) => {
    sendUpdateStatus("error", { message: err.message });
  });

  // Check for updates after a short delay, then every 30 minutes
  setTimeout(() => autoUpdater.checkForUpdates(), 5_000);
  setInterval(() => autoUpdater.checkForUpdates(), 30 * 60 * 1000);
}

// IPC handlers for renderer-initiated actions
ipcMain.handle("updater:check", () => autoUpdater.checkForUpdates());
ipcMain.handle("updater:download", () => autoUpdater.downloadUpdate());
ipcMain.handle("updater:install", () => autoUpdater.quitAndInstall());
ipcMain.handle("updater:get-version", () => app.getVersion());

app.whenReady().then(() => {
  createWindow();
  if (app.isPackaged) {
    setupAutoUpdater();
  }
});

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
