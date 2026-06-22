import * as THREE from 'three';
import { MotionScriptEngine, MOTION_SCRIPTS } from './motionScriptEngine.js';
import { MotionBlender } from './motionBlender.js';
import { BreathingSystem } from './breathingSystem.js';
import { BodyDelayChain } from './delayBuffer.js';
import { MicroJitter } from '../utils/noise.js';

const INTENT_MAP = {
  greet:     ['greet', 'wave', '挥手', '你好', 'hello', 'hi', '再见', 'bye', '打招呼'],
  nod:       ['nod', '点头', '好的', '同意', '嗯嗯', 'yes'],
  shake:     ['shake', '摇头', '否定', '不是', '不行', 'no'],
  point:    ['point', '指向', '指着', '那边', '这里'],
  raise:    ['raise_hand', '举手'],
  idle:     ['idle', '站立', '等待', '没事'],
};

function resolveIntent(text) {
  if (!text) return 'idle';
  const lower = text.toLowerCase();
  for (const [intent, keywords] of Object.entries(INTENT_MAP)) {
    for (const kw of keywords) {
      if (lower.includes(kw)) return intent;
    }
  }
  return 'idle';
}

export class MotorLayerSystem {
  constructor() {
    this.scriptEngine = new MotionScriptEngine();
    this.blenderRight = new MotionBlender();
    this.blenderLeft = new MotionBlender();
    this.breathing = new BreathingSystem();
    this.bodyDelay = new BodyDelayChain();
    this.jitter = new MicroJitter(77, 0.6, 0.004);

    this.currentIntent = 'idle';
    this._time = 0;
    this._speakTimer = 0;
    this._isSpeaking = false;

    this.emotionState = { happy: 0, sad: 0, angry: 0, calm: 0.7 };
    this._emotionTarget = { happy: 0, sad: 0, angry: 0, calm: 0.7 };
    this.energy = 0.4;
    this._energyTarget = 0.4;

    this.expression = { smile: 0, mouthOpen: 0, blink: 0 };
    this._blinkTimer = 3 + Math.random() * 3;
    this._blinkPhase = 0;

    this.gazeTarget = new THREE.Vector3(0, 1.6, 2.5);
    this.gazeWeight = 0.7;

    this._tmp = new THREE.Vector3();
    this._restRight = new THREE.Vector3(-0.22, 0.12, 0.04);
    this._restLeft = new THREE.Vector3(0.22, 0.12, 0.04);
  }

  setIntent(llmIntent) {
    const intent = resolveIntent(llmIntent);
    if (this.currentIntent === intent && intent !== 'idle') return;

    this.currentIntent = intent;
    console.log(`[Motor] 意图: ${intent}`);

    switch (intent) {
      case 'greet':
        this.scriptEngine.playScript('greet', this._time);
        this.expression.smile = 0.6;
        break;
      case 'nod':
        this.scriptEngine.playScript('nod', this._time);
        break;
      case 'shake':
        this.scriptEngine.playScript('shake', this._time);
        break;
      case 'point':
        this.scriptEngine.playScript('point', this._time);
        break;
      case 'raise':
        this.scriptEngine.playScript('raise_hand', this._time);
        break;
      case 'idle':
      default:
        break;
    }
  }

  setEmotion(emotion) {
    if (emotion.happy !== undefined) this._emotionTarget.happy = emotion.happy;
    if (emotion.sad !== undefined) this._emotionTarget.sad = emotion.sad;
    if (emotion.angry !== undefined) this._emotionTarget.angry = emotion.angry;
    if (emotion.calm !== undefined) this._emotionTarget.calm = emotion.calm;

    this._energyTarget = (emotion.happy || 0) * 0.5 + (emotion.angry || 0) * 0.7 + (emotion.calm || 0) * 0.3;
    this._energyTarget = Math.max(0.15, Math.min(1, this._energyTarget));
  }

  setGaze(target, userPos) {
    if (userPos) this.gazeTarget.copy(userPos);
  }

  setSpeaking(active) {
    this._isSpeaking = active;
    if (active) this._speakTimer = 2.5;
  }

  update(dt) {
    this._time += dt;

    this._smoothEmotions(dt);
    this.energy += (this._energyTarget - this.energy) * Math.min(1, dt * 4);

    this.breathing.setEnergy(this.energy);
    this.breathing.setEmotion(this.emotionState);
    this.breathing.update(dt);

    this.scriptEngine.update(dt);

    this._updateBlink(dt);

    if (this._isSpeaking) {
      this._speakTimer -= dt;
      if (this._speakTimer <= 0) this._isSpeaking = false;
      this.expression.mouthOpen = 0.2 + this.energy * 0.4;
    } else {
      this.expression.mouthOpen *= 0.9;
    }
  }

  _smoothEmotions(dt) {
    const k = 1 - Math.exp(-4 * dt);
    this.emotionState.happy += (this._emotionTarget.happy - this.emotionState.happy) * k;
    this.emotionState.sad   += (this._emotionTarget.sad   - this.emotionState.sad)   * k;
    this.emotionState.angry += (this._emotionTarget.angry - this.emotionState.angry) * k;
    this.emotionState.calm  += (this._emotionTarget.calm  - this.emotionState.calm)  * k;
  }

  _updateBlink(dt) {
    this._blinkTimer -= dt;
    if (this._blinkTimer <= 0) {
      this._blinkTimer = 2.5 + Math.random() * 5;
      this._blinkPhase = 0.2;
    }
    if (this._blinkPhase > 0) {
      this._blinkPhase -= dt;
      const p = 1 - this._blinkPhase / 0.2;
      this.expression.blink = p < 0.4 ? p / 0.4 : (1 - p) / 0.6;
    } else {
      this.expression.blink = 0;
    }
  }

  generateMotionField() {
    const field = {
      rightHandTarget: new THREE.Vector3(),
      leftHandTarget: new THREE.Vector3(),
      rightHandActive: false,
      leftHandActive: false,
      rightShoulderRaise: 0,
      leftShoulderRaise: 0,

      headLookAt: this.gazeTarget.clone(),
      headLookAtWeight: this.gazeWeight,
      headOffset: new THREE.Vector3(),

      smile: this.expression.smile,
      mouthOpen: this.expression.mouthOpen,
      blink: this.expression.blink,

      spineLean: { x: 0, y: 0, z: 0 },
      spineTwist: 0,
    };

    this._applyPosture(field);
    this._applyGesture(field);
    this._applyBlendedIK(field);

    return field;
  }

  _applyPosture(field) {
    const t = this._time;
    const happy = this.emotionState.happy;
    const sad = this.emotionState.sad;
    const angry = this.emotionState.angry;

    field.spineLean.x = this.breathing.chest * 1.5;
    field.spineLean.y = this.breathing.belly * 0.5;
    field.spineLean.z = 0;

    if (happy > 0.3) field.spineLean.z += happy * 0.05;
    if (sad > 0.3)   field.spineLean.z -= sad * 0.04;
    if (angry > 0.3) field.spineLean.z += angry * 0.06;

    const j = this.jitter.jitter3D(0.016, this.energy);
    field.headOffset.set(j.x * 2, j.y * 2, j.z);

    field.rightShoulderRaise = Math.max(0, this.breathing.shoulderLift * 1.2);
    field.leftShoulderRaise = Math.max(0, this.breathing.shoulderLift * 1.2);

    if (happy > 0.3) {
      field.rightShoulderRaise += happy * 0.1;
      field.leftShoulderRaise += happy * 0.1;
    }

    field.smile = Math.max(0, happy * 0.8 - sad * 0.3);
  }

  _applyGesture(field) {
    const right = this.scriptEngine.getArmIKTarget('right');
    const left = this.scriptEngine.getArmIKTarget('left');
    const head = this.scriptEngine.getHeadTarget();

    field.rightHandTarget.copy(right.position);
    field.rightHandActive = right.isActive;
    field.rightShoulderRaise += right.shoulderRaise;

    field.leftHandTarget.copy(left.position);
    field.leftHandActive = left.isActive;
    field.leftShoulderRaise += left.shoulderRaise;

    if (head.active) {
      field.headOffset.x += head.rotation.x * 0.3;
      field.headOffset.y += head.rotation.y * 0.3;
      field.headOffset.z += head.rotation.z * 0.3;
    }
  }

  _applyBlendedIK(field) {
    for (const side of ['right', 'left']) {
      const blender = side === 'right' ? this.blenderRight : this.blenderLeft;
      const rest = side === 'right' ? this._restRight : this._restLeft;

      const idleOffset = this.scriptEngine.getIdleOffset(side);
      const idlePos = this._tmp.copy(rest);
      idlePos.y += idleOffset * 0.5;

      blender.setLayer('idle', idlePos, 0.2);

      const emotionShift = this._tmp.set(0, this.emotionState.happy * 0.08 - this.emotionState.sad * 0.05, 0);
      blender.setLayer('emotion', emotionShift, 0.3);

      const gestureKey = side === 'right' ? 'rightHandTarget' : 'leftHandTarget';
      if (field[side + 'HandActive']) {
        blender.setLayer('gesture', field[gestureKey], 0.9);
      } else {
        blender.setLayer('gesture', null, 0);
      }

      const blended = blender.blendActive();
      field[side + 'HandTarget'].copy(blended.position);
      field[side + 'HandActive'] = blended.isActive;
    }
  }

  getStatus() {
    return {
      intent: this.currentIntent,
      script: this.scriptEngine.getStatus(),
      energy: this.energy,
    };
  }
}
