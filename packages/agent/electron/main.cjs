const { app, BrowserWindow, ipcMain, desktopCapturer, Tray, Menu, screen, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execSync } = require('child_process');
let autoUpdater = null;
try {
  ({ autoUpdater } = require("electron-updater"));
} catch (e) {
  console.warn("[updater] electron-updater missing. updater disabled.", e?.message || e);
}

let mainWindow;
let tray = null;
let controllerProcess;
let inputLockWindows = [];
let preferredDisplayId = null;
let remoteStatusWindow = null;

const isDev = !app.isPackaged;
const devServerUrl = process.env.WONREMOTE_DEV_SERVER_URL || 'http://localhost:3001';
const startHidden = process.argv.includes('--hidden');

// Agent는 userData/cache를 전용으로 고정합니다.
const envLocal = process.env.LOCALAPPDATA || (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : null);
const profileFromEnv = (process.env.WONREMOTE_PROFILE || '').trim();
const profile = profileFromEnv || `agent${isDev ? '-dev' : ''}`;

const appDataFolderName = `WonRemote_${profile}`;
const userDataRoot = envLocal ? path.join(envLocal, appDataFolderName) : null;
const cachePath = userDataRoot ? path.join(userDataRoot, 'Cache') : null;

function applyUserDataPathsEarly() {
  if (!userDataRoot || !cachePath) return;
  try {
    fs.mkdirSync(cachePath, { recursive: true });
    app.setPath('userData', userDataRoot);
    app.setPath('cache', cachePath);
    app.commandLine.appendSwitch('user-data-dir', userDataRoot);
    app.commandLine.appendSwitch('disk-cache-dir', cachePath);
  } catch {}
}

applyUserDataPathsEarly();
app.commandLine.appendSwitch('disable-renderer-backgrounding');

function resolveAppIcon() {
  // runtime: app.asar 내부(public/icon.ico) 또는 resources/public/icon.ico 둘 다 고려
  const candidates = [
    path.join(app.getAppPath(), 'public', 'icon.ico'),
    path.join(process.resourcesPath || '', 'public', 'icon.ico'),
    path.join(process.resourcesPath || '', 'app.asar.unpacked', 'public', 'icon.ico'),
    path.join(__dirname, '..', 'public', 'icon.ico')
  ];

  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return candidates[candidates.length - 1];
}

const appIcon = resolveAppIcon();

function getDisplaySnapshot() {
  try {
    const primaryId = screen.getPrimaryDisplay()?.id;
    return screen.getAllDisplays().map((d) => ({
      id: d.id,
      primary: d.id === primaryId,
      bounds: { x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height }, // DIP
      scaleFactor: d.scaleFactor || 1
    }));
  } catch {
    return [];
  }
}

ipcMain.handle('get-displays', async () => getDisplaySnapshot());
ipcMain.handle('set-preferred-display', async (_e, id) => {
  const n = Number(id);
  preferredDisplayId = Number.isFinite(n) ? n : null;
  return true;
});

function isElevated() {
  try {
    // 관리자면 0, 아니면 예외
    execSync('net session', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle('agent-is-elevated', async () => isElevated());

ipcMain.handle('agent-relaunch-elevated', async () => {
  try {
    // 현재 exe를 관리자 권한으로 재실행
    const exe = process.execPath;
    const args = process.argv.slice(1).filter(a => a !== '--no-elevate');
    const ps = [
      'powershell',
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command',
      `Start-Process -FilePath "${exe}" -ArgumentList "${args.join(' ')}" -Verb RunAs`
    ];
    execSync(ps.join(' '), { stdio: 'ignore' });
    app.isQuitting = true;
    app.quit();
    return true;
  } catch {
    return false;
  }
});

// Clipboard
ipcMain.on('clipboard-set-text', (_e, text) => {
  try { clipboard.writeText(String(text ?? '')); } catch {}
});

ipcMain.handle('clipboard-get-text', async () => {
  try { return clipboard.readText() || ''; } catch { return ''; }
});

// 입력 잠금 (오버레이)
function setInputLock(enabled) {
  try {
    if (!enabled) {
      for (const w of inputLockWindows) {
        try { w.close(); } catch {}
      }
      inputLockWindows = [];
      return;
    }

    if (inputLockWindows.length) return;

    const displays = screen.getAllDisplays();
    inputLockWindows = displays.map((d) => {
      const w = new BrowserWindow({
        x: d.bounds.x,
        y: d.bounds.y,
        width: d.bounds.width,
        height: d.bounds.height,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        focusable: true,
        fullscreenable: false,
        resizable: false,
        movable: false,
        show: true,
        webPreferences: { contextIsolation: true, sandbox: true }
      });

      w.setAlwaysOnTop(true, 'screen-saver');
      w.setVisibleOnAllWorkspaces(true);
      w.loadURL(
        'data:text/html;charset=utf-8,' +
          encodeURIComponent(`
            <html><body style="margin:0;width:100vw;height:100vh;background:rgba(0,0,0,.25);display:flex;align-items:center;justify-content:center;font-family:sans-serif;">
              <div style="background:rgba(0,0,0,.65);color:#fff;padding:18px 22px;border-radius:12px;font-size:14px;">
                원격 제어 중 — 로컬 입력이 잠금 상태입니다
              </div>
            </body></html>
          `)
      );
      w.on('ready-to-show', () => w.focus());
      return w;
    });
  } catch {}
}

ipcMain.on('set-input-lock', (_e, enabled) => setInputLock(!!enabled));

function getControlCommand() {
  // 배포: extraResources로 resourcesPath/control/control.exe 에 들어옵니다.
  const exeCandidates = [
    path.join(process.resourcesPath || '', 'control', 'control.exe'),
    path.join(__dirname, '..', 'resources', 'control', 'control.exe')
  ];

  for (const exe of exeCandidates) {
    if (exe && fs.existsSync(exe)) return { cmd: exe, args: [] };
  }

  // 개발: control.py 허용
  const py = path.join(__dirname, '..', 'control.py');
  if (fs.existsSync(py)) return { cmd: 'python', args: [py] };

  return null;
}

// 자동 실행(Agent)
app.setLoginItemSettings({
  openAtLogin: true,
  path: process.execPath,
  args: ['--hidden']
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 380,
    height: 560,
    show: false,
    icon: appIcon,
    resizable: false,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      backgroundThrottling: false
    }
  });

  if (isDev) {
    mainWindow.loadURL(devServerUrl);
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.removeMenu();
  mainWindow.webContents.setBackgroundThrottling(false);

  mainWindow.webContents.session.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      if (!sources || sources.length === 0) return;

      const primaryId = String(screen.getPrimaryDisplay().id);
      const preferredId = preferredDisplayId != null ? String(preferredDisplayId) : null;

      const picked =
        (preferredId ? sources.find((s) => String(s.display_id) === preferredId) : null) ||
        sources.find((s) => String(s.display_id) === primaryId) ||
        sources[0];

      callback({ video: picked, audio: null });
    });
  });

  mainWindow.on('close', (event) => {
    if (!app.isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
    return false;
  });

  mainWindow.on('minimize', (event) => {
    event.preventDefault();
    mainWindow.hide();
  });

  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow.show();
  });
}

function createTray() {
  try {
    tray = new Tray(appIcon);
    const contextMenu = Menu.buildFromTemplate([
      { label: 'WonRemote 열기', click: () => mainWindow.show() },
      {
        label: '종료',
        click: () => {
          app.isQuitting = true;
          app.quit();
        }
      }
    ]);
    tray.setToolTip('WonRemote Agent');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => mainWindow.show());
  } catch {}
}

function ensureRemoteStatusWindow() {
  if (remoteStatusWindow && !remoteStatusWindow.isDestroyed()) return;

  remoteStatusWindow = new BrowserWindow({
    width: 280,
    height: 76,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    show: false,
    focusable: false,
    webPreferences: { contextIsolation: true, sandbox: true }
  });

  const html = `
    <html>
      <body style="margin:0;font-family:Segoe UI,Arial,sans-serif;">
        <div style="margin:8px;background:rgba(20,20,20,0.92);color:#fff;border-radius:10px;padding:10px 12px;box-shadow:0 8px 24px rgba(0,0,0,0.3);">
          <div style="font-size:12px;font-weight:600;margin-bottom:4px;">원격 지원 중입니다</div>
          <div style="font-size:11px;color:#d1d5db;">상담원이 PC를 제어하고 있습니다.</div>
        </div>
      </body>
    </html>`;

  remoteStatusWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

function positionRemoteStatusWindow() {
  if (!remoteStatusWindow || remoteStatusWindow.isDestroyed()) return;
  const area = screen.getPrimaryDisplay().workArea;
  const [w, h] = remoteStatusWindow.getSize();
  const x = area.x + area.width - w - 16;
  const y = area.y + area.height - h - 16;
  remoteStatusWindow.setPosition(x, y, false);
}

function showRemoteStatusWindow() {
  ensureRemoteStatusWindow();
  positionRemoteStatusWindow();
  remoteStatusWindow.showInactive();
}

function hideRemoteStatusWindow() {
  if (!remoteStatusWindow || remoteStatusWindow.isDestroyed()) return;
  remoteStatusWindow.hide();
}

function startController() {
  const cmdInfo = getControlCommand();
  if (!cmdInfo) {
    console.error('[controller] control binary not found.');
    return;
  }
  const { cmd, args } = cmdInfo;
  controllerProcess = spawn(cmd, args, { stdio: ['pipe', 'ignore', 'pipe'] });
  controllerProcess.on('error', () => {});
}

function setupAutoUpdate(app) {
  try {
    if (!app?.isPackaged) return;
    if (!autoUpdater) return;

    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;

    autoUpdater.on("error", (e) => {
      console.error("[updater] error", e?.message || e);
    });

    autoUpdater.checkForUpdatesAndNotify();

    setInterval(() => {
      autoUpdater.checkForUpdatesAndNotify();
    }, 30 * 60 * 1000);
  } catch (e) {
    console.error("[updater] setup failed", e?.message || e);
  }
}

app.whenReady().then(() => {
  createWindow();
  createTray();
  startController();
  setupAutoUpdate(app);
  screen.on('display-metrics-changed', positionRemoteStatusWindow);
});

app.on('before-quit', () => {
  if (controllerProcess) {
    try { controllerProcess.kill(); } catch {}
  }
});

// 원격 제어 입력 전달
ipcMain.on('remote_control', (_event, data) => {
  try {
    if (data?.action === 'paste_text' && typeof data.text === 'string') {
      try { clipboard.writeText(String(data.text)); } catch {}
      data = { action: 'paste' };
    }
    if (data?.action === 'mouse' && typeof data.xn === 'number' && typeof data.yn === 'number') {
      const xn = Math.max(0, Math.min(1, data.xn));
      const yn = Math.max(0, Math.min(1, data.yn));
      const displays = getDisplaySnapshot();
      const primary = displays.find((d) => d.primary) || displays[0];
      const target = displays.find((d) => d.id === data.displayId) || primary;
      if (target) {
        const absX = Math.round((target.bounds.x + xn * target.bounds.width) * target.scaleFactor);
        const absY = Math.round((target.bounds.y + yn * target.bounds.height) * target.scaleFactor);
        data = { ...data, x: absX, y: absY };
      }
    }
    if (controllerProcess?.stdin) controllerProcess.stdin.write(JSON.stringify(data) + '\n');
  } catch {}
});

ipcMain.on('window-minimize', () => mainWindow?.hide());
ipcMain.on('window-hide', () => mainWindow?.hide());
ipcMain.on('remote-session-status', (_event, { active }) => {
  if (active) showRemoteStatusWindow();
  else hideRemoteStatusWindow();
});

// 파일 저장 (청크)
ipcMain.on('write-file-chunk', (_event, { fileName, fileData, offset }) => {
  try {
    const desktopPath = app.getPath('desktop') || path.join(app.getPath('home'), 'Desktop');
    const saveDir = path.join(desktopPath, 'WonRemote_Files');
    fs.mkdirSync(saveDir, { recursive: true });
    const filePath = path.join(saveDir, fileName);

    let buf;
    if (Buffer.isBuffer(fileData)) buf = fileData;
    else if (fileData instanceof ArrayBuffer) buf = Buffer.from(new Uint8Array(fileData));
    else if (ArrayBuffer.isView(fileData)) buf = Buffer.from(fileData.buffer, fileData.byteOffset, fileData.byteLength);
    else if (fileData && fileData.type === 'Buffer' && Array.isArray(fileData.data)) buf = Buffer.from(fileData.data);
    else if (fileData && Array.isArray(fileData.data)) buf = Buffer.from(fileData.data);
    else return;

    if (offset === 0) fs.writeFileSync(filePath, buf);
    else fs.appendFileSync(filePath, buf);
  } catch {}
});
