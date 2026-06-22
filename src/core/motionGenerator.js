// ============================================================================
//  Motion Parameter Generator - 运动参数生成器
//
//  输入: BehaviorEngine.state（bodyState）
//  输出: MotionField（骨骼目标函数场 + morph 目标）
//
//  核心: AI 不输出"动作"，而是输出情绪/能量/手势参数。
//        这里把这些参数转换为每帧变化的 骨骼目标 / morph 目标。
// ============================================================================

import * as THREE from 'three';
import { FBMNoise, MicroJitter } from '../utils/noise.js';

/**
 * MotionField: 最终骨骼与 morph 的目标值（每帧重新生成）
 */
export class MotionField {
  constructor() {
    this.spineLean = { x: 0, y: 0, z: 0 };
    this.spineTwist = 0;

    this.head = { lookAtWeight: 0.75 };
    this.headLookAt = new THREE.Vector3(0, 1.6, 2.5);
    this.headOffset = new THREE.Vector3(); // 微抖动（X/Y/Z 单位: 米，约 0.01 量级）

    this.rightHandTarget = new THREE.Vector3();
    this.leftHandTarget = new THREE.Vector3();
    this.rightHandActive = false;
    this.leftHandActive = false;

    this.rightHandOpenness = 0.3;
    this.leftHandOpenness = 0.3;

    this.rightShoulderRaise = 0;
    this.leftShoulderRaise = 0;

    // 手指弯曲（0=放松，1=握紧）
    this.rightFingers = { thumb: 0.2, index: 0.1, middle: 0.1, ring: 0.1, pinky: 0.15 };
    this.leftFingers = { thumb: 0.2, index: 0.1, middle: 0.1, ring: 0.1, pinky: 0.15 };

    this.mouthOpen = 0;
    this.smile = 0;
    this.blinkPhase = 0;
  }
}

/**
 * 核心生成器（函数式 + 相位驱动）
 */
export function makeMotionGenerator() {
  const gen = {
    _t: 0,                // 总时间
    _phase: { Right: 0, Left: 0 }, // 手臂摆动相位
    _breathing: 0,        // 呼吸相位
    _idle: 0,             // 空闲律动相位
    _mouth: 0,            // 口型相位
    _mouthAmplitude: 0,   // 当前嘴振幅（平滑过渡）
    _blinkTimer: 3 + Math.random() * 3,
    _blinkPhase: 0,

    jitter: new MicroJitter(77, 0.5, 0.004),
    armNoise: new FBMNoise(123, 2, 2.0, 0.5),
    idleNoise: new FBMNoise(456, 3, 2.0, 0.5),

    defaultGaze: new THREE.Vector3(0, 1.6, 2.5),

    field: new MotionField(),

    generate(bodyState, dt, userWorldPos) {
      gen._t += dt;
      const t = gen._t;
      const f = gen.field;

      // ============== 1) 呼吸 ==============
      const breathFreq = 0.9 + bodyState.energy * 0.6;
      gen._breathing += dt * breathFreq * 2 * Math.PI;
      const breath = Math.sin(gen._breathing) * 0.025 * (0.6 + bodyState.energy * 0.8);
      const breathUp = Math.sin(gen._breathing) * 0.015 * (0.5 + bodyState.energy * 0.5);

      // ============== 2) 躯干（更自然的摆动）==============
      gen._idle += dt * 0.6;
      const swayX = gen.idleNoise.fbm2D(gen._idle, 0) * 0.04;
      const swayZ = gen.idleNoise.fbm2D(gen._idle + 10, 0) * 0.035;
      const twist = gen.idleNoise.fbm2D(gen._idle * 0.5, 5) * 0.02;

      f.spineLean.x = bodyState.spine.leanForward + breath + swayX * 0.5;
      f.spineLean.y = breathUp * 0.3; // 轻微上下浮动
      f.spineLean.z = bodyState.spine.leanSide + swayZ;
      f.spineTwist = twist + Math.sin(gen._idle * 0.8) * 0.01;

      // ============== 3) 头部凝视 ==============
      if (bodyState.lookAtUser && userWorldPos) {
        const w = bodyState.head.lookAtWeight;
        f.headLookAt.lerpVectors(gen.defaultGaze, userWorldPos, w);
      } else {
        // 无神 / 走神状态：缓慢看向随机方向
        f.headLookAt.set(
          gen.idleNoise.fbm2D(t * 0.08, 0) * 2.2,
          1.5 + gen.idleNoise.fbm2D(t * 0.08, 2) * 0.4,
          2.5
        );
      }
      f.head.lookAtWeight = bodyState.head.lookAtWeight;

      // 头部微抖动（增强生命感）
      const hj = gen.jitter.jitter3D(dt, 0.8 + bodyState.energy * 0.5);
      f.headOffset.set(hj.x * 3, hj.y * 3, hj.z * 2);

      // ============== 4) 手臂：相位驱动的摆动 ==============
      _genArm(gen, 'Right', bodyState, dt);
      _genArm(gen, 'Left', bodyState, dt);

      // 张开度
      f.rightHandOpenness = bodyState.armRight.openness;
      f.leftHandOpenness = bodyState.armLeft.openness;

      // ============== 5) 肩膀抬升（增加呼吸影响）==============
      const happyLift = bodyState.emotion.happy * 0.35;
      const energyLift = bodyState.energy * 0.2;
      const breathLift = Math.sin(gen._breathing) * 0.08; // 呼吸带动肩膀
      f.rightShoulderRaise = bodyState.armRight.active
        ? bodyState.armRight.elevation * 0.7 + happyLift + energyLift + breathLift
        : (bodyState.shoulderRaise || 0) * 0.3 + breathLift;
      f.leftShoulderRaise = bodyState.armLeft.active
        ? bodyState.armLeft.elevation * 0.7 + happyLift + energyLift + breathLift
        : (bodyState.shoulderRaise || 0) * 0.3 + breathLift;

      const sadSink = bodyState.emotion.sad * 0.25;
      f.rightShoulderRaise -= sadSink;
      f.leftShoulderRaise  -= sadSink;

      // ============== 6) 手指动作 ==============
      // 活跃手臂：手指张开（挥手姿势）
      // 非活跃手臂：自然放松状态
      const activeHandOpen = 0.05; // 活跃时手指略微弯曲
      const restHandClose = 0.15; // 静止时轻微弯曲
      
      const rightActive = bodyState.armRight.active;
      const leftActive = bodyState.armLeft.active;
      
      // 右手手指
      f.rightFingers.thumb = rightActive ? activeHandOpen : restHandClose + gen.idleNoise.fbm2D(gen._idle, 10) * 0.05;
      f.rightFingers.index = rightActive ? 0.02 : restHandClose;
      f.rightFingers.middle = rightActive ? 0.02 : restHandClose;
      f.rightFingers.ring = rightActive ? 0.05 : restHandClose;
      f.rightFingers.pinky = rightActive ? 0.08 : restHandClose + 0.05;
      
      // 左手手指（镜像）
      f.leftFingers.thumb = leftActive ? activeHandOpen : restHandClose + gen.idleNoise.fbm2D(gen._idle + 5, 10) * 0.05;
      f.leftFingers.index = leftActive ? 0.02 : restHandClose;
      f.leftFingers.middle = leftActive ? 0.02 : restHandClose;
      f.leftFingers.ring = leftActive ? 0.05 : restHandClose;
      f.leftFingers.pinky = leftActive ? 0.08 : restHandClose + 0.05;

      // ============== 7) 口型：基于 isSpeaking 的振幅振荡器 ==============
      if (bodyState.isSpeaking) {
        // 目标嘴振幅随 energy 调整，energy 越高开得越大
        const target = 0.25 + bodyState.energy * 0.5;
        gen._mouthAmplitude += (target - gen._mouthAmplitude) * Math.min(1, dt * 6);
        gen._mouth += dt * (5 + bodyState.energy * 5);
        f.mouthOpen = Math.max(0, Math.sin(gen._mouth)) * gen._mouthAmplitude;
      } else {
        gen._mouthAmplitude *= (1 - Math.min(1, dt * 4));
        f.mouthOpen = gen._mouthAmplitude * Math.max(0, Math.sin(gen._mouth));
        if (f.mouthOpen < 0.01) f.mouthOpen = 0;
      }

      // ============== 7) 表情（微笑） ==============
      const smileRaw = bodyState.emotion.happy * 0.95
                      - bodyState.emotion.sad * 0.3
                      - bodyState.emotion.angry * 0.1;
      f.smile = Math.max(0, smileRaw);

      // ============== 8) 眨眼 ==============
      gen._blinkTimer -= dt;
      if (gen._blinkTimer <= 0) {
        gen._blinkTimer = 3.0 + Math.random() * 4.0;
        gen._blinkPhase = 0.25; // 一次眨眼持续 ~0.25 秒
      }
      if (gen._blinkPhase > 0) {
        gen._blinkPhase -= dt;
        const p = 1 - (gen._blinkPhase / 0.25);
        // 三角形：0 → 1 → 0
        f.blinkPhase = p < 0.4 ? p / 0.4 : (1 - p) / 0.6;
      } else {
        f.blinkPhase = 0;
      }

      return f;
    },
  };

  return gen;
}

/**
 * 为某侧手臂生成 target position（相对角色根节点 / 模型本地空间）
 */
function _genArm(gen, side, bodyState, dt) {
  const state = bodyState['arm' + side];
  const targetField = side === 'Right' ? 'rightHandTarget' : 'leftHandTarget';
  const activeField = side === 'Right' ? 'rightHandActive' : 'leftHandActive';
  const target = gen.field[targetField];
  const active = (gen.field[activeField] = !!state.active);

  // 持续推进的相位（弧度）
  gen._phase[side] = (gen._phase[side] || 0) + dt * state.rhythm * 2 * Math.PI;
  const phase = gen._phase[side];

  if (active) {
    // 基础高度：elevation 越大越高
    const baseHeight = 0.45 + state.elevation * 0.9;
    // 左右位置（右为负，左为正）
    const baseSide = (side === 'Right' ? -0.35 : 0.35);
    // 前后位置
    const baseFwd = 0.1 + state.elevation * 0.35;

    // 振幅（增大幅度！受 style 影响）
    let amp = state.amplitude * 0.75;
    if (state.style === 'sharp') amp *= 1.5;
    if (state.style === 'soft')  amp *= 0.5;

    // 正弦摆动（上下 + 前后 + 少量左右）
    const mainY = Math.sin(phase) * amp;
    const mainZ = Math.sin(phase + 0.7) * amp * 0.8;
    const sideX = Math.sin(phase * 1.5) * amp * 0.3;

    target.set(baseSide + sideX, baseHeight + mainY, baseFwd + mainZ);
    target.y += bodyState.energy * 0.2; // 激动整体抬高一点
  } else {
    // 待机状态：手臂在身体两侧，有更明显的自然微动
    const baseSide = (side === 'Right' ? -0.25 : 0.25);
    const restPhase = gen._idle * 0.4 + (side === 'Right' ? 0 : Math.PI);
    const swayY = Math.sin(restPhase) * 0.04 + Math.sin(restPhase * 2.3) * 0.02;
    const swayZ = Math.sin(restPhase * 0.7) * 0.03;
    // 呼吸应该用正弦值，不是弧度值
    const breathY = Math.sin(gen._breathing) * 0.03;
    target.set(
      baseSide + gen.armNoise.fbm2D(gen._idle, side === 'Right' ? 0 : 1) * 0.06,
      0.5 + swayY + breathY,
      0.08 + swayZ
    );
  }
}
