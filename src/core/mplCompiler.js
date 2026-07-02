// ═══════════════════════════════════════════════════════════
//  MPL WASM 编译器封装
//  使用 mmd-mpl npm 包，将 MPL 脚本编译为 VMD 二进制（WASM，极快）
//  同时支持 VMD/VPD 反编译为 MPL 文本
//
//  本文件包含两个关键增强：
//  1. customVMDToMPL: 自定义 VMD→MPL 转换器，绕过 WASM 的有损 Nelder-Mead 优化，
//     直接用轴角分解，保留浮点精度，不丢弃任何骨骼
//  2. patchVMDBezier: 修复 WASM 编译输出的损坏 bezier 曲线，
//     将瞬间跳跃的插值替换为平滑的线性曲线
// ═══════════════════════════════════════════════════════════

let _compiler = null;
let _initPromise = null;
let _boneAxes = null;       // 骨骼旋转轴缓存
let _boneNameMap = null;    // 日文→英文骨骼名映射缓存
let _reverseBoneNameMap = null; // 英文→日文骨骼名映射缓存
let _lastOrigQuats = null;  // 最近一次反编译的原始四元数缓存: Map("boneJp_frameNum" → [qx,qy,qz,qw])
let _lastMplText = null;    // 最近一次生成的 MPL 文本（用于检测用户是否编辑过）
let _lastLostBoneFrames = null; // 最近一次反编译中无 MPL 映射的骨骼帧完整数据: Array<Uint8Array(111)>
                                // 用于编译后追加回 VMD（保留 IK 骨骼等位置驱动数据）

const VMD_MAGIC_LEN = 30;
const VMD_MODEL_NAME_LEN = 20;
const VMD_HEADER_SIZE = VMD_MAGIC_LEN + VMD_MODEL_NAME_LEN;
const VMD_BONE_NAME_LEN = 15;
const VMD_BONE_FRAME_SIZE = 111; // 15+4+12+16+64

/**
 * 初始化 MPL WASM 编译器（懒加载，只执行一次）
 */
export async function getMPLCompiler() {
  if (_compiler) return _compiler;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const mpl = await import('mmd-mpl');
    await mpl.default();
    _compiler = new mpl.WasmMPLCompiler();
    console.log('[MPL] WASM 编译器已就绪');
    return _compiler;
  })();

  return _initPromise;
}

/**
 * 检测文本是否为 MPL 格式
 */
export function isMPLScript(text) {
  const head = text.slice(0, 2000);
  return /@pose\s+\w+\s*\{/.test(head) ||
         /@animation\s+\w+\s*\{/.test(head) ||
         /^main\s*\{/m.test(head);
}

// ═══════════════════════════════════════════════════════════
//  Shift-JIS 解码（用于 VMD 骨骼名）
// ═══════════════════════════════════════════════════════════

let _sjisDecoder = null;
try { _sjisDecoder = new TextDecoder('shift-jis'); } catch (e) {}

function decodeShiftJIS(uint8, offset, len) {
  let actualLen = 0;
  while (actualLen < len && uint8[offset + actualLen] !== 0) actualLen++;
  if (actualLen === 0) return '';
  if (_sjisDecoder) {
    const view = new Uint8Array(uint8.buffer, uint8.byteOffset + offset, actualLen);
    return _sjisDecoder.decode(view).trim();
  }
  let s = '';
  for (let i = 0; i < actualLen; i++) s += String.fromCharCode(uint8[offset + i]);
  return s.trim();
}

// ═══════════════════════════════════════════════════════════
//  骨骼名映射（日文 VMD 名 → MPL 英文名）
//  从 WASM 骨骼数据库获取，缓存后复用
// ═══════════════════════════════════════════════════════════

async function ensureBoneData() {
  if (_boneAxes && _boneNameMap) return;
  const compiler = await getMPLCompiler();

  // 获取所有骨骼名
  const allBones = compiler.get_all_bones();
  _boneNameMap = {};
  _boneAxes = {};

  for (const bone of allBones) {
    // 日文→英文映射
    const jp = compiler.get_bone_japanese_name(bone);
    if (jp) _boneNameMap[jp] = bone;

    // 提取每个 (action, direction) 的旋转轴
    const actions = compiler.get_bone_actions(bone);
    if (!actions) continue;
    _boneAxes[bone] = {};
    for (const action of actions) {
      if (action === 'move') continue;
      const directions = compiler.get_bone_directions(bone, action);
      if (!directions) continue;
      _boneAxes[bone][action] = {};
      for (const dir of directions) {
        const limit = compiler.get_bone_degree_limit(bone, action, dir);
        // 编译 1° 测试姿势，提取四元数，反推旋转轴
        const script = `@pose tp {\n ${bone} ${action} ${dir} 1;\n}\n@animation ta {\n 0.0: tp;\n}\nmain {\n ta;\n}`;
        try {
          const bytes = compiler.compile(script);
          if (bytes && bytes.length > 54) {
            const view = new DataView(bytes.buffer);
            const count = view.getUint32(50, true);
            if (count > 0) {
              const off = 54 + 15 + 4 + 12; // 跳过 boneName + frame + pos
              const qx = view.getFloat32(off, true);
              const qy = view.getFloat32(off + 4, true);
              const qz = view.getFloat32(off + 8, true);
              const qw = view.getFloat32(off + 12, true);
              // q = (sin(0.5°)*axis, cos(0.5°))
              const sinHalf = Math.sin(0.5 * Math.PI / 180);
              let ax = qx / sinHalf;
              let ay = qy / sinHalf;
              let az = qz / sinHalf;
              const len = Math.sqrt(ax * ax + ay * ay + az * az);
              if (len > 0) { ax /= len; ay /= len; az /= len; }
              _boneAxes[bone][action][dir] = { axis: [ax, ay, az], limit };
            }
          }
        } catch (e) { /* skip */ }
      }
    }
  }
  // 构建反向映射：英文→日文
  _reverseBoneNameMap = {};
  for (const [jp, en] of Object.entries(_boneNameMap)) {
    _reverseBoneNameMap[en] = jp;
  }
  console.log(`[MPL] 骨骼数据: ${Object.keys(_boneNameMap).length} 日文名, ${Object.keys(_boneAxes).length} 骨骼轴`);
}

// ═══════════════════════════════════════════════════════════
//  四元数 → 轴角
// ═══════════════════════════════════════════════════════════

function quatToAxisAngle(qx, qy, qz, qw) {
  // 归一化
  const len = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
  if (len === 0) return { axis: [0, 0, 1], angle: 0 };
  qx /= len; qy /= len; qz /= len; qw /= len;

  // qw 可能略超 [-1, 1]
  const w = Math.max(-1, Math.min(1, qw));
  const angle = 2 * Math.acos(w);
  const s = Math.sqrt(1 - w * w);
  if (s < 0.0001) {
    // 接近 0° 或 180°，轴不重要
    return { axis: [qx || 0, qy || 0, qz || 1], angle };
  }
  return { axis: [qx / s, qy / s, qz / s], angle };
}

// ═══════════════════════════════════════════════════════════
//  自定义 VMD → MPL 转换器
//  绕过 WASM 的 Nelder-Mead 优化（有损），直接用轴角分解
//  保留 1 位小数精度，不丢弃任何骨骼
// ═══════════════════════════════════════════════════════════

export async function customVMDToMPL(vmdBytes, onProgress) {
  await ensureBoneData();

  const uint8 = new Uint8Array(vmdBytes.buffer || vmdBytes);
  const view = new DataView(vmdBytes.buffer || vmdBytes);

  if (uint8.byteLength < VMD_HEADER_SIZE) throw new Error('VMD 文件不完整');

  // 初始化原始四元数缓存（用于编译时恢复精确旋转）
  _lastOrigQuats = new Map();
  // 初始化无 MPL 映射的骨骼帧缓存（用于编译后追加回 VMD，保留 IK 等位置驱动数据）
  _lastLostBoneFrames = [];

  // 解析骨骼帧
  let offset = VMD_HEADER_SIZE;
  const boneFrameCount = view.getUint32(offset, true);
  offset += 4;

  // 按帧分组：frameNum → [{ bone, qx, qy, qz, qw }]
  const framesByKey = new Map();
  let lostBoneCount = 0;

  const BATCH = 4000;
  for (let i = 0; i < boneFrameCount; i++) {
    if (offset + VMD_BONE_FRAME_SIZE > uint8.byteLength) break;

    const boneNameJp = decodeShiftJIS(uint8, offset, VMD_BONE_NAME_LEN);

    // 在修改 offset 之前，先保存这一帧的完整 111 字节原始数据
    // （对于无 MPL 映射的骨骼，编译后需要追加回 VMD）
    const frameStartOffset = offset;
    const frameNum = view.getUint32(offset + VMD_BONE_NAME_LEN, true);

    offset += VMD_BONE_NAME_LEN;
    offset += 4;
    offset += 12; // 跳过位置
    const qx = view.getFloat32(offset, true);
    const qy = view.getFloat32(offset + 4, true);
    const qz = view.getFloat32(offset + 8, true);
    const qw = view.getFloat32(offset + 12, true);
    offset += 16;
    offset += 64; // 跳过 bezier

    // 日文骨名 → 英文
    const boneNameEn = _boneNameMap[boneNameJp];
    if (!boneNameEn) {
      // 无 MPL 映射的骨骼（如 IK 骨骼、つま先、裙摆等）：保存完整帧数据
      // 关键：IK 骨骼（左足ＩＫ/右足ＩＫ等）包含位置数据，驱动 IK 求解器
      // 如果不保留，编译后 VMD 会丢失所有 IK 目标位置，导致腿部动作完全消失
      const frameBytes = new Uint8Array(VMD_BONE_FRAME_SIZE);
      frameBytes.set(uint8.subarray(frameStartOffset, frameStartOffset + VMD_BONE_FRAME_SIZE));
      _lastLostBoneFrames.push(frameBytes);
      lostBoneCount++;
      continue;
    }

    // 保存原始四元数（用于编译时恢复精确旋转，避免轴投影损失）
    _lastOrigQuats.set(`${boneNameJp}_${frameNum}`, [qx, qy, qz, qw]);

    if (!framesByKey.has(frameNum)) framesByKey.set(frameNum, []);
    framesByKey.get(frameNum).push({ bone: boneNameEn, qx, qy, qz, qw });

    if ((i + 1) % BATCH === 0) {
      if (onProgress) onProgress('bone', i + 1, boneFrameCount);
      await new Promise(r => setTimeout(r, 0));
    }
  }
  if (onProgress) onProgress('bone', boneFrameCount, boneFrameCount);
  console.log(`[MPL] customVMDToMPL: ${lostBoneCount} 帧无 MPL 映射（IK/未支持骨骼），已缓存待编译后追加`);

  // 解析表情帧
  let morphFrames = [];
  if (offset + 4 <= uint8.byteLength) {
    const morphFrameCount = view.getUint32(offset, true);
    offset += 4;
    for (let i = 0; i < morphFrameCount; i++) {
      if (offset + 23 > uint8.byteLength) break;
      const morphName = decodeShiftJIS(uint8, offset, 15);
      offset += 15;
      const frameNum = view.getUint32(offset, true);
      offset += 4;
      const weight = view.getFloat32(offset, true);
      offset += 4;
      morphFrames.push({ name: morphName, frame: frameNum, weight });
    }
  }

  // 将帧转换为 MPL pose 语句
  const sortedFrames = [...framesByKey.keys()].sort((a, b) => a - b);
  const poseMap = new Map(); // 语句内容 → pose 名
  const animStatements = [];
  let poseCounter = 0;

  // ── 诊断计数 ──
  let diagTotal = 0, diagReset = 0, diagFallbackBest = 0;

  for (const frameNum of sortedFrames) {
    const bones = framesByKey.get(frameNum);
    const statements = [];

    for (const { bone, qx, qy, qz, qw } of bones) {
      const rules = _boneAxes[bone];
      if (!rules) continue;
      diagTotal++;

      // 四元数归一化
      const qlen = Math.sqrt(qx * qx + qy * qy + qz * qz + qw * qw);
      if (qlen === 0) {
        statements.push(`${bone} reset;`);
        diagReset++;
        continue;
      }
      const nqx = qx / qlen, nqy = qy / qlen, nqz = qz / qlen, nqw = qw / qlen;

      // ── 轴角分解 ──
      const { axis, angle } = quatToAxisAngle(nqx, nqy, nqz, nqw);
      const angleDeg = angle * 180 / Math.PI;

      // 真正接近 0°（< 0.05°）才 reset
      if (angleDeg < 0.05) {
        statements.push(`${bone} reset;`);
        diagReset++;
        continue;
      }

      const sinHalf = Math.sqrt(nqx * nqx + nqy * nqy + nqz * nqz); // = |sin(angle/2)|
      const cosHalf = Math.max(-1, Math.min(1, nqw));

      // ── 单轴骨骼特殊处理 ──
      // 对于只有一个 action 且该 action 只有一个 direction 的骨骼（如 knee_l/r），
      // MPL 数据库只能表示单轴旋转，无法表达原 VMD 的侧向分量（Y/Z）。
      // 此时用总角度（angleDeg）而非投影角度，保留完整旋转幅度。
      // 虽然轴方向有偏差，但膝盖弯曲的视觉效果会更明显（动作不缺失）。
      let allRuleEntries = [];
      for (const action of Object.keys(rules)) {
        for (const dir of Object.keys(rules[action])) {
          allRuleEntries.push({ action, dir, ...rules[action][dir] });
        }
      }
      if (allRuleEntries.length === 1) {
        const only = allRuleEntries[0];
        const dot = axis[0] * only.axis[0] + axis[1] * only.axis[1] + axis[2] * only.axis[2];
        if (dot > 0.05) {
          // 单轴骨骼：clamp 到 limit，保留总幅度
          const angle = Math.max(0, Math.min(only.limit, angleDeg));
          if (angle > 0.01) {
            statements.push(`${bone} ${only.action} ${only.dir} ${angle.toFixed(2)};`);
          } else {
            statements.push(`${bone} reset;`);
            diagReset++;
          }
          continue;
        }
      }

      // ── 多轴分解：对每个 action 找最佳 direction ──
      const commands = [];
      let globalBest = { dot: -2, action: null, dir: null, limit: 0 };

      for (const action of Object.keys(rules)) {
        let bestDir = null;
        let bestDot = -2;
        for (const dir of Object.keys(rules[action])) {
          const rule = rules[action][dir];
          const dot = axis[0] * rule.axis[0] + axis[1] * rule.axis[1] + axis[2] * rule.axis[2];
          if (dot > bestDot) {
            bestDot = dot;
            bestDir = { dir, limit: rule.limit };
          }
        }

        // 更新全局最佳（用于无匹配时的 fallback）
        if (bestDot > globalBest.dot) {
          globalBest = { dot: bestDot, action, dir: bestDir.dir, limit: bestDir.limit };
        }

        // dot 阈值降到 0.05，保留更多小分量（避免帧间闪烁）
        if (bestDot > 0.05) {
          // 精确投影公式：2 * atan2(sinHalf * dot, cosHalf)
          let projectedAngle = 2 * Math.atan2(sinHalf * bestDot, cosHalf) * 180 / Math.PI;
          // 限制在 limit 范围内
          projectedAngle = Math.max(0, Math.min(bestDir.limit, projectedAngle));
          // 保留所有正投影，即使很小（避免该帧变 reset 导致闪烁）
          if (projectedAngle > 0.01) {
            commands.push(`${action} ${bestDir.dir} ${projectedAngle.toFixed(2)}`);
          }
        }
      }

      if (commands.length === 0) {
        // 无任何匹配：用全局最佳 action 输出（即使 dot 很低），避免 reset 闪烁
        // 只有当 dot <= 0 才真正 reset（轴完全反向，无法表示）
        if (globalBest.dot > 0 && globalBest.action) {
          let projAngle = 2 * Math.atan2(sinHalf * globalBest.dot, cosHalf) * 180 / Math.PI;
          projAngle = Math.max(0, Math.min(globalBest.limit, projAngle));
          if (projAngle > 0.01) {
            statements.push(`${bone} ${globalBest.action} ${globalBest.dir} ${projAngle.toFixed(2)};`);
            diagFallbackBest++;
          } else {
            statements.push(`${bone} reset;`);
            diagReset++;
          }
        } else {
          statements.push(`${bone} reset;`);
          diagReset++;
        }
      } else {
        // 输出多命令组合
        statements.push(`${bone} ${commands.join(', ')};`);
      }
    }

    if (statements.length === 0) continue;

    // 去重：相同语句内容的 pose 复用
    const stmtKey = statements.sort().join('\n');
    let poseName;
    if (poseMap.has(stmtKey)) {
      poseName = poseMap.get(stmtKey).name;
    } else {
      poseName = `pose_${poseCounter++}`;
      poseMap.set(stmtKey, { name: poseName, statements });
    }

    // MPL 编译器把秒数量化为帧号时用浮点，会因精度损失向下取整：
    //   4/30 = 0.13333... → ×30 = 3.9999 → 取整为 3（错！应为 4）
    // 加 1e-6 epsilon 保证向上取整到正确帧号。
    animStatements.push({ time: frameNum / 30.0 + 1e-6, poseName });
  }

  console.log(`[MPL] customVMDToMPL: 总骨骼=${diagTotal}, reset=${diagReset} (${(diagReset/diagTotal*100).toFixed(1)}%), fallback最佳=${diagFallbackBest}`);

  // 生成 MPL 脚本
  const lines = [];

  // 输出所有唯一 pose
  for (const { name, statements } of poseMap.values()) {
    lines.push(`@pose ${name} {`);
    for (const s of statements) {
      lines.push(` ${s}`);
    }
    lines.push('}');
    lines.push('');
  }

  // 输出 animation（用 6 位小数秒数，避免 MPL 编译器量化误差）
  lines.push('@animation motion {');
  for (const { time, poseName } of animStatements) {
    lines.push(` ${time.toFixed(6)}: ${poseName};`);
  }
  lines.push('}');
  lines.push('');

  // 输出 main
  lines.push('main {');
  lines.push(' motion;');
  lines.push('}');

  const mplText = lines.join('\n');
  // 缓存 MPL 文本，用于编译时检测是否被用户编辑
  _lastMplText = mplText;
  console.log(`[MPL] customVMDToMPL: 缓存 ${_lastOrigQuats.size} 个原始四元数, MPL 文本 ${mplText.length} 字符`);
  return mplText;
}

// ═══════════════════════════════════════════════════════════
//  VMD bezier 后处理器
//  WASM 编译输出的 bezier 控制点不在对角线上（x1≠y1, x2≠y2），
//  导致动画瞬间跳跃到目标值然后停滞（"一闪一闪"）。
//  此函数将所有骨骼帧的 bezier 替换为平滑的线性曲线。
//
//  VMD 64字节 bezier 布局：4轴×16字节，每轴用 offsets 0,4,8,12
//  P1=(0,0) P2=(x1,y1) P3=(x2,y2) P4=(127,127)
//  线性：x1=y1, x2=y2 → 控制点在对角线上
// ═══════════════════════════════════════════════════════════

export function patchVMDBezier(vmdBytes) {
  // 关键：创建独立副本（WASM 返回的可能是 memory 视图，byteOffset>0）
  const bytes = new Uint8Array(vmdBytes.length);
  bytes.set(vmdBytes);
  const view = new DataView(bytes.buffer);

  // 跳过 header(50) + boneCount(4)
  const boneFrameCount = view.getUint32(50, true);
  let offset = 54;
  let patchedCount = 0;

  console.log(`[MPL] patchVMDBezier: 开始 patch, 骨骼帧数=${boneFrameCount}, bytes.length=${bytes.length}, byteOffset=${bytes.byteOffset}`);

  // 每个骨骼帧的 bezier 起始位置 = offset + 15(boneName) + 4(frame) + 12(pos) + 16(rot) = offset + 47
  for (let i = 0; i < boneFrameCount; i++) {
    if (offset + VMD_BONE_FRAME_SIZE > bytes.length) {
      console.warn(`[MPL] patchVMDBezier: 在帧 ${i} 提前结束 (offset=${offset} > length=${bytes.length})`);
      break;
    }

    const bezierOffset = offset + 15 + 4 + 12 + 16; // = offset + 47

    // 对 4 个轴（X, Y, Z, Rotation）设置 bezier
    // 用 [20,20,20,20] 模式（与原始 MMD VMD 一致，线性插值）
    for (let axis = 0; axis < 4; axis++) {
      const base = bezierOffset + axis * 16;
      bytes[base + 0] = 20;  // x1
      bytes[base + 4] = 20;  // x2
      bytes[base + 8] = 20;   // y1
      bytes[base + 12] = 20; // y2
    }

    patchedCount++;
    offset += VMD_BONE_FRAME_SIZE;
  }

  // 验证 patch 是否生效
  if (patchedCount > 0) {
    const checkOffset = 54 + 47; // 第一帧的 bezier 起点
    const x1 = bytes[checkOffset + 0];
    const x2 = bytes[checkOffset + 4];
    const y1 = bytes[checkOffset + 8];
    const y2 = bytes[checkOffset + 12];
    console.log(`[MPL] patchVMDBezier: 完成 ${patchedCount} 帧, 首帧 bezier byte[0,4,8,12]=[${x1},${x2},${y1},${y2}] (应为 [20,20,20,20])`);
  }

  return bytes;
}

// ═══════════════════════════════════════════════════════════
//  VMD 四元数后处理器
//  解决问题：MPL 编译时使用自身骨骼轴（如 knee 用 (-1,0,0)），
//  丢失原 VMD 的侧向分量（Y/Z），导致膝盖动作不明显。
//  此函数用反编译时缓存的原始四元数覆盖编译输出，恢复精确旋转。
//
//  VMD 骨骼帧布局（共 111 字节）：
//    [0..14]   骨骼名（Shift-JIS）
//    [15..18]  帧号（uint32 LE）
//    [19..30]  位置（3×float32）
//    [31..46]  四元数 qx,qy,qz,qw（4×float32 LE）
//    [47..110] bezier（64 字节）
// ═══════════════════════════════════════════════════════════

export function patchVMDQuaternions(vmdBytes) {
  if (!_lastOrigQuats || _lastOrigQuats.size === 0) {
    console.log('[MPL] patchVMDQuaternions: 无原始四元数缓存，跳过');
    return vmdBytes;
  }

  // 创建独立副本（patchVMDBezier 已创建过副本，但为安全再创建）
  const bytes = new Uint8Array(vmdBytes.length);
  bytes.set(vmdBytes);
  const view = new DataView(bytes.buffer);

  const boneFrameCount = view.getUint32(50, true);
  let offset = 54;
  let patchedCount = 0;
  let missingCount = 0;
  // 统计每根骨骼的命中情况，便于诊断哪些骨骼没匹配
  const missByBone = {};

  for (let i = 0; i < boneFrameCount; i++) {
    if (offset + VMD_BONE_FRAME_SIZE > bytes.length) break;

    const boneName = decodeShiftJIS(bytes, offset, VMD_BONE_NAME_LEN);
    const frameNum = view.getUint32(offset + 15, true);

    // 编译输出通常使用日文骨名（与原 VMD 一致），直接构造键
    let key = `${boneName}_${frameNum}`;
    let origQuat = _lastOrigQuats.get(key);

    // 如果没找到，尝试用反向映射（英→日）：编译器可能用英文骨名输出
    if (!origQuat && _reverseBoneNameMap && _reverseBoneNameMap[boneName]) {
      const jpName = _reverseBoneNameMap[boneName];
      key = `${jpName}_${frameNum}`;
      origQuat = _lastOrigQuats.get(key);
    }

    if (origQuat) {
      // 覆盖四元数：offset + 15(boneName) + 4(frame) + 12(pos) = offset + 31
      const quatOffset = offset + 15 + 4 + 12;
      view.setFloat32(quatOffset + 0, origQuat[0], true); // qx
      view.setFloat32(quatOffset + 4, origQuat[1], true); // qy
      view.setFloat32(quatOffset + 8, origQuat[2], true); // qz
      view.setFloat32(quatOffset + 12, origQuat[3], true); // qw
      patchedCount++;
    } else {
      missingCount++;
      missByBone[boneName] = (missByBone[boneName] || 0) + 1;
    }

    offset += VMD_BONE_FRAME_SIZE;
  }

  // 输出缺失最多的骨骼（前 5 个），帮助诊断
  const topMiss = Object.entries(missByBone).sort((a, b) => b[1] - a[1]).slice(0, 5);
  const missStr = topMiss.length > 0
    ? `, 缺失最多: ${topMiss.map(([n, c]) => `${n}=${c}`).join(', ')}`
    : '';
  console.log(`[MPL] patchVMDQuaternions: 已覆盖 ${patchedCount}/${boneFrameCount} 帧, 缺失 ${missingCount}${missStr}`);

  return bytes;
}

// ═══════════════════════════════════════════════════════════
//  VMD 丢失骨骼帧追加器
//  解决问题：MPL 数据库不支持 IK 骨骼（左足ＩＫ/右足ＩＫ等）和许多其他骨骼，
//  这些骨骼的反编译会被完全跳过，编译后 VMD 中完全没有这些帧。
//  但 IK 骨骼包含位置数据，是 IK 求解器的目标位置，驱动整条腿的动作。
//  此函数将反编译时缓存的无映射骨骼帧（含位置和四元数）追加到编译后 VMD 末尾。
//
//  VMD 结构：
//    [0..29]   magic "Vocaloid Motion Data 0002"
//    [30..49]  模型名
//    [50..53]  骨骼帧数 (uint32 LE)
//    [54..]    骨骼帧 (每帧 111 字节)
//    后面是 morph 帧、相机帧、灯光帧等
//
//  追加策略：
//    1. 找到骨骼帧区域的结束位置 = 54 + boneFrameCount * 111
//    2. 创建新 buffer = 原 buffer + lostFrames.length * 111
//    3. 复制原 buffer 的 [0..54) header（修改帧数）+ [54..boneEnd) 骨骼帧
//    4. 追加 lostFrames
//    5. 复制原 buffer 的 [boneEnd..] morph/camera/light 帧
// ═══════════════════════════════════════════════════════════

export function patchVMDLostBones(vmdBytes) {
  if (!_lastLostBoneFrames || _lastLostBoneFrames.length === 0) {
    console.log('[MPL] patchVMDLostBones: 无丢失骨骼帧缓存，跳过');
    return vmdBytes;
  }

  const view = new DataView(vmdBytes.buffer, vmdBytes.byteOffset, vmdBytes.byteLength);
  const origBoneFrameCount = view.getUint32(50, true);
  const boneEnd = 54 + origBoneFrameCount * VMD_BONE_FRAME_SIZE;
  const lostCount = _lastLostBoneFrames.length;
  const newBoneFrameCount = origBoneFrameCount + lostCount;
  const newLength = vmdBytes.length + lostCount * VMD_BONE_FRAME_SIZE;

  // 创建新 buffer
  const newBytes = new Uint8Array(newLength);
  const newView = new DataView(newBytes.buffer);

  // 1. 复制原 VMD 的 header 区域 [0..54)
  newBytes.set(vmdBytes.subarray(0, 54), 0);
  // 2. 更新骨骼帧数
  newView.setUint32(50, newBoneFrameCount, true);

  // 3. 复制原 VMD 的骨骼帧区域 [54..boneEnd)
  newBytes.set(vmdBytes.subarray(54, boneEnd), 54);

  // 4. 追加丢失的骨骼帧
  let appendOffset = 54 + origBoneFrameCount * VMD_BONE_FRAME_SIZE;
  for (let i = 0; i < lostCount; i++) {
    newBytes.set(_lastLostBoneFrames[i], appendOffset);
    appendOffset += VMD_BONE_FRAME_SIZE;
  }

  // 5. 复制原 VMD 剩余部分（morph/camera/light 帧）
  if (boneEnd < vmdBytes.length) {
    newBytes.set(vmdBytes.subarray(boneEnd), appendOffset);
  }

  // 统计：检查追加的帧中包含哪些骨骼
  const boneCount = {};
  for (const frameBytes of _lastLostBoneFrames) {
    const name = decodeShiftJIS(frameBytes, 0, VMD_BONE_NAME_LEN);
    boneCount[name] = (boneCount[name] || 0) + 1;
  }
  const topBones = Object.entries(boneCount).sort((a, b) => b[1] - a[1]).slice(0, 8);
  console.log(`[MPL] patchVMDLostBones: 追加 ${lostCount} 帧到编译 VMD, 骨骼帧数 ${origBoneFrameCount} → ${newBoneFrameCount}, 新 VMD ${vmdBytes.length} → ${newLength} 字节`);
  console.log(`[MPL] patchVMDLostBones: 追加的骨骼: ${topBones.map(([n, c]) => `${n}=${c}`).join(', ')}`);

  return newBytes;
}

// ═══════════════════════════════════════════════════════════
//  MPL → VMD 编译（带 bezier 修复 + 四元数恢复 + 丢失骨骼帧追加）
// ═══════════════════════════════════════════════════════════

export async function compileMPLToVMD(script) {
  const compiler = await getMPLCompiler();
  const rawBytes = compiler.compile(script);
  if (!rawBytes || rawBytes.length === 0) {
    throw new Error('MPL 编译结果为空，请检查脚本语法');
  }
  // 复制到独立 buffer（WASM 返回的可能是 memory 视图，byteOffset > 0）
  const bytes = new Uint8Array(rawBytes);
  const view = new DataView(bytes.buffer);
  const boneFrameCount = view.getUint32(50, true);
  console.log('[MPL] compileMPLToVMD: 原始 VMD', bytes.length, '字节, 骨骼帧数', boneFrameCount);
  if (boneFrameCount > 0) {
    console.log('[MPL] patch 前 bezier[0..15]:', [...bytes.slice(101, 117)].join(','));
  }
  // 修复 WASM 输出的损坏 bezier 曲线
  let patched = patchVMDBezier(bytes);

  // 用反编译时缓存的原始四元数覆盖编译输出
  // 安全检查：只有当 script 与最近一次 customVMDToMPL 输出完全一致时才覆盖，
  // 避免用户手动编辑 MPL 后用陈旧的四元数破坏其意图
  if (_lastOrigQuats && _lastOrigQuats.size > 0 && script === _lastMplText) {
    patched = patchVMDQuaternions(patched);
  } else if (_lastOrigQuats && _lastOrigQuats.size > 0) {
    console.log('[MPL] compileMPLToVMD: MPL 文本已被编辑，跳过四元数覆盖');
  }

  // 追加无 MPL 映射的骨骼帧（IK 骨骼等位置驱动数据）
  // 同样的安全检查：仅当 MPL 未被编辑时才追加
  if (_lastLostBoneFrames && _lastLostBoneFrames.length > 0 && script === _lastMplText) {
    patched = patchVMDLostBones(patched);
  }

  const patchedView = new DataView(patched.buffer);
  const patchedCount = patchedView.getUint32(50, true);
  if (patchedCount > 0) {
    console.log('[MPL] patch 后 bezier[0..15]:', [...patched.slice(101, 117)].join(','));
  }
  return patched;
}

/**
 * 将 VMD 二进制反编译为 MPL 脚本（使用自定义转换器，保留全部骨骼数据）
 */
export async function reverseCompileVMD(vmdBytes) {
  return customVMDToMPL(vmdBytes);
}

/**
 * 将 VPD 二进制反编译为 MPL 脚本
 */
export async function reverseCompileVPD(vpdBytes) {
  const compiler = await getMPLCompiler();
  return compiler.reverse_compile('vpd', vpdBytes);
}

/**
 * 从原始 VMD 二进制数据预填充四元数缓存和丢失骨骼帧缓存
 *
 * 用于以下场景：
 * 1. 用户已经反编译并保存了 MPL 文件，再次启动应用后直接加载该 MPL 文件播放
 *    此时 _lastOrigQuats 和 _lastLostBoneFrames 为空，patch 不生效
 *    需要在播放前调用此函数，从对应的原始 VMD 填充缓存
 * 2. 加载与 VMD 配对的 MPL 文件时（同名文件）
 *
 * 调用方式：在 viewer.js 的 compileMpl 中，如果用户同时提供了 motion.vmd，
 * 在 compileMPLToVMD 之前调用 preloadVMDForPatch(origVmdBytes)
 *
 * @param {Uint8Array} vmdBytes 原始 VMD 二进制数据
 * @returns {Promise<void>}
 */
export async function preloadVMDForPatch(vmdBytes) {
  console.log('[MPL] preloadVMDForPatch: 开始从原始 VMD 填充缓存');
  // 调用 customVMDToMPL 完成缓存填充（它内部会设置 _lastOrigQuats, _lastLostBoneFrames, _lastMplText）
  // 但我们不需要返回的 MPL 文本，因为我们已经有了 motion.mpl
  // 但 _lastMplText 会被设置为 customVMDToMPL 的输出，这可能与用户加载的 motion.mpl 不一致
  // 所以调用后，_lastMplText 会是反编译生成的文本，而不是用户加载的文本
  // → script === _lastMplText 会失败，patch 不会执行
  //
  // 解决方案：在 viewer.js 中，调用 preloadVMDForPatch 后，将 _lastMplText 设为 null，
  // 并修改 compileMPLToVMD 的逻辑：当 _lastMplText 为 null 但 _lastOrigQuats 非空时，
  // 直接应用 patch（用户已确认匹配）。
  //
  // 或者更简单：让 preloadVMDForPatch 接收 mplText 参数，直接设置 _lastMplText
  // 这样 compileMPLToVMD 的 script === _lastMplText 检查仍然有效

  // 这里不直接调用 customVMDToMPL，因为它的副作用（设置 _lastMplText）会覆盖用户的 motion.mpl
  // 而是手动填充 _lastOrigQuats 和 _lastLostBoneFrames，并让调用方设置 _lastMplText
  await ensureBoneData();

  const uint8 = new Uint8Array(vmdBytes.buffer || vmdBytes);
  const view = new DataView(vmdBytes.buffer || vmdBytes);

  if (uint8.byteLength < VMD_HEADER_SIZE) {
    console.warn('[MPL] preloadVMDForPatch: VMD 文件不完整');
    return;
  }

  // 初始化缓存
  _lastOrigQuats = new Map();
  _lastLostBoneFrames = [];

  let offset = VMD_HEADER_SIZE;
  const boneFrameCount = view.getUint32(offset, true);
  offset += 4;

  let lostCount = 0, keptCount = 0;
  for (let i = 0; i < boneFrameCount; i++) {
    if (offset + VMD_BONE_FRAME_SIZE > uint8.byteLength) break;

    const boneNameJp = decodeShiftJIS(uint8, offset, VMD_BONE_NAME_LEN);
    const frameNum = view.getUint32(offset + VMD_BONE_NAME_LEN, true);
    const frameStartOffset = offset;

    offset += VMD_BONE_NAME_LEN;
    offset += 4;
    offset += 12; // 跳过位置
    const qx = view.getFloat32(offset, true);
    const qy = view.getFloat32(offset + 4, true);
    const qz = view.getFloat32(offset + 8, true);
    const qw = view.getFloat32(offset + 12, true);
    offset += 16;
    offset += 64; // 跳过 bezier

    const boneNameEn = _boneNameMap[boneNameJp];
    if (!boneNameEn) {
      // 无 MPL 映射：保存完整 111 字节帧数据
      const frameBytes = new Uint8Array(VMD_BONE_FRAME_SIZE);
      frameBytes.set(uint8.subarray(frameStartOffset, frameStartOffset + VMD_BONE_FRAME_SIZE));
      _lastLostBoneFrames.push(frameBytes);
      lostCount++;
    } else {
      // 有 MPL 映射：保存原始四元数
      _lastOrigQuats.set(`${boneNameJp}_${frameNum}`, [qx, qy, qz, qw]);
      keptCount++;
    }
  }

  console.log(`[MPL] preloadVMDForPatch: 骨骼帧=${boneFrameCount}, 保留四元数=${keptCount}, 丢失骨骼帧=${lostCount}`);
}

/**
 * 设置最近一次的 MPL 文本缓存
 *
 * 用于配合 preloadVMDForPatch 使用：
 * preloadVMDForPatch(vmdBytes) → setLastMplText(mplText) → compileMPLToVMD(mplText)
 *
 * 这样 compileMPLToVMD 中的 script === _lastMplText 检查就会通过，
 * 从而应用 patchVMDQuaternions 和 patchVMDLostBones
 *
 * @param {string} mplText 用户加载的 MPL 文本
 */
export function setLastMplText(mplText) {
  _lastMplText = mplText;
  console.log(`[MPL] setLastMplText: 已设置 MPL 文本缓存 (${mplText.length} 字符)`);
}
