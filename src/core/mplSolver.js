// ═══════════════════════════════════════════════════════════
//  MPL MediaPipe Solver — 移植自 MMD-MPL 项目的 mediapipe_solver.ts
//  使用 three.js 的 Quaternion/Vector3/Matrix4 替代 Babylon.js
//
//  该 Solver 接收 HolisticLandmarker 的结果（pose + leftHand + rightHand），
//  计算出 MMD 标准骨骼（日文名）的旋转四元数。
//  算法比原 solvePoseToBones 更精确：考虑了完整父链变换，
//  在父骨骼局部空间中求解子骨骼旋转。
// ═══════════════════════════════════════════════════════════

import * as THREE from 'three';

// ── MediaPipe Pose 关键点索引 ──
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

// ── MediaPipe Hand 关键点索引 ──
const HandIndexTable = {
  wrist: 0, thumb_cmc: 1, thumb_mcp: 2, thumb_ip: 3, thumb_tip: 4,
  index_mcp: 5, index_pip: 6, index_dip: 7, index_tip: 8,
  middle_mcp: 9, middle_pip: 10, middle_dip: 11, middle_tip: 12,
  ring_mcp: 13, ring_pip: 14, ring_dip: 15, ring_tip: 16,
  pinky_mcp: 17, pinky_pip: 18, pinky_dip: 19, pinky_tip: 20,
};

// ── MMD 标准骨骼名（日文）→ 英文键 ──
// Solver 内部用英文键存储中间结果，最终输出日文骨骼名
const BONE_NAME_JP = {
  upper_body: '上半身',
  lower_body: '下半身',
  neck: '首',
  head: '頭',
  left_leg: '左足',
  right_leg: '右足',
  left_knee: '左ひざ',
  right_knee: '右ひざ',
  left_ankle: '左足首',
  right_ankle: '右足首',
  left_arm: '左腕',
  right_arm: '右腕',
  left_elbow: '左ひじ',
  right_elbow: '右ひじ',
  left_wrist_twist: '左手捩',
  right_wrist_twist: '右手捩',
  left_wrist: '左手首',
  right_wrist: '右手首',
  left_thumb_1: '左親指１', left_thumb_2: '左親指２',
  left_index_1: '左人指１', left_index_2: '左人指２', left_index_3: '左人指３',
  left_middle_1: '左中指１', left_middle_2: '左中指２', left_middle_3: '左中指３',
  left_ring_1: '左薬指１', left_ring_2: '左薬指２', left_ring_3: '左薬指３',
  left_pinky_1: '左小指１', left_pinky_2: '左小指２', left_pinky_3: '左小指３',
  right_thumb_1: '右親指１', right_thumb_2: '右親指２',
  right_index_1: '右人指１', right_index_2: '右人指２', right_index_3: '右人指３',
  right_middle_1: '右中指１', right_middle_2: '右中指２', right_middle_3: '右中指３',
  right_ring_1: '右薬指１', right_ring_2: '右薬指２', right_ring_3: '右薬指３',
  right_pinky_1: '右小指１', right_pinky_2: '右小指２', right_pinky_3: '右小指３',
};

// ── 临时对象（避免每帧 GC）──
const _tmpV3 = new THREE.Vector3();
const _tmpV3b = new THREE.Vector3();
const _tmpQuat = new THREE.Quaternion();
const _tmpMat4 = new THREE.Matrix4();

/**
 * 从 landmark 构建 three.js Vector3
 * MediaPipe 世界坐标: x 右为正, y 下为正, z 近屏幕为正（靠近相机）
 * MMD 模型在 three.js 中面朝 -z（MMDLoader 将左手系转右手系时 z 取反）
 * 因此 MediaPipe 的 z 正值对应模型的"后方"，需要取反 z 使其与 MMD 坐标系一致
 */
function landmarkToVec3(lm) {
  if (!lm) return new THREE.Vector3(0, 0, 0);
  return new THREE.Vector3(lm.x, -lm.y, -lm.z);
}

/**
 * 创建 ref 向量（骨骼静止方向）
 * ref 向量基于 MMD 模型坐标系（前方 -z），z 自动与 landmarkToVec3 的取反保持一致
 * 传入的 x,y,z 是 MMD 坐标系下的值（前方为 -z）
 */
function refVec(x, y, z) {
  return new THREE.Vector3(x, y, z);
}

/**
 * 四元数 → 旋转矩阵
 * 等价于 Babylon.js Matrix.FromQuaternionToRef
 */
function quatToMat4(q, out) {
  out.makeRotationFromQuaternion(q);
  return out;
}

/**
 * 从 from→to 的旋转四元数
 * 等价于 Babylon.js Quaternion.FromUnitVectorsToRef
 */
function fromUnitVectors(from, to) {
  return new THREE.Quaternion().setFromUnitVectors(from, to);
}

/**
 * 提取四元数中绕指定轴的旋转角度（度）
 */
function extractBendDegrees(q, bendAxis) {
  const totalAngle = 2 * Math.acos(Math.abs(q.w)) * (180 / Math.PI);
  const axisComponent = q.x * bendAxis.x + q.y * bendAxis.y + q.z * bendAxis.z;
  return totalAngle * (axisComponent < 0 ? -1 : 1);
}

/**
 * 从角度（度）+ 轴构建四元数
 */
function fromAxisAngleDeg(axis, degrees) {
  const radians = degrees * Math.PI / 180;
  return new THREE.Quaternion().setFromAxisAngle(axis, radians);
}

// ═══════════════════════════════════════════════════════════
//  MPL Solver 主类
// ═══════════════════════════════════════════════════════════

export class MPLSolver {
  constructor() {
    this.poseWorldLandmarks = null;
    this.leftHandWorldLandmarks = null;
    this.rightHandWorldLandmarks = null;
    this.boneStates = {}; // key -> { name, rotation: THREE.Quaternion }
  }

  /**
   * 求解骨骼旋转
   * @param {Object} result HolisticLandmarker 结果
   *   { poseWorldLandmarks: [[]], leftHandWorldLandmarks: [[]], rightHandWorldLandmarks: [[]] }
   * @returns {Object} 骨骼名(日文) → THREE.Quaternion
   */
  solve(result) {
    this.boneStates = {};

    if (result.poseWorldLandmarks && result.poseWorldLandmarks.length > 0 &&
        result.poseWorldLandmarks[0].length === 33) {
      this.poseWorldLandmarks = result.poseWorldLandmarks[0];
    } else {
      this.poseWorldLandmarks = null;
    }

    if (result.leftHandWorldLandmarks && result.leftHandWorldLandmarks.length > 0 &&
        result.leftHandWorldLandmarks[0].length === 21) {
      this.leftHandWorldLandmarks = result.leftHandWorldLandmarks[0];
    } else {
      this.leftHandWorldLandmarks = null;
    }

    if (result.rightHandWorldLandmarks && result.rightHandWorldLandmarks.length > 0 &&
        result.rightHandWorldLandmarks[0].length === 21) {
      this.rightHandWorldLandmarks = result.rightHandWorldLandmarks[0];
    } else {
      this.rightHandWorldLandmarks = null;
    }

    // 身体
    this._set('upper_body', this._solveUpperBody());
    this._set('neck', this._solveNeck());
    this._set('head', this._solveHead());
    this._set('lower_body', this._solveLowerBody());
    this._set('left_leg', this._solveLeftLeg());
    this._set('right_leg', this._solveRightLeg());
    this._set('left_knee', this._solveLeftKnee());
    this._set('right_knee', this._solveRightKnee());
    this._set('left_ankle', this._solveLeftAnkle());
    this._set('right_ankle', this._solveRightAnkle());
    this._set('left_arm', this._solveLeftArm());
    this._set('right_arm', this._solveRightArm());
    this._set('left_elbow', this._solveLeftElbow());
    this._set('right_elbow', this._solveRightElbow());
    this._set('left_wrist_twist', this._solveLeftWristTwist());
    this._set('right_wrist_twist', this._solveRightWristTwist());
    this._set('left_wrist', this._solveLeftWrist());
    this._set('right_wrist', this._solveRightWrist());

    // 左手手指
    this._set('left_thumb_1', this._solveLeftThumb1());
    this._set('left_thumb_2', this._solveFingerJoint('left_thumb_1', 'left_thumb_2', refVec(-1, -1, 0).normalize(), 0.85));
    this._set('left_index_1', this._solveLeftIndex1());
    this._set('left_index_2', this._solveFingerJoint('left_index_1', 'left_index_2', refVec(-0.031, 0, 0.993).normalize(), 0.9));
    this._set('left_index_3', this._solveFingerJoint('left_index_1', 'left_index_3', refVec(-0.031, 0, 0.993).normalize(), 0.65));
    this._set('left_middle_1', this._solveLeftMiddle1());
    this._set('left_middle_2', this._solveFingerJoint('left_middle_1', 'left_middle_2', refVec(0.03, 0, 0.996).normalize(), 0.9));
    this._set('left_middle_3', this._solveFingerJoint('left_middle_1', 'left_middle_3', refVec(0.03, 0, 0.996).normalize(), 0.65));
    this._set('left_ring_1', this._solveLeftRing1());
    this._set('left_ring_2', this._solveFingerJoint('left_ring_1', 'left_ring_2', refVec(0.048, 0, -0.997).normalize(), 0.88));
    this._set('left_ring_3', this._solveFingerJoint('left_ring_1', 'left_ring_3', refVec(0.048, 0, -0.997).normalize(), 0.6));
    this._set('left_pinky_1', this._solveLeftPinky1());
    this._set('left_pinky_2', this._solveFingerJoint('left_pinky_1', 'left_pinky_2', refVec(0.088, 0, 0.997).normalize(), 0.85));
    this._set('left_pinky_3', this._solveFingerJoint('left_pinky_1', 'left_pinky_3', refVec(0.088, 0, 0.997).normalize(), 0.55));

    // 右手手指
    this._set('right_thumb_1', this._solveRightThumb1());
    this._set('right_thumb_2', this._solveFingerJoint('right_thumb_1', 'right_thumb_2', refVec(-1, 1, 0).normalize(), 0.85));
    this._set('right_index_1', this._solveRightIndex1());
    this._set('right_index_2', this._solveFingerJoint('right_index_1', 'right_index_2', refVec(-0.031, 0, -0.993).normalize(), 0.9));
    this._set('right_index_3', this._solveFingerJoint('right_index_1', 'right_index_3', refVec(-0.031, 0, -0.993).normalize(), 0.65));
    this._set('right_middle_1', this._solveRightMiddle1());
    this._set('right_middle_2', this._solveFingerJoint('right_middle_1', 'right_middle_2', refVec(0.03, 0, -0.996).normalize(), 0.9));
    this._set('right_middle_3', this._solveFingerJoint('right_middle_1', 'right_middle_3', refVec(0.03, 0, -0.996).normalize(), 0.65));
    this._set('right_ring_1', this._solveRightRing1());
    this._set('right_ring_2', this._solveFingerJoint('right_ring_1', 'right_ring_2', refVec(0.048, 0, -0.997).normalize(), 0.88));
    this._set('right_ring_3', this._solveFingerJoint('right_ring_1', 'right_ring_3', refVec(0.048, 0, -0.997).normalize(), 0.6));
    this._set('right_pinky_1', this._solveRightPinky1());
    this._set('right_pinky_2', this._solveFingerJoint('right_pinky_1', 'right_pinky_2', refVec(0.088, 0, -0.997).normalize(), 0.85));
    this._set('right_pinky_3', this._solveFingerJoint('right_pinky_1', 'right_pinky_3', refVec(0.088, 0, -0.997).normalize(), 0.55));

    // 输出：日文骨骼名 → 四元数
    const result_map = {};
    for (const [key, state] of Object.entries(this.boneStates)) {
      const jpName = BONE_NAME_JP[key];
      if (jpName) result_map[jpName] = state.rotation;
    }
    return result_map;
  }

  _set(key, state) {
    this.boneStates[key] = state;
  }

  _getPose(name) {
    if (!this.poseWorldLandmarks) return null;
    return landmarkToVec3(this.poseWorldLandmarks[PoseLandmarksTable[name]]);
  }

  _getLeftHand(name) {
    if (!this.leftHandWorldLandmarks) return null;
    return landmarkToVec3(this.leftHandWorldLandmarks[HandIndexTable[name]]);
  }

  _getRightHand(name) {
    if (!this.rightHandWorldLandmarks) return null;
    return landmarkToVec3(this.rightHandWorldLandmarks[HandIndexTable[name]]);
  }

  _identity(key) {
    return { name: key, rotation: new THREE.Quaternion() };
  }

  // ── 下半身 ──
  // 只保留 y 轴旋转（左右转动），过滤掉 x/z 轴旋转
  // 避免抬腿时左右髋关节高度差导致下半身整体倾斜
  _solveLowerBody() {
    const leftHip = this._getPose('left_hip');
    const rightHip = this._getPose('right_hip');
    if (!leftHip || !rightHip) return this._identity('lower_body');
    // 只取 x 和 z 分量计算水平方向，忽略 y（高度差）
    const hipDir = new THREE.Vector3(
      leftHip.x - rightHip.x,
      0,
      leftHip.z - rightHip.z
    ).normalize();
    const ref = refVec(1, 0, 0);
    const fullRot = fromUnitVectors(ref, hipDir);
    // 提取 y 轴旋转（左右转动）
    const euler = new THREE.Euler().setFromQuaternion(fullRot, 'YXZ');
    return { name: 'lower_body', rotation: new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), euler.y) };
  }

  // ── 上半身 ──
  // 用肩膀连线和脊柱方向构建旋转矩阵
  // 注意：MMD 模型面朝 -z，upperBodyZ 应指向 -z（模型前方）
  _solveUpperBody() {
    const leftShoulder = this._getPose('left_shoulder');
    const rightShoulder = this._getPose('right_shoulder');
    if (!leftShoulder || !rightShoulder) return this._identity('upper_body');

    const shoulderCenter = _tmpV3.addVectors(leftShoulder, rightShoulder).multiplyScalar(0.5);
    const shoulderX = _tmpV3b.subVectors(leftShoulder, rightShoulder).normalize();
    const spineY = shoulderCenter.clone().normalize();
    // 叉积顺序：spineY × shoulderX 使 z 轴指向 -z（模型前方）
    const upperBodyZ = new THREE.Vector3().crossVectors(spineY, shoulderX).normalize();

    // 构建旋转矩阵：列向量为 shoulderX, spineY, upperBodyZ
    const m = new THREE.Matrix4();
    m.makeBasis(shoulderX, spineY, upperBodyZ);
    const rotation = new THREE.Quaternion();
    m.decompose(new THREE.Vector3(), rotation, new THREE.Vector3());
    return { name: 'upper_body', rotation };
  }

  // ── 颈部 ──
  _solveNeck() {
    const lEar = this._getPose('left_ear');
    const rEar = this._getPose('right_ear');
    const lShoulder = this._getPose('left_shoulder');
    const rShoulder = this._getPose('right_shoulder');
    if (!lEar || !rEar || !lShoulder || !rShoulder) return this._identity('neck');

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const invMat = quatToMat4(upperBodyQuat, _tmpMat4).invert();

    const localLEar = lEar.clone().applyMatrix4(invMat);
    const localREar = rEar.clone().applyMatrix4(invMat);
    const localLShoulder = lShoulder.clone().applyMatrix4(invMat);
    const localRShoulder = rShoulder.clone().applyMatrix4(invMat);

    const earCenter = _tmpV3.addVectors(localLEar, localREar).multiplyScalar(0.5);
    const shoulderCenter = _tmpV3b.addVectors(localLShoulder, localRShoulder).multiplyScalar(0.5);
    const neckDir = _tmpV3.subVectors(earCenter, shoulderCenter).normalize();
    const ref = refVec(0, 0.9758578206707508, 0.21840676233975218).normalize();
    return { name: 'neck', rotation: fromUnitVectors(ref, neckDir) };
  }

  // ── 头部 ──
  _solveHead() {
    const lEar = this._getPose('left_ear');
    const rEar = this._getPose('right_ear');
    const lEye = this._getPose('left_eye');
    const rEye = this._getPose('right_eye');
    if (!lEar || !rEar || !lEye || !rEye) return this._identity('head');

    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const neckQuat = this.boneStates['neck'].rotation;
    // fullParent = upperBody * neck
    const fullParent = _tmpQuat.copy(upperBodyQuat).multiply(neckQuat);
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();

    const localLEar = lEar.clone().applyMatrix4(invMat);
    const localREar = rEar.clone().applyMatrix4(invMat);
    const localLEye = lEye.clone().applyMatrix4(invMat);
    const localREye = rEye.clone().applyMatrix4(invMat);

    const earDir = _tmpV3.subVectors(localLEar, localREar).normalize();
    const eyeCenter = _tmpV3b.addVectors(localLEye, localREye).multiplyScalar(0.5);
    const earCenter = new THREE.Vector3().addVectors(localLEar, localREar).multiplyScalar(0.5);
    const bendDir = new THREE.Vector3().subVectors(eyeCenter, earCenter).normalize();

    const horizRot = fromUnitVectors(refVec(1, 0, 0), earDir);
    const vertRot = fromUnitVectors(refVec(0, 0, 1), bendDir);
    return { name: 'head', rotation: horizRot.multiply(vertRot) };
  }

  // ── 左腿 ──
  _solveLeftLeg() {
    const hip = this._getPose('left_hip');
    const knee = this._getPose('left_knee');
    if (!hip || !knee) return this._identity('left_leg');
    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    const invMat = quatToMat4(lowerBodyQuat, _tmpMat4).invert();
    const localHip = hip.clone().applyMatrix4(invMat);
    const localKnee = knee.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localKnee, localHip).normalize();
    const ref = refVec(-0.009540689177369048, -0.998440855265296, -0.05499848895310636).normalize();
    return { name: 'left_leg', rotation: fromUnitVectors(ref, dir) };
  }

  _solveRightLeg() {
    const hip = this._getPose('right_hip');
    const knee = this._getPose('right_knee');
    if (!hip || !knee) return this._identity('right_leg');
    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    const invMat = quatToMat4(lowerBodyQuat, _tmpMat4).invert();
    const localHip = hip.clone().applyMatrix4(invMat);
    const localKnee = knee.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localKnee, localHip).normalize();
    const ref = refVec(-0.009540689177369048, -0.998440855265296, -0.05499848895310636).normalize();
    return { name: 'right_leg', rotation: fromUnitVectors(ref, dir) };
  }

  _solveLeftKnee() {
    const knee = this._getPose('left_knee');
    const ankle = this._getPose('left_ankle');
    if (!knee || !ankle) return this._identity('left_knee');
    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    const leftLegQuat = this.boneStates['left_leg'].rotation;
    const fullParent = _tmpQuat.copy(lowerBodyQuat).multiply(leftLegQuat);
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localKnee = knee.clone().applyMatrix4(invMat);
    const localAnkle = ankle.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localAnkle, localKnee).normalize();
    const ref = refVec(-0.0007085292291306043, -0.9908517790187175, -0.1349527695224302).normalize();
    return { name: 'left_knee', rotation: fromUnitVectors(ref, dir) };
  }

  _solveRightKnee() {
    const knee = this._getPose('right_knee');
    const ankle = this._getPose('right_ankle');
    if (!knee || !ankle) return this._identity('right_knee');
    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    const rightLegQuat = this.boneStates['right_leg'].rotation;
    const fullParent = _tmpQuat.copy(lowerBodyQuat).multiply(rightLegQuat);
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localKnee = knee.clone().applyMatrix4(invMat);
    const localAnkle = ankle.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localAnkle, localKnee).normalize();
    const ref = refVec(0.0007079817891811808, -0.9908517794028981, -0.13495276957475513).normalize();
    return { name: 'right_knee', rotation: fromUnitVectors(ref, dir) };
  }

  _solveLeftAnkle() {
    const heel = this._getPose('left_heel');
    const footIdx = this._getPose('left_foot_index');
    if (!heel || !footIdx) return this._identity('left_ankle');
    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    const leftLegQuat = this.boneStates['left_leg'].rotation;
    const leftKneeQuat = this.boneStates['left_knee'].rotation;
    const fullParent = _tmpQuat.copy(lowerBodyQuat).multiply(leftLegQuat).multiply(leftKneeQuat);
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localHeel = heel.clone().applyMatrix4(invMat);
    const localFoot = footIdx.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localFoot, localHeel).normalize();
    const ref = refVec(0, -0.65728916525082, 0.7536384764884819).normalize();
    return { name: 'left_ankle', rotation: fromUnitVectors(ref, dir) };
  }

  _solveRightAnkle() {
    const heel = this._getPose('right_heel');
    const footIdx = this._getPose('right_foot_index');
    if (!heel || !footIdx) return this._identity('right_ankle');
    const lowerBodyQuat = this.boneStates['lower_body'].rotation;
    const rightLegQuat = this.boneStates['right_leg'].rotation;
    const rightKneeQuat = this.boneStates['right_knee'].rotation;
    const fullParent = _tmpQuat.copy(lowerBodyQuat).multiply(rightLegQuat).multiply(rightKneeQuat);
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localHeel = heel.clone().applyMatrix4(invMat);
    const localFoot = footIdx.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localFoot, localHeel).normalize();
    const ref = refVec(0, -0.65728916525082, 0.7536384764884819).normalize();
    return { name: 'right_ankle', rotation: fromUnitVectors(ref, dir) };
  }

  // ── 左臂 ──
  _solveLeftArm() {
    const shoulder = this._getPose('left_shoulder');
    const elbow = this._getPose('left_elbow');
    if (!shoulder || !elbow) return this._identity('left_arm');
    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const invMat = quatToMat4(upperBodyQuat, _tmpMat4).invert();
    const localShoulder = shoulder.clone().applyMatrix4(invMat);
    const localElbow = elbow.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localElbow, localShoulder).normalize();
    const ref = refVec(0.8012514930735141, -0.5966378711527615, 0.04493657256361681).normalize();
    return { name: 'left_arm', rotation: fromUnitVectors(ref, dir) };
  }

  _solveRightArm() {
    const shoulder = this._getPose('right_shoulder');
    const elbow = this._getPose('right_elbow');
    if (!shoulder || !elbow) return this._identity('right_arm');
    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const invMat = quatToMat4(upperBodyQuat, _tmpMat4).invert();
    const localShoulder = shoulder.clone().applyMatrix4(invMat);
    const localElbow = elbow.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localElbow, localShoulder).normalize();
    const ref = refVec(-0.8020376176381924, -0.5972232450219962, 0.007749548286792409).normalize();
    return { name: 'right_arm', rotation: fromUnitVectors(ref, dir) };
  }

  _solveLeftElbow() {
    const elbow = this._getPose('left_elbow');
    const wrist = this._getPose('left_wrist');
    if (!elbow || !wrist) return this._identity('left_elbow');
    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const leftArmQuat = this.boneStates['left_arm'].rotation;
    const fullParent = _tmpQuat.copy(upperBodyQuat).multiply(leftArmQuat);
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localElbow = elbow.clone().applyMatrix4(invMat);
    const localWrist = wrist.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localWrist, localElbow).normalize();
    const ref = refVec(0.7991214493734219, -0.600241324846603, 0.03339552511514752).normalize();
    return { name: 'left_elbow', rotation: fromUnitVectors(ref, dir) };
  }

  _solveRightElbow() {
    const elbow = this._getPose('right_elbow');
    const wrist = this._getPose('right_wrist');
    if (!elbow || !wrist) return this._identity('right_elbow');
    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const rightArmQuat = this.boneStates['right_arm'].rotation;
    const fullParent = _tmpQuat.copy(upperBodyQuat).multiply(rightArmQuat);
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localElbow = elbow.clone().applyMatrix4(invMat);
    const localWrist = wrist.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localWrist, localElbow).normalize();
    const ref = refVec(-0.7991213083626819, -0.6002415122251716, 0.03339553147285845).normalize();
    return { name: 'right_elbow', rotation: fromUnitVectors(ref, dir) };
  }

  _solveLeftWristTwist() {
    const wrist = this._getLeftHand('wrist');
    const indexMcp = this._getLeftHand('index_mcp');
    const ringMcp = this._getLeftHand('ring_mcp');
    if (!wrist || !indexMcp || !ringMcp) return this._identity('left_wrist_twist');
    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const leftArmQuat = this.boneStates['left_arm'].rotation;
    const leftElbowQuat = this.boneStates['left_elbow'].rotation;
    const fullParent = _tmpQuat.copy(upperBodyQuat).multiply(leftArmQuat).multiply(leftElbowQuat);
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localIndex = indexMcp.clone().applyMatrix4(invMat);
    const localRing = ringMcp.clone().applyMatrix4(invMat);
    const handDir = _tmpV3.subVectors(localIndex, localRing).normalize();
    const fullRot = fromUnitVectors(refVec(0, 0, 1), handDir);
    // 只取 roll 分量（绕 Y 轴）
    const euler = new THREE.Euler().setFromQuaternion(fullRot, 'YXZ');
    const rollOnly = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), euler.z);
    return { name: 'left_wrist_twist', rotation: rollOnly };
  }

  _solveRightWristTwist() {
    const wrist = this._getRightHand('wrist');
    const indexMcp = this._getRightHand('index_mcp');
    const ringMcp = this._getRightHand('ring_mcp');
    if (!wrist || !indexMcp || !ringMcp) return this._identity('right_wrist_twist');
    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const rightArmQuat = this.boneStates['right_arm'].rotation;
    const rightElbowQuat = this.boneStates['right_elbow'].rotation;
    const fullParent = _tmpQuat.copy(upperBodyQuat).multiply(rightArmQuat).multiply(rightElbowQuat);
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localIndex = indexMcp.clone().applyMatrix4(invMat);
    const localRing = ringMcp.clone().applyMatrix4(invMat);
    const handDir = _tmpV3.subVectors(localIndex, localRing).normalize();
    const fullRot = fromUnitVectors(refVec(0, 0, 1), handDir);
    const euler = new THREE.Euler().setFromQuaternion(fullRot, 'YXZ');
    const rollOnly = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), euler.z);
    return { name: 'right_wrist_twist', rotation: rollOnly };
  }

  _solveLeftWrist() {
    const wrist = this._getLeftHand('wrist');
    const middleMcp = this._getLeftHand('middle_mcp');
    if (!wrist || !middleMcp) return this._identity('left_wrist');
    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const leftArmQuat = this.boneStates['left_arm'].rotation;
    const leftElbowQuat = this.boneStates['left_elbow'].rotation;
    const leftWristTwistQuat = this.boneStates['left_wrist_twist'].rotation;
    const fullParent = _tmpQuat.copy(upperBodyQuat).multiply(leftArmQuat).multiply(leftElbowQuat).multiply(leftWristTwistQuat);
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localWrist = wrist.clone().applyMatrix4(invMat);
    const localMiddleMcp = middleMcp.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localMiddleMcp, localWrist).normalize();
    const ref = refVec(0.72573996, -0.40247154, 0.01692206).normalize();
    return { name: 'left_wrist', rotation: fromUnitVectors(ref, dir) };
  }

  _solveRightWrist() {
    const wrist = this._getRightHand('wrist');
    const indexMcp = this._getRightHand('index_mcp');
    if (!wrist || !indexMcp) return this._identity('right_wrist');
    const upperBodyQuat = this.boneStates['upper_body'].rotation;
    const rightArmQuat = this.boneStates['right_arm'].rotation;
    const rightElbowQuat = this.boneStates['right_elbow'].rotation;
    const rightWristTwistQuat = this.boneStates['right_wrist_twist'].rotation;
    const fullParent = _tmpQuat.copy(upperBodyQuat).multiply(rightArmQuat).multiply(rightElbowQuat).multiply(rightWristTwistQuat);
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localWrist = wrist.clone().applyMatrix4(invMat);
    const localIndexMcp = indexMcp.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localIndexMcp, localWrist).normalize();
    const ref = refVec(-0.72573996, -0.40247154, -0.01692206).normalize();
    return { name: 'right_wrist', rotation: fromUnitVectors(ref, dir) };
  }

  // ── 手指第一关节（MCP→PIP 方向）──
  _solveLeftThumb1() {
    const mcp = this._getLeftHand('thumb_mcp');
    const ip = this._getLeftHand('thumb_ip');
    if (!mcp || !ip) return this._identity('left_thumb_1');
    const fullParent = this._handParentQuat('left');
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localMcp = mcp.clone().applyMatrix4(invMat);
    const localIp = ip.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localIp, localMcp).normalize();
    const ref = refVec(0.6236582921350833, -0.7035050354478427, 0.34077998730952624).normalize();
    return { name: 'left_thumb_1', rotation: fromUnitVectors(ref, dir) };
  }

  _solveLeftIndex1() {
    const mcp = this._getLeftHand('index_mcp');
    const pip = this._getLeftHand('index_pip');
    if (!mcp || !pip) return this._identity('left_index_1');
    const fullParent = this._handParentQuat('left');
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localMcp = mcp.clone().applyMatrix4(invMat);
    const localPip = pip.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localPip, localMcp).normalize();
    const ref = refVec(0.8432431728071625, -0.5368768421934949, -0.026536914486258466).normalize();
    return { name: 'left_index_1', rotation: fromUnitVectors(ref, dir) };
  }

  _solveLeftMiddle1() {
    const mcp = this._getLeftHand('middle_mcp');
    const pip = this._getLeftHand('middle_pip');
    if (!mcp || !pip) return this._identity('left_middle_1');
    const fullParent = this._handParentQuat('left');
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localMcp = mcp.clone().applyMatrix4(invMat);
    const localPip = pip.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localPip, localMcp).normalize();
    const ref = refVec(0.8303922987881693, -0.5566343204926274, -0.02463459687127938).normalize();
    return { name: 'left_middle_1', rotation: fromUnitVectors(ref, dir) };
  }

  _solveLeftRing1() {
    const mcp = this._getLeftHand('ring_mcp');
    const pip = this._getLeftHand('ring_pip');
    if (!mcp || !pip) return this._identity('left_ring_1');
    const fullParent = this._handParentQuat('left');
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localMcp = mcp.clone().applyMatrix4(invMat);
    const localPip = pip.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localPip, localMcp).normalize();
    const ref = refVec(0.8076445279586488, -0.5883930602992032, -0.038780446750771254).normalize();
    return { name: 'left_ring_1', rotation: fromUnitVectors(ref, dir) };
  }

  _solveLeftPinky1() {
    const mcp = this._getLeftHand('pinky_mcp');
    const pip = this._getLeftHand('pinky_pip');
    if (!mcp || !pip) return this._identity('left_pinky_1');
    const fullParent = this._handParentQuat('left');
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localMcp = mcp.clone().applyMatrix4(invMat);
    const localPip = pip.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localPip, localMcp).normalize();
    const ref = refVec(0.8462256262210587, -0.5275922475926769, -0.07448899117913084).normalize();
    return { name: 'left_pinky_1', rotation: fromUnitVectors(ref, dir) };
  }

  _solveRightThumb1() {
    const mcp = this._getRightHand('thumb_mcp');
    const ip = this._getRightHand('thumb_ip');
    if (!mcp || !ip) return this._identity('right_thumb_1');
    const fullParent = this._handParentQuat('right');
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localMcp = mcp.clone().applyMatrix4(invMat);
    const localIp = ip.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localIp, localMcp).normalize();
    const ref = refVec(-0.6236753178947897, -0.7034896546159694, 0.34078057998826367).normalize();
    return { name: 'right_thumb_1', rotation: fromUnitVectors(ref, dir) };
  }

  _solveRightIndex1() {
    const mcp = this._getRightHand('index_mcp');
    const pip = this._getRightHand('index_pip');
    if (!mcp || !pip) return this._identity('right_index_1');
    const fullParent = this._handParentQuat('right');
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localMcp = mcp.clone().applyMatrix4(invMat);
    const localPip = pip.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localPip, localMcp).normalize();
    const ref = refVec(-0.8432487044803304, -0.5368678957658006, -0.026542134206687714).normalize();
    return { name: 'right_index_1', rotation: fromUnitVectors(ref, dir) };
  }

  _solveRightMiddle1() {
    const mcp = this._getRightHand('middle_mcp');
    const pip = this._getRightHand('middle_pip');
    if (!mcp || !pip) return this._identity('right_middle_1');
    const fullParent = this._handParentQuat('right');
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localMcp = mcp.clone().applyMatrix4(invMat);
    const localPip = pip.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localPip, localMcp).normalize();
    const ref = refVec(-0.830394244494938, -0.5566311582035673, -0.024640463198495298).normalize();
    return { name: 'right_middle_1', rotation: fromUnitVectors(ref, dir) };
  }

  _solveRightRing1() {
    const mcp = this._getRightHand('ring_mcp');
    const pip = this._getRightHand('ring_pip');
    if (!mcp || !pip) return this._identity('right_ring_1');
    const fullParent = this._handParentQuat('right');
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localMcp = mcp.clone().applyMatrix4(invMat);
    const localPip = pip.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localPip, localMcp).normalize();
    const ref = refVec(-0.8076382239720394, -0.5884013252930373, -0.03878633229228).normalize();
    return { name: 'right_ring_1', rotation: fromUnitVectors(ref, dir) };
  }

  _solveRightPinky1() {
    const mcp = this._getRightHand('pinky_mcp');
    const pip = this._getRightHand('pinky_pip');
    if (!mcp || !pip) return this._identity('right_pinky_1');
    const fullParent = this._handParentQuat('right');
    const invMat = quatToMat4(fullParent, _tmpMat4).invert();
    const localMcp = mcp.clone().applyMatrix4(invMat);
    const localPip = pip.clone().applyMatrix4(invMat);
    const dir = _tmpV3.subVectors(localPip, localMcp).normalize();
    const ref = refVec(-0.8462155810704232, -0.5276077240369134, -0.07449348891167894).normalize();
    return { name: 'right_pinky_1', rotation: fromUnitVectors(ref, dir) };
  }

  /**
   * 获取手的完整父链四元数
   * left: upper_body * left_arm * left_elbow * left_wrist_twist * left_wrist
   * right: upper_body * right_arm * right_elbow * right_wrist_twist * right_wrist
   */
  _handParentQuat(side) {
    const upperBody = this.boneStates['upper_body'].rotation;
    const arm = this.boneStates[side + '_arm'].rotation;
    const elbow = this.boneStates[side + '_elbow'].rotation;
    const wristTwist = this.boneStates[side + '_wrist_twist'].rotation;
    const wrist = this.boneStates[side + '_wrist'].rotation;
    return new THREE.Quaternion()
      .copy(upperBody)
      .multiply(arm)
      .multiply(elbow)
      .multiply(wristTwist)
      .multiply(wrist);
  }

  /**
   * 手指第 2/3 关节：从第 1 关节的旋转中提取弯曲角度，按比例分配
   */
  _solveFingerJoint(baseKey, jointKey, bendAxis, ratio) {
    const baseRot = this.boneStates[baseKey].rotation;
    const degrees = extractBendDegrees(baseRot, bendAxis) * ratio;
    return { name: jointKey, rotation: fromAxisAngleDeg(bendAxis, degrees) };
  }
}

// ═══════════════════════════════════════════════════════════
//  VPD 写入器（Shift-JIS 编码）
//  用于将 Solver 结果导出为 VPD 文件，供 MPL 反编译
// ═══════════════════════════════════════════════════════════

let _sjisEncoder = null;
let _sjisEncoderChecked = false;

function getSJISEncoder() {
  if (_sjisEncoderChecked) return _sjisEncoder;
  _sjisEncoderChecked = true;
  // 浏览器 TextEncoder 只支持 UTF-8，尝试用 TextDecoder 反向构建编码表
  try {
    const decoder = new TextDecoder('shift-jis');
    if (decoder) {
      _sjisEncoder = { decoder };
    }
  } catch (e) {
    _sjisEncoder = null;
  }
  return _sjisEncoder;
}

// 复用 vmdDecompiler 的 Shift-JIS 编码能力（懒加载）
let _sjisEncodeMap = null;
async function buildSJISEncodeMap() {
  if (_sjisEncodeMap) return _sjisEncodeMap;
  _sjisEncodeMap = new Map();
  let decoder;
  try { decoder = new TextDecoder('shift-jis'); } catch (e) { return _sjisEncodeMap; }

  for (let b = 0; b <= 0xFF; b++) {
    try {
      const str = decoder.decode(new Uint8Array([b]));
      if (str && str.length === 1) {
        const code = str.charCodeAt(0);
        if (!_sjisEncodeMap.has(code)) _sjisEncodeMap.set(code, b);
      }
    } catch (e) {}
  }
  for (let b1 = 0x81; b1 <= 0x9F; b1++) {
    for (let b2 = 0x40; b2 <= 0xFC; b2++) {
      if (b2 === 0x7F) continue;
      try {
        const str = decoder.decode(new Uint8Array([b1, b2]));
        if (str && str.length === 1) {
          const code = str.charCodeAt(0);
          if (code > 0x7F && !_sjisEncodeMap.has(code)) _sjisEncodeMap.set(code, (b1 << 8) | b2);
        }
      } catch (e) {}
    }
  }
  for (let b1 = 0xE0; b1 <= 0xEF; b1++) {
    for (let b2 = 0x40; b2 <= 0xFC; b2++) {
      if (b2 === 0x7F) continue;
      try {
        const str = decoder.decode(new Uint8Array([b1, b2]));
        if (str && str.length === 1) {
          const code = str.charCodeAt(0);
          if (code > 0x7F && !_sjisEncodeMap.has(code)) _sjisEncodeMap.set(code, (b1 << 8) | b2);
        }
      } catch (e) {}
    }
  }
  return _sjisEncodeMap;
}

/**
 * 将骨骼旋转数据导出为 VPD 格式 Uint8Array（Shift-JIS 编码）
 * @param {Object} boneRotations 骨骼名(日文) → THREE.Quaternion
 * @param {string} modelName 模型名
 * @returns {Promise<Uint8Array>} VPD 二进制
 */
export async function exportToVPD(boneRotations, modelName = 'MotionCapture') {
  const entries = Object.entries(boneRotations);
  const lines = [];
  lines.push('Vocaloid Pose Data file');
  lines.push('');
  lines.push(`${modelName};\t\t// モデルファイル名`);
  lines.push(`${entries.length};\t\t\t// ボーンフレーム数`);
  lines.push('');

  entries.forEach(([boneName, quat], i) => {
    lines.push(`Bone${i}{${boneName}`);
    lines.push(`  0.000000,0.000000,0.000000;\t\t\t\t// trans x,y,z`);
    lines.push(`  ${quat.x},${quat.y},${quat.z},${quat.w};\t\t// Quaternion x,y,z,w`);
    lines.push(`}`);
    lines.push('');
  });

  const content = lines.join('\n');
  const map = await buildSJISEncodeMap();
  const bytes = [];
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    const encoded = map.get(code);
    if (encoded !== undefined) {
      if (encoded <= 0xFF) {
        bytes.push(encoded);
      } else {
        bytes.push(encoded >> 8);
        bytes.push(encoded & 0xFF);
      }
    } else if (code < 0x80) {
      bytes.push(code);
    } else {
      bytes.push(0x3F); // '?'
    }
  }
  return new Uint8Array(bytes);
}
