// ═══════════════════════════════════════════════════════════
//  viewer.js — Electron 模型窗口（透明背景）
//
//  职责：
//    - 3D 场景渲染（透明背景，只显示模型）
//    - 接收控制面板的 IPC 指令（load-model/play-vmd/start-camera 等）
//    - 动捕 landmarks 由控制面板通过 IPC 传入，这里只做 solver 求解和骨骼应用
//    - 窗口拖动（顶部 drag region）
//
//  与 main.js（控制面板）的差异：
//    - 无 UI 控件（按钮、侧边栏、加载遮罩等），只有 canvas + 状态文字
//    - 无文件选择对话框（由主进程处理）
//    - 无 PoseCaptureSystem（摄像头在控制面板运行，landmarks 通过 IPC 传入）
//    - 无 VMDRecorder（录制由控制面板触发，但 recorder 需要 mesh，后续再拆）
// ═══════════════════════════════════════════════════════════

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { MMDLoader } from 'three/addons/loaders/MMDLoader.js';
import { MMDAnimationHelper } from 'three/addons/animation/MMDAnimationHelper.js';
import { compileMPLToVMD, isMPLScript, preloadVMDForPatch, setLastMplText } from './src/core/mplCompiler.js';
import { isKFM, kfmToMPL } from './src/core/kfmConverter.js';
import { textToVMD } from './src/core/vmdDecompiler.js';
import { resetCalibration, setMirrorMode, buildPoseBoneMap } from './src/core/poseCapture.js';
import { Solver as PoPoSolver, SOLVER_REST_BONES } from './src/core/poseCapture/solver.js';
import { FaceBlendshapeSolver } from './src/core/faceBlendshapeSolver.js';

// ═══════════════════════════════════════════════════════════
//  状态
// ═══════════════════════════════════════════════════════════

const state = {
  scene: null,
  camera: null,
  renderer: null,
  controls: null,
  clock: new THREE.Clock(),
  loadedModels: [],
  activeModelId: null,
  isPlaying: true,
  // 动捕（landmarks 由控制面板传入）
  poseActive: false,
  poseLandmarks: null,
  poseSolver: null,
  poseBoneLookup: null,
  poseGrants: null,
  poseGrantRestQuats: null,
  faceSolver: null,
  posePrevBoneQuats: null,
  poseCurrBoneQuats: null,
  poseCurrSolveTs: 0,
  posePrevSolveTs: 0,
  poseLandmarksDirty: false,
  poseMorphWeights: null,
  poseBoneByUuid: null,
  // 临时状态
  pendingMplText: null,
  pendingMplName: null,
};

let _modelIdCounter = 0;
const nextModelId = () => 'm' + (++_modelIdCounter);

const $ = (sel) => document.querySelector(sel);
const container = $('#scene-container');
const loadingOverlay = $('#loading-overlay');
const loadingText = $('#loading-text');
const statusText = $('#status-text');

function showLoading(msg) { loadingText.textContent = msg; loadingOverlay.classList.add('active'); }
function hideLoading() { loadingOverlay.classList.remove('active'); }
function setStatus(msg) { if (statusText) statusText.textContent = msg; }

// 回传状态给控制面板
function sendStateToControl(state) {
  if (window.electronAPI && window.electronAPI.sendState) {
    window.electronAPI.sendState(state);
  }
}

// ═══════════════════════════════════════════════════════════
//  3D 场景初始化（透明背景）
// ═══════════════════════════════════════════════════════════

function initScene() {
  state.scene = new THREE.Scene();
  // 关键：背景设为 null，让 renderer 的 alpha 通道透出桌面
  state.scene.background = null;

  const w = container.clientWidth;
  const h = container.clientHeight;
  state.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 5000);
  state.camera.position.set(0, 18, 40);

  // 关键：alpha: true 开启透明背景，premultipliedAlpha 避免边缘黑边
  state.renderer = new THREE.WebGLRenderer({
    antialias: true,
    alpha: true,
    premultipliedAlpha: true,
    preserveDrawingBuffer: true,  // 快照需要
  });
  state.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  state.renderer.setSize(w, h);
  state.renderer.outputColorSpace = THREE.SRGBColorSpace;
  state.renderer.toneMapping = THREE.ACESFilmicToneMapping;
  state.renderer.toneMappingExposure = 1.0;
  // setClearColor 透明
  state.renderer.setClearColor(0x000000, 0);
  container.appendChild(state.renderer.domElement);

  // OrbitControls：鼠标旋转/缩放（在 drag-region 以外的区域）
  state.controls = new OrbitControls(state.camera, state.renderer.domElement);
  state.controls.enableDamping = true;
  state.controls.dampingFactor = 0.08;
  state.controls.target.set(0, 12, 0);
  state.controls.minDistance = 5;
  state.controls.maxDistance = 200;
  state.controls.maxPolarAngle = Math.PI * 0.95;

  // 灯光（透明场景仍需要灯光照亮模型）
  const ambient = new THREE.AmbientLight(0xffffff, 0.65);
  state.scene.add(ambient);

  const dirLight = new THREE.DirectionalLight(0xffffff, 1.1);
  dirLight.position.set(20, 30, 20);
  state.scene.add(dirLight);

  const fillLight = new THREE.DirectionalLight(0x88aaff, 0.4);
  fillLight.position.set(-20, 15, -10);
  state.scene.add(fillLight);

  // 不加地面网格（透明窗口要求只显示模型）

  window.addEventListener('resize', onResize);
  animate();
}

function onResize() {
  const w = container.clientWidth;
  const h = container.clientHeight;
  state.camera.aspect = w / h;
  state.camera.updateProjectionMatrix();
  state.renderer.setSize(w, h);
}

function animate() {
  requestAnimationFrame(animate);
  const delta = state.clock.getDelta();

  if (state.isPlaying) {
    state.controls.update();

    if (state.poseActive && state.poseLandmarks) {
      const active = getActiveModel();
      if (active) {
        if (state.poseLandmarksDirty) {
          solvePose(active);
          state.poseLandmarksDirty = false;
        }
        applyPoseToMesh(active);
      }
    } else {
      for (const m of state.loadedModels) {
        if (m.helper) m.helper.update(delta);
      }
    }
  }

  state.renderer.render(state.scene, state.camera);
}

// ═══════════════════════════════════════════════════════════
//  模型加载
// ═══════════════════════════════════════════════════════════

// 从文件路径加载模型（Electron 模式：控制面板选择文件夹后传路径过来）
// payload: { id, name, pmxPath, textureFiles: [{name, relativePath, fullPath}] }
async function loadModelFromPath(payload) {
  showLoading(`加载模型: ${payload.name}...`);
  // 收集所有创建的 blob URL，用于加载完成后清理
  const createdUrls = [];
  try {
    // ── 预加载贴图文件为 blob URL ──
    // Chromium 安全策略阻止 http:// 页面通过 file:// 加载本地文件，
    // 所以必须通过 IPC 读取贴图为 ArrayBuffer，再创建 blob URL 供 MMDLoader 使用。
    const texLookup = {};
    const texEntries = []; // [{key, fullPath}]
    for (const tf of (payload.textureFiles || [])) {
      const lower = tf.name.toLowerCase();
      texEntries.push({ key: lower, fullPath: tf.fullPath });
      if (tf.relativePath) {
        const relNorm = tf.relativePath.replace(/\\/g, '/').toLowerCase();
        if (relNorm !== lower) texEntries.push({ key: relNorm, fullPath: tf.fullPath });
        // 同时存储不带目录的 basename
        const baseName = relNorm.split('/').pop();
        if (baseName !== lower && baseName !== relNorm) {
          texEntries.push({ key: baseName, fullPath: tf.fullPath });
        }
      }
    }

    // 并行读取所有贴图文件
    const mimeByExt = (name) => {
      const ext = name.toLowerCase().match(/\.([^.]+)$/)?.[1] || '';
      if (ext === 'png') return 'image/png';
      if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
      if (ext === 'bmp') return 'image/bmp';
      if (ext === 'tga') return 'image/x-tga';
      if (ext === 'dds') return 'image/vnd.ms-dds';
      if (ext === 'tiff' || ext === 'tif') return 'image/tiff';
      if (ext === 'spa' || ext === 'sph') return 'application/octet-stream';
      return 'application/octet-stream';
    };

    // 按 fullPath 去重，避免同一文件被读多次
    const uniquePaths = [...new Set(texEntries.map(e => e.fullPath))];
    const pathToBlobUrl = {};
    await Promise.all(uniquePaths.map(async (fp) => {
      try {
        const buf = await window.electronAPI.readFileArrayBuffer(fp);
        const mime = mimeByExt(fp);
        const blobUrl = URL.createObjectURL(new Blob([buf], { type: mime }));
        pathToBlobUrl[fp] = blobUrl;
        createdUrls.push(blobUrl);
      } catch (e) {
        console.warn(`[Viewer] 贴图预加载失败: ${fp}`, e);
      }
    }));

    // 填充 texLookup：key → blobUrl
    for (const { key, fullPath } of texEntries) {
      if (pathToBlobUrl[fullPath]) {
        texLookup[key] = pathToBlobUrl[fullPath];
      }
    }

    const manager = new THREE.LoadingManager();
    manager.resolveURL = (url) => {
      // blob: / data: 直接放行
      if (/^blob:[^/]+:\/\/[^/]+\/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(url) || url.startsWith('data:')) {
        return url;
      }
      let pathPart = url;
      try { pathPart = decodeURIComponent(pathPart); } catch (e) {}
      pathPart = pathPart.replace(/^blob:[^/]+:\/\/[^/]+\//, '');
      pathPart = pathPart.replace(/^https?:\/\/[^/]+\//, '');
      pathPart = pathPart.replace(/^[./]+/, '');
      // 去掉可能残留的 file:// 前缀和盘符
      pathPart = pathPart.replace(/^file:\/\/\/[a-z]:/i, '');
      const norm = pathPart.replace(/\\/g, '/').toLowerCase();
      const baseName = norm.split('/').pop();
      if (texLookup[norm]) return texLookup[norm];
      if (texLookup[baseName]) return texLookup[baseName];
      // 未命中查找表：返回原 url（可能是 MMDLoader 内部生成的 blob）
      return url;
    };

    // 读取 PMX 文件为 ArrayBuffer
    const pmxBuffer = await window.electronAPI.readFileArrayBuffer(payload.pmxPath);
    const pmxBlobUrl = URL.createObjectURL(new Blob([pmxBuffer]));
    createdUrls.push(pmxBlobUrl);

    const loader = new MMDLoader(manager);
    const helper = new MMDAnimationHelper({ afterglow: 0 });

    const mesh = await new Promise((resolve, reject) => {
      loader.load(
        pmxBlobUrl,
        (object) => resolve(object),
        undefined,
        (err) => reject(err)
      );
    });

    state.scene.add(mesh);
    helper.add(mesh, { physics: false });

    const loaded = {
      id: payload.id || nextModelId(),
      name: payload.name,
      mesh,
      helper,
      motionName: '',
      vmdBuffer: null,
      pmxUrl: pmxBlobUrl,
      createdUrls,
      // 自动错开位置：每个模型在 X 轴偏移，避免重叠
      // 偏移量基于已加载数量，间隔约 30 单位（足够分开两个角色）
      offset: state.loadedModels.length * 30,
    };
    mesh.position.x = loaded.offset;
    mesh.updateMatrixWorld(true);
    state.loadedModels.push(loaded);
    state.activeModelId = loaded.id;

    focusModel(mesh);
    hideLoading();
    setStatus(`已加载: ${payload.name}`);
    sendStateToControl({ type: 'model-loaded', id: loaded.id, name: loaded.name });
  } catch (err) {
    // 加载失败时清理已创建的 blob URL
    for (const u of createdUrls) { try { URL.revokeObjectURL(u); } catch (e) {} }
    hideLoading();
    setStatus(`加载失败: ${err.message}`);
    console.error('[Viewer] 模型加载失败:', err);
    sendStateToControl({ type: 'model-error', error: err.message });
  }
}

function focusModel(mesh) {
  if (!mesh) return;
  const box = new THREE.Box3().setFromObject(mesh);
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const maxDim = Math.max(size.x, size.y, size.z);
  const dist = maxDim * 1.8 + 10;
  state.controls.target.copy(center);
  state.camera.position.set(center.x, center.y + size.y * 0.3, center.z + dist);
  state.controls.update();
}

function unloadModel(modelId) {
  const idx = state.loadedModels.findIndex(m => m.id === modelId);
  if (idx < 0) return;
  const m = state.loadedModels[idx];

  if (state.poseActive && state.activeModelId === modelId) {
    stopCamera();
  }

  try {
    if (m.helper) { m.helper.remove(m.mesh); }
    state.scene.remove(m.mesh);
    m.mesh.traverse((obj) => {
      if (obj.geometry) obj.geometry.dispose();
      if (obj.material) {
        if (Array.isArray(obj.material)) obj.material.forEach(mt => mt.dispose());
        else obj.material.dispose();
      }
    });
    if (m.createdUrls) {
      for (const u of m.createdUrls) { try { URL.revokeObjectURL(u); } catch (e) {} }
    }
  } catch (e) {}
  state.loadedModels.splice(idx, 1);
  if (state.activeModelId === modelId) {
    state.activeModelId = state.loadedModels.length > 0 ? state.loadedModels[0].id : null;
  }
  sendStateToControl({ type: 'model-unloaded', id: modelId });
}

function getActiveModel() {
  return state.loadedModels.find(m => m.id === state.activeModelId);
}

function clearScene() {
  while (state.loadedModels.length > 0) {
    unloadModel(state.loadedModels[0].id);
  }
}

// ═══════════════════════════════════════════════════════════
//  动作播放
// ═══════════════════════════════════════════════════════════

// payload: { vmdPath, name } 或 { vmdBuffer, name }
async function playVMD(payload) {
  const model = getActiveModel();
  if (!model) { setStatus('请先加载模型'); return; }

  if (state.poseActive) stopCamera();

  let vmdBuffer;
  if (payload.vmdPath) {
    vmdBuffer = await window.electronAPI.readFileArrayBuffer(payload.vmdPath);
  } else if (payload.vmdBuffer) {
    vmdBuffer = payload.vmdBuffer;
  } else {
    setStatus('缺少 VMD 数据');
    return;
  }

  await playVMDOnModel(model, vmdBuffer, payload.name);
  sendStateToControl({ type: 'vmd-playing', name: payload.name });
}

async function playVMDOnModel(model, vmdBuffer, motionName) {
  if (model.helper) {
    try { model.helper.remove(model.mesh); } catch (e) {}
    model.helper = null;
  }

  forceResetModel(model);

  const loader = new MMDLoader();
  const vmdUrl = URL.createObjectURL(new Blob([vmdBuffer], { type: 'application/octet-stream' }));

  const vmd = await new Promise((resolve, reject) => {
    loader.loadAnimation(vmdUrl, model.mesh, resolve, undefined, reject);
  });
  URL.revokeObjectURL(vmdUrl);

  model.vmdBuffer = vmdBuffer;
  model.motionName = motionName;

  forceResetModel(model);

  model.helper = new MMDAnimationHelper({ afterglow: 0 });
  model.helper.add(model.mesh, { animation: vmd, physics: false });
  model.helper.update(0);
  state.clock.getDelta();
  state.isPlaying = true;
}

function forceResetModel(model) {
  if (!model || !model.mesh || !model.mesh.skeleton) return;
  const mesh = model.mesh;
  mesh.pose();
  mesh.updateMatrixWorld(true);
  mesh.skeleton.update();
  if (mesh.skeleton.boneTexture) mesh.skeleton.computeBoneTexture();
  if (mesh.morphTargetInfluences) {
    for (let i = 0; i < mesh.morphTargetInfluences.length; i++) {
      mesh.morphTargetInfluences[i] = 0;
    }
  }
}

// 编译 MPL/TXT 并播放
// payload: { text, name, pairedVmdPath? }
async function compileMpl(payload) {
  const model = getActiveModel();
  if (!model) {
    setStatus('请先加载模型');
    // 必须回传错误，否则控制面板 AI 消息会卡在"正在生成动作…"
    sendStateToControl({ type: 'compile-error', error: '未加载模型' });
    return;
  }

  state.pendingMplText = payload.text;
  state.pendingMplName = payload.name;

  let vmdData;
  try {
    // 优先检测 KFM 格式（AI 生成的紧凑关键帧格式）
    let mplText = payload.text;
    if (isKFM(payload.text)) {
      console.log('[viewer] 检测到 KFM 格式，转换为 MPL...');
      sendStateToControl({ type: 'compile-log', msg: '检测到 KFM 格式，转换为 MPL...' });
      mplText = kfmToMPL(payload.text);
      console.log(`[viewer] KFM → MPL: ${payload.text.length} → ${mplText.length} 字符`);
      sendStateToControl({ type: 'compile-log', msg: `KFM → MPL: ${payload.text.length} → ${mplText.length} 字符` });
    }

    const isMPL = isMPLScript(mplText);
    console.log('[viewer] isMPLScript判定:', isMPL, '文本前100字:', mplText.slice(0, 100));
    sendStateToControl({ type: 'compile-log', msg: `isMPLScript=${isMPL}, 走 ${isMPL ? 'compileMPLToVMD' : 'textToVMD'} 分支` });
    if (isMPL) {
      // 如果提供了配对的原始 VMD 文件，预填充四元数和 IK 骨骼缓存
      // 这样即使用户加载已保存的 MPL 文件，patchVMDQuaternions 和 patchVMDLostBones 也能生效
      if (payload.pairedVmdPath) {
        try {
          const vmdBuffer = await window.electronAPI.readFileArrayBuffer(payload.pairedVmdPath);
          await preloadVMDForPatch(new Uint8Array(vmdBuffer));
          setLastMplText(payload.text);
          sendStateToControl({ type: 'compile-log', msg: `已从配对 VMD 预填充缓存: ${payload.pairedVmdPath.split(/[\\/]/).pop()}` });
        } catch (e) {
          console.warn('[viewer] 预填充 VMD 缓存失败:', e);
          sendStateToControl({ type: 'compile-log', msg: `预填充 VMD 缓存失败: ${e.message}` });
        }
      }
      vmdData = await compileMPLToVMD(mplText);
      // 验证 bezier 是否真的被修复：检查第一帧的前 16 字节
      const vview = new DataView(vmdData.buffer);
      const vcount = vview.getUint32(50, true);
      if (vcount > 0) {
        const b = vmdData.slice(101, 117);
        const x1 = b[0], x2 = b[4], y1 = b[8], y2 = b[12];
        const isLinear = (x1 === y1) && (x2 === y2);
        sendStateToControl({ type: 'compile-log', msg: `compileMPLToVMD: VMD=${vmdData.length}字节, 骨骼帧=${vcount}, bezier首帧=[${[...b].join(',')}], P2=(${x1},${y1})P3=(${x2},${y2}), 线性=${isLinear}` });
      } else {
        sendStateToControl({ type: 'compile-log', msg: `compileMPLToVMD: VMD=${vmdData.length}字节, 骨骼帧=0` });
      }
    } else {
      vmdData = await textToVMD(payload.text);
      sendStateToControl({ type: 'compile-log', msg: `textToVMD 完成, VMD=${vmdData.length}字节 (未应用bezier修复!)` });
    }
  } catch (err) {
    setStatus(`编译失败: ${err.message}`);
    sendStateToControl({ type: 'compile-error', error: err.message });
    return;
  }

  await playVMDOnModel(model, vmdData, payload.name);
  sendStateToControl({ type: 'vmd-playing', name: payload.name });
}

// ═══════════════════════════════════════════════════════════
//  动捕（landmarks 由控制面板通过 IPC 传入）
// ═══════════════════════════════════════════════════════════

// 控制面板启动动捕时通知 viewer 准备 solver
async function startCamera(payload) {
  const model = getActiveModel();
  if (!model || !model.mesh || !model.mesh.skeleton) {
    setStatus('请先加载模型');
    return;
  }

  // 停止动画 helper
  if (model.helper) {
    try { model.helper.remove(model.mesh); } catch (e) {}
  }

  // 禁用 IK
  const mmdData = model.mesh.geometry.userData.MMD;
  if (mmdData && mmdData.iks && mmdData.iks.length > 0) {
    model._savedIKs = mmdData.iks;
    mmdData.iks = [];
  }

  model.helper = new MMDAnimationHelper({ afterglow: 0 });
  model.helper.add(model.mesh, { physics: false });

  model.mesh.pose();
  model.mesh.updateMatrixWorld(true);

  const bones = model.mesh.skeleton.bones;
  state.poseBoneLookup = {};
  for (let i = 0; i < bones.length; i++) {
    state.poseBoneLookup[bones[i].name] = bones[i];
  }
  const boneMap = buildPoseBoneMap(bones);
  for (const [stdName, idx] of Object.entries(boneMap)) {
    if (idx >= 0 && bones[idx]) {
      state.poseBoneLookup[stdName] = bones[idx];
    }
  }

  state.poseSolver = new PoPoSolver();
  state.faceSolver = new FaceBlendshapeSolver({ smoothingFactor: 0.4 });
  state.posePrevBoneQuats = null;
  state.poseCurrBoneQuats = null;
  state.poseBoneByUuid = null;
  state.poseMorphWeights = null;
  state.poseCurrSolveTs = 0;
  state.posePrevSolveTs = 0;
  state.poseLandmarksDirty = false;

  // calibrate
  {
    model.mesh.updateMatrixWorld(true);
    const restWorldPos = {};
    const boneByName = {};
    for (const b of bones) boneByName[b.name] = b;
    for (const name of SOLVER_REST_BONES) {
      const b = boneByName[name];
      if (!b) continue;
      const wp = new THREE.Vector3();
      b.getWorldPosition(wp);
      restWorldPos[name] = { x: wp.x, y: wp.y, z: -wp.z };
    }
    state.poseSolver.calibrateFromPlain(restWorldPos);
  }

  // grant 数据
  state.poseGrants = [];
  state.poseGrantRestQuats = {};
  const mmdGrantData = model.mesh.geometry.userData.MMD;
  if (mmdGrantData && mmdGrantData.grants && mmdGrantData.grants.length > 0) {
    for (const grant of mmdGrantData.grants) {
      if (grant.isLocal || !grant.affectRotation) continue;
      const bone = bones[grant.index];
      const parentBone = bones[grant.parentIndex];
      if (!bone || !parentBone) continue;
      state.poseGrants.push(grant);
      state.poseGrantRestQuats[grant.index] = bone.quaternion.clone();
    }
  }

  state.poseActive = true;
  setStatus('动捕已启动');
}

function stopCamera() {
  state.poseActive = false;
  state.poseLandmarks = null;
  state.poseSolver = null;
  state.faceSolver = null;
  state.poseBoneLookup = null;
  state.poseGrants = null;
  state.poseGrantRestQuats = null;
  state.posePrevBoneQuats = null;
  state.poseCurrBoneQuats = null;
  state.poseBoneByUuid = null;
  state.poseMorphWeights = null;
  state.poseLandmarksDirty = false;

  const model = getActiveModel();

  if (model && model._savedIKs) {
    const mmdData = model.mesh.geometry.userData.MMD;
    if (mmdData) mmdData.iks = model._savedIKs;
    model._savedIKs = null;
  }

  if (model && model.mesh && model.mesh.skeleton) {
    model.mesh.pose();
    model.mesh.updateMatrixWorld(true);
    model.mesh.skeleton.update();
    if (model.mesh.skeleton.boneTexture) model.mesh.skeleton.computeBoneTexture();
    if (model.mesh.morphTargetInfluences) {
      for (let i = 0; i < model.mesh.morphTargetInfluences.length; i++) {
        model.mesh.morphTargetInfluences[i] = 0;
      }
    }
  }

  setStatus('动捕已停止');
}

// 接收控制面板传来的 landmarks（实时流）
function onLandmarks(landmarks) {
  state.poseLandmarks = landmarks;
  state.poseLandmarksDirty = true;
}

function solvePose(model) {
  if (!model || !model.mesh || !model.mesh.skeleton || !state.poseSolver) return;
  const landmarks = state.poseLandmarks;
  if (!landmarks || !landmarks.poseWorldLandmarks) return;

  const solverInput = {
    poseWorldLandmarks: landmarks.poseWorldLandmarks || [],
    leftHandWorldLandmarks: landmarks.leftHandWorldLandmarks || [],
    rightHandWorldLandmarks: landmarks.rightHandWorldLandmarks || [],
  };

  const boneStates = state.poseSolver.solve(solverInput);
  const lookup = state.poseBoneLookup;
  const now = performance.now();

  if (!state.poseCurrBoneQuats) {
    state.poseCurrBoneQuats = {};
    state.posePrevBoneQuats = {};
  }
  for (const uuid of Object.keys(state.poseCurrBoneQuats)) {
    state.posePrevBoneQuats[uuid] = state.poseCurrBoneQuats[uuid].clone();
  }

  const _q = new THREE.Quaternion();
  for (const bs of boneStates) {
    const bone = lookup[bs.name];
    if (!bone) continue;
    if (bone.name.includes('ＩＫ') || bone.name.includes('IK')) continue;
    const r = bs.rotation;
    _q.set(-r.x, -r.y, r.z, r.w);
    if (!state.poseCurrBoneQuats[bone.uuid]) {
      state.posePrevBoneQuats[bone.uuid] = _q.clone();
    }
    state.poseCurrBoneQuats[bone.uuid] = _q.clone();
  }

  if (state.faceSolver && landmarks.faceLandmarks && landmarks.faceLandmarks[0]) {
    const faceResult = state.faceSolver.solve(landmarks.faceLandmarks[0]);
    if (faceResult.boneStates && faceResult.boneStates.length > 0) {
      for (const bs of faceResult.boneStates) {
        const bone = lookup[bs.name];
        if (!bone) continue;
        const r = bs.rotation;
        _q.set(-r.x, -r.y, r.z, r.w);
        if (!state.poseCurrBoneQuats[bone.uuid]) {
          state.posePrevBoneQuats[bone.uuid] = _q.clone();
        }
        state.poseCurrBoneQuats[bone.uuid] = _q.clone();
      }
    }
    state.poseMorphWeights = faceResult.morphWeights || null;
  } else {
    state.poseMorphWeights = null;
  }

  state.posePrevSolveTs = state.poseCurrSolveTs || now;
  state.poseCurrSolveTs = now;
}

function applyPoseToMesh(model) {
  if (!model || !model.mesh || !model.mesh.skeleton) return;
  if (!state.poseCurrBoneQuats) return;

  const lookup = state.poseBoneLookup;
  if (!lookup) return;

  if (!state.poseBoneByUuid) {
    state.poseBoneByUuid = {};
    for (const b of model.mesh.skeleton.bones) {
      state.poseBoneByUuid[b.uuid] = b;
    }
  }

  const now = performance.now();
  const elapsed = now - state.poseCurrSolveTs;
  const tweenMs = 33;
  let t = elapsed / tweenMs;
  if (t < 0) t = 0;
  if (t > 1) t = 1;

  const _q = new THREE.Quaternion();
  const boneByUuid = state.poseBoneByUuid;

  for (const uuid of Object.keys(state.poseCurrBoneQuats)) {
    const bone = boneByUuid[uuid];
    if (!bone) continue;
    const prev = state.posePrevBoneQuats[uuid];
    const curr = state.poseCurrBoneQuats[uuid];
    if (!prev || !curr) continue;
    _q.copy(prev).slerp(curr, t);
    bone.quaternion.copy(_q);
    bone.matrixWorldNeedsUpdate = true;
  }

  // grant 骨骼
  if (state.poseGrants && state.poseGrants.length > 0) {
    const skeletonBones = model.mesh.skeleton.bones;
    for (const grant of state.poseGrants) {
      const bone = skeletonBones[grant.index];
      const parentBone = skeletonBones[grant.parentIndex];
      if (!bone || !parentBone) continue;
      const restQuat = state.poseGrantRestQuats[grant.index];
      _q.identity().slerp(parentBone.quaternion, grant.ratio);
      bone.quaternion.copy(restQuat).multiply(_q);
      bone.matrixWorldNeedsUpdate = true;
    }
  }

  // morph
  const mw = state.poseMorphWeights;
  if (mw && model.mesh.morphTargetDictionary && model.mesh.morphTargetInfluences) {
    const dict = model.mesh.morphTargetDictionary;
    const infl = model.mesh.morphTargetInfluences;
    const setMorph = (name, weight) => {
      const idx = dict[name];
      if (idx !== undefined) infl[idx] = weight;
    };
    setMorph('まばたき', mw.まばたき);
    setMorph('ウィンク', mw.ウィンク);
    setMorph('ウィンク右', mw.ウィンク右);
    setMorph('あ', mw.あ);
    setMorph('ワ', mw.ワ);
  }

  const allBones = model.mesh.skeleton.bones;
  for (const bone of allBones) {
    if (!bone.parent || !bone.parent.isBone) {
      bone.updateMatrixWorld(true);
    }
  }
  model.mesh.skeleton.update();
  if (model.mesh.skeleton.boneTexture) {
    model.mesh.skeleton.computeBoneTexture();
  }
}

// ═══════════════════════════════════════════════════════════
//  其他指令处理
// ═══════════════════════════════════════════════════════════

function togglePlay() {
  state.isPlaying = !state.isPlaying;
  sendStateToControl({ type: 'play-state', isPlaying: state.isPlaying });
}

function resetCamera() {
  const model = getActiveModel();
  if (model) focusModel(model.mesh);
  else {
    state.camera.position.set(0, 18, 40);
    state.controls.target.set(0, 12, 0);
    state.controls.update();
  }
}

function setSpeed(speed) {
  for (const m of state.loadedModels) {
    if (m.helper) m.helper.enabled = state.isPlaying;
  }
}

function takeSnapshot() {
  const model = getActiveModel();
  if (!model) return;
  state.renderer.render(state.scene, state.camera);
  const dataUrl = state.renderer.domElement.toDataURL('image/png');
  // 通过主进程保存
  if (window.electronAPI) {
    // 把 dataUrl 转成 base64 数据传回控制面板
    sendStateToControl({ type: 'snapshot', dataUrl, name: `snapshot_${Date.now()}.png` });
  }
}

// ═══════════════════════════════════════════════════════════
//  IPC 指令路由
// ═══════════════════════════════════════════════════════════

function bindIPC() {
  const api = window.electronAPI;
  if (!api) {
    console.error('[Viewer] electronAPI 未注入');
    return;
  }

  // 模型加载
  api.onCommand('viewer:load-model', (payload) => loadModelFromPath(payload));
  api.onCommand('viewer:unload-model', (payload) => unloadModel(payload.id));
  api.onCommand('viewer:clear-scene', () => clearScene());

  // 动作
  api.onCommand('viewer:play-vmd', (payload) => playVMD(payload));
  api.onCommand('viewer:compile-mpl', (payload) => compileMpl(payload));

  // 动捕
  api.onCommand('viewer:start-camera', (payload) => startCamera(payload));
  api.onCommand('viewer:stop-camera', () => stopCamera());
  api.onCommand('viewer:calibrate', () => { resetCalibration(); });
  api.onCommand('viewer:set-mirror', (payload) => setMirrorMode(payload.mirror));
  api.onCommand('viewer:landmarks', (landmarks) => onLandmarks(landmarks));
  api.onCommand('viewer:toggle-face', (payload) => { /* TODO */ });
  api.onCommand('viewer:toggle-hands', (payload) => { /* TODO */ });

  // 播放控制
  api.onCommand('viewer:toggle-play', () => togglePlay());
  api.onCommand('viewer:reset-camera', () => resetCamera());
  api.onCommand('viewer:set-speed', (payload) => setSpeed(payload.speed));
  api.onCommand('viewer:snapshot', () => takeSnapshot());

  // 通知主进程 viewer 已就绪
  api.notifyReady();
  console.log('[Viewer] IPC 已就绪');
}

// ═══════════════════════════════════════════════════════════
//  窗口拖动
// ═══════════════════════════════════════════════════════════

function bindWindowControls() {
  const closeBtn = $('#btn-close');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      window.close();
    });
  }
}

// ═══════════════════════════════════════════════════════════
//  启动
// ═══════════════════════════════════════════════════════════

function init() {
  initScene();
  bindIPC();
  bindWindowControls();
  setMirrorMode(true);
  console.log('[Viewer] 初始化完成');
}

init();
