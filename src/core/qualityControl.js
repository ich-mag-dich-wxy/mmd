// qualityControl.js — 质量控制系统（Quality Control）
// 自动评分：smoothness + realism + joint_validity + continuity

/**
 * 评估 Motion Plan 质量
 * @param {Object} plan
 * @returns {Object} { totalScore, scores, issues, recommendations }
 */
export function evaluatePlan(plan) {
  const scores = {
    smoothness: 0,   // 平滑度：时间线插值质量
    realism: 0,      // 真实度：动作幅度是否合理
    jointValidity: 0, // 关节有效性：骨骼约束检查
    continuity: 0,   // 连续性：时间线是否单调
  };

  const issues = [];
  const recommendations = [];

  // 1. 平滑度评分
  const smoothnessScore = evaluateSmoothness(plan, issues);
  scores.smoothness = smoothnessScore;

  // 2. 真实度评分
  const realismScore = evaluateRealism(plan, issues);
  scores.realism = realismScore;

  // 3. 关节有效性评分
  const jointScore = evaluateJointValidity(plan, issues);
  scores.jointValidity = jointScore;

  // 4. 连续性评分
  const continuityScore = evaluateContinuity(plan, issues);
  scores.continuity = continuityScore;

  // 总分
  const totalScore = Math.round(
    (scores.smoothness + scores.realism + scores.jointValidity + scores.continuity) / 4
  );

  // 生成建议
  if (scores.smoothness < 70) {
    recommendations.push('动作过渡不够平滑，建议增加中间关键帧或减小单帧角度变化');
  }
  if (scores.realism < 70) {
    recommendations.push('动作幅度过大，不够自然，建议减小夸张程度');
  }
  if (scores.jointValidity < 70) {
    recommendations.push('存在骨骼角度超限，建议检查并修正关节约束');
  }
  if (scores.continuity < 70) {
    recommendations.push('时间线不连续，存在跳变，建议检查 phase 时间顺序');
  }

  if (issues.length === 0) {
    issues.push('暂无明显问题');
  }
  if (recommendations.length === 0) {
    recommendations.push('动作质量良好，无需修改');
  }

  return {
    totalScore,
    scores,
    issues,
    recommendations,
    needsImprovement: totalScore < 75,
  };
}

/**
 * 平滑度评估
 */
function evaluateSmoothness(plan, issues) {
  if (!plan.phases || plan.phases.length === 0) return 0;

  let totalTransition = 0;
  let maxJump = 0;
  const boneChanges = {};

  for (let i = 1; i < plan.phases.length; i++) {
    const prev = plan.phases[i - 1];
    const curr = plan.phases[i];

    const dt = curr.time - prev.time;
    if (dt <= 0) continue;

    const prevPose = plan.poseDefinitions[prev.pose];
    const currPose = plan.poseDefinitions[curr.pose];
    if (!prevPose || !currPose) continue;

    // 计算每根骨骼的角度变化
    const allBones = new Set([...Object.keys(prevPose), ...Object.keys(currPose)]);

    for (const boneName of allBones) {
      let prevAngle = getTotalAngle(prevPose[boneName]);
      let currAngle = getTotalAngle(currPose[boneName]);

      const delta = Math.abs(currAngle - prevAngle);
      const speed = delta / dt;

      if (!boneChanges[boneName]) boneChanges[boneName] = [];
      boneChanges[boneName].push({
        time: curr.time,
        speed,
      });

      if (speed > maxJump) maxJump = speed;
      totalTransition += speed;
    }
  }

  const avgSpeed = totalTransition / Math.max(plan.phases.length, 1);

  // 评分：速度越合理分数越高
  let score = 100;

  if (maxJump > 200) {
    score -= 20;
    issues.push(`骨骼最大角速度过高: ${maxJump.toFixed(0)} 度/秒 (建议 < 200)`);
  }
  if (avgSpeed > 100) {
    score -= 15;
    issues.push(`平均角速度偏高: ${avgSpeed.toFixed(0)} 度/秒`);
  }

  return Math.max(0, score);
}

/**
 * 真实度评估
 */
function evaluateRealism(plan, issues) {
  if (!plan.poseDefinitions) return 0;

  let totalAngle = 0;
  let excessiveAngleCount = 0;
  let poseCount = 0;

  for (const [poseName, boneDefs] of Object.entries(plan.poseDefinitions)) {
    poseCount++;
    for (const [boneName, actions] of Object.entries(boneDefs)) {
      const angle = getTotalAngle(actions);
      totalAngle += angle;

      // 检查是否过度夸张
      if (boneName.startsWith('head') || boneName.startsWith('neck')) {
        if (angle > 50) {
          excessiveAngleCount++;
          issues.push(`${poseName} 中 ${boneName} 角度过大: ${angle.toFixed(0)}度`);
        }
      }
    }
  }

  const avgAngle = totalAngle / Math.max(poseCount * 5, 1); // 假设每 pose 约 5 个骨骼有动作

  let score = 100;
  if (avgAngle > 40) {
    score -= 15;
    issues.push(`平均动作幅度偏高: ${avgAngle.toFixed(0)}度`);
  }
  if (excessiveAngleCount > 2) {
    score -= excessiveAngleCount * 5;
  }

  return Math.max(0, score);
}

/**
 * 关节有效性评估（基于约束）
 */
function evaluateJointValidity(plan, issues) {
  if (!plan.poseDefinitions) return 0;

  let violations = 0;
  let totalChecks = 0;

  // 骨骼最大角度表（简化）
  const MAX_ANGLES = {
    head: 50, neck: 30, upper_body: 45, waist: 45,
    shoulder_l: 60, shoulder_r: 60,
    arm_l: 130, arm_r: 130,
    elbow_l: 120, elbow_r: 120,
    wrist_l: 60, wrist_r: 60,
    leg_l: 90, leg_r: 90,
    knee_l: 120, knee_r: 120,
    ankle_l: 45, ankle_r: 45,
  };

  for (const [poseName, boneDefs] of Object.entries(plan.poseDefinitions)) {
    for (const [boneName, actions] of Object.entries(boneDefs)) {
      totalChecks++;

      const maxAngle = MAX_ANGLES[boneName] || 90;
      const angle = getTotalAngle(actions);

      if (angle > maxAngle) {
        violations++;
        issues.push(`${poseName} 中 ${boneName} 角度 ${angle.toFixed(0)}度 超过限制 ${maxAngle}度`);
      }
    }
  }

  const violationRate = violations / Math.max(totalChecks, 1);
  const score = Math.round(100 * (1 - violationRate * 3)); // 每 33% 的违规扣 100 分

  if (violations > 0) {
    issues.push(`共发现 ${violations}/${totalChecks} 个骨骼角度约束违规`);
  }

  return Math.max(0, score);
}

/**
 * 时间连续性评估
 */
function evaluateContinuity(plan, issues) {
  if (!plan.phases || plan.phases.length === 0) return 0;

  const sortedPhases = [...plan.phases].sort((a, b) => a.time - b.time);

  let backwards = 0;
  let duplicates = 0;
  let gaps = 0;

  for (let i = 1; i < sortedPhases.length; i++) {
    const dt = sortedPhases[i].time - sortedPhases[i - 1].time;

    if (dt < 0) backwards++;
    else if (dt === 0) duplicates++;
    else if (dt > 1.0) gaps++;
  }

  let score = 100;

  if (backwards > 0) {
    score -= backwards * 20;
    issues.push(`发现 ${backwards} 处时间倒退`);
  }
  if (duplicates > 2) {
    score -= 10;
    issues.push(`发现 ${duplicates} 处重复时间点`);
  }
  if (gaps > 0) {
    score -= gaps * 10;
    issues.push(`发现 ${gaps} 处时间间隔过长 (>1秒)`);
  }

  return Math.max(0, score);
}

// 计算一个骨骼动作定义的总角度
function getTotalAngle(boneDef) {
  if (!boneDef) return 0;
  let total = 0;
  for (const [actionName, params] of Object.entries(boneDef)) {
    for (const angle of Object.values(params)) {
      total += Math.abs(angle || 0);
    }
  }
  return total;
}

/**
 * 评估 MPL 脚本质量（字符串级别）
 */
export function evaluateMPLScript(mplScript) {
  // 统计 pose 数量
  const poseCount = (mplScript.match(/@pose/g) || []).length;

  // 统计关键帧数量
  const timeMatches = mplScript.match(/\d+\.?\d*:/g) || [];
  const keyframeCount = timeMatches.length;

  // 检查是否有归位帧（角度为 0 的 pose）
  const hasRestPose = /forward\s+0|backward\s+0/.test(mplScript);

  // 检查时间线是否单调
  const numbers = timeMatches.map(m => parseFloat(m));
  let isMonotonic = true;
  for (let i = 1; i < numbers.length; i++) {
    if (numbers[i] < numbers[i - 1]) {
      isMonotonic = false;
      break;
    }
  }

  // 基础评分
  const issues = [];
  let score = 100;

  if (poseCount === 0) {
    score -= 40;
    issues.push('没有找到 pose 定义');
  }
  if (keyframeCount === 0) {
    score -= 40;
    issues.push('没有找到动画时间线');
  }
  if (keyframeCount < 3) {
    score -= 15;
    issues.push('关键帧数量过少 (<3)，动画可能不流畅');
  }
  if (!hasRestPose && keyframeCount > 0) {
    score -= 15;
    issues.push('没有归位帧，动画结束后角色不会回到初始姿势');
  }
  if (!isMonotonic && numbers.length > 1) {
    score -= 20;
    issues.push('时间线不是单调递增，动画播放顺序不正确');
  }

  return {
    score: Math.max(0, score),
    poseCount,
    keyframeCount,
    hasRestPose,
    isMonotonic,
    issues,
  };
}

/**
 * 判断是否需要重新生成（总分 < 阈值）
 */
export function shouldRegenerate(evaluation) {
  return evaluation.totalScore < 75;
}

/**
 * 生成可读的质量报告
 */
export function generateReport(evaluation) {
  const lines = [];
  lines.push(`===== 动作质量报告 =====`);
  lines.push(`总分: ${evaluation.totalScore}/100`);
  lines.push(`平滑度: ${evaluation.scores.smoothness}/100`);
  lines.push(`真实度: ${evaluation.scores.realism}/100`);
  lines.push(`关节有效性: ${evaluation.scores.jointValidity}/100`);
  lines.push(`连续性: ${evaluation.scores.continuity}/100`);
  lines.push('');
  lines.push('--- 问题 ---');
  for (const issue of evaluation.issues) {
    lines.push(`- ${issue}`);
  }
  lines.push('');
  lines.push('--- 建议 ---');
  for (const rec of evaluation.recommendations) {
    lines.push(`- ${rec}`);
  }
  return lines.join('\n');
}

console.log('[Quality Control] ✅ 已初始化');
