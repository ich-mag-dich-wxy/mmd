import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { MMDAnimationHelper } from 'three/addons/animation/MMDAnimationHelper.js';
import { createAvatar } from './src/core/avatarCore.js';
import { vmdToText, textToVMD, createDirectAnimationClip, downloadVMD } from './src/core/vmdDecompiler.js';

const state = {
  mesh: null,
  avatar: null,
  helper: new MMDAnimationHelper(),
  clock: new THREE.Clock(),
  isPlaying: true,
  animation: null,
  ammoReady: false,
  modelName: '',
  motionName: '',
  textureUrlMap: {},
  fileCache: {},
  folderName: '',
  vmdArrayBuffer: null,
  vmdFileName: '',
  mplFileText: null,
  mplFileName: '',
};

const $ = (sel) => document.querySelector(sel);
const container = $('#scene-container');
const loadingOverlay = $('#loading-overlay');
const loadingText = $('#loading-text');
const dropZone = $('#drop-zone');
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

function startProgress() {
  progressEl.classList.add('active');
  progressFill.style.width = '0%';
  progressText.textContent = '';
}

function endProgress() {
  progressEl.classList.remove('active');
  progressFill.style.width = '0%';
}

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x2a2a3a);

const camera = new THREE.PerspectiveCamera(22, container.clientWidth / container.clientHeight, 1, 3000);
camera.position.set(0, 22, 70);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setSize(container.clientWidth, container.clientHeight);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.2;
container.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 15, 0);
controls.enableDamping = true;
controls.dampingFactor = 0.05;
controls.minDistance = 5;
controls.maxDistance = 300;
controls.update();

scene.add(new THREE.AmbientLight(0x404060, 0.6));
scene.add(new THREE.HemisphereLight(0xadd8e6, 0x333333, 0.8));
const mLight = new THREE.DirectionalLight(0xffeedd, 2.0);
mLight.position.set(10, 20, 10);
scene.add(mLight);
const fLight = new THREE.DirectionalLight(0x8888ff, 0.6);
fLight.position.set(-10, 5, -10);
scene.add(fLight);
const rLight = new THREE.DirectionalLight(0xffffff, 0.5);
rLight.position.set(0, -5, 15);
scene.add(rLight);

const grid = new THREE.GridHelper(40, 20, 0x8888ff, 0x444466);
grid.position.y = 0;
scene.add(grid);

window.addEventListener('resize', () => {
  camera.aspect = container.clientWidth / container.clientHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(container.clientWidth, container.clientHeight);
});

function showLoading(msg) { loadingText.textContent = msg; loadingOverlay.classList.add('active'); }
function hideLoading() { loadingOverlay.classList.remove('active'); }

async function initAmmo() {
  showLoading('初始化物理引擎...');
  try {
    if (typeof Ammo !== 'undefined') {
      await Ammo();
      state.ammoReady = true;
    }
  } catch (e) {
    console.warn('[MMD] 物理引擎不可用:', e);
  }
  hideLoading();
}

function buildTextureUrlMap(filesArray) {
  const exts = ['.png', '.jpg', '.jpeg', '.bmp', '.tga', '.dds', '.tif', '.tiff', '.gif'];
  const map = {};
  for (const file of filesArray) {
    const ext = '.' + file.name.split('.').pop().toLowerCase();
    if (!exts.includes(ext)) continue;
    const blobUrl = URL.createObjectURL(file);
    const relPath = file.webkitRelativePath ? file.webkitRelativePath.replace(/\\/g, '/') : file.name;
    map[relPath.toLowerCase()] = blobUrl;
    map[file.name.toLowerCase()] = blobUrl;
    const parts = relPath.split('/');
    if (parts.length > 1) map[parts.slice(1).join('/').toLowerCase()] = blobUrl;
  }
  return map;
}

function patchMMDLoader(loader) {
  const mb = loader.meshBuilder.materialBuilder;
  const origLoadTexture = mb._loadTexture.bind(mb);
  mb._loadTexture = function (filePath, textures, params, onProgress, onError) {
    params = params || {};
    if (params.isDefaultToonTexture) return origLoadTexture(filePath, textures, params, onProgress, onError);
    const np = filePath.replace(/\\/g, '/').toLowerCase();
    const fn = np.split('/').pop();
    const candidates = [np, fn, state.folderName ? state.folderName + '/' + np : null, state.folderName ? state.folderName + '/' + fn : null].filter(Boolean);
    for (const c of candidates) {
      if (state.textureUrlMap[c]) {
        const blobUrl = state.textureUrlMap[c];
        const savedPath = this.resourcePath;
        this.resourcePath = '';
        const wrappedOnError = onError || (() => {});
        const result = origLoadTexture(blobUrl, textures, params, onProgress, wrappedOnError);
        this.resourcePath = savedPath;
        return result;
      }
    }
    return origLoadTexture(filePath, textures, params, onProgress, onError || (() => {}));
  };
  return loader;
}

async function loadMMD() {
  const modelFile = state.fileCache['model'];
  if (!modelFile) {
    loadingText.textContent = '请先选择 PMX 模型文件';
    setTimeout(hideLoading, 1500);
    return;
  }

  if (state.mesh) {
    state.helper.remove(state.mesh);
    scene.remove(state.mesh);
    state.mesh = null;
    state.avatar = null;
  }
  state.animation = null;

  showLoading('构建纹理映射表...');
  state.textureUrlMap = buildTextureUrlMap(Object.values(state.fileCache));
  showLoading('加载 3D 模型中...');

  let modelUrl = null;
  try {
    const modelBuffer = await modelFile.arrayBuffer();
    const loader = patchMMDLoader(new MMDLoader());
    loader.setResourcePath('/');
    const modelBlob = new Blob([modelBuffer], { type: 'application/octet-stream' });
    modelUrl = URL.createObjectURL(modelBlob);

    const motionFile = state.fileCache['motion'];
    const cameraFile = state.fileCache['camera'];

    if (motionFile) {
      const motionBuffer = await motionFile.arrayBuffer();
      state.vmdArrayBuffer = motionBuffer.slice(0);
      state.vmdFileName = motionFile.name;
      const motionBlob = new Blob([motionBuffer], { type: 'application/octet-stream' });
      const motionUrl = URL.createObjectURL(motionBlob);
      const result = await new Promise((res, rej) =>
        loader.loadWithAnimation(modelUrl, motionUrl, (m) => res(m), null, (e) => rej(e))
      );
      state.mesh = result.mesh;
      state.animation = result.animation;
      scene.add(state.mesh);
      state.helper.add(state.mesh, {
        animation: state.animation,
        physics: false,
      });
      URL.revokeObjectURL(motionUrl);
    } else {
      state.mesh = await new Promise((res, rej) =>
        loader.load(modelUrl, (m) => res(m), null, rej)
      );
      scene.add(state.mesh);
    }

    await new Promise((r) => setTimeout(r, 100));
    if (state.mesh.skeleton && state.mesh.skeleton.bones) {
      const vmdMode = !!state.animation;
      state.avatar = createAvatar(state.mesh, { scene, helper: state.helper, vmdMode });
    }

    updateInfo();
    hideLoading();
    editorStatus.textContent = `✅ 模型「${state.modelName}」加载成功`;
  } catch (err) {
    console.error('[MMD] 加载失败:', err);
    loadingText.textContent = `加载失败: ${err.message || '未知错误'}`;
    setTimeout(hideLoading, 3000);
  } finally {
    if (modelUrl) URL.revokeObjectURL(modelUrl);
  }
}

async function applyVMDMotion() {
  const motionFile = state.fileCache['motion'];
  if (!motionFile || !state.mesh) return;

  try {
    showLoading('加载 VMD 动作...');

    if (state.avatar) {
      state.avatar.stopAllAnimations();
    }
    try { state.helper.remove(state.mesh); } catch(e) {}

    const loader = patchMMDLoader(new MMDLoader());
    const motionBuffer = await motionFile.arrayBuffer();
    state.vmdArrayBuffer = motionBuffer.slice(0);
    state.vmdFileName = motionFile.name;

    const motionBlob = new Blob([motionBuffer], { type: 'application/octet-stream' });
    const motionUrl = URL.createObjectURL(motionBlob);

    const animation = await new Promise((res, rej) => {
      loader.loadAnimation(motionUrl, state.mesh, res, null, rej);
    });

    state.animation = animation;

    state.helper.add(state.mesh, {
      animation: animation,
      animationRepeat: Infinity,
      physics: false,
    });

    if (state.avatar) {
      state.avatar._vmdMode = true;
    }

    URL.revokeObjectURL(motionUrl);
    state.motionName = motionFile.name.replace(/\.vmd$/i, '');
    updateInfo();
    editorStatus.textContent = `🎬 正在播放: ${state.motionName}.vmd`;
    hideLoading();
  } catch (err) {
    console.error('[VMD] 加载失败:', err);
    hideLoading();
    editorStatus.textContent = `❌ 加载失败: ${err.message}`;
  }
}

function updateInfo() {
  const infoModel = $('#info-model');
  const infoMotion = $('#info-motion');
  if (infoModel) infoModel.textContent = state.modelName || '未加载';
  if (infoMotion) infoMotion.textContent = state.motionName || '无';
}

function handleFolderUpload(files) {
  for (const key in state.textureUrlMap) URL.revokeObjectURL(state.textureUrlMap[key]);
  state.fileCache = {};
  state.textureUrlMap = {};
  state.modelName = state.motionName = '';
  state.folderName = '';

  if (files.length > 0 && files[0].webkitRelativePath) {
    state.folderName = files[0].webkitRelativePath.replace(/\\/g, '/').split('/')[0];
  }

  let foundModel = false;
  for (const file of files) {
    const n = file.name.toLowerCase();
    if (n.endsWith('.pmx') || n.endsWith('.pmd')) {
      state.fileCache['model'] = file;
      state.modelName = file.name.replace(/\.(pmx|pmd)$/i, '');
      foundModel = true;
    } else if (n.endsWith('.vmd')) {
      if (!state.fileCache['motion']) {
        state.fileCache['motion'] = file;
        state.motionName = file.name.replace(/\.vmd$/i, '');
      } else {
        state.fileCache['camera'] = file;
      }
    } else {
      state.fileCache['tex_' + file.name] = file;
    }
  }

  if (!foundModel) { alert('未找到 PMX/PMD 文件！'); return; }

  $('#file-folder-name').textContent = `✓ ${state.folderName} (${files.length} 文件)`;
  $('#file-motion-name').textContent = state.motionName ? `✓ ${state.motionName}.vmd` : '未选择';

  loadMMD();
}

function animate() {
  requestAnimationFrame(animate);
  const delta = state.clock.getDelta();

  if (state.isPlaying) {
    controls.update();
    if (state.helper) {
      state.helper.update(delta);
    }
    if (state.avatar && !state.avatar._vmdMode) {
      state.avatar.userWorldPos.set(
        camera.position.x * 0.3,
        camera.position.y * 0.3,
        camera.position.z * 0.3,
      );
      state.avatar.update(delta);
    }
  }

  renderer.render(scene, camera);
}

document.querySelectorAll('.file-input-folder').forEach((input) => {
  input.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handleFolderUpload(e.target.files);
  });
});

dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
dropZone.addEventListener('dragleave', () => { dropZone.classList.remove('drag-over'); });
dropZone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');
  const files = Array.from(e.dataTransfer.files);
  if (files.length > 1 && files.some((f) => f.name.toLowerCase().endsWith('.pmx') || f.name.toLowerCase().endsWith('.pmd'))) {
    handleFolderUpload(files);
  }
});

document.querySelectorAll('.file-input').forEach((input) => {
  input.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const type = input.dataset.type;
    const name = file.name.toLowerCase();

    if (type === 'motion') {
      state.fileCache['motion'] = file;
      state.motionName = file.name.replace(/\.vmd$/i, '');
      $('#file-motion-name').textContent = `✓ ${state.motionName}.vmd`;
      if (state.mesh) {
        applyVMDMotion();
      }
    }
  });
});

$('#btn-play').addEventListener('click', () => {
  state.isPlaying = !state.isPlaying;
  $('#btn-play').textContent = state.isPlaying ? '⏯️' : '▶';
});

$('#btn-reset-camera').addEventListener('click', () => {
  camera.position.set(0, 8, 45);
  controls.target.set(0, 10, 0);
  controls.update();
});

$('#speed-slider').addEventListener('input', () => {
  const val = parseFloat($('#speed-slider').value);
  $('#speed-label').textContent = val.toFixed(1) + 'x';
  state.helper.setAnimationSpeed(val);
});

$('#btn-decompile').addEventListener('click', async () => {
  const buffer = state.vmdArrayBuffer;
  if (!buffer) {
    editorStatus.textContent = '⚠️ 请先上传 VMD 文件';
    return;
  }
  try {
    startProgress();
    editorStatus.textContent = '反编译中...';
    const text = await vmdToText(buffer, showProgress);
    endProgress();

    // 下载为文本文件
    const baseName = state.vmdFileName.replace(/\.vmd$/i, '');
    const fileName = baseName + '_decompiled.txt';
    const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();
    URL.revokeObjectURL(url);

    const boneCount = text.split('\n').filter(l => l.startsWith('b ')).length;
    const morphCount = text.split('\n').filter(l => l.startsWith('m ')).length;
    editorStatus.textContent = `✅ 已下载 ${fileName}: ${boneCount.toLocaleString()}骨骼帧, ${morphCount.toLocaleString()}形变帧`;
  } catch (err) {
    endProgress();
    editorStatus.textContent = `❌ 反编译失败: ${err.message}`;
  }
});

// 上传文本文件
$('#mpl-file-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    state.mplFileText = await file.text();
    state.mplFileName = file.name;
    $('#mpl-file-name').textContent = `✓ ${file.name}`;
    const boneCount = state.mplFileText.split('\n').filter(l => l.startsWith('b ')).length;
    const morphCount = state.mplFileText.split('\n').filter(l => l.startsWith('m ')).length;
    editorStatus.textContent = `📄 已加载: ${boneCount.toLocaleString()}骨骼帧, ${morphCount.toLocaleString()}形变帧`;
  } catch (err) {
    editorStatus.textContent = `❌ 读取文件失败: ${err.message}`;
  }
});

$('#btn-compile').addEventListener('click', async () => {
  if (!state.mplFileText) {
    editorStatus.textContent = '⚠️ 请先上传文本文件';
    return;
  }
  if (!state.mesh) {
    editorStatus.textContent = '⚠️ 请先加载模型';
    return;
  }

  const text = state.mplFileText;

  // 1. 文本 → VMD 二进制（异步）
  let vmdData;
  try {
    startProgress();
    editorStatus.textContent = '编译中...';
    vmdData = await textToVMD(text, showProgress);
  } catch (err) {
    endProgress();
    editorStatus.textContent = `❌ 编译失败: ${err.message}`;
    return;
  }

  // 2. 用 MMDLoader 加载编译出的 VMD 并播放
  if (state.avatar) {
    state.avatar.stopAllAnimations();
    state.avatar._vmdMode = true;
    state.avatar._vmdModePureJS = false;
  }
  try { state.helper.remove(state.mesh); } catch(e) {}

  editorStatus.textContent = '加载动画...';
  state.isPlaying = true;
  $('#btn-play').textContent = '⏯️';
  const loader = new MMDLoader();
  const blob = new Blob([vmdData], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);

  loader.loadAnimation(url, state.mesh, (animation) => {
    URL.revokeObjectURL(url);
    state.animation = animation;
    state.helper.add(state.mesh, {
      animation: animation,
      animationRepeat: Infinity,
      physics: false,
    });
    endProgress();
    editorStatus.textContent = `▶ 播放中: ${animation.tracks.length}轨道, ${animation.duration.toFixed(1)}秒`;
    state.motionName = '编译 VMD';
    updateInfo();
  }, null, (err) => {
    URL.revokeObjectURL(url);
    endProgress();
    // MMDLoader 失败，回退到 Pure-JS 直接播放
    console.warn('[Compile] MMDLoader 播放失败，回退到 Pure-JS:', err);
    try {
      const clip = createDirectAnimationClip(text, state.mesh.skeleton, state.mesh.morphTargetDictionary);
      state.avatar.stopAllAnimations();
      state.avatar._vmdMode = false;
      state.avatar._vmdModePureJS = true;

      // 手动驱动 clip
      state.avatar._animClip = clip;
      state.avatar._animTime = 0;

      editorStatus.textContent = `▶ Pure-JS 播放: ${clip.tracks.length}轨道, ${clip.duration.toFixed(1)}秒`;
      state.motionName = '编译 VMD (Pure-JS)';
      updateInfo();
    } catch (fallbackErr) {
      editorStatus.textContent = `❌ 播放失败: ${fallbackErr.message}`;
    }
  });
});

async function init() {
  await initAmmo();
  animate();
  hideLoading();
}

init();
