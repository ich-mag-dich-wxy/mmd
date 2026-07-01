// ═══════════════════════════════════════════════════════════
//  Electron 主进程 — 控制面板 + 透明模型窗口
//
//  两个窗口：
//    1. 控制面板 (index.html)：按钮/列表/动捕预览，有边框
//    2. 模型窗口 (viewer.html)：无边框、透明背景、置顶，只渲染 3D 模型
//
//  通信：控制面板通过 IPC 发指令到主进程，主进程转发到模型窗口；
//       文件选择对话框在主进程打开，把路径回传给渲染进程。
// ═══════════════════════════════════════════════════════════

const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');

// 调试日志写入文件（electron stdout 可能不工作）
const LOG_FILE = path.join(__dirname, 'debug.log');
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.appendFileSync(LOG_FILE, line); } catch (e) {}
  try { process.stdout.write(line); } catch (e) {}
}

// 清空旧日志
try { fs.writeFileSync(LOG_FILE, ''); } catch (e) {}

// 开发模式判定：
//   1. ELECTRON_IS_DEV=1 环境变量（npm script 中显式设置，最可靠）
//   2. 否则用 app.isPackaged 取反（packaged 构建时为 true）
// 注意：某些 pnpm/缓存布局下 app.isPackaged 可能误报 true，故优先用环境变量。
const isDev = process.env.ELECTRON_IS_DEV === '1' || !app.isPackaged;

log('=== electron main.cjs started ===');
log(`app.isPackaged: ${app.isPackaged}`);
log(`isDev (computed): ${isDev}`);
log(`process.versions.electron: ${process.versions.electron}`);
log(`process.versions.node: ${process.versions.node}`);
log(`process.argv: ${JSON.stringify(process.argv)}`);
log(`ELECTRON_IS_DEV: ${process.env.ELECTRON_IS_DEV}`);

let controlWindow = null;
let viewerWindow = null;

// 模型窗口是否已准备好（等 viewer.js 完成初始化后才开始转发指令）
let viewerReady = false;
// viewer 未就绪时缓存的指令队列
const pendingMessages = [];

// 探测 vite dev server 端口（vite 默认 3000，被占用时会自动切到 3001/3002...）
// 循环等待最多 30 秒，直到 vite 启动
async function detectVitePort() {
  const tryPort = (port) => new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/`, (res) => {
      res.resume();
      res.on('end', () => resolve(true));
      res.on('data', () => {});
    });
    req.on('error', () => resolve(false));
    req.setTimeout(500, () => { req.destroy(); resolve(false); });
  });

  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    for (const port of [3000, 3001, 3002, 3003, 3004, 3005]) {
      if (await tryPort(port)) return port;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  console.warn('[Electron] 未探测到 vite dev server，回退到 3000');
  return 3000;
}

let _devPort = null;

function createControlWindow() {
  controlWindow = new BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 900,
    minHeight: 600,
    title: 'MMD Studio — 控制面板',
    backgroundColor: '#08090d',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 开发模式加载 vite dev server，生产模式加载构建产物
  if (isDev) {
    const url = `http://localhost:${_devPort}/index.html`;
    log(`loading: ${url}`);
    // 立即打开 DevTools（不等加载完成，确保能看到所有错误）
    controlWindow.webContents.openDevTools({ mode: 'right' });
    controlWindow.loadURL(url);
    controlWindow.webContents.on('did-finish-load', () => {
      log('control panel loaded successfully');
    });
    controlWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
      log(`LOAD FAILED: code=${code} desc=${desc} url=${url}`);
    });
    // 捕获控制台日志输出到文件
    controlWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
      const tag = ['LOG', 'WARN', 'ERROR'][level] || 'LOG';
      log(`[Console ${tag}] ${message} (${sourceId}:${line})`);
    });
  } else {
    controlWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  controlWindow.on('closed', () => {
    controlWindow = null;
    // 控制面板关闭时退出整个应用
    if (viewerWindow) {
      viewerWindow.destroy();
    }
    app.quit();
  });
}

function createViewerWindow() {
  viewerWindow = new BrowserWindow({
    width: 600,
    height: 800,
    minWidth: 200,
    minHeight: 200,
    frame: false,               // 无边框
    transparent: true,          // 透明背景
    alwaysOnTop: true,          // 置顶
    resizable: true,
    skipTaskbar: true,          // 不在任务栏显示
    backgroundColor: '#00000000',
    hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    viewerWindow.loadURL(`http://localhost:${_devPort}/viewer.html`);
  } else {
    viewerWindow.loadFile(path.join(__dirname, '..', 'dist', 'viewer.html'));
  }

  // 捕获 viewer 窗口的加载事件与控制台日志（写入同一份 debug.log）
  viewerWindow.webContents.on('did-finish-load', () => {
    log('viewer window loaded successfully');
  });
  viewerWindow.webContents.on('did-fail-load', (_e, code, desc, url) => {
    log(`VIEWER LOAD FAILED: code=${code} desc=${desc} url=${url}`);
  });
  viewerWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    const tag = ['LOG', 'WARN', 'ERROR'][level] || 'LOG';
    log(`[Viewer ${tag}] ${message} (${sourceId}:${line})`);
  });
  viewerWindow.webContents.on('render-process-gone', (_e, details) => {
    log(`VIEWER RENDER GONE: reason=${details.reason} exitCode=${details.exitCode}`);
  });

  viewerWindow.on('closed', () => {
    viewerWindow = null;
    viewerReady = false;
  });

  // 阻止模型窗口打开外部链接
  viewerWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// 将消息发往模型窗口；若未就绪则缓存
function sendToViewer(channel, payload) {
  if (viewerReady && viewerWindow && !viewerWindow.isDestroyed()) {
    viewerWindow.webContents.send(channel, payload);
  } else {
    pendingMessages.push({ channel, payload });
  }
}

// ── IPC：控制面板 → 主进程 → 模型窗口 ──

// 打开模型窗口（用户首次加载模型时调用）
ipcMain.handle('viewer:open', () => {
  if (!viewerWindow) {
    createViewerWindow();
  } else {
    if (viewerWindow.isMinimized()) viewerWindow.restore();
    viewerWindow.show();
  }
  return true;
});

// 关闭模型窗口
ipcMain.handle('viewer:close', () => {
  if (viewerWindow) {
    viewerWindow.destroy();
  }
  return true;
});

// 模型窗口就绪通知
ipcMain.handle('viewer:ready', () => {
  viewerReady = true;
  // 发送缓存的消息
  for (const { channel, payload } of pendingMessages) {
    if (viewerWindow && !viewerWindow.isDestroyed()) {
      viewerWindow.webContents.send(channel, payload);
    }
  }
  pendingMessages.length = 0;
  return true;
});

// 通用转发：控制面板 → 模型窗口
// 频道命名约定：viewer:<action>
const forwardChannels = [
  'viewer:load-model',
  'viewer:unload-model',
  'viewer:play-vmd',
  'viewer:compile-mpl',
  'viewer:start-camera',
  'viewer:stop-camera',
  'viewer:calibrate',
  'viewer:set-mirror',
  'viewer:toggle-play',
  'viewer:reset-camera',
  'viewer:set-speed',
  'viewer:clear-scene',
  'viewer:snapshot',
  'viewer:decompile',
  'viewer:pose-image',
  'viewer:pose-video',
  'viewer:landmarks',        // 动捕 landmarks 实时流
  'viewer:toggle-face',
  'viewer:toggle-hands',
];

for (const ch of forwardChannels) {
  ipcMain.on(ch, (_event, payload) => {
    sendToViewer(ch, payload);
  });
}

// 模型窗口 → 控制面板：转发 viewer:state（viewer 回传的模型加载/播放/快照等状态）
ipcMain.on('viewer:state', (_event, payload) => {
  if (controlWindow && !controlWindow.isDestroyed()) {
    controlWindow.webContents.send('viewer:state', payload);
  }
});

// ── AI 对话（DeepSeek API，OpenAI 兼容）──
// 在主进程发起请求，规避渲染进程的 CORS 限制，且 API key 不暴露于渲染进程网络栈
ipcMain.handle('ai:chat', async (_event, { apiKey, model, messages }) => {
  if (!apiKey) return { ok: false, error: '未提供 API Key' };
  const url = 'https://api.deepseek.com/chat/completions';
  const body = {
    model: model || 'deepseek-v4-flash',
    messages,
    stream: false,
    response_format: { type: 'json_object' },
  };
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    });
    const data = await resp.json();
    if (!resp.ok) {
      const msg = data?.error?.message || `HTTP ${resp.status}`;
      return { ok: false, error: msg };
    }
    const content = data?.choices?.[0]?.message?.content || '';
    return { ok: true, content };
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});

// ── 文件选择对话框（主进程才能调）──

// 选择模型文件夹
ipcMain.handle('dialog:pick-models-folder', async () => {
  const result = await dialog.showOpenDialog(controlWindow, {
    properties: ['openDirectory'],
    title: '选择模型文件夹',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const folderPath = result.filePaths[0];
  const files = collectFilesInFolder(folderPath);
  return { folderPath, files };
});

// 选择动作文件夹
ipcMain.handle('dialog:pick-motions-folder', async () => {
  const result = await dialog.showOpenDialog(controlWindow, {
    properties: ['openDirectory'],
    title: '选择动作文件夹',
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const folderPath = result.filePaths[0];
  const files = collectFilesInFolder(folderPath);
  return { folderPath, files };
});

// 选择单个文本/mpl 文件
ipcMain.handle('dialog:pick-text-file', async () => {
  const result = await dialog.showOpenDialog(controlWindow, {
    properties: ['openFile'],
    title: '选择文本文件',
    filters: [
      { name: '文本', extensions: ['txt', 'mpl'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const buffer = fs.readFileSync(filePath);
  // 把 Buffer 转成 base64 传给渲染进程（避免 contextIsolation 下传 Buffer 对象）
  const text = buffer.toString('utf-8');
  const name = path.basename(filePath);
  return { filePath, name, text };
});

// 选择图片/视频文件（动捕输入）
ipcMain.handle('dialog:pick-media-file', async (_event, filters) => {
  const result = await dialog.showOpenDialog(controlWindow, {
    properties: ['openFile'],
    title: '选择媒体文件',
    filters: filters || [
      { name: '媒体', extensions: ['png', 'jpg', 'jpeg', 'mp4', 'webm', 'avi'] },
      { name: '所有文件', extensions: ['*'] },
    ],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const buffer = fs.readFileSync(filePath);
  const ext = path.extname(filePath).slice(1).toLowerCase();
  const mime = ext.match(/^(png|jpe?g)$/) ? `image/${ext === 'jpg' ? 'jpeg' : ext}`
    : ext === 'mp4' ? 'video/mp4'
    : ext === 'webm' ? 'video/webm'
    : 'application/octet-stream';
  return {
    filePath,
    name: path.basename(filePath),
    dataUrl: `data:${mime};base64,${buffer.toString('base64')}`,
  };
});

// 读取文件夹下所有文件，返回相对路径列表
function collectFilesInFolder(folderPath) {
  const result = [];
  function walk(dir, relBase) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      const rel = relBase ? `${relBase}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        walk(full, rel);
      } else {
        result.push({
          name: ent.name,
          relativePath: rel,
          fullPath: full,
          size: fs.statSync(full).size,
        });
      }
    }
  }
  walk(folderPath, '');
  return result;
}

// 读取文件内容为 ArrayBuffer（用于加载 PMX/VMD 二进制）
ipcMain.handle('file:read-arraybuffer', async (_event, filePath) => {
  const buffer = fs.readFileSync(filePath);
  // 返回 ArrayBuffer 的副本（避免 Buffer 引用泄漏到渲染进程）
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
});

// 保存文件（VMD 导出/录制/快照）
ipcMain.handle('file:save', async (_event, { defaultName, data, filters }) => {
  const result = await dialog.showSaveDialog(controlWindow, {
    defaultPath: defaultName,
    filters: filters || [{ name: '所有文件', extensions: ['*'] }],
  });
  if (result.canceled) return null;
  try {
    // data 可能是 base64 字符串或 Uint8Array
    if (typeof data === 'string') {
      fs.writeFileSync(result.filePath, Buffer.from(data, 'base64'));
    } else if (data && data.type === 'base64') {
      fs.writeFileSync(result.filePath, Buffer.from(data.data, 'base64'));
    } else {
      fs.writeFileSync(result.filePath, data);
    }
    return { filePath: result.filePath };
  } catch (err) {
    return { error: err.message };
  }
});

// ── 模型窗口 → 主进程（窗口拖动等）──

// 移动模型窗口
ipcMain.on('viewer:move', (_event, { x, y }) => {
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    const [curX, curY] = viewerWindow.getPosition();
    viewerWindow.setPosition(curX + x, curY + y);
  }
});

// 调整模型窗口大小
ipcMain.on('viewer:resize', (_event, { width, height }) => {
  if (viewerWindow && !viewerWindow.isDestroyed()) {
    viewerWindow.setSize(width, height);
  }
});

// ── 应用生命周期 ──

app.whenReady().then(async () => {
  log('app.whenReady() called');
  if (isDev) {
    // 开发模式：探测 vite dev server 实际端口
    // vite 默认 3000，但被占用时会自动切到 3001/3002...，必须动态探测
    log('dev mode: detecting vite port...');
    _devPort = await detectVitePort();
    log(`vite detected on port ${_devPort}`);
  } else {
    // 生产模式：加载 dist 构建产物，端口变量不会被使用
    _devPort = 3000;
    log('packaged mode, loading from dist/');
  }
  createControlWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createControlWindow();
  }
});
