// ═══════════════════════════════════════════════════════════
//  MMD Studio — 控制面板（Electron 渲染进程）
//
//  职责：
//    - UI 交互（按钮、侧边栏、文件夹选择）
//    - 摄像头动捕预览（PoseCaptureSystem 在这里运行）
//    - 通过 IPC 指挥模型窗口（viewer）执行 3D 操作
//
//  与原 main.js 的差异：
//    - 无 three.js 场景（所有 3D 逻辑移到 viewer.js）
//    - 文件夹选择改用 Electron dialog（不再用 webkitdirectory）
//    - 模型加载通过 IPC 发路径给 viewer，viewer 自己读文件
//    - 动捕 landmarks 在这里采集，通过 IPC 实时传给 viewer
// ═══════════════════════════════════════════════════════════

import { vmdToText, downloadVMD } from './src/core/vmdDecompiler.js';
import { compileMPLToVMD, isMPLScript } from './src/core/mplCompiler.js';
import { drawPoseCanvas, resetCalibration, setMirrorMode, getMirrorMode } from './src/core/poseCapture.js';
import { PoseCaptureSystem } from './src/core/poseCaptureSystem.js';
import { VMDRecorder, saveRecording } from './src/core/vmdRecorder.js';
import { AI_SYSTEM_PROMPT } from './src/core/aiPrompt.js';
import './style.css';  // vite 通过 JS 注入 CSS（支持 HMR）

// ═══════════════════════════════════════════════════════════
//  状态
// ═══════════════════════════════════════════════════════════

const state = {
  // 资源库
  modelLibrary: [],   // [{ id, name, pmxPath, textureFiles, folderName, size }]
  motionLibrary: [],  // [{ id, name, type, path, folderName, size, text }]
  // 当前活动模型/动作
  activeModelId: null,
  activeMotionId: null,
  // 播放
  isPlaying: true,
  motionFilter: 'all',
  // 动捕（在控制面板运行，landmarks 传给 viewer）
  poseCapture: null,
  poseActive: false,
  poseLandmarks: null,
  // 编译/反编译
  mplFileText: null,
  mplFileName: '',
  vmdArrayBuffer: null,
  vmdFileName: '',
  // 录制
  recorder: null,
  isRecording: false,
  // viewer 窗口状态
  viewerOpened: false,
  // AI 对话
  aiMessages: [],     // OpenAI 格式: [{role, content}]
  aiBusy: false,
};

let _modelIdCounter = 0;
let _motionIdCounter = 0;
const nextModelId = () => 'm' + (++_modelIdCounter);
const nextMotionId = () => 'v' + (++_motionIdCounter);

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const loadingOverlay = $('#loading-overlay');
const loadingText = $('#loading-text');
const editorStatus = $('#editor-status');
const progressEl = $('#editor-progress');
const progressFill = $('#progress-fill');
const progressText = $('#progress-text');

function showProgress(phase, current, total) {
  const pct = total > 0 ? Math.min(100, Math.round(current / total * 100)) : 0;
  progressFill.style.width = pct + '%';
  const label = phase === 'bone' ? '骨骼' : phase === 'morph' ? '形变' : phase;
  progressText.textContent = `${label} ${current.toLocaleString()} / ${total.toLocaleString()} (${pct}%)`;
}
function startProgress() { progressEl.classList.add('active'); progressFill.style.width = '0%'; progressText.textContent = ''; }
function endProgress() { progressEl.classList.remove('active'); progressFill.style.width = '0%'; }
function setStatus(msg) { editorStatus.textContent = msg; }
function showLoading(msg) { loadingText.textContent = msg; loadingOverlay.classList.add('active'); }
function hideLoading() { loadingOverlay.classList.remove('active'); }

// ═══════════════════════════════════════════════════════════
//  IPC 通信辅助
// ═══════════════════════════════════════════════════════════

const api = window.electronAPI;

// 发送指令到 viewer
function sendToViewer(channel, payload) {
  if (api && api.sendToViewer) {
    api.sendToViewer(channel, payload);
  }
}

// 确保 viewer 窗口已打开
async function ensureViewerOpen() {
  if (state.viewerOpened) return;
  if (api && api.openViewer) {
    await api.openViewer();
    state.viewerOpened = true;
  }
}

// 接收 viewer 回传的状态
if (api && api.onViewerState) {
  api.onViewerState((viewerState) => {
    if (viewerState.type === 'model-loaded') {
      state.activeModelId = viewerState.id;
      hideLoading();
      updateModelListUI();
      updateInfoChips();
      setStatus(`模型已加载: ${viewerState.name || ''}`);
    } else if (viewerState.type === 'model-unloaded') {
      if (state.activeModelId === viewerState.id) {
        state.activeModelId = null;
      }
      updateModelListUI();
      updateInfoChips();
    } else if (viewerState.type === 'vmd-playing') {
      setStatus(`正在播放: ${viewerState.name}`);
      if (_lastAIMsgEl) setAIMotion(_lastAIMsgEl, '▶ 动作已播放');
    } else if (viewerState.type === 'play-state') {
      state.isPlaying = viewerState.isPlaying;
      updatePlayButton();
    } else if (viewerState.type === 'snapshot') {
      // 下载快照
      const a = document.createElement('a');
      a.href = viewerState.dataUrl;
      a.download = viewerState.name;
      a.click();
      setStatus(`已保存快照: ${viewerState.name}`);
    } else if (viewerState.type === 'model-error') {
      setStatus(`模型加载失败: ${viewerState.error}`);
      hideLoading();
    } else if (viewerState.type === 'compile-error') {
      setStatus(`编译失败: ${viewerState.error}`);
      if (_lastAIMsgEl) setAIMotion(_lastAIMsgEl, '✗ 动作编译失败: ' + viewerState.error, true);
    }
  });
}

// ═══════════════════════════════════════════════════════════
//  文件夹扫描（Electron dialog）
// ═══════════════════════════════════════════════════════════

async function pickModelsFolder() {
  if (!api || !api.pickModelsFolder) {
    setStatus('需要 Electron 环境才能选择文件夹');
    return;
  }
  const result = await api.pickModelsFolder();
  if (!result) return;

  const { folderPath, files } = result;
  const folderName = folderPath.split(/[\\/]/).pop();

  // 收集 PMX/PMD
  const modelFiles = files.filter(f => {
    const n = f.name.toLowerCase();
    return n.endsWith('.pmx') || n.endsWith('.pmd');
  });

  if (modelFiles.length === 0) {
    setStatus('文件夹中未找到 PMX/PMD 文件');
    return;
  }

  // 清除同文件夹旧条目
  state.modelLibrary = state.modelLibrary.filter(m => m.folderName !== folderName);

  for (const mf of modelFiles) {
    const name = mf.name.replace(/\.(pmx|pmd)$/i, '');
    // 收集贴图文件（同目录下）
    const textureFiles = files.filter(f => {
      const n = f.name.toLowerCase();
      return /\.(png|jpg|jpeg|bmp|tga|dds|tiff?|spa|sph)$/i.test(n);
    }).map(f => ({ name: f.name, relativePath: f.relativePath, fullPath: f.fullPath }));

    state.modelLibrary.push({
      id: nextModelId(),
      name,
      pmxPath: mf.fullPath,
      textureFiles,
      folderName,
      size: mf.size,
    });
  }

  $('#models-folder-hint').textContent = `${folderName} · ${modelFiles.length} 个模型`;
  updateModelListUI();
  updateInfoChips();
  setStatus(`扫描到 ${modelFiles.length} 个模型`);
}

async function pickMotionsFolder() {
  if (!api || !api.pickMotionsFolder) {
    setStatus('需要 Electron 环境才能选择文件夹');
    return;
  }
  const result = await api.pickMotionsFolder();
  if (!result) return;

  const { folderPath, files } = result;
  const folderName = folderPath.split(/[\\/]/).pop();

  const motionFiles = files.filter(f => {
    const n = f.name.toLowerCase();
    return n.endsWith('.vmd') || n.endsWith('.txt') || n.endsWith('.mpl');
  });

  if (motionFiles.length === 0) {
    setStatus('文件夹中未找到 VMD/TXT 文件');
    return;
  }

  state.motionLibrary = state.motionLibrary.filter(m => m.folderName !== folderName);

  for (const f of motionFiles) {
    const n = f.name.toLowerCase();
    const type = n.endsWith('.vmd') ? 'vmd' : 'txt';
    const name = f.name.replace(/\.(vmd|txt|mpl)$/i, '');
    state.motionLibrary.push({
      id: nextMotionId(),
      name,
      type,
      path: f.fullPath,
      folderName,
      size: f.size,
      text: null,  // txt 文件内容按需读取
    });
  }

  $('#motions-folder-hint').textContent = `${folderName} · ${motionFiles.length} 个动作`;
  updateMotionListUI();
  updateInfoChips();
  setStatus(`扫描到 ${motionFiles.length} 个动作`);
}

// ═══════════════════════════════════════════════════════════
//  模型/动作操作
// ═══════════════════════════════════════════════════════════

async function loadModel(modelEntry) {
  await ensureViewerOpen();
  showLoading(`加载模型: ${modelEntry.name}...`);
  sendToViewer('viewer:load-model', {
    id: modelEntry.id,
    name: modelEntry.name,
    pmxPath: modelEntry.pmxPath,
    textureFiles: modelEntry.textureFiles,
  });
  // loading 由 viewer 回传的 model-loaded/model-error 关闭
}

async function applyMotion(motionEntry) {
  if (state.poseActive) stopCamera();

  state.activeMotionId = motionEntry.id;

  try {
    if (motionEntry.type === 'vmd') {
      showLoading(`加载 VMD: ${motionEntry.name}...`);
      // 读取 VMD 文件内容（用于反编译），同时传路径给 viewer
      if (api && api.readFileArrayBuffer) {
        state.vmdArrayBuffer = await api.readFileArrayBuffer(motionEntry.path);
        state.vmdFileName = motionEntry.name + '.vmd';
      }
      sendToViewer('viewer:play-vmd', {
        vmdPath: motionEntry.path,
        name: motionEntry.name,
      });
      hideLoading();
    } else if (motionEntry.type === 'txt') {
      showLoading(`编译文本: ${motionEntry.name}...`);
      // 读取文本内容
      let text = motionEntry.text;
      if (!text && api && api.readFileArrayBuffer) {
        // 读取文本文件
        const buffer = await api.readFileArrayBuffer(motionEntry.path);
        text = new TextDecoder('utf-8').decode(buffer);
        motionEntry.text = text;
      }
      state.mplFileText = text;
      state.mplFileName = motionEntry.name;
      $('#mpl-file-name').textContent = `✓ ${motionEntry.name}`;
      sendToViewer('viewer:compile-mpl', {
        text,
        name: motionEntry.name,
      });
      hideLoading();
    }
    updateMotionListUI();
  } catch (err) {
    console.error('[Motion] 加载失败:', err);
    hideLoading();
    setStatus(`动作加载失败: ${err.message}`);
  }
}

function clearScene() {
  sendToViewer('viewer:clear-scene', {});
  setStatus('场景已清空');
}

// ═══════════════════════════════════════════════════════════
//  动捕（在控制面板运行，landmarks 传给 viewer）
// ═══════════════════════════════════════════════════════════

async function startCamera() {
  if (!state.activeModelId) {
    setStatus('请先加载模型');
    return;
  }

  const videoEl = $('#pose-video');

  try {
    setStatus('正在加载 Holistic 检测模型（首次需下载，约10秒）...');
    state.poseCapture = new PoseCaptureSystem();
    await state.poseCapture.init((msg) => setStatus('📷 ' + msg));
    await state.poseCapture.startCamera(videoEl, (results) => {
      state.poseLandmarks = results;
      // 实时传 landmarks 给 viewer
      sendToViewer('viewer:landmarks', results);
    }, (msg) => setStatus('📷 ' + msg));
    state.poseActive = true;

    // 通知 viewer 进入动捕模式（准备 solver）
    sendToViewer('viewer:start-camera', {});

    $('#pose-panel').classList.add('active');
    $('#btn-camera').textContent = '⏹ 停止';
    setStatus('📷 摄像头已启动');
  } catch (err) {
    setStatus(`摄像头启动失败: ${err.message}`);
    console.error('[Pose] 启动失败:', err);
  }
}

function stopCamera() {
  if (state.poseCapture) {
    state.poseCapture.stop();
    state.poseCapture = null;
  }
  state.poseActive = false;
  state.poseLandmarks = null;

  if (state.isRecording) {
    stopRecording();
  }

  sendToViewer('viewer:stop-camera', {});

  $('#pose-panel').classList.remove('active');
  $('#btn-camera').textContent = '📷 启动捕捉';
  setStatus('摄像头已停止');
}

// ═══════════════════════════════════════════════════════════
//  录制（TODO：recorder 需要 mesh，目前先在控制面板留 UI，实际录制逻辑后续移到 viewer）
// ═══════════════════════════════════════════════════════════

function startRecording() {
  if (!state.activeModelId) { setStatus('请先加载模型'); return; }
  // TODO: 录制需要访问 viewer 的 mesh，后续通过 IPC 实现
  setStatus('录制功能需要 viewer 端配合（开发中）');
}

async function stopRecording() {
  if (!state.recorder) return;
  const data = state.recorder.stop();
  state.isRecording = false;
  $('#btn-record').textContent = '🔴 开始录制';
  const name = `capture_${Date.now()}.vmd`;
  await saveRecording(name, data);
  $('#record-status').textContent = `已保存: ${name}`;
  setStatus(`已保存录制: ${name}`);
}

// ═══════════════════════════════════════════════════════════
//  反编译
// ═══════════════════════════════════════════════════════════

async function decompileVMD() {
  if (!state.vmdArrayBuffer) { setStatus('请先加载 VMD 动作'); return; }
  try {
    startProgress();
    setStatus('反编译中...');
    const text = await vmdToText(state.vmdArrayBuffer, showProgress);
    endProgress();
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = state.vmdFileName.replace(/\.vmd$/i, '.txt');
    a.click();
    URL.revokeObjectURL(url);
    setStatus(`已下载: ${state.vmdFileName.replace(/\.vmd$/i, '.txt')}`);
  } catch (err) {
    endProgress();
    setStatus(`反编译失败: ${err.message}`);
  }
}

// ═══════════════════════════════════════════════════════════
//  UI 更新
// ═══════════════════════════════════════════════════════════

function updateInfoChips() {
  $('#chip-models .chip-value').textContent = state.modelLibrary.length;
  $('#chip-motions .chip-value').textContent = state.motionLibrary.length;
}

function updateModelListUI() {
  const list = $('#models-list');
  if (state.modelLibrary.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.3"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        <p>选择文件夹后<br/>模型将显示在此处</p>
      </div>`;
    return;
  }
  list.innerHTML = state.modelLibrary.map(m => {
    const isActive = state.activeModelId === m.id;
    const sizeStr = m.size > 1024 * 1024 ? (m.size / 1024 / 1024).toFixed(1) + ' MB' : (m.size / 1024).toFixed(0) + ' KB';
    return `
      <div class="resource-item ${isActive ? 'active' : ''}" data-id="${m.id}" data-kind="model">
        <div class="resource-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>
        </div>
        <div class="resource-info">
          <div class="resource-name">${escapeHtml(m.name)}</div>
          <div class="resource-meta">
            <span>${sizeStr}</span>
            ${isActive ? '<span class="resource-tag">已加载</span>' : ''}
          </div>
        </div>
      </div>`;
  }).join('');
}

function updateMotionListUI() {
  const list = $('#motions-list');
  if (state.motionLibrary.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.3"><path d="M5 4l14 8-14 8V4z"/></svg>
        <p>选择文件夹后<br/>动作将显示在此处</p>
      </div>`;
    return;
  }
  const filtered = state.motionFilter === 'all'
    ? state.motionLibrary
    : state.motionLibrary.filter(m => m.type === state.motionFilter);

  list.innerHTML = filtered.map(m => {
    const isActive = state.activeMotionId === m.id;
    const sizeStr = m.size > 1024 * 1024 ? (m.size / 1024 / 1024).toFixed(1) + ' MB' : (m.size / 1024).toFixed(0) + ' KB';
    return `
      <div class="resource-item ${isActive ? 'active' : ''}" data-id="${m.id}" data-kind="motion">
        <div class="resource-icon">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M5 4l14 8-14 8V4z"/></svg>
        </div>
        <div class="resource-info">
          <div class="resource-name">${escapeHtml(m.name)}</div>
          <div class="resource-meta">
            <span>${m.type.toUpperCase()}</span>
            <span>${sizeStr}</span>
          </div>
        </div>
      </div>`;
  }).join('');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function updatePlayButton() {
  const icon = $('#play-icon');
  if (state.isPlaying) {
    icon.innerHTML = '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
  } else {
    icon.innerHTML = '<polygon points="6 4 20 12 6 20 6 4"/>';
  }
}

// ═══════════════════════════════════════════════════════════
//  事件绑定
// ═══════════════════════════════════════════════════════════

function bindEvents() {
  // Tab 切换
  $$('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.tab-btn').forEach(b => b.classList.remove('active'));
      $$('.tab-panel').forEach(p => p.classList.remove('active'));
      btn.classList.add('active');
      const tab = btn.dataset.tab;
      $(`#panel-${tab}`).classList.add('active');
    });
  });

  // 文件夹选择（改用 Electron dialog）
  $('#pick-models-folder').addEventListener('click', pickModelsFolder);
  $('#pick-motions-folder').addEventListener('click', pickMotionsFolder);

  // 资源列表点击
  document.addEventListener('click', (e) => {
    const item = e.target.closest('.resource-item');
    if (!item) return;
    const id = item.dataset.id;
    const kind = item.dataset.kind;
    if (kind === 'model') {
      const entry = state.modelLibrary.find(m => m.id === id);
      if (entry) loadModel(entry);
    } else if (kind === 'motion') {
      const entry = state.motionLibrary.find(m => m.id === id);
      if (entry) applyMotion(entry);
    }
  });

  // 动作筛选
  $$('.filter-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      $$('.filter-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.motionFilter = btn.dataset.filter;
      updateMotionListUI();
    });
  });

  // 播放控制
  $('#btn-play').addEventListener('click', () => {
    state.isPlaying = !state.isPlaying;
    updatePlayButton();
    sendToViewer('viewer:toggle-play', {});
  });

  $('#btn-reset-camera').addEventListener('click', () => {
    sendToViewer('viewer:reset-camera', {});
  });

  $('#speed-slider').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    $('#speed-label').textContent = val.toFixed(1) + 'x';
    sendToViewer('viewer:set-speed', { speed: val });
  });

  $('#btn-clear-scene').addEventListener('click', clearScene);

  // 动捕
  $('#btn-camera').addEventListener('click', () => {
    if (state.poseActive) stopCamera();
    else startCamera();
  });
  $('#pose-close').addEventListener('click', stopCamera);
  $('#btn-calibrate').addEventListener('click', () => {
    resetCalibration();
    setStatus('校准已重置');
  });
  $('#btn-mirror').addEventListener('click', () => {
    const newMode = !getMirrorMode();
    setMirrorMode(newMode);
    $('#btn-mirror').textContent = newMode ? '🪞 镜像' : '🎭 木偶';
    sendToViewer('viewer:set-mirror', { mirror: newMode });
  });

  // 图片/视频提取（TODO：需要传给 viewer 或在控制面板处理后传 landmarks）
  $('#btn-pose-image').addEventListener('click', async () => {
    if (!api || !api.pickMediaFile) return;
    const result = await api.pickMediaFile([
      { name: '图片', extensions: ['png', 'jpg', 'jpeg'] },
    ]);
    if (!result) return;
    setStatus(`已选择图片: ${result.name}`);
    // TODO: 在控制面板处理图片提取姿势，然后传 landmarks 给 viewer
  });

  $('#btn-pose-video').addEventListener('click', async () => {
    if (!api || !api.pickMediaFile) return;
    const result = await api.pickMediaFile([
      { name: '视频', extensions: ['mp4', 'webm', 'avi'] },
    ]);
    if (!result) return;
    setStatus(`已选择视频: ${result.name}`);
    // TODO: 在控制面板处理视频提取动作
  });

  // 反编译/编译
  $('#btn-decompile').addEventListener('click', decompileVMD);

  $('#mpl-file-input').addEventListener('change', async (e) => {
    // Electron 模式下改用 dialog，这个 input 可能不会触发
    const file = e.target.files[0];
    if (!file) return;
    state.mplFileText = await file.text();
    state.mplFileName = file.name.replace(/\.(txt|mpl)$/i, '');
    $('#mpl-file-name').textContent = `✓ ${file.name}`;
    setStatus(`已加载文本: ${file.name}`);
  });

  $('#btn-compile').addEventListener('click', async () => {
    if (!state.mplFileText) { setStatus('请先选择文本文件'); return; }
    sendToViewer('viewer:compile-mpl', {
      text: state.mplFileText,
      name: state.mplFileName,
    });
  });

  // 录制
  $('#btn-record').addEventListener('click', () => {
    if (state.isRecording) stopRecording();
    else startRecording();
  });
  $('#btn-snapshot').addEventListener('click', () => {
    sendToViewer('viewer:snapshot', {});
  });

  bindAIChat();
}

// ═══════════════════════════════════════════════════════════
//  AI 对话（DeepSeek + MPL 动作生成）
// ═══════════════════════════════════════════════════════════

const AI_KEY_STORAGE = 'mmd_deepseek_api_key';
const aiMessagesEl = () => $('#ai-messages');
const aiInputEl = () => $('#ai-input');
const aiStatusEl = () => $('#ai-status');
let _lastAIMsgEl = null;  // 最近一条 AI 消息元素，用于回写动作状态

function setAIStatus(msg, kind) {
  const el = aiStatusEl();
  if (!el) return;
  el.textContent = msg || '';
  el.className = 'ai-status' + (kind ? ' ' + kind : '');
}

// 追加一条消息到聊天区，返回该消息元素
function appendAIMsg(role, text) {
  const el = aiMessagesEl();
  if (!el) return null;
  // 首次发送时清空空状态提示
  const empty = el.querySelector('.ai-empty');
  if (empty) empty.remove();

  const msg = document.createElement('div');
  msg.className = 'ai-msg ' + (role === 'user' ? 'user' : 'ai');
  const roleEl = document.createElement('div');
  roleEl.className = 'ai-msg-role';
  roleEl.textContent = role === 'user' ? '我' : '角色';
  const bubble = document.createElement('div');
  bubble.className = 'ai-msg-bubble';
  bubble.textContent = text;
  msg.appendChild(roleEl);
  msg.appendChild(bubble);
  el.appendChild(msg);
  el.scrollTop = el.scrollHeight;
  return msg;
}

// 在 AI 消息下追加动作状态行
function setAIMotion(msgEl, text, isErr) {
  if (!msgEl) return;
  let motion = msgEl.querySelector('.ai-msg-motion');
  if (!motion) {
    motion = document.createElement('div');
    motion.className = 'ai-msg-motion' + (isErr ? ' err' : '');
    msgEl.appendChild(motion);
  }
  motion.className = 'ai-msg-motion' + (isErr ? ' err' : '');
  motion.textContent = text;
}

// 显示"正在思考"动画，返回该消息元素
function showTyping() {
  const el = aiMessagesEl();
  if (!el) return null;
  const empty = el.querySelector('.ai-empty');
  if (empty) empty.remove();
  const msg = document.createElement('div');
  msg.className = 'ai-msg ai typing';
  const roleEl = document.createElement('div');
  roleEl.className = 'ai-msg-role';
  roleEl.textContent = '角色';
  const bubble = document.createElement('div');
  bubble.className = 'ai-msg-bubble';
  msg.appendChild(roleEl);
  msg.appendChild(bubble);
  el.appendChild(msg);
  el.scrollTop = el.scrollHeight;
  return msg;
}

// 从 AI 返回的 content 中解析 {reply, mpl}
function parseAIResponse(content) {
  if (!content) return { reply: '', mpl: '' };
  try {
    const obj = JSON.parse(content);
    return {
      reply: obj.reply || '',
      mpl: obj.mpl || '',
    };
  } catch (e) {
    // JSON 解析失败：尝试从文本中提取代码块作为兜底
    const reply = content.replace(/```[\s\S]*?```/g, '').trim();
    const m = content.match(/```(?:mpl|MPL)?\n?([\s\S]*?)```/);
    return { reply: reply || content.slice(0, 200), mpl: m ? m[1] : '' };
  }
}

async function sendAIMessage() {
  if (state.aiBusy) return;
  const input = aiInputEl();
  const text = (input?.value || '').trim();
  if (!text) return;

  const apiKey = ($('#ai-api-key').value || '').trim();
  if (!apiKey) {
    setAIStatus('请先填写 DeepSeek API Key', 'err');
    $('#ai-api-key').focus();
    return;
  }
  // 持久化 key
  localStorage.setItem(AI_KEY_STORAGE, apiKey);

  const model = $('#ai-model').value || 'deepseek-v4-flash';

  // 首次对话注入 system prompt
  if (state.aiMessages.length === 0) {
    state.aiMessages.push({ role: 'system', content: AI_SYSTEM_PROMPT });
  }

  // 显示用户消息
  appendAIMsg('user', text);
  state.aiMessages.push({ role: 'user', content: text });

  // 清空输入、禁用、显示思考动画
  input.value = '';
  input.style.height = 'auto';
  $('#ai-send').disabled = true;
  state.aiBusy = true;
  setAIStatus('思考中…');
  const typingEl = showTyping();

  const result = await api.aiChat({ apiKey, model, messages: state.aiMessages });

  state.aiBusy = false;
  $('#ai-send').disabled = false;

  if (typingEl) typingEl.remove();

  if (!result.ok) {
    appendAIMsg('ai', '（请求失败：' + result.error + '）');
    setAIStatus('请求失败: ' + result.error, 'err');
    // 失败时把刚加入的用户消息从历史移除，避免污染上下文
    state.aiMessages.pop();
    return;
  }

  const { reply, mpl } = parseAIResponse(result.content);

  // 显示角色台词
  const aiMsgEl = appendAIMsg('ai', reply || '（无回复）');
  _lastAIMsgEl = aiMsgEl;
  // 记录 assistant 消息到历史（存原始 content，保持上下文连贯）
  state.aiMessages.push({ role: 'assistant', content: result.content });

  // 编译并播放 MPL 动作
  if (mpl && mpl.trim()) {
    if (!state.viewerOpened) {
      setAIMotion(aiMsgEl, '⚠ 未打开模型窗口，动作未播放', true);
      setAIStatus('已回复，但模型窗口未打开', 'err');
      return;
    }
    setAIMotion(aiMsgEl, '正在生成动作…');
    setAIStatus('已回复，正在播放动作…', 'ok');
    sendToViewer('viewer:compile-mpl', {
      text: mpl,
      name: 'AI生成动作',
    });
  } else {
    setAIStatus('已回复', 'ok');
  }
}

function bindAIChat() {
  // 恢复已保存的 API key
  const savedKey = localStorage.getItem(AI_KEY_STORAGE);
  if (savedKey) $('#ai-api-key').value = savedKey;

  // 显示/隐藏 key
  $('#ai-key-toggle').addEventListener('click', () => {
    const inp = $('#ai-api-key');
    inp.type = inp.type === 'password' ? 'text' : 'password';
  });

  // 清空对话
  $('#ai-clear').addEventListener('click', () => {
    state.aiMessages = [];
    const el = aiMessagesEl();
    if (el) {
      el.innerHTML = '';
      const empty = document.createElement('div');
      empty.className = 'ai-empty';
      empty.innerHTML = '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.2" opacity="0.3"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg><p>对话已清空<br/>可重新开始</p>';
      el.appendChild(empty);
    }
    setAIStatus('');
  });

  // 发送按钮
  $('#ai-send').addEventListener('click', sendAIMessage);

  // 输入框：Enter 发送，Shift+Enter 换行；自动增高
  const inp = aiInputEl();
  inp.addEventListener('input', () => {
    inp.style.height = 'auto';
    inp.style.height = Math.min(inp.scrollHeight, 100) + 'px';
  });
  inp.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendAIMessage();
    }
  });

  // key 变化时实时持久化
  $('#ai-api-key').addEventListener('change', () => {
    localStorage.setItem(AI_KEY_STORAGE, $('#ai-api-key').value.trim());
  });
}

// ═══════════════════════════════════════════════════════════
//  启动
// ═══════════════════════════════════════════════════════════

function init() {
  try {
    console.log('[Control Panel] init() 开始');
    bindEvents();
    setMirrorMode(true);
    console.log('[Control Panel] 初始化完成');
    document.body.setAttribute('data-init', 'ok');
  } catch (err) {
    console.error('[Control Panel] 初始化失败:', err);
    document.body.setAttribute('data-init', 'error');
    document.body.setAttribute('data-init-err', err.message);
    const banner = document.createElement('div');
    banner.style.cssText = 'position:fixed;top:0;left:0;right:0;background:#f87171;color:#fff;padding:8px;font-size:12px;z-index:9999;font-family:monospace';
    banner.textContent = '初始化错误: ' + err.message;
    document.body.appendChild(banner);
  }
}

init();
