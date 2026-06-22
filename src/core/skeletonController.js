import * as THREE from 'three';
import { CCDIKSolver } from 'three/addons/animation/CCDIKSolver.js';
import { lerpCriticalDamped } from '../utils/spring.js';

console.log('[Skeleton] ★ V7_TRAJECTORY 版本 (IK=修正器, 轨迹驱动)');

export class SkeletonController {
  constructor(mesh) {
    this.mesh = mesh;
    this.ikSolver = null;
    this.mixer = null;
    this.animationClip = null;

    this._ikTargetBones = { right: null, left: null };
    this._ikTargetDefaults = { right: null, left: null };

    this._hasArmIK = false;
    this._armBones = { right: null, left: null };

    this._headBone = null;
    this._headInitQuat = null;

    this._debugFrame = 0;

    this._tmpV1 = new THREE.Vector3();
    this._tmpV2 = new THREE.Vector3();
    this._tmpQ1 = new THREE.Quaternion();
    this._tmpQ2 = new THREE.Quaternion();

    this._initFromMMD(mesh);
  }

  _initFromMMD(mesh) {
    const iks = mesh.geometry.userData?.MMD?.iks || [];
    const bones = mesh.skeleton.bones;

    console.log(`[Skeleton] CCDIKSolver (${iks.length}个IK链)`);

    const armKw = ['腕', '手', 'wrist', 'hand', 'arm', 'ひじ', 'elbow', '肩', 'shoulder', '上腕', '前腕'];
    const rightKw = ['右', 'right', 'r_'];
    const leftKw = ['左', 'left', 'l_'];

    for (let i = 0; i < iks.length; i++) {
      const ik = iks[i];
      const effBone = bones[ik.effector];
      const tgtBone = bones[ik.target];
      const eName = (effBone?.name || '').toLowerCase();
      const tName = (tgtBone?.name || '').toLowerCase();

      const isArm = armKw.some(k => eName.includes(k) || tName.includes(k));
      const isRight = rightKw.some(k => eName.includes(k) || tName.includes(k));
      const isLeft = leftKw.some(k => eName.includes(k) || tName.includes(k));

      if (isArm && tgtBone) {
        if (isRight && !this._ikTargetBones.right) {
          this._ikTargetBones.right = tgtBone;
          this._ikTargetDefaults.right = tgtBone.position.clone();
        } else if (isLeft && !this._ikTargetBones.left) {
          this._ikTargetBones.left = tgtBone;
          this._ikTargetDefaults.left = tgtBone.position.clone();
        }
      }
    }

    this._hasArmIK = !!(this._ikTargetBones.right || this._ikTargetBones.left);

    if (!this._hasArmIK) {
      console.warn('[Skeleton] ⚠️ 无可用的手臂 IK 链，启用直接骨骼操控 Fallback');
      this._findArmBones(bones);
    }

    mesh.frustumCulled = false;
    this._findHeadBone(bones);
  }

  _findArmBones(bones) {
    const armChainKw = ['腕', '手首', 'wrist', 'hand', 'ひじ', 'elbow', '肩', 'shoulder', '腕', 'arm'];
    const twistSkip = ['捩', 'twist'];
    const rightKw = ['右', 'right', 'r_'];
    const leftKw = ['左', 'left', 'l_'];

    const candidates = { right: [], left: [] };

    for (const bone of bones) {
      const name = bone.name;
      const lower = name.toLowerCase();
      const isArm = armChainKw.some(k => lower.includes(k));
      const isTwist = twistSkip.some(k => lower.includes(k) || name.includes(k));
      if (!isArm || isTwist) continue;

      const isRight = rightKw.some(k => lower.includes(k));
      const isLeft = leftKw.some(k => lower.includes(k));
      const side = isRight ? 'right' : isLeft ? 'left' : null;
      if (!side) continue;

      candidates[side].push(bone);
      }

    for (const side of ['right', 'left']) {
      const list = candidates[side];
      if (list.length === 0) {
        console.warn(`[Skeleton] ⚠️ ${side} 侧未找到手臂骨骼`);
        continue;
      }

      const shoulder = list.find(b => b.name.includes('肩') || b.name.includes('shoulder'));
      const upperArm = list.find(b =>
        (b.name.includes('腕') || b.name.includes('arm')) &&
        !b.name.includes('手首') && !b.name.includes('wrist') && !b.name.includes('hand') &&
        b !== shoulder
      );
      const forearm = list.find(b =>
        (b.name.includes('ひじ') || b.name.includes('elbow') || b.name.includes('前腕'))
      );
      const wrist = list.find(b =>
        b.name.includes('手首') || b.name.includes('wrist') || b.name.includes('hand')
      );

      if (shoulder && (upperArm || forearm || wrist)) {
        const chain = {
          shoulder: null,
          upperArm: null,
          forearm: null,
          wrist: null,
        };

        for (const b of list) {
          const n = b.name;
          if (n.includes('肩') || n.includes('shoulder')) chain.shoulder = b;
          else if (
            (n.includes('腕') || n.includes('arm')) &&
            !n.includes('手首') && !n.includes('wrist') && !n.includes('hand') &&
            !n.includes('ひじ') && !n.includes('elbow') && !n.includes('前腕')
          ) {
            if (!chain.upperArm) chain.upperArm = b;
          }
          else if (n.includes('ひじ') || n.includes('elbow') || n.includes('前腕')) {
            if (!chain.forearm) chain.forearm = b;
          }
          else if (n.includes('手首') || n.includes('wrist') || n.includes('hand')) {
            if (!chain.wrist) chain.wrist = b;
          }
        }

        if (!chain.upperArm && chain.forearm) {
          chain.upperArm = chain.forearm;
          chain.forearm = wrist;
          chain.wrist = null;
        }
        if (!chain.forearm && chain.wrist) {
          chain.forearm = chain.wrist;
          chain.wrist = null;
        }
        if (!chain.shoulder && chain.upperArm) {
          chain.shoulder = chain.upperArm?.parent;
          if (!chain.shoulder || !(chain.shoulder.name.includes('肩') || chain.shoulder.name.includes('shoulder'))) {
            chain.shoulder = null;
          }
        }

        const armLen = chain.upperArm ? this._boneLength(chain.upperArm) : 0.3;
        const foreLen = chain.forearm ? this._boneLength(chain.forearm) : 0.25;

        this._armBones[side] = {
          shoulder: chain.shoulder,
          upperArm: chain.upperArm,
          forearm: chain.forearm,
          wrist: chain.wrist,
          upperArmLen: armLen || 0.3,
          forearmLen: foreLen || 0.25,
          shoulderRestQuat: chain.shoulder ? chain.shoulder.quaternion.clone() : null,
          upperArmRestQuat: chain.upperArm ? chain.upperArm.quaternion.clone() : null,
          forearmRestQuat: chain.forearm ? chain.forearm.quaternion.clone() : null,
          wristRestQuat: chain.wrist ? chain.wrist.quaternion.clone() : null,
        };

        const parts = [];
        if (chain.shoulder) parts.push(`肩="${chain.shoulder.name}"`);
        if (chain.upperArm) parts.push(`上腕="${chain.upperArm.name}"`);
        if (chain.forearm) parts.push(`前腕="${chain.forearm.name}"`);
        if (chain.wrist) parts.push(`手首="${chain.wrist.name}"`);
        console.log(`[Skeleton] ✅ ${side}臂链: ${parts.join(', ')} len=${armLen.toFixed(2)}/${foreLen.toFixed(2)}`);
      } else {
        console.warn(`[Skeleton] ⚠️ ${side} 侧骨骼不足，无法构建臂链 (found: ${list.map(b => b.name).join(',')})`);
      }
    }

    if (!this._armBones.right && !this._armBones.left) {
      console.warn('[Skeleton] ⚠️ 两臂均无可用骨骼，手势功能不可用');
    }
  }

  _boneLength(bone) {
    if (!bone || !bone.children.length) return 0.3;
    const child = bone.children[0];
    return bone.position.distanceTo(child.position);
  }

  _findHeadBone(bones) {
    const headNames = ['頭', 'Head', 'head', '頭部'];
    for (const bone of bones) {
      if (headNames.some(n => bone.name === n || bone.name.includes(n))) {
        this._headBone = bone;
        this._headInitQuat = bone.quaternion.clone();
        console.log(`[Skeleton] 头部: "${bone.name}"`);
        return;
      }
    }
  }

  setAnimation(animationClip) {
    if (!animationClip) {
      this.mixer = null;
      return;
    }
    this.mixer = new THREE.AnimationMixer(this.mesh);
    const action = this.mixer.clipAction(animationClip);
    action.play();
    console.log('[Skeleton] Mixer 已创建');
  }

  applyTargets(field, dt, userWorldPos) {
    this._debugFrame++;
    this.mesh.updateMatrixWorld(true);

    if (this.mixer) {
      this.mixer.update(dt);
      this.mesh.updateMatrixWorld(true);
    }

    this._applyIKTargets(field, dt);

    if (this.ikSolver) {
      this.ikSolver.update();
    }

    this._applyMorphs(field, dt);
    this._applyHeadLookAt(field, dt, userWorldPos);

    this._sanitizeBones();

    this.mesh.updateMatrixWorld(true);

    if (this._debugFrame <= 1 || this._debugFrame % 300 === 0) {
      const s = this.getStatus();
      console.log(`[Skeleton] 帧${this._debugFrame}: armIK=${s.hasArmIK} R=${s.rightIK} L=${s.leftIK} directArm=${s.hasDirectArm}`);
    }
  }

  _applyIKTargets(field, dt) {
    if (this._hasArmIK) {
      this._applyCCDIKTargets(field, dt);
    } else {
      this._applyDirectArmBones(field, dt);
    }
  }

  _applyCCDIKTargets(field, dt) {
    const meshWorld = this.mesh.matrixWorld;

    for (const entry of [
      { bone: this._ikTargetBones.right, defaults: this._ikTargetDefaults.right,
        active: field.rightHandActive, position: field.rightHandTarget, label: 'right' },
      { bone: this._ikTargetBones.left, defaults: this._ikTargetDefaults.left,
        active: field.leftHandActive, position: field.leftHandTarget, label: 'left' },
    ]) {
      const { bone, defaults, active, position, label } = entry;
      if (!bone || !position) continue;

      if (active) {
        const worldTarget = position.clone().applyMatrix4(meshWorld);
        if (bone.parent) {
          bone.parent.updateMatrixWorld();
          const parentInv = new THREE.Matrix4().copy(bone.parent.matrixWorld).invert();
          worldTarget.applyMatrix4(parentInv);
        }
        bone.position.lerp(worldTarget, Math.min(1, dt * 15));
      } else if (defaults) {
        bone.position.lerp(defaults, 0.04);
      }

      if (active && this._debugFrame % 180 === 0) {
        console.log(`[Skeleton] IK ${label}: pos=(${bone.position.x.toFixed(2)},${bone.position.y.toFixed(2)},${bone.position.z.toFixed(2)})`);
      }
    }
  }

  _applyDirectArmBones(field, dt) {
    const meshWorld = this.mesh.matrixWorld;

    for (const side of ['right', 'left']) {
      const chain = this._armBones[side];
      if (!chain || !chain.shoulder || !chain.upperArm) continue;

      const activeKey = side === 'right' ? 'rightHandActive' : 'leftHandActive';
      const targetKey = side === 'right' ? 'rightHandTarget' : 'leftHandTarget';
      const active = field[activeKey];
      const target = field[targetKey];

      if (!active || !target) {
        this._relaxArm(chain, dt);
        continue;
      }

      chain.shoulder.updateMatrixWorld();
      chain.shoulder.updateMatrix();
      chain.upperArm.updateMatrixWorld();
      chain.upperArm.updateMatrix();

      const shoulderWorld = this._tmpV1;
      chain.shoulder.getWorldPosition(shoulderWorld);

      const targetWorld = target.clone().applyMatrix4(meshWorld);

      const dir = this._tmpV2.copy(targetWorld).sub(shoulderWorld);
      const dist = dir.length();
      dir.normalize();

      const armLen = chain.upperArmLen;
      const foreLen = chain.forearmLen;
      const maxReach = armLen + foreLen;
      const minReach = Math.abs(armLen - foreLen);

      let reachDist = Math.max(minReach + 0.01, Math.min(maxReach * 0.95, dist));

      const cosElbow = (armLen * armLen + reachDist * reachDist - foreLen * foreLen) /
                       (2 * armLen * reachDist * (reachDist > 0 ? reachDist : 1));
      const cosElbowClamped = Math.max(-1, Math.min(1, cosElbow));
      const elbowAngle = Math.acos(cosElbowClamped);

      const up = new THREE.Vector3(0, 1, 0);
      const sideVec = new THREE.Vector3().crossVectors(dir, up).normalize();
      if (sideVec.lengthSq() < 0.01) sideVec.set(1, 0, 0).normalize();

      const armDirLocal = this._tmpV2.copy(dir).applyAxisAngle(sideVec, elbowAngle - 0.3);
      armDirLocal.normalize();

      const shoulderLocal = this._tmpV1;
      chain.shoulder.parent?.updateMatrixWorld();
      const shoulderLocalTarget = targetWorld.clone();
      if (chain.shoulder.parent) {
        const parentInv = new THREE.Matrix4().copy(chain.shoulder.parent.matrixWorld).invert();
        shoulderLocalTarget.applyMatrix4(parentInv);
      }
      shoulderLocal.copy(shoulderLocalTarget).sub(
        chain.shoulder.parent
          ? chain.shoulder.parent.getWorldPosition(new THREE.Vector3())
          : new THREE.Vector3()
      ).normalize();

      const facingForward = new THREE.Vector3(0, 0, 1);
      const shoulderQuat = new THREE.Quaternion().setFromUnitVectors(
        facingForward,
        shoulderLocal
      );
      chain.shoulder.quaternion.slerp(shoulderQuat, Math.min(1, dt * 8));
      chain.shoulder.updateMatrix();

      if (chain.forearm) {
        chain.forearm.updateMatrixWorld();
        chain.forearm.updateMatrix();
        const elbowWorld = this._tmpV1;
        chain.forearm.getWorldPosition(elbowWorld);
        const forearmDir = this._tmpV2.copy(targetWorld).sub(elbowWorld).normalize();

        const forearmFwd = new THREE.Vector3(0, 1, 0);
        const forearmQuat = new THREE.Quaternion().setFromUnitVectors(forearmFwd, forearmDir);
        if (chain.forearmRestQuat) {
          forearmQuat.multiply(chain.forearmRestQuat);
        }
        chain.forearm.quaternion.slerp(forearmQuat, Math.min(1, dt * 8));
        chain.forearm.updateMatrix();
      }

      if (chain.wrist) {
        chain.wrist.updateMatrix();
      }

      if (active && this._debugFrame % 180 === 0) {
        console.log(`[Skeleton] DirectArm ${side}: target=(${target.x.toFixed(2)},${target.y.toFixed(2)},${target.z.toFixed(2)})`);
      }
    }
  }

  _relaxArm(chain, dt) {
    const lerp = Math.min(1, dt * 3);
    if (chain.shoulder && chain.shoulderRestQuat) {
      chain.shoulder.quaternion.slerp(chain.shoulderRestQuat, lerp);
      chain.shoulder.updateMatrix();
    }
    if (chain.forearm && chain.forearmRestQuat) {
      chain.forearm.quaternion.slerp(chain.forearmRestQuat, lerp);
      chain.forearm.updateMatrix();
    }
    if (chain.wrist && chain.wristRestQuat) {
      chain.wrist.quaternion.slerp(chain.wristRestQuat, lerp);
      chain.wrist.updateMatrix();
    }
    if (chain.upperArm && chain.upperArmRestQuat) {
      chain.upperArm.quaternion.slerp(chain.upperArmRestQuat, lerp);
      chain.upperArm.updateMatrix();
    }
  }

  _applyMorphs(field, dt) {
    if (!this.mesh.morphTargetDictionary) return;
    const dict = this.mesh.morphTargetDictionary;

    for (const [name, idx] of Object.entries(dict)) {
      const lower = name.toLowerCase();
      let target = 0;

      if (lower.includes('mouth') || name.includes('口') ||
          name.includes('あ') || name.includes('ア') ||
          lower === 'a' || lower.includes('open')) {
        target = field.mouthOpen || 0;
      } else if (lower.includes('smile') || name.includes('笑') ||
                 name.includes('ニッコリ') || name.includes('嬉')) {
        target = field.smile || 0;
      } else if (lower.includes('wink') || name.includes('ウィンク') ||
                 name.includes('瞬き') || lower.includes('blink') ||
                 name.includes('まばた')) {
        target = field.blink || 0;
      }

      const cur = this.mesh.morphTargetInfluences[idx] || 0;
      this.mesh.morphTargetInfluences[idx] = lerpCriticalDamped(cur, target, dt, 6);
    }
  }

  _applyHeadLookAt(field, dt, userWorldPos) {
    if (!this._headBone || !this._headInitQuat || !userWorldPos) return;

    const headWorldPos = new THREE.Vector3();
    this._headBone.getWorldPosition(headWorldPos);
    const dir = new THREE.Vector3().copy(userWorldPos).sub(headWorldPos);
    if (dir.lengthSq() < 0.01) return;
    dir.normalize();

    const baseFwd = new THREE.Vector3(0, 0, 1);
    const delta = new THREE.Quaternion().setFromUnitVectors(baseFwd, dir);
    const target = new THREE.Quaternion().copy(this._headInitQuat).premultiply(delta);

    const weight = (field.headLookAtWeight || 0.5) * 0.45;
    this._headBone.quaternion.slerp(target, Math.min(1, dt * 2.5));

    if (field.headOffset && (field.headOffset.x || field.headOffset.y || field.headOffset.z)) {
      const euler = new THREE.Euler(
        field.headOffset.x * 0.3,
        field.headOffset.y * 0.3,
        field.headOffset.z * 0.3
      );
      const offsetQuat = new THREE.Quaternion().setFromEuler(euler);
      this._headBone.quaternion.slerp(
        this._headBone.quaternion.clone().multiply(offsetQuat),
        0.3
      );
    }

    this._headBone.updateMatrix();
  }

  _sanitizeBones() {
    for (const bone of this.mesh.skeleton.bones) {
      const q = bone.quaternion;
      if (isNaN(q.x) || isNaN(q.y) || isNaN(q.z) || isNaN(q.w)) {
        q.set(0, 0, 0, 1);
        bone.updateMatrix();
      }
    }
  }

  getStatus() {
    return {
      hasIK: !!this.ikSolver,
      hasArmIK: this._hasArmIK,
      rightIK: !!this._ikTargetBones.right,
      leftIK: !!this._ikTargetBones.left,
      hasDirectArm: !!(this._armBones.right || this._armBones.left),
      hasMixer: !!this.mixer,
      hasHead: !!this._headBone,
    };
  }
}
