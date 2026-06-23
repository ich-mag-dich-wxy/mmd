import * as THREE from 'three';

// ═══════════════════════════════════════════════════════════
//  MediaPipe Tasks Vision → MMD 骨骼映射
//  使用 2D 角度 + 欧拉角方案（比 3D 向量旋转更稳定）
//  原理：MediaPipe 的 x/y 精度高，z 精度低
//        所以用 x/y 计算主旋转角，z 做辅助
// ═══════════════════════════════════════════════════════════

const MP = {
  NOSE: 0,
  LEFT_SHOULDER: 11, RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13, RIGHT_ELBOW: 14,
  LEFT_WRIST: 15, RIGHT_WRIST: 16,
  LEFT_HIP: 23, RIGHT_HIP: 24,
  LEFT_KNEE: 25, RIGHT_KNEE: 26,
  LEFT_ANKLE: 27, RIGHT_ANKLE: 28,
};

let _landmarks = null;

function lm(idx) {
  return _landmarks && _landmarks[idx] ? _landmarks[idx] : null;
}

function avg(idxA, idxB) {
  const a = lm(idxA), b = lm(idxB);
  if (!a || !b) return null;
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
}

// ── 角度计算 ──
// 以"向下"为 0，顺时针为正（atan2(dx, dy)，MP y 向下为正）
// 返回 [-π, π]
function angleFromDown(from, to) {
  if (!from || !to) return 0;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.atan2(dx, dy);
}

// 以"向上"为 0
function angleFromUp(from, to) {
  if (!from || !to) return 0;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  return Math.atan2(dx, -dy);
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// ── 平滑滤波 ──
const _smooth = {}; // boneName → { value, velocity }
const SMOOTH = 0.2; // 越小越平滑

function smoothValue(name, target) {
  const s = _smooth[name];
  if (!s) {
    _smooth[name] = { value: target };
    return target;
  }
  s.value += (target - s.value) * SMOOTH;
  return s.value;
}

function resetSmoothing() {
  for (const k in _smooth) delete _smooth[k];
}

// ── 从欧拉角创建四元数 ──
function quatFromEuler(x, y, z) {
  return new THREE.Quaternion().setFromEuler(new THREE.Euler(x, y, z, 'XYZ'));
}

// ═══════════════════════════════════════════════════════════
//  骨骼求解
//  MP left = MMD 右（摄像头镜像）
// ═══════════════════════════════════════════════════════════

export function solvePoseToBones(landmarks, boneMap) {
  _landmarks = landmarks;
  const results = {};

  const nose = lm(MP.NOSE);
  const lSh = lm(MP.LEFT_SHOULDER), rSh = lm(MP.RIGHT_SHOULDER);
  const lEl = lm(MP.LEFT_ELBOW), rEl = lm(MP.RIGHT_ELBOW);
  const lWr = lm(MP.LEFT_WRIST), rWr = lm(MP.RIGHT_WRIST);
  const lHi = lm(MP.LEFT_HIP), rHi = lm(MP.RIGHT_HIP);
  const lKn = lm(MP.LEFT_KNEE), rKn = lm(MP.RIGHT_KNEE);
  const lAn = lm(MP.LEFT_ANKLE), rAn = lm(MP.RIGHT_ANKLE);

  const shoulderC = avg(MP.LEFT_SHOULDER, MP.RIGHT_SHOULDER);
  const hipC = avg(MP.LEFT_HIP, MP.RIGHT_HIP);

  // ── 上半身：前倾/后仰 + 左右扭转 ──
  if (shoulderC && hipC && boneMap['上半身'] !== undefined) {
    // 前倾：肩相对于髋向前（z 增大）
    const dz = shoulderC.z - hipC.z;
    const leanX = clamp(dz * 3.0, -0.5, 0.5);

    // 左右扭转：肩连线与髋连线的角度差
    const shoulderAngle = lSh && rSh ? Math.atan2(lSh.y - rSh.y, lSh.x - rSh.x) : 0;
    const hipAngle = lHi && rHi ? Math.atan2(lHi.y - rHi.y, lHi.x - rHi.x) : 0;
    const twistY = clamp((shoulderAngle - hipAngle) * 0.5, -0.6, 0.6);

    results['上半身'] = {
      idx: boneMap['上半身'],
      quat: quatFromEuler(smoothValue('上半身_x', leanX), smoothValue('上半身_y', twistY), 0),
    };
  }

  // ── 首/頭：左右转头 + 点头 ──
  if (nose && shoulderC) {
    // 左右转头：鼻相对于肩中心的水平偏移
    const dx = nose.x - shoulderC.x;
    const shoulderWidth = lSh && rSh ? Math.abs(lSh.x - rSh.x) : 0.3;
    const turnY = clamp(dx / shoulderWidth * 0.8, -0.8, 0.8);

    // 点头：鼻相对于肩中心的垂直偏移
    const dy = nose.y - shoulderC.y;
    const nodX = clamp(-dy * 1.5, -0.5, 0.5);

    if (boneMap['首'] !== undefined) {
      results['首'] = {
        idx: boneMap['首'],
        quat: quatFromEuler(smoothValue('首_x', nodX), smoothValue('首_y', turnY), 0),
      };
    }
    if (boneMap['頭'] !== undefined) {
      results['頭'] = {
        idx: boneMap['頭'],
        quat: quatFromEuler(smoothValue('頭_x', nodX * 0.5), smoothValue('頭_y', turnY * 0.5), 0),
      };
    }
  }

  // ── 右腕（MMD右 = MP左）：左肩→左肘 ──
  // 大臂：Z轴旋转 = 手臂在身体平面内的角度（侧抬）
  //       X轴旋转 = 前后摆动（用 z 深度）
  if (lSh && lEl && boneMap['右腕'] !== undefined) {
    // 侧抬角度：0=下垂, π/2=水平侧抬
    const sideAngle = angleFromDown(lSh, lEl);
    // 映射到 Z 轴：MMD 右臂侧抬 = 负 Z 旋转（右手系）
    const rz = clamp(-sideAngle, -Math.PI * 0.9, Math.PI * 0.9);

    // 前后摆动：肘相对于肩的 z 差
    const dz = lEl.z - lSh.z;
    const rx = clamp(dz * 2.5, -1.2, 1.2);

    results['右腕'] = {
      idx: boneMap['右腕'],
      quat: quatFromEuler(smoothValue('右腕_x', rx), 0, smoothValue('右腕_z', rz)),
    };
  }

  // ── 左腕（MMD左 = MP右）：右肩→右肘 ──
  if (rSh && rEl && boneMap['左腕'] !== undefined) {
    const sideAngle = angleFromDown(rSh, rEl);
    // 左臂侧抬 = 正 Z 旋转
    const rz = clamp(sideAngle, -Math.PI * 0.9, Math.PI * 0.9);

    const dz = rEl.z - rSh.z;
    const rx = clamp(dz * 2.5, -1.2, 1.2);

    results['左腕'] = {
      idx: boneMap['左腕'],
      quat: quatFromEuler(smoothValue('左腕_x', rx), 0, smoothValue('左腕_z', rz)),
    };
  }

  // ── 右ひじ（MMD右 = MP左）：左肘→左腕 ──
  // 小臂弯曲：大臂与小臂的夹角
  if (lEl && lWr && lSh && boneMap['右ひじ'] !== undefined) {
    // 大臂方向
    const armDx = lEl.x - lSh.x, armDy = lEl.y - lSh.y;
    // 小臂方向
    const foreDx = lWr.x - lEl.x, foreDy = lWr.y - lEl.y;
    // 两向量夹角
    const armLen = Math.hypot(armDx, armDy) || 1;
    const foreLen = Math.hypot(foreDx, foreDy) || 1;
    const dot = (armDx * foreDx + armDy * foreDy) / (armLen * foreLen);
    const angle = Math.acos(clamp(dot, -1, 1));
    // 弯曲角度：伸直=0, 弯曲=π
    // 映射到 X 轴旋转（小臂向内弯）
    const rx = clamp((Math.PI - angle) * 0.8, 0, 2.0);

    results['右ひじ'] = {
      idx: boneMap['右ひじ'],
      quat: quatFromEuler(smoothValue('右ひじ_x', rx), 0, 0),
    };
  }

  // ── 左ひじ（MMD左 = MP右）：右肘→右腕 ──
  if (rEl && rWr && rSh && boneMap['左ひじ'] !== undefined) {
    const armDx = rEl.x - rSh.x, armDy = rEl.y - rSh.y;
    const foreDx = rWr.x - rEl.x, foreDy = rWr.y - rEl.y;
    const armLen = Math.hypot(armDx, armDy) || 1;
    const foreLen = Math.hypot(foreDx, foreDy) || 1;
    const dot = (armDx * foreDx + armDy * foreDy) / (armLen * foreLen);
    const angle = Math.acos(clamp(dot, -1, 1));
    const rx = clamp((Math.PI - angle) * 0.8, 0, 2.0);

    results['左ひじ'] = {
      idx: boneMap['左ひじ'],
      quat: quatFromEuler(smoothValue('左ひじ_x', rx), 0, 0),
    };
  }

  // ── 右足（MMD右 = MP左）：左髋→左膝 ──
  if (lHi && lKn && boneMap['右足'] !== undefined) {
    // 前后抬腿：角度
    const legAngle = angleFromDown(lHi, lKn);
    // 映射到 X 轴旋转
    const rx = clamp(-legAngle, -1.0, 1.0);

    results['右足'] = {
      idx: boneMap['右足'],
      quat: quatFromEuler(smoothValue('右足_x', rx), 0, 0),
    };
  }

  // ── 左足（MMD左 = MP右）：右髋→右膝 ──
  if (rHi && rKn && boneMap['左足'] !== undefined) {
    const legAngle = angleFromDown(rHi, rKn);
    const rx = clamp(legAngle, -1.0, 1.0);

    results['左足'] = {
      idx: boneMap['左足'],
      quat: quatFromEuler(smoothValue('左足_x', rx), 0, 0),
    };
  }

  // ── 右ひざ（MMD右 = MP左）：左膝→左踝 ──
  if (lKn && lAn && lHi && boneMap['右ひざ'] !== undefined) {
    const thighDx = lKn.x - lHi.x, thighDy = lKn.y - lHi.y;
    const shinDx = lAn.x - lKn.x, shinDy = lAn.y - lKn.y;
    const tLen = Math.hypot(thighDx, thighDy) || 1;
    const sLen = Math.hypot(shinDx, shinDy) || 1;
    const dot = (thighDx * shinDx + thighDy * shinDy) / (tLen * sLen);
    const angle = Math.acos(clamp(dot, -1, 1));
    const rx = clamp((Math.PI - angle) * 0.7, 0, 1.8);

    results['右ひざ'] = {
      idx: boneMap['右ひざ'],
      quat: quatFromEuler(smoothValue('右ひざ_x', rx), 0, 0),
    };
  }

  // ── 左ひざ（MMD左 = MP右）：右膝→右踝 ──
  if (rKn && rAn && rHi && boneMap['左ひざ'] !== undefined) {
    const thighDx = rKn.x - rHi.x, thighDy = rKn.y - rHi.y;
    const shinDx = rAn.x - rKn.x, shinDy = rAn.y - rKn.y;
    const tLen = Math.hypot(thighDx, thighDy) || 1;
    const sLen = Math.hypot(shinDx, shinDy) || 1;
    const dot = (thighDx * shinDx + thighDy * shinDy) / (tLen * sLen);
    const angle = Math.acos(clamp(dot, -1, 1));
    const rx = clamp((Math.PI - angle) * 0.7, 0, 1.8);

    results['左ひざ'] = {
      idx: boneMap['左ひざ'],
      quat: quatFromEuler(smoothValue('左ひざ_x', rx), 0, 0),
    };
  }

  _landmarks = null;
  return results;
}

// ═══════════════════════════════════════════════════════════
//  MediaPipe Tasks Vision 初始化
// ═══════════════════════════════════════════════════════════

let _poseLandmarker = null;

async function ensurePoseLandmarker() {
  if (_poseLandmarker) return _poseLandmarker;

  console.log('[Pose] 开始加载 @mediapipe/tasks-vision...');
  const { PoseLandmarker, FilesetResolver } = await import('@mediapipe/tasks-vision');
  console.log('[Pose] tasks-vision 模块已加载');

  console.log('[Pose] 加载 WASM 运行时...');
  const vision = await FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@latest/wasm'
  );
  console.log('[Pose] WASM 运行时已加载');

  console.log('[Pose] 下载姿态检测模型...');
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
  try {
    landmarker = await ensurePoseLandmarker();
  } catch (err) {
    throw new Error('MediaPipe 初始化失败: ' + (err.message || err));
  }

  status('打开摄像头...');
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
  } catch (err) {
    if (err.name === 'NotAllowedError') throw new Error('摄像头权限被拒绝');
    if (err.name === 'NotFoundError') throw new Error('未找到摄像头设备');
    if (err.name === 'NotReadableError') throw new Error('摄像头被其他应用占用');
    throw new Error(`摄像头访问失败(${err.name}): ${err.message}`);
  }

  videoEl.srcObject = stream;
  await new Promise((resolve) => { videoEl.onloadedmetadata = resolve; });
  await videoEl.play();
  await new Promise((resolve) => {
    if (videoEl.readyState >= 2) { resolve(); return; }
    videoEl.onloadeddata = resolve;
  });

  console.log('[Pose] 摄像头已启动:', videoEl.videoWidth, 'x', videoEl.videoHeight);
  status('摄像头已启动，开始检测...');

  let running = true;
  let lastTimestamp = -1;

  async function detect() {
    if (!running) return;

    if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
      const now = performance.now();
      if (now > lastTimestamp) {
        lastTimestamp = now;
        try {
          const result = landmarker.detectForVideo(videoEl, Math.floor(now));
          if (result.landmarks && result.landmarks.length > 0) {
            const landmarks = result.landmarks[0].map(lm => ({
              x: lm.x, y: lm.y, z: lm.z, visibility: lm.visibility || 1,
            }));
            onResults(landmarks);
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
    landmarker,
    videoEl,
    stop: () => {
      running = false;
      stream.getTracks().forEach((t) => t.stop());
      resetSmoothing();
    },
  };
}

/**
 * 在 canvas 上绘制视频画面 + 骨骼连线
 */
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

  const connections = [
    [11, 12], [11, 13], [13, 15], [12, 14], [14, 16],
    [11, 23], [12, 24], [23, 24],
    [23, 25], [25, 27], [24, 26], [26, 28],
  ];

  const mx = (lm) => lm ? (1 - lm.x) * w : 0;
  const my = (lm) => lm ? lm.y * h : 0;

  ctx.strokeStyle = '#7c5cfc';
  ctx.lineWidth = 3;
  ctx.beginPath();
  for (const [a, b] of connections) {
    if (!landmarks[a] || !landmarks[b]) continue;
    ctx.moveTo(mx(landmarks[a]), my(landmarks[a]));
    ctx.lineTo(mx(landmarks[b]), my(landmarks[b]));
  }
  ctx.stroke();

  ctx.fillStyle = '#f09393';
  for (let i = 0; i < landmarks.length; i++) {
    const lm = landmarks[i];
    if (!lm || (lm.visibility !== undefined && lm.visibility < 0.3)) continue;
    ctx.beginPath();
    ctx.arc(mx(lm), my(lm), 4, 0, Math.PI * 2);
    ctx.fill();
  }
}
