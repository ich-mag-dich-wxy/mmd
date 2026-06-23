import * as THREE from 'three';
import { encodeShiftJISInto } from './vmdDecompiler.js';

// ═══════════════════════════════════════════════════════════
//  VMD 录制器 + 快照 + 本地文件保存
//  使用 File System Access API 直接保存到本地文件夹
// ═══════════════════════════════════════════════════════════

const BONE_FRAME_SIZE = 111;   // 15 + 4 + 12 + 16 + 64
const MORPH_FRAME_SIZE = 23;   // 15 + 4 + 4
const VMD_HEADER_SIZE = 50;    // 30 + 20
const POS_THRESHOLD = 1e-5;
const ROT_THRESHOLD = 0.005;   // 弧度

// 文件夹句柄
let recordDirHandle = null;
let snapshotDirHandle = null;

/**
 * 选择录制保存目录
 */
export async function pickRecordDir() {
  if (!window.showDirectoryPicker) {
    throw new Error('浏览器不支持文件系统访问 API，请使用 Chrome/Edge 浏览器');
  }
  recordDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  return recordDirHandle.name;
}

/**
 * 选择快照保存目录
 */
export async function pickSnapshotDir() {
  if (!window.showDirectoryPicker) {
    throw new Error('浏览器不支持文件系统访问 API，请使用 Chrome/Edge 浏览器');
  }
  snapshotDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  return snapshotDirHandle.name;
}

/**
 * 保存文件到指定目录
 */
async function saveToDir(dirHandle, fileName, data) {
  const fileHandle = await dirHandle.getFileHandle(fileName, { create: true });
  const writable = await fileHandle.createWritable();
  await writable.write(data);
  await writable.close();
}

/**
 * 保存录制文件
 */
export async function saveRecording(fileName, data) {
  if (!recordDirHandle) {
    recordDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  }
  if (!fileName.endsWith('.vmd')) fileName += '.vmd';
  await saveToDir(recordDirHandle, fileName, data);
  return recordDirHandle.name + '/' + fileName;
}

/**
 * 保存快照文件
 */
export async function saveSnapshot(fileName, data) {
  if (!snapshotDirHandle) {
    snapshotDirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  }
  if (!fileName.endsWith('.vmd')) fileName += '.vmd';
  await saveToDir(snapshotDirHandle, fileName, data);
  return snapshotDirHandle.name + '/' + fileName;
}

/**
 * VMD 录制器
 */
export class VMDRecorder {
  constructor(mesh) {
    this.mesh = mesh;
    this.boneFrames = [];      // {name, frameNum, pos[3], quat[4]}
    this.morphFrames = [];     // {name, frameNum, weight}
    this.recording = false;
    this.startTime = 0;
    this.lastFrameNum = -1;

    // 记录 rest pose
    const bones = mesh.skeleton.bones;
    this.restPositions = [];
    this.restQuaternions = [];
    for (let i = 0; i < bones.length; i++) {
      this.restPositions.push(bones[i].position.clone());
      this.restQuaternions.push(bones[i].quaternion.clone());
    }
  }

  /**
   * 开始录制
   */
  start() {
    this.boneFrames = [];
    this.morphFrames = [];
    this.recording = true;
    this.startTime = performance.now();
    this.lastFrameNum = -1;
  }

  /**
   * 捕获当前帧（在 animate 循环中调用）
   */
  captureFrame() {
    if (!this.recording) return;

    const frameNum = Math.floor((performance.now() - this.startTime) * 30 / 1000);
    if (frameNum === this.lastFrameNum) return; // 同一帧不重复记录
    this.lastFrameNum = frameNum;

    const bones = this.mesh.skeleton.bones;
    const _tmpQuat = new THREE.Quaternion();

    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i];
      const restPos = this.restPositions[i];
      const restQuat = this.restQuaternions[i];

      // 位置偏移
      const dx = bone.position.x - restPos.x;
      const dy = bone.position.y - restPos.y;
      const dz = bone.position.z - restPos.z;
      const hasPos = Math.abs(dx) > POS_THRESHOLD || Math.abs(dy) > POS_THRESHOLD || Math.abs(dz) > POS_THRESHOLD;

      // 旋转差异
      const rotDiff = bone.quaternion.angleTo(restQuat);

      // 只记录有变化的骨骼（减少文件大小）
      if (!hasPos && rotDiff < ROT_THRESHOLD) continue;

      // 转换到 VMD 左手系：位置 z 取反，四元数 x/y 取反
      this.boneFrames.push({
        name: bone.name,
        frameNum,
        pos: hasPos ? [dx, dy, -dz] : [0, 0, 0],
        quat: [-bone.quaternion.x, -bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
      });
    }

    // 记录表情
    if (this.mesh.morphTargetInfluences && this.mesh.morphTargetDictionary) {
      for (const [name, idx] of Object.entries(this.mesh.morphTargetDictionary)) {
        const weight = this.mesh.morphTargetInfluences[idx];
        if (weight > 0.001) {
          this.morphFrames.push({ name, frameNum, weight });
        }
      }
    }
  }

  /**
   * 停止录制，返回 VMD 二进制数据
   */
  stop() {
    this.recording = false;
    return this._generateVMD(this.boneFrames, this.morphFrames);
  }

  /**
   * 快照：记录当前姿势为单帧 VMD
   */
  snapshot() {
    const bones = this.mesh.skeleton.bones;
    const frames = [];
    const morphs = [];

    for (let i = 0; i < bones.length; i++) {
      const bone = bones[i];
      const restPos = this.restPositions[i];
      const restQuat = this.restQuaternions[i];

      const dx = bone.position.x - restPos.x;
      const dy = bone.position.y - restPos.y;
      const dz = bone.position.z - restPos.z;
      const hasPos = Math.abs(dx) > POS_THRESHOLD || Math.abs(dy) > POS_THRESHOLD || Math.abs(dz) > POS_THRESHOLD;
      const rotDiff = bone.quaternion.angleTo(restQuat);

      if (!hasPos && rotDiff < ROT_THRESHOLD) continue;

      frames.push({
        name: bone.name,
        frameNum: 0,
        pos: hasPos ? [dx, dy, -dz] : [0, 0, 0],
        quat: [-bone.quaternion.x, -bone.quaternion.y, bone.quaternion.z, bone.quaternion.w],
      });
    }

    if (this.mesh.morphTargetInfluences && this.mesh.morphTargetDictionary) {
      for (const [name, idx] of Object.entries(this.mesh.morphTargetDictionary)) {
        const weight = this.mesh.morphTargetInfluences[idx];
        if (weight > 0.001) {
          morphs.push({ name, frameNum: 0, weight });
        }
      }
    }

    return this._generateVMD(frames, morphs);
  }

  /**
   * 获取录制时长（秒）
   */
  getDuration() {
    if (!this.recording) return 0;
    return (performance.now() - this.startTime) / 1000;
  }

  /**
   * 获取已录制帧数
   */
  getFrameCount() {
    return this.lastFrameNum + 1;
  }

  /**
   * 生成 VMD 二进制
   */
  _generateVMD(frames, morphs) {
    frames = frames || this.boneFrames;
    morphs = morphs || this.morphFrames;

    const totalSize = VMD_HEADER_SIZE + 4 + frames.length * BONE_FRAME_SIZE + 4 + morphs.length * MORPH_FRAME_SIZE + 8;
    const buffer = new ArrayBuffer(totalSize);
    const view = new DataView(buffer);
    const uint8 = new Uint8Array(buffer);

    // Header
    encodeShiftJISInto('Vocaloid Motion Data 0002', view, 0, 30);
    encodeShiftJISInto('Camera', view, 30, 20);

    // 骨骼帧
    let offset = VMD_HEADER_SIZE;
    view.setUint32(offset, frames.length, true);
    offset += 4;

    for (const frame of frames) {
      encodeShiftJISInto(frame.name, view, offset, 15);
      offset += 15;
      view.setUint32(offset, frame.frameNum, true);
      offset += 4;
      view.setFloat32(offset, frame.pos[0], true); offset += 4;
      view.setFloat32(offset, frame.pos[1], true); offset += 4;
      view.setFloat32(offset, frame.pos[2], true); offset += 4;
      view.setFloat32(offset, frame.quat[0], true); offset += 4;
      view.setFloat32(offset, frame.quat[1], true); offset += 4;
      view.setFloat32(offset, frame.quat[2], true); offset += 4;
      view.setFloat32(offset, frame.quat[3], true); offset += 4;
      // 默认贝塞尔曲线（线性插值）
      for (let i = 0; i < 64; i++) uint8[offset + i] = 20;
      offset += 64;
    }

    // 表情帧
    view.setUint32(offset, morphs.length, true);
    offset += 4;

    for (const morph of morphs) {
      encodeShiftJISInto(morph.name, view, offset, 15);
      offset += 15;
      view.setUint32(offset, morph.frameNum, true);
      offset += 4;
      view.setFloat32(offset, morph.weight, true);
      offset += 4;
    }

    // cameraCount = 0, lightCount = 0
    view.setUint32(offset, 0, true); offset += 4;
    view.setUint32(offset, 0, true); offset += 4;

    return new Uint8Array(buffer, 0, offset);
  }
}
