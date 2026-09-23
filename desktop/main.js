// This Source Code Form is subject to the terms of the Mozilla Public
// License, v2.0. If a copy of the MPL was not distributed with this
// file, You can obtain one at http://mozilla.org/MPL/2.0/

const { app, BrowserWindow, ipcMain, protocol, safeStorage, shell } = require("electron");
const { autoUpdater } = require("electron-updater");
const fsSync = require("fs");
const fs = require("fs/promises");
const path = require("path");
const { Readable } = require("stream");

// The renderer opens recordings this app is registered for through its own
// privileged protocol rather than reading them off disk in the page. The scheme
// must be declared before the app is ready. `supportFetchAPI` + `stream` let the
// MCAP reader fetch byte ranges from it; the handler (installed in whenReady)
// honors HTTP Range so a large recording is never loaded whole.
protocol.registerSchemesAsPrivileged([
  {
    scheme: "mcap-local",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: true,
    },
  },
]);

// Opt-in Chrome DevTools Protocol endpoint for debugging/benchmarking the
// running app (e.g. OCTAVIEW_DEBUG_PORT=9222). CDP grants full control of the
// app, so it is env-gated and Electron binds it to 127.0.0.1 only.
if (process.env.OCTAVIEW_DEBUG_PORT) {
  app.commandLine.appendSwitch("remote-debugging-port", process.env.OCTAVIEW_DEBUG_PORT);
}

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

// --- Opening MCAP files the OS hands us ---
//
// The app registers as a handler for `.mcap` (see fileAssociations in
// package.json). macOS delivers the path through the "open-file" event;
// Windows/Linux pass it in argv. Either way we forward it to the renderer, which
// opens it over the mcap-local:// protocol below.

/** A recording named on launch but not yet claimed by the renderer. */
let pendingOpenFile;

/** Build the mcap-local:// URL the renderer opens for an absolute host path. */
function mcapLocalUrl(absPath) {
  // The whole path rides as one encoded segment, so separators and spaces
  // survive; the protocol handler decodes it back.
  return `mcap-local://file/${encodeURIComponent(absPath)}`;
}

/** The first `.mcap` path in an argv list, if any (Windows/Linux launch). */
function firstMcapArg(argv) {
  return argv.find((arg) => !arg.startsWith("-") && arg.toLowerCase().endsWith(".mcap"));
}

/** Hand a recording to the renderer, or hold it until the renderer asks. */
function handleOpenPath(filePath) {
  if (!filePath || !filePath.toLowerCase().endsWith(".mcap")) {
    return;
  }
  const payload = { url: mcapLocalUrl(filePath), name: path.basename(filePath) };

  // Once the window has loaded, the renderer is listening, so push it straight
  // through. Before that (the launch case) it pulls pendingOpenFile on mount.
  if (mainWindow && !mainWindow.webContents.isLoading()) {
    mainWindow.webContents.send("open-mcap-file", payload);
    if (mainWindow.isMinimized()) {
      mainWindow.restore();
    }
    mainWindow.focus();
  } else {
    pendingOpenFile = payload;
  }
}

// macOS delivers file opens here, often before the app is ready.
app.on("open-file", (event, filePath) => {
  event.preventDefault();
  handleOpenPath(filePath);
});

/** Read one local recording over mcap-local://, honoring HTTP Range requests. */
async function serveMcapLocal(request) {
  let filePath;
  try {
    // mcap-local://file/<encoded absolute path> -> host "file", one path segment.
    const encoded = new URL(request.url).pathname.replace(/^\/+/, "");
    filePath = decodeURIComponent(encoded);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // Only ever serve `.mcap` files, and only real files — the renderer is
  // sandboxed, so this is the trust boundary for what it can read off disk.
  if (!filePath.toLowerCase().endsWith(".mcap")) {
    return new Response("Forbidden", { status: 403 });
  }
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!stat.isFile()) {
    return new Response("Not found", { status: 404 });
  }

  const size = stat.size;
  const headers = { "accept-ranges": "bytes", "content-type": "application/octet-stream" };
  const range = /^bytes=(\d*)-(\d*)$/.exec((request.headers.get("range") ?? "").trim());

  if (range) {
    let start = range[1] === "" ? undefined : parseInt(range[1], 10);
    let end = range[2] === "" ? undefined : parseInt(range[2], 10);
    if (start == undefined) {
      // Suffix range "bytes=-N": the last N bytes.
      start = end == undefined ? 0 : Math.max(0, size - end);
      end = size - 1;
    } else {
      end = end == undefined ? size - 1 : Math.min(end, size - 1);
    }
    if (start > end || start >= size) {
      return new Response(undefined, {
        status: 416,
        headers: { ...headers, "content-range": `bytes */${size}` },
      });
    }
    const stream = fsSync.createReadStream(filePath, { start, end });
    return new Response(Readable.toWeb(stream), {
      status: 206,
      headers: {
        ...headers,
        "content-range": `bytes ${start}-${end}/${size}`,
        "content-length": String(end - start + 1),
      },
    });
  }

  const stream = fsSync.createReadStream(filePath);
  return new Response(Readable.toWeb(stream), {
    status: 200,
    headers: { ...headers, "content-length": String(size) },
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
  setTimeout(() => autoUpdater.checkForUpdates(), 5000);
  setInterval(() => autoUpdater.checkForUpdates(), 30 * 60 * 1000);
}

// IPC handlers for renderer-initiated actions
ipcMain.handle("updater:check", () => autoUpdater.checkForUpdates());
ipcMain.handle("updater:download", () => autoUpdater.downloadUpdate());
ipcMain.handle("updater:install", () => autoUpdater.quitAndInstall());
ipcMain.handle("updater:get-version", () => app.getVersion());

// --- Secure storage ---
// Encrypts values with the OS keychain (safeStorage) before writing them to disk, so
// secrets like Edge Hub API tokens are never persisted in plaintext.

const SECURE_STORAGE_DIR = path.join(app.getPath("userData"), "secure-storage");
// Keys are used to build filenames, so restrict them to a safe charset (defense in
// depth against a compromised renderer trying to pass a path-traversal key).
const SECURE_STORAGE_KEY_PATTERN = /^[a-zA-Z0-9_-]+$/;

function secureStorageFilePath(key) {
  if (!SECURE_STORAGE_KEY_PATTERN.test(key)) {
    throw new Error(`Invalid secure storage key: ${key}`);
  }
  return path.join(SECURE_STORAGE_DIR, `${key}.enc`);
}

ipcMain.handle("secure-storage:get", async (_event, key) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return undefined;
  }
  try {
    const encrypted = await fs.readFile(secureStorageFilePath(key));
    return safeStorage.decryptString(encrypted);
  } catch {
    return undefined;
  }
});

ipcMain.handle("secure-storage:set", async (_event, key, value) => {
  if (!safeStorage.isEncryptionAvailable()) {
    return false;
  }
  try {
    await fs.mkdir(SECURE_STORAGE_DIR, { recursive: true });
    const encrypted = safeStorage.encryptString(value);
    await fs.writeFile(secureStorageFilePath(key), encrypted);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("secure-storage:delete", async (_event, key) => {
  try {
    await fs.unlink(secureStorageFilePath(key));
  } catch {
    // Already absent - nothing to do.
  }
});

// The renderer claims a recording queued before it started listening (the
// launch case). Clearing it means we never reopen the same file twice.
ipcMain.handle("desktop:take-open-file", () => {
  const payload = pendingOpenFile;
  pendingOpenFile = undefined;
  return payload;
});

// A single instance owns the file associations: a second "open with" should
// reuse the running window rather than start a rival process.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_event, argv) => {
    handleOpenPath(firstMcapArg(argv));
  });

  app.whenReady().then(() => {
    protocol.handle("mcap-local", serveMcapLocal);
    createWindow();
    // A path passed on the command line at launch (Windows/Linux).
    handleOpenPath(firstMcapArg(process.argv));
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
}
