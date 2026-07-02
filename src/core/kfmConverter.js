// ═══════════════════════════════════════════════════════════
//  KFM (Keyframe Motion Format) → MPL 转换器
//
//  KFM 是为 AI 生成设计的紧凑动作格式：
//  - 只描述关键帧（不每帧都写）
//  - 增量描述（只写变化的骨骼，未提及的保持上一帧值）
//  - 不需要 @pose 块（自动生成）
//
//  KFM 格式示例：
//  @motion wave {
//    0.0: arm_r reset; elbow_r reset; wrist_r reset;
//    0.5: arm_r bend forward 60; elbow_r bend forward 90;
//    1.0: wrist_r sway left 30;
//    1.5: wrist_r sway right 10;
//    2.0: arm_r reset; elbow_r reset; wrist_r reset;
//  }
//  main { wave; }
//
//  转换为标准 MPL 后，WASM 编译器用 bezier [20,20,20,20] 线性插值
//  自动生成关键帧之间的中间帧。
// ═══════════════════════════════════════════════════════════

/**
 * 检测文本是否为 KFM 格式
 */
export function isKFM(text) {
  return /@motion\s+\w+\s*\{/.test(text.slice(0, 2000));
}

/**
 * 解析单条骨骼语句
 * "arm_r bend forward 60" → { bone: "arm_r", action: "bend", direction: "forward", amount: 60 }
 * "arm_r reset" → { bone: "arm_r", reset: true }
 * "arm_r bend forward 60, sway left 20" → 两条语句
 */
function parseStatements(text) {
  const stmts = [];
  // 按分号或逗号分割
  const parts = text.split(/[;,]/).map(s => s.trim()).filter(Boolean);
  let currentBone = null;

  for (const part of parts) {
    // "arm_r bend forward 60" or "arm_r reset" or "bend forward 60" (延续上一个骨骼)
    const tokens = part.split(/\s+/);
    if (tokens.length === 0) continue;

    // 判断是否以骨骼名开头
    const firstToken = tokens[0];
    const looksLikeBone = /^[a-z]/.test(firstToken) && tokens.length >= 2;
    let bone, rest;

    if (looksLikeBone && firstToken !== 'reset' && firstToken !== 'bend' && firstToken !== 'turn' && firstToken !== 'sway' && firstToken !== 'move') {
      bone = firstToken;
      rest = tokens.slice(1);
      currentBone = bone;
    } else {
      bone = currentBone;
      rest = tokens;
    }

    if (!bone) continue;

    if (rest[0] === 'reset') {
      stmts.push({ bone, reset: true });
    } else if (rest.length >= 3) {
      // action direction amount
      const action = rest[0];
      const direction = rest[1];
      const amount = parseFloat(rest[2]);
      if (!isNaN(amount)) {
        stmts.push({ bone, action, direction, amount });
      }
    }
  }
  return stmts;
}

/**
 * 将 KFM 转换为标准 MPL
 */
export function kfmToMPL(kfmText) {
  const lines = kfmText.split('\n');

  // 解析 @motion 块
  const motions = [];
  let currentMotion = null;
  let currentName = null;
  let inMotion = false;
  let mainAnim = null;

  for (const line of lines) {
    // @motion name {
    const motionMatch = line.match(/@motion\s+(\w+)\s*\{/);
    if (motionMatch) {
      currentMotion = [];
      currentName = motionMatch[1];
      inMotion = true;
      continue;
    }
    if (inMotion && line.trim() === '}') {
      motions.push({ name: currentName, keyframes: currentMotion });
      inMotion = false;
      currentMotion = null;
      continue;
    }
    if (inMotion) {
      // "0.5: arm_r bend forward 60; elbow_r bend forward 90;"
      const m = line.match(/^\s*(\d+(?:\.\d+)?)\s*:\s*(.+)/);
      if (m) {
        const time = parseFloat(m[1]);
        const stmtText = m[2].replace(/;\s*$/, '');
        const statements = parseStatements(stmtText);
        currentMotion.push({ time, statements });
      }
      continue;
    }
    // main { name; }
    const mainMatch = line.match(/main\s*\{\s*(\w+)\s*;?\s*\}/);
    if (mainMatch) {
      mainAnim = mainMatch[1];
    }
  }

  if (motions.length === 0) {
    throw new Error('KFM 解析失败：未找到 @motion 块');
  }

  // 为每个 motion 生成 @pose 和 @animation
  const mplLines = [];
  const motionToUse = mainAnim ? motions.find(m => m.name === mainAnim) || motions[0] : motions[0];

  const { keyframes } = motionToUse;
  if (keyframes.length === 0) {
    throw new Error('KFM 解析失败：没有关键帧');
  }

  // 按时间排序
  keyframes.sort((a, b) => a.time - b.time);

  // 维护骨骼状态（增量描述的核心：未提及的骨骼保持上一帧值）
  // 结构: bone → Map(action → {direction, amount})
  // 同骨骼的不同 action 共存（如 bend + sway），同 action 的新值替换旧值
  const boneState = new Map();

  // 为每个关键帧生成完整 @pose
  const poseNames = [];
  for (let i = 0; i < keyframes.length; i++) {
    const kf = keyframes[i];

    // 更新骨骼状态
    for (const stmt of kf.statements) {
      if (stmt.reset) {
        boneState.set(stmt.bone, null); // null 表示 reset
      } else {
        // 获取或创建该骨骼的 action map
        let actionMap = boneState.get(stmt.bone);
        if (!actionMap || actionMap === null) {
          actionMap = new Map();
          boneState.set(stmt.bone, actionMap);
        }
        // 同 action 的新值替换旧值（如 sway left 30 → sway right 15）
        actionMap.set(stmt.action, { direction: stmt.direction, amount: stmt.amount });
      }
    }

    // 生成 @pose
    const poseName = `kf_${i}`;
    poseNames.push({ time: kf.time, name: poseName });
    mplLines.push(`@pose ${poseName} {`);
    for (const [bone, actionMap] of boneState) {
      if (actionMap === null) {
        mplLines.push(`  ${bone} reset;`);
      } else {
        // 同骨骼的多个 action 用逗号连接：bone action1 dir1 amt1, action2 dir2 amt2;
        const parts = [];
        for (const [action, { direction, amount }] of actionMap) {
          parts.push(`${action} ${direction} ${amount}`);
        }
        mplLines.push(`  ${bone} ${parts.join(', ')};`);
      }
    }
    mplLines.push('}');
    mplLines.push('');
  }

  // 生成 @animation
  mplLines.push(`@animation ${motionToUse.name} {`);
  for (const { time, name } of poseNames) {
    mplLines.push(`  ${time.toFixed(6)}: ${name};`);
  }
  mplLines.push('}');
  mplLines.push('');

  // 生成 main
  mplLines.push(`main {`);
  mplLines.push(`  ${motionToUse.name};`);
  mplLines.push('}');

  return mplLines.join('\n');
}
