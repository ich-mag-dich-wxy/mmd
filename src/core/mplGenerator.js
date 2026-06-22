// mplGenerator.js — MPL 脚本生成器（MPL Generator）
// 输入：Motion Plan（时间线 + pose 定义）
// 输出：MPL 脚本字符串（供 mplPipeline.js 解析）

/**
 * 从 Motion Plan 生成 MPL 脚本
 * @param {Object} plan Motion Plan
 * @returns {string} MPL 脚本
 */
export function generateMPL(plan) {
  const poseLines = [];
  const animationLines = [];
  const poseNames = [];

  // 生成 @pose 定义
  for (const [poseName, boneDefs] of Object.entries(plan.poseDefinitions)) {
    const boneLines = [];

    for (const [boneName, actions] of Object.entries(boneDefs)) {
      // 每个骨骼可能有多个动作（bend, turn, sway 等）
      for (const [actionName, params] of Object.entries(actions)) {
        for (const [direction, angle] of Object.entries(params)) {
          const roundedAngle = Math.round(angle * 10) / 10;
          if (roundedAngle !== 0) {
            boneLines.push(`    ${boneName} ${actionName} ${direction} ${roundedAngle};`);
          }
        }
      }
    }

    if (boneLines.length > 0) {
      poseNames.push(poseName);
      poseLines.push(`  @pose ${poseName} {\n${boneLines.join('\n')}\n  }`);
    }
  }

  // 生成 @animation 时间线
  // 按时间排序 phases
  const sortedPhases = [...plan.phases].sort((a, b) => a.time - b.time);

  for (const phase of sortedPhases) {
    const poseName = phase.pose;
    if (!plan.poseDefinitions[poseName]) continue; // 跳过被删除的 pose

    // 时间格式化为小数点后两位（如 0.00, 0.30, 1.50）
    const timeStr = formatTime(phase.time);
    animationLines.push(`    ${timeStr}: ${poseName};`);
  }

  const totalDuration = formatTime(plan.totalDuration);

  // 组装完整脚本
  let script = '';
  script += '@motion main {\n';
  script += poseLines.join('\n');
  script += '\n';
  script += '  @animation timeline {\n';
  script += animationLines.join('\n');
  script += '\n  }\n';
  script += `  @duration ${totalDuration};\n`;
  script += '}';

  return script;
}

/**
 * 生成更简洁的 MPL 格式（使用原始 @pose @animation main 三段式）
 * 与现有 mplPipeline.js 兼容
 * @param {Object} plan Motion Plan
 * @returns {string} MPL 脚本
 */
export function generateClassicMPL(plan) {
  const poseLines = [];
  const timelineLines = [];
  const poseNames = new Set();

  // 生成 @pose 定义
  for (const [poseName, boneDefs] of Object.entries(plan.poseDefinitions)) {
    const boneLines = [];

    for (const [boneName, actions] of Object.entries(boneDefs)) {
      for (const [actionName, params] of Object.entries(actions)) {
        for (const [direction, angle] of Object.entries(params)) {
          const roundedAngle = Math.round(angle * 10) / 10;
          if (roundedAngle !== 0) {
            boneLines.push(`    ${boneName} ${actionName} ${direction} ${roundedAngle};`);
          }
        }
      }
    }

    if (boneLines.length > 0) {
      poseNames.add(poseName);
      poseLines.push(`@pose ${poseName} {\n${boneLines.join('\n')}\n}`);
    }
  }

  // 生成 @animation 时间线
  const sortedPhases = [...plan.phases]
    .filter(p => poseNames.has(p.pose))
    .sort((a, b) => a.time - b.time);

  for (const phase of sortedPhases) {
    const timeStr = formatTime(phase.time);
    timelineLines.push(`  ${timeStr}: ${phase.pose};`);
  }

  // 组装
  let script = '';
  script += poseLines.join('\n');
  script += '\n';
  script += '@animation motion {\n';
  script += timelineLines.join('\n');
  script += '\n}\n';
  script += 'main { motion; }';

  return script;
}

/**
 * 直接生成 keyframe 格式（用于 mplPipeline.js 的 createAnimationClip）
 * 不经过脚本解析，直接生成骨骼动画关键帧
 * @param {Object} plan Motion Plan
 * @returns {Array} keyframes 列表 [{time, boneRotations: {boneName: {x,y,z,w}}}]
 */
export function generateKeyframes(plan) {
  const keyframes = [];
  const sortedPhases = [...plan.phases].sort((a, b) => a.time - b.time);

  for (const phase of sortedPhases) {
    const pose = plan.poseDefinitions[phase.pose];
    if (!pose) continue;

    // 将 pose 定义转换为骨骼旋转四元数
    const boneRotations = {};

    for (const [boneName, actions] of Object.entries(pose)) {
      // 合并多个动作（bend, turn, sway）到一个四元数
      const quat = { x: 0, y: 0, z: 0, w: 1 };
      let hasRotation = false;

      for (const [actionName, params] of Object.entries(actions)) {
        for (const [direction, angle] of Object.entries(params)) {
          if (angle !== 0) {
            // 简化：直接以角度作为欧拉角分量
            const rad = angle * Math.PI / 180;
            const axis = getAxisForAction(actionName, direction);
            const partialQuat = eulerToQuat(axis.x * rad, axis.y * rad, axis.z * rad);
            quatMultiply(quat, partialQuat);
            hasRotation = true;
          }
        }
      }

      if (hasRotation) {
        // 归一化
        normalizeQuat(quat);
        boneRotations[boneName] = quat;
      }
    }

    if (Object.keys(boneRotations).length > 0) {
      keyframes.push({
        time: phase.time,
        pose: phase.pose,
        motion: phase.motion,
        boneRotations: boneRotations,
      });
    }
  }

  return keyframes;
}

// 获取动作的旋转轴（简化版，与 mplPipeline.js 中的 BONE_AXES 对应）
function getAxisForAction(actionName, direction) {
  const dirMap = {
    'forward': 'f', 'backward': 'b',
    'left': 'l', 'right': 'r',
    'up': 'u', 'down': 'd',
  };
  const d = dirMap[direction] || 'f';

  // 简化的轴映射
  const axisMap = {
    'bend': {
      'f': { x: 0, y: 0, z: 1 },
      'b': { x: 0, y: 0, z: -1 },
    },
    'turn': {
      'l': { x: 0, y: 1, z: 0 },
      'r': { x: 0, y: -1, z: 0 },
    },
    'sway': {
      'l': { x: 1, y: 0, z: 0 },
      'r': { x: -1, y: 0, z: 0 },
    },
  };

  return axisMap[actionName]?.[d] || { x: 0, y: 0, z: 1 };
}

// 简单的欧拉角 → 四元数（用于方向角）
function eulerToQuat(x, y, z) {
  const cx = Math.cos(x / 2), sx = Math.sin(x / 2);
  const cy = Math.cos(y / 2), sy = Math.sin(y / 2);
  const cz = Math.cos(z / 2), sz = Math.sin(z / 2);

  return {
    x: sx * cy * cz - cx * sy * sz,
    y: cx * sy * cz + sx * cy * sz,
    z: cx * cy * sz - sx * sy * cz,
    w: cx * cy * cz + sx * sy * sz,
  };
}

// 四元数乘法（修改第一个参数）
function quatMultiply(q1, q2) {
  const x = q1.w * q2.x + q1.x * q2.w + q1.y * q2.z - q1.z * q2.y;
  const y = q1.w * q2.y - q1.x * q2.z + q1.y * q2.w + q1.z * q2.x;
  const z = q1.w * q2.z + q1.x * q2.y - q1.y * q2.x + q1.z * q2.w;
  const w = q1.w * q2.w - q1.x * q2.x - q1.y * q2.y - q1.z * q2.z;
  q1.x = x; q1.y = y; q1.z = z; q1.w = w;
}

// 四元数归一化
function normalizeQuat(q) {
  const len = Math.sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
  if (len > 0) {
    q.x /= len; q.y /= len; q.z /= len; q.w /= len;
  }
}

/**
 * 格式化时间（保留两位小数）
 */
function formatTime(time) {
  const t = Math.round(time * 100) / 100;
  // 简化：去掉多余的 0
  if (t === Math.floor(t)) return t.toFixed(1);
  return t.toFixed(2);
}

/**
 * 验证 MPL 脚本是否有语法问题（基础检查）
 */
export function validateMPL(script) {
  const errors = [];

  if (!script || typeof script !== 'string') {
    errors.push('脚本为空');
    return { valid: false, errors };
  }

  if (!script.includes('@pose')) {
    errors.push('缺少 @pose 定义');
  }
  if (!script.includes('@animation')) {
    errors.push('缺少 @animation 定义');
  }
  if (!script.includes('main')) {
    errors.push('缺少 main 入口');
  }

  // 检查时间线是否单调递增
  const timeRegex = /(\d+\.?\d*):\s*(\w+)/g;
  const times = [];
  let match;
  while ((match = timeRegex.exec(script))) {
    times.push(parseFloat(match[1]));
  }
  for (let i = 1; i < times.length; i++) {
    if (times[i] < times[i - 1]) {
      errors.push(`时间线不单调: ${times[i - 1]} → ${times[i]}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    poseCount: (script.match(/@pose/g) || []).length,
    keyframeCount: times.length,
  };
}

console.log('[MPL Generator] ✅ 已初始化');
