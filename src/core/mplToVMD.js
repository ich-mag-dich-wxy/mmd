// mplToVMD.js — MPL 动画转 VMD 格式
// VMD 文件格式说明：
// - 魔法: "Vocaloid Motion Data 0002" (30字节)
// - 模型名: 20字节 (Shift-JIS)
// - 骨骼动画数量: 4字节 (小端)
// - 骨骼动画帧: 每帧 111 字节
//   - 骨骼名: 15字节 (Shift-JIS，不足补0)
//   - 帧号: 4字节 (小端)
//   - 位置: 12字节 (3个float，小端)
//   - 旋转: 16字节 (4个float，小端)
//   - 插值曲线: 64字节 (4轴 × 4控制点 × 4字节)
// - 表情动画数量: 4字节 (小端)

const VMD_MAGIC = 'Vocaloid Motion Data 0002';
const BONE_NAME_SIZE = 15;
const BONE_FRAME_SIZE = 15 + 4 + 12 + 16 + 64; // 111
const HEADER_SIZE = 30 + 20;

// 标准线性插值曲线参数
const LINEAR_BEZIER = [20, 20, 20, 107, 20, 20, 20, 107, 20, 20, 20, 107, 107, 20, 107, 20];

/**
 * 转换字符串到 Shift-JIS 字节（简化版，只处理ASCII和基本日文）
 */
function stringToShiftJIS(str) {
  const bytes = [];
  for (let i = 0; i < str.length; i++) {
    const charCode = str.charCodeAt(i);
    
    // ASCII 直接输出
    if (charCode < 128) {
      bytes.push(charCode);
    } else {
      // 简化处理：非ASCII字符替换为空格或跳过
      // 完整实现需要 Shift-JIS 编码表，这里简化处理
      const replacements = {
        '頭': 0xA4, '首': 0xB9, '足': 0xD4, '膝': 0xC0, '腕': 0xBB,
        '上': 0xA4, '下': 0xB0, '左': 0xB6, '右': 0xA2, '腰': 0xBB,
        '肩': 0xAE, '肘': 0xD1, '手': 0xC4, '指': 0xC6, '目': 0xC7,
        '口': 0xBD, '鼻': 0xD0, '耳': 0xA4, '舌': 0xBF, '歩': 0xA0,
        'Ｌ': 0x82, 'Ｒ': 0x83, 'ｌ': 0x91, 'ｒ': 0x92,
      };
      bytes.push(replacements[str[i]] || 0x20); // 空格
    }
  }
  return bytes;
}

/**
 * 创建 VMD Uint8Array
 */
export function animationClipToVMD(tracks, skeleton, fps = 30) {
  const boneFrames = [];
  
  for (const track of tracks) {
    const boneIdx = track.boneIdx;
    const bone = skeleton.bones[boneIdx];
    if (!bone) continue;
    
    const boneName = bone.name;
    
    for (const kf of track.keyframes) {
      const frame = Math.round(kf.time * fps);
      boneFrames.push({
        boneName,
        frame,
        position: [0, 0, 0],
        rotation: [kf.quat.x, kf.quat.y, kf.quat.z, kf.quat.w],
      });
    }
  }
  
  // 排序
  boneFrames.sort((a, b) => {
    if (a.boneName !== b.boneName) return a.boneName.localeCompare(b.boneName);
    return a.frame - b.frame;
  });
  
  // 计算文件大小
  const dataSize = HEADER_SIZE + 4 + boneFrames.length * BONE_FRAME_SIZE + 4;
  const buffer = new ArrayBuffer(dataSize);
  const view = new DataView(buffer);
  
  // 写入魔法
  for (let i = 0; i < VMD_MAGIC.length; i++) {
    view.setUint8(i, VMD_MAGIC.charCodeAt(i));
  }
  
  // 模型名（20字节，空）
  for (let i = 0; i < 20; i++) {
    view.setUint8(30 + i, 0);
  }
  
  // 骨骼动画数量
  view.setUint32(HEADER_SIZE, boneFrames.length, true);
  
  // 写入骨骼帧
  let offset = HEADER_SIZE + 4;
  
  for (const bf of boneFrames) {
    // 骨骼名（15字节）
    const nameBytes = stringToShiftJIS(bf.boneName);
    for (let i = 0; i < BONE_NAME_SIZE; i++) {
      view.setUint8(offset + i, nameBytes[i] || 0);
    }
    offset += BONE_NAME_SIZE;
    
    // 帧号
    view.setUint32(offset, bf.frame, true);
    offset += 4;
    
    // 位置
    view.setFloat32(offset, bf.position[0], true); offset += 4;
    view.setFloat32(offset, bf.position[1], true); offset += 4;
    view.setFloat32(offset, bf.position[2], true); offset += 4;
    
    // 旋转四元数
    view.setFloat32(offset, bf.rotation[0], true); offset += 4;
    view.setFloat32(offset, bf.rotation[1], true); offset += 4;
    view.setFloat32(offset, bf.rotation[2], true); offset += 4;
    view.setFloat32(offset, bf.rotation[3], true); offset += 4;
    
    // 插值曲线（64字节）
    for (let i = 0; i < 64; i++) {
      view.setUint8(offset + i, LINEAR_BEZIER[i % 16]);
    }
    offset += 64;
  }
  
  // 表情数量（0）
  view.setUint32(offset, 0, true);
  
  console.log(`[VMD] 生成: ${boneFrames.length} 帧, ${dataSize} 字节`);
  return new Uint8Array(buffer);
}

/**
 * 简化版本：直接创建 AnimationClip 给 MMDHelper 使用
 */
export function createMMDAnimation(clip, skeleton) {
  // 直接返回简化格式，让 MMDHelper 处理
  const tracks = [];
  
  for (const track of clip.tracks) {
    const boneIdx = track.boneIdx;
    const bone = skeleton.bones[boneIdx];
    if (!bone) continue;
    
    const keyframes = [];
    for (const kf of track.keyframes) {
      keyframes.push({
        time: kf.time,
        position: new THREE.Vector3(0, 0, 0),
        rotation: kf.quat.clone(),
      });
    }
    
    tracks.push({
      name: bone.name,
      keyframes,
    });
  }
  
  return { tracks, duration: clip.duration };
}
