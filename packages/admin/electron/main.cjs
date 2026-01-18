const { app, BrowserWindow } = require('electron');
let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (e) {
  console.warn('[updater] electron-updater missing. updater disabled.', e?.message || e);
}
const path = require('path');
const fs = require('fs');

let mainWindow;
const isDev = !app.isPackaged;
const devServerUrl = process.env.WONREMOTE_DEV_SERVER_URL || 'http://localhost:3002';

const envLocal = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : null);
const profileFromEnv = (process.env.WONREMOTE_PROFILE || '').trim();
const profile = profileFromEnv || `admin${isDev ? '-dev' : ''}`;

const appDataFolderName = `WonRemote_${profile}`;
const userDataRoot = envLocal ? path.join(envLocal, appDataFolderName) : null;
const cachePath = userDataRoot ? path.join(userDataRoot, 'Cache') : null;

function applyUserDataPathsEarly() {
  if (!userDataRoot || !cachePath) return;
  try {
    fs.mkdirSync(cachePath, { recursive: true });
    app.setPath('userData', userDataRoot);
    app.setPath('cache', cachePath);
  } catch {}
}
applyUserDataPathsEarly();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    show: false,
    resizable: true,
    fullscreenable: true,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  if (isDev) mainWindow.loadURL(devServerUrl);
  else mainWindow.loadFile(path.join(__dirname, '..', 'dist/index.html'));

  mainWindow.removeMenu();
  mainWindow.once('ready-to-show', () => mainWindow.show());
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  if (!autoUpdater) return;
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('error', (e) => {
    console.error('[updater] error', e?.message || e);
  });
  autoUpdater.checkForUpdatesAndNotify();
  setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 30 * 60 * 1000);
}

app.whenReady().then(() => {
  createWindow();
  setupAutoUpdate();
});
