// motionPlanner.js — 动作时间线规划器（Motion Planner）
// 输入：Intent JSON
// 输出：Motion Plan — 精确的分阶段时间线
// 核心规则：必须分阶段，不能跳帧，必须保证连续性

import { getMotion } from './motionLibrary.js';

/**
 * 生成动作时间线
 * @param {Object} intent 解析后的意图
 * @returns {Object} Motion Plan
 */
export function planMotion(intent) {
  const subActions = intent.sub_actions || ['idle'];
  const emotion = intent.emotion || 'neutral';
  const energy = intent.energy || 'medium';
  const executionType = intent.executionType || 'sequence';

  // 获取每个子动作的标准库定义
  const motionDefs = subActions.map(action =>
    getMotion(action, emotion, energy)
  );

  // 根据执行类型生成时间线
  let timeline;
  if (executionType === 'parallel' && motionDefs.length > 1) {
    timeline = buildParallelTimeline(motionDefs);
  } else {
    timeline = buildSequentialTimeline(motionDefs);
  }

  return {
    phases: timeline.phases,
    totalDuration: timeline.totalDuration,
    poseDefinitions: timeline.poseDefinitions,
    intent: intent,
    motionDefs: motionDefs,
  };
}

/**
 * 顺序执行时间线（默认）
 * 动作1 → 动作2 → 动作3 ...
 */
function buildSequentialTimeline(motionDefs) {
  const phases = [];
  const poseDefinitions = {};
  let currentTime = 0;

  // 对每个动作生成阶段
  for (let i = 0; i < motionDefs.length; i++) {
    const motion = motionDefs[i];
    const motionName = motion.name;

    // 获取动作的 pose 时间线
    const poseTimepoints = Object.entries(motion.timeline)
      .map(([time, poseName]) => ({
        time: parseFloat(time),
        poseName,
      }))
      .sort((a, b) => a.time - b.time);

    // 总时间偏移
    for (const tp of poseTimepoints) {
      const absoluteTime = currentTime + tp.time;
      const uniquePoseName = `${motionName}_${tp.poseName}_${i}`;

      // 复制 pose 定义
      poseDefinitions[uniquePoseName] = {
        ...motion.poses[tp.poseName],
      };

      phases.push({
        time: roundTime(absoluteTime),
        pose: uniquePoseName,
        motion: motionName,
        motionIndex: i,
      });
    }

    currentTime += motion.duration;
  }

  // 按时间排序
  phases.sort((a, b) => a.time - b.time);

  return {
    phases,
    totalDuration: roundTime(currentTime),
    poseDefinitions,
  };
}

/**
 * 并行执行时间线（多个动作同时进行）
 * 例如：挥手并点头 → 上半身挥手，头部点头
 */
function buildParallelTimeline(motionDefs) {
  // 找最长的动作时长
  const maxDuration = Math.max(...motionDefs.map(m => m.duration));
  const phases = [];
  const poseDefinitions = {};

  for (let i = 0; i < motionDefs.length; i++) {
    const motion = motionDefs[i];
    const motionName = motion.name;

    const poseTimepoints = Object.entries(motion.timeline)
      .map(([time, poseName]) => ({
        time: parseFloat(time),
        poseName,
      }))
      .sort((a, b) => a.time - b.time);

    for (const tp of poseTimepoints) {
      const absoluteTime = tp.time; // 并行：都从 0 开始
      const uniquePoseName = `${motionName}_${tp.poseName}_${i}`;

      poseDefinitions[uniquePoseName] = {
        ...motion.poses[tp.poseName],
      };

      phases.push({
        time: roundTime(absoluteTime),
        pose: uniquePoseName,
        motion: motionName,
        motionIndex: i,
      });
    }
  }

  // 按时间排序（同一时间点按动作索引排序）
  phases.sort((a, b) => {
    if (a.time !== b.time) return a.time - b.time;
    return a.motionIndex - b.motionIndex;
  });

  return {
    phases,
    totalDuration: roundTime(maxDuration),
    poseDefinitions,
  };
}

/**
 * 时间四舍五入到 0.05 精度
 */
function roundTime(time) {
  return Math.round(time * 20) / 20;
}

/**
 * 生成人类可读的时间线描述
 * @param {Object} plan
 * @returns {string}
 */
export function describePlan(plan) {
  const lines = [];
  lines.push(`总时长: ${plan.totalDuration.toFixed(2)}s`);
  lines.push(`阶段数: ${plan.phases.length}`);
  lines.push('---');

  for (const phase of plan.phases) {
    lines.push(`${phase.time.toFixed(2)}s → ${phase.motion}.${phase.pose.split('_').pop()}`);
  }

  return lines.join('\n');
}

/**
 * 获取动作组合的骨骼冲突检测
 * @param {Object} plan
 * @returns {Array} 冲突列表
 */
export function detectConflicts(plan) {
  const conflicts = [];
  const boneUsage = {}; // boneName -> [{time, motion, angle}]

  for (const phase of plan.phases) {
    const pose = plan.poseDefinitions[phase.pose];
    if (!pose) continue;

    for (const [boneName, actions] of Object.entries(pose)) {
      if (!boneUsage[boneName]) {
        boneUsage[boneName] = [];
      }

      boneUsage[boneName].push({
        time: phase.time,
        motion: phase.motion,
        actions: actions,
      });
    }
  }

  // 检查同一时间点是否有多个动作操作同一骨骼
  for (const [boneName, usages] of Object.entries(boneUsage)) {
    const byTime = {};
    for (const u of usages) {
      const t = u.time.toFixed(1);
      if (!byTime[t]) byTime[t] = [];
      byTime[t].push(u);
    }

    for (const [time, users] of Object.entries(byTime)) {
      const uniqueMotions = [...new Set(users.map(u => u.motion))];
      if (uniqueMotions.length > 1) {
        conflicts.push({
          bone: boneName,
          time: parseFloat(time),
          motions: uniqueMotions,
          details: users,
        });
      }
    }
  }

  return conflicts;
}

/**
 * 合并骨骼冲突（让同一时间点的多个动作对同一骨骼的操作取平均）
 * @param {Object} plan
 * @returns {Object} 修正后的 plan
 */
export function resolveConflicts(plan) {
  const conflicts = detectConflicts(plan);
  if (conflicts.length === 0) return plan;

  // 对每个冲突点，合并骨骼角度
  for (const conflict of conflicts) {
    const timeKey = conflict.time.toFixed(2);

    // 找到此时间点的所有相关 pose
    const relatedPoses = plan.phases
      .filter(p => Math.abs(p.time - conflict.time) < 0.06)
      .map(p => p.pose);

    if (relatedPoses.length < 2) continue;

    // 合并骨骼定义：取第一个动作的角度为主，其他动作减少影响
    const primaryPose = plan.poseDefinitions[relatedPoses[0]];
    for (let i = 1; i < relatedPoses.length; i++) {
      const secondaryPose = plan.poseDefinitions[relatedPoses[i]];
      if (!secondaryPose) continue;

      // 只添加主 pose 中没有的骨骼
      for (const [boneName, actions] of Object.entries(secondaryPose)) {
        if (!primaryPose[boneName]) {
          primaryPose[boneName] = { ...actions };
        }
      }

      // 删除副 pose（已合并到主 pose）
      delete plan.poseDefinitions[relatedPoses[i]];

      // 从 phases 中移除副 pose 项
      const idx = plan.phases.findIndex(p => p.pose === relatedPoses[i]);
      if (idx >= 0) plan.phases.splice(idx, 1);
    }
  }

  // 重新排序
  plan.phases.sort((a, b) => a.time - b.time);

  return plan;
}

/**
 * 便捷：生成并自动修复冲突
 * @param {Object} intent
 * @returns {Object}
 */
export function planAndResolve(intent) {
  const plan = planMotion(intent);
  return resolveConflicts(plan);
}

console.log('[Motion Planner] ✅ 已初始化');
