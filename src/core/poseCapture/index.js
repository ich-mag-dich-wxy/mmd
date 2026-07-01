// ═══════════════════════════════════════════════════════════
//  poseCapture 模块入口 — 整合 Solver + 应用 + MediaPipe 封装
//
//  完全照搬 PoPo（https://github.com/AmyangXYZ/PoPo）的 solver 实现：
//    - 硬编码 reference 向量（pre-2.0 版本，无需 calibrate）
//    - landmarkToVector3: (x, -y, z)  // MediaPipe → Babylon/MMD
//    - 输出 Babylon.js 四元数（坐标系与 MMD 一致）
//
//  应用方式对齐 MiKaPo：
//    - 四元数直接透传到 three.js 骨骼（不转换坐标，因 three.js MMD 骨骼已是 MMD 空间）
//    - 30ms 时间补间，frame-rate 无关
// ═══════════════════════════════════════════════════════════

// Solver + VpdWriter（照搬 PoPo）
export { Solver, BoneState, KeyBones } from './solver.js';

// 应用到 three.js mesh（照搬 MiKaPo rotateBones(pose, 30) 语义）
export { applyPoseToMesh, buildBoneIndexMap } from './applyPose.js';

// MediaPipe HolisticLandmarker 封装（已有，引擎无关，直接复用）
export { initHolisticLandmarker, PoseCaptureSystem } from '../poseCaptureSystem.js';
