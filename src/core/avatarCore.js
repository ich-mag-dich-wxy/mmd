import * as THREE from 'three';
import { lerpCriticalDamped } from '../utils/spring.js';

export class AvatarCore {
  constructor(mesh, opts = {}) {
    this.mesh = mesh;
    this.helper = opts.helper || null;
    this.isSpeaking = false;

    this.userWorldPos = new THREE.Vector3(0, 1.6, 2.5);
    this._animClip = null;
    this._animTime = 0;
    this._headBone = null;
    this._headInitQuat = null;
    this._blinkTimer = 3 + Math.random() * 3;
    this._blinkPhase = 0;
    this._activeBoneIndices = new Set();
    this._returnSpeed = 8.0;
    this._vmdMode = !!opts.vmdMode;
    this._vmdModePureJS = false;

    const bones = mesh.skeleton.bones;
    this._boneRest = [];
    this._boneRestPos = [];
    for (let i = 0; i < bones.length; i++) {
      this._boneRest[i] = bones[i].quaternion.clone();
      this._boneRestPos[i] = bones[i].position.clone();
    }

    const sk = mesh.skeleton;
    if (!sk.boneInverses) {
      sk.boneInverses = new Array(bones.length);
      mesh.updateMatrixWorld(true);
      for (let i = 0; i < bones.length; i++) {
        sk.boneInverses[i] = new THREE.Matrix4().copy(bones[i].matrixWorld).invert();
      }
    }

    if (!sk.boneMatrices || sk.boneMatrices.length !== bones.length * 16) {
      sk.boneMatrices = new Float32Array(bones.length * 16);
    }

    if (!sk.boneTexture) {
      const size = Math.ceil(Math.sqrt(bones.length * 4));
      const data = new Float32Array(size * size * 4);
      sk.boneTexture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat, THREE.FloatType);
      sk.boneTextureSize = size;
    }

    if (!mesh.bindMatrix) mesh.bindMatrix = new THREE.Matrix4().identity();
    if (!mesh.bindMatrixInverse) mesh.bindMatrixInverse = new THREE.Matrix4().identity();

    mesh.frustumCulled = false;
    this._findHeadBone(bones);
  }

  _findHeadBone(bones) {
    const headNames = ['頭', 'Head', 'head', '頭部'];
    for (const bone of bones) {
      if (headNames.some(n => bone.name === n || bone.name.includes(n))) {
        this._headBone = bone;
        this._headInitQuat = bone.quaternion.clone();
        return;
      }
    }
  }

  stopAllAnimations() {
    this._animClip = null;
    this._animTime = 0;
    this._activeBoneIndices.clear();
    this._vmdModePureJS = false;
    if (this.helper) {
      try { this.helper.remove(this.mesh); } catch(e) {}
    }
    const skeleton = this.mesh.skeleton;
    if (skeleton) {
      for (let i = 0; i < skeleton.bones.length; i++) {
        const bone = skeleton.bones[i];
        if (bone && this._boneRest[i]) {
          bone.quaternion.copy(this._boneRest[i]);
        }
      }
    }
  }

  playClip(clip) {
    this.stopAllAnimations();
    this._animClip = clip;
    this._animTime = 0;
    this._vmdModePureJS = true;
  }

  update(dt) {
    if (!dt || dt > 0.1) dt = 0.016;

    if (this._animClip && this._animTime < this._animClip.duration) {
      this._animTime += dt;
      this._applyBoneAnimation(this._animClip, this._animTime);
    } else if (this._animClip && this._animTime >= this._animClip.duration) {
      if (this._vmdModePureJS) {
        this._animTime = this._animTime % this._animClip.duration;
        this._applyBoneAnimation(this._animClip, this._animTime);
      } else {
        this._resetBonesToRest(dt);
        if (this._activeBoneIndices.size === 0) {
          this._animClip = null;
          this._animTime = 0;
        }
      }
    }

    if (!this._animClip && !this._vmdMode && !this._vmdModePureJS) {
      this._applyHeadLookAt(dt);
    }

    if (!this._vmdModePureJS) {
      this._applyMorphTargets(dt);
    }
  }

  _applyBoneAnimation(clip, time) {
    this._activeBoneIndices.clear();
    const skeleton = this.mesh.skeleton;
    const POS_THRESHOLD = 1e-6;

    for (const track of clip.tracks) {
      const bone = skeleton.bones[track.boneIdx];
      if (!bone) continue;

      const kf = sampleKeyframes(track.keyframes, time);

      kf.quat.normalize();
      bone.quaternion.copy(kf.quat);

      if (kf.pos) {
        const restPos = this._boneRestPos[track.boneIdx];
        if (restPos) {
          if (Math.abs(kf.pos.x) > POS_THRESHOLD ||
              Math.abs(kf.pos.y) > POS_THRESHOLD ||
              Math.abs(kf.pos.z) > POS_THRESHOLD) {
            bone.position.set(
              restPos.x + kf.pos.x,
              restPos.y + kf.pos.y,
              restPos.z + kf.pos.z,
            );
          } else {
            bone.position.copy(restPos);
          }
        }
      }

      bone.matrixWorldNeedsUpdate = true;
      this._activeBoneIndices.add(track.boneIdx);
    }
    for (const bone of skeleton.bones) {
      if (!bone.parent || !bone.parent.isBone) {
        bone.updateMatrixWorld(true);
      }
    }
    skeleton.update();
    if (skeleton.boneTexture) {
      skeleton.computeBoneTexture();
    }

    if (clip.morphTracks && clip.morphTracks.length > 0 && this.mesh.morphTargetInfluences) {
      const dict = this.mesh.morphTargetDictionary;
      const influences = this.mesh.morphTargetInfluences;
      for (const mt of clip.morphTracks) {
        // 优先使用预解析的 morphIdx，否则查 morphTargetDictionary
        let idx = mt.morphIdx;
        if (idx === undefined && dict) idx = dict[mt.morphName];
        if (idx === undefined) continue;
        const w = lerpMorphKeyframes(mt.keyframes, time);
        influences[idx] = w;
      }
    }
  }

  _resetBonesToRest(dt) {
    if (this._activeBoneIndices.size === 0) return;
    const skeleton = this.mesh.skeleton;
    let allRest = true;
    for (const idx of this._activeBoneIndices) {
      const bone = skeleton.bones[idx];
      const rest = this._boneRest[idx];
      if (bone && rest) {
        bone.quaternion.slerp(rest, dt * this._returnSpeed);
        bone.quaternion.normalize();
        bone.matrixWorldNeedsUpdate = true;
        if (bone.quaternion.angleTo(rest) > 0.001) {
          allRest = false;
        }
      }
    }
    for (const bone of skeleton.bones) {
      if (!bone.parent || !bone.parent.isBone) {
        bone.updateMatrixWorld(true);
      }
    }
    skeleton.update();
    if (skeleton.boneTexture) {
      skeleton.computeBoneTexture();
    }
    if (allRest) {
      this._activeBoneIndices.clear();
    }
  }

  _applyMorphTargets(dt) {
    if (!this.mesh.morphTargetDictionary) return;
    const dict = this.mesh.morphTargetDictionary;
    const skipKw = ['まつげ', '睫毛', 'lash', '眉', '目', 'eye', '涙', 'tear', '頬', 'cheek'];
    for (const [name, idx] of Object.entries(dict)) {
      const lower = name.toLowerCase();
      if (skipKw.some(k => lower.includes(k) || name.includes(k))) continue;
      let target = -1;
      if (name === 'あ' || lower === 'a' || name === 'ア') {
        target = 0;
      } else if ((name.includes('笑顔') || name.includes('にっこり') || name.includes('ニッコリ')) && !name.includes('困')) {
        target = 0.1;
      } else if (name.includes('まばたき') || lower === 'blink' || lower.includes('wink') || name.includes('ｳｨﾝｸ') || name === 'ウィンク') {
        target = this._blinkPhase;
      }
      if (target < 0) continue;
      const cur = this.mesh.morphTargetInfluences[idx] || 0;
      this.mesh.morphTargetInfluences[idx] = lerpCriticalDamped(cur, target, dt, 6);
    }
    this._blinkTimer -= dt;
    if (this._blinkTimer <= 0) {
      this._blinkTimer = 2.5 + Math.random() * 5;
      this._blinkPhase = 0.2;
    }
    if (this._blinkPhase > 0) {
      this._blinkPhase -= dt;
      const p = 1 - this._blinkPhase / 0.2;
      this._blinkPhase = p < 0.4 ? p / 0.4 : (1 - p) / 0.6;
    }
  }

  _applyHeadLookAt(dt) {
    if (!this._headBone || !this._headInitQuat) return;
    if (this._animClip || this._vmdMode) return;
    const headWorldPos = new THREE.Vector3();
    this._headBone.getWorldPosition(headWorldPos);
    const dir = new THREE.Vector3().copy(this.userWorldPos).sub(headWorldPos);
    if (dir.lengthSq() < 0.01) return;
    dir.normalize();
    const baseFwd = new THREE.Vector3(0, 0, 1);
    const delta = new THREE.Quaternion().setFromUnitVectors(baseFwd, dir);
    const target = new THREE.Quaternion().copy(this._headInitQuat).premultiply(delta);
    this._headBone.quaternion.slerp(target, Math.min(1, dt * 2.5));
    this._headBone.updateMatrix();
    this._headBone.matrixWorldNeedsUpdate = true;
    this.mesh.skeleton.update();
    if (this.mesh.skeleton.boneTexture) {
      this.mesh.skeleton.computeBoneTexture();
    }
  }
}

function lerpKeyframes(kfs, t) {
  if (kfs.length === 1) return kfs[0].quat;
  if (t <= kfs[0].time) return kfs[0].quat;
  if (t >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].quat;
  let i = 0;
  while (i < kfs.length - 1 && kfs[i + 1].time <= t) i++;
  const a = kfs[i];
  const b = kfs[i + 1];
  const alpha = (t - a.time) / (b.time - a.time);
  const result = new THREE.Quaternion();
  result.slerpQuaternions(a.quat, b.quat, alpha);
  return result;
}

function sampleKeyframes(kfs, t) {
  if (kfs.length === 1) return kfs[0];
  if (t <= kfs[0].time) return kfs[0];
  if (t >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1];
  let i = 0;
  while (i < kfs.length - 1 && kfs[i + 1].time <= t) i++;
  const a = kfs[i];
  const b = kfs[i + 1];
  const alpha = (t - a.time) / (b.time - a.time);
  const result = {
    time: t,
    quat: new THREE.Quaternion().slerpQuaternions(a.quat, b.quat, alpha),
  };
  if (a.pos && b.pos) {
    result.pos = new THREE.Vector3().lerpVectors(a.pos, b.pos, alpha);
  }
  return result;
}

function lerpMorphKeyframes(kfs, t) {
  if (kfs.length === 1) return kfs[0].weight;
  if (t <= kfs[0].time) return kfs[0].weight;
  if (t >= kfs[kfs.length - 1].time) return kfs[kfs.length - 1].weight;
  let i = 0;
  while (i < kfs.length - 1 && kfs[i + 1].time <= t) i++;
  const a = kfs[i];
  const b = kfs[i + 1];
  const alpha = (t - a.time) / (b.time - a.time);
  return a.weight + (b.weight - a.weight) * alpha;
}

export function createAvatar(mesh, opts = {}) {
  return new AvatarCore(mesh, opts);
}