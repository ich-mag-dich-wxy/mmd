// preload.js — 在渲染进程注入安全 API，暴露给控制面板和模型窗口
// contextIsolation: true 下，渲染进程的 window 上没有 ipcRenderer，需要通过 preload 暴露

const { contextBridge, ipcRenderer } = require('electron');

// 控制面板用到的 API
const controlAPI = {
  // 模型窗口管理
  openViewer: () => ipcRenderer.invoke('viewer:open'),
  closeViewer: () => ipcRenderer.invoke('viewer:close'),

  // 发送指令到模型窗口（单向，不等待返回）
  sendToViewer: (channel, payload) => {
    // 频道必须是 viewer: 开头，防止越权
    if (!channel.startsWith('viewer:')) return;
    ipcRenderer.send(channel, payload);
  },

  // 接收模型窗口回传的状态
  onViewerState: (callback) => {
    const handler = (_event, state) => callback(state);
    ipcRenderer.on('viewer:state', handler);
    return () => ipcRenderer.removeListener('viewer:state', handler);
  },

  // 文件对话框
  pickModelsFolder: () => ipcRenderer.invoke('dialog:pick-models-folder'),
  pickMotionsFolder: () => ipcRenderer.invoke('dialog:pick-motions-folder'),
  pickTextFile: () => ipcRenderer.invoke('dialog:pick-text-file'),
  pickMediaFile: (filters) => ipcRenderer.invoke('dialog:pick-media-file', filters),

  // 文件读写
  readFileArrayBuffer: (filePath) => ipcRenderer.invoke('file:read-arraybuffer', filePath),
  saveFile: (options) => ipcRenderer.invoke('file:save', options),

  // AI 对话（DeepSeek API，主进程代理调用以规避 CORS）
  aiChat: (params) => ipcRenderer.invoke('ai:chat', params),

  // 平台信息
  platform: process.platform,
};

// 模型窗口用到的 API
const viewerAPI = {
  // 通知主进程 viewer 已就绪
  notifyReady: () => ipcRenderer.invoke('viewer:ready'),

  // 接收控制面板的指令
  onCommand: (channel, callback) => {
    if (!channel.startsWith('viewer:')) return;
    const handler = (_event, payload) => callback(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },

  // 回传状态给控制面板
  sendState: (state) => ipcRenderer.send('viewer:state', state),

  // 窗口拖动
  moveWindow: (dx, dy) => ipcRenderer.send('viewer:move', { x: dx, y: dy }),

  // 读取文件（加载 PMX/VMD）
  readFileArrayBuffer: (filePath) => ipcRenderer.invoke('file:read-arraybuffer', filePath),
};

// 根据当前页面判断注入哪个 API
// viewer.html 注入 viewerAPI，其他页面注入 controlAPI
const isViewer = window.location.pathname.endsWith('viewer.html');

if (isViewer) {
  contextBridge.exposeInMainWorld('electronAPI', viewerAPI);
} else {
  contextBridge.exposeInMainWorld('electronAPI', controlAPI);
}
