import * as THREE from 'three';

const EASE = {
  linear:       t => t,
  easeInQuad:   t => t * t,
  easeOutQuad:  t => t * (2 - t),
  easeInOutQuad: t => t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t,
  easeInCubic:  t => t * t * t,
  easeOutCubic: t => (--t) * t * t + 1,
  easeInOutCubic:t => t < 0.5 ? 4 * t * t * t : (t - 1) * (2 * t - 2) * (2 * t - 2) + 1,
  easeOutBack:  t => { const c1 = 1.70158; const c3 = c1 + 1; return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2); },
  easeOutElastic:t => { if (t === 0 || t === 1) return t; return Math.pow(2, -10 * t) * Math.sin((t - 1) * 5 * Math.PI) + 1; },
};

export class KeyframeTrajectory {
  constructor(keyframes = []) {
    this.keyframes = keyframes;
    this._time = 0;
    this._paused = false;
    this._onComplete = null;
  }

  static fromStartEnd(start, end, duration, easeFn = 'easeOutCubic') {
    return new KeyframeTrajectory([
      { t: 0, value: start.clone(), ease: 'linear' },
      { t: duration, value: end.clone(), ease: easeFn },
    ]);
  }

  static fromPhases(phases) {
    let totalTime = 0;
    const kfs = [];
    for (const phase of phases) {
      const dur = phase.duration || 0;
      if (phase.value) {
        kfs.push({ t: totalTime, value: phase.value.clone(), ease: 'linear' });
        kfs.push({ t: totalTime + dur, value: phase.value.clone(), ease: phase.ease || 'easeOutCubic' });
      }
      totalTime += dur;
    }
    if (kfs.length >= 2) {
      kfs[kfs.length - 1].ease = 'linear';
      kfs[kfs.length - 2].ease = phases[phases.length - 1]?.ease || 'easeOutCubic';
    }
    return new KeyframeTrajectory(kfs);
  }

  get duration() {
    if (this.keyframes.length === 0) return 0;
    return this.keyframes[this.keyframes.length - 1].t;
  }

  get isComplete() {
    return this._time >= this.duration && this.duration > 0;
  }

  get progress() {
    if (this.duration === 0) return 1;
    return Math.min(this._time / this.duration, 1);
  }

  reset() {
    this._time = 0;
    this._paused = false;
  }

  update(dt) {
    if (!this._paused) {
      this._time += dt;
    }
  }

  getPosition(out = new THREE.Vector3()) {
    if (this.keyframes.length === 0) return out.set(0, 0, 0);
    if (this.keyframes.length === 1) return out.copy(this.keyframes[0].value);

    const t = this._time;
    for (let i = 0; i < this.keyframes.length - 1; i++) {
      const k0 = this.keyframes[i];
      const k1 = this.keyframes[i + 1];
      if (t >= k0.t && t <= k1.t) {
        const range = k1.t - k0.t;
        const raw = range > 0 ? (t - k0.t) / range : 1;
        const eased = (EASE[k1.ease] || EASE.linear)(raw);
        return out.lerpVectors(k0.value, k1.value, eased);
      }
    }
    return out.copy(this.keyframes[this.keyframes.length - 1].value);
  }

  onComplete(fn) {
    this._onComplete = fn;
  }

  complete() {
    if (this._onComplete) {
      const fn = this._onComplete;
      this._onComplete = null;
      fn();
    }
  }
}

export class SpringTrajectory {
  constructor(stiffness = 6, damping = 2.5) {
    this.current = new THREE.Vector3();
    this.target = new THREE.Vector3();
    this.velocity = new THREE.Vector3();
    this.stiffness = stiffness;
    this.damping = damping;
  }

  setTarget(v) {
    this.target.copy(v);
  }

  setCurrent(v) {
    this.current.copy(v);
    this.velocity.set(0, 0, 0);
  }

  update(dt) {
    const k = this.stiffness;
    const d = this.damping;
    this.velocity.x += ((this.target.x - this.current.x) * k - this.velocity.x * d) * dt;
    this.velocity.y += ((this.target.y - this.current.y) * k - this.velocity.y * d) * dt;
    this.velocity.z += ((this.target.z - this.current.z) * k - this.velocity.z * d) * dt;
    this.current.x += this.velocity.x * dt;
    this.current.y += this.velocity.y * dt;
    this.current.z += this.velocity.z * dt;
    return this.current;
  }

  getPosition(out = new THREE.Vector3()) {
    return out.copy(this.current);
  }
}

export class OscillateTrajectory {
  constructor(amplitude = 0.15, frequency = 5, axis = 'y', base = new THREE.Vector3()) {
    this.amplitude = amplitude;
    this.frequency = frequency;
    this.axis = axis;
    this.base = base.clone();
    this._time = 0;
    this.damping = 0.95;
    this._active = false;
  }

  start() {
    this._time = 0;
    this._active = true;
  }

  stop() {
    this._active = false;
  }

  update(dt) {
    if (!this._active) return;
    this._time += dt;
  }

  getPosition(out = new THREE.Vector3()) {
    out.copy(this.base);
    if (!this._active) return out;

    const t = this._time;
    const decay = Math.exp(-t * 1.5);
    const wave = Math.sin(t * Math.PI * 2 * this.frequency) * this.amplitude * decay;

    if (this.axis === 'y') out.y += wave;
    else if (this.axis === 'x') out.x += wave;
    else if (this.axis === 'z') out.z += wave;

    return out;
  }

  get isActive() {
    return this._active && Math.exp(-this._time * 1.5) > 0.01;
  }
}
