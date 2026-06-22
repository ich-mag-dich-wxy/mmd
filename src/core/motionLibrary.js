// motionLibrary.js — 动作标准库（Motion Standard Library）
// ❌ 禁止从零生成动作 | ✅ 只能组合标准库动作
// 每个动作包含：poseDefinitions, animation, emotionScale

export const MOTION_LIBRARY = {
  // ═══════════════════════════════════════════════════════════
  // 🧍 IDLE 静止类
  // ═══════════════════════════════════════════════════════════
  idle: {
    name: 'idle',
    duration: 2.0,
    poses: {
      idle_start: {
        upper_body: { sway: { right: 3 } },
        waist: { sway: { right: 2 } },
      },
      idle_mid: {
        upper_body: { sway: { left: 3 } },
        waist: { sway: { left: 2 } },
      },
      idle_rest: {
        upper_body: { sway: { right: 0 } },
        waist: { sway: { right: 0 } },
      },
    },
    timeline: {
      0.0: 'idle_start',
      1.0: 'idle_mid',
      2.0: 'idle_rest',
    },
    emotionScale: {
      neutral: { all: 1.0 },
      happy: { upper_body: 1.2, waist: 1.2 },
      sad: { upper_body: 0.6, waist: 0.6 },
      excited: { upper_body: 1.5, waist: 1.5 },
    },
    energyScale: { low: 0.7, medium: 1.0, high: 1.3 },
  },

  // ═══════════════════════════════════════════════════════════
  // 🖐️ WAVE 挥手类
  // ═══════════════════════════════════════════════════════════
  wave: {
    name: 'wave',
    duration: 1.6,
    poses: {
      wave_prepare: {
        shoulder_r: { bend: { forward: 20 } },
        arm_r: { bend: { forward: 40 } },
        elbow_r: { bend: { forward: 10 } },
        upper_body: { turn: { right: 8 } },
      },
      wave_high: {
        shoulder_r: { bend: { forward: 35 } },
        arm_r: { bend: { forward: 95 } },
        elbow_r: { bend: { forward: 0 } },
        wrist_r: { bend: { forward: 25 } },
        upper_body: { turn: { right: 12 } },
      },
      wave_low: {
        shoulder_r: { bend: { forward: 28 } },
        arm_r: { bend: { forward: 75 } },
        elbow_r: { bend: { forward: 20 } },
        wrist_r: { bend: { forward: 45 } },
        upper_body: { turn: { right: 10 } },
      },
      wave_rest: {
        shoulder_r: { bend: { forward: 0 } },
        arm_r: { bend: { forward: 0 } },
        elbow_r: { bend: { forward: 0 } },
        wrist_r: { bend: { forward: 0 } },
        upper_body: { turn: { right: 0 } },
      },
    },
    timeline: {
      0.0: 'wave_prepare',
      0.3: 'wave_high',
      0.55: 'wave_low',
      0.8: 'wave_high',
      1.05: 'wave_low',
      1.3: 'wave_high',
      1.5: 'wave_rest',
    },
    emotionScale: {
      neutral: { all: 1.0 },
      happy: { arm_r: 1.2, wrist_r: 1.3, upper_body: 1.2 },
      sad: { arm_r: 0.7, wrist_r: 0.5 },
      excited: { arm_r: 1.3, wrist_r: 1.5, shoulder_r: 1.2 },
    },
    energyScale: { low: 0.7, medium: 1.0, high: 1.3 },
  },

  // ═══════════════════════════════════════════════════════════
  // 😊 NOD 点头类
  // ═══════════════════════════════════════════════════════════
  nod: {
    name: 'nod',
    duration: 1.2,
    poses: {
      nod_start: {
        head: { bend: { forward: 0 } },
        neck: { bend: { forward: 0 } },
      },
      nod_down: {
        head: { bend: { forward: 30 } },
        neck: { bend: { forward: 15 } },
      },
      nod_up: {
        head: { bend: { backward: 8 } },
        neck: { bend: { forward: 2 } },
      },
      nod_rest: {
        head: { bend: { forward: 0 } },
        neck: { bend: { forward: 0 } },
      },
    },
    timeline: {
      0.0: 'nod_start',
      0.15: 'nod_down',
      0.4: 'nod_up',
      0.65: 'nod_down',
      0.95: 'nod_rest',
    },
    emotionScale: {
      neutral: { all: 1.0 },
      happy: { head: 1.2, neck: 1.1 },
      sad: { head: 1.3, neck: 1.2 },
      excited: { head: 1.4, neck: 1.2 },
    },
    energyScale: { low: 0.7, medium: 1.0, high: 1.3 },
  },

  // ═══════════════════════════════════════════════════════════
  // 🙅 SHAKE 摇头类
  // ═══════════════════════════════════════════════════════════
  shake: {
    name: 'shake',
    duration: 1.2,
    poses: {
      shake_start: { head: { turn: { right: 0 } } },
      shake_left: { head: { turn: { left: 35 } } },
      shake_right: { head: { turn: { right: 35 } } },
      shake_rest: { head: { turn: { right: 0 } } },
    },
    timeline: {
      0.0: 'shake_start',
      0.2: 'shake_left',
      0.4: 'shake_right',
      0.6: 'shake_left',
      0.8: 'shake_right',
      1.0: 'shake_rest',
    },
    emotionScale: {
      neutral: { all: 1.0 },
      happy: { head: 1.1 },
      sad: { head: 0.8 },
      excited: { head: 1.3 },
    },
    energyScale: { low: 0.7, medium: 1.0, high: 1.3 },
  },

  // ═══════════════════════════════════════════════════════════
  // 🦵 KICK 踢腿类
  // ═══════════════════════════════════════════════════════════
  kick: {
    name: 'kick',
    duration: 1.6,
    poses: {
      kick_ready: {
        leg_r: { bend: { forward: 20 } },
        knee_r: { bend: { backward: 30 } },
        upper_body: { bend: { backward: 8 } },
      },
      kick_up: {
        leg_r: { bend: { forward: 70 } },
        knee_r: { bend: { forward: 15 } },
        upper_body: { bend: { forward: 15 } },
        arm_l: { bend: { backward: 40 } },
        arm_r: { bend: { forward: 20 } },
      },
      kick_down: {
        leg_r: { bend: { forward: 15 } },
        knee_r: { bend: { backward: 25 } },
        upper_body: { bend: { forward: 5 } },
      },
      kick_rest: {
        leg_r: { bend: { forward: 0 } },
        knee_r: { bend: { backward: 0 } },
        upper_body: { bend: { forward: 0 } },
        arm_l: { bend: { backward: 0 } },
        arm_r: { bend: { forward: 0 } },
      },
    },
    timeline: {
      0.0: 'kick_ready',
      0.3: 'kick_up',
      0.9: 'kick_down',
      1.3: 'kick_rest',
    },
    emotionScale: {
      neutral: { all: 1.0 },
      happy: { leg_r: 1.1, upper_body: 1.2 },
      sad: { leg_r: 0.8, upper_body: 0.7 },
      excited: { leg_r: 1.3, upper_body: 1.3, arm_l: 1.2, arm_r: 1.2 },
    },
    energyScale: { low: 0.7, medium: 1.0, high: 1.3 },
  },

  // ═══════════════════════════════════════════════════════════
  // 🚶 WALK 走路类
  // ═══════════════════════════════════════════════════════════
  walk: {
    name: 'walk',
    duration: 1.8,
    poses: {
      walk_start: {
        leg_l: { bend: { forward: 0 } },
        leg_r: { bend: { forward: 0 } },
        arm_l: { bend: { backward: 0 } },
        arm_r: { bend: { forward: 0 } },
        waist: { bend: { forward: 0 } },
      },
      walk_l: {
        leg_l: { bend: { forward: 35 } },
        leg_r: { bend: { backward: 25 } },
        arm_l: { bend: { backward: 25 } },
        arm_r: { bend: { forward: 25 } },
        waist: { bend: { forward: 5 } },
        upper_body: { sway: { right: 5 } },
      },
      walk_r: {
        leg_r: { bend: { forward: 35 } },
        leg_l: { bend: { backward: 25 } },
        arm_r: { bend: { backward: 25 } },
        arm_l: { bend: { forward: 25 } },
        waist: { bend: { forward: 5 } },
        upper_body: { sway: { left: 5 } },
      },
      walk_rest: {
        leg_l: { bend: { forward: 0 } },
        leg_r: { bend: { forward: 0 } },
        arm_l: { bend: { backward: 0 } },
        arm_r: { bend: { forward: 0 } },
        waist: { bend: { forward: 0 } },
        upper_body: { sway: { right: 0 } },
      },
    },
    timeline: {
      0.0: 'walk_start',
      0.3: 'walk_l',
      0.6: 'walk_r',
      0.9: 'walk_l',
      1.2: 'walk_r',
      1.5: 'walk_rest',
    },
    emotionScale: {
      neutral: { all: 1.0 },
      happy: { arm_l: 1.3, arm_r: 1.3, leg_l: 1.1, leg_r: 1.1 },
      sad: { arm_l: 0.7, arm_r: 0.7, leg_l: 0.8, leg_r: 0.8 },
      excited: { arm_l: 1.4, arm_r: 1.4, leg_l: 1.2, leg_r: 1.2, upper_body: 1.2 },
    },
    energyScale: { low: 0.7, medium: 1.0, high: 1.3 },
  },

  // ═══════════════════════════════════════════════════════════
  // 🙋 RAISE 举手类
  // ═══════════════════════════════════════════════════════════
  raise: {
    name: 'raise',
    duration: 2.2,
    poses: {
      raise_ready: {
        arm_l: { bend: { forward: 10 } },
        shoulder_l: { bend: { forward: 10 } },
      },
      raise_up: {
        arm_l: { bend: { forward: 10 } },
        arm_l: { sway: { right: 110 } },
        elbow_l: { bend: { backward: 15 } },
        shoulder_l: { bend: { forward: 30 } },
        wrist_l: { bend: { forward: 0 } },
        upper_body: { turn: { right: 5 } },
      },
      raise_hold: {
        arm_l: { sway: { right: 110 } },
        elbow_l: { bend: { backward: 10 } },
        shoulder_l: { bend: { forward: 30 } },
      },
      raise_rest: {
        arm_l: { sway: { right: 0 } },
        elbow_l: { bend: { backward: 0 } },
        shoulder_l: { bend: { forward: 0 } },
        upper_body: { turn: { right: 0 } },
      },
    },
    timeline: {
      0.0: 'raise_ready',
      0.4: 'raise_up',
      1.8: 'raise_hold',
      2.2: 'raise_rest',
    },
    emotionScale: {
      neutral: { all: 1.0 },
      happy: { arm_l: 1.1, shoulder_l: 1.1 },
      sad: { arm_l: 0.8, shoulder_l: 0.7 },
      excited: { arm_l: 1.2, shoulder_l: 1.3, upper_body: 1.2 },
    },
    energyScale: { low: 0.7, medium: 1.0, high: 1.3 },
  },

  // ═══════════════════════════════════════════════════════════
  // 💃 DANCE 跳舞类
  // ═══════════════════════════════════════════════════════════
  dance: {
    name: 'dance',
    duration: 1.8,
    poses: {
      dance_1: {
        arm_r: { bend: { forward: 80 } },
        arm_l: { bend: { backward: 40 } },
        leg_r: { bend: { forward: 20 } },
        upper_body: { turn: { right: 15 } },
        waist: { sway: { right: 8 } },
      },
      dance_2: {
        arm_r: { bend: { backward: 40 } },
        arm_l: { bend: { forward: 80 } },
        leg_l: { bend: { forward: 20 } },
        upper_body: { turn: { left: 15 } },
        waist: { sway: { left: 8 } },
      },
      dance_rest: {
        arm_r: { bend: { forward: 0 } },
        arm_l: { bend: { forward: 0 } },
        leg_r: { bend: { forward: 0 } },
        leg_l: { bend: { forward: 0 } },
        upper_body: { turn: { right: 0 } },
        waist: { sway: { right: 0 } },
      },
    },
    timeline: {
      0.0: 'dance_rest',
      0.3: 'dance_1',
      0.6: 'dance_2',
      0.9: 'dance_1',
      1.2: 'dance_2',
      1.5: 'dance_rest',
    },
    emotionScale: {
      neutral: { all: 1.0 },
      happy: { arm_l: 1.3, arm_r: 1.3, upper_body: 1.2, waist: 1.3 },
      sad: { arm_l: 0.7, arm_r: 0.7 },
      excited: { arm_l: 1.5, arm_r: 1.5, upper_body: 1.4, waist: 1.5, leg_l: 1.2, leg_r: 1.2 },
    },
    energyScale: { low: 0.7, medium: 1.0, high: 1.3 },
  },

  // ═══════════════════════════════════════════════════════════
  // 👋 GREET 打招呼类
  // ═══════════════════════════════════════════════════════════
  greet: {
    name: 'greet',
    duration: 1.5,
    poses: {
      greet_prepare: {
        shoulder_r: { bend: { forward: 15 } },
        arm_r: { bend: { forward: 30 } },
        upper_body: { bend: { forward: 10 } },
      },
      greet_wave: {
        shoulder_r: { bend: { forward: 30 } },
        arm_r: { bend: { forward: 85 } },
        elbow_r: { bend: { forward: 5 } },
        wrist_r: { bend: { forward: 30 } },
        upper_body: { turn: { right: 10 } },
      },
      greet_hold: {
        shoulder_r: { bend: { forward: 28 } },
        arm_r: { bend: { forward: 75 } },
        wrist_r: { bend: { forward: 40 } },
      },
      greet_rest: {
        shoulder_r: { bend: { forward: 0 } },
        arm_r: { bend: { forward: 0 } },
        elbow_r: { bend: { forward: 0 } },
        wrist_r: { bend: { forward: 0 } },
        upper_body: { bend: { forward: 0 }, turn: { right: 0 } },
      },
    },
    timeline: {
      0.0: 'greet_prepare',
      0.3: 'greet_wave',
      0.6: 'greet_hold',
      0.9: 'greet_wave',
      1.2: 'greet_hold',
      1.4: 'greet_rest',
    },
    emotionScale: {
      neutral: { all: 1.0 },
      happy: { arm_r: 1.2, wrist_r: 1.3, upper_body: 1.2 },
      sad: { arm_r: 0.7, wrist_r: 0.5 },
      excited: { arm_r: 1.3, wrist_r: 1.5, shoulder_r: 1.3, upper_body: 1.3 },
    },
    energyScale: { low: 0.7, medium: 1.0, high: 1.3 },
  },

  // ═══════════════════════════════════════════════════════════
  // 😊 POINT 指方向
  // ═══════════════════════════════════════════════════════════
  point: {
    name: 'point',
    duration: 2.0,
    poses: {
      point_prepare: {
        arm_l: { bend: { forward: 15 } },
        shoulder_l: { bend: { forward: 10 } },
      },
      point_extend: {
        arm_l: { bend: { forward: 5 } },
        arm_l: { sway: { right: 85 } },
        elbow_l: { bend: { backward: 5 } },
        shoulder_l: { bend: { forward: 25 } },
        head: { turn: { left: 15 } },
        upper_body: { turn: { right: 8 } },
      },
      point_hold: {
        arm_l: { sway: { right: 85 } },
        elbow_l: { bend: { backward: 5 } },
        shoulder_l: { bend: { forward: 25 } },
        head: { turn: { left: 15 } },
      },
      point_rest: {
        arm_l: { sway: { right: 0 } },
        elbow_l: { bend: { backward: 0 } },
        shoulder_l: { bend: { forward: 0 } },
        head: { turn: { left: 0 } },
        upper_body: { turn: { right: 0 } },
      },
    },
    timeline: {
      0.0: 'point_prepare',
      0.4: 'point_extend',
      1.6: 'point_hold',
      2.0: 'point_rest',
    },
    emotionScale: {
      neutral: { all: 1.0 },
      happy: { arm_l: 1.1, head: 1.1 },
      sad: { arm_l: 0.8, head: 0.9 },
      excited: { arm_l: 1.2, head: 1.2, upper_body: 1.2 },
    },
    energyScale: { low: 0.7, medium: 1.0, high: 1.3 },
  },

  // ═══════════════════════════════════════════════════════════
  // 🙇 BOW 鞠躬类
  // ═══════════════════════════════════════════════════════════
  bow: {
    name: 'bow',
    duration: 1.6,
    poses: {
      bow_start: {
        upper_body: { bend: { forward: 15 } },
        waist: { bend: { forward: 20 } },
        head: { bend: { forward: 25 } },
      },
      bow_deep: {
        upper_body: { bend: { forward: 35 } },
        waist: { bend: { forward: 45 } },
        head: { bend: { forward: 40 } },
        arm_l: { bend: { forward: 30 } },
        arm_r: { bend: { forward: 30 } },
      },
      bow_up: {
        upper_body: { bend: { forward: 15 } },
        waist: { bend: { forward: 20 } },
        head: { bend: { forward: 25 } },
      },
      bow_rest: {
        upper_body: { bend: { forward: 0 } },
        waist: { bend: { forward: 0 } },
        head: { bend: { forward: 0 } },
        arm_l: { bend: { forward: 0 } },
        arm_r: { bend: { forward: 0 } },
      },
    },
    timeline: {
      0.0: 'bow_start',
      0.3: 'bow_deep',
      1.0: 'bow_up',
      1.6: 'bow_rest',
    },
    emotionScale: {
      neutral: { all: 1.0 },
      happy: { upper_body: 1.1, waist: 1.1, head: 1.1 },
      sad: { upper_body: 1.2, waist: 1.2, head: 1.3 },
      excited: { upper_body: 1.1, waist: 1.1 },
    },
    energyScale: { low: 0.7, medium: 1.0, high: 1.3 },
  },
};

// 动作名 → 标准库动作的映射（用于中文别名）
export const ACTION_ALIAS = {
  '挥手': 'wave',
  '挥手打招呼': 'wave',
  '招手': 'wave',
  '挥动': 'wave',
  '点头': 'nod',
  '同意': 'nod',
  '点头同意': 'nod',
  '摇头': 'shake',
  '不同意': 'shake',
  '摇头否定': 'shake',
  '踢腿': 'kick',
  '抬腿': 'kick',
  '抬脚': 'kick',
  '走路': 'walk',
  '行走': 'walk',
  '散步': 'walk',
  '跳舞': 'dance',
  '舞动': 'dance',
  '跳': 'dance',
  '举手': 'raise',
  '举起手': 'raise',
  '回答': 'raise',
  '指': 'point',
  '指向': 'point',
  '指方向': 'point',
  '打招呼': 'greet',
  '问候': 'greet',
  '你好': 'greet',
  '鞠躬': 'bow',
  '敬礼': 'bow',
  '弯腰': 'bow',
  '站立': 'idle',
  '静止': 'idle',
  '别动': 'idle',
  '发呆': 'idle',
};

// 情绪名映射
export const EMOTION_MAP = {
  '中性': 'neutral',
  '一般': 'neutral',
  '普通': 'neutral',
  '开心': 'happy',
  '高兴': 'happy',
  '快乐': 'happy',
  '开心地': 'happy',
  '高兴地': 'happy',
  '悲伤': 'sad',
  '难过': 'sad',
  '伤心': 'sad',
  '难过地': 'sad',
  '兴奋': 'excited',
  '激动': 'excited',
  '热情': 'excited',
  '激动地': 'excited',
  '兴奋地': 'excited',
};

// 能量/强度映射
export const ENERGY_MAP = {
  '慢': 'low',
  '轻': 'low',
  '轻微': 'low',
  '慢慢地': 'low',
  '轻轻地': 'low',
  '正常': 'medium',
  '一般': 'medium',
  '中等': 'medium',
  '快速': 'high',
  '用力': 'high',
  '大': 'high',
  '用力地': 'high',
  '大力': 'high',
};

// 获取动作（支持情绪和能量缩放）
export function getMotion(actionName, emotion = 'neutral', energy = 'medium') {
  // 尝试别名映射
  let motionKey = ACTION_ALIAS[actionName] || actionName;
  if (!MOTION_LIBRARY[motionKey]) {
    motionKey = 'idle';
  }

  const motion = MOTION_LIBRARY[motionKey];
  const emoScale = motion.emotionScale[emotion] || motion.emotionScale.neutral;
  const engScale = motion.energyScale[energy] || 1.0;

  // 深拷贝并缩放
  return {
    name: motion.name,
    duration: motion.duration,
    poses: scalePoses(motion.poses, emoScale, engScale),
    timeline: { ...motion.timeline },
  };
}

// 按比例缩放 pose 角度
function scalePoses(poses, emoScale, engScale) {
  const result = {};
  for (const [poseName, boneDefs] of Object.entries(poses)) {
    result[poseName] = {};
    for (const [boneName, actions] of Object.entries(boneDefs)) {
      result[poseName][boneName] = {};
      for (const [actionName, params] of Object.entries(actions)) {
        result[poseName][boneName][actionName] = {};
        for (const [dir, angle] of Object.entries(params)) {
          const boneScale = emoScale.all || emoScale[boneName] || 1.0;
          result[poseName][boneName][actionName][dir] = angle * boneScale * engScale;
        }
      }
    }
  }
  return result;
}

// 列出所有可用动作
export function listAvailableActions() {
  return Object.keys(MOTION_LIBRARY);
}

// 检查动作是否存在
export function hasAction(actionName) {
  return !!(ACTION_ALIAS[actionName] || MOTION_LIBRARY[actionName]);
}

console.log('[Motion Library] ✅ 已加载', Object.keys(MOTION_LIBRARY).length, '个标准动作');
