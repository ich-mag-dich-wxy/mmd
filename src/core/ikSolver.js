// ═══════════════════════════════════════════════════════════
//  MMD 动作捕捉求解器 — 移植自 MiKaPo 项目
//
//  核心架构（与 MiKaPo 完全一致）:
//    1. 所有计算在 MiKaPo/Babylon.js 坐标系中进行（x, -y, z）
//    2. lower_body / upper_body 存储【世界旋转】（Gram-Schmidt 基）
//    3. 其他骨骼在父链世界空间中计算【局部旋转】
//    4. 输出时将 upper_body 转为局部旋转，并将四元数从
//       Babylon.js 坐标系转换到 three.js 坐标系（z 翻转 = x/y 取反）
//
//  坐标系说明:
//    MediaPipe: x 右, y 下, z 靠近相机
//    MiKaPo (Babylon.js 左手系): x 右, y 上, z 朝向相机 = MMD 前方
//    three.js (右手系): x 右, y 上, z 朝向相机, MMD 前方 = -Z
//    landmark → Vector3: (x, -y, z)  [只翻转 y，与 MiKaPo 一致]
//    输出四元数: (-qx, -qy, qz, qw)  [Babylon → three.js]
// ═══════════════════════════════════════════════════════════

import * as THREE from 'three';

// ── MediaPipe Pose 关键点索引 ──
const P = {
  nose: 0, l_eye_inner: 1, l_eye: 2, l_eye_outer: 3,
  r_eye_inner: 4, r_eye: 5, r_eye_outer: 6,
  l_ear: 7, r_ear: 8, mouth_l: 9, mouth_r: 10,
  l_shoulder: 11, r_shoulder: 12, l_elbow: 13, r_elbow: 14,
  l_wrist: 15, r_wrist: 16, l_pinky: 17, r_pinky: 18,
  l_index: 19, r_index: 20, l_thumb: 21, r_thumb: 22,
  l_hip: 23, r_hip: 24, l_knee: 25, r_knee: 26,
  l_ankle: 27, r_ankle: 28, l_heel: 29, r_heel: 30,
  l_foot_index: 31, r_foot_index: 32,
};

// ── MediaPipe Hand 关键点索引 ──
const H = {
  wrist: 0,
  thumb_cmc: 1, thumb_mcp: 2, thumb_ip: 3, thumb_tip: 4,
  index_mcp: 5, index_pip: 6, index_dip: 7, index_tip: 8,
  middle_mcp: 9, middle_pip: 10, middle_dip: 11, middle_tip: 12,
  ring_mcp: 13, ring_pip: 14, ring_dip: 15, ring_tip: 16,
  pinky_mcp: 17, pinky_pip: 18, pinky_dip: 19, pinky_tip: 20,
};

// ── 默认参考方向（MiKaPo 原始值，Babylon.js 坐标系）──
const DEFAULT_REFS = {
  '左腕': new THREE.Vector3(0.80917156, -0.58753001, 0.00706277).normalize(),
  '右腕': new THREE.Vector3(-0.80917129, -0.58753035, 0.00706463).normalize(),
  '左ひじ': new THREE.Vector3(0.80886214, -0.58772615, 0.01788871).normalize(),
  '右ひじ': new THREE.Vector3(-0.80886264, -0.58772542, 0.01789011).normalize(),
  '左足': new THREE.Vector3(-0.01338665, -0.99819434, -0.05855645).normalize(),
  '右足': new THREE.Vector3(0.01338609, -0.99819433, -0.05855677).normalize(),
  '左ひざ': new THREE.Vector3(-0.01333798, -0.98954426, -0.14361147).normalize(),
  '右ひざ': new THREE.Vector3(0.01333724, -0.98954425, -0.14361163).normalize(),
  '左足首': new THREE.Vector3(0.00000064, -0.80765191, 0.58965955).normalize(),
  '右足首': new THREE.Vector3(0.00000054, -0.80765185, 0.58965964).normalize(),
  '首': new THREE.Vector3(0.00000258, 0.97346054, 0.22885491).normalize(),
  '左手首': new THREE.Vector3(0.81635913, -0.57754444, 0.00043314).normalize(),
  '右手首': new THREE.Vector3(-0.81635927, -0.57754425, 0.00043491).normalize(),
  '左親指１': new THREE.Vector3(0.62716533, -0.72577692, 0.28268623).normalize(),
  '右親指１': new THREE.Vector3(-0.62716428, -0.72578107, 0.28267792).normalize(),
  '左人指１': new THREE.Vector3(0.84121176, -0.54001806, -0.02726296).normalize(),
  '右人指１': new THREE.Vector3(-0.84121092, -0.54001943, -0.02726177).normalize(),
  '左中指１': new THREE.Vector3(0.82851523, -0.55942638, -0.02458950).normalize(),
  '右中指１': new THREE.Vector3(-0.82851643, -0.55942465, -0.02458833).normalize(),
  '左薬指１': new THREE.Vector3(0.80448878, -0.59258445, -0.04051516).normalize(),
  '右薬指１': new THREE.Vector3(-0.80448680, -0.59258726, -0.04051333).normalize(),
  '左小指１': new THREE.Vector3(0.86110206, -0.49661517, -0.10897986).normalize(),
  '右小指１': new THREE.Vector3(-0.86110169, -0.49661597, -0.10897917).normalize(),
  '左手捩': new THREE.Vector3(0, 0, 1).normalize(),
  '右手捩': new THREE.Vector3(0, 0, 1).normalize(),
};

// ═══════════════════════════════════════════════════════════
//  One-Euro Filter（带半球翻转）
// ═══════════════════════════════════════════════════════════

class OneEuroFilter1D {
  constructor(minCutoff = 1.5, beta = 0.5, dCutoff = 1.0) {
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
    const aD = OneEuroFilter1D.smoothing(this.dCutoff, dt);
    const filteredDeriv = aD * rawDeriv + (1 - aD) * this.prevDeriv;

    const cutoff = this.minCutoff + this.beta * Math.abs(filteredDeriv);
    const a = OneEuroFilter1D.smoothing(cutoff, dt);
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
  constructor(minCutoff = 1.5, beta = 0.5, dCutoff = 1.0) {
    this.fx = new OneEuroFilter1D(minCutoff, beta, dCutoff);
    this.fy = new OneEuroFilter1D(minCutoff, beta, dCutoff);
    this.fz = new OneEuroFilter1D(minCutoff, beta, dCutoff);
    this.fw = new OneEuroFilter1D(minCutoff, beta, dCutoff);
    this.prev = null;
  }

  filter(q, ts) {
    let x = q.x, y = q.y, z = q.z, w = q.w;
    if (this.prev) {
      const dot = this.prev.x * x + this.prev.y * y + this.prev.z * z + this.prev.w * w;
      if (dot < 0) { x = -x; y = -y; z = -z; w = -w; }
    }
    const out = new THREE.Quaternion(
      this.fx.filter(x, ts),
      this.fy.filter(y, ts),
      this.fz.filter(z, ts),
      this.fw.filter(w, ts),
    );
    out.normalize();
    this.prev = out.clone();
    return out;
  }

  reset() {
    this.fx.reset(); this.fy.reset(); this.fz.reset(); this.fw.reset();
    this.prev = null;
  }
}

// ═══════════════════════════════════════════════════════════
//  Solver 主类
// ═══════════════════════════════════════════════════════════

const _v3a = new THREE.Vector3();
const _v3b = new THREE.Vector3();
const _v3c = new THREE.Vector3();
const _qA = new THREE.Quaternion();
const _matA = new THREE.Matrix4();

export class IKSolver {
  constructor() {
    this.poseWorldLandmarks = null;
    this.leftHandWorldLandmarks = null;
    this.rightHandWorldLandmarks = null;
    this.boneStates = {};
    this.filters = {};
    this.smoothing = { minCutoff: 1.5, beta: 0.5, dCutoff: 1.0 };
    this.refs = {};
  }

  reset() {
    for (const key of Object.keys(this.filters)) {
      this.filters[key].reset();
    }
  }

  /**
   * 从模型 rest pose 校准参考方向
   * restWorldPos 是 three.js 坐标系的世界位置，需转到 MiKaPo 坐标系（翻转 Z）
   */
  calibrate(restWorldPos) {
    const dir = (parent, child) => {
      const p = restWorldPos[parent];
      const c = restWorldPos[child];
      if (!p || !c) return null;
      // three.js → MiKaPo 坐标系：翻转 Z
      const v = new THREE.Vector3(c.x - p.x, c.y - p.y, -(c.z - p.z));
      const len = v.length();
      if (len < 1e-6) return null;
      return v.multiplyScalar(1 / len);
    };
    const set = (key, v) => { if (v) this.refs[key] = v; };

    set('左腕', dir('左腕', '左ひじ'));
    set('右腕', dir('右腕', '右ひじ'));
    set('左ひじ', dir('左ひじ', '左手首'));
    set('右ひじ', dir('右ひじ', '右手首'));
    set('左足', dir('左足', '左ひざ'));
    set('右足', dir('右足', '右ひざ'));
    set('左ひざ', dir('左ひざ', '左足首'));
    set('右ひざ', dir('右ひざ', '右足首'));
    set('左足首', dir('左足首', '左つま先'));
    set('右足首', dir('右足首', '右つま先'));
    set('首', dir('首', '頭'));
    set('左手首', dir('左手首', '左中指１'));
    set('右手首', dir('右手首', '右中指１'));
    set('左手捩', dir('左薬指１', '左人指１'));
    set('右手捩', dir('右薬指１', '右人指１'));
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

    console.log('[IK Solver] 校准完成，参考方向数:', Object.keys(this.refs).length);
  }

  getRef(key) {
    return this.refs[key] || DEFAULT_REFS[key] || new THREE.Vector3(0, 1, 0);
  }

  static twistAroundAxis(q, a) {
    const d = q.x * a.x + q.y * a.y + q.z * a.z;
    const px = a.x * d;
    const py = a.y * d;
    const pz = a.z * d;
    const len = Math.sqrt(px * px + py * py + pz * pz + q.w * q.w);
    if (len < 1e-8) return new THREE.Quaternion();
    return new THREE.Quaternion(px / len, py / len, pz / len, q.w / len);
  }

  solve(result) {
    this.boneStates = {};
    this.poseWorldLandmarks = null;
    this.leftHandWorldLandmarks = null;
    this.rightHandWorldLandmarks = null;

    if (result.poseWorldLandmarks && result.poseWorldLandmarks.length > 0 &&
        result.poseWorldLandmarks[0].length === 33) {
      this.poseWorldLandmarks = result.poseWorldLandmarks[0];
    }
    if (result.leftHandWorldLandmarks && result.leftHandWorldLandmarks.length > 0 &&
        result.leftHandWorldLandmarks[0].length === 21) {
      this.leftHandWorldLandmarks = result.leftHandWorldLandmarks[0];
    }
    if (result.rightHandWorldLandmarks && result.rightHandWorldLandmarks.length > 0 &&
        result.rightHandWorldLandmarks[0].length === 21) {
      this.rightHandWorldLandmarks = result.rightHandWorldLandmarks[0];
    }

    if (!this.poseWorldLandmarks) return {};

    // 按层级顺序求解（所有计算在 MiKaPo/Babylon.js 坐标系中）
    this.boneStates['lower_body'] = this._solveLowerBody();
    this.boneStates['upper_body'] = this._solveUpperBody();
    this.boneStates['neck'] = this._solveNeck();
    this.boneStates['head'] = this._solveHead();
    this.boneStates['left_leg'] = this._solveLeg('left');
    this.boneStates['right_leg'] = this._solveLeg('right');
    this.boneStates['left_knee'] = this._solveKnee('left');
    this.boneStates['right_knee'] = this._solveKnee('right');
    this.boneStates['left_ankle'] = this._solveAnkle('left');
    this.boneStates['right_ankle'] = this._solveAnkle('right');
    this.boneStates['left_arm'] = this._solveArm('left');
    this.boneStates['right_arm'] = this._solveArm('right');
    this.boneStates['left_elbow'] = this._solveElbow('left');
    this.boneStates['right_elbow'] = this._solveElbow('right');
    this.boneStates['left_wrist_twist'] = this._solveWristTwist('left');
    this.boneStates['right_wrist_twist'] = this._solveWristTwist('right');
    this.boneStates['left_wrist'] = this._solveWrist('left');
    this.boneStates['right_wrist'] = this._solveWrist('right');

    this._solveAllFingers('left');
    this._solveAllFingers('right');

    // One-Euro 滤波后处理（在 MiKaPo 坐标系中滤波）
    // 注意：skip 标记的骨骼保留上一帧滤波结果，不重新滤波
    const ts = performance.now();
    for (const key of Object.keys(this.boneStates)) {
      if (this.boneStates[key].skip) continue; // 跳过：保留上一帧旋转
      if (!this.filters[key]) {
        this.filters[key] = new QuaternionOneEuroFilter(
          this.smoothing.minCutoff, this.smoothing.beta, this.smoothing.dCutoff);
      }
      this.boneStates[key].rotation = this.filters[key].filter(this.boneStates[key].rotation, ts);
    }

    // 输出：转换为 骨骼名 → 四元数
    // 1. upper_body 从世界旋转转为局部旋转
    // 2. 所有四元数从 MiKaPo/Babylon.js 坐标系转到 three.js 坐标系（x/y 取反）
    // 3. skip 标记的骨骼不输出（让 adapter 保留上一帧）
    const result_map = {};
    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    for (const [key, bs] of Object.entries(this.boneStates)) {
      if (bs.skip) continue; // 跳过：不输出，保留上一帧
      let q = bs.rotation;
      if (key === 'upper_body') {
        q = _qA.copy(lowerBodyQuat).invert().multiply(q);
      }
      // MiKaPo(Babylon.js, z) → three.js(z=-z): 四元数 x/y 取反
      result_map[bs.name] = new THREE.Quaternion(-q.x, -q.y, q.z, q.w);
    }

    // 调试日志：每 60 帧打印一次关键骨骼旋转
    if (!this._dbgCounter) this._dbgCounter = 0;
    this._dbgCounter++;
    if (this._dbgCounter % 60 === 1) {
      const fmt = (q) => `(${q.x.toFixed(3)},${q.y.toFixed(3)},${q.z.toFixed(3)},${q.w.toFixed(3)})`;
      console.log('[IK Debug] lower_body:', fmt(this.boneStates['lower_body'].rotation));
      console.log('[IK Debug] left_leg:', fmt(this.boneStates['left_leg'].rotation));
      console.log('[IK Debug] right_leg:', fmt(this.boneStates['right_leg'].rotation));
      console.log('[IK Debug] left_knee:', fmt(this.boneStates['left_knee'].rotation));
      console.log('[IK Debug] right_knee:', fmt(this.boneStates['right_knee'].rotation));
      console.log('[IK Debug] output 左足:', fmt(result_map['左足']));
      console.log('[IK Debug] output 右足:', fmt(result_map['右足']));
    }

    return result_map;
  }

  // ── landmark → Vector3（与 MiKaPo 一致：只翻转 Y）──
  _lmToV3(landmark) {
    if (!landmark) return null;
    return new THREE.Vector3(landmark.x, -landmark.y, landmark.z);
  }

  _getPose(idx) {
    if (!this.poseWorldLandmarks) return null;
    return this._lmToV3(this.poseWorldLandmarks[idx]);
  }

  // 检查 landmark 可见度（MediaPipe poseWorldLandmarks 有 visibility 字段）
  _getVisibility(idx) {
    if (!this.poseWorldLandmarks) return 0;
    const lm = this.poseWorldLandmarks[idx];
    if (!lm) return 0;
    return lm.visibility !== undefined ? lm.visibility : 1;
  }

  // 可见度阈值：低于此值认为 landmark 不可靠
  static VISIBILITY_THRESHOLD = 0.5;

  _getHandLandmark(side, idx) {
    const lms = side === 'left' ? this.leftHandWorldLandmarks : this.rightHandWorldLandmarks;
    if (!lms) return null;
    return this._lmToV3(lms[idx]);
  }

  // ── 下半身（Gram-Schmidt 3 轴基，世界旋转）──
  // 注意: MiKaPo 用 Babylon.js 行优先矩阵，three.js makeBasis 是列优先
  // 所以需要转置（axis 作为行而非列）
  _solveLowerBody() {
    const lHip = this._getPose(P.l_hip);
    const rHip = this._getPose(P.r_hip);
    const lShoulder = this._getPose(P.l_shoulder);
    const rShoulder = this._getPose(P.r_shoulder);
    if (!lHip || !rHip || !lShoulder || !rShoulder) {
      return { name: '下半身', rotation: new THREE.Quaternion() };
    }

    const shoulderCenter = _v3a.addVectors(lShoulder, rShoulder).multiplyScalar(0.5);
    const hipCenter = _v3b.addVectors(lHip, rHip).multiplyScalar(0.5);
    const spineY = _v3c.subVectors(shoulderCenter, hipCenter).normalize();

    const rawHipX = new THREE.Vector3().subVectors(lHip, rHip).normalize();
    const hipX = rawHipX.sub(spineY.clone().multiplyScalar(rawHipX.dot(spineY))).normalize();
    const hipZ = new THREE.Vector3().crossVectors(hipX, spineY).normalize();

    // three.js 用列向量约定 (M*v)，轴应作为列 → 用 makeBasis
    // (Babylon.js 用行向量 v*M，轴作为行 → Matrix.FromValues)
    // 两者等价：makeBasis(x,y,z) in three.js == FromValues(x,y,z,...) in Babylon.js
    const m = new THREE.Matrix4().makeBasis(hipX, spineY, hipZ);
    const rotation = new THREE.Quaternion();
    m.decompose(new THREE.Vector3(), rotation, new THREE.Vector3());
    return { name: '下半身', rotation };
  }

  // ── 上半身（Gram-Schmidt 世界旋转）──
  _solveUpperBody() {
    const lShoulder = this._getPose(P.l_shoulder);
    const rShoulder = this._getPose(P.r_shoulder);
    if (!lShoulder || !rShoulder) {
      return { name: '上半身', rotation: new THREE.Quaternion() };
    }

    const shoulderCenter = _v3a.addVectors(lShoulder, rShoulder).multiplyScalar(0.5);
    const spineY = shoulderCenter.clone().normalize();

    const rawShoulderX = new THREE.Vector3().subVectors(lShoulder, rShoulder).normalize();
    const shoulderX = rawShoulderX.sub(spineY.clone().multiplyScalar(rawShoulderX.dot(spineY))).normalize();
    const upperBodyZ = new THREE.Vector3().crossVectors(shoulderX, spineY).normalize();

    // three.js 列向量约定：用 makeBasis（轴作为列）
    const m = new THREE.Matrix4().makeBasis(shoulderX, spineY, upperBodyZ);
    const rotation = new THREE.Quaternion();
    m.decompose(new THREE.Vector3(), rotation, new THREE.Vector3());
    return { name: '上半身', rotation };
  }

  // ── 颈部 ──
  _solveNeck() {
    const lEar = this._getPose(P.l_ear);
    const rEar = this._getPose(P.r_ear);
    const lShoulder = this._getPose(P.l_shoulder);
    const rShoulder = this._getPose(P.r_shoulder);
    if (!lEar || !rEar || !lShoulder || !rShoulder) {
      return { name: '首', rotation: new THREE.Quaternion() };
    }

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const invMat = _matA.makeRotationFromQuaternion(upperBodyQuat).invert();

    const localLEar = lEar.clone().applyMatrix4(invMat);
    const localREar = rEar.clone().applyMatrix4(invMat);
    const localLShoulder = lShoulder.clone().applyMatrix4(invMat);
    const localRShoulder = rShoulder.clone().applyMatrix4(invMat);

    const localEarCenter = _v3a.addVectors(localLEar, localREar).multiplyScalar(0.5);
    const localShoulderCenter = _v3b.addVectors(localLShoulder, localRShoulder).multiplyScalar(0.5);
    const neckDir = _v3c.subVectors(localEarCenter, localShoulderCenter).normalize();
    const ref = this.getRef('首');

    return { name: '首', rotation: new THREE.Quaternion().setFromUnitVectors(ref, neckDir) };
  }

  // ── 头部（Gram-Schmidt）──
  _solveHead() {
    const lEar = this._getPose(P.l_ear);
    const rEar = this._getPose(P.r_ear);
    const lEye = this._getPose(P.l_eye);
    const rEye = this._getPose(P.r_eye);
    if (!lEar || !rEar || !lEye || !rEye) {
      return { name: '頭', rotation: new THREE.Quaternion() };
    }

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const neckQuat = this.boneStates['neck'].rotation;
    const fullParent = _qA.multiplyQuaternions(upperBodyQuat, neckQuat);
    const invMat = _matA.makeRotationFromQuaternion(fullParent).invert();

    const localLEar = lEar.clone().applyMatrix4(invMat);
    const localREar = rEar.clone().applyMatrix4(invMat);
    const localLEye = lEye.clone().applyMatrix4(invMat);
    const localREye = rEye.clone().applyMatrix4(invMat);

    const localEarCenter = _v3a.addVectors(localLEar, localREar).multiplyScalar(0.5);
    const localEyeCenter = _v3b.addVectors(localLEye, localREye).multiplyScalar(0.5);

    const earX = new THREE.Vector3().subVectors(localLEar, localREar).normalize();
    const back = _v3c.subVectors(localEarCenter, localEyeCenter).normalize();
    const headX = earX.sub(back.clone().multiplyScalar(earX.dot(back))).normalize();
    const headY = new THREE.Vector3().crossVectors(back, headX).normalize();

    // three.js 列向量约定：用 makeBasis（轴作为列）
    const m = new THREE.Matrix4().makeBasis(headX, headY, back);
    const rotation = new THREE.Quaternion();
    m.decompose(new THREE.Vector3(), rotation, new THREE.Vector3());
    return { name: '頭', rotation };
  }

  // ── 腿 ──
  _solveLeg(side) {
    const hipIdx = side === 'left' ? P.l_hip : P.r_hip;
    const kneeIdx = side === 'left' ? P.l_knee : P.r_knee;
    const boneName = side === 'left' ? '左足' : '右足';

    const hip = this._getPose(hipIdx);
    const knee = this._getPose(kneeIdx);
    if (!hip || !knee) return { name: boneName, rotation: new THREE.Quaternion(), skip: true };

    // 可见度检查：髋/膝任一不可见时跳过更新（保留上一帧旋转）
    const hipVis = this._getVisibility(hipIdx);
    const kneeVis = this._getVisibility(kneeIdx);
    if (hipVis < IKSolver.VISIBILITY_THRESHOLD || kneeVis < IKSolver.VISIBILITY_THRESHOLD) {
      return { name: boneName, rotation: new THREE.Quaternion(), skip: true };
    }

    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    const invMat = _matA.makeRotationFromQuaternion(lowerBodyQuat).invert();
    const localHip = hip.clone().applyMatrix4(invMat);
    const localKnee = knee.clone().applyMatrix4(invMat);
    const dir = _v3a.subVectors(localKnee, localHip).normalize();
    const ref = this.getRef(boneName);

    // 调试日志
    if (!this._legDbgCounter) this._legDbgCounter = 0;
    this._legDbgCounter++;
    if (this._legDbgCounter % 60 === 1) {
      console.log(`[IK Leg ${side}] ref: (${ref.x.toFixed(3)},${ref.y.toFixed(3)},${ref.z.toFixed(3)}) dir: (${dir.x.toFixed(3)},${dir.y.toFixed(3)},${dir.z.toFixed(3)}) dot: ${ref.dot(dir).toFixed(3)} vis: hip=${hipVis.toFixed(2)} knee=${kneeVis.toFixed(2)}`);
    }

    return { name: boneName, rotation: IKSolver._safeSetFromUnitVectors(ref, dir) };
  }

  // ── 膝盖 ──
  _solveKnee(side) {
    const kneeIdx = side === 'left' ? P.l_knee : P.r_knee;
    const ankleIdx = side === 'left' ? P.l_ankle : P.r_ankle;
    const boneName = side === 'left' ? '左ひざ' : '右ひざ';
    const legKey = side === 'left' ? 'left_leg' : 'right_leg';

    const knee = this._getPose(kneeIdx);
    const ankle = this._getPose(ankleIdx);
    if (!knee || !ankle) return { name: boneName, rotation: new THREE.Quaternion(), skip: true };

    // 可见度检查
    const kneeVis = this._getVisibility(kneeIdx);
    const ankleVis = this._getVisibility(ankleIdx);
    if (kneeVis < IKSolver.VISIBILITY_THRESHOLD || ankleVis < IKSolver.VISIBILITY_THRESHOLD) {
      return { name: boneName, rotation: new THREE.Quaternion(), skip: true };
    }

    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    const legQuat = this.boneStates[legKey].rotation;
    const fullParent = _qA.multiplyQuaternions(lowerBodyQuat, legQuat);
    const invMat = _matA.makeRotationFromQuaternion(fullParent).invert();
    const localKnee = knee.clone().applyMatrix4(invMat);
    const localAnkle = ankle.clone().applyMatrix4(invMat);
    const dir = _v3a.subVectors(localAnkle, localKnee).normalize();
    const ref = this.getRef(boneName);

    return { name: boneName, rotation: IKSolver._safeSetFromUnitVectors(ref, dir) };
  }

  // ── 脚踝 ──
  _solveAnkle(side) {
    const ankleIdx = side === 'left' ? P.l_ankle : P.r_ankle;
    const footIdx = side === 'left' ? P.l_foot_index : P.r_foot_index;
    const boneName = side === 'left' ? '左足首' : '右足首';
    const legKey = side === 'left' ? 'left_leg' : 'right_leg';
    const kneeKey = side === 'left' ? 'left_knee' : 'right_knee';

    const ankle = this._getPose(ankleIdx);
    const foot = this._getPose(footIdx);
    if (!ankle || !foot) return { name: boneName, rotation: new THREE.Quaternion(), skip: true };

    // 可见度检查
    const ankleVis = this._getVisibility(ankleIdx);
    const footVis = this._getVisibility(footIdx);
    if (ankleVis < IKSolver.VISIBILITY_THRESHOLD || footVis < IKSolver.VISIBILITY_THRESHOLD) {
      return { name: boneName, rotation: new THREE.Quaternion(), skip: true };
    }

    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    const legQuat = this.boneStates[legKey].rotation;
    const kneeQuat = this.boneStates[kneeKey].rotation;
    const fullParent = new THREE.Quaternion().multiplyQuaternions(
      new THREE.Quaternion().multiplyQuaternions(lowerBodyQuat, legQuat), kneeQuat);
    const invMat = _matA.makeRotationFromQuaternion(fullParent).invert();
    const localAnkle = ankle.clone().applyMatrix4(invMat);
    const localFoot = foot.clone().applyMatrix4(invMat);
    const dir = _v3a.subVectors(localFoot, localAnkle).normalize();
    const ref = this.getRef(boneName);

    return { name: boneName, rotation: IKSolver._safeSetFromUnitVectors(ref, dir) };
  }

  // setFromUnitVectors 的稳定版本：当两个向量近似反向时，
  // 选择一个稳定的垂直轴来避免翻转
  static _safeSetFromUnitVectors(from, to) {
    const dot = from.dot(to);
    if (dot > 0.999999) {
      return new THREE.Quaternion(); // 几乎相同，返回 identity
    }
    if (dot < -0.999999) {
      // 近似反向：180° 旋转，选择一个稳定的垂直轴
      let axis;
      if (Math.abs(from.x) < 0.9) {
        axis = new THREE.Vector3(1, 0, 0);
      } else {
        axis = new THREE.Vector3(0, 1, 0);
      }
      axis.sub(from.clone().multiplyScalar(from.dot(axis))).normalize();
      return new THREE.Quaternion(axis.x, axis.y, axis.z, 0);
    }
    return new THREE.Quaternion().setFromUnitVectors(from, to);
  }

  // ── 手臂 ──
  _solveArm(side) {
    const shoulderIdx = side === 'left' ? P.l_shoulder : P.r_shoulder;
    const elbowIdx = side === 'left' ? P.l_elbow : P.r_elbow;
    const boneName = side === 'left' ? '左腕' : '右腕';

    const shoulder = this._getPose(shoulderIdx);
    const elbow = this._getPose(elbowIdx);
    if (!shoulder || !elbow) return { name: boneName, rotation: new THREE.Quaternion() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const invMat = _matA.makeRotationFromQuaternion(upperBodyQuat).invert();
    const localShoulder = shoulder.clone().applyMatrix4(invMat);
    const localElbow = elbow.clone().applyMatrix4(invMat);
    const dir = _v3a.subVectors(localElbow, localShoulder).normalize();
    const ref = this.getRef(boneName);

    return { name: boneName, rotation: new THREE.Quaternion().setFromUnitVectors(ref, dir) };
  }

  // ── 肘部 ──
  _solveElbow(side) {
    const elbowIdx = side === 'left' ? P.l_elbow : P.r_elbow;
    const wristIdx = side === 'left' ? P.l_wrist : P.r_wrist;
    const boneName = side === 'left' ? '左ひじ' : '右ひじ';
    const armKey = side === 'left' ? 'left_arm' : 'right_arm';

    const elbow = this._getPose(elbowIdx);
    const wrist = this._getPose(wristIdx);
    if (!elbow || !wrist) return { name: boneName, rotation: new THREE.Quaternion() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const armQuat = this.boneStates[armKey].rotation;
    const fullParent = _qA.multiplyQuaternions(upperBodyQuat, armQuat);
    const invMat = _matA.makeRotationFromQuaternion(fullParent).invert();
    const localElbow = elbow.clone().applyMatrix4(invMat);
    const localWrist = wrist.clone().applyMatrix4(invMat);
    const dir = _v3a.subVectors(localWrist, localElbow).normalize();
    const ref = this.getRef(boneName);

    return { name: boneName, rotation: new THREE.Quaternion().setFromUnitVectors(ref, dir) };
  }

  // ── 手腕扭转（Swing-Twist 分解）──
  _solveWristTwist(side) {
    const boneName = side === 'left' ? '左手捩' : '右手捩';
    const armKey = side === 'left' ? 'left_arm' : 'right_arm';
    const elbowKey = side === 'left' ? 'left_elbow' : 'right_elbow';
    const elbowBoneName = side === 'left' ? '左ひじ' : '右ひじ';

    const indexMcp = this._getHandLandmark(side, H.index_mcp);
    const ringMcp = this._getHandLandmark(side, H.ring_mcp);
    if (!indexMcp || !ringMcp) return { name: boneName, rotation: new THREE.Quaternion() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const armQuat = this.boneStates[armKey].rotation;
    const elbowQuat = this.boneStates[elbowKey].rotation;
    const fullParent = new THREE.Quaternion().multiplyQuaternions(
      new THREE.Quaternion().multiplyQuaternions(upperBodyQuat, armQuat), elbowQuat);
    const invMat = _matA.makeRotationFromQuaternion(fullParent).invert();
    const localIndex = indexMcp.clone().applyMatrix4(invMat);
    const localRing = ringMcp.clone().applyMatrix4(invMat);

    const handDir = _v3a.subVectors(localIndex, localRing).normalize();
    const ref = this.getRef(boneName);
    const fullRotation = new THREE.Quaternion().setFromUnitVectors(ref, handDir);
    const twist = IKSolver.twistAroundAxis(fullRotation, this.getRef(elbowBoneName));

    return { name: boneName, rotation: twist };
  }

  // ── 手腕 ──
  _solveWrist(side) {
    const boneName = side === 'left' ? '左手首' : '右手首';
    const armKey = side === 'left' ? 'left_arm' : 'right_arm';
    const elbowKey = side === 'left' ? 'left_elbow' : 'right_elbow';
    const twistKey = side === 'left' ? 'left_wrist_twist' : 'right_wrist_twist';

    const wrist = this._getHandLandmark(side, H.wrist);
    const middleMcp = this._getHandLandmark(side, H.middle_mcp);
    if (!wrist || !middleMcp) return { name: boneName, rotation: new THREE.Quaternion() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const armQuat = this.boneStates[armKey].rotation;
    const elbowQuat = this.boneStates[elbowKey].rotation;
    const twistQuat = this.boneStates[twistKey].rotation;
    const fullParent = new THREE.Quaternion().multiplyQuaternions(
      new THREE.Quaternion().multiplyQuaternions(
        new THREE.Quaternion().multiplyQuaternions(upperBodyQuat, armQuat), elbowQuat), twistQuat);
    const invMat = _matA.makeRotationFromQuaternion(fullParent).invert();
    const localWrist = wrist.clone().applyMatrix4(invMat);
    const localMiddleMcp = middleMcp.clone().applyMatrix4(invMat);
    const dir = _v3a.subVectors(localMiddleMcp, localWrist).normalize();
    const ref = this.getRef(boneName);

    return { name: boneName, rotation: new THREE.Quaternion().setFromUnitVectors(ref, dir) };
  }

  // ── 所有手指 ──
  _solveAllFingers(side) {
    const prefix = side === 'left' ? '左' : '右';
    this.boneStates[`${side}_thumb_1`] = this._solveFingerBase(side, 'thumb_mcp', 'thumb_ip', `${prefix}親指１`);
    this.boneStates[`${side}_index_1`] = this._solveFingerBase(side, 'index_mcp', 'index_pip', `${prefix}人指１`);
    this.boneStates[`${side}_middle_1`] = this._solveFingerBase(side, 'middle_mcp', 'middle_pip', `${prefix}中指１`);
    this.boneStates[`${side}_ring_1`] = this._solveFingerBase(side, 'ring_mcp', 'ring_pip', `${prefix}薬指１`);
    this.boneStates[`${side}_pinky_1`] = this._solveFingerBase(side, 'pinky_mcp', 'pinky_pip', `${prefix}小指１`);

    const bendAxes = side === 'left' ? {
      thumb: new THREE.Vector3(-1.0, -1.0, 0.0).normalize(),
      index: new THREE.Vector3(-0.031, 0.0, -0.993).normalize(),
      middle: new THREE.Vector3(0.03, 0.0, -0.996).normalize(),
      ring: new THREE.Vector3(0.048, 0.0, 0.997).normalize(),
      pinky: new THREE.Vector3(0.088, 0.0, -0.997).normalize(),
    } : {
      thumb: new THREE.Vector3(-1.0, 1.0, 0.0).normalize(),
      index: new THREE.Vector3(-0.031, 0.0, 0.993).normalize(),
      middle: new THREE.Vector3(0.03, 0.0, 0.996).normalize(),
      ring: new THREE.Vector3(0.048, 0.0, -0.997).normalize(),
      pinky: new THREE.Vector3(0.088, 0.0, 0.997).normalize(),
    };

    this.boneStates[`${side}_thumb_2`] = this._solveFingerJoint(`${side}_thumb_1`, `${prefix}親指２`, bendAxes.thumb, 0.85);
    this.boneStates[`${side}_index_2`] = this._solveFingerJoint(`${side}_index_1`, `${prefix}人指２`, bendAxes.index, 0.9);
    this.boneStates[`${side}_index_3`] = this._solveFingerJoint(`${side}_index_1`, `${prefix}人指３`, bendAxes.index, 0.65);
    this.boneStates[`${side}_middle_2`] = this._solveFingerJoint(`${side}_middle_1`, `${prefix}中指２`, bendAxes.middle, 0.9);
    this.boneStates[`${side}_middle_3`] = this._solveFingerJoint(`${side}_middle_1`, `${prefix}中指３`, bendAxes.middle, 0.65);
    this.boneStates[`${side}_ring_2`] = this._solveFingerJoint(`${side}_ring_1`, `${prefix}薬指２`, bendAxes.ring, 0.88);
    this.boneStates[`${side}_ring_3`] = this._solveFingerJoint(`${side}_ring_1`, `${prefix}薬指３`, bendAxes.ring, 0.6);
    this.boneStates[`${side}_pinky_2`] = this._solveFingerJoint(`${side}_pinky_1`, `${prefix}小指２`, bendAxes.pinky, 0.85);
    this.boneStates[`${side}_pinky_3`] = this._solveFingerJoint(`${side}_pinky_1`, `${prefix}小指３`, bendAxes.pinky, 0.55);
  }

  _solveFingerBase(side, mcpName, pipName, boneName) {
    const mcp = this._getHandLandmark(side, H[mcpName]);
    const pip = this._getHandLandmark(side, H[pipName]);
    if (!mcp || !pip) return { name: boneName, rotation: new THREE.Quaternion() };

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const armKey = side === 'left' ? 'left_arm' : 'right_arm';
    const elbowKey = side === 'left' ? 'left_elbow' : 'right_elbow';
    const twistKey = side === 'left' ? 'left_wrist_twist' : 'right_wrist_twist';
    const wristKey = side === 'left' ? 'left_wrist' : 'right_wrist';

    const fullParent = new THREE.Quaternion().multiplyQuaternions(
      new THREE.Quaternion().multiplyQuaternions(
        new THREE.Quaternion().multiplyQuaternions(
          new THREE.Quaternion().multiplyQuaternions(upperBodyQuat, this.boneStates[armKey].rotation),
          this.boneStates[elbowKey].rotation),
        this.boneStates[twistKey].rotation),
      this.boneStates[wristKey].rotation);

    const invMat = _matA.makeRotationFromQuaternion(fullParent).invert();
    const localMcp = mcp.clone().applyMatrix4(invMat);
    const localPip = pip.clone().applyMatrix4(invMat);
    const dir = _v3a.subVectors(localPip, localMcp).normalize();
    const ref = this.getRef(boneName);

    return { name: boneName, rotation: new THREE.Quaternion().setFromUnitVectors(ref, dir) };
  }

  _solveFingerJoint(baseKey, boneName, bendAxis, ratio) {
    const baseRotation = this.boneStates[baseKey].rotation;
    const bendDegrees = this._extractBendDegrees(baseRotation, bendAxis);
    const adjustedDegrees = bendDegrees * ratio;
    const radians = (adjustedDegrees * Math.PI) / 180;
    const halfAngle = radians / 2;
    const sin = Math.sin(halfAngle);
    const cos = Math.cos(halfAngle);
    return { name: boneName, rotation: new THREE.Quaternion(bendAxis.x * sin, bendAxis.y * sin, bendAxis.z * sin, cos) };
  }

  _extractBendDegrees(quat, bendAxis) {
    const totalAngle = 2 * Math.acos(Math.abs(quat.w)) * (180 / Math.PI);
    const axisComponent = quat.x * bendAxis.x + quat.y * bendAxis.y + quat.z * bendAxis.z;
    return totalAngle * (axisComponent < 0 ? -1 : 1);
  }
}
