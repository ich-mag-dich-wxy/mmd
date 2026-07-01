// ═══════════════════════════════════════════════════════════
//  MiKaPo Solver — 完全照搬 plug/MiKaPo-main/src/lib/solver.ts
//  逐行翻译 TypeScript → JavaScript，不改动任何算法逻辑。
//  额外保留 calibrateFromPlain() 供 three.js 非 Babylon 调用方使用。
// ═══════════════════════════════════════════════════════════

import { Matrix, Quaternion, Vector3 } from '@babylonjs/core';

export class BoneState {
  constructor(name, rotation) {
    this.name = name;
    this.rotation = rotation;
  }
}

export const KeyBones = [
  '首', '頭', '上半身', '下半身',
  '左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首',
  '左腕', '右腕', '左ひじ', '右ひじ',
  '左足ＩＫ', '右足ＩＫ', '右つま先ＩＫ', '左つま先ＩＫ',
  '左目', '右目',
  '左手首', '右手首', '左手捩', '右手捩',
  '右親指１', '右親指２', '右人指１', '右人指２', '右人指３',
  '右中指１', '右中指２', '右中指３',
  '右薬指１', '右薬指２', '右薬指３',
  '右小指１', '右小指２', '右小指３',
  '左親指１', '左親指２', '左人指１', '左人指２', '左人指３',
  '左中指１', '左中指２', '左中指３',
  '左薬指１', '左薬指２', '左薬指３',
  '左小指１', '左小指２', '左小指３',
];

const PoseLandmarksTable = {
  nose: 0, left_eye_inner: 1, left_eye: 2, left_eye_outer: 3,
  right_eye_inner: 4, right_eye: 5, right_eye_outer: 6,
  left_ear: 7, right_ear: 8, mouth_left: 9, mouth_right: 10,
  left_shoulder: 11, right_shoulder: 12, left_elbow: 13, right_elbow: 14,
  left_wrist: 15, right_wrist: 16, left_pinky: 17, right_pinky: 18,
  left_index: 19, right_index: 20, left_thumb: 21, right_thumb: 22,
  left_hip: 23, right_hip: 24, left_knee: 25, right_knee: 26,
  left_ankle: 27, right_ankle: 28, left_heel: 29, right_heel: 30,
  left_foot_index: 31, right_foot_index: 32,
};

const HandIndexTable = {
  wrist: 0, thumb_cmc: 1, thumb_mcp: 2, thumb_ip: 3, thumb_tip: 4,
  index_mcp: 5, index_pip: 6, index_dip: 7, index_tip: 8,
  middle_mcp: 9, middle_pip: 10, middle_dip: 11, middle_tip: 12,
  ring_mcp: 13, ring_pip: 14, ring_dip: 15, ring_tip: 16,
  pinky_mcp: 17, pinky_pip: 18, pinky_dip: 19, pinky_tip: 20,
};

// ── One-Euro 滤波器（照搬 MiKaPo solver.ts 第 125-219 行）──

class OneEuroFilter {
  constructor(minCutoff, beta, dCutoff) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.prev = null;
    this.prevDeriv = 0;
    this.prevTs = null;
  }

  filter(value, ts) {
    if (this.prev === null || this.prevTs === null) {
      this.prev = value;
      this.prevTs = ts;
      return value;
    }
    const dt = (ts - this.prevTs) / 1000;
    if (dt <= 0) return this.prev;

    const rawDeriv = (value - this.prev) / dt;
    const aD = OneEuroFilter.smoothing(this.dCutoff, dt);
    const filteredDeriv = aD * rawDeriv + (1 - aD) * this.prevDeriv;

    const cutoff = this.minCutoff + this.beta * Math.abs(filteredDeriv);
    const a = OneEuroFilter.smoothing(cutoff, dt);
    const filtered = a * value + (1 - a) * this.prev;

    this.prev = filtered;
    this.prevDeriv = filteredDeriv;
    this.prevTs = ts;
    return filtered;
  }

  reset() {
    this.prev = null;
    this.prevDeriv = 0;
    this.prevTs = null;
  }

  static smoothing(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
}

class QuaternionOneEuroFilter {
  constructor(minCutoff, beta, dCutoff) {
    this.fx = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fz = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.fw = new OneEuroFilter(minCutoff, beta, dCutoff);
    this.prev = null;
  }

  filter(q, ts) {
    let x = q.x, y = q.y, z = q.z, w = q.w;
    // Hemisphere flip: keep dot(prev, raw) >= 0 so component-wise filtering
    // doesn't take the long way around the 4D sphere.
    if (this.prev) {
      const dot = this.prev.x * x + this.prev.y * y + this.prev.z * z + this.prev.w * w;
      if (dot < 0) {
        x = -x; y = -y; z = -z; w = -w;
      }
    }
    const out = new Quaternion(
      this.fx.filter(x, ts),
      this.fy.filter(y, ts),
      this.fz.filter(z, ts),
      this.fw.filter(w, ts),
    );
    out.normalize();
    this.prev = out;
    return out;
  }

  reset() {
    this.fx.reset();
    this.fy.reset();
    this.fz.reset();
    this.fw.reset();
    this.prev = null;
  }
}

// Bones whose rest world positions calibrate() reads. Caller queries each
// from the loaded MMD model and passes them as `restWorldPos`.
export const SOLVER_REST_BONES = [
  '左足', '右足', '左ひざ', '右ひざ', '左足首', '右足首',
  '左つま先', '右つま先',
  '首', '頭', '左肩', '右肩', '左目', '右目',
  '左腕', '右腕', '左ひじ', '右ひじ', '左手首', '右手首',
  '左中指１', '右中指１',
  '左親指１', '左親指２', '右親指１', '右親指２',
  '左人指１', '左人指２', '右人指１', '右人指２',
  '左中指２', '右中指２',
  '左薬指１', '左薬指２', '右薬指１', '右薬指２',
  '左小指１', '左小指２', '右小指１', '右小指２',
];

// Fallback reference directions in each bone's parent-local frame at rest.
// `Solver.calibrate()` overrides any of these from the loaded model's rest pose.
// 左手捩/右手捩 use a canonical hand-local axis that calibrate() can't derive
// from bones, so they always come from here.
const DEFAULT_REFS = {
  左腕: new Vector3(0.80917156, -0.58753001, -0.00706277).normalize(),
  右腕: new Vector3(-0.80917129, -0.58753035, -0.00706463).normalize(),
  左ひじ: new Vector3(0.80886214, -0.58772615, -0.01788871).normalize(),
  右ひじ: new Vector3(-0.80886264, -0.58772542, -0.01789011).normalize(),
  左足: new Vector3(-0.01338665, -0.99819434, 0.05855645).normalize(),
  右足: new Vector3(0.01338609, -0.99819433, 0.05855677).normalize(),
  左ひざ: new Vector3(-0.01333798, -0.98954426, 0.14361147).normalize(),
  右ひざ: new Vector3(0.01333724, -0.98954425, 0.14361163).normalize(),
  左足首: new Vector3(0.00000064, -0.80765191, -0.58965955).normalize(),
  右足首: new Vector3(0.00000054, -0.80765185, -0.58965964).normalize(),
  首: new Vector3(0.00000258, 0.97346054, -0.22885491).normalize(),
  左手首: new Vector3(0.81635913, -0.57754444, -0.00043314).normalize(),
  右手首: new Vector3(-0.81635927, -0.57754425, -0.00043491).normalize(),
  左親指１: new Vector3(0.62716533, -0.72577692, -0.28268623).normalize(),
  右親指１: new Vector3(-0.62716428, -0.72578107, -0.28267792).normalize(),
  左人指１: new Vector3(0.84121176, -0.54001806, 0.02726296).normalize(),
  右人指１: new Vector3(-0.84121092, -0.54001943, 0.02726177).normalize(),
  左中指１: new Vector3(0.82851523, -0.55942638, 0.02458950).normalize(),
  右中指１: new Vector3(-0.82851643, -0.55942465, 0.02458833).normalize(),
  左薬指１: new Vector3(0.80448878, -0.59258445, 0.04051516).normalize(),
  右薬指１: new Vector3(-0.80448680, -0.59258726, 0.04051333).normalize(),
  左小指１: new Vector3(0.86110206, -0.49661517, 0.10897986).normalize(),
  右小指１: new Vector3(-0.86110169, -0.49661597, 0.10897917).normalize(),
  // 左手捩/右手捩: canonical hand-local axis used for wrist twist roll extraction.
  左手捩: new Vector3(0, 0, -1).normalize(),
  右手捩: new Vector3(0, 0, -1).normalize(),
};

export class Solver {
  constructor() {
    this.poseWorldLandmarks = null;
    this.leftHandWorldLandmarks = null;
    this.rightHandWorldLandmarks = null;
    this.boneStates = {};
    this.filters = {};
    this.smoothing = { minCutoff: 1.5, beta: 0.5, dCutoff: 1.0 };
    // Calibrated reference directions in each bone's parent-local frame at rest.
    // Populated by calibrate() from the loaded model. Falls through to DEFAULT_REFS.
    this.refs = {};
    // ── 深度修正（骨骼长度约束）──
    // MediaPipe poseWorldLandmarks 的 Z 是单目深度估计，正面朝相机时
    // 前后运动（如抬膝）的 Z 变化被严重低估。利用骨骼长度恒定的约束
    // （hip-knee、knee-ankle 距离应恒定），保持 X/Y 不变反推正确的 Z。
    this.boneLengthEst = {};     // key → { hipKnee, kneeAnkle } 骨骼长度估计（衰减 max）
    this.prevZSigns = {};        // key → { knee, ankle } 上一帧修正后 Z 的符号（运动连续性）
    this.correctedPoseLandmarks = null;  // Z 修正后的 landmark 副本
  }

  reset() {
    for (const key of Object.keys(this.filters)) {
      this.filters[key].reset();
    }
  }

  // 从普通对象 {x,y,z} 校准（供 three.js 等非 Babylon 调用方使用）。
  // plainPos: Record<string, {x,y,z}>，坐标必须是 solver 左手系（landmark 系）。
  calibrateFromPlain(plainPos) {
    const v = {};
    for (const [k, p] of Object.entries(plainPos)) {
      v[k] = new Vector3(p.x, p.y, p.z);
    }
    this.calibrate(v);
  }

  // Calibrate reference directions from the model's rest-pose world bone positions.
  // Parent chains are identity at rest, so world-space (child − parent) IS the
  // parent-local reference direction.
  // restWorldPos: Record<string, Vector3> (Babylon Vector3)
  calibrate(restWorldPos) {
    const dir = (parent, child) => {
      const p = restWorldPos[parent];
      const c = restWorldPos[child];
      if (!p || !c) return null;
      const v = c.subtract(p);
      const len = v.length();
      if (len < 1e-6) return null;
      return v.scale(1 / len);
    };
    const set = (key, v) => {
      if (v) this.refs[key] = v;
    };

    // Limbs
    set('左腕', dir('左腕', '左ひじ'));
    set('右腕', dir('右腕', '右ひじ'));
    set('左ひじ', dir('左ひじ', '左手首'));
    set('右ひじ', dir('右ひじ', '右手首'));
    set('左足', dir('左足', '左ひざ'));
    set('右足', dir('右足', '右ひざ'));
    set('左ひざ', dir('左ひざ', '左足首'));
    set('右ひざ', dir('右ひざ', '右足首'));

    // Ankle: foot_index is forward of ankle; pose runtime uses ankle→foot_index
    // landmark direction, so calibrate the same shape from MMD foot bones.
    set('左足首', dir('左足首', '左つま先'));
    set('右足首', dir('右足首', '右つま先'));

    // Neck: bone-direct (首→頭) doesn't match the pose runtime measurement
    // (ear_center − shoulder_center), so even at rest the rotation isn't identity.
    // Use eye/shoulder bone proxies — eye height ≈ ear height, shoulder bone ≈
    // shoulder landmark — so the calibrated direction lines up with the pose
    // measurement. Falls through to 首→頭 if any of the four bones is missing.
    set('首', dir('首', '頭'));
    const ls = restWorldPos['左肩'];
    const rs = restWorldPos['右肩'];
    const le = restWorldPos['左目'];
    const re = restWorldPos['右目'];
    if (ls && rs && le && re) {
      const shoulderMid = ls.add(rs).scale(0.5);
      const eyeMid = le.add(re).scale(0.5);
      const v = eyeMid.subtract(shoulderMid);
      const len = v.length();
      if (len > 1e-6) this.refs['首'] = v.scale(1 / len);
    }

    // Wrists — middle finger root is the natural "forward" axis of the hand
    set('左手首', dir('左手首', '左中指１'));
    set('右手首', dir('右手首', '右中指１'));

    // Wrist-twist witness axis: index_mcp − ring_mcp at rest. solveWristTwist
    // compares the live hand axis to this reference and projects onto the
    // forearm to extract twist. Without calibration, the (0, 0, -1) fallback
    // bakes in a 90°-ish baseline twist for every frame including rest.
    set('左手捩', dir('左薬指１', '左人指１'));
    set('右手捩', dir('右薬指１', '右人指１'));

    // Finger base joints (proximal phalanges)
    set('左親指１', dir('左親指１', '左親指２'));
    set('右親指１', dir('右親指１', '右親指２'));
    set('左人指１', dir('左人指１', '左人指２'));
    set('右人指１', dir('右人指１', '右人指２'));
    set('左中指１', dir('左中指１', '左中指２'));
    set('右中指１', dir('右中指１', '右中指２'));
    set('左薬指１', dir('左薬指１', '左薬指２'));
    set('右薬指１', dir('右薬指１', '右薬指２'));
    set('左小指１', dir('左小指１', '左小指２'));
    set('右小指１', dir('右小指１', '右小指２'));
  }

  // Calibrated reference for `key` if available, else the static default.
  getRef(key) {
    return this.refs[key] ?? DEFAULT_REFS[key];
  }

  // Swing-twist decomposition: returns the twist component of `q` around unit
  // axis `a`. `q = swing * twist`; the swing has zero rotation around `a`.
  // Singular when q is ~180° around an axis perpendicular to a — return identity.
  static twistAroundAxis(q, a) {
    const d = q.x * a.x + q.y * a.y + q.z * a.z;
    const px = a.x * d;
    const py = a.y * d;
    const pz = a.z * d;
    const len = Math.sqrt(px * px + py * py + pz * pz + q.w * q.w);
    if (len < 1e-8) return Quaternion.Identity();
    return new Quaternion(px / len, py / len, pz / len, q.w / len);
  }

  solve(landmarks) {
    this.boneStates = {};
    this.poseWorldLandmarks = null;
    this.leftHandWorldLandmarks = null;
    this.rightHandWorldLandmarks = null;

    if (landmarks.poseWorldLandmarks.length > 0 && landmarks.poseWorldLandmarks[0].length === 33) {
      this.poseWorldLandmarks = landmarks.poseWorldLandmarks[0];
    }
    if (landmarks.leftHandWorldLandmarks.length > 0 && landmarks.leftHandWorldLandmarks[0].length === 21) {
      this.leftHandWorldLandmarks = landmarks.leftHandWorldLandmarks[0];
    }
    if (landmarks.rightHandWorldLandmarks.length > 0 && landmarks.rightHandWorldLandmarks[0].length === 21) {
      this.rightHandWorldLandmarks = landmarks.rightHandWorldLandmarks[0];
    }

    // 深度修正：用骨骼长度约束修正 hip-knee-ankle 链的 Z
    this.correctLandmarkDepths();

    // 求解顺序至关重要：父骨骼必须先于子骨骼求解
    this.boneStates['upper_body'] = this.solveUpperBody();
    this.boneStates['neck'] = this.solveNeck();
    this.boneStates['head'] = this.solveHead();
    this.boneStates['lower_body'] = this.solveLowerBody();
    this.boneStates['left_leg'] = this.solveLeftLeg();
    this.boneStates['right_leg'] = this.solveRightLeg();
    this.boneStates['left_knee'] = this.solveLeftKnee();
    this.boneStates['right_knee'] = this.solveRightKnee();
    this.boneStates['left_ankle'] = this.solveLeftAnkle();
    this.boneStates['right_ankle'] = this.solveRightAnkle();
    this.boneStates['left_arm'] = this.solveLeftArm();
    this.boneStates['right_arm'] = this.solveRightArm();
    this.boneStates['left_elbow'] = this.solveLeftElbow();
    this.boneStates['right_elbow'] = this.solveRightElbow();
    this.boneStates['left_wrist_twist'] = this.solveLeftWristTwist();
    this.boneStates['right_wrist_twist'] = this.solveRightWristTwist();
    this.boneStates['left_wrist'] = this.solveLeftWrist();
    this.boneStates['right_wrist'] = this.solveRightWrist();
    // 左手指
    this.boneStates['left_thumb_1'] = this.solveLeftThumb1();
    this.boneStates['left_thumb_2'] = this.solveLeftThumb2();
    this.boneStates['left_index_1'] = this.solveLeftIndex1();
    this.boneStates['left_index_2'] = this.solveLeftIndex2();
    this.boneStates['left_index_3'] = this.solveLeftIndex3();
    this.boneStates['left_middle_1'] = this.solveLeftMiddle1();
    this.boneStates['left_middle_2'] = this.solveLeftMiddle2();
    this.boneStates['left_middle_3'] = this.solveLeftMiddle3();
    this.boneStates['left_ring_1'] = this.solveLeftRing1();
    this.boneStates['left_ring_2'] = this.solveLeftRing2();
    this.boneStates['left_ring_3'] = this.solveLeftRing3();
    this.boneStates['left_pinky_1'] = this.solveLeftPinky1();
    this.boneStates['left_pinky_2'] = this.solveLeftPinky2();
    this.boneStates['left_pinky_3'] = this.solveLeftPinky3();
    // 右手指
    this.boneStates['right_thumb_1'] = this.solveRightThumb1();
    this.boneStates['right_thumb_2'] = this.solveRightThumb2();
    this.boneStates['right_index_1'] = this.solveRightIndex1();
    this.boneStates['right_index_2'] = this.solveRightIndex2();
    this.boneStates['right_index_3'] = this.solveRightIndex3();
    this.boneStates['right_middle_1'] = this.solveRightMiddle1();
    this.boneStates['right_middle_2'] = this.solveRightMiddle2();
    this.boneStates['right_middle_3'] = this.solveRightMiddle3();
    this.boneStates['right_ring_1'] = this.solveRightRing1();
    this.boneStates['right_ring_2'] = this.solveRightRing2();
    this.boneStates['right_ring_3'] = this.solveRightRing3();
    this.boneStates['right_pinky_1'] = this.solveRightPinky1();
    this.boneStates['right_pinky_2'] = this.solveRightPinky2();
    this.boneStates['right_pinky_3'] = this.solveRightPinky3();

    // One-Euro filter pass. Applied as a post-pass on the final outputs so the
    // hierarchical chain (child computed in unfiltered parent's local space)
    // stays mathematically consistent — only the displayed rotations are smoothed.
    const ts = performance.now();
    for (const key of Object.keys(this.boneStates)) {
      let f = this.filters[key];
      if (!f) {
        f = new QuaternionOneEuroFilter(this.smoothing.minCutoff, this.smoothing.beta, this.smoothing.dCutoff);
        this.filters[key] = f;
      }
      this.boneStates[key].rotation = f.filter(this.boneStates[key].rotation, ts);
    }

    return Object.values(this.boneStates);
  }

  exportToVpdBlob(modelName = 'MotionCapture') {
    const poseData = Object.values(this.boneStates);
    return VpdWriter.ConvertToVpdBlob(poseData, modelName);
  }

  getPoseLandmark(name) {
    // 优先读取深度修正后的 landmark（腿部 hip/knee/ankle 被修正，其他骨骼原样）
    const src = this.correctedPoseLandmarks || this.poseWorldLandmarks;
    if (!src) return null;
    return this.landmarkToVector3(src[PoseLandmarksTable[name]]);
  }
  getLeftHandLandmark(name) {
    if (!this.leftHandWorldLandmarks) return null;
    return this.landmarkToVector3(this.leftHandWorldLandmarks[HandIndexTable[name]]);
  }
  getRightHandLandmark(name) {
    if (!this.rightHandWorldLandmarks) return null;
    return this.landmarkToVector3(this.rightHandWorldLandmarks[HandIndexTable[name]]);
  }
  landmarkToVector3(landmark) {
    if (!landmark) return new Vector3(0, 0, 0);
    return new Vector3(landmark.x, -landmark.y, landmark.z);
  }

  // ── 深度修正：骨骼长度约束 ──
  // MediaPipe 单目深度估计在正面朝相机时严重低估前后运动的 Z 变化。
  // hip-knee、knee-ankle 的骨骼长度恒定，保持 X/Y 不变（2D 画面准），
  // 用骨骼长度约束反推正确的 Z，再配合运动连续性追踪 Z 符号。
  correctLandmarkDepths() {
    if (!this.poseWorldLandmarks || this.poseWorldLandmarks.length < 33) return;

    // 浅拷贝一份，只修改需要修正的 knee/ankle
    this.correctedPoseLandmarks = this.poseWorldLandmarks.map(l => l ? { x: l.x, y: l.y, z: l.z, visibility: l.visibility } : l);

    // 左腿链：left_hip(23) → left_knee(25) → left_ankle(27)
    this.constrainLegChain(23, 25, 27, 'left');
    // 右腿链：right_hip(24) → right_knee(26) → right_ankle(28)
    this.constrainLegChain(24, 26, 28, 'right');
  }

  constrainLegChain(hipIdx, kneeIdx, ankleIdx, key) {
    const lm = this.correctedPoseLandmarks;
    const hip = lm[hipIdx], knee = lm[kneeIdx], ankle = lm[ankleIdx];
    if (!hip || !knee || !ankle) return;

    const hipV = this.landmarkToVector3(hip);
    const kneeV = this.landmarkToVector3(knee);
    const ankleV = this.landmarkToVector3(ankle);

    const hipKneeDist = Vector3.Distance(hipV, kneeV);
    const kneeAnkleDist = Vector3.Distance(kneeV, ankleV);

    // 骨骼长度估计：衰减 max（站立时腿伸直距离最大，抬膝时 Z 低估距离偏小）
    if (!this.boneLengthEst[key]) this.boneLengthEst[key] = { hipKnee: 0, kneeAnkle: 0 };
    const est = this.boneLengthEst[key];
    est.hipKnee = Math.max(est.hipKnee * 0.999, hipKneeDist);
    est.kneeAnkle = Math.max(est.kneeAnkle * 0.999, kneeAnkleDist);

    // 估计值不够大时不修正（避免冷启动时用 0 修正）
    if (est.hipKnee < 1e-4 || est.kneeAnkle < 1e-4) return;

    if (!this.prevZSigns[key]) this.prevZSigns[key] = { knee: 1, ankle: 1 };
    const signs = this.prevZSigns[key];

    // 修正 knee 的 Z（parent = hip）
    const kneeResult = this.constrainBoneZ(hipV, kneeV, est.hipKnee, signs.knee);
    signs.knee = kneeResult.sign;

    // 修正 ankle 的 Z（parent = 修正后的 knee）
    const ankleResult = this.constrainBoneZ(kneeResult.pos, ankleV, est.kneeAnkle, signs.ankle);
    signs.ankle = ankleResult.sign;

    // 写回（landmark 格式 Y 未翻转，修正用的是翻 Y 后的 Vector3，写回要翻回）
    lm[kneeIdx].x = kneeResult.pos.x;
    lm[kneeIdx].y = -kneeResult.pos.y;
    lm[kneeIdx].z = kneeResult.pos.z;

    lm[ankleIdx].x = ankleResult.pos.x;
    lm[ankleIdx].y = -ankleResult.pos.y;
    lm[ankleIdx].z = ankleResult.pos.z;
  }

  // 保持 child 的 X/Y 不变，调整 Z 使 |parent→child| = targetLength。
  // 符号：当前 Z 信号足够强时用其符号，否则沿用上一帧符号（运动连续性）。
  constrainBoneZ(parentPos, childPos, targetLength, prevSign) {
    const dx = childPos.x - parentPos.x;
    const dy = childPos.y - parentPos.y;
    const dz = childPos.z - parentPos.z;
    const xySq = dx * dx + dy * dy;
    const dzSq = targetLength * targetLength - xySq;

    if (dzSq <= 0) {
      // X/Y 距离已超过骨骼长度（罕见，如 landmark 噪声），无法修正
      return { pos: childPos, sign: prevSign };
    }

    const newDzAbs = Math.sqrt(dzSq);

    // 符号判断：当前 Z 信号 > 10% 骨骼长度时采信，否则用上一帧符号
    let sign = prevSign;
    if (Math.abs(dz) > 0.1 * targetLength) {
      sign = dz >= 0 ? 1 : -1;
    }

    const newDz = sign * newDzAbs;
    const newPos = new Vector3(childPos.x, childPos.y, parentPos.z + newDz);

    return { pos: newPos, sign };
  }

  solveLowerBody() {
    const leftHip = this.getPoseLandmark('left_hip');
    const rightHip = this.getPoseLandmark('right_hip');
    const leftShoulder = this.getPoseLandmark('left_shoulder');
    const rightShoulder = this.getPoseLandmark('right_shoulder');

    if (!leftHip || !rightHip || !leftShoulder || !rightShoulder)
      return { name: '下半身', rotation: Quaternion.Identity() };

    // Build a pelvis basis (X = hip line, Y = trunk vertical, Z = cross).
    const shoulderCenter = leftShoulder.add(rightShoulder).scale(0.5);
    const hipCenter = leftHip.add(rightHip).scale(0.5);

    const spineY = shoulderCenter.subtract(hipCenter).normalize();

    const rawHipX = leftHip.subtract(rightHip).normalize();
    const hipX = rawHipX.subtract(spineY.scale(Vector3.Dot(rawHipX, spineY))).normalize();

    const hipZ = Vector3.Cross(hipX, spineY).normalize();

    const m = Matrix.FromValues(
      hipX.x, hipX.y, hipX.z, 0,
      spineY.x, spineY.y, spineY.z, 0,
      hipZ.x, hipZ.y, hipZ.z, 0,
      0, 0, 0, 1
    );

    const scaling = new Vector3();
    const rotation = new Quaternion();
    const translation = new Vector3();
    m.decompose(scaling, rotation, translation);

    return { name: '下半身', rotation: rotation };
  }

  solveUpperBody() {
    const leftShoulder = this.getPoseLandmark('left_shoulder');
    const rightShoulder = this.getPoseLandmark('right_shoulder');

    if (!leftShoulder || !rightShoulder) return { name: '上半身', rotation: Quaternion.Identity() };

    const shoulderCenter = leftShoulder.add(rightShoulder).scale(0.5);

    const spineY = shoulderCenter.normalize();

    // Gram-Schmidt: shoulderX from landmarks isn't guaranteed perpendicular to
    // spineY, which was leaving the matrix slightly sheared and tilting the torso.
    // Project out the spineY component so all three axes are orthonormal.
    const rawShoulderX = leftShoulder.subtract(rightShoulder).normalize();
    const shoulderX = rawShoulderX.subtract(spineY.scale(Vector3.Dot(rawShoulderX, spineY))).normalize();

    const upperBodyZ = Vector3.Cross(shoulderX, spineY).normalize();

    const upperBodyMatrix = Matrix.FromValues(
      shoulderX.x, shoulderX.y, shoulderX.z, 0,
      spineY.x, spineY.y, spineY.z, 0,
      upperBodyZ.x, upperBodyZ.y, upperBodyZ.z, 0,
      0, 0, 0, 1
    );

    const scaling = new Vector3();
    const rotation = new Quaternion();
    const translation = new Vector3();
    upperBodyMatrix.decompose(scaling, rotation, translation);

    return { name: '上半身', rotation: rotation };
  }

  solveNeck() {
    const worldLeftEar = this.getPoseLandmark('left_ear');
    const worldRightEar = this.getPoseLandmark('right_ear');
    const worldLeftShoulder = this.getPoseLandmark('left_shoulder');
    const worldRightShoulder = this.getPoseLandmark('right_shoulder');

    if (!worldLeftEar || !worldRightEar || !worldLeftShoulder || !worldRightShoulder)
      return { name: '首', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const upperBodyMatrix = new Matrix();
    Matrix.FromQuaternionToRef(upperBodyQuat, upperBodyMatrix);
    const worldToUpperBody = upperBodyMatrix.invert();

    const localLeftEar = Vector3.TransformCoordinates(worldLeftEar, worldToUpperBody);
    const localRightEar = Vector3.TransformCoordinates(worldRightEar, worldToUpperBody);
    const localLeftShoulder = Vector3.TransformCoordinates(worldLeftShoulder, worldToUpperBody);
    const localRightShoulder = Vector3.TransformCoordinates(worldRightShoulder, worldToUpperBody);

    // Calculate neck direction in upper body space
    const localEarCenter = localLeftEar.add(localRightEar).scale(0.5);
    const localShoulderCenter = localLeftShoulder.add(localRightShoulder).scale(0.5);
    const neckDirection = localEarCenter.subtract(localShoulderCenter).normalize();
    const reference = this.getRef('首');

    return {
      name: '首',
      rotation: Quaternion.FromUnitVectorsToRef(reference, neckDirection, new Quaternion()),
    };
  }

  solveHead() {
    const worldLeftEar = this.getPoseLandmark('left_ear');
    const worldRightEar = this.getPoseLandmark('right_ear');
    const worldLeftEye = this.getPoseLandmark('left_eye');
    const worldRightEye = this.getPoseLandmark('right_eye');

    if (!worldLeftEar || !worldRightEar || !worldLeftEye || !worldRightEye)
      return { name: '頭', rotation: Quaternion.Identity() };

    // Use full parent chain: upper_body * neck
    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const neckQuat = this.boneStates['neck'].rotation;

    const fullParentQuat = upperBodyQuat.multiply(neckQuat);
    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localLeftEar = Vector3.TransformCoordinates(worldLeftEar, worldToFullParent);
    const localRightEar = Vector3.TransformCoordinates(worldRightEar, worldToFullParent);
    const localLeftEye = Vector3.TransformCoordinates(worldLeftEye, worldToFullParent);
    const localRightEye = Vector3.TransformCoordinates(worldRightEye, worldToFullParent);

    const localEarCenter = localLeftEar.add(localRightEar).scale(0.5);
    const localEyeCenter = localLeftEye.add(localRightEye).scale(0.5);

    // Build head basis in upper_body * neck local frame and decompose to a single
    // rotation. X = ear axis (left − right), Z = back (ear_center − eye_center,
    // since eye is forward of ear at rest), Y = cross.
    const earX = localLeftEar.subtract(localRightEar).normalize();
    const back = localEarCenter.subtract(localEyeCenter).normalize();
    // Gram-Schmidt: project earX to plane perpendicular to back so axes are orthonormal.
    const headX = earX.subtract(back.scale(Vector3.Dot(earX, back))).normalize();
    const headY = Vector3.Cross(back, headX).normalize();

    const m = Matrix.FromValues(
      headX.x, headX.y, headX.z, 0,
      headY.x, headY.y, headY.z, 0,
      back.x, back.y, back.z, 0,
      0, 0, 0, 1
    );

    const scaling = new Vector3();
    const rotation = new Quaternion();
    const translation = new Vector3();
    m.decompose(scaling, rotation, translation);

    return { name: '頭', rotation: rotation };
  }

  solveLeftLeg() {
    const worldLeftHip = this.getPoseLandmark('left_hip');
    const worldLeftKnee = this.getPoseLandmark('left_knee');

    if (!worldLeftHip || !worldLeftKnee) return { name: '左足', rotation: Quaternion.Identity() };

    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    const lowerBodyMatrix = new Matrix();
    Matrix.FromQuaternionToRef(lowerBodyQuat, lowerBodyMatrix);
    const worldToLowerBody = lowerBodyMatrix.invert();
    const localLeftHip = Vector3.TransformCoordinates(worldLeftHip, worldToLowerBody);
    const localLeftKnee = Vector3.TransformCoordinates(worldLeftKnee, worldToLowerBody);

    const leftLegDirection = localLeftKnee.subtract(localLeftHip).normalize();

    const reference = this.getRef('左足');

    return {
      name: '左足',
      rotation: Quaternion.FromUnitVectorsToRef(reference, leftLegDirection, new Quaternion()),
    };
  }

  solveRightLeg() {
    const worldRightHip = this.getPoseLandmark('right_hip');
    const worldRightKnee = this.getPoseLandmark('right_knee');

    if (!worldRightHip || !worldRightKnee) return { name: '右足', rotation: Quaternion.Identity() };

    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    const lowerBodyMatrix = new Matrix();
    Matrix.FromQuaternionToRef(lowerBodyQuat, lowerBodyMatrix);
    const worldToLowerBody = lowerBodyMatrix.invert();

    const localRightHip = Vector3.TransformCoordinates(worldRightHip, worldToLowerBody);
    const localRightKnee = Vector3.TransformCoordinates(worldRightKnee, worldToLowerBody);

    const rightLegDirection = localRightKnee.subtract(localRightHip).normalize();

    const reference = this.getRef('右足');

    return {
      name: '右足',
      rotation: Quaternion.FromUnitVectorsToRef(reference, rightLegDirection, new Quaternion()),
    };
  }

  solveLeftKnee() {
    const worldLeftKnee = this.getPoseLandmark('left_knee');
    const worldLeftAnkle = this.getPoseLandmark('left_ankle');

    if (!worldLeftKnee || !worldLeftAnkle) return { name: '左ひざ', rotation: Quaternion.Identity() };

    const leftLegQuat = this.boneStates['left_leg'].rotation;
    const lowerBodyQuat = this.boneStates['lower_body'].rotation;

    const fullParentQuat = lowerBodyQuat.multiply(leftLegQuat);
    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localLeftKnee = Vector3.TransformCoordinates(worldLeftKnee, worldToFullParent);
    const localLeftAnkle = Vector3.TransformCoordinates(worldLeftAnkle, worldToFullParent);

    const kneeDirection = localLeftAnkle.subtract(localLeftKnee).normalize();
    const reference = this.getRef('左ひざ');

    return {
      name: '左ひざ',
      rotation: Quaternion.FromUnitVectorsToRef(reference, kneeDirection, new Quaternion()),
    };
  }

  solveRightKnee() {
    const worldRightKnee = this.getPoseLandmark('right_knee');
    const worldRightAnkle = this.getPoseLandmark('right_ankle');

    if (!worldRightKnee || !worldRightAnkle) return { name: '右ひざ', rotation: Quaternion.Identity() };

    const rightLegQuat = this.boneStates['right_leg'].rotation;
    const lowerBodyQuat = this.boneStates['lower_body'].rotation;

    const fullParentQuat = lowerBodyQuat.multiply(rightLegQuat);
    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localRightKnee = Vector3.TransformCoordinates(worldRightKnee, worldToFullParent);
    const localRightAnkle = Vector3.TransformCoordinates(worldRightAnkle, worldToFullParent);

    const kneeDirection = localRightAnkle.subtract(localRightKnee).normalize();
    const reference = this.getRef('右ひざ');

    return {
      name: '右ひざ',
      rotation: Quaternion.FromUnitVectorsToRef(reference, kneeDirection, new Quaternion()),
    };
  }

  solveLeftAnkle() {
    // Use ankle (not heel) → foot_index so the runtime direction matches the
    // calibrated 左足首→左つま先 bone reference.
    const worldLeftAnkle = this.getPoseLandmark('left_ankle');
    const worldLeftFootIndex = this.getPoseLandmark('left_foot_index');

    if (!worldLeftAnkle || !worldLeftFootIndex) return { name: '左足首', rotation: Quaternion.Identity() };

    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    const leftLegQuat = this.boneStates['left_leg'].rotation;
    const leftKneeQuat = this.boneStates['left_knee'].rotation;

    const fullParentQuat = lowerBodyQuat.multiply(leftLegQuat).multiply(leftKneeQuat);
    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localLeftAnkle = Vector3.TransformCoordinates(worldLeftAnkle, worldToFullParent);
    const localLeftFootIndex = Vector3.TransformCoordinates(worldLeftFootIndex, worldToFullParent);

    const ankleDirection = localLeftFootIndex.subtract(localLeftAnkle).normalize();
    const reference = this.getRef('左足首');

    return {
      name: '左足首',
      rotation: Quaternion.FromUnitVectorsToRef(reference, ankleDirection, new Quaternion()),
    };
  }

  solveRightAnkle() {
    const worldRightAnkle = this.getPoseLandmark('right_ankle');
    const worldRightFootIndex = this.getPoseLandmark('right_foot_index');

    if (!worldRightAnkle || !worldRightFootIndex) return { name: '右足首', rotation: Quaternion.Identity() };

    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    const rightLegQuat = this.boneStates['right_leg'].rotation;
    const rightKneeQuat = this.boneStates['right_knee'].rotation;

    const fullParentQuat = lowerBodyQuat.multiply(rightLegQuat).multiply(rightKneeQuat);
    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localRightAnkle = Vector3.TransformCoordinates(worldRightAnkle, worldToFullParent);
    const localRightFootIndex = Vector3.TransformCoordinates(worldRightFootIndex, worldToFullParent);

    const ankleDirection = localRightFootIndex.subtract(localRightAnkle).normalize();
    const reference = this.getRef('右足首');

    return {
      name: '右足首',
      rotation: Quaternion.FromUnitVectorsToRef(reference, ankleDirection, new Quaternion()),
    };
  }

  solveLeftArm() {
    const worldLeftShoulder = this.getPoseLandmark('left_shoulder');
    const worldLeftElbow = this.getPoseLandmark('left_elbow');

    if (!worldLeftShoulder || !worldLeftElbow) return { name: '左腕', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const upperBodyMatrix = new Matrix();
    Matrix.FromQuaternionToRef(upperBodyQuat, upperBodyMatrix);
    const worldToUpperBody = upperBodyMatrix.invert();

    const localLeftShoulder = Vector3.TransformCoordinates(worldLeftShoulder, worldToUpperBody);
    const localLeftElbow = Vector3.TransformCoordinates(worldLeftElbow, worldToUpperBody);

    const leftArmDirection = localLeftElbow.subtract(localLeftShoulder).normalize();
    const reference = this.getRef('左腕');

    return {
      name: '左腕',
      rotation: Quaternion.FromUnitVectorsToRef(reference, leftArmDirection, new Quaternion()),
    };
  }

  solveRightArm() {
    const worldRightShoulder = this.getPoseLandmark('right_shoulder');
    const worldRightElbow = this.getPoseLandmark('right_elbow');

    if (!worldRightShoulder || !worldRightElbow) return { name: '右腕', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const upperBodyMatrix = new Matrix();
    Matrix.FromQuaternionToRef(upperBodyQuat, upperBodyMatrix);
    const worldToUpperBody = upperBodyMatrix.invert();

    const localRightShoulder = Vector3.TransformCoordinates(worldRightShoulder, worldToUpperBody);
    const localRightElbow = Vector3.TransformCoordinates(worldRightElbow, worldToUpperBody);

    const rightArmDirection = localRightElbow.subtract(localRightShoulder).normalize();
    const reference = this.getRef('右腕');

    return {
      name: '右腕',
      rotation: Quaternion.FromUnitVectorsToRef(reference, rightArmDirection, new Quaternion()),
    };
  }

  solveLeftElbow() {
    const worldLeftElbow = this.getPoseLandmark('left_elbow');
    const worldLeftWrist = this.getPoseLandmark('left_wrist');

    if (!worldLeftElbow || !worldLeftWrist) return { name: '左ひじ', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const leftArmQuat = this.boneStates['left_arm'].rotation;

    const fullParentQuat = upperBodyQuat.multiply(leftArmQuat);
    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localLeftElbow = Vector3.TransformCoordinates(worldLeftElbow, worldToFullParent);
    const localLeftWrist = Vector3.TransformCoordinates(worldLeftWrist, worldToFullParent);

    const leftElbowDirection = localLeftWrist.subtract(localLeftElbow).normalize();
    const reference = this.getRef('左ひじ');

    return {
      name: '左ひじ',
      rotation: Quaternion.FromUnitVectorsToRef(reference, leftElbowDirection, new Quaternion()),
    };
  }

  solveRightElbow() {
    const worldRightElbow = this.getPoseLandmark('right_elbow');
    const worldRightWrist = this.getPoseLandmark('right_wrist');

    if (!worldRightElbow || !worldRightWrist) return { name: '右ひじ', rotation: Quaternion.Identity() };

    const rightArmQuat = this.boneStates['right_arm'].rotation;
    const upperBodyQuat = this.boneStates['upper_body'].rotation;

    const fullParentQuat = upperBodyQuat.multiply(rightArmQuat);
    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localRightElbow = Vector3.TransformCoordinates(worldRightElbow, worldToFullParent);
    const localRightWrist = Vector3.TransformCoordinates(worldRightWrist, worldToFullParent);

    const rightElbowDirection = localRightWrist.subtract(localRightElbow).normalize();
    const reference = this.getRef('右ひじ');

    return {
      name: '右ひじ',
      rotation: Quaternion.FromUnitVectorsToRef(reference, rightElbowDirection, new Quaternion()),
    };
  }

  solveLeftWristTwist() {
    const worldLeftWrist = this.getLeftHandLandmark('wrist');
    const worldLeftIndex = this.getLeftHandLandmark('index_mcp');
    const worldLeftRing = this.getLeftHandLandmark('ring_mcp');

    if (!worldLeftWrist || !worldLeftIndex || !worldLeftRing) return { name: '左手捩', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const leftArmQuat = this.boneStates['left_arm'].rotation;
    const leftElbowQuat = this.boneStates['left_elbow'].rotation;

    const fullParentQuat = upperBodyQuat.multiply(leftArmQuat).multiply(leftElbowQuat);
    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localLeftIndex = Vector3.TransformCoordinates(worldLeftIndex, worldToFullParent);
    const localLeftRing = Vector3.TransformCoordinates(worldLeftRing, worldToFullParent);

    const handDirection = localLeftIndex.subtract(localLeftRing).normalize();
    const reference = this.getRef('左手捩');

    // Total rotation aligning rest hand axis to current. Includes wrist twist + swing.
    const fullRotation = Quaternion.FromUnitVectorsToRef(reference, handDirection, new Quaternion());
    // Forearm direction in this local frame at rest = elbow's reference (parent-local).
    // Project the rotation onto this axis to keep only the twist; the residual swing
    // is absorbed by 左手首 since its parent chain includes 左手捩.
    const twist = Solver.twistAroundAxis(fullRotation, this.getRef('左ひじ'));

    return {
      name: '左手捩',
      rotation: twist,
    };
  }

  solveRightWristTwist() {
    const worldRightWrist = this.getRightHandLandmark('wrist');
    const worldRightIndex = this.getRightHandLandmark('index_mcp');
    const worldRightRing = this.getRightHandLandmark('ring_mcp');
    if (!worldRightWrist || !worldRightIndex || !worldRightRing)
      return { name: '右手捩', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const rightArmQuat = this.boneStates['right_arm'].rotation;
    const rightElbowQuat = this.boneStates['right_elbow'].rotation;

    const fullParentQuat = upperBodyQuat.multiply(rightArmQuat).multiply(rightElbowQuat);
    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localRightIndex = Vector3.TransformCoordinates(worldRightIndex, worldToFullParent);
    const localRightRing = Vector3.TransformCoordinates(worldRightRing, worldToFullParent);

    const handDirection = localRightIndex.subtract(localRightRing).normalize();
    const reference = this.getRef('右手捩');

    // See solveLeftWristTwist. Twist axis = forearm = right elbow's reference direction.
    const fullRotation = Quaternion.FromUnitVectorsToRef(reference, handDirection, new Quaternion());
    const twist = Solver.twistAroundAxis(fullRotation, this.getRef('右ひじ'));

    return {
      name: '右手捩',
      rotation: twist,
    };
  }

  solveLeftWrist() {
    const worldLeftWrist = this.getLeftHandLandmark('wrist');
    const worldLeftMiddleMcp = this.getLeftHandLandmark('middle_mcp');

    if (!worldLeftWrist || !worldLeftMiddleMcp) return { name: '左手首', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const leftArmQuat = this.boneStates['left_arm'].rotation;
    const leftElbowQuat = this.boneStates['left_elbow'].rotation;
    const leftWristTwistQuat = this.boneStates['left_wrist_twist'].rotation;

    const fullParentQuat = upperBodyQuat.multiply(leftArmQuat).multiply(leftElbowQuat).multiply(leftWristTwistQuat);
    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localLeftWrist = Vector3.TransformCoordinates(worldLeftWrist, worldToFullParent);
    const localLeftMiddleMcp = Vector3.TransformCoordinates(worldLeftMiddleMcp, worldToFullParent);

    const wristDirection = localLeftMiddleMcp.subtract(localLeftWrist).normalize();
    const reference = this.getRef('左手首');

    return {
      name: '左手首',
      rotation: Quaternion.FromUnitVectorsToRef(reference, wristDirection, new Quaternion()),
    };
  }

  solveRightWrist() {
    const worldRightWrist = this.getRightHandLandmark('wrist');
    const worldRightMiddleMcp = this.getRightHandLandmark('middle_mcp');

    if (!worldRightWrist || !worldRightMiddleMcp) return { name: '右手首', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const rightArmQuat = this.boneStates['right_arm'].rotation;
    const rightElbowQuat = this.boneStates['right_elbow'].rotation;
    const rightWristTwistQuat = this.boneStates['right_wrist_twist'].rotation;

    const fullParentQuat = upperBodyQuat.multiply(rightArmQuat).multiply(rightElbowQuat).multiply(rightWristTwistQuat);
    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localRightWrist = Vector3.TransformCoordinates(worldRightWrist, worldToFullParent);
    const localRightMiddleMcp = Vector3.TransformCoordinates(worldRightMiddleMcp, worldToFullParent);

    const wristDirection = localRightMiddleMcp.subtract(localRightWrist).normalize();
    const reference = this.getRef('右手首');

    return {
      name: '右手首',
      rotation: Quaternion.FromUnitVectorsToRef(reference, wristDirection, new Quaternion()),
    };
  }

  solveLeftThumb1() {
    const thumbMCP = this.getLeftHandLandmark('thumb_mcp');
    const thumbIP = this.getLeftHandLandmark('thumb_ip');
    if (!thumbMCP || !thumbIP) return { name: '左親指１', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const leftArmQuat = this.boneStates['left_arm'].rotation;
    const leftElbowQuat = this.boneStates['left_elbow'].rotation;
    const leftWristTwistQuat = this.boneStates['left_wrist_twist'].rotation;
    const leftWristQuat = this.boneStates['left_wrist'].rotation;

    const fullParentQuat = upperBodyQuat
      .multiply(leftArmQuat)
      .multiply(leftElbowQuat)
      .multiply(leftWristTwistQuat)
      .multiply(leftWristQuat);

    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localThumbMCP = Vector3.TransformCoordinates(thumbMCP, worldToFullParent);
    const localThumbIP = Vector3.TransformCoordinates(thumbIP, worldToFullParent);

    const thumbDirection = localThumbIP.subtract(localThumbMCP).normalize();
    const reference = this.getRef('左親指１');
    return {
      name: '左親指１',
      rotation: Quaternion.FromUnitVectorsToRef(reference, thumbDirection, new Quaternion()),
    };
  }

  solveLeftThumb2() {
    return this.solveFingerJoint('left_thumb_1', '左親指２', new Vector3(-1.0, -1.0, 0.0).normalize(), 0.85);
  }

  solveLeftIndex1() {
    const wrist = this.getLeftHandLandmark('wrist');
    const indexMCP = this.getLeftHandLandmark('index_mcp');
    const indexPIP = this.getLeftHandLandmark('index_pip');
    if (!wrist || !indexMCP || !indexPIP) return { name: '左人指１', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const leftArmQuat = this.boneStates['left_arm'].rotation;
    const leftElbowQuat = this.boneStates['left_elbow'].rotation;
    const leftWristTwistQuat = this.boneStates['left_wrist_twist'].rotation;
    const leftWristQuat = this.boneStates['left_wrist'].rotation;

    const fullParentQuat = upperBodyQuat
      .multiply(leftArmQuat)
      .multiply(leftElbowQuat)
      .multiply(leftWristTwistQuat)
      .multiply(leftWristQuat);

    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localIndexMCP = Vector3.TransformCoordinates(indexMCP, worldToFullParent);
    const localIndexPIP = Vector3.TransformCoordinates(indexPIP, worldToFullParent);

    const indexDirection = localIndexPIP.subtract(localIndexMCP).normalize();
    const reference = this.getRef('左人指１');

    return {
      name: '左人指１',
      rotation: Quaternion.FromUnitVectorsToRef(reference, indexDirection, new Quaternion()),
    };
  }

  solveLeftIndex2() {
    return this.solveFingerJoint('left_index_1', '左人指２', new Vector3(-0.031, 0.0, -0.993).normalize(), 0.9);
  }

  solveLeftIndex3() {
    return this.solveFingerJoint('left_index_1', '左人指３', new Vector3(-0.031, 0.0, -0.993).normalize(), 0.65);
  }

  solveLeftMiddle1() {
    const middleMCP = this.getLeftHandLandmark('middle_mcp');
    const middlePIP = this.getLeftHandLandmark('middle_pip');
    if (!middleMCP || !middlePIP) return { name: '左中指１', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const leftArmQuat = this.boneStates['left_arm'].rotation;
    const leftElbowQuat = this.boneStates['left_elbow'].rotation;
    const leftWristTwistQuat = this.boneStates['left_wrist_twist'].rotation;
    const leftWristQuat = this.boneStates['left_wrist'].rotation;

    const fullParentQuat = upperBodyQuat
      .multiply(leftArmQuat)
      .multiply(leftElbowQuat)
      .multiply(leftWristTwistQuat)
      .multiply(leftWristQuat);

    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localMiddleMCP = Vector3.TransformCoordinates(middleMCP, worldToFullParent);
    const localMiddlePIP = Vector3.TransformCoordinates(middlePIP, worldToFullParent);

    const middleDirection = localMiddlePIP.subtract(localMiddleMCP).normalize();
    const reference = this.getRef('左中指１');

    return {
      name: '左中指１',
      rotation: Quaternion.FromUnitVectorsToRef(reference, middleDirection, new Quaternion()),
    };
  }

  solveLeftMiddle2() {
    return this.solveFingerJoint('left_middle_1', '左中指２', new Vector3(0.03, 0.0, -0.996).normalize(), 0.9);
  }

  solveLeftMiddle3() {
    return this.solveFingerJoint('left_middle_1', '左中指３', new Vector3(0.03, 0.0, -0.996).normalize(), 0.65);
  }

  solveLeftRing1() {
    const ringMCP = this.getLeftHandLandmark('ring_mcp');
    const ringPIP = this.getLeftHandLandmark('ring_pip');
    if (!ringMCP || !ringPIP) return { name: '左薬指１', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const leftArmQuat = this.boneStates['left_arm'].rotation;
    const leftElbowQuat = this.boneStates['left_elbow'].rotation;
    const leftWristTwistQuat = this.boneStates['left_wrist_twist'].rotation;
    const leftWristQuat = this.boneStates['left_wrist'].rotation;

    const fullParentQuat = upperBodyQuat
      .multiply(leftArmQuat)
      .multiply(leftElbowQuat)
      .multiply(leftWristTwistQuat)
      .multiply(leftWristQuat);
    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localRingMCP = Vector3.TransformCoordinates(ringMCP, worldToFullParent);
    const localRingPIP = Vector3.TransformCoordinates(ringPIP, worldToFullParent);

    const ringDirection = localRingPIP.subtract(localRingMCP).normalize();
    const reference = this.getRef('左薬指１');

    return {
      name: '左薬指１',
      rotation: Quaternion.FromUnitVectorsToRef(reference, ringDirection, new Quaternion()),
    };
  }

  solveLeftRing2() {
    return this.solveFingerJoint('left_ring_1', '左薬指２', new Vector3(0.048, 0.0, 0.997).normalize(), 0.88);
  }

  solveLeftRing3() {
    return this.solveFingerJoint('left_ring_1', '左薬指３', new Vector3(0.048, 0.0, 0.997).normalize(), 0.6);
  }

  solveLeftPinky1() {
    const pinkyMCP = this.getLeftHandLandmark('pinky_mcp');
    const pinkyPIP = this.getLeftHandLandmark('pinky_pip');
    if (!pinkyMCP || !pinkyPIP) return { name: '左小指１', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const leftArmQuat = this.boneStates['left_arm'].rotation;
    const leftElbowQuat = this.boneStates['left_elbow'].rotation;
    const leftWristTwistQuat = this.boneStates['left_wrist_twist'].rotation;
    const leftWristQuat = this.boneStates['left_wrist'].rotation;

    const fullParentQuat = upperBodyQuat
      .multiply(leftArmQuat)
      .multiply(leftElbowQuat)
      .multiply(leftWristTwistQuat)
      .multiply(leftWristQuat);

    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localPinkyMCP = Vector3.TransformCoordinates(pinkyMCP, worldToFullParent);
    const localPinkyPIP = Vector3.TransformCoordinates(pinkyPIP, worldToFullParent);

    const pinkyDirection = localPinkyPIP.subtract(localPinkyMCP).normalize();
    const reference = this.getRef('左小指１');

    return {
      name: '左小指１',
      rotation: Quaternion.FromUnitVectorsToRef(reference, pinkyDirection, new Quaternion()),
    };
  }

  solveLeftPinky2() {
    return this.solveFingerJoint('left_pinky_1', '左小指２', new Vector3(0.088, 0.0, -0.997).normalize(), 0.85);
  }

  solveLeftPinky3() {
    return this.solveFingerJoint('left_pinky_1', '左小指３', new Vector3(0.088, 0.0, -0.997).normalize(), 0.55);
  }

  solveRightThumb1() {
    const thumbMCP = this.getRightHandLandmark('thumb_mcp');
    const thumbIP = this.getRightHandLandmark('thumb_ip');

    if (!thumbMCP || !thumbIP) return { name: '右親指１', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const rightArmQuat = this.boneStates['right_arm'].rotation;
    const rightElbowQuat = this.boneStates['right_elbow'].rotation;
    const rightWristTwistQuat = this.boneStates['right_wrist_twist'].rotation;
    const rightWristQuat = this.boneStates['right_wrist'].rotation;

    const fullParentQuat = upperBodyQuat
      .multiply(rightArmQuat)
      .multiply(rightElbowQuat)
      .multiply(rightWristTwistQuat)
      .multiply(rightWristQuat);

    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localThumbMCP = Vector3.TransformCoordinates(thumbMCP, worldToFullParent);
    const localThumbIP = Vector3.TransformCoordinates(thumbIP, worldToFullParent);

    const thumbDirection = localThumbIP.subtract(localThumbMCP).normalize();
    const reference = this.getRef('右親指１');

    return {
      name: '右親指１',
      rotation: Quaternion.FromUnitVectorsToRef(reference, thumbDirection, new Quaternion()),
    };
  }

  solveRightThumb2() {
    return this.solveFingerJoint('right_thumb_1', '右親指２', new Vector3(-1.0, 1.0, 0.0).normalize(), 0.85);
  }

  solveRightIndex1() {
    const indexMCP = this.getRightHandLandmark('index_mcp');
    const indexPIP = this.getRightHandLandmark('index_pip');
    if (!indexMCP || !indexPIP) return { name: '右人指１', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const rightArmQuat = this.boneStates['right_arm'].rotation;
    const rightElbowQuat = this.boneStates['right_elbow'].rotation;
    const rightWristQuat = this.boneStates['right_wrist'].rotation;
    const rightWristTwistQuat = this.boneStates['right_wrist_twist'].rotation;

    // Transform to wrist local space (NOT including wrist twist)
    const wristSpaceQuat = upperBodyQuat
      .multiply(rightArmQuat)
      .multiply(rightElbowQuat)
      .multiply(rightWristTwistQuat)
      .multiply(rightWristQuat);

    const wristSpaceMatrix = new Matrix();
    Matrix.FromQuaternionToRef(wristSpaceQuat, wristSpaceMatrix);
    const worldToWristSpace = wristSpaceMatrix.invert();

    const localIndexMCP = Vector3.TransformCoordinates(indexMCP, worldToWristSpace);
    const localIndexPIP = Vector3.TransformCoordinates(indexPIP, worldToWristSpace);

    const indexDirection = localIndexPIP.subtract(localIndexMCP).normalize();
    const reference = this.getRef('右人指１');

    return {
      name: '右人指１',
      rotation: Quaternion.FromUnitVectorsToRef(reference, indexDirection, new Quaternion()),
    };
  }

  solveRightIndex2() {
    return this.solveFingerJoint('right_index_1', '右人指２', new Vector3(-0.031, 0.0, 0.993).normalize(), 0.9);
  }

  solveRightIndex3() {
    return this.solveFingerJoint('right_index_1', '右人指３', new Vector3(-0.031, 0.0, 0.993).normalize(), 0.65);
  }

  solveRightMiddle1() {
    const middleMCP = this.getRightHandLandmark('middle_mcp');
    const middlePIP = this.getRightHandLandmark('middle_pip');
    if (!middleMCP || !middlePIP) return { name: '右中指１', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const rightArmQuat = this.boneStates['right_arm'].rotation;
    const rightElbowQuat = this.boneStates['right_elbow'].rotation;
    const rightWristTwistQuat = this.boneStates['right_wrist_twist'].rotation;
    const rightWristQuat = this.boneStates['right_wrist'].rotation;

    const fullParentQuat = upperBodyQuat
      .multiply(rightArmQuat)
      .multiply(rightElbowQuat)
      .multiply(rightWristTwistQuat)
      .multiply(rightWristQuat);

    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localMiddleMCP = Vector3.TransformCoordinates(middleMCP, worldToFullParent);
    const localMiddlePIP = Vector3.TransformCoordinates(middlePIP, worldToFullParent);

    const middleDirection = localMiddlePIP.subtract(localMiddleMCP).normalize();
    const reference = this.getRef('右中指１');

    return {
      name: '右中指１',
      rotation: Quaternion.FromUnitVectorsToRef(reference, middleDirection, new Quaternion()),
    };
  }

  solveRightMiddle2() {
    return this.solveFingerJoint('right_middle_1', '右中指２', new Vector3(0.03, 0.0, 0.996).normalize(), 0.9);
  }

  solveRightMiddle3() {
    return this.solveFingerJoint('right_middle_1', '右中指３', new Vector3(0.03, 0.0, 0.996).normalize(), 0.65);
  }

  solveRightRing1() {
    const ringMCP = this.getRightHandLandmark('ring_mcp');
    const ringPIP = this.getRightHandLandmark('ring_pip');
    if (!ringMCP || !ringPIP) return { name: '右薬指１', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const rightArmQuat = this.boneStates['right_arm'].rotation;
    const rightElbowQuat = this.boneStates['right_elbow'].rotation;
    const rightWristTwistQuat = this.boneStates['right_wrist_twist'].rotation;
    const rightWristQuat = this.boneStates['right_wrist'].rotation;

    const fullParentQuat = upperBodyQuat
      .multiply(rightArmQuat)
      .multiply(rightElbowQuat)
      .multiply(rightWristTwistQuat)
      .multiply(rightWristQuat);

    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localRingMCP = Vector3.TransformCoordinates(ringMCP, worldToFullParent);
    const localRingPIP = Vector3.TransformCoordinates(ringPIP, worldToFullParent);

    const ringDirection = localRingPIP.subtract(localRingMCP).normalize();
    const reference = this.getRef('右薬指１');

    return {
      name: '右薬指１',
      rotation: Quaternion.FromUnitVectorsToRef(reference, ringDirection, new Quaternion()),
    };
  }

  solveRightRing2() {
    return this.solveFingerJoint('right_ring_1', '右薬指２', new Vector3(0.048, 0.0, 0.997).normalize(), 0.88);
  }

  solveRightRing3() {
    return this.solveFingerJoint('right_ring_1', '右薬指３', new Vector3(0.048, 0.0, 0.997).normalize(), 0.6);
  }

  solveRightPinky1() {
    const pinkyMCP = this.getRightHandLandmark('pinky_mcp');
    const pinkyPIP = this.getRightHandLandmark('pinky_pip');
    if (!pinkyMCP || !pinkyPIP) return { name: '右小指１', rotation: Quaternion.Identity() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const rightArmQuat = this.boneStates['right_arm'].rotation;
    const rightElbowQuat = this.boneStates['right_elbow'].rotation;
    const rightWristQuat = this.boneStates['right_wrist'].rotation;
    const rightWristTwistQuat = this.boneStates['right_wrist_twist'].rotation;

    const fullParentQuat = upperBodyQuat
      .multiply(rightArmQuat)
      .multiply(rightElbowQuat)
      .multiply(rightWristTwistQuat)
      .multiply(rightWristQuat);

    const fullParentMatrix = new Matrix();
    Matrix.FromQuaternionToRef(fullParentQuat, fullParentMatrix);
    const worldToFullParent = fullParentMatrix.invert();

    const localPinkyMCP = Vector3.TransformCoordinates(pinkyMCP, worldToFullParent);
    const localPinkyPIP = Vector3.TransformCoordinates(pinkyPIP, worldToFullParent);

    const pinkyDirection = localPinkyPIP.subtract(localPinkyMCP).normalize();
    const reference = this.getRef('右小指１');

    return {
      name: '右小指１',
      rotation: Quaternion.FromUnitVectorsToRef(reference, pinkyDirection, new Quaternion()),
    };
  }

  solveRightPinky2() {
    return this.solveFingerJoint('right_pinky_1', '右小指２', new Vector3(0.088, 0.0, 0.997).normalize(), 0.85);
  }

  solveRightPinky3() {
    return this.solveFingerJoint('right_pinky_1', '右小指３', new Vector3(0.088, 0.0, 0.997).normalize(), 0.55);
  }

  solveFingerJoint(baseJointName, jointName, bendAxis, ratio) {
    // Extract bend degrees from base joint quaternion
    const baseRotation = this.boneStates[baseJointName].rotation;
    const bendDegrees = this.extractBendDegrees(baseRotation, bendAxis);

    // Apply ratio to get degrees for this joint
    const adjustedDegrees = bendDegrees * ratio;

    // Create quaternion directly from degrees (following MPL approach)
    const radians = (adjustedDegrees * Math.PI) / 180;
    const halfAngle = radians / 2;
    const sin = Math.sin(halfAngle);
    const cos = Math.cos(halfAngle);

    const rotation = new Quaternion(bendAxis.x * sin, bendAxis.y * sin, bendAxis.z * sin, cos);

    return {
      name: jointName,
      rotation: rotation,
    };
  }

  extractBendDegrees(quat, bendAxis) {
    // Extract the total rotation angle from quaternion in degrees
    const totalAngle = 2 * Math.acos(Math.abs(quat.w)) * (180 / Math.PI);

    // Determine the sign based on the bend axis component
    const axisComponent = quat.x * bendAxis.x + quat.y * bendAxis.y + quat.z * bendAxis.z;
    const sign = axisComponent < 0 ? -1 : 1;

    return totalAngle * sign;
  }
}

// ==================== VPD 烘焙器（照搬 MiKaPo VpdWriter） ====================
import Encoding from 'encoding-japanese';

class VpdWriter {
  static _Signature = 'Vocaloid Pose Data file';

  static encodeShiftJIS(str) {
    const unicodeArray = Encoding.stringToCode(str);
    const sjisArray = Encoding.convert(unicodeArray, {
      to: 'SJIS',
      from: 'UNICODE',
    });
    return new Uint8Array(sjisArray);
  }

  static ConvertToVpdBlob(poseData, modelName = 'Model') {
    const lines = [];
    lines.push(this._Signature);
    lines.push('');
    lines.push(`${modelName};\t\t// モデルファイル名`);
    lines.push(`${poseData.length};\t\t\t// ボーンフレーム数`);
    lines.push('');
    poseData.forEach((boneState, index) => {
      lines.push(`Bone${index}{${boneState.name}`);
      lines.push(`  0.000000,0.000000,0.000000;\t\t\t\t// trans x,y,z`);
      lines.push(
        `  ${boneState.rotation.x},${boneState.rotation.y},${boneState.rotation.z},${boneState.rotation.w};\t\t// Quaternion x,y,z,w`
      );
      lines.push(`}`);
      lines.push('');
    });
    const content = lines.join('\n');
    const sjisBytes = this.encodeShiftJIS(content);
    return new Blob([sjisBytes.buffer], { type: 'text/plain; charset=shift_jis' });
  }
}
