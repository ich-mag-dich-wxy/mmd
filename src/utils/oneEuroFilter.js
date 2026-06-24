/**
 * One-Euro 自适应滤波器
 * 低速时强力平滑，高速时弱平滑，兼顾抖动消除和延迟
 * 参考: Casie et al., "1€ Filter: A Simple Speed-based Low-pass Filter for Noisy Input in Interactive Systems"
 */

// ── 标量版 ──
export class OneEuroFilterScalar {
  constructor({ minCutoff = 1.2, beta = 0.08, dCutoff = 1.0 } = {}) {
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this._x = null;
    this._dx = 0;
    this._t = null;
  }

  filter(x, t) {
    if (this._x === null || this._t === null) {
      this._x = x;
      this._t = t;
      return x;
    }

    const dt = Math.max(t - this._t, 1e-6);
    this._t = t;

    // 速度估计
    const edx = (x - this._x) / dt;
    this._dx = this._alpha(dt, this.dCutoff) * edx + (1 - this._alpha(dt, this.dCutoff)) * this._dx;

    // 自适应截止频率
    const cutoff = this.minCutoff + this.beta * Math.abs(this._dx);
    const alpha = this._alpha(dt, cutoff);

    this._x = alpha * x + (1 - alpha) * this._x;
    return this._x;
  }

  _alpha(dt, cutoff) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }

  reset() {
    this._x = null;
    this._dx = 0;
    this._t = null;
  }
}

// ── Vector3 版（对 x/y/z 各一个标量滤波器） ──
export class OneEuroFilterVec3 {
  constructor(opts = {}) {
    this._fx = new OneEuroFilterScalar(opts);
    this._fy = new OneEuroFilterScalar(opts);
    this._fz = new OneEuroFilterScalar(opts);
  }

  /**
   * @param {{x:number, y:number, z:number}} v
   * @param {number} t - 时间戳(秒)
   * @returns {{x:number, y:number, z:number}}
   */
  filter(v, t) {
    return {
      x: this._fx.filter(v.x, t),
      y: this._fy.filter(v.y, t),
      z: this._fz.filter(v.z, t),
    };
  }

  reset() {
    this._fx.reset();
    this._fy.reset();
    this._fz.reset();
  }
}

// ── 四元数版（slerp 平滑，alpha 由 One-Euro 控制） ──
export class OneEuroFilterQuat {
  constructor(opts = {}) {
    this._speedFilter = new OneEuroFilterScalar({ minCutoff: 1.5, beta: 0.1, dCutoff: 1.0, ...opts });
    this._q = null;
    this._t = null;
    this._angularSpeed = 0;
  }

  /**
   * @param {import('three').Quaternion} q
   * @param {number} t - 时间戳(秒)
   * @returns {import('three').Quaternion}
   */
  filter(q, t) {
    if (!this._q || this._t === null) {
      this._q = q.clone();
      this._t = t;
      return q.clone();
    }

    const dt = Math.max(t - this._t, 1e-6);
    this._t = t;

    // 角速度估计
    const angle = this._q.angleTo(q);
    const rawSpeed = angle / dt;
    this._angularSpeed = this._speedFilter.filter(rawSpeed, t);

    // 自适应 alpha：速度越高，alpha 越大（越少平滑）
    const cutoff = 1.5 + 0.1 * this._angularSpeed;
    const tau = 1 / (2 * Math.PI * cutoff);
    const alpha = 1 / (1 + tau / dt);

    this._q.slerp(q, alpha);
    return this._q.clone();
  }

  reset() {
    this._q = null;
    this._t = null;
    this._angularSpeed = 0;
    this._speedFilter.reset();
  }
}
