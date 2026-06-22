import * as THREE from 'three';

const VMD_MAGIC_LEN = 30;
const MODEL_NAME_LEN = 20;
const BONE_NAME_LEN = 15;
const BONE_FRAME_SIZE = 111;
const MORPH_NAME_LEN = 15;
const MORPH_FRAME_SIZE = 23;
const VMD_HEADER_SIZE = VMD_MAGIC_LEN + MODEL_NAME_LEN;

// 十六进制查找表
const HEX = new Array(256);
for (let i = 0; i < 256; i++) HEX[i] = i.toString(16).padStart(2, '0');

// 十六进制字符→数值查找表
const HEX_VAL = new Uint8Array(128);
for (let i = 0; i < 10; i++) HEX_VAL[48 + i] = i;       // '0'-'9'
for (let i = 0; i < 6; i++) HEX_VAL[97 + i] = 10 + i;   // 'a'-'f'
for (let i = 0; i < 6; i++) HEX_VAL[65 + i] = 10 + i;   // 'A'-'F'

// ═══════════════════════════════════════════════════════════
//  MMD 左手坐标系 ↔ Three.js 右手坐标系 转换
//  与 MMDParser 的 leftToRightVector3 / leftToRightQuaternion 一致
//  位置: z = -z
//  四元数: x = -x, y = -y
// ═══════════════════════════════════════════════════════════

// left → right（反编译时：VMD原始 → 文本中存储的右手系值）
function leftToRightPos(px, py, pz) { return [px, py, -pz]; }
function leftToRightQuat(qx, qy, qz, qw) { return [-qx, -qy, qz, qw]; }

// right → left（编译时：文本中右手系值 → VMD原始左手系）
function rightToLeftPos(px, py, pz) { return [px, py, -pz]; }
function rightToLeftQuat(qx, qy, qz, qw) { return [-qx, -qy, qz, qw]; }

// ═══════════════════════════════════════════════════════════
//  Shift-JIS 解码（反编译用，带缓存）
// ═══════════════════════════════════════════════════════════

const _decoderCache = new Map();
let _decoder = null;
try { _decoder = new TextDecoder('shift-jis'); } catch (e) {}

function shiftJISToString(uint8, offset, len) {
  let actualLen = 0;
  while (actualLen < len && uint8[offset + actualLen] !== 0) actualLen++;
  if (actualLen === 0) return '';

  let hash = actualLen;
  for (let i = 0; i < actualLen; i++) hash = ((hash << 5) - hash + uint8[offset + i]) | 0;
  const cached = _decoderCache.get(hash);
  if (cached !== undefined) return cached;

  let str;
  if (_decoder) {
    const view = new Uint8Array(uint8.buffer, uint8.byteOffset + offset, actualLen);
    str = _decoder.decode(view).trim();
  } else {
    str = '';
    for (let i = 0; i < actualLen; i++) str += String.fromCharCode(uint8[offset + i]);
    str = str.trim();
  }
  if (_decoderCache.size < 2000) _decoderCache.set(hash, str);
  return str;
}

// ═══════════════════════════════════════════════════════════
//  Shift-JIS 编码（编译用，延迟构建）
// ═══════════════════════════════════════════════════════════

let _shiftJISEncodeMap = null;

function buildShiftJISEncodeMap() {
  if (_shiftJISEncodeMap) return _shiftJISEncodeMap;
  _shiftJISEncodeMap = new Map();
  if (!_decoder) return _shiftJISEncodeMap;

  for (let b = 0; b <= 0xFF; b++) {
    try {
      const str = _decoder.decode(new Uint8Array([b]));
      if (str && str.length === 1) {
        const code = str.charCodeAt(0);
        if (!_shiftJISEncodeMap.has(code)) _shiftJISEncodeMap.set(code, b);
      }
    } catch (e) { /* skip */ }
  }
  for (let b1 = 0x81; b1 <= 0x9F; b1++) {
    for (let b2 = 0x40; b2 <= 0xFC; b2++) {
      if (b2 === 0x7F) continue;
      try {
        const str = _decoder.decode(new Uint8Array([b1, b2]));
        if (str && str.length === 1) {
          const code = str.charCodeAt(0);
          if (code > 0x7F && !_shiftJISEncodeMap.has(code)) _shiftJISEncodeMap.set(code, (b1 << 8) | b2);
        }
      } catch (e) { /* skip */ }
    }
  }
  for (let b1 = 0xE0; b1 <= 0xEF; b1++) {
    for (let b2 = 0x40; b2 <= 0xFC; b2++) {
      if (b2 === 0x7F) continue;
      try {
        const str = _decoder.decode(new Uint8Array([b1, b2]));
        if (str && str.length === 1) {
          const code = str.charCodeAt(0);
          if (code > 0x7F && !_shiftJISEncodeMap.has(code)) _shiftJISEncodeMap.set(code, (b1 << 8) | b2);
        }
      } catch (e) { /* skip */ }
    }
  }
  console.log(`[VMD] Shift-JIS 编码表: ${_shiftJISEncodeMap.size} 字符`);
  return _shiftJISEncodeMap;
}

function encodeShiftJISInto(str, view, offset, maxLen) {
  const map = buildShiftJISEncodeMap();
  let pos = 0;
  for (let i = 0; i < str.length && pos < maxLen; i++) {
    const code = str.charCodeAt(i);
    const encoded = map.get(code);
    if (encoded !== undefined) {
      if (encoded <= 0xFF) {
        view.setUint8(offset + pos, encoded);
        pos++;
      } else {
        if (pos + 1 >= maxLen) break;
        view.setUint8(offset + pos, encoded >> 8);
        view.setUint8(offset + pos + 1, encoded & 0xFF);
        pos += 2;
      }
    } else if (code < 0x80) {
      view.setUint8(offset + pos, code);
      pos++;
    } else {
      view.setUint8(offset + pos, 0x3F);
      pos++;
    }
  }
  for (let i = pos; i < maxLen; i++) view.setUint8(offset + i, 0);
}

// ═══════════════════════════════════════════════════════════
//  VMD → Text（反编译）— 异步批处理
//  输出文本中的坐标已转换为 Three.js 右手坐标系
// ═══════════════════════════════════════════════════════════

export async function vmdToText(arrayBuffer, onProgress) {
  const uint8 = new Uint8Array(arrayBuffer);
  const view = new DataView(arrayBuffer);

  if (arrayBuffer.byteLength < VMD_HEADER_SIZE) {
    throw new Error('VMD 文件不完整');
  }

  const magic = shiftJISToString(uint8, 0, VMD_MAGIC_LEN);
  if (!magic.startsWith('Vocaloid Motion Data')) {
    throw new Error('不是有效的 VMD 文件');
  }

  const modelName = shiftJISToString(uint8, VMD_MAGIC_LEN, MODEL_NAME_LEN);

  const chunks = [`model: ${modelName || '(未命名)'}`];
  const BATCH = 4000;

  let offset = VMD_HEADER_SIZE;
  const boneFrameCount = view.getUint32(offset, true);
  offset += 4;

  const hexBuf = new Array(65);

  // 骨骼帧
  for (let i = 0; i < boneFrameCount; i++) {
    if (offset + BONE_FRAME_SIZE > arrayBuffer.byteLength) break;

    const boneName = shiftJISToString(uint8, offset, BONE_NAME_LEN);
    offset += BONE_NAME_LEN;

    const frameNum = view.getUint32(offset, true);
    offset += 4;

    // 位置：left → right (z 取反)
    const [px, py, pz] = leftToRightPos(
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
      view.getFloat32(offset + 8, true),
    );
    offset += 12;

    // 四元数：left → right (x, y 取反)
    const [qx, qy, qz, qw] = leftToRightQuat(
      view.getFloat32(offset, true),
      view.getFloat32(offset + 4, true),
      view.getFloat32(offset + 8, true),
      view.getFloat32(offset + 12, true),
    );
    offset += 16;

    // bezier → 十六进制
    hexBuf[0] = 'h:';
    for (let b = 0; b < 64; b++) hexBuf[b + 1] = HEX[uint8[offset + b]];
    offset += 64;

    chunks.push(`b ${boneName} ${frameNum} ${px.toFixed(6)} ${py.toFixed(6)} ${pz.toFixed(6)} ${qx.toFixed(6)} ${qy.toFixed(6)} ${qz.toFixed(6)} ${qw.toFixed(6)} ${hexBuf.join('')}`);

    if ((i + 1) % BATCH === 0) {
      if (onProgress) onProgress('bone', i + 1, boneFrameCount);
      await yieldToMain();
    }
  }

  if (onProgress) onProgress('bone', boneFrameCount, boneFrameCount);

  // 形变帧
  if (offset + 4 <= arrayBuffer.byteLength) {
    const morphFrameCount = view.getUint32(offset, true);
    offset += 4;

    for (let i = 0; i < morphFrameCount; i++) {
      if (offset + MORPH_FRAME_SIZE > arrayBuffer.byteLength) break;

      const morphName = shiftJISToString(uint8, offset, MORPH_NAME_LEN);
      offset += MORPH_NAME_LEN;
      const frameNum = view.getUint32(offset, true);
      offset += 4;
      const weight = view.getFloat32(offset, true);
      offset += 4;

      chunks.push(`m ${morphName} ${frameNum} ${weight.toFixed(6)}`);

      if ((i + 1) % BATCH === 0) {
        if (onProgress) onProgress('morph', i + 1, morphFrameCount);
        await yieldToMain();
      }
    }
    if (onProgress) onProgress('morph', morphFrameCount, morphFrameCount);
  }

  return chunks.join('\n');
}

function yieldToMain() {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// ═══════════════════════════════════════════════════════════
//  Text → VMD 二进制（编译）— 异步批处理
//  输入文本为 Three.js 右手坐标系，编译时转回 VMD 左手坐标系
// ═══════════════════════════════════════════════════════════

export async function textToVMD(text, onProgress) {
  const lines = text.split('\n');
  const totalLines = lines.length;

  // 第一遍：统计最大帧数（用于预分配 buffer）
  let maxBoneFrames = 0;
  let maxMorphFrames = 0;
  let modelName = '';

  for (let i = 0; i < totalLines; i++) {
    const line = lines[i];
    if (line.startsWith('b ')) maxBoneFrames++;
    else if (line.startsWith('m ')) maxMorphFrames++;
    else if (line.startsWith('model: ')) modelName = line.slice(7).trim();
  }

  if (maxBoneFrames === 0) {
    throw new Error('没有骨骼帧数据可编译');
  }

  // 预分配 VMD buffer（按最大可能大小分配，+8 字节给 cameraCount + lightCount）
  const maxDataSize = VMD_HEADER_SIZE + 4 + maxBoneFrames * BONE_FRAME_SIZE + 4 + maxMorphFrames * MORPH_FRAME_SIZE + 8;
  const buffer = new ArrayBuffer(maxDataSize);
  const vview = new DataView(buffer);

  // 写入头部
  encodeShiftJISInto('Vocaloid Motion Data 0002', vview, 0, 30);
  encodeShiftJISInto(modelName, vview, 30, 20);

  // 骨骼帧数占位（稍后回写实际值）
  const boneCountOffset = VMD_HEADER_SIZE;
  let offset = boneCountOffset + 4;

  const BATCH = 4000;

  // 第二遍：写入所有骨骼帧
  let boneIdx = 0;
  for (let li = 0; li < totalLines; li++) {
    const line = lines[li];
    if (!line.startsWith('b ')) continue;

    const spaceAfterQw = nthSpaceIndex(line, 9);
    let boneName, frameNum, px, py, pz, qx, qy, qz, qw;

    if (spaceAfterQw > 0) {
      const headPart = line.substring(2, spaceAfterQw);
      const hp = headPart.split(/\s+/);
      if (hp.length < 9) continue;
      boneName = hp[0]; frameNum = parseInt(hp[1], 10);
      px = parseFloat(hp[2]); py = parseFloat(hp[3]); pz = parseFloat(hp[4]);
      qx = parseFloat(hp[5]); qy = parseFloat(hp[6]); qz = parseFloat(hp[7]); qw = parseFloat(hp[8]);

      const [lpx, lpy, lpz] = rightToLeftPos(px, py, pz);
      const [lqx, lqy, lqz, lqw] = rightToLeftQuat(qx, qy, qz, qw);

      encodeShiftJISInto(boneName, vview, offset, BONE_NAME_LEN);
      offset += BONE_NAME_LEN;
      vview.setUint32(offset, frameNum, true); offset += 4;
      vview.setFloat32(offset, lpx, true); offset += 4;
      vview.setFloat32(offset, lpy, true); offset += 4;
      vview.setFloat32(offset, lpz, true); offset += 4;
      vview.setFloat32(offset, lqx, true); offset += 4;
      vview.setFloat32(offset, lqy, true); offset += 4;
      vview.setFloat32(offset, lqz, true); offset += 4;
      vview.setFloat32(offset, lqw, true); offset += 4;

      const tailPart = line.substring(spaceAfterQw + 1).trim();
      if (tailPart.startsWith('h:')) {
        const hexStr = tailPart.substring(2);
        for (let i = 0; i < 64; i++) {
          const hi = HEX_VAL[hexStr.charCodeAt(i * 2)] || 0;
          const lo = HEX_VAL[hexStr.charCodeAt(i * 2 + 1)] || 0;
          vview.setUint8(offset + i, (hi << 4) | lo);
        }
      } else if (tailPart.length > 0) {
        const nums = tailPart.split(/\s+/);
        for (let i = 0; i < 64; i++) {
          vview.setUint8(offset + i, i < nums.length ? (parseInt(nums[i], 10) || 0) : 20);
        }
      } else {
        for (let i = 0; i < 64; i++) vview.setUint8(offset + i, 20);
      }
      offset += 64;
    } else {
      const parts = line.split(/\s+/);
      if (parts.length < 10) continue;
      boneName = parts[1]; frameNum = parseInt(parts[2], 10);
      px = parseFloat(parts[3]); py = parseFloat(parts[4]); pz = parseFloat(parts[5]);
      qx = parseFloat(parts[6]); qy = parseFloat(parts[7]); qz = parseFloat(parts[8]); qw = parseFloat(parts[9]);

      const [lpx, lpy, lpz] = rightToLeftPos(px, py, pz);
      const [lqx, lqy, lqz, lqw] = rightToLeftQuat(qx, qy, qz, qw);

      encodeShiftJISInto(boneName, vview, offset, BONE_NAME_LEN);
      offset += BONE_NAME_LEN;
      vview.setUint32(offset, frameNum, true); offset += 4;
      vview.setFloat32(offset, lpx, true); offset += 4;
      vview.setFloat32(offset, lpy, true); offset += 4;
      vview.setFloat32(offset, lpz, true); offset += 4;
      vview.setFloat32(offset, lqx, true); offset += 4;
      vview.setFloat32(offset, lqy, true); offset += 4;
      vview.setFloat32(offset, lqz, true); offset += 4;
      vview.setFloat32(offset, lqw, true); offset += 4;
      for (let i = 0; i < 64; i++) vview.setUint8(offset + i, 20);
      offset += 64;
    }

    boneIdx++;
    if (boneIdx % BATCH === 0) {
      if (onProgress) onProgress('bone', boneIdx, maxBoneFrames);
      await yieldToMain();
    }
  }

  // 回写实际骨骼帧数
  vview.setUint32(boneCountOffset, boneIdx, true);

  if (onProgress) onProgress('bone', boneIdx, boneIdx);

  // 形变帧数占位
  const morphCountOffset = offset;
  offset += 4;

  // 第三遍：写入所有形变帧
  let morphIdx = 0;
  for (let li = 0; li < totalLines; li++) {
    const line = lines[li];
    if (!line.startsWith('m ')) continue;

    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;

    encodeShiftJISInto(parts[1], vview, offset, MORPH_NAME_LEN);
    offset += MORPH_NAME_LEN;
    vview.setUint32(offset, parseInt(parts[2], 10), true);
    offset += 4;
    vview.setFloat32(offset, parseFloat(parts[3]), true);
    offset += 4;
    morphIdx++;

    if (morphIdx % BATCH === 0) {
      if (onProgress) onProgress('morph', morphIdx, maxMorphFrames);
      await yieldToMain();
    }
  }

  // 回写实际形变帧数
  vview.setUint32(morphCountOffset, morphIdx, true);

  if (onProgress) onProgress('morph', morphIdx, morphIdx);

  // VMD 格式在 morph 之后还有 cameras 和 lights 部分，必须写入 count=0
  // 否则 MMDParser 会读取越界（RangeError: Offset is outside the bounds of the DataView）
  vview.setUint32(offset, 0, true);  // cameraCount = 0
  offset += 4;
  vview.setUint32(offset, 0, true);  // lightCount = 0
  offset += 4;

  // 截断到实际大小
  return new Uint8Array(buffer, 0, offset);
}

function nthSpaceIndex(str, n) {
  let count = 0;
  for (let i = 2; i < str.length; i++) {
    if (str[i] === ' ') {
      count++;
      if (count === n) return i;
    }
  }
  return -1;
}

// ═══════════════════════════════════════════════════════════
//  模糊骨骼匹配
//  策略：精确匹配 → 别名映射 → 去尾数字 → 去C后缀 → 包含匹配
// ═══════════════════════════════════════════════════════════

// 常见骨骼名别名表（VMD中的名 → 模型中可能的名）
const BONE_ALIASES = {
  // 中心
  'センター': ['center', 'Center', '全ての親', '全ての親0', 'Root', 'root'],
  'センターC': ['centerC', 'CenterC', 'センター2'],
  'グルーブ': ['groove', 'Groove', 'Guroove'],
  // 上半身
  '上半身': ['upperBody', 'UpperBody', '上半身1', 'chest', 'Chest', '胸'],
  '上半身2': ['upperBody2', 'UpperBody2', '上半身3', 'chest2', 'Chest2', '上半身D'],
  '上半身3': ['upperBody3', 'UpperBody3', '上半身4', 'chest3', 'Chest3'],
  // 下半身
  '下半身': ['lowerBody', 'LowerBody', 'waist', 'Waist', '腰', 'pelvis', 'Pelvis', 'hips', 'Hips'],
  '下半身2': ['lowerBody2', 'LowerBody2', 'waist2', 'Waist2', '下半身D'],
  // 首
  '首': ['neck', 'Neck', 'ネック'],
  '首D': ['neckD', 'NeckD', '首2'],
  // 頭
  '頭': ['head', 'Head', 'ヘッド'],
  '頭D': ['headD', 'HeadD', '頭2'],
  // 肩
  '右肩': ['rightShoulder', 'RightShoulder', '肩R', 'shoulder_R', 'R肩', 'shoulder.R'],
  '左肩': ['leftShoulder', 'LeftShoulder', '肩L', 'shoulder_L', 'L肩', 'shoulder.L'],
  '右肩C': ['rightShoulderC', 'RightShoulderC', '右肩P', 'shoulderC_R', '右肩2'],
  '左肩C': ['leftShoulderC', 'LeftShoulderC', '左肩P', 'shoulderC_L', '左肩2'],
  // 腕（大臂）
  '右腕': ['rightArm', 'RightArm', '腕R', 'arm_R', 'R腕', 'arm.R', 'upperArm_R', '右大臂'],
  '左腕': ['leftArm', 'LeftArm', '腕L', 'arm_L', 'L腕', 'arm.L', 'upperArm_L', '左大臂'],
  '右腕C': ['rightArmC', 'RightArmC', '右腕2', '右腕P', 'armC_R'],
  '左腕C': ['leftArmC', 'LeftArmC', '左腕2', '左腕P', 'armC_L'],
  // ひじ（肘/小臂）
  '右ひじ': ['rightElbow', 'RightElbow', 'ひじR', 'elbow_R', 'Rひじ', '右肘', 'elbow.R', 'forearm_R', '右小臂'],
  '左ひじ': ['leftElbow', 'LeftElbow', 'ひじL', 'elbow_L', 'Lひじ', '左肘', 'elbow.L', 'forearm_L', '左小臂'],
  '右ひじC': ['rightElbowC', 'RightElbowC', '右ひじ2', '右肘C', 'elbowC_R'],
  '左ひじC': ['leftElbowC', 'LeftElbowC', '左ひじ2', '左肘C', 'elbowC_L'],
  // 手首
  '右手首': ['rightWrist', 'RightWrist', '手首R', 'wrist_R', 'R手首', 'wrist.R', 'hand_R', '右手'],
  '左手首': ['leftWrist', 'LeftWrist', '手首L', 'wrist_L', 'L手首', 'wrist.L', 'hand_L', '左手'],
  '右手首C': ['rightWristC', 'RightWristC', '右手首2', 'wristC_R'],
  '左手首C': ['leftWristC', 'LeftWristC', '左手首2', 'wristC_L'],
  // 指（右手）
  '右親指０': ['rightThumb0', 'RightThumb0', 'thumb0_R', '親指０R'],
  '右親指１': ['rightThumb1', 'RightThumb1', 'thumb1_R', '親指１R'],
  '右親指２': ['rightThumb2', 'RightThumb2', 'thumb2_R', '親指２R'],
  '右人指１': ['rightIndex1', 'RightIndex1', 'index1_R', '人指１R'],
  '右人指２': ['rightIndex2', 'RightIndex2', 'index2_R', '人指２R'],
  '右人指３': ['rightIndex3', 'RightIndex3', 'index3_R', '人指３R'],
  '右中指１': ['rightMiddle1', 'RightMiddle1', 'middle1_R', '中指１R'],
  '右中指２': ['rightMiddle2', 'RightMiddle2', 'middle2_R', '中指２R'],
  '右中指３': ['rightMiddle3', 'RightMiddle3', 'middle3_R', '中指３R'],
  '右薬指１': ['rightRing1', 'RightRing1', 'ring1_R', '薬指１R'],
  '右薬指２': ['rightRing2', 'RightRing2', 'ring2_R', '薬指２R'],
  '右薬指３': ['rightRing3', 'RightRing3', 'ring3_R', '薬指３R'],
  '右小指１': ['rightPinky1', 'RightPinky1', 'pinky1_R', '小指１R'],
  '右小指２': ['rightPinky2', 'RightPinky2', 'pinky2_R', '小指２R'],
  '右小指３': ['rightPinky3', 'RightPinky3', 'pinky3_R', '小指３R'],
  // 指（左手）
  '左親指０': ['leftThumb0', 'LeftThumb0', 'thumb0_L', '親指０L'],
  '左親指１': ['leftThumb1', 'LeftThumb1', 'thumb1_L', '親指１L'],
  '左親指２': ['leftThumb2', 'LeftThumb2', 'thumb2_L', '親指２L'],
  '左人指１': ['leftIndex1', 'LeftIndex1', 'index1_L', '人指１L'],
  '左人指２': ['leftIndex2', 'LeftIndex2', 'index2_L', '人指２L'],
  '左人指３': ['leftIndex3', 'LeftIndex3', 'index3_L', '人指３L'],
  '左中指１': ['leftMiddle1', 'LeftMiddle1', 'middle1_L', '中指１L'],
  '左中指２': ['leftMiddle2', 'LeftMiddle2', 'middle2_L', '中指２L'],
  '左中指３': ['leftMiddle3', 'LeftMiddle3', 'middle3_L', '中指３L'],
  '左薬指１': ['leftRing1', 'LeftRing1', 'ring1_L', '薬指１L'],
  '左薬指２': ['leftRing2', 'LeftRing2', 'ring2_L', '薬指２L'],
  '左薬指３': ['leftRing3', 'LeftRing3', 'ring3_L', '薬指３L'],
  '左小指１': ['leftPinky1', 'LeftPinky1', 'pinky1_L', '小指１L'],
  '左小指２': ['leftPinky2', 'LeftPinky2', 'pinky2_L', '小指２L'],
  '左小指３': ['leftPinky3', 'LeftPinky3', 'pinky3_L', '小指３L'],
  // 足（大腿）
  '右足': ['rightLeg', 'RightLeg', '足R', 'leg_R', 'R足', '右脚', 'thigh_R', '右大腿', 'upperLeg_R', 'rightThigh'],
  '左足': ['leftLeg', 'LeftLeg', '足L', 'leg_L', 'L足', '左脚', 'thigh_L', '左大腿', 'upperLeg_L', 'leftThigh'],
  '右足2': ['rightLeg2', 'RightLeg2', '右足D', '右脚2', 'leg2_R'],
  '左足2': ['leftLeg2', 'LeftLeg2', '左足D', '左脚2', 'leg2_L'],
  // ひざ（膝盖/小腿）
  '右ひざ': ['rightKnee', 'RightKnee', 'ひざR', 'knee_R', 'Rひざ', '右膝', 'knee.R', 'calf_R', '右小腿', 'lowerLeg_R', 'rightCalf'],
  '左ひざ': ['leftKnee', 'LeftKnee', 'ひざL', 'knee_L', 'Lひざ', '左膝', 'knee.L', 'calf_L', '左小腿', 'lowerLeg_L', 'leftCalf'],
  '右ひざ2': ['rightKnee2', 'RightKnee2', '右ひざD', '右膝2', 'knee2_R'],
  '左ひざ2': ['leftKnee2', 'LeftKnee2', '左ひざD', '左膝2', 'knee2_L'],
  // 足首（脚踝）
  '右足首': ['rightAnkle', 'RightAnkle', '足首R', 'ankle_R', 'R足首', 'ankle.R', '右踝', 'foot_R', '右脚踝'],
  '左足首': ['leftAnkle', 'LeftAnkle', '足首L', 'ankle_L', 'L足首', 'ankle.L', '左踝', 'foot_L', '左脚踝'],
  '右足首2': ['rightAnkle2', 'RightAnkle2', '右足首D', 'ankle2_R'],
  '左足首2': ['leftAnkle2', 'LeftAnkle2', '左足首D', 'ankle2_L'],
  // つま先（脚趾）
  '右つま先': ['rightToe', 'RightToe', 'つま先R', 'toe_R', 'Rつま先', 'toe.R', '右趾', 'toeTip_R'],
  '左つま先': ['leftToe', 'LeftToe', 'つま先L', 'toe_L', 'Lつま先', 'toe.L', '左趾', 'toeTip_L'],
  '右つま先２': ['rightToe2', 'RightToe2', '右つま先D', 'toe2_R'],
  '左つま先２': ['leftToe2', 'LeftToe2', '左つま先D', 'toe2_L'],
  // 目
  '両目': ['bothEyes', 'BothEyes', 'eyes', 'Eyes'],
  '右目': ['rightEye', 'RightEye', '目R', 'eye_R', 'R目', 'eye.R'],
  '左目': ['leftEye', 'LeftEye', '目L', 'eye_L', 'L目', 'eye.L'],
  // グリップ
  '右グリップ': ['rightGrip', 'RightGrip', 'グリップR', 'grip_R'],
  '左グリップ': ['leftGrip', 'LeftGrip', 'グリップL', 'grip_L'],
};

// 反向别名表（别名 → 标准名），运行时构建
let _reverseAliasMap = null;

function getReverseAliasMap() {
  if (_reverseAliasMap) return _reverseAliasMap;
  _reverseAliasMap = new Map();
  for (const [standard, aliases] of Object.entries(BONE_ALIASES)) {
    for (const alias of aliases) {
      if (!_reverseAliasMap.has(alias)) _reverseAliasMap.set(alias, standard);
    }
  }
  return _reverseAliasMap;
}

/**
 * 模糊匹配骨骼名
 * @param {string} vmdBoneName - VMD 中的骨名
 * @param {Object} boneMap - { boneName: boneIdx } 映射
 * @returns {number|undefined} 骨骼索引，未找到返回 undefined
 */
function findBoneFuzzy(vmdBoneName, boneMap) {
  // 1. 精确匹配
  if (boneMap[vmdBoneName] !== undefined) return boneMap[vmdBoneName];

  // 2. 别名匹配：VMD骨名 → 标准名 → 模型中的名
  const aliases = BONE_ALIASES[vmdBoneName];
  if (aliases) {
    for (const alias of aliases) {
      if (boneMap[alias] !== undefined) return boneMap[alias];
    }
  }

  // 3. 反向别名匹配：VMD骨名可能是别名，查找对应的标准名
  const reverseMap = getReverseAliasMap();
  const standardName = reverseMap.get(vmdBoneName);
  if (standardName && boneMap[standardName] !== undefined) return boneMap[standardName];

  // 4. 去尾数字：右足2 → 右足, 左腕C → 左腕
  const stripped = vmdBoneName.replace(/[0-9C]$/, '');
  if (stripped !== vmdBoneName && boneMap[stripped] !== undefined) return boneMap[stripped];

  // 5. 去尾数字+再查别名
  if (stripped !== vmdBoneName) {
    const strippedAliases = BONE_ALIASES[stripped];
    if (strippedAliases) {
      for (const alias of strippedAliases) {
        if (boneMap[alias] !== undefined) return boneMap[alias];
      }
    }
  }

  // 6. R/L 替换：右肩 → shoulder_R 等
  const rlMap = { '右': '_R', '左': '_L', 'R': '_R', 'L': '_L' };
  for (const [jp, en] of Object.entries(rlMap)) {
    if (vmdBoneName.startsWith(jp)) {
      const candidate = vmdBoneName.substring(jp.length) + en;
      if (boneMap[candidate] !== undefined) return boneMap[candidate];
    }
  }

  return undefined;
}

// ═══════════════════════════════════════════════════════════
//  Text → Pure-JS 直接播放
//  文本中已是右手坐标系，可直接用于 Three.js 骨骼
// ═══════════════════════════════════════════════════════════

export function createDirectAnimationClip(text, skeleton) {
  const bones = skeleton.bones;
  const boneMap = {};
  for (let i = 0; i < bones.length; i++) boneMap[bones[i].name] = i;

  const tracksPerBone = {};
  const morphTracksPerName = {};
  let mapped = 0, missed = 0;
  const missedBones = new Set();
  const fuzzyMatched = new Map(); // 缓存模糊匹配结果

  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (!line.startsWith('b ') && !line.startsWith('m ')) continue;

    if (line.startsWith('b ')) {
      const parts = fastSplit(line, 10);
      if (parts.length < 10) continue;

      const boneName = parts[1];

      // 使用模糊匹配
      let boneIdx = fuzzyMatched.get(boneName);
      if (boneIdx === undefined) {
        boneIdx = findBoneFuzzy(boneName, boneMap);
        fuzzyMatched.set(boneName, boneIdx !== undefined ? boneIdx : -1);
      } else if (boneIdx === -1) {
        boneIdx = undefined;
      }

      if (boneIdx === undefined) { missed++; missedBones.add(boneName); continue; }

      mapped++;
      if (!tracksPerBone[boneIdx]) tracksPerBone[boneIdx] = [];
      const frameNum = parseInt(parts[2], 10);
      tracksPerBone[boneIdx].push({
        frameNum,
        time: frameNum / 30,
        pos: new THREE.Vector3(parseFloat(parts[3]), parseFloat(parts[4]), parseFloat(parts[5])),
        quat: new THREE.Quaternion(parseFloat(parts[6]), parseFloat(parts[7]), parseFloat(parts[8]), parseFloat(parts[9])),
      });
    } else {
      const parts = line.split(/\s+/);
      if (parts.length < 4) continue;
      if (!morphTracksPerName[parts[1]]) morphTracksPerName[parts[1]] = [];
      morphTracksPerName[parts[1]].push({ frameNum: parseInt(parts[2], 10), time: parseInt(parts[2], 10) / 30, weight: parseFloat(parts[3]) });
    }
  }

  const tracks = [];
  for (const [idx, kfs] of Object.entries(tracksPerBone)) {
    kfs.sort((a, b) => a.frameNum - b.frameNum);
    tracks.push({ boneIdx: parseInt(idx), keyframes: kfs.map(kf => ({ time: kf.time, pos: kf.pos.clone(), quat: kf.quat.clone() })) });
  }

  const morphTracks = [];
  for (const [name, kfs] of Object.entries(morphTracksPerName)) {
    kfs.sort((a, b) => a.frameNum - b.frameNum);
    morphTracks.push({ morphName: name, keyframes: kfs.map(kf => ({ time: kf.time, weight: kf.weight })) });
  }

  if (tracks.length === 0) throw new Error(`没有可播放的骨骼轨道（${missed} 帧未匹配）`);

  const totalTime = tracks.reduce((max, t) => {
    const last = t.keyframes[t.keyframes.length - 1];
    return last ? Math.max(max, last.time) : max;
  }, 0);

  console.log(`[VMD] 直接播放: ${tracks.length}骨骼轨道, ${morphTracks.length}表情轨道, ${mapped}帧已匹配, ${missed}帧未匹配`);
  if (missedBones.size > 0) console.log(`[VMD] 未找到的骨骼: ${[...missedBones].slice(0, 10).join(', ')}${missedBones.size > 10 ? '...' : ''}`);

  return { name: 'vmd_direct', duration: totalTime + 0.5, tracks, morphTracks };
}

function fastSplit(str, maxParts) {
  const parts = [];
  let start = 0;
  for (let i = 0; i < str.length && parts.length < maxParts; i++) {
    if (str[i] === ' ') {
      if (i > start) parts.push(str.substring(start, i));
      start = i + 1;
    }
  }
  if (start < str.length && parts.length < maxParts) parts.push(str.substring(start));
  return parts;
}

// ═══════════════════════════════════════════════════════════
//  下载 VMD 文件
// ═══════════════════════════════════════════════════════════

export function downloadVMD(vmdData, fileName) {
  const blob = new Blob([vmdData], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  URL.revokeObjectURL(url);
}
