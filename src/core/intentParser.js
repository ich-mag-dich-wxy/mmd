// intentParser.js — 意图解析器（Intent Parser）
// 输入：自然语言（如"挥手打招呼并点头"）
// 输出：Intent JSON — { action, sub_actions, emotion, energy, target }

import { ACTION_ALIAS, EMOTION_MAP, ENERGY_MAP, hasAction } from './motionLibrary.js';

// 动作关键词模式
const ACTION_PATTERNS = [
  // 复杂动作优先
  { pattern: /挥手打招呼|挥手问好|招手打招呼/, actions: ['wave', 'greet'] },
  { pattern: /挥手点头|招手点头/, actions: ['wave', 'nod'] },
  { pattern: /打招呼并点头|打招呼点头/, actions: ['greet', 'nod'] },
  { pattern: /挥手并点头|挥手点头/, actions: ['wave', 'nod'] },
  { pattern: /开心挥手|高兴挥手/, actions: ['wave'], emotion: 'happy' },
  { pattern: /兴奋跳舞|激动跳舞/, actions: ['dance'], emotion: 'excited' },
  { pattern: /难过低头|伤心低头/, actions: ['nod'], emotion: 'sad' },

  // 单动作
  { pattern: /挥手|招手|打招呼|问候|问好/, actions: ['greet'] },
  { pattern: /点头|同意|认可|嗯|好/, actions: ['nod'] },
  { pattern: /摇头|不同意|不认可|不要|no/, actions: ['shake'] },
  { pattern: /踢腿|抬腿|抬脚|踢/, actions: ['kick'] },
  { pattern: /走路|行走|散步|走/, actions: ['walk'] },
  { pattern: /跳舞|舞动|跳起来|蹦迪/, actions: ['dance'] },
  { pattern: /举手|举起手|提问|回答/, actions: ['raise'] },
  { pattern: /指向|指方向|指一下|指/, actions: ['point'] },
  { pattern: /鞠躬|敬礼|弯腰|点头致意/, actions: ['bow'] },
  { pattern: /站立|别动|静止|发呆|不动/, actions: ['idle'] },
];

// 情感关键词
const EMOTION_PATTERNS = [
  { pattern: /开心|高兴|快乐|愉快|兴高采烈|开心地|高兴地|快乐地/, emotion: 'happy' },
  { pattern: /悲伤|难过|伤心|失望|沮丧|难过地|悲伤地/, emotion: 'sad' },
  { pattern: /兴奋|激动|热情|热情地|激动地|兴奋地/, emotion: 'excited' },
];

// 能量/强度关键词
const ENERGY_PATTERNS = [
  { pattern: /慢|轻|轻微|慢慢地|轻轻地|缓缓/, energy: 'low' },
  { pattern: /快速|用力|大力|用力地|快|狠狠地|用力/, energy: 'high' },
  { pattern: /正常|一般|中等|适中/, energy: 'medium' },
];

// 目标关键词
const TARGET_PATTERNS = [
  { pattern: /用户|你|对方|观众/, target: 'user' },
  { pattern: /前方|前面|正前方/, target: 'front' },
  { pattern: /左边|左侧/, target: 'left' },
  { pattern: /右边|右侧/, target: 'right' },
  { pattern: /镜子|自己|镜像/, target: 'self' },
];

// 顺序关键词
const SEQUENCE_PATTERNS = [
  { pattern: /然后|接着|之后|再|随后|之后再/, type: 'sequence' },
  { pattern: /并|同时|一边|一边|一起/, type: 'parallel' },
];

/**
 * 解析用户自然语言输入为结构化意图
 * @param {string} userText 用户自然语言输入
 * @returns {Object} Intent JSON
 */
export function parseIntent(userText) {
  if (!userText || typeof userText !== 'string') {
    return {
      action: 'idle',
      sub_actions: ['idle'],
      emotion: 'neutral',
      energy: 'medium',
      target: 'user',
      raw: userText || '',
      confidence: 0.3,
    };
  }

  const text = userText.trim();
  const subActions = [];
  let emotion = 'neutral';
  let energy = 'medium';
  let target = 'user';
  let confidence = 0.5;

  // 1. 检查复杂动作模式（优先匹配）
  for (const p of ACTION_PATTERNS) {
    if (p.pattern.test(text)) {
      for (const a of p.actions) {
        if (!subActions.includes(a)) {
          subActions.push(a);
        }
      }
      if (p.emotion) emotion = p.emotion;
      confidence = Math.max(confidence, 0.9);
    }
  }

  // 2. 如果没有匹配到，用简单关键词匹配
  if (subActions.length === 0) {
    for (const [alias, motionName] of Object.entries(ACTION_ALIAS)) {
      if (text.includes(alias)) {
        if (!subActions.includes(motionName)) {
          subActions.push(motionName);
        }
        confidence = Math.max(confidence, 0.8);
      }
    }
  }

  // 3. 情感检测
  for (const p of EMOTION_PATTERNS) {
    if (p.pattern.test(text)) {
      emotion = p.emotion;
      confidence = Math.max(confidence, 0.95);
      break;
    }
  }

  // 4. 能量检测
  for (const p of ENERGY_PATTERNS) {
    if (p.pattern.test(text)) {
      energy = p.energy;
      confidence = Math.max(confidence, 0.9);
      break;
    }
  }

  // 5. 目标检测
  for (const p of TARGET_PATTERNS) {
    if (p.pattern.test(text)) {
      target = p.target;
      break;
    }
  }

  // 6. 如果还是没有匹配到动作，检查是否是纯对话
  if (subActions.length === 0) {
    // 纯对话 → idle 动作
    const isPureDialog = /[\u4e00-\u9fa5]/.test(text) || /[a-zA-Z]/.test(text);
    if (isPureDialog) {
      return {
        action: 'idle',
        sub_actions: ['idle'],
        emotion: 'neutral',
        energy: 'medium',
        target: 'user',
        raw: text,
        confidence: 0.6,
        isDialogOnly: true,
      };
    }
    subActions.push('idle');
  }

  // 7. 检查顺序关系（并 vs 然后）
  const executionType = /然后|接着|之后|再|随后/.test(text) ? 'sequence' : 'parallel';

  return {
    action: subActions[0],
    sub_actions: subActions,
    emotion: emotion,
    energy: energy,
    target: target,
    executionType: executionType, // 'sequence' 或 'parallel'
    raw: text,
    confidence: confidence,
  };
}

/**
 * 验证意图是否有效
 * @param {Object} intent
 * @returns {boolean}
 */
export function validateIntent(intent) {
  if (!intent || !intent.sub_actions || intent.sub_actions.length === 0) {
    return false;
  }

  // 检查每个子动作是否在标准库中
  for (const action of intent.sub_actions) {
    if (!hasAction(action)) {
      console.warn('[Intent Parser] ⚠️ 未知动作:', action);
      return false;
    }
  }

  // 检查情绪和能量
  if (!['neutral', 'happy', 'sad', 'excited'].includes(intent.emotion)) {
    intent.emotion = 'neutral';
  }
  if (!['low', 'medium', 'high'].includes(intent.energy)) {
    intent.energy = 'medium';
  }

  return true;
}

/**
 * 合并多个意图（用于复杂对话）
 * @param {Array<Object>} intents
 * @returns {Object}
 */
export function mergeIntents(intents) {
  if (!intents || intents.length === 0) {
    return {
      action: 'idle',
      sub_actions: ['idle'],
      emotion: 'neutral',
      energy: 'medium',
      target: 'user',
      raw: '',
      confidence: 0.3,
    };
  }

  const merged = {
    action: intents[0].action,
    sub_actions: [],
    emotion: intents[0].emotion,
    energy: intents[0].energy,
    target: intents[0].target,
    raw: intents.map(i => i.raw).join('; '),
    confidence: Math.min(...intents.map(i => i.confidence || 0.5)),
  };

  for (const intent of intents) {
    if (intent.sub_actions) {
      for (const a of intent.sub_actions) {
        if (!merged.sub_actions.includes(a)) {
          merged.sub_actions.push(a);
        }
      }
    }
  }

  if (merged.sub_actions.length === 0) {
    merged.sub_actions = ['idle'];
  }

  return merged;
}

// 便捷：快速解析
export function quickParse(text) {
  const intent = parseIntent(text);
  validateIntent(intent);
  return intent;
}

console.log('[Intent Parser] ✅ 已初始化');
