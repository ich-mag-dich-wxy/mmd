// ============================================================================
//  Noise System - 程序化噪声系统
//  作用: 产生微动作 / 生命感 / 抖动随机性
// ============================================================================

import * as THREE from 'three';

/**
 * 简单 Perlin-like 噪声（纯计算，无依赖）
 * 输出范围: [-1, 1]
 */
export class ValueNoise {
  constructor(seed = 12345) {
    this.seed = seed;
    this._perm = new Uint8Array(512);
    this._buildPerm();
  }

  _buildPerm() {
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    // 伪随机打乱
    let s = this.seed;
    const rand = () => {
      s = (s * 9301 + 49297) % 233280;
      return s / 233280;
    };
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this._perm[i] = p[i & 255];
  }

  _fade(t) { return t * t * t * (t * (t * 6 - 15) + 10); }
  _grad(h, x, y) {
    const u = (h & 1) === 0 ? x : -x;
    const v = (h & 2) === 0 ? y : -y;
    return u + v;
  }

  noise2D(x, y) {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = this._fade(xf), v = this._fade(yf);
    const AA = this._perm[this._perm[X] + Y];
    const AB = this._perm[this._perm[X] + Y + 1];
    const BA = this._perm[this._perm[X + 1] + Y];
    const BB = this._perm[this._perm[X + 1] + Y + 1];
    const x1 = lerp(this._grad(AA, xf, yf), this._grad(BA, xf - 1, yf), u);
    const x2 = lerp(this._grad(AB, xf, yf - 1), this._grad(BB, xf - 1, yf - 1), u);
    return lerp(x1, x2, v);
  }
}

function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * 多频分形噪声（Fractal Brownian Motion）
 */
export class FBMNoise {
  constructor(seed = 12345, octaves = 3, lacunarity = 2.0, gain = 0.5) {
    this.base = new ValueNoise(seed);
    this.octaves = octaves;
    this.lacunarity = lacunarity;
    this.gain = gain;
  }

  fbm2D(x, y) {
    let freq = 1.0, amp = 1.0, sum = 0.0, norm = 0.0;
    for (let i = 0; i < this.octaves; i++) {
      sum += this.base.noise2D(x * freq, y * freq) * amp;
      norm += amp;
      freq *= this.lacunarity;
      amp *= this.gain;
    }
    return sum / norm;
  }
}

/**
 * 时间驱动正弦扰动（轻量级）
 * 适合: 呼吸 / 微动作 / 待机晃动
 */
export function sinusoidal(t, baseAmp = 0.5, freq = 1.0, phase = 0) {
  return Math.sin(t * freq + phase) * baseAmp;
}

/**
 * 多频正弦叠加（更"有机"的感觉）
 */
export function multiSin(t, components) {
  let v = 0;
  for (const c of components) {
    v += Math.sin(t * c.freq + (c.phase || 0)) * c.amp;
  }
  return v;
}

/**
 * Perlin 抖动生成器（生成 x,y,z 三轴独立噪声抖动）
 * 用于给 pose 叠加"微动作"
 */
export class MicroJitter {
  constructor(seed = 42, baseFreq = 0.6, baseAmp = 0.003) {
    this.noise = new FBMNoise(seed, 2, 2.0, 0.6);
    this.baseFreq = baseFreq;
    this.baseAmp = baseAmp;
    this._t = 0;
  }

  jitter3D(dt, ampScale = 1.0) {
    this._t += dt * this.baseFreq;
    return new THREE.Vector3(
      this.noise.fbm2D(this._t, 0.0) * this.baseAmp * ampScale,
      this.noise.fbm2D(this._t + 100, 0.0) * this.baseAmp * ampScale,
      this.noise.fbm2D(this._t + 200, 0.0) * this.baseAmp * ampScale
    );
  }
}
