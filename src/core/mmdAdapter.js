// ═══════════════════════════════════════════════════════════
//  MMD Adapter — IK 输出 → MMD 模型骨骼映射
//
//  职责:
//  1. 骨骼名映射（IK 输出日文名 → 模型骨骼索引）
//  2. 应用四元数到模型骨骼（带 slerp 插值平滑）
//  3. 处理别名匹配
//  4. 自动校准（从模型 rest pose 读取参考方向）
// ═══════════════════════════════════════════════════════════

import * as THREE from 'three';

/**
 * 常见骨骼名别名表
 */
const BONE_ALIASES = {
  '下半身': ['lower_body', 'LowerBody', 'waist', 'Waist', '腰', 'pelvis', 'Pelvis', 'hips', 'Hips'],
  '上半身': ['upper_body', 'UpperBody', '上半身1', '上半身2', 'chest', 'Chest', '胸'],
  '首': ['neck', 'Neck', 'ネック'],
  '頭': ['head', 'Head', 'ヘッド'],
  '左肩': ['left_shoulder', 'LeftShoulder', 'shoulder_l', 'L_shoulder'],
  '右肩': ['right_shoulder', 'RightShoulder', 'shoulder_r', 'R_shoulder'],
  '左腕': ['left_arm', 'LeftArm', 'arm_l', 'L_arm'],
  '右腕': ['right_arm', 'RightArm', 'arm_r', 'R_arm'],
  '左ひじ': ['left_elbow', 'LeftElbow', 'elbow_l', 'L_elbow'],
  '右ひじ': ['right_elbow', 'RightElbow', 'elbow_r', 'R_elbow'],
  '左手捩': ['left_wrist_twist', 'LeftWristTwist', 'wrist_twist_l', '左手捩'],
  '右手捩': ['right_wrist_twist', 'RightWristTwist', 'wrist_twist_r', '右手捩'],
  '左手首': ['left_wrist', 'LeftWrist', 'wrist_l', 'L_wrist'],
  '右手首': ['right_wrist', 'RightWrist', 'wrist_r', 'R_wrist'],
  '左足': ['left_leg', 'LeftLeg', 'leg_l', 'L_leg'],
  '右足': ['right_leg', 'RightLeg', 'leg_r', 'R_leg'],
  '左ひざ': ['left_knee', 'LeftKnee', 'knee_l', 'L_knee'],
  '右ひざ': ['right_knee', 'RightKnee', 'knee_r', 'R_knee'],
  '左足首': ['left_ankle', 'LeftAnkle', 'ankle_l', 'L_ankle'],
  '右足首': ['right_ankle', 'RightAnkle', 'ankle_r', 'R_ankle'],
  '左つま先': ['left_toe', 'LeftToe', 'toe_l', 'L_toe'],
  '右つま先': ['right_toe', 'RightToe', 'toe_r', 'R_toe'],
  '左目': ['left_eye', 'LeftEye', 'eye_l', 'L_eye'],
  '右目': ['right_eye', 'RightEye', 'eye_r', 'R_eye'],
  // 手指
  '左親指１': ['左親指0', 'left_thumb_0', '左親指'],
  '左親指２': ['左親指1', 'left_thumb_1'],
  '左人指１': ['左人指0', 'left_index_0', '左人指'],
  '左人指２': ['左人指1', 'left_index_1'],
  '左人指３': ['左人指2', 'left_index_2'],
  '左中指１': ['左中指0', 'left_middle_0', '左中指'],
  '左中指２': ['左中指1', 'left_middle_1'],
  '左中指３': ['左中指2', 'left_middle_2'],
  '左薬指１': ['左薬指0', 'left_ring_0', '左薬指'],
  '左薬指２': ['左薬指1', 'left_ring_1'],
  '左薬指３': ['左薬指2', 'left_ring_2'],
  '左小指１': ['左小指0', 'left_pinky_0', '左小指'],
  '左小指２': ['左小指1', 'left_pinky_1'],
  '左小指３': ['左小指2', 'left_pinky_2'],
  '右親指１': ['右親指0', 'right_thumb_0', '右親指'],
  '右親指２': ['右親指1', 'right_thumb_1'],
  '右人指１': ['右人指0', 'right_index_0', '右人指'],
  '右人指２': ['右人指1', 'right_index_1'],
  '右人指３': ['右人指2', 'right_index_2'],
  '右中指１': ['右中指0', 'right_middle_0', '右中指'],
  '右中指２': ['右中指1', 'right_middle_1'],
  '右中指３': ['右中指2', 'right_middle_2'],
  '右薬指１': ['右薬指0', 'right_ring_0', '右薬指'],
  '右薬指２': ['右薬指1', 'right_ring_1'],
  '右薬指３': ['右薬指2', 'right_ring_2'],
  '右小指１': ['右小指0', 'right_pinky_0', '右小指'],
  '右小指２': ['右小指1', 'right_pinky_1'],
  '右小指３': ['右小指2', 'right_pinky_2'],
};

/**
 * MMD Adapter 类
 */
export class MMDAdapter {
  constructor() {
    this.boneIndexMap = null;
    this.restQuaternions = null;
    this.currentQuats = {}; // 骨骼索引 → 当前四元数（用于 slerp 插值）
    this.smoothFactor = 0.2; // slerp 插值因子（接近 MiKaPo 的 30 帧平滑）
    this.calibrated = false;
  }

  /**
   * 初始化：构建骨骼名映射
   */
  init(skeleton) {
    const bones = skeleton.bones;
    this.boneIndexMap = {};
    this.restQuaternions = [];

    // 直接映射
    for (let i = 0; i < bones.length; i++) {
      this.boneIndexMap[bones[i].name] = i;
      this.restQuaternions[i] = bones[i].quaternion.clone();
    }

    // 别名映射
    let aliasMatched = 0;
    for (const [jpName, aliases] of Object.entries(BONE_ALIASES)) {
      if (this.boneIndexMap[jpName] !== undefined) continue;
      for (const alias of aliases) {
        if (this.boneIndexMap[alias] !== undefined) {
          this.boneIndexMap[jpName] = this.boneIndexMap[alias];
          aliasMatched++;
          break;
        }
      }
    }

    // 检查关键骨骼是否映射成功
    const criticalBones = ['上半身', '下半身', '左腕', '右腕', '左足', '右足', '首', '頭'];
    const missing = criticalBones.filter(name => this.boneIndexMap[name] === undefined);

    console.log(`[MMDAdapter] 骨骼映射: ${bones.length} 根骨骼, ${aliasMatched} 个别名匹配`);
    if (missing.length > 0) {
      console.warn(`[MMDAdapter] ⚠️ 缺少关键骨骼: ${missing.join(', ')}`);
      // 输出所有骨骼名帮助调试
      console.log('[MMDAdapter] 模型骨骼名列表:', bones.map(b => b.name).filter(n => n).join(', '));
    } else {
      console.log('[MMDAdapter] ✓ 所有关键骨骼已映射');
    }

    // 检查下半身骨骼层级和 rest 旋转
    const lowerBodyIdx = this.boneIndexMap['下半身'];
    if (lowerBodyIdx !== undefined) {
      const lb = bones[lowerBodyIdx];
      console.log('[MMDAdapter] 下半身 rest quat:', lb.quaternion.x.toFixed(4), lb.quaternion.y.toFixed(4), lb.quaternion.z.toFixed(4), lb.quaternion.w.toFixed(4));
      console.log('[MMDAdapter] 下半身 parent:', lb.parent ? lb.parent.name : 'none');
      if (lb.parent && lb.parent.isBone) {
        console.log('[MMDAdapter] 下半身 parent rest quat:', lb.parent.quaternion.x.toFixed(4), lb.parent.quaternion.y.toFixed(4), lb.parent.quaternion.z.toFixed(4), lb.parent.quaternion.w.toFixed(4));
      }
    }

    // 检查是否有 IK 骨骼
    const ikBones = bones.filter(b => b.name.includes('ＩＫ') || b.name.includes('IK'));
    if (ikBones.length > 0) {
      console.log('[MMDAdapter] 发现 IK 骨骼:', ikBones.map(b => b.name).join(', '));
    }

    // 检查左足骨骼层级
    const leftLegIdx = this.boneIndexMap['左足'];
    if (leftLegIdx !== undefined) {
      const ll = bones[leftLegIdx];
      console.log('[MMDAdapter] 左足 parent:', ll.parent ? ll.parent.name : 'none');
      console.log('[MMDAdapter] 左足 rest quat:', ll.quaternion.x.toFixed(4), ll.quaternion.y.toFixed(4), ll.quaternion.z.toFixed(4), ll.quaternion.w.toFixed(4));
    }
  }

  /**
   * 从模型 rest pose 构建校准数据
   * @param {THREE.SkinnedMesh} mesh
   * @returns {Object} 骨骼名 → THREE.Vector3 世界位置
   */
  buildRestWorldPos(mesh) {
    mesh.updateMatrixWorld(true);
    const bones = mesh.skeleton.bones;
    const pos = {};
    const _v = new THREE.Vector3();

    // 读取所有骨骼的世界位置
    for (const bone of bones) {
      bone.getWorldPosition(_v);
      pos[bone.name] = _v.clone();
    }

    // 通过别名补充缺失的骨骼
    for (const [jpName, aliases] of Object.entries(BONE_ALIASES)) {
      if (pos[jpName]) continue;
      for (const alias of aliases) {
        if (pos[alias]) {
          pos[jpName] = pos[alias];
          break;
        }
      }
    }

    return pos;
  }

  /**
   * 将 IK 输出的骨骼旋转应用到模型（带 slerp 插值平滑）
   * @param {Object} boneRotations 骨骼名(日文) → THREE.Quaternion
   * @param {THREE.SkinnedMesh} mesh
   */
  applyToModel(boneRotations, mesh) {
    if (!this.boneIndexMap) {
      this.init(mesh.skeleton);
    }

    const bones = mesh.skeleton.bones;
    const slerpFactor = this.smoothFactor;
    let applied = 0;
    let missingNames = [];

    for (const [boneName, targetQuat] of Object.entries(boneRotations)) {
      const idx = this.boneIndexMap[boneName];
      if (idx === undefined) {
        missingNames.push(boneName);
        continue;
      }
      const bone = bones[idx];
      if (!bone) continue;

      // slerp 插值平滑（类似 MiKaPo 的 rotateBones(pose, 30)）
      if (this.currentQuats[idx]) {
        bone.quaternion.slerp(targetQuat, slerpFactor);
      } else {
        bone.quaternion.copy(targetQuat);
        this.currentQuats[idx] = true;
      }
      bone.matrixWorldNeedsUpdate = true;
      applied++;
    }

    // 调试日志：每 60 帧打印一次
    if (!this._dbgCounter) this._dbgCounter = 0;
    this._dbgCounter++;
    if (this._dbgCounter % 60 === 1) {
      console.log(`[MMDAdapter] 收到 ${Object.keys(boneRotations).length} 骨骼, 应用 ${applied}`);
      if (missingNames.length > 0) {
        console.warn(`[MMDAdapter] 未映射骨骼: ${missingNames.join(', ')}`);
      }
    }

    // 更新骨骼矩阵（从根骨骼开始递归）
    for (const bone of bones) {
      if (!bone.parent || !bone.parent.isBone) {
        bone.updateMatrixWorld(true);
      }
    }
    mesh.skeleton.update();
    if (mesh.skeleton.boneTexture) {
      mesh.skeleton.computeBoneTexture();
    }

    return applied;
  }

  /**
   * 重置所有骨骼到 rest pose
   */
  resetToRest(mesh) {
    const bones = mesh.skeleton.bones;
    for (let i = 0; i < bones.length; i++) {
      if (this.restQuaternions && this.restQuaternions[i]) {
        bones[i].quaternion.copy(this.restQuaternions[i]);
      } else {
        bones[i].quaternion.identity();
      }
      bones[i].matrixWorldNeedsUpdate = true;
    }
    this.currentQuats = {};
    for (const bone of bones) {
      if (!bone.parent || !bone.parent.isBone) {
        bone.updateMatrixWorld(true);
      }
    }
    mesh.skeleton.update();
    if (mesh.skeleton.boneTexture) {
      mesh.skeleton.computeBoneTexture();
    }
  }
}
