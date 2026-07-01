// ═══════════════════════════════════════════════════════════
//  Babylon.js → three.js 适配层（照搬 PoPo/MiKaPo：不做坐标转换）
//
//  关键事实：
//    1. PoPo / MiKaPo 使用 reze-engine（左手系，与 MMD/Babylon 相同），
//       它们把 Babylon.js 求解器输出的四元数直接写入骨骼，**完全不做坐标转换**。
//    2. three.js 的 MMDLoader 不会翻转 Z（已 grep 源码确认），
//       PMX 模型的骨骼位置/旋转保持 MMD 原生左手系空间加载到 three.js。
//    3. 因此 three.js 中的 MMD 骨骼 = Babylon.js 坐标系 = MMD 坐标系，
//       三者相同，无需任何转换。
//
//  结论：照搬 PoPo/MiKaPo，所有坐标/四元数直接透传，不翻转 Z。
//  之前的 Z 翻转是 bug —— 它把已经是 Babylon 空间的坐标又翻了一次，
//  破坏了 calibrate() 的参考方向和腿部旋转求解。
// ═══════════════════════════════════════════════════════════

import * as THREE from 'three';
import { Vector3 } from '@babylonjs/core';

/**
 * three.js Vector3 → Babylon.js Vector3（直接透传，不翻转）
 * 照搬 PoPo/MiKaPo：两者坐标系相同。
 */
export function threeToBabylonVec3(v) {
  return new Vector3(v.x, v.y, v.z);
}

/**
 * Babylon.js Quaternion → three.js Quaternion（直接透传，不翻转）
 * 照搬 PoPo/MiKaPo：骨骼坐标系相同，四元数可直接使用。
 */
export function babylonToThreeQuat(q) {
  return new THREE.Quaternion(q.x, q.y, q.z, q.w);
}

/**
 * 从 three.js SkinnedMesh 构建校准数据（Babylon.js 坐标系）
 * 读取所有骨骼的世界位置，直接透传（坐标系已相同）。
 */
export function buildRestWorldPosForBabylon(mesh) {
  mesh.updateMatrixWorld(true);
  const bones = mesh.skeleton.bones;
  const pos = {};
  const _v = new THREE.Vector3();

  for (const bone of bones) {
    bone.getWorldPosition(_v);
    pos[bone.name] = new Vector3(_v.x, _v.y, _v.z);
  }

  return pos;
}

/**
 * 将 Solver 输出的 BoneState[] 应用到 three.js SkinnedMesh。
 *
 * 对齐 MiKaPo 的 model.rotateBones(pose, 30) 语义：
 *   - 第二参数是补间时长（毫秒），不是每帧 slerp 因子
 *   - 每帧按 delta 时间线性趋近目标，30ms 内逼近完成
 *   - Solver 内部已含 One-Euro 滤波，此处只做轻量补间抑制抖动
 *
 * 照搬 PoPo/MiKaPo：四元数直接透传，不做坐标转换。
 *
 * @param {Array} boneStates - Solver.solve() 返回的 BoneState 数组
 * @param {Object} boneIndexMap - 骨骼名 → 索引映射
 * @param {Array} bones - mesh.skeleton.bones
 * @param {Object} currentQuats - 当前骨骼四元数缓存（首次写入标记）
 * @param {number} deltaSeconds - 本帧时间间隔（秒）
 * @param {number} tweenMs - 补间时长（毫秒），默认 30，与 MiKaPo 一致
 * @returns {number} 应用的骨骼数
 */
export function applyBabylonPoseToThreeMesh(boneStates, boneIndexMap, bones, currentQuats, deltaSeconds, tweenMs = 30) {
  let applied = 0;
  // 30ms 线性补间因子：frame-rate 无关，长帧封顶为 1（即瞬时写入）
  const factor = Math.min(1, (deltaSeconds * 1000) / tweenMs);

  for (const boneState of boneStates) {
    const idx = boneIndexMap[boneState.name];
    if (idx === undefined) continue;
    const bone = bones[idx];
    if (!bone) continue;

    // Babylon.js 四元数 → three.js 四元数（直接透传）
    const targetQuat = babylonToThreeQuat(boneState.rotation);

    if (currentQuats[idx]) {
      bone.quaternion.slerp(targetQuat, factor);
    } else {
      bone.quaternion.copy(targetQuat);
      currentQuats[idx] = true;
    }
    bone.matrixWorldNeedsUpdate = true;
    applied++;
  }

  // 更新骨骼矩阵（从根骨骼开始递归，一次完成整棵骨骼树）
  for (const bone of bones) {
    if (!bone.parent || !bone.parent.isBone) {
      bone.updateMatrixWorld(true);
    }
  }

  return applied;
}
