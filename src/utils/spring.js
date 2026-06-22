// ============================================================================
//  Spring System - 物理弹簧平滑系统
//  作用: 避免机械跳变，产生自然的惯性/阻尼运动
//  核心公式: velocity += (target - current) * stiffness
//           position += velocity
// ============================================================================

import * as THREE from 'three';

/**
 * 单值弹簧（用于 1D 标量）
 */
export class SpringScalar {
  constructor(initial = 0, stiffness = 8.0, damping = 3.0) {
    this.current = initial;
    this.target = initial;
    this.velocity = 0;
    this.stiffness = stiffness;    // 刚度（越大越"硬"）
    this.damping = damping;         // 阻尼（越大越"稳"）
  }

  setTarget(v) { this.target = v; }

  update(dt) {
    const k = this.stiffness;
    const d = this.damping;
    // 二阶弹簧方程（F = -k*x - d*v）
    const force = (this.target - this.current) * k - this.velocity * d;
    this.velocity += force * dt;
    this.current += this.velocity * dt;
    return this.current;
  }
}

/**
 * 三维向量弹簧
 */
export class SpringVector3 {
  constructor(v = new THREE.Vector3(), stiffness = 8.0, damping = 3.0) {
    this.current = v.clone();
    this.target = v.clone();
    this.velocity = new THREE.Vector3();
    this.stiffness = stiffness;
    this.damping = damping;
  }

  setTarget(v) { this.target.copy(v); }

  update(dt, out = this.current) {
    const k = this.stiffness;
    const d = this.damping;
    this.velocity.x += ((this.target.x - this.current.x) * k - this.velocity.x * d) * dt;
    this.velocity.y += ((this.target.y - this.current.y) * k - this.velocity.y * d) * dt;
    this.velocity.z += ((this.target.z - this.current.z) * k - this.velocity.z * d) * dt;
    this.current.x += this.velocity.x * dt;
    this.current.y += this.velocity.y * dt;
    this.current.z += this.velocity.z * dt;
    out.copy(this.current);
    return out;
  }
}

/**
 * 四元数弹簧（用于姿态插值）
 */
export class SpringQuaternion {
  constructor(q = new THREE.Quaternion(), stiffness = 6.0, damping = 2.5) {
    this.current = q.clone();
    this.target = q.clone();
    this.angularVel = new THREE.Vector3();
    this.stiffness = stiffness;
    this.damping = damping;
    this._tmpQuat = new THREE.Quaternion();
  }

  setTarget(q) { this.target.copy(q); }

  update(dt, out = this.current) {
    // 计算目标四元数与当前的"差角轴"
    const q = this._tmpQuat;
    q.copy(this.current).invert().multiply(this.target);

    // 将四元数差转成轴角向量（Euler error）
    let angle = 2.0 * Math.acos(THREE.MathUtils.clamp(q.w, -1, 1));
    if (angle > Math.PI) angle -= Math.PI * 2.0;

    const s = Math.sqrt(1.0 - q.w * q.w);
    if (s > 0.001) {
      const ix = q.x / s;
      const iy = q.y / s;
      const iz = q.z / s;

      // 弹簧力 = -k*angle - d*omega
      const torque = angle * this.stiffness;
      this.angularVel.x += (torque * ix - this.angularVel.x * this.damping) * dt;
      this.angularVel.y += (torque * iy - this.angularVel.y * this.damping) * dt;
      this.angularVel.z += (torque * iz - this.angularVel.z * this.damping) * dt;

      // 角速度 → 增量四元数
      const mag = this.angularVel.length();
      if (mag > 0.0001) {
        const half = mag * dt * 0.5;
        const sinHalf = Math.sin(half) / mag;
        const dq = new THREE.Quaternion(
          this.angularVel.x * sinHalf,
          this.angularVel.y * sinHalf,
          this.angularVel.z * sinHalf,
          Math.cos(half)
        );
        this.current.multiply(dq);
      }
      this.current.normalize();
    }
    out.copy(this.current);
    return out;
  }
}

/**
 * 临界阻尼插值函数（轻量级）
 * 用法: lerpCriticalDamped(current, target, dt, lambda=10)
 */
export function lerpCriticalDamped(current, target, dt, lambda = 8.0) {
  // exp(-lambda*dt) => 无限接近 target，不会过冲
  return current + (target - current) * (1.0 - Math.exp(-lambda * dt));
}

/**
 * 欧拉角临界阻尼
 */
export function eulerCriticalDamped(current, target, dt, out = current, lambda = 8.0) {
  const k = 1.0 - Math.exp(-lambda * dt);
  out.x = current.x + (target.x - current.x) * k;
  out.y = current.y + (target.y - current.y) * k;
  out.z = current.z + (target.z - current.z) * k;
  return out;
}
