// Electron shell for ミュージック! — wraps the exact same server.js used for
// local/CLI hosting, started on an OS-assigned localhost port, so there is no
// separate "desktop" codebase to keep in sync with the web version.
'use strict';

const { app, BrowserWindow, shell, Menu, dialog } = require('electron');
const path = require('path');
const { autoUpdater } = require('electron-updater');
const { start } = require('../server.js');

let mainWindow = null;
let serverHandle = null;   // { server, port, url, close } — see server.js's start()

autoUpdater.autoDownload = true;
autoUpdater.autoInstallOnAppQuit = true;

function log(...a) { console.log('[myujikku]', ...a); }

async function createWindow() {
  serverHandle = await start({
    port: 0,
    host: '127.0.0.1',
    // Packaged app: songs/ sits next to the app resources. Dev run: same
    // relative path server.js already defaults to.
    songsDir: path.join(app.isPackaged ? process.resourcesPath : __dirname + '/..', 'songs'),
    // server.js runs from inside app.asar when packaged — a read-only
    // virtual archive — so its default "write .cache/ next to myself"
    // behavior throws ENOTDIR there. userData is always a real, writable,
    // per-user directory (e.g. %APPDATA%\myujikku on Windows). Named
    // distinctly from Chromium's own "Cache" dir there — Windows' default
    // case-insensitive filesystem would otherwise treat "cache" and "Cache"
    // as the same folder.
    cacheDir: path.join(app.getPath('userData'), 'beatmap-cache'),
    quiet: true,
  });
  const { url } = serverHandle;
  log('local server:', url);

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 720,
    minHeight: 480,
    backgroundColor: '#0a0713',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  Menu.setApplicationMenu(null);

  // The game already opens external links (editor, beatmap repo) with plain
  // <a> tags; keep those in the system browser instead of navigating the app.
  mainWindow.webContents.setWindowOpenHandler(({ url: target }) => {
    shell.openExternal(target);
    return { action: 'deny' };
  });

  await mainWindow.loadURL(url);
  mainWindow.on('closed', () => { mainWindow = null; });
}

// A startup failure here previously meant an unhandled rejection: the process
// stayed alive (visible in Task Manager) but no window ever appeared, no
// error shown, nothing to go on. Whatever fails next, this makes it visible
// instead of silent, and quits instead of leaving a ghost process behind.
app.whenReady().then(async () => {
  try {
    await createWindow();
  } catch (err) {
    log('startup failed:', err.stack || err.message);
    dialog.showErrorBox('ミュージック! failed to start', err.stack || err.message);
    app.quit();
    return;
  }

  if (app.isPackaged) {
    // Checks the GitHub Release matching this build's version (electron-builder
    // writes that config into app-update.yml at build time — nothing to wire
    // up by hand here). Silently no-ops if offline or already current.
    autoUpdater.checkForUpdatesAndNotify().catch(err => log('update check failed:', err.message));
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow().catch(err => log('re-activate failed:', err.message));
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  // server.js binds to 127.0.0.1 only and dies with the process regardless,
  // but close it explicitly for a clean shutdown log / faster port release.
  serverHandle?.close().catch(() => {});
});

autoUpdater.on('error', err => log('autoUpdater error:', err.message));
autoUpdater.on('update-available', info => log('update available:', info.version));
autoUpdater.on('update-downloaded', info => log('update downloaded, will install on quit:', info.version));
