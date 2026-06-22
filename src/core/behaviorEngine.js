// ============================================================================
//  Behavior State Engine - 行为状态引擎
//  作用: 接收 LLM 的行为状态 JSON → 平滑成连续的 body state
//
//  接收 schema（来自 LLM）:
//  {
//    emotion: { happy, sad, angry, calm },
//    attention: { lookAtUser, headTrackingStrength },
//    body: { posture, energy, leanForward, shoulderRaise },
//    motion_intent: [ { arm, style, rhythm, elevation, amplitude, openness } ]
//  }
//
//  输出 bodyState（驱动 motionGenerator）:
//    emotion.{happy,sad,angry,calm}
//    spine.{leanForward, leanSide, twist}
//    head.lookAtWeight
//    armRight.{active, elevation, openness, amplitude, rhythm, style}
//    armLeft.{...}
//    energy
//    isSpeaking
//    lookAtUser, lookAt
// ============================================================================

import * as THREE from 'three';
import { lerpCriticalDamped } from '../utils/spring.js';

/**
 * 单个手臂参数
 */
function makeArm() {
  return {
    active: false,
    elevation: 0.3,
    openness: 0.4,
    amplitude: 0,
    rhythm: 1.0,
    phase: 0,
    style: 'normal',
  };
}

/**
 * 身体状态向量（驱动 MotionParameterGenerator）
 */
export class BodyState {
  constructor() {
    this.emotion = { happy: 0, sad: 0, angry: 0, calm: 0.7 };
    this.spine = { leanForward: 0, leanSide: 0, twist: 0 };
    this.head = { lookAtWeight: 0.75, tilt: 0 };
    this.armRight = makeArm();
    this.armLeft = makeArm();
    this.energy = 0.4;
    this.isSpeaking = false;
    this.speakVolume = 0.5;
    this.shoulderRaise = 0;
    this.lookAt = new THREE.Vector3(0, 1.5, 2.5);
    this.lookAtUser = true;
  }
}

/**
 * 行为状态引擎
 */
export class BehaviorStateEngine {
  constructor() {
    this.state = new BodyState();
    this.targetState = new BodyState();

    this.emotionSmooth = 3.0;
    this.postureSmooth = 4.0;
    this.energySmooth = 5.0;

    this.lastLLMTime = 0;
    this.globalTime = 0;

    // 人格配置
    this.personality = {
      baseEnergy: 0.4,
      microBreathing: 1.0,
    };
  }

  getRecentHistory(n) {
    return [];
  }

  onUserSpeech(text) {
    // 用户说话时：略抬升能量，让角色有"正在听"的感觉
    this.targetState.energy = Math.max(this.targetState.energy, 0.55);
    this.targetState.spine.leanForward = Math.max(this.targetState.spine.leanForward, 0.08);
  }

  /**
   * 把 LLM 输出解析为目标状态（容错）
   */
  processLLM(llm) {
    const e = llm.emotion || {};
    this.targetState.emotion.happy = clamp(typeof e.happy === 'number' ? e.happy : 0, 0, 1);
    this.targetState.emotion.sad   = clamp(typeof e.sad === 'number' ? e.sad : 0, 0, 1);
    this.targetState.emotion.angry = clamp(typeof e.angry === 'number' ? e.angry : 0, 0, 1);
    this.targetState.emotion.calm  = clamp(typeof e.calm === 'number' ? e.calm : 0, 0, 1);
    // 归一化（防止 AI 随便填 0 导致看起来没精神）
    const total = this.targetState.emotion.happy + this.targetState.emotion.sad
                + this.targetState.emotion.angry + this.targetState.emotion.calm;
    if (total < 0.5) this.targetState.emotion.calm += (0.5 - total);

    // 身体姿态
    const body = llm.body || {};
    const postureMap = {
      open:    { leanForward: 0.05, leanSide: 0 },
      neutral: { leanForward: 0,    leanSide: 0 },
      closed:  { leanForward: -0.05, leanSide: 0 },
    };
    const p = postureMap[body.posture] || postureMap.neutral;
    this.targetState.spine.leanForward = p.leanForward + clamp(body.leanForward || 0, -0.2, 0.3);
    this.targetState.spine.leanSide = p.leanSide;
    this.targetState.spine.twist = 0;

    // 肩膀抬升
    this.targetState.shoulderRaise = clamp(body.shoulderRaise || 0, 0, 1);

    // 能量
    this.targetState.energy = clamp(typeof body.energy === 'number' ? body.energy : 0.4, 0.1, 1);

    // 说话状态（外部设置 isSpeaking）
    this.targetState.isSpeaking = !!llm.isSpeaking;

    // 头部追踪
    const at = llm.attention || {};
    this.targetState.head.lookAtWeight = clamp(
      typeof at.headTrackingStrength === 'number' ? at.headTrackingStrength : 0.7,
      0, 1
    );
    this.targetState.lookAtUser = at.lookAtUser !== false;

    // 动作意图（motion_intent → armRight / armLeft）
    const intents = Array.isArray(llm.motion_intent) ? llm.motion_intent : [];
    // 先重置两侧为不活动
    this.targetState.armRight.active = false;
    this.targetState.armLeft.active = false;
    for (const it of intents) {
      if (!it) continue;
      const sides = [];
      if (it.arm === 'both') { sides.push('Right'); sides.push('Left'); }
      else if (it.arm === 'right') sides.push('Right');
      else if (it.arm === 'left') sides.push('Left');
      else sides.push('Right'); // 默认用右手

      for (const s of sides) {
        const arm = this.targetState['arm' + s];
        arm.active = true;
        arm.elevation = clamp(it.elevation || 0.4, 0, 1);
        arm.openness  = clamp(it.openness || 0.4, 0, 1);
        arm.amplitude = clamp(it.amplitude || 0.4, 0, 1);
        arm.rhythm    = clamp(it.rhythm || 1.0, 0.3, 4);
        arm.style     = (typeof it.style === 'string' && it.style) || 'normal';
      }
    }

    this.lastLLMTime = this.globalTime;
    console.log('[Behavior] → targetState', {
      emotion: this.targetState.emotion,
      energy: this.targetState.energy,
      rightActive: this.targetState.armRight.active,
    });
  }

  /**
   * 每帧更新：平滑 current → target
   * @param {number} dt
   * @param {object} opts
   * @param {boolean} opts.isSpeaking - 是否正在说话，直接覆盖 state.isSpeaking
   */
  update(dt, opts = {}) {
    this.globalTime += dt;
    const s = this.state;
    const t = this.targetState;

    // 情绪平滑
    s.emotion.happy = lerpCriticalDamped(s.emotion.happy, t.emotion.happy, dt, this.emotionSmooth);
    s.emotion.sad   = lerpCriticalDamped(s.emotion.sad,   t.emotion.sad,   dt, this.emotionSmooth);
    s.emotion.angry = lerpCriticalDamped(s.emotion.angry, t.emotion.angry, dt, this.emotionSmooth);
    s.emotion.calm  = lerpCriticalDamped(s.emotion.calm,  t.emotion.calm,  dt, this.emotionSmooth);

    // 情绪自平衡（长时间无新消息 → 回到 calm）
    const silence = this.globalTime - this.lastLLMTime;
    if (silence > 3.0) {
      const decay = Math.min(0.8, (silence - 3.0) / 4.0);
      s.emotion.happy *= (1 - decay * 0.5);
      s.emotion.sad   *= (1 - decay * 0.5);
      s.emotion.angry *= (1 - decay * 0.7);
      s.emotion.calm = lerpCriticalDamped(s.emotion.calm, 0.8, dt, 0.8);
    }

    // 躯干
    s.spine.leanForward = lerpCriticalDamped(s.spine.leanForward, t.spine.leanForward, dt, this.postureSmooth);
    s.spine.leanSide    = lerpCriticalDamped(s.spine.leanSide,    t.spine.leanSide,    dt, this.postureSmooth);
    s.spine.twist       = lerpCriticalDamped(s.spine.twist,       t.spine.twist,       dt, this.postureSmooth);

    // 能量
    s.energy = lerpCriticalDamped(s.energy, t.energy, dt, this.energySmooth);

    // 肩膀抬升（跟随 emotion / energy 慢慢变化）
    s.shoulderRaise = lerpCriticalDamped(s.shoulderRaise, t.shoulderRaise, dt, 3);

    // 手臂
    this._smoothArm(s.armRight, t.armRight, dt);
    this._smoothArm(s.armLeft, t.armLeft, dt);

    // 说话状态
    s.isSpeaking = typeof opts.isSpeaking === 'boolean' ? opts.isSpeaking : t.isSpeaking;

    // 头部凝视
    s.lookAtUser = t.lookAtUser;
    s.head.lookAtWeight = lerpCriticalDamped(s.head.lookAtWeight, t.head.lookAtWeight, dt, 5);
  }

  _smoothArm(cur, tgt, dt) {
    cur.active = tgt.active;
    cur.elevation = lerpCriticalDamped(cur.elevation, tgt.elevation, dt, 4);
    cur.openness  = lerpCriticalDamped(cur.openness,  tgt.openness,  dt, 4);
    cur.amplitude = lerpCriticalDamped(cur.amplitude, tgt.amplitude, dt, 4);
    cur.rhythm    = lerpCriticalDamped(cur.rhythm,    tgt.rhythm,    dt, 3);
    cur.style     = tgt.style;
  }
}

function clamp(v, lo, hi) {
  if (typeof v !== 'number' || isNaN(v)) return lo;
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}
