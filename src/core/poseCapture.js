import * as THREE from 'three';
import { OneEuroFilterVec3, OneEuroFilterQuat } from '../utils/oneEuroFilter.js';

// ═══════════════════════════════════════════════════════════
//  MediaPipe → MMD 骨骼映射
//  核心改进：
//  1. 骨骼名模糊匹配（支持英文名/别名）
//  2. 正确的FK链（预计算restWorldQuats）
//  3. 详细调试日志
//  4. One-Euro滤波 + 四元数slerp平滑
// ═══════════════════════════════════════════════════════════

const MP = {
  NOSE: 0, LEFT_EAR: 7, RIGHT_EAR: 8,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
};

const VIS_THRESH = 0.3;
const SCALE = 2.0;

// ── 骨骼名别名表（用于模糊匹配） ──
const BONE_ALIASES = {
  '下半身': ['下半身', 'lower_body', 'LowerBody', 'lower body', 'hips', 'Hips', 'pelvis', 'Pelvis'],
  '上半身': ['上半身', 'upper_body', 'UpperBody', 'upper body', 'spine', 'Spine', 'chest', 'Chest'],
  '首': ['首', 'neck', 'Neck'],
  '頭': ['頭', 'head', 'Head'],
  '右腕': ['右腕', 'right_arm', 'RightArm', 'right arm', 'rightUpperArm'],
  '左腕': ['左腕', 'left_arm', 'LeftArm', 'left arm', 'leftUpperArm'],
  '右ひじ': ['右ひじ', 'right_elbow', 'RightElbow', 'right elbow', 'rightForeArm', 'rightLowerArm'],
  '左ひじ': ['左ひじ', 'left_elbow', 'LeftElbow', 'left elbow', 'leftForeArm', 'leftLowerArm'],
  '右足': ['右足', 'right_leg', 'RightLeg', 'right leg', 'rightUpperLeg', 'rightThigh'],
  '左足': ['左足', 'left_leg', 'LeftLeg', 'left leg', 'leftUpperLeg', 'leftThigh'],
  '右ひざ': ['右ひざ', 'right_knee', 'RightKnee', 'right knee', 'rightLowerLeg', 'rightShin'],
  '左ひざ': ['左ひざ', 'left_knee', 'LeftKnee', 'left knee', 'leftLowerLeg', 'leftShin'],
  '右足首': ['右足首', 'right_ankle', 'RightAnkle', 'right ankle', 'rightFoot'],
  '左足首': ['左足首', 'left_ankle', 'LeftAnkle', 'left ankle', 'leftFoot'],
};

// 构建反向查找表：别名 → 标准名
const _aliasToStandard = {};
for (const [std, aliases] of Object.entries(BONE_ALIASES)) {
  for (const a of aliases) _aliasToStandard[a.toLowerCase()] = std;
}

/**
 * 骨骼名模糊匹配：将模型骨骼名映射到标准MMD骨骼名
 */
function buildBoneMap(bones) {
  const boneMap = {};
  const modelNames = bones.map(b => b.name);
  const modelNamesLower = modelNames.map(n => n.toLowerCase());

  for (const [stdName, aliases] of Object.entries(BONE_ALIASES)) {
    let found = -1;
    // 1. 精确匹配
    for (let i = 0; i < modelNames.length; i++) {
      if (modelNames[i] === stdName) { found = i; break; }
    }
    // 2. 别名匹配
    if (found < 0) {
      for (const alias of aliases) {
        for (let i = 0; i < modelNames.length; i++) {
          if (modelNames[i] === alias) { found = i; break; }
        }
        if (found >= 0) break;
      }
    }
    // 3. 大小写忽略
    if (found < 0) {
      const stdLower = stdName.toLowerCase();
      for (let i = 0; i < modelNames.length; i++) {
        if (modelNamesLower[i] === stdLower) { found = i; break; }
      }
    }
    // 4. 别名大小写忽略
    if (found < 0) {
      for (const alias of aliases) {
        const al = alias.toLowerCase();
        for (let i = 0; i < modelNames.length; i++) {
          if (modelNamesLower[i] === al) { found = i; break; }
        }
        if (found >= 0) break;
      }
    }
    // 5. 包含匹配（排除 IK 骨骼：避免「左足」误匹配到「左足ＩＫ」，
    //    IK 骨骼旋转会驱动 IK 链把双腿拉到一起 → 双腿并拢一起动）
    if (found < 0) {
      for (let i = 0; i < modelNames.length; i++) {
        const nl = modelNamesLower[i];
        if (nl.includes('ＩＫ') || nl.includes('ik') || nl.includes('IK')) continue;
        if (nl.includes(stdName.toLowerCase()) || stdName.toLowerCase().includes(nl)) {
          found = i; break;
        }
      }
    }

    if (found >= 0) {
      boneMap[stdName] = found;
    }
  }

  return boneMap;
}

// ── 滤波器 ──
let _lmFilters = null;
let _quatFilters = {};

function ensureLmFilters() {
  if (!_lmFilters) {
    _lmFilters = [];
    for (let i = 0; i < 33; i++) _lmFilters.push(new OneEuroFilterVec3({ minCutoff: 1.0, beta: 0.05 }));
  }
  return _lmFilters;
}

function getQF(name) {
  if (!_quatFilters[name]) _quatFilters[name] = new OneEuroFilterQuat({ minCutoff: 1.5, beta: 0.1 });
  return _quatFilters[name];
}

function resetFilters() { _lmFilters = null; _quatFilters = {}; }

// ── 校准 ──
let _calib = null;
let _mirror = true;
let _boneMapCache = null;
let _debugCount = 0;

function toWorld(p) {
  return new THREE.Vector3(
    (p.x - 0.5) * SCALE,
    (0.5 - p.y) * SCALE,
    -p.z * SCALE * 0.5
  );
}

function isVis(p) { return p && (p.visibility === undefined || p.visibility >= VIS_THRESH); }

function norm(v) {
  const l = v.length();
  return l > 1e-6 ? v.clone().divideScalar(l) : new THREE.Vector3(0, 1, 0);
}

function makeBasisQuat(x, y, z) {
  const m = new THREE.Matrix4().makeBasis(x, y, z);
  return new THREE.Quaternion().setFromRotationMatrix(m);
}

function calibrate(landmarks) {
  const lSh = toWorld(landmarks[MP.LEFT_SHOULDER]);
  const rSh = toWorld(landmarks[MP.RIGHT_SHOULDER]);
  const lHi = toWorld(landmarks[MP.LEFT_HIP]);
  const rHi = toWorld(landmarks[MP.RIGHT_HIP]);
  const lEl = toWorld(landmarks[MP.LEFT_ELBOW]);
  const rEl = toWorld(landmarks[MP.RIGHT_ELBOW]);
  const lWr = toWorld(landmarks[MP.LEFT_WRIST]);
  const rWr = toWorld(landmarks[MP.RIGHT_WRIST]);
  const lKn = toWorld(landmarks[MP.LEFT_KNEE]);
  const rKn = toWorld(landmarks[MP.RIGHT_KNEE]);
  const lAn = toWorld(landmarks[MP.LEFT_ANKLE]);
  const rAn = toWorld(landmarks[MP.RIGHT_ANKLE]);
  const nose = toWorld(landmarks[MP.NOSE]);

  const shoulderC = new THREE.Vector3().addVectors(lSh, rSh).multiplyScalar(0.5);
  const hipC = new THREE.Vector3().addVectors(lHi, rHi).multiplyScalar(0.5);

  const shoulderLine = norm(new THREE.Vector3().subVectors(lSh, rSh));
  const hipLine = norm(new THREE.Vector3().subVectors(lHi, rHi));
  const spineDir = norm(new THREE.Vector3().subVectors(shoulderC, hipC));

  const spineZ = norm(new THREE.Vector3().crossVectors(shoulderLine, spineDir));
  const hipZ = norm(new THREE.Vector3().crossVectors(hipLine, spineDir));

  _calib = {
    shoulderLine, hipLine, spineDir,
    spineBasis: makeBasisQuat(shoulderLine, spineDir, spineZ),
    hipBasis: makeBasisQuat(hipLine, spineDir, hipZ),
    noseDir: norm(new THREE.Vector3().subVectors(nose, shoulderC)),
    lArmDir: norm(new THREE.Vector3().subVectors(lEl, lSh)),
    rArmDir: norm(new THREE.Vector3().subVectors(rEl, rSh)),
    lForeDir: norm(new THREE.Vector3().subVectors(lWr, lEl)),
    rForeDir: norm(new THREE.Vector3().subVectors(rWr, rEl)),
    lLegDir: norm(new THREE.Vector3().subVectors(lKn, lHi)),
    rLegDir: norm(new THREE.Vector3().subVectors(rKn, rHi)),
    lShinDir: norm(new THREE.Vector3().subVectors(lAn, lKn)),
    rShinDir: norm(new THREE.Vector3().subVectors(rAn, rKn)),
  };

  console.log('[Pose] 校准完成');
  console.log('[Pose] spineDir:', spineDir.toArray().map(v => v.toFixed(3)));
}

export function isCalibrated() { return !!_calib; }
export function resetCalibration() { _calib = null; resetFilters(); _debugCount = 0; }
export function setMirrorMode(m) { _mirror = m; }
export function getMirrorMode() { return _mirror; }

// ═══════════════════════════════════════════════════════════
//  求解器
// ═══════════════════════════════════════════════════════════

export function solvePoseToBones(landmarks, boneMap, restWorldQuats, timestamp) {
  if (!landmarks || landmarks.length < 33) return {};

  // 构建骨骼映射（带模糊匹配），缓存
  if (!_boneMapCache || _boneMapCache._boneCount !== boneMap._boneCount) {
    // boneMap 是从 main.js 传入的 {name: idx}，我们需要重建
    // 实际上 main.js 传入的是简单映射，我们在这里用骨骼数组重建
    // 但 main.js 传入的不是骨骼数组... 让我们直接用传入的 boneMap
    _boneMapCache = boneMap;
  }

  if (!_calib) { calibrate(landmarks); }
  if (!_calib) return {};

  const t = timestamp || performance.now() / 1000;
  const c = _calib;
  const results = {};
  const targetWorldQ = {};

  // ── 滤波 landmarks ──
  const filters = ensureLmFilters();
  const fl = [];
  for (let i = 0; i < landmarks.length; i++) {
    const p = landmarks[i];
    if (!isVis(p)) {
      if (filters[i]._fx._x !== null) {
        fl.push({ x: filters[i]._fx._x, y: filters[i]._fy._x, z: filters[i]._fz._x, visibility: 0 });
      } else {
        fl.push(p);
      }
      continue;
    }
    fl.push(filters[i].filter(p, t));
  }

  // ── 关键点 ──
  const lSh = toWorld(fl[MP.LEFT_SHOULDER]);
  const rSh = toWorld(fl[MP.RIGHT_SHOULDER]);
  const lEl = toWorld(fl[MP.LEFT_ELBOW]);
  const rEl = toWorld(fl[MP.RIGHT_ELBOW]);
  const lWr = toWorld(fl[MP.LEFT_WRIST]);
  const rWr = toWorld(fl[MP.RIGHT_WRIST]);
  const lHi = toWorld(fl[MP.LEFT_HIP]);
  const rHi = toWorld(fl[MP.RIGHT_HIP]);
  const lKn = toWorld(fl[MP.LEFT_KNEE]);
  const rKn = toWorld(fl[MP.RIGHT_KNEE]);
  const lAn = toWorld(fl[MP.LEFT_ANKLE]);
  const rAn = toWorld(fl[MP.RIGHT_ANKLE]);
  const nose = toWorld(fl[MP.NOSE]);

  const shoulderC = new THREE.Vector3().addVectors(lSh, rSh).multiplyScalar(0.5);
  const hipC = new THREE.Vector3().addVectors(lHi, rHi).multiplyScalar(0.5);

  // ── 当前方向 ──
  const curSpineDir = norm(new THREE.Vector3().subVectors(shoulderC, hipC));
  const curShoulderLine = norm(new THREE.Vector3().subVectors(lSh, rSh));
  const curHipLine = norm(new THREE.Vector3().subVectors(lHi, rHi));

  // ── 辅助函数：方向向量骨骼求解 ──
  function solveDir(name, calibDir, curDir, parentName) {
    if (boneMap[name] === undefined) return;
    const delta = new THREE.Quaternion().setFromUnitVectors(calibDir, curDir);
    const restW = restWorldQuats[name] || new THREE.Quaternion();
    const tgtW = delta.clone().multiply(restW);
    const parentTgtW = parentName ? (targetWorldQ[parentName] || restWorldQuats[parentName] || new THREE.Quaternion()) : new THREE.Quaternion();
    const localQ = parentTgtW.clone().invert().multiply(tgtW);
    results[name] = { idx: boneMap[name], quat: getQF(name).filter(localQ, t) };
    targetWorldQ[name] = tgtW;
  }

  // ── 辅助函数：正交基骨骼求解 ──
  function solveBasis(name, calibBasis, curBasis, parentName) {
    if (boneMap[name] === undefined) return;
    const delta = calibBasis.clone().invert().multiply(curBasis);
    const restW = restWorldQuats[name] || new THREE.Quaternion();
    const tgtW = delta.clone().multiply(restW);
    const parentTgtW = parentName ? (targetWorldQ[parentName] || restWorldQuats[parentName] || new THREE.Quaternion()) : new THREE.Quaternion();
    const localQ = parentTgtW.clone().invert().multiply(tgtW);
    results[name] = { idx: boneMap[name], quat: getQF(name).filter(localQ, t) };
    targetWorldQ[name] = tgtW;
  }

  // ═══════════════════════════════════════════════════════════
  //  按骨骼层级顺序求解
  // ═══════════════════════════════════════════════════════════

  // ── 下半身 ──
  const curHipZ = norm(new THREE.Vector3().crossVectors(curHipLine, curSpineDir));
  const curHipBasis = makeBasisQuat(curHipLine, curSpineDir, curHipZ);
  solveBasis('下半身', c.hipBasis, curHipBasis, null);

  // ── 上半身 ──
  const curSpineZ = norm(new THREE.Vector3().crossVectors(curShoulderLine, curSpineDir));
  const curSpineBasis = makeBasisQuat(curShoulderLine, curSpineDir, curSpineZ);
  solveBasis('上半身', c.spineBasis, curSpineBasis, '下半身');

  // ── 首 ──
  const curNoseDir = norm(new THREE.Vector3().subVectors(nose, shoulderC));
  solveDir('首', c.noseDir, curNoseDir, '上半身');

  // ── 頭 ──
  if (boneMap['頭'] !== undefined) {
    const neckLocalQ = results['首'] ? results['首'].quat : new THREE.Quaternion();
    const headLocalQ = new THREE.Quaternion().slerpQuaternions(new THREE.Quaternion(), neckLocalQ, 0.5);
    results['頭'] = { idx: boneMap['頭'], quat: getQF('頭').filter(headLocalQ, t) };
    const parentTgtW = targetWorldQ['首'] || targetWorldQ['上半身'] || new THREE.Quaternion();
    targetWorldQ['頭'] = parentTgtW.clone().multiply(headLocalQ);
  }

  // ── 四肢 ──
  const R = _mirror; // true=镜像: MP left → MMD 右

  // 右腕 = MP左臂（镜像）
  solveDir('右腕', R ? c.lArmDir : c.rArmDir,
    norm(new THREE.Vector3().subVectors(R ? lEl : rEl, R ? lSh : rSh)), '上半身');
  // 左腕 = MP右臂（镜像）
  solveDir('左腕', R ? c.rArmDir : c.lArmDir,
    norm(new THREE.Vector3().subVectors(R ? rEl : lEl, R ? rSh : lSh)), '上半身');
  // 右ひじ
  solveDir('右ひじ', R ? c.lForeDir : c.rForeDir,
    norm(new THREE.Vector3().subVectors(R ? lWr : rWr, R ? lEl : rEl)), '右腕');
  // 左ひじ
  solveDir('左ひじ', R ? c.rForeDir : c.lForeDir,
    norm(new THREE.Vector3().subVectors(R ? rWr : lWr, R ? rEl : lEl)), '左腕');

  // 右足 = MP左腿（镜像）
  solveDir('右足', R ? c.lLegDir : c.rLegDir,
    norm(new THREE.Vector3().subVectors(R ? lKn : rKn, R ? lHi : rHi)), '下半身');
  // 左足 = MP右腿（镜像）
  solveDir('左足', R ? c.rLegDir : c.lLegDir,
    norm(new THREE.Vector3().subVectors(R ? rKn : lKn, R ? rHi : lHi)), '下半身');
  // 右ひざ
  solveDir('右ひざ', R ? c.lShinDir : c.rShinDir,
    norm(new THREE.Vector3().subVectors(R ? lAn : rAn, R ? lKn : rKn)), '右足');
  // 左ひざ
  solveDir('左ひざ', R ? c.rShinDir : c.lShinDir,
    norm(new THREE.Vector3().subVectors(R ? rAn : lAn, R ? rKn : lKn)), '左足');

  // 足首保持 rest
  if (boneMap['右足首'] !== undefined) {
    const restLocal = restWorldQuats['右足首'] ? (targetWorldQ['右ひざ'] ?
      targetWorldQ['右ひざ'].clone().invert().multiply(restWorldQuats['右足首']) : new THREE.Quaternion()) : new THREE.Quaternion();
    results['右足首'] = { idx: boneMap['右足首'], quat: getQF('右足首').filter(restLocal, t) };
  }
  if (boneMap['左足首'] !== undefined) {
    const restLocal = restWorldQuats['左足首'] ? (targetWorldQ['左ひざ'] ?
      targetWorldQ['左ひざ'].clone().invert().multiply(restWorldQuats['左足首']) : new THREE.Quaternion()) : new THREE.Quaternion();
    results['左足首'] = { idx: boneMap['左足首'], quat: getQF('左足首').filter(restLocal, t) };
  }

  // ── 调试日志（前5帧） ──
  if (_debugCount < 5) {
    _debugCount++;
    const solved = Object.keys(results);
    const allExpected = ['下半身', '上半身', '首', '頭', '右腕', '左腕', '右ひじ', '左ひじ', '右足', '左足', '右ひざ', '左ひざ'];
    const missing = allExpected.filter(n => boneMap[n] === undefined);
    console.log(`[Pose] 帧${_debugCount}: 求解 ${solved.length} 骨骼: ${solved.join(', ')}`);
    if (missing.length) console.warn(`[Pose] 模型缺少骨骼: ${missing.join(', ')}`);
    if (_debugCount === 1 && boneMap['下半身'] !== undefined) {
      const restW = restWorldQuats['下半身'];
      console.log('[Pose] 下半身 restWorldQuat:', restW ? [restW.x.toFixed(3), restW.y.toFixed(3), restW.z.toFixed(3), restW.w.toFixed(3)] : 'null');
    }
  }

  return results;
}

/**
 * 构建骨骼映射表（带模糊匹配）
 * @param {Array} bones - mesh.skeleton.bones
 * @returns {Object} { standardName: boneIndex }
 */
export function buildPoseBoneMap(bones) {
  const map = buildBoneMap(bones);
  console.log('[Pose] 骨骼映射:', Object.fromEntries(
    Object.entries(map).map(([k, v]) => [k, `${v}(${bones[v].name})`])
  ));
  return map;
}

// ═══════════════════════════════════════════════════════════
//  MediaPipe Tasks Vision 初始化
// ═══════════════════════════════════════════════════════════

let _poseLandmarker = null;

async function ensurePoseLandmarker() {
  if (_poseLandmarker) return _poseLandmarker;
  const { PoseLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  );
  _poseLandmarker = await PoseLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
      delegate: 'GPU',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
  });
  console.log('[Pose] PoseLandmarker 初始化完成');
  return _poseLandmarker;
}

export async function initPoseCapture(videoEl, onResults, onStatus) {
  const status = (msg) => { console.log('[Pose]', msg); if (onStatus) onStatus(msg); };

  status('加载姿态检测模型...');
  let landmarker;
  try { landmarker = await ensurePoseLandmarker(); }
  catch (err) { throw new Error('MediaPipe 初始化失败: ' + (err.message || err)); }

  status('打开摄像头...');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } }, audio: false,
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('摄像头权限被拒绝');
    if (err.name === 'NotFoundError') throw new Error('未找到摄像头设备');
    if (err.name === 'NotReadableError') throw new Error('摄像头被其他应用占用');
    throw new Error(`摄像头访问失败(${err.name}): ${err.message}`);
  }

  videoEl.srcObject = stream;
  await new Promise(r => { videoEl.onloadedmetadata = r; });
  await videoEl.play();
  await new Promise(r => { if (videoEl.readyState >= 2) r(); else videoEl.onloadeddata = r; });

  console.log('[Pose] 摄像头已启动:', videoEl.videoWidth, 'x', videoEl.videoHeight);
  status('摄像头已启动，开始检测...');

  let running = true;
  let lastTs = -1;

  function detect() {
    if (!running) return;
    if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
      const now = performance.now();
      if (now > lastTs) {
        lastTs = now;
        try {
          const result = landmarker.detectForVideo(videoEl, Math.floor(now));
          if (result.landmarks && result.landmarks.length > 0) {
            onResults(result.landmarks[0].map(lm => ({
              x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility || 1,
            })));
          } else {
            onResults(null);
          }
        } catch (e) { /* skip */ }
      }
    }
    if (running) requestAnimationFrame(detect);
  }
  requestAnimationFrame(detect);

  return {
    stop: () => {
      running = false;
      stream.getTracks().forEach(t => t.stop());
      resetFilters();
      resetCalibration();
      _boneMapCache = null;
    },
  };
}

export function drawPoseCanvas(ctx, landmarks, w, h, videoEl) {
  ctx.clearRect(0, 0, w, h);
  if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
    ctx.save();
    ctx.translate(w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(videoEl, 0, 0, w, h);
    ctx.restore();
  }
  if (!landmarks) return;
  const conns = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24],[23,25],[25,27],[24,26],[26,28]];
  const mx = l => l ? (1 - l.x) * w : 0;
  const my = l => l ? l.y * h : 0;
  ctx.strokeStyle = '#7c5cfc'; ctx.lineWidth = 3;
  ctx.beginPath();
  for (const [a, b] of conns) {
    if (!landmarks[a] || !landmarks[b]) continue;
    ctx.moveTo(mx(landmarks[a]), my(landmarks[a]));
    ctx.lineTo(mx(landmarks[b]), my(landmarks[b]));
  }
  ctx.stroke();
  ctx.fillStyle = '#f09393';
  for (let i = 0; i < landmarks.length; i++) {
    const l = landmarks[i];
    if (!l || (l.visibility !== undefined && l.visibility < VIS_THRESH)) continue;
    ctx.beginPath(); ctx.arc(mx(l), my(l), 4, 0, Math.PI * 2); ctx.fill();
  }
}
