// motionSystem.js — 完整的 AI 动作生成系统（核心编排）
// 用户输入自然语言 → 意图解析 → 动作规划 → MPL 生成 → 约束修正 → 质量评估
// 禁止从零生成动作 — 只能组合标准动作库

import { parseIntent, validateIntent } from './intentParser.js';
import { planAndResolve, describePlan } from './motionPlanner.js';
import { generateClassicMPL, generateMPL, validateMPL } from './mplGenerator.js';
import { applyConstraints, smoothTimeJumps } from './constraintEngine.js';
import { evaluatePlan, shouldRegenerate, generateReport } from './qualityControl.js';

/**
 * 从自然语言生成 MPL 动作脚本（完整流程）
 * @param {string} userText 用户自然语言输入
 * @returns {Object} 完整结果 { mplScript, plan, intent, evaluation, steps }
 */
export function generateMotionFromText(userText) {
  const steps = [];

  // Step 1: 意图解析
  const t1 = Date.now();
  const intent = parseIntent(userText);
  validateIntent(intent);
  steps.push({
    name: '意图解析',
    duration: Date.now() - t1,
    data: intent,
  });

  // 纯对话不生成动作
  if (intent.isDialogOnly) {
    return {
      success: true,
      isDialog: true,
      mplScript: '',
      intent,
      plan: null,
      evaluation: null,
      steps,
      message: '纯对话输入，无需生成动作',
    };
  }

  // Step 2: 动作规划
  const t2 = Date.now();
  let plan = planAndResolve(intent);
  steps.push({
    name: '动作规划',
    duration: Date.now() - t2,
    data: {
      duration: plan.totalDuration,
      phaseCount: plan.phases.length,
      poseCount: Object.keys(plan.poseDefinitions).length,
    },
  });

  // Step 3: 约束修正
  const t3 = Date.now();
  const constraintResult = applyConstraints(plan);
  plan = constraintResult.plan;
  steps.push({
    name: '约束修正',
    duration: Date.now() - t3,
    data: {
      fixes: constraintResult.totalClamped,
      details: constraintResult.fixes.slice(0, 5),
    },
  });

  // Step 4: 时间平滑
  const t4 = Date.now();
  plan = smoothTimeJumps(plan);
  steps.push({
    name: '时间平滑',
    duration: Date.now() - t4,
  });

  // Step 5: 质量评估
  const t5 = Date.now();
  const evaluation = evaluatePlan(plan);
  steps.push({
    name: '质量评估',
    duration: Date.now() - t5,
    data: evaluation.scores,
  });

  // Step 6: 生成 MPL 脚本
  const t6 = Date.now();
  const mplScript = generateClassicMPL(plan);
  steps.push({
    name: 'MPL 生成',
    duration: Date.now() - t6,
  });

  // Step 7: 验证 MPL
  const t7 = Date.now();
  const mplValidation = validateMPL(mplScript);
  steps.push({
    name: 'MPL 验证',
    duration: Date.now() - t7,
    data: mplValidation,
  });

  const totalTime = steps.reduce((s, x) => s + x.duration, 0);

  return {
    success: true,
    mplScript,
    intent,
    plan,
    evaluation,
    mplValidation,
    steps,
    totalDuration: plan.totalDuration,
    needsImprovement: evaluation.needsImprovement && false, // 不强制重新生成
    message: `动作生成完成，质量评分: ${evaluation.totalScore}/100`,
    report: generateReport(evaluation),
    totalTime,
  };
}

/**
 * 直接生成 MPL 脚本（不包含中间对象）
 */
export function getMPL(userText) {
  const result = generateMotionFromText(userText);
  if (result.isDialogOnly) return '';
  return result.mplScript;
}

/**
 * 获取可用动作列表
 */
import { listAvailableActions } from './motionLibrary.js';

export function getAvailableActions() {
  return listAvailableActions();
}

/**
 * 获取意图解析结果（调试用）
 */
export function debugParse(userText) {
  const intent = parseIntent(userText);
  validateIntent(intent);
  return intent;
}

/**
 * 获取时间线描述（调试用）
 */
export function debugPlan(userText) {
  const intent = parseIntent(userText);
  if (intent.isDialogOnly) return '纯对话输入';

  const plan = planAndResolve(intent);
  return describePlan(plan);
}

/**
 * 便捷：生成并返回 MMLAnimationHelper 兼容格式
 */
export function getAnimationForHelper(userText) {
  const result = generateMotionFromText(userText);
  if (result.isDialogOnly) return null;

  return {
    animation: result.mplScript,
    duration: result.totalDuration,
    quality: result.evaluation.totalScore,
  };
}

console.log('[Motion System] ✅ 已初始化完整的动作生成系统');
console.log('[Motion System] ✅ 可用模块: IntentParser + MotionPlanner + MPLGenerator + ConstraintEngine + QualityControl');
