// boneMatcher.js — MMD 骨骼语义匹配器 V2.0
// 核心改进：利用骨骼层级结构 + 世界坐标 + LLM辅助进行精准匹配

import * as THREE from 'three';

const SEMANTIC_BONES = [
  'base', 'center', 'upper_body', 'lower_body', 'waist',
  'head', 'neck',
  'shoulder_l', 'shoulder_r',
  'arm_l', 'arm_r',
  'elbow_l', 'elbow_r',
  'wrist_l', 'wrist_r',
  'leg_l', 'leg_r',
  'knee_l', 'knee_r',
  'ankle_l', 'ankle_r',
  'toe_l', 'toe_r',
  'thumb_0_l', 'thumb_1_l',
  'index_0_l', 'index_1_l', 'index_2_l',
  'middle_0_l', 'middle_1_l', 'middle_2_l',
  'ring_0_l', 'ring_1_l', 'ring_2_l',
  'pinky_0_l', 'pinky_1_l', 'pinky_2_l',
  'thumb_0_r', 'thumb_1_r',
  'index_0_r', 'index_1_r', 'index_2_r',
  'middle_0_r', 'middle_1_r', 'middle_2_r',
  'ring_0_r', 'ring_1_r', 'ring_2_r',
  'pinky_0_r', 'pinky_1_r', 'pinky_2_r',
];

const JP_EXACT = {
  base:        ['全ての親', '全ての親bone', 'Base', 'Root'],
  center:      ['センター', 'Center', '中心', 'グルーブ', 'Groove'],
  upper_body:  ['上半身', '上半身2', 'UpperBody', 'Spine', 'Spine1'],
  lower_body:  ['下半身', 'LowerBody', 'Pelvis', 'Hips'],
  waist:       ['腰', 'Waist', 'Hip', 'Spine2'],
  neck:        ['首', 'Neck', 'Neck1'],
  head:        ['頭', 'Head', '头部', 'HeadTop_End'],

  shoulder_l: ['左肩', 'LeftShoulder', 'L_Shoulder', '肩_L', 'Shoulder_L'],
  shoulder_r: ['右肩', 'RightShoulder', 'R_Shoulder', '肩_R', 'Shoulder_R'],
  arm_l:      ['左腕', 'LeftArm', 'L_Arm', '左上腕', 'UpperArm_L', '腕_L', 'Arm_L'],
  arm_r:      ['右腕', 'RightArm', 'R_Arm', '右上腕', 'UpperArm_R', '腕_R', 'Arm_R'],
  elbow_l:    ['左ひじ', '左肘', 'LeftElbow', 'L_Elbow', '左前腕', 'ForeArm_L', 'ひじL', '肘L', 'LowerArm_L'],
  elbow_r:    ['右ひじ', '右肘', 'RightElbow', 'R_Elbow', '右前腕', 'ForeArm_R', 'ひじR', '肘R', 'LowerArm_R'],
  wrist_l:    ['左手首', 'LeftHand', 'L_Hand', '左手', 'Hand_L', '手首L', 'Wrist_L'],
  wrist_r:    ['右手首', 'RightHand', 'R_Hand', '右手', 'Hand_R', '手首R', 'Wrist_R'],

  // VRM 格式: 足R/足L, ひざR/ひざL 等
  leg_l:    ['左足', 'LeftLeg', 'L_Leg', '左太もも', '左大腿', 'Thigh_L', 'LeftUpperLeg', 'UpperLeg_L', '足L', 'Leg_L'],
  leg_r:    ['右足', 'RightLeg', 'R_Leg', '右太もも', '右大腿', 'Thigh_R', 'RightUpperLeg', 'UpperLeg_R', '足R', 'Leg_R'],
  knee_l:   ['左ひざ', '左膝', 'LeftKnee', 'L_Knee', '左ふくらはぎ', '左下腿', 'Calf_L', 'LeftLowerLeg', 'LowerLeg_L', 'ひざL', '膝L'],
  knee_r:   ['右ひざ', '右膝', 'RightKnee', 'R_Knee', '右ふくらはぎ', '右下腿', 'Calf_R', 'RightLowerLeg', 'LowerLeg_R', 'ひざR', '膝R'],
  ankle_l:  ['左足首', 'LeftAnkle', 'L_Ankle', 'Foot_L', 'LeftFoot', '足首L', 'Ankle_L'],
  ankle_r:  ['右足首', 'RightAnkle', 'R_Ankle', 'Foot_R', 'RightFoot', '足首R', 'Ankle_R'],
  toe_l:    ['左足先EX', '左足先', 'LeftToe', 'L_Toe', '左つま先', 'Toe_L', 'LeftToes', 'つま先L', 'Toe_L'],
  toe_r:    ['右足先EX', '右足先', 'RightToe', 'R_Toe', '右つま先', 'Toe_R', 'RightToes', 'つま先R', 'Toe_R'],

  thumb_0_l:  ['左親指１', 'L_Thumb_1', 'LeftThumb_1', '親指L_1', 'Thumb_L_1'],
  thumb_1_l:  ['左親指２', 'L_Thumb_2', 'LeftThumb_2', '親指L_2', 'Thumb_L_2'],
  index_0_l:  ['左人指１', 'L_Index_1', 'LeftIndex_1', '左食指１', '人指L_1', 'Index_L_1'],
  index_1_l:  ['左人指２', 'L_Index_2', 'LeftIndex_2', '左食指２', '人指L_2', 'Index_L_2'],
  index_2_l:  ['左人指３', 'L_Index_3', 'LeftIndex_3', '左食指３', '人指L_3', 'Index_L_3'],
  middle_0_l: ['左中指１', 'L_Middle_1', 'LeftMiddle_1', '中指L_1', 'Middle_L_1'],
  middle_1_l: ['左中指２', 'L_Middle_2', 'LeftMiddle_2', '中指L_2', 'Middle_L_2'],
  middle_2_l: ['左中指３', 'L_Middle_3', 'LeftMiddle_3', '中指L_3', 'Middle_L_3'],
  ring_0_l:   ['左薬指１', 'L_Ring_1', 'LeftRing_1', '薬指L_1', 'Ring_L_1'],
  ring_1_l:   ['左薬指２', 'L_Ring_2', 'LeftRing_2', '薬指L_2', 'Ring_L_2'],
  ring_2_l:   ['左薬指３', 'L_Ring_3', 'LeftRing_3', '薬指L_3', 'Ring_L_3'],
  pinky_0_l:  ['左小指１', 'L_Pinky_1', 'LeftPinky_1', '小指L_1', 'Pinky_L_1'],
  pinky_1_l:  ['左小指２', 'L_Pinky_2', 'LeftPinky_2', '小指L_2', 'Pinky_L_2'],
  pinky_2_l:  ['左小指３', 'L_Pinky_3', 'LeftPinky_3', '小指L_3', 'Pinky_L_3'],

  thumb_0_r:  ['右親指１', 'R_Thumb_1', 'RightThumb_1', '親指R_1', 'Thumb_R_1'],
  thumb_1_r:  ['右親指２', 'R_Thumb_2', 'RightThumb_2', '親指R_2', 'Thumb_R_2'],
  index_0_r:  ['右人指１', 'R_Index_1', 'RightIndex_1', '右食指１', '人指R_1', 'Index_R_1'],
  index_1_r:  ['右人指２', 'R_Index_2', 'RightIndex_2', '右食指２', '人指R_2', 'Index_R_2'],
  index_2_r:  ['右人指３', 'R_Index_3', 'RightIndex_3', '右食指３', '人指R_3', 'Index_R_3'],
  middle_0_r: ['右中指１', 'R_Middle_1', 'RightMiddle_1', '中指R_1', 'Middle_R_1'],
  middle_1_r: ['右中指２', 'R_Middle_2', 'RightMiddle_2', '中指R_2', 'Middle_R_2'],
  middle_2_r: ['右中指３', 'R_Middle_3', 'RightMiddle_3', '中指R_3', 'Middle_R_3'],
  ring_0_r:   ['右薬指１', 'R_Ring_1', 'RightRing_1', '薬指R_1', 'Ring_R_1'],
  ring_1_r:   ['右薬指２', 'R_Ring_2', 'RightRing_2', '薬指R_2', 'Ring_R_2'],
  ring_2_r:   ['右薬指３', 'R_Ring_3', 'RightRing_3', '薬指R_3', 'Ring_R_3'],
  pinky_0_r:  ['右小指１', 'R_Pinky_1', 'RightPinky_1', '小指R_1', 'Pinky_R_1'],
  pinky_1_r:  ['右小指２', 'R_Pinky_2', 'RightPinky_2', '小指R_2', 'Pinky_R_2'],
  pinky_2_r:  ['右小指３', 'R_Pinky_3', 'RightPinky_3', '小指R_3', 'Pinky_R_3'],
};

function _detectSide(name) {
  const n = name.toLowerCase();
  if (/left|_l[^a-z]|^l_/.test(n)) return 'l';
  if (/right|_r[^a-z]|^r_/.test(n)) return 'r';
  if (name.includes('左') && !name.includes('右')) return 'l';
  if (name.includes('右') && !name.includes('左')) return 'r';
  return null;
}

const PART_KEYWORDS = {
  base:        ['全ての親', 'base', 'root'],
  center:      ['センター', 'center', 'groove', '中心'],
  upper_body:  ['上半身', 'upperbody', 'upper_body', 'spine1'],
  lower_body:  ['下半身', 'lowerbody', 'lower_body', 'pelvis', 'hips'],
  waist:       ['腰', 'waist', 'hip', 'spine2'],
  neck:        ['首', 'neck'],
  head:        ['頭', 'head', 'face', '头部'],

  shoulder:    ['肩', 'shoulder'],
  arm:         ['腕', 'arm', 'upperarm'],
  elbow:       ['ひじ', '肘', 'elbow', 'forearm', '前腕', 'lowerarm'],
  wrist:       ['手首', 'wrist', 'hand'],

  leg:         ['足', 'leg', '大腿', '太もも', 'thigh', 'upperleg'],
  knee:        ['ひざ', '膝', 'knee', 'ふくらはぎ', 'calf', '下腿', 'lowerleg'],
  ankle:       ['足首', 'ankle', 'foot'],
  toe:         ['足先', 'toe', 'つま先', 'toes'],

  thumb:       ['親指', 'thumb'],
  index:       ['人指', '食指', 'index'],
  middle:      ['中指', 'middle'],
  ring:        ['薬指', 'ring'],
  pinky:       ['小指', 'pinky'],
};

function _extractPart(semantic) {
  if (semantic.includes('_l') || semantic.includes('_r')) {
    return semantic.slice(0, -2);
  }
  return semantic;
}

function _analyzeBoneHierarchy(bones) {
  const hierarchy = {};
  const parentMap = new Map();
  const childrenMap = new Map();
  
  for (const bone of bones) {
    const parent = bone.parent;
    const parentName = parent?.name || null;
    parentMap.set(bone.name, parentName);
    
    if (!childrenMap.has(parentName)) {
      childrenMap.set(parentName, []);
    }
    childrenMap.get(parentName).push(bone.name);
  }
  
  hierarchy.parentMap = parentMap;
  hierarchy.childrenMap = childrenMap;
  return hierarchy;
}

function _analyzeBonePositions(bones) {
  const positions = {};
  let minY = Infinity, maxY = -Infinity;
  
  const tempMesh = new THREE.Object3D();
  for (const bone of bones) {
    tempMesh.position.set(0, 0, 0);
    tempMesh.quaternion.copy(bone.quaternion);
    tempMesh.updateMatrixWorld(true);
    const worldPos = new THREE.Vector3();
    tempMesh.getWorldPosition(worldPos);
    positions[bone.name] = { x: worldPos.x, y: worldPos.y, z: worldPos.z };
    minY = Math.min(minY, worldPos.y);
    maxY = Math.max(maxY, worldPos.y);
  }
  
  return { positions, minY, maxY, midY: (minY + maxY) / 2 };
}



export async function matchBones(bones, opts = {}) {
  const { debug = false } = opts;
  const boneNames = bones.map(b => b.name);
  const result = {};
  const usedIndices = new Set();
  const report = [];

  const hierarchy = _analyzeBoneHierarchy(bones);
  const posInfo = _analyzeBonePositions(bones);

  for (const semantic of SEMANTIC_BONES) {
    const alts = JP_EXACT[semantic] || [];
    for (const alt of alts) {
      const idx = boneNames.indexOf(alt);
      if (idx !== -1 && !usedIndices.has(idx)) {
        result[semantic] = alt;
        usedIndices.add(idx);
        report.push({ semantic, matched: alt, via: 'exact' });
        break;
      }
    }
  }

  for (const semantic of SEMANTIC_BONES) {
    if (result[semantic]) continue;

    const side = semantic.endsWith('_l') ? 'l' : semantic.endsWith('_r') ? 'r' : null;
    const baseSem = _extractPart(semantic);

    const partKws = PART_KEYWORDS[baseSem];
    if (!partKws) continue;

    const candidates = [];
    for (let i = 0; i < bones.length; i++) {
      if (usedIndices.has(i)) continue;
      const bone = bones[i];
      const name = bone.name;
      const low = name.toLowerCase();
      
      const nmSide = _detectSide(name);
      if (side && nmSide && nmSide !== side) continue;
      if (side && !nmSide && !/[左右]/.test(name) && !/left|right|^[lr]_|_[lr]$/i.test(name)) continue;

      const hasKeyword = partKws.some(kw => name.includes(kw) || low.includes(kw));
      if (!hasKeyword) continue;

      const parentName = hierarchy.parentMap.get(name);
      const y = posInfo.positions[name]?.y || 0;
      
      let score = 5;
      if (side && nmSide === side) score += 2;
      if (parentName && (parentName.includes('肩') || parentName.includes('Shoulder')) && baseSem === 'arm') {
        score += 3;
      }
      if (parentName && (parentName.includes('腰') || parentName.includes('Pelvis') || parentName.includes('Hip')) && baseSem === 'leg') {
        score += 3;
      }
      if (baseSem === 'leg' && y < posInfo.midY) score += 2;
      if (baseSem === 'arm' && y > posInfo.midY) score += 2;

      candidates.push({ idx: i, name, parentName, y, score, bone });
    }

    if (candidates.length === 0) {
      report.push({ semantic, matched: null, via: 'none' });
      continue;
    }

    candidates.sort((a, b) => b.score - a.score);

    let selected = candidates[0];

    if (selected) {
      result[semantic] = selected.name;
      usedIndices.add(selected.idx);
      report.push({ semantic, matched: selected.name, via: 'fuzzy', score: selected.score });
    }
  }

  try {
    const raw = localStorage.getItem('mmd_bone_overrides');
    if (raw) {
      const overrides = JSON.parse(raw);
      for (const semantic of Object.keys(overrides)) {
        const want = overrides[semantic];
        const idx = boneNames.indexOf(want);
        if (idx !== -1) {
          result[semantic] = want;
          report.push({ semantic, matched: want, via: 'override' });
        }
      }
    }
  } catch (e) { /* ignore */ }

  if (debug) {
    const hit = Object.keys(result).length;
    console.log(`[boneMatcher] ✅ 匹配 ${hit}/${SEMANTIC_BONES.length} 个骨骼`);
    const missing = SEMANTIC_BONES.filter(s => !result[s]);
    if (missing.length) {
      console.warn('[boneMatcher] ⚠️ 未匹配:', missing);
    }
  }

  return { map: result, report, allNames: boneNames, hierarchy, posInfo };
}

export function toJPMap(matchResult) {
  return matchResult.map;
}

export function saveOverride(semantic, actualName) {
  try {
    const raw = localStorage.getItem('mmd_bone_overrides');
    const obj = raw ? JSON.parse(raw) : {};
    obj[semantic] = actualName;
    localStorage.setItem('mmd_bone_overrides', JSON.stringify(obj));
    return true;
  } catch (e) { return false; }
}

export function clearOverrides() {
  try { localStorage.removeItem('mmd_bone_overrides'); } catch (e) {}
}

export function getOverrides() {
  try { return JSON.parse(localStorage.getItem('mmd_bone_overrides') || '{}'); }
  catch (e) { return {}; }
}

export const SEMANTIC_BONE_LIST = SEMANTIC_BONES;
