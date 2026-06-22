import * as THREE from 'three';
import { KeyframeTrajectory, OscillateTrajectory, SpringTrajectory } from './motionTrajectory.js';

const ARM_DEFAULTS = {
  right: { rest: new THREE.Vector3(-0.22, 0.12, 0.04) },
  left:  { rest: new THREE.Vector3( 0.22, 0.12, 0.04) },
};

const MOTION_SCRIPTS = {

  greet: {
    name: 'greet',
    duration: 2.4,
    arm: 'right',
    phases: [
      {
        name: 'raise',
        duration: 0.4,
        value: new THREE.Vector3(-0.06, 0.62, 0.26),
        shoulderRaise: 0.4,
        ease: 'easeOutCubic',
      },
      {
        name: 'wave',
        duration: 1.4,
        type: 'oscillate',
        amplitude: 0.16,
        frequency: 6.5,
        axis: 'y',
        base: new THREE.Vector3(-0.06, 0.60, 0.28),
      },
      {
        name: 'return',
        duration: 0.6,
        value: new THREE.Vector3(-0.22, 0.12, 0.04),
        shoulderRaise: 0,
        ease: 'easeInOutCubic',
      },
    ],
  },

  nod: {
    name: 'nod',
    duration: 1.3,
    phases: [
      { name: 'down',  duration: 0.3, value: new THREE.Euler( 0.22, 0, 0), ease: 'easeOutQuad', type: 'euler' },
      { name: 'up',    duration: 0.35, value: new THREE.Euler(-0.18, 0, 0), ease: 'easeInOutQuad', type: 'euler' },
      { name: 'settle', duration: 0.35, value: new THREE.Euler( 0.08, 0, 0), ease: 'easeOutQuad', type: 'euler' },
      { name: 'rest',  duration: 0.3,  value: new THREE.Euler( 0, 0, 0),    ease: 'easeOutQuad', type: 'euler' },
    ],
  },

  shake: {
    name: 'shake',
    duration: 1.4,
    phases: [
      { name: 'left',  duration: 0.3,  value: new THREE.Euler(0,  0.35, 0), ease: 'easeOutQuad', type: 'euler' },
      { name: 'right', duration: 0.35, value: new THREE.Euler(0, -0.35, 0), ease: 'easeInOutQuad', type: 'euler' },
      { name: 'left2', duration: 0.3,  value: new THREE.Euler(0,  0.18, 0), ease: 'easeOutQuad', type: 'euler' },
      { name: 'rest',  duration: 0.45, value: new THREE.Euler(0,  0, 0),     ease: 'easeOutQuad', type: 'euler' },
    ],
  },

  raise_hand: {
    name: 'raise_hand',
    duration: 1.8,
    arm: 'right',
    phases: [
      { name: 'raise', duration: 0.55, value: new THREE.Vector3(-0.04, 1.0, 0.14), shoulderRaise: 0.7, ease: 'easeOutCubic' },
      { name: 'hold',  duration: 0.7,  value: new THREE.Vector3(-0.06, 1.05, 0.16), shoulderRaise: 0.85, ease: 'linear' },
      { name: 'down',  duration: 0.55, value: new THREE.Vector3(-0.22, 0.12, 0.04), shoulderRaise: 0,    ease: 'easeInCubic' },
    ],
  },

  point: {
    name: 'point',
    duration: 1.8,
    arm: 'right',
    phases: [
      { name: 'raise',  duration: 0.35, value: new THREE.Vector3(-0.32, 0.55, 0.14), ease: 'easeOutCubic' },
      { name: 'extend', duration: 0.4,  value: new THREE.Vector3(-0.62, 0.48, 0.44), ease: 'easeOutQuad' },
      { name: 'hold',   duration: 0.5,  value: new THREE.Vector3(-0.62, 0.48, 0.44), ease: 'linear' },
      { name: 'return', duration: 0.55, value: new THREE.Vector3(-0.22, 0.12, 0.04), ease: 'easeInCubic' },
    ],
  },

  idle: {
    name: 'idle',
    duration: 1,
    phases: [],
  },
};

const IDLE_COMPONENTS = [
  { freq: 0.5, amp: 0.012, phase: 0 },
  { freq: 0.9, amp: 0.008, phase: 1.2 },
  { freq: 1.4, amp: 0.005, phase: 2.8 },
];

export class MotionScriptEngine {
  constructor() {
    this.activeScript = null;
    this.scriptStartTime = 0;
    this.currentTime = 0;

    this._armTrajectory = { right: null, left: null };
    this._oscillator = { right: null, left: null };

    this._headTrajectory = null;
    this._completed = false;

    this._armSpring = {
      right: new SpringTrajectory(5, 2.8),
      left:  new SpringTrajectory(5, 2.8),
    };
    this._shoulderRaise = { right: 0, left: 0 };

    for (const side of ['right', 'left']) {
      const rest = ARM_DEFAULTS[side].rest;
      this._armSpring[side].setCurrent(rest);
      this._armSpring[side].setTarget(rest);
    }
  }

  playScript(scriptName, currentTime = 0) {
    const script = MOTION_SCRIPTS[scriptName];
    if (!script) {
      console.warn(`[MotionScript] 未知动作: ${scriptName}`);
      return;
    }

    const side = script.arm || 'right';

    if (this._oscillator[side]) {
      this._oscillator[side].stop();
      this._oscillator[side] = null;
    }

    this.activeScript = script;
    this.scriptStartTime = currentTime;
    this._completed = false;

    this._armTrajectory[side] = this._buildArmTrajectory(script);
    this._headTrajectory = this._buildHeadTrajectory(script);

    console.log(`[MotionScript] ▶ ${script.name} (${script.duration}s, arm=${side})`);
  }

  _buildArmTrajectory(script) {
    const side = script.arm || 'right';
    const sign = side === 'right' ? -1 : 1;

    let prevPos = this._armSpring[side].current.clone();
    let totalTime = 0;
    const kfs = [];

    for (const phase of script.phases) {
      if (!phase.value || phase.type === 'oscillate' || phase.type === 'euler') continue;

      const pos = new THREE.Vector3(
        phase.value.x * sign,
        phase.value.y,
        phase.value.z
      );

      kfs.push({ t: totalTime, value: prevPos.clone(), ease: 'linear' });
      kfs.push({
        t: totalTime + phase.duration,
        value: pos.clone(),
        ease: phase.ease || 'easeOutCubic',
      });

      if (phase.shoulderRaise !== undefined) {
        const shoulderKfs = kfs[kfs.length - 1];
        shoulderKfs._shoulderRaise = phase.shoulderRaise;
      }

      prevPos.copy(pos);
      totalTime += phase.duration;
    }

    if (kfs.length < 2) return null;

    kfs[kfs.length - 1].ease = 'linear';
    if (kfs.length >= 2) {
      kfs[kfs.length - 2].ease = script.phases
        .filter(p => p.value && p.type !== 'oscillate' && p.type !== 'euler')
        .pop()?.ease || 'easeOutCubic';
    }

    return new KeyframeTrajectory(kfs);
  }

  _buildHeadTrajectory(script) {
    const eulerPhases = script.phases.filter(p => p.type === 'euler');
    if (eulerPhases.length === 0) return null;

    let totalTime = 0;
    const kfs = [];

    for (const phase of eulerPhases) {
      kfs.push({ t: totalTime, value: new THREE.Euler(0, 0, 0), ease: 'linear' });
      kfs.push({
        t: totalTime + phase.duration,
        value: phase.value.clone(),
        ease: phase.ease || 'easeOutQuad',
      });
      totalTime += phase.duration;
    }

    if (kfs.length < 2) return null;
    return new KeyframeTrajectory(kfs);
  }

  update(dt) {
    this.currentTime += dt;

    if (this._armTrajectory.right) this._armTrajectory.right.update(dt);
    if (this._armTrajectory.left) this._armTrajectory.left.update(dt);
    if (this._headTrajectory) this._headTrajectory.update(dt);

    for (const side of ['right', 'left']) {
      if (this._oscillator[side]) this._oscillator[side].update(dt);
    }

    if (!this._completed && this.activeScript) {
      const elapsed = this.currentTime - this.scriptStartTime;
      if (elapsed >= this.activeScript.duration) {
        this._completed = true;
        for (const side of ['right', 'left']) {
          if (this._armTrajectory[side]) {
            const lastPos = this._armTrajectory[side].getPosition();
            this._armSpring[side].current.copy(lastPos);
          }
        }
      }
    }
  }

  _ensureOscillator(script, side) {
    const oscillatorPhase = script.phases.find(p => p.type === 'oscillate');
    if (!oscillatorPhase) return null;

    if (!this._oscillator[side]) {
      const base = new THREE.Vector3(
        (oscillatorPhase.base?.x || 0) * (side === 'right' ? -1 : 1),
        oscillatorPhase.base?.y || 0.6,
        oscillatorPhase.base?.z || 0.25
      );
      this._oscillator[side] = new OscillateTrajectory(
        oscillatorPhase.amplitude || 0.15,
        oscillatorPhase.frequency || 5,
        oscillatorPhase.axis || 'y',
        base
      );
    }
    return this._oscillator[side];
  }

  getArmIKTarget(side) {
    const spring = this._armSpring[side];
    const rest = ARM_DEFAULTS[side].rest;

    if (!this.activeScript || this._completed) {
      spring.setTarget(rest);
      spring.update(0.016);
      return {
        position: spring.getPosition(),
        isActive: false,
        shoulderRaise: 0,
      };
    }

    const elapsed = this.currentTime - this.scriptStartTime;
    const script = this.activeScript;
    const armSide = script.arm === 'left' ? 'left' : 'right';

    if (side !== armSide) {
      spring.setTarget(rest);
      spring.update(0.016);
      return {
        position: spring.getPosition(),
        isActive: false,
        shoulderRaise: 0,
      };
    }

    const oscillatorPhase = script.phases.find(p => p.type === 'oscillate');
    const oscStartTime = script.phases
      .filter(p => p.type !== 'oscillate')
      .reduce((sum, p) => sum + p.duration, 0);

    let targetPos;

    if (oscillatorPhase && elapsed >= oscStartTime) {
      const osc = this._ensureOscillator(script, side);
      if (osc && !osc.isActive) osc.start();
      if (osc) {
        targetPos = osc.getPosition();
      } else {
        targetPos = this._armTrajectory[side]?.getPosition() || spring.current.clone();
      }
    } else if (this._armTrajectory[side]) {
      targetPos = this._armTrajectory[side].getPosition();
    } else {
      return {
        position: spring.getPosition(),
        isActive: false,
        shoulderRaise: 0,
      };
    }

    spring.setTarget(targetPos);
    spring.update(0.016);

    let shoulderRaise = 0;
    if (this._armTrajectory[side] && !this._completed) {
      const traj = this._armTrajectory[side];
      const pos = traj.getPosition();
      for (const kf of traj.keyframes) {
        if (kf._shoulderRaise !== undefined && pos.distanceToSquared(kf.value) < 0.001) {
          shoulderRaise = kf._shoulderRaise;
          break;
        }
      }
    }

    return {
      position: spring.getPosition(),
      isActive: !this._completed,
      shoulderRaise,
    };
  }

  getHeadTarget() {
    if (!this._headTrajectory || this._completed) {
      return { rotation: new THREE.Euler(), active: false };
    }

    const euler = new THREE.Euler();
    const pos = this._headTrajectory.getPosition();
    euler.copy(pos);
    return { rotation: euler, active: true };
  }

  getIdleOffset(side) {
    const t = this.currentTime;
    const sign = side === 'right' ? -1 : 1;
    let offset = 0;
    for (const c of IDLE_COMPONENTS) {
      offset += Math.sin(t * c.freq + c.phase) * c.amp;
    }
    return offset * sign;
  }

  cancelAll() {
    this.activeScript = null;
    this._completed = true;
    for (const side of ['right', 'left']) {
      this._armTrajectory[side] = null;
      if (this._oscillator[side]) {
        this._oscillator[side].stop();
        this._oscillator[side] = null;
      }
    }
    this._headTrajectory = null;
  }

  get progress() {
    if (!this.activeScript) return 1;
    return Math.min((this.currentTime - this.scriptStartTime) / this.activeScript.duration, 1);
  }

  get isActive() {
    return this.activeScript !== null && !this._completed;
  }

  getStatus() {
    if (!this.activeScript) return 'idle';
    return this._completed ? 'done' : `${this.activeScript.name} (${(this.progress * 100).toFixed(0)}%)`;
  }
}

export { MOTION_SCRIPTS };
