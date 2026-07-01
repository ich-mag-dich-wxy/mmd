// ═══════════════════════════════════════════════════════════
//  MPL WASM 编译器封装
//  使用 mmd-mpl npm 包，将 MPL 脚本编译为 VMD 二进制（WASM，极快）
//  同时支持 VMD/VPD 反编译为 MPL 文本
// ═══════════════════════════════════════════════════════════

let _compiler = null;
let _initPromise = null;

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
 * MPL 格式特征：包含 @pose / @animation / main 关键字
 */
export function isMPLScript(text) {
  const head = text.slice(0, 2000);
  return /@pose\s+\w+\s*\{/.test(head) ||
         /@animation\s+\w+\s*\{/.test(head) ||
         /^main\s*\{/m.test(head);
}

/**
 * 将 MPL 脚本编译为 VMD 二进制
 * @param {string} script MPL 脚本
 * @returns {Promise<Uint8Array>} VMD 二进制数据
 */
export async function compileMPLToVMD(script) {
  const compiler = await getMPLCompiler();
  const bytes = compiler.compile(script);
  if (!bytes || bytes.length === 0) {
    throw new Error('MPL 编译结果为空，请检查脚本语法');
  }
  return bytes;
}

/**
 * 将 VMD 二进制反编译为 MPL 脚本
 * @param {Uint8Array} vmdBytes VMD 二进制数据
 * @returns {Promise<string>} MPL 脚本
 */
export async function reverseCompileVMD(vmdBytes) {
  const compiler = await getMPLCompiler();
  return compiler.reverse_compile('vmd', vmdBytes);
}

/**
 * 将 VPD 二进制反编译为 MPL 脚本
 * @param {Uint8Array} vpdBytes VPD 二进制数据
 * @returns {Promise<string>} MPL 脚本
 */
export async function reverseCompileVPD(vpdBytes) {
  const compiler = await getMPLCompiler();
  return compiler.reverse_compile('vpd', vpdBytes);
}
