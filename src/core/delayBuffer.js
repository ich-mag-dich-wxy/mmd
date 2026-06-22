import * as THREE from 'three';

export class DelayBuffer {
  constructor(maxDelay = 0.5, capacity = 120) {
    this.maxDelay = maxDelay;
    this._buffer = new Array(capacity);
    this._head = 0;
    this._count = 0;
    this._capacity = capacity;
  }

  push(value) {
    this._buffer[this._head] = value;
    this._head = (this._head + 1) % this._capacity;
    if (this._count < this._capacity) this._count++;
  }

  sample(delayTime) {
    if (this._count === 0) return null;
    const stepsAgo = Math.min(Math.floor(delayTime * 60), this._count - 1);
    const idx = (this._head - 1 - stepsAgo + this._capacity) % this._capacity;
    return this._buffer[idx];
  }
}

export class BodyDelayChain {
  constructor() {
    this.buffers = {
      target: new DelayBuffer(0.3, 60),
    };

    this.delays = {
      head: 0.05,
      spine: 0.10,
      shoulder: 0.15,
      arm: 0.20,
    };

    this._cache = {};
  }

  pushTarget(pos) {
    this.buffers.target.push(pos.clone());
  }

  sample(part) {
    const delay = this.delays[part] || 0.1;
    const raw = this.buffers.target.sample(delay);
    if (!raw) return null;

    if (!this._cache[part]) this._cache[part] = new THREE.Vector3();
    return this._cache[part].copy(raw);
  }
}
