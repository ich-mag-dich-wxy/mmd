// ═══════════════════════════════════════════════════════════
//  将 Solver 输出的 BoneState[] 应用到 three.js SkinnedMesh
//
//  照搬 PoPo/MiKaPo：
//    - PoPo 用 reze-engine（左手系 = MMD = Babylon），四元数直接写入，不转换
//    - three.js 的 MMDLoader 不会翻转 Z（已 grep 源码确认），PMX 骨骼原生 MMD 空间
//    - 因此 three.js MMD 骨骼 = Babylon 坐标系，四元数直接透传，不翻转
//
//  对齐 MiKaPo 的 model.rotateBones(pose, 30) 语义：
//    - 30ms 时间补间，frame-rate 无关
//    - 长帧封顶为 1（瞬时写入）
// ═══════════════════════════════════════════════════════════

import * as THREE from 'three';

/**
 * 构建骨骼名 → 索引映射
 */
export function buildBoneIndexMap(skeleton) {
  const map = {};
  skeleton.bones.forEach((bone, idx) => {
    map[bone.name] = idx;
  });
  return map;
}

/**
 * Babylon 四元数 → three.js 四元数（直接透传，坐标系相同）
 */
function babylonQuatToThree(q) {
  return new THREE.Quaternion(q.x, q.y, q.z, q.w);
}

/**
 * 将 BoneState[] 应用到 three.js SkinnedMesh。
 *
 * @param {Array} boneStates - Solver.solve() 返回的 BoneState 数组
 * @param {Object} boneIndexMap - 骨骼名 → 索引映射
 * @param {Array} bones - mesh.skeleton.bones
 * @param {Object} currentQuats - 当前骨骼四元数缓存（首次写入标记）
 * @param {number} deltaSeconds - 本帧时间间隔（秒）
 * @param {number} tweenMs - 补间时长（毫秒），默认 30，与 MiKaPo 一致
 * @returns {number} 应用的骨骼数
 */
export function applyPoseToMesh(boneStates, boneIndexMap, bones, currentQuats, deltaSeconds, tweenMs = 30) {
  let applied = 0;
  const factor = Math.min(1, (deltaSeconds * 1000) / tweenMs);

  for (const boneState of boneStates) {
    const idx = boneIndexMap[boneState.name];
    if (idx === undefined) continue;
    const bone = bones[idx];
    if (!bone) continue;

    const targetQuat = babylonQuatToThree(boneState.rotation);

    if (currentQuats[idx]) {
      bone.quaternion.slerp(targetQuat, factor);
    } else {
      bone.quaternion.copy(targetQuat);
      currentQuats[idx] = true;
    }
    bone.matrixWorldNeedsUpdate = true;
    applied++;
  }

  // 更新骨骼矩阵（从根骨骼递归，一次完成整棵骨骼树）
  for (const bone of bones) {
    if (!bone.parent || !bone.parent.isBone) {
      bone.updateMatrixWorld(true);
    }
  }

  return applied;
}
