/**
 * MPL WASM 编译器包装器
 * 基于官方 mmd-mpl npm 包（与 PoPo 项目相同）
 * 提供：MPS → VMD 编译、骨骼约束查询、骨骼名称映射
 */
import init, { WasmMPLCompiler } from 'mmd-mpl';

let compiler = null;
let initialized = false;
let initPromise = null;

/** 初始化 WASM 编译器（只需调用一次） */
export async function initMPLCompiler() {
  if (initPromise) return initPromise;
  if (initialized) return;

  initPromise = (async () => {
    await init();
    compiler = new WasmMPLCompiler();
    initialized = true;
    console.log('[MPLWasm] ✅ WASM 编译器已初始化');
    console.log('[MPLWasm] 支持骨骼:', compiler.get_all_bones().length, '个');
  })();

  return initPromise;
}

/** 确保编译器已初始化 */
async function ensureInit() {
  if (!initialized) {
    await initMPLCompiler();
  }
}

/** 编译 MPL 脚本为 VMD 二进制数据 */
export async function compileMPLToVMD(script) {
  await ensureInit();
  return compiler.compile(script);
}

/** 获取骨骼角度限制 */
export async function getBoneDegreeLimit(bone, action, direction) {
  await ensureInit();
  return compiler.get_bone_degree_limit(bone, action, direction);
}

/** 获取骨骼日文名称 */
export async function getBoneJapaneseName(bone) {
  await ensureInit();
  return compiler.get_bone_japanese_name(bone);
}

/** 获取骨骼英文名称 */
export async function getBoneEnglishName(bone) {
  await ensureInit();
  return compiler.get_bone_english_name(bone);
}

/** 获取所有支持的骨骼列表 */
export async function getAllBones() {
  await ensureInit();
  return compiler.get_all_bones();
}

/** 获取骨骼支持的动作类型 */
export async function getBoneActions(bone) {
  await ensureInit();
  return compiler.get_bone_actions(bone);
}

/** 获取骨骼支持的方向 */
export async function getBoneDirections(bone, action) {
  await ensureInit();
  return compiler.get_bone_directions(bone, action);
}

/** 构建完整的骨骼名称映射表（MPL英文名 → 日文名） */
export async function buildBoneNameMap() {
  await ensureInit();
  const bones = compiler.get_all_bones();
  const map = {};
  for (const bone of bones) {
    const jp = compiler.get_bone_japanese_name(bone);
    if (jp) {
      map[bone] = jp;
    }
  }
  return map;
}

/** 构建完整的骨骼约束表（所有骨骼 x 动作 x 方向的角度限制） */
export async function buildConstraintTable() {
  await ensureInit();
  const bones = compiler.get_all_bones();
  const table = {};

  for (const bone of bones) {
    const actions = compiler.get_bone_actions(bone);
    if (!actions) continue;

    const boneConstraints = {};
    for (const action of actions) {
      const directions = compiler.get_bone_directions(bone, action);
      if (!directions) continue;

      const dirConstraints = {};
      for (const direction of directions) {
        const limit = compiler.get_bone_degree_limit(bone, action, direction);
        if (limit !== undefined) {
          dirConstraints[direction] = limit;
        }
      }
      if (Object.keys(dirConstraints).length > 0) {
        boneConstraints[action] = dirConstraints;
      }
    }
    if (Object.keys(boneConstraints).length > 0) {
      table[bone] = boneConstraints;
    }
  }

  return table;
}

/** 构建有效组合表 (bone → { action: [dirKeys] } )，用于 VMD 反编译过滤 */
export async function buildValidCombos() {
  await ensureInit();
  const bones = compiler.get_all_bones();
  const combos = {};

  for (const bone of bones) {
    const actions = compiler.get_bone_actions(bone);
    if (!actions || actions.length === 0) continue;

    const boneCombos = {};
    for (const action of actions) {
      const directions = compiler.get_bone_directions(bone, action);
      if (directions && directions.length > 0) {
        boneCombos[action] = directions;
      }
    }
    if (Object.keys(boneCombos).length > 0) {
      combos[bone] = boneCombos;
    }
  }

  return combos;
}