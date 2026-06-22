// ============================================================================
//  ⚠️ 此文件已弃用
//
//  旧的 MMDAnimator 已被替换为模块化的新版数字人系统：
//
//    src/core/behaviorEngine.js    行为状态引擎
//    src/core/motionGenerator.js   动作参数生成器（函数级运动）
//    src/core/skeletonController.js 骨骼控制器（IK + 弹簧）
//    src/core/avatarCore.js        数字人主控（推荐入口）
//
//  使用方法:
//    import { createAvatar } from './src/core/avatarCore.js';
//    const avatar = createAvatar(mesh, { scene });
//
//  保留此文件仅为防止旧 import 报"找不到类"的错误；
//  MMDAnimator 已不再导出，遇到引用时立即抛错以便快速定位。
// ============================================================================

export class MMDAnimator {
  constructor() {
    throw new Error(
      '[animator.js] MMDAnimator 已弃用。\n' +
      '请改用: import { createAvatar } from "./src/core/avatarCore.js"'
    );
  }
}

export default MMDAnimator;
