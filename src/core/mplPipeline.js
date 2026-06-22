import * as THREE from 'three';

console.log('[MPL] ★ Pure-JS 运行时 (无 WASM 依赖)');

const BONE_JP_NAMES = {
  'base': '全ての親', 'center': 'センター', 'upper_body': '上半身', 'lower_body': '下半身',
  'waist': '腰', 'neck': '首', 'head': '頭',
  'shoulder_l': '左肩', 'shoulder_r': '右肩',
  'arm_l': '左腕', 'arm_r': '右腕',
  'elbow_l': '左ひじ', 'elbow_r': '右ひじ',
  'wrist_l': '左手首', 'wrist_r': '右手首',
  'leg_l': '左足', 'leg_r': '右足',
  'knee_l': '左ひざ', 'knee_r': '右ひざ',
  'ankle_l': '左足首', 'ankle_r': '右足首',
  'toe_l': '左足先EX', 'toe_r': '右足先EX',
  'thumb_0_l': '左親指１', 'thumb_1_l': '左親指２',
  'index_0_l': '左人指１', 'index_1_l': '左人指２', 'index_2_l': '左人指３',
  'middle_0_l': '左中指１', 'middle_1_l': '左中指２', 'middle_2_l': '左中指３',
  'ring_0_l': '左薬指１', 'ring_1_l': '左薬指２', 'ring_2_l': '左薬指３',
  'pinky_0_l': '左小指１', 'pinky_1_l': '左小指２', 'pinky_2_l': '左小指３',
  'thumb_0_r': '右親指１', 'thumb_1_r': '右親指２',
  'index_0_r': '右人指１', 'index_1_r': '右人指２', 'index_2_r': '右人指３',
  'middle_0_r': '右中指１', 'middle_1_r': '右中指２', 'middle_2_r': '右中指３',
  'ring_0_r': '右薬指１', 'ring_1_r': '右薬指２', 'ring_2_r': '右薬指３',
  'pinky_0_r': '右小指１', 'pinky_1_r': '右小指２', 'pinky_2_r': '右小指３',
};

const BONE_AXES = {
  'base': { 'move': { f: [0,0,-1], b: [0,0,1], l: [1,0,0], r: [-1,0,0], u: [0,1,0], d: [0,-1,0] } },
  'center': { 'bend': { f: [-1,0,0], b: [1,0,0], u: [0,0,1], d: [0,0,-1] }, 'turn': { l: [0,-1,0], r: [0,1,0] }, 'sway': { l: [0,0,-1], r: [0,0,1] } },
  'head': { 'bend': { f: [-1,0,0], b: [1,0,0], u: [0,0,1], d: [0,0,-1] }, 'turn': { l: [0,-1,0], r: [0,1,0] }, 'sway': { l: [0,0,-1], r: [0,0,1] } },
  'neck': { 'bend': { f: [-1,0,0], b: [1,0,0], u: [0,0,1], d: [0,0,-1] }, 'turn': { l: [0,-1,0], r: [0,1,0] }, 'sway': { l: [0,0,-1], r: [0,0,1] } },
  'upper_body': { 'bend': { f: [-1,0,0], b: [1,0,0], u: [0,0,1], d: [0,0,-1] }, 'turn': { l: [0,-1,0], r: [0,1,0] }, 'sway': { l: [0,0,-1], r: [0,0,1] } },
  'lower_body': { 'bend': { f: [1,0,0], b: [-1,0,0], u: [0,0,1], d: [0,0,-1] }, 'turn': { l: [0,-1,0], r: [0,1,0] }, 'sway': { l: [0,0,-1], r: [0,0,1] } },
  'waist': { 'bend': { f: [-1,0,0], b: [1,0,0], u: [0,0,1], d: [0,0,-1] }, 'turn': { l: [0,-1,0], r: [0,1,0] }, 'sway': { l: [0,0,-1], r: [0,0,1] } },
  'shoulder_l': { 'bend': { f: [0,0,-1], b: [0,0,1], u: [1,0,0], d: [-1,0,0] }, 'sway': { l: [0,0,-1], r: [0,0,1] }, 'turn': { l: [-0.8,0.6,0], r: [0.8,-0.6,0] } },
  'shoulder_r': { 'bend': { f: [0,0,1], b: [0,0,-1], u: [-1,0,0], d: [1,0,0] }, 'sway': { l: [-0.6,0.8,0], r: [0.6,-0.8,0] }, 'turn': { l: [-0.8,-0.6,0], r: [0.8,0.6,0] } },
  'arm_l': { 'bend': { f: [0,0,-1], b: [0,0,1], u: [1,0,0], d: [-1,0,0] }, 'sway': { l: [-0.6,-0.8,0], r: [0.6,0.8,0] }, 'turn': { l: [-0.8,0.6,0], r: [0.8,-0.6,0] } },
  'arm_r': { 'bend': { f: [0,0,1], b: [0,0,-1], u: [-1,0,0], d: [1,0,0] }, 'sway': { l: [0.6,-0.8,0], r: [-0.6,0.8,0] }, 'turn': { l: [-0.8,-0.6,0], r: [0.8,0.6,0] } },
  'elbow_l': { 'bend': { f: [0.6,0.8,0], u: [0,0,-1], d: [0,0,1] }, 'turn': { l: [0,-1,0], r: [0,1,0] }, 'sway': { l: [-0.6,-0.8,0], r: [0.6,0.8,0] } },
  'elbow_r': { 'bend': { f: [0.6,-0.8,0], u: [0,0,1], d: [0,0,-1] }, 'turn': { l: [0,-1,0], r: [0,1,0] }, 'sway': { l: [0.6,-0.8,0], r: [-0.6,0.8,0] } },
  'wrist_l': { 'bend': { f: [0,0,-1], b: [0,0,1], u: [1,0,0], d: [-1,0,0] }, 'sway': { l: [-0.6,-0.8,0], r: [0.6,0.8,0] }, 'turn': { l: [-0.8,0.6,0], r: [0.8,-0.6,0] } },
  'wrist_r': { 'bend': { f: [0,0,1], b: [0,0,-1], u: [-1,0,0], d: [1,0,0] }, 'sway': { l: [0.6,-0.8,0], r: [-0.6,0.8,0] }, 'turn': { l: [-0.8,-0.6,0], r: [0.8,0.6,0] } },
  'leg_l': { 'bend': { f: [1,0,0], b: [-1,0,0], u: [0,0,1], d: [0,0,-1] }, 'turn': { l: [0,-1,0], r: [0,1,0] }, 'sway': { l: [0,0,1], r: [0,0,-1] } },
  'leg_r': { 'bend': { f: [1,0,0], b: [-1,0,0], u: [0,0,-1], d: [0,0,1] }, 'turn': { l: [0,-1,0], r: [0,1,0] }, 'sway': { l: [0,0,1], r: [0,0,-1] } },
  'knee_l': { 'bend': { f: [-1,0,0], b: [1,0,0] } },
  'knee_r': { 'bend': { f: [-1,0,0], b: [1,0,0] } },
  'ankle_l': { 'bend': { f: [1,0,0], b: [-1,0,0] } },
  'ankle_r': { 'bend': { f: [1,0,0], b: [-1,0,0] } },
  'toe_l': { 'bend': { f: [1,0,0] } },
  'toe_r': { 'bend': { f: [1,0,0] } },
};

const DIR_MAP = { 'forward': 'f', 'backward': 'b', 'left': 'l', 'right': 'r', 'up': 'u', 'down': 'd' };

export const AXIS_OVERRIDES = {
    'leg_r': {
        bend: { f: [0, 0, 1], b: [0, 0, -1] },
        turn: { l: [0, -1, 0], r: [0, 1, 0] },
        sway: { l: [0, 0, 1], r: [0, 0, -1] }
    },
    'leg_l': {
        bend: { f: [0, 0, 1], b: [0, 0, -1] },
        turn: { l: [0, -1, 0], r: [0, 1, 0] },
        sway: { l: [0, 0, 1], r: [0, 0, -1] }
    },
    'spine': {
        bend: { f: [-1, 0, 0], b: [1, 0, 0] },
        turn: { l: [0, -1, 0], r: [0, 1, 0] },
        sway: { l: [0, 0, -1], r: [0, 0, 1] }
    },
    'upper_body': {
        bend: { f: [-1, 0, 0], b: [1, 0, 0] },
        turn: { l: [0, -1, 0], r: [0, 1, 0] },
        sway: { l: [0, 0, -1], r: [0, 0, 1] }
    },
    'waist': {
        bend: { f: [-1, 0, 0], b: [1, 0, 0] },
        turn: { l: [0, -1, 0], r: [0, 1, 0] },
        sway: { l: [0, 0, -1], r: [0, 0, 1] }
    },
    'lower_body': {
        bend: { f: [-1, 0, 0], b: [1, 0, 0] },
        turn: { l: [0, -1, 0], r: [0, 1, 0] },
        sway: { l: [0, 0, -1], r: [0, 0, 1] }
    }
};

function normalize(text) {
  return text
    .replace(/\{/g, '\n{\n')
    .replace(/}/g, '\n}\n')
    .replace(/@pose /g, '\n@pose ')
    .replace(/@animation /g, '\n@animation ')
    .replace(/main\s*\{/g, '\nmain {')
    .replace(/\n+/g, '\n')
    .trim();
}

function parseBlock(text) {
  const normalized = normalize(text);
  const lines = normalized.split('\n');
  let blockName = '';
  let braceCount = 0;
  let hasBrace = false;
  let blockType = '';
  let currentBlock = '';

  const blocks = { poses: {}, animations: {}, main: [] };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('@pose ') || trimmed.startsWith('@animation ') || trimmed.startsWith('main')) {
      if (braceCount > 0) throw new Error(`L${i+1}: nested block not allowed`);

      if (trimmed.startsWith('@pose ')) blockType = 'pose';
      else if (trimmed.startsWith('@animation ')) blockType = 'animation';
      else blockType = 'main';

      const namePart = trimmed.endsWith('{') ? trimmed.slice(0, -1).trim() : trimmed;
      if (blockType === 'pose') blockName = namePart.split(/\s+/)[1] || '';
      else if (blockType === 'animation') blockName = namePart.split(/\s+/)[1] || '';
      else blockName = '';

      currentBlock = '';
      hasBrace = false;
    }

    currentBlock += line + '\n';
    braceCount += (line.match(/\{/g) || []).length;
    braceCount -= (line.match(/\}/g) || []).length;
    if (braceCount > 0) hasBrace = true;

    if (braceCount === 0 && hasBrace && currentBlock.trim()) {
      const content = currentBlock.trim();
      const body = extractBody(content);
      if (blockType === 'pose') {
        const stmts = parsePoseStatements(body);
        if (stmts.length === 0) throw new Error(`L${i+1}: pose '${blockName}' has no valid statements`);
        const pose = { name: blockName, statements: stmts };
        if (blocks.poses[blockName]) throw new Error(`Duplicate pose: ${blockName}`);
        blocks.poses[blockName] = pose;
      } else if (blockType === 'animation') {
        const stmts = parseAnimationStatements(body);
        if (stmts.length === 0) throw new Error(`L${i+1}: animation '${blockName}' has no statements`);
        for (const s of stmts) {
          for (const pn of s.poses) {
            if (!blocks.poses[pn]) throw new Error(`Animation '${blockName}' refs unknown pose '${pn}'`);
          }
        }
        if (blocks.animations[blockName]) throw new Error(`Duplicate animation: ${blockName}`);
        blocks.animations[blockName] = { name: blockName, statements: stmts };
      } else if (blockType === 'main') {
        const refs = parseMainBlock(content);
        blocks.main = refs;
      }
      currentBlock = '';
    }
  }

  return blocks;
}

function extractBody(text) {
  const headEnd = text.indexOf('{');
  if (headEnd < 0) return text;
  let idx = headEnd + 1;
  let depth = 1;
  for (; idx < text.length && depth > 0; idx++) {
    if (text[idx] === '{') depth++;
    else if (text[idx] === '}') depth--;
  }
  return text.slice(headEnd + 1, idx - 1).trim();
}

function parsePoseStatements(text) {
  const stmts = [];
  const rawChunks = text.split(';');
  for (const chunk of rawChunks) {
    const t = chunk.trim();
    if (!t || t === '{' || t === '}' || t.startsWith('@pose')) continue;

    const parts = t.split(',').map(p => p.trim()).filter(Boolean);
    let firstBone = '';
    for (let i = 0; i < parts.length; i++) {
      const words = parts[i].split(/\s+/);

      if (words.length === 2 && words[0] === 'reset') {
        stmts.push({ bone: words[1], action: 'reset', direction: '', degrees: 0 });
        continue;
      }
      if (words.length === 2 && words[1] === 'reset') {
        stmts.push({ bone: words[0], action: 'reset', direction: '', degrees: 0 });
        if (i === 0) firstBone = words[0];
        continue;
      }

      if (words.length >= 6 && words[1] === 'quat') {
        const bone = words[0];
        const qx = parseFloat(words[2]);
        const qy = parseFloat(words[3]);
        const qz = parseFloat(words[4]);
        const qw = parseFloat(words[5]);
        if (isNaN(qx + qy + qz + qw)) throw new Error(`Invalid quat in: "${parts[i]}"`);
        stmts.push({ bone, action: 'quat', quat: new THREE.Quaternion(qx, qy, qz, qw) });
        if (i === 0) firstBone = bone;
        continue;
      }

      if (words.length >= 5 && words[0] === 'quat') {
        const bone = firstBone;
        const qx = parseFloat(words[1]);
        const qy = parseFloat(words[2]);
        const qz = parseFloat(words[3]);
        const qw = parseFloat(words[4]);
        if (!isNaN(qx + qy + qz + qw)) {
          stmts.push({ bone, action: 'quat', quat: new THREE.Quaternion(qx, qy, qz, qw) });
          continue;
        }
      }

      if (i === 0) firstBone = words[0];
      const bone = i === 0 ? words[0] : firstBone;
      const action = i === 0 ? words[1] : words[0];
      const direction = i === 0 ? words[2] : words[1];
      const degrees = parseFloat(i === 0 ? words[3] : words[2]);
      if (isNaN(degrees)) throw new Error(`Invalid degrees in: "${parts[i]}"`);
      stmts.push({ bone, action, direction, degrees });
    }
  }
  return stmts;
}

function parseAnimationStatements(text) {
  const stmts = [];
  const allEntries = text
    .split(';')
    .map(s => s.trim())
    .filter(s => s && s !== '{' && s !== '}' && !s.startsWith('@animation'));

  for (const entry of allEntries) {
    const colonIdx = entry.indexOf(':');
    if (colonIdx < 0) throw new Error(`Missing colon in: "${entry}"`);
    const timeStr = entry.slice(0, colonIdx).trim();
    const poseRef = entry.slice(colonIdx + 1).trim();
    const time = parseFloat(timeStr);
    if (isNaN(time)) throw new Error(`Invalid time: "${timeStr}"`);
    const poses = poseRef.split(/[,\s]+/).filter(Boolean);
    stmts.push({ time, poses });
  }
  return stmts;
}

function parseMainBlock(text) {
  const refs = [];
  const lines = text.split('\n');
  for (const line of lines) {
    let t = line.trim();
    if (!t || t === '{' || t === '}' || t === 'main') continue;
    if (t.endsWith(';')) t = t.slice(0, -1).trim();
    if (t) refs.push(t);
  }
  return refs;
}

function computeRotation(bone, action, direction, degrees) {
  if (action === 'reset' || action === 'quat') return null;

  const dirKey = DIR_MAP[direction];
  if (!dirKey) throw new Error(`Unknown direction: ${direction}`);

  let axis = null;
  if (AXIS_OVERRIDES[bone] && AXIS_OVERRIDES[bone][action] && AXIS_OVERRIDES[bone][action][dirKey]) {
    axis = AXIS_OVERRIDES[bone][action][dirKey];
  } else if (BONE_AXES[bone] && BONE_AXES[bone][action] && BONE_AXES[bone][action][dirKey]) {
    axis = BONE_AXES[bone][action][dirKey];
  }

  if (!axis) {
    console.warn(`[MPL] 未找到旋转轴: ${bone}.${action}.${direction}`);
    return new THREE.Quaternion(0, 0, 0, 1);
  }

  const rad = THREE.MathUtils.degToRad(degrees);
  const quat = new THREE.Quaternion();
  quat.setFromAxisAngle(new THREE.Vector3(axis[0], axis[1], axis[2]).normalize(), rad);
  return quat;
}

function compileScript(scriptText) {
  const blocks = parseBlock(scriptText);
  const keyframes = [];

  for (const refName of blocks.main) {
    if (blocks.animations[refName]) {
      const anim = blocks.animations[refName];
      for (const stmt of anim.statements) {
        const boneFrames = [];
        const seen = new Set();

        for (const poseName of stmt.poses) {
          const pose = blocks.poses[poseName];
          if (!pose) throw new Error(`Pose not found: ${poseName}`);
          for (const s of pose.statements) {
            if (s.action === 'reset') {
              if (!seen.has(s.bone)) {
                boneFrames.push({ bone: s.bone, quat: new THREE.Quaternion() });
                seen.add(s.bone);
              }
              continue;
            }
            if (s.action === 'quat') {
              if (!seen.has(s.bone)) {
                boneFrames.push({ bone: s.bone, quat: s.quat.clone(), quatAbsolute: true });
                seen.add(s.bone);
              }
              continue;
            }
            const q = computeRotation(s.bone, s.action, s.direction, s.degrees);
            if (q && !seen.has(s.bone)) {
              boneFrames.push({ bone: s.bone, quat: q });
              seen.add(s.bone);
            }
          }
        }

        if (boneFrames.length > 0) {
          keyframes.push({ time: stmt.time, boneFrames });
        }
      }
    } else if (blocks.poses[refName]) {
      const pose = blocks.poses[refName];
      const boneFrames = [];
      for (const s of pose.statements) {
        if (s.action === 'reset') { boneFrames.push({ bone: s.bone, quat: new THREE.Quaternion() }); continue; }
        if (s.action === 'quat') { boneFrames.push({ bone: s.bone, quat: s.quat.clone(), quatAbsolute: true }); continue; }
        const q = computeRotation(s.bone, s.action, s.direction, s.degrees);
        if (q) boneFrames.push({ bone: s.bone, quat: q });
      }
      if (boneFrames.length > 0) keyframes.push({ time: 0, boneFrames });
    }
  }

  return { blocks, keyframes };
}

export function createAnimationClip(mesh, scriptText, jpNamesOverride, boneIndexOverride) {
  if (!mesh || !mesh.skeleton || !mesh.skeleton.bones) {
    throw new Error('Invalid mesh: missing skeleton');
  }
  
  const { keyframes } = compileScript(scriptText);
  if (keyframes.length === 0) throw new Error('No keyframes generated');

  const bones = mesh.skeleton.bones;
  const boneMap = {};
  const boneRest = [];
  for (let i = 0; i < bones.length; i++) {
    boneMap[bones[i].name] = i;
    boneRest[i] = bones[i].quaternion.clone();
  }

  const tracksPerBone = {};
  let mappedCount = 0;
  let missedCount = 0;
  const missedBones = [];

  // ★ 为未匹配的骨骼尝试动态模糊匹配
  function findBoneFuzzy(mplName, jpName, boneMap, bones, cache) {
    const cacheKey = mplName + '|' + jpName;
    if (cache[cacheKey] !== undefined) return cache[cacheKey];

    const modelNames = Object.keys(boneMap);
    const candidates = [mplName, jpName];

    if (mplName !== jpName) candidates.push(jpName);
    candidates.push(mplName.replace(/[_]/g, ''));
    candidates.push(mplName.replace(/[._](\d+)$/, ''));

    for (const c of candidates) {
      if (boneMap[c] !== undefined) {
        cache[cacheKey] = boneMap[c];
        return boneMap[c];
      }
    }

    for (const c of candidates) {
      if (!c) continue;
      const lower = c.toLowerCase();
      for (const mn of modelNames) {
        const mnLower = mn.toLowerCase();
        if (mnLower.includes(lower) || lower.includes(mnLower)) {
          cache[cacheKey] = boneMap[mn];
          return boneMap[mn];
        }
      }
    }

    cache[cacheKey] = undefined;
    return undefined;
  }

  const fuzzyCache = {};

  for (const kf of keyframes) {
    for (const bf of kf.boneFrames) {
      // ★ 智能匹配模式：直接使用骨骼索引（优先）
      let boneIdx;
      if (boneIndexOverride && typeof boneIndexOverride === 'object') {
        boneIdx = boneIndexOverride[bf.bone];
        if (boneIdx !== undefined) {
          mappedCount++;
          if (!tracksPerBone[boneIdx]) {
            tracksPerBone[boneIdx] = [];
          }
          tracksPerBone[boneIdx].push({ time: kf.time, quat: bf.quat.clone() });
          continue;
        }
      }

      // ★ 传统匹配模式：通过骨骼名查找
      const jpName = (jpNamesOverride && typeof jpNamesOverride === 'object')
        ? (jpNamesOverride[bf.bone] || BONE_JP_NAMES[bf.bone] || bf.bone)
        : (BONE_JP_NAMES[bf.bone] || bf.bone);
      boneIdx = boneMap[jpName];
      if (boneIdx !== undefined) {
        mappedCount++;
        if (!tracksPerBone[boneIdx]) {
          tracksPerBone[boneIdx] = [];
        }
        tracksPerBone[boneIdx].push({ time: kf.time, quat: bf.quat.clone() });
        continue;
      }

      // ★ 动态模糊回退：遍历模型骨骼名尝试子串匹配
      boneIdx = findBoneFuzzy(bf.bone, jpName, boneMap, bones, fuzzyCache);
      if (boneIdx !== undefined) {
        mappedCount++;
        if (!tracksPerBone[boneIdx]) {
          tracksPerBone[boneIdx] = [];
        }
        tracksPerBone[boneIdx].push({ time: kf.time, quat: bf.quat.clone() });
        continue;
      }

      if (!missedBones.includes(bf.bone)) {
        missedBones.push(bf.bone);
        console.warn(`[MPL] ⚠️ 骨骼未找到: "${bf.bone}" → jp:"${jpName}"`);
      }
      missedCount++;
    }
  }

  const tracks = [];
  for (const [boneIdxStr, kfs] of Object.entries(tracksPerBone)) {
    const boneIdx = parseInt(boneIdxStr);
    kfs.sort((a, b) => a.time - b.time);

    const keyframesOut = [];

    for (const kf of kfs) {
      const mplRot = kf.quat;
      const rest = boneRest[boneIdx];
      let frameQuat;
      if (kf.quatAbsolute) {
        frameQuat = mplRot.clone();
      } else {
        frameQuat = rest.clone().multiply(mplRot);
      }
      keyframesOut.push({ time: kf.time, quat: frameQuat });
    }

    tracks.push({ boneIdx, keyframes: keyframesOut });
  }

  if (tracks.length === 0) throw new Error('No bone tracks generated');

  const totalDuration = keyframes[keyframes.length - 1].time + 0.5;

  console.log(`[MPL] ✅ AnimationClip: ${tracks.length}个轨道, ${totalDuration.toFixed(1)}s, 映射${mappedCount}个, 未找到${missedCount}个${missedBones.length > 0 ? ' (' + missedBones.join(', ') + ')' : ''}`);
  return { name: 'mpl_action', duration: totalDuration, tracks };
}

export async function initMPL() {
  console.log('[MPL] Pure-JS 运行时就绪 (无需 WASM)');
  return true;
}

export function compileMPL(script) {
  return compileScript(script);
}

export function createAnimationClipFromVMD(mesh, scriptText, jpNamesOverride) {
  return createAnimationClip(mesh, scriptText, jpNamesOverride);
}

export function getCompiler() {
  return { get_all_bones: () => Object.keys(BONE_AXES) };
}

const INTENT_TO_MPL = {
  greet: `@pose greet_raise {
arm_r bend forward 80;
wrist_r bend forward 20;
shoulder_r bend forward 25;
}
@pose greet_wave_a {
arm_r bend forward 80;
wrist_r bend forward 40;
shoulder_r bend forward 25;
}
@pose greet_wave_b {
arm_r bend forward 80;
wrist_r bend forward 20;
shoulder_r bend forward 25;
}
@pose greet_lower {
arm_r reset;
wrist_r reset;
shoulder_r reset;
}
@animation greet_anim {
0: greet_raise;
0.35: greet_wave_a;
0.55: greet_wave_b;
0.75: greet_wave_a;
0.95: greet_wave_b;
1.15: greet_wave_a;
1.35: greet_wave_b;
1.7: greet_lower;
}
main {
greet_anim;
}`,

  nod: `@pose nod_down {
head bend forward 25;
neck bend forward 15;
}
@pose nod_up {
head bend backward 10;
neck bend backward 5;
}
@pose nod_rest {
head reset;
neck reset;
}
@animation nod_anim {
0: nod_down;
0.3: nod_up;
0.6: nod_down;
0.9: nod_rest;
}
main {
nod_anim;
}`,

  shake: `@pose shake_left {
head turn left 30;
}
@pose shake_right {
head turn right 30;
}
@pose shake_rest {
head reset;
}
@animation shake_anim {
0: shake_left;
0.3: shake_right;
0.6: shake_left;
0.9: shake_rest;
}
main {
shake_anim;
}`,

  raise_hand: `@pose hand_up {
arm_r bend forward 130;
shoulder_r bend forward 40;
wrist_r bend forward 10;
}
@pose hand_down {
arm_r reset;
shoulder_r reset;
wrist_r reset;
}
@animation raise_anim {
0: hand_up;
2.0: hand_down;
}
main {
raise_anim;
}`,

  point: `@pose point_raise {
arm_r bend forward 70;
shoulder_r bend forward 25;
}
@pose point_extend {
arm_r bend forward 45;
wrist_r bend forward 60;
}
@pose point_return {
arm_r reset;
wrist_r reset;
shoulder_r reset;
}
@animation point_anim {
0: point_raise;
0.4: point_extend;
1.5: point_return;
}
main {
point_anim;
}`,

  kick: `@pose kick_up {
leg_r bend forward 45;
knee_r bend backward 30;
upper_body bend forward 5;
}
@pose kick_down {
leg_r reset;
knee_r reset;
upper_body reset;
}
@animation kick_anim {
0: kick_up;
0.5: kick_up;
0.8: kick_down;
}
main {
kick_anim;
}`,

  walk: `@pose step_l {
leg_l bend forward 30;
leg_r bend backward 20;
arm_l bend backward 20;
arm_r bend forward 20;
}
@pose step_r {
leg_r bend forward 30;
leg_l bend backward 20;
arm_r bend backward 20;
arm_l bend forward 20;
}
@animation walk_anim {
0: step_l;
0.4: step_r;
0.8: step_l;
1.2: step_r;
}
main {
walk_anim;
}`,

  dance: `@pose dance_a {
arm_l bend forward 80;
arm_r bend forward 20;
leg_l bend forward 20;
leg_r bend backward 15;
upper_body bend forward 8;
}
@pose dance_b {
arm_r bend forward 80;
arm_l bend forward 20;
leg_r bend forward 20;
leg_l bend backward 15;
upper_body bend forward 8;
}
@animation dance_anim {
0: dance_a;
0.4: dance_b;
0.8: dance_a;
1.2: dance_b;
1.6: dance_a;
2.0: dance_b;
}
main {
dance_anim;
}`,

  sit: `@pose sit_pose {
leg_l bend forward 90;
leg_r bend forward 90;
knee_l bend backward 85;
knee_r bend backward 85;
upper_body bend forward 8;
}
@pose sit_up {
leg_l reset;
leg_r reset;
knee_l reset;
knee_r reset;
upper_body reset;
}
@animation sit_anim {
0: sit_pose;
3.0: sit_up;
}
main {
sit_anim;
}`,

  jump: `@pose crouch {
knee_l bend backward 30;
knee_r bend backward 30;
leg_l bend forward 15;
leg_r bend forward 15;
arm_l bend backward 20;
arm_r bend backward 20;
upper_body bend forward 15;
}
@pose air {
knee_l reset;
knee_r reset;
leg_l bend backward 10;
leg_r bend backward 10;
arm_l bend forward 100;
arm_r bend forward 100;
upper_body bend backward 10;
}
@pose land {
knee_l bend backward 25;
knee_r bend backward 25;
leg_l reset;
leg_r reset;
arm_l reset;
arm_r reset;
upper_body reset;
}
@animation jump_anim {
0: crouch;
0.3: air;
0.7: land;
1.0: land;
}
main {
jump_anim;
}`,

  hug: `@pose hug_open {
arm_l bend forward 60;
arm_r bend forward 60;
shoulder_l bend forward 20;
shoulder_r bend forward 20;
upper_body bend forward 8;
wrist_l bend forward 20;
wrist_r bend forward 20;
}
@pose hug_close {
arm_l bend forward 40;
arm_r bend forward 40;
shoulder_l bend forward 10;
shoulder_r bend forward 10;
wrist_l bend forward 40;
wrist_r bend forward 40;
}
@pose hug_rest {
arm_l reset;
arm_r reset;
shoulder_l reset;
shoulder_r reset;
upper_body reset;
wrist_l reset;
wrist_r reset;
}
@animation hug_anim {
0: hug_open;
0.8: hug_close;
1.6: hug_rest;
}
main {
hug_anim;
}`,

  idle: `@pose idle_rest {
}
@animation idle_anim {
0: idle_rest;
}
main {
idle_anim;
}`,
};

export function getMPLForIntent(intent) {
  return INTENT_TO_MPL[intent] || INTENT_TO_MPL.idle;
}
