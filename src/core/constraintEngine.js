// constraintEngine.js — 约束修正器（Constraint Engine）
// 修复不合理的骨骼动作：角度超限、骨骼冲突、时间跳变等

// 骨骼最大角度约束（单位：度）
const BONE_CONSTRAINTS = {
  // 头部：小幅度
  head: {
    bend: { max: 50, min: -30 },
    turn: { max: 45, min: -45 },
    sway: { max: 25, min: -25 },
  },
  neck: {
    bend: { max: 25, min: -20 },
    turn: { max: 30, min: -30 },
    sway: { max: 15, min: -15 },
  },

  // 躯干：中等幅度
  upper_body: {
    bend: { max: 45, min: -30 },
    turn: { max: 30, min: -30 },
    sway: { max: 25, min: -25 },
  },
  lower_body: {
    bend: { max: 30, min: -30 },
    turn: { max: 20, min: -20 },
    sway: { max: 15, min: -15 },
  },
  waist: {
    bend: { max: 45, min: -30 },
    turn: { max: 25, min: -25 },
    sway: { max: 20, min: -20 },
  },

  // 肩膀：中等幅度
  shoulder_l: {
    bend: { max: 60, min: -30 },
    turn: { max: 30, min: -30 },
    sway: { max: 30, min: -30 },
  },
  shoulder_r: {
    bend: { max: 60, min: -30 },
    turn: { max: 30, min: -30 },
    sway: { max: 30, min: -30 },
  },

  // 手臂：大幅度
  arm_l: {
    bend: { max: 130, min: 0 },
    turn: { max: 60, min: -60 },
    sway: { max: 120, min: -120 },
  },
  arm_r: {
    bend: { max: 130, min: 0 },
    turn: { max: 60, min: -60 },
    sway: { max: 120, min: -120 },
  },

  // 肘关节：单向
  elbow_l: {
    bend: { max: 120, min: -10 },
  },
  elbow_r: {
    bend: { max: 120, min: -10 },
  },

  // 手腕：中等幅度
  wrist_l: {
    bend: { max: 60, min: -45 },
    turn: { max: 30, min: -30 },
    sway: { max: 30, min: -30 },
  },
  wrist_r: {
    bend: { max: 60, min: -45 },
    turn: { max: 30, min: -30 },
    sway: { max: 30, min: -30 },
  },

  // 腿部：大幅度
  leg_l: {
    bend: { max: 90, min: -45 },
    turn: { max: 30, min: -30 },
    sway: { max: 30, min: -30 },
  },
  leg_r: {
    bend: { max: 90, min: -45 },
    turn: { max: 30, min: -30 },
    sway: { max: 30, min: -30 },
  },

  // 膝关节：单向（只能向后弯）
  knee_l: {
    bend: { max: 0, min: -120 },
  },
  knee_r: {
    bend: { max: 0, min: -120 },
  },

  // 脚踝：小幅度
  ankle_l: {
    bend: { max: 30, min: -45 },
  },
  ankle_r: {
    bend: { max: 30, min: -45 },
  },

  // 脚趾：小幅度
  toe_l: {
    bend: { max: 30, min: 0 },
  },
  toe_r: {
    bend: { max: 30, min: 0 },
  },
};

// 时间线最大跳变（度/秒）
const MAX_ROTATION_SPEED = 200; // 200 度/秒

/**
 * 对 Motion Plan 进行约束检查和修正
 * @param {Object} plan
 * @returns {Object} { plan, fixes: [...], isValid }
 */
export function applyConstraints(plan) {
  const fixes = [];
  let totalClamped = 0;

  // 遍历所有 pose 中的骨骼动作
  for (const [poseName, boneDefs] of Object.entries(plan.poseDefinitions)) {
    for (const [boneName, actions] of Object.entries(boneDefs)) {
      const constraint = BONE_CONSTRAINTS[boneName];
      if (!constraint) continue;

      for (const [actionName, params] of Object.entries(actions)) {
        const actionConstraint = constraint[actionName];
        if (!actionConstraint) continue;

        for (const [direction, angle] of Object.entries(params)) {
          // 取绝对值判断是否超限
          const absAngle = Math.abs(angle);
          const maxAngle = Math.max(Math.abs(actionConstraint.max), Math.abs(actionConstraint.min));

          if (absAngle > maxAngle) {
            // 角度超限，clamp
            const clampedAngle = angle > 0 ? maxAngle : -maxAngle;
            plan.poseDefinitions[poseName][boneName][actionName][direction] = clampedAngle;

            fixes.push({
              type: 'angle_clamp',
              bone: boneName,
              action: `${actionName} ${direction}`,
              pose: poseName,
              original: angle,
              clamped: clampedAngle,
            });
            totalClamped++;
          }

          // 检查最小角度（膝关节等单向关节）
          const signedAngle = angle;
          if (signedAngle > actionConstraint.max) {
            plan.poseDefinitions[poseName][boneName][actionName][direction] = actionConstraint.max;
            fixes.push({
              type: 'angle_upper_clamp',
              bone: boneName,
              action: `${actionName} ${direction}`,
              pose: poseName,
              original: signedAngle,
              clamped: actionConstraint.max,
            });
          }
          if (signedAngle < actionConstraint.min) {
            plan.poseDefinitions[poseName][boneName][actionName][direction] = actionConstraint.min;
            fixes.push({
              type: 'angle_lower_clamp',
              bone: boneName,
              action: `${actionName} ${direction}`,
              pose: poseName,
              original: signedAngle,
              clamped: actionConstraint.min,
            });
          }
        }
      }
    }
  }

  // 检查时间线跳变（同一骨骼在相邻时间点角度变化过大）
  const timeJumps = checkTimeContinuity(plan);
  for (const jump of timeJumps) {
    fixes.push(jump);
    totalClamped++;
  }

  return {
    plan,
    fixes,
    totalClamped,
    isValid: true,
  };
}

/**
 * 检查时间线连续性，避免同一骨骼在相邻时间点角度跳变过大
 */
function checkTimeContinuity(plan) {
  const fixes = [];

  // 按骨骼分组时间线
  const boneTimelines = {};

  for (const phase of plan.phases) {
    const pose = plan.poseDefinitions[phase.pose];
    if (!pose) continue;

    for (const [boneName, actions] of Object.entries(pose)) {
      if (!boneTimelines[boneName]) {
        boneTimelines[boneName] = [];
      }

      // 计算这个 pose 中该骨骼的总角度影响
      let totalAngle = 0;
      for (const [actionName, params] of Object.entries(actions)) {
        for (const angle of Object.values(params)) {
          totalAngle += angle;
        }
      }

      boneTimelines[boneName].push({
        time: phase.time,
        angle: totalAngle,
        pose: phase.pose,
      });
    }
  }

  // 检查每个骨骼的时间线跳变
  for (const [boneName, timeline] of Object.entries(boneTimelines)) {
    timeline.sort((a, b) => a.time - b.time);

    for (let i = 1; i < timeline.length; i++) {
      const dt = timeline[i].time - timeline[i - 1].time;
      if (dt === 0) continue;

      const dAngle = Math.abs(timeline[i].angle - timeline[i - 1].angle);
      const speed = dAngle / dt;

      if (speed > MAX_ROTATION_SPEED) {
        fixes.push({
          type: 'time_jump',
          bone: boneName,
          fromTime: timeline[i - 1].time,
          toTime: timeline[i].time,
          angleDelta: dAngle,
          speed: speed,
          maxSpeed: MAX_ROTATION_SPEED,
        });
      }
    }
  }

  return fixes;
}

/**
 * 在相邻关键帧之间插入过渡帧
 * 避免角度跳变过大
 */
export function smoothTimeJumps(plan) {
  const boneTimelines = {};

  // 构建每条骨骼的时间线
  for (const phase of plan.phases) {
    const pose = plan.poseDefinitions[phase.pose];
    if (!pose) continue;

    for (const [boneName, actions] of Object.entries(pose)) {
      if (!boneTimelines[boneName]) {
        boneTimelines[boneName] = [];
      }

      let totalAngle = 0;
      for (const [actionName, params] of Object.entries(actions)) {
        for (const angle of Object.values(params)) {
          totalAngle += angle;
        }
      }

      boneTimelines[boneName].push({
        time: phase.time,
        angle: totalAngle,
        phase: phase,
      });
    }
  }

  let insertionsNeeded = false;

  // 检查并建议插入过渡帧
  for (const [boneName, timeline] of Object.entries(boneTimelines)) {
    timeline.sort((a, b) => a.time - b.time);

    for (let i = 1; i < timeline.length; i++) {
      const dt = timeline[i].time - timeline[i - 1].time;
      if (dt === 0) continue;

      const dAngle = Math.abs(timeline[i].angle - timeline[i - 1].angle);
      const speed = dAngle / dt;

      if (speed > MAX_ROTATION_SPEED) {
        // 在中间插入一个过渡时间点
        const midTime = (timeline[i].time + timeline[i - 1].time) / 2;
        const midPoseName = `smooth_${boneName}_${i}`;

        // 插入插值 pose
        const midAngle = (timeline[i].angle + timeline[i - 1].angle) / 2;
        plan.poseDefinitions[midPoseName] = {
          [boneName]: {
            bend: { forward: midAngle },
          },
        };

        plan.phases.push({
          time: midTime,
          pose: midPoseName,
          motion: 'smooth',
        });

        insertionsNeeded = true;
      }
    }
  }

  if (insertionsNeeded) {
    plan.phases.sort((a, b) => a.time - b.time);
  }

  return plan;
}

/**
 * 修正 MPL 脚本中的角度约束
 * 输入：MPL 脚本字符串
 * 输出：修正后的 MPL 脚本
 */
export function constrainMPLScript(mplScript) {
  // 简单的正则匹配：boneName action direction angle;
  const pattern = /(\w+)\s+(bend|turn|sway)\s+(forward|backward|left|right|up|down)\s+(-?\d+\.?\d*)/g;

  let match;
  const fixes = [];

  const result = mplScript.replace(pattern, (match, boneName, action, direction, angleStr) => {
    const angle = parseFloat(angleStr);
    const constraint = BONE_CONSTRAINTS[boneName];

    if (!constraint) return match;

    const actionConstraint = constraint[action];
    if (!actionConstraint) return match;

    const maxAngle = Math.max(Math.abs(actionConstraint.max), Math.abs(actionConstraint.min));
    const absAngle = Math.abs(angle);

    if (absAngle > maxAngle) {
      const clamped = angle > 0 ? maxAngle : -maxAngle;
      fixes.push({
        bone: boneName,
        action: `${action} ${direction}`,
        original: angle,
        clamped: clamped,
      });
      return `${boneName} ${action} ${direction} ${Math.round(clamped * 10) / 10}`;
    }

    // 检查有符号约束（如膝关节）
    if (angle > actionConstraint.max) {
      fixes.push({
        bone: boneName,
        action: `${action} ${direction}`,
        original: angle,
        clamped: actionConstraint.max,
      });
      return `${boneName} ${action} ${direction} ${actionConstraint.max}`;
    }
    if (angle < actionConstraint.min) {
      fixes.push({
        bone: boneName,
        action: `${action} ${direction}`,
        original: angle,
        clamped: actionConstraint.min,
      });
      return `${boneName} ${action} ${direction} ${actionConstraint.min}`;
    }

    return match;
  });

  return {
    script: result,
    fixes,
    totalFixed: fixes.length,
  };
}

// 获取某个骨骼的约束
export function getBoneConstraint(boneName) {
  return BONE_CONSTRAINTS[boneName] || null;
}

// 列出所有受约束的骨骼
export function listConstrainedBones() {
  return Object.keys(BONE_CONSTRAINTS);
}

console.log('[Constraint Engine] ✅ 已加载', Object.keys(BONE_CONSTRAINTS).length, '个骨骼约束');
