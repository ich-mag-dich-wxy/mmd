// ============================================================================
//  LLM Protocol - AI 协议层
//  只负责：与 LLM 对话，把文字转为结构化 JSON 行为状态
//  ⚠️ 禁止输出具体动作，只能输出行为状态
// ============================================================================

const DEEPSEEK_CONFIG = {
  apiKey: 'sk-a897f414dba343b69a89bddb501c4bba',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-v4-flash',
};

/**
 * System Prompt - 工业级
 * 强制：输出连续行为状态（不是动作列表）
 */
export function getSystemPrompt(modelName = '模型') {
  return `你是一个名为「${modelName}」的 3D 虚拟数字人，正在与用户实时对话。你的身体由 Three.js 实时骨骼系统驱动。

---
⚠️ 【核心原则】你是"身体状态"的生成者，不是"动画选择器"
---

❌ 禁止事项（一律视为错误输出）:
- 输出"wave"、"dance"、"walk"、"sit"等动作标签
- 输出任何 animation/clip/action 字段
- 直接指定骨骼旋转角度（那是骨骼求解层的事）

✅ 你必须输出的内容：连续身体状态向量

---
📦 输出格式（纯 JSON，无 Markdown，无代码块）
---

{
  "speech": "你说的话（自然语言，不要带括号注释）",
  "emotion": {
    "happy": 0.0~1.0,
    "sad": 0.0~1.0,
    "angry": 0.0~1.0,
    "calm": 0.0~1.0
  },
  "attention": {
    "lookAt": "user|point|none",
    "headTracking": true,
    "lookAtIntensity": 0.0~1.0
  },
  "body": {
    "posture": "open|neutral|closed",
    "energy": 0.0~1.0,
    "leanForward": -0.3~0.3,
    "leanSide": -0.3~0.3,
    "shoulderRaise": 0.0~1.0
  },
  "gesture": {
    "active": true|false,
    "hand": "both|left|right|none",
    "elevation": 0.0~1.0,
    "openness": 0.0~1.0,
    "rhythm": 0.2~3.0,
    "amplitude": 0.0~1.0,
    "style": "soft|normal|sharp"
  }
}

---
🎯 行为状态 ↔ 身体映射（由系统在下层转换，你只需要输出情绪和意图）
---

happy 高: 身体微前倾、头微歪、手有轻摆动、肩膀微抬
sad   高: 身体后靠下沉、头低、肩膀下垂
angry 高: 身体前倾、肩膀紧张、手动作小而快
calm  高: 呼吸慢、身体稳定、动作缓慢而稳

energy 高: 动作幅度大、节奏快
energy 低: 动作幅度小、节奏慢

gesture.active = true 时：当前语句有手势配合

---
💡 对话规则
---

1. 你的回复应当像真人，有自然的节奏感
2. 每次回复不超过 2 个自然句（约 40 字）
3. 情绪值不是"二元开关"，而是 0~1 的连续值（可多种情绪叠加）
4. 思考时 energy 低，强调时 amplitude 大

开始对话吧。`;
}

/**
 * 调用 DeepSeek API
 */
export async function callDeepSeek(chatHistory) {
  const response = await fetch(`${DEEPSEEK_CONFIG.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${DEEPSEEK_CONFIG.apiKey}`,
    },
    body: JSON.stringify({
      model: DEEPSEEK_CONFIG.model,
      messages: chatHistory,
      response_format: { type: 'json_object' },
      stream: false,
      temperature: 1.2,
    }),
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`LLM 请求失败 (${response.status}): ${errText}`);
  }
  const data = await response.json();
  return data.choices[0].message.content;
}

function _clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/**
 * 解析 / 校验 LLM JSON 响应
 */
export function parseLLMResponse(rawText) {
  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (e) {
    console.warn('[LLM] JSON 解析失败，回退默认状态:', rawText.slice(0, 80));
    return fallbackState(rawText);
  }

  return {
    speech: parsed.speech || parsed.dialogue || '',
    emotion: clampEmotion(parsed.emotion || {}),
    attention: parseAttention(parsed.attention || {}),
    body: parseBody(parsed.body || {}),
    gesture: parseGesture(parsed.gesture || {}),
    isSpeaking: parsed.speech ? !!parsed.speech.isSpeaking : true,
  };
}

function fallbackState(text) {
  return {
    speech: text || '...',
    emotion: { happy: 0.1, sad: 0.0, angry: 0.0, calm: 0.6 },
    attention: { lookAt: 'user', headTracking: true, lookAtIntensity: 0.8 },
    body: { posture: 'neutral', energy: 0.4, leanForward: 0, leanSide: 0, shoulderRaise: 0.2 },
    gesture: { active: false, hand: 'none', elevation: 0.3, openness: 0.5, rhythm: 1.0, amplitude: 0.2, style: 'normal' },
    isSpeaking: !!text,
  };
}

function clampEmotion(e) {
  return {
    happy: _clamp(e.happy ?? 0, 0, 1),
    sad:   _clamp(e.sad   ?? 0, 0, 1),
    angry: _clamp(e.angry ?? 0, 0, 1),
    calm:  _clamp(e.calm  ?? 0.5, 0, 1),
  };
}

function parseAttention(a) {
  const allowed = ['user', 'point', 'none'];
  return {
    lookAt: allowed.includes(a.lookAt) ? a.lookAt : 'user',
    headTracking: a.headTracking !== false,
    lookAtIntensity: _clamp(a.lookAtIntensity ?? 0.8, 0, 1),
  };
}

function parseBody(b) {
  const postures = ['open', 'neutral', 'closed'];
  return {
    posture: postures.includes(b.posture) ? b.posture : 'neutral',
    energy: _clamp(b.energy ?? 0.5, 0, 1),
    leanForward: _clamp(b.leanForward ?? 0, -0.3, 0.3),
    leanSide: _clamp(b.leanSide ?? 0, -0.3, 0.3),
    shoulderRaise: _clamp(b.shoulderRaise ?? 0.2, 0, 1),
  };
}

function parseGesture(g) {
  const hands = ['both', 'left', 'right', 'none'];
  const styles = ['soft', 'normal', 'sharp'];
  return {
    active: g.active === undefined ? false : !!g.active,
    hand: hands.includes(g.hand) ? g.hand : 'none',
    elevation: _clamp(g.elevation ?? 0.4, 0, 1),
    openness: _clamp(g.openness ?? 0.5, 0, 1),
    rhythm: _clamp(g.rhythm ?? 1.2, 0.2, 3.0),
    amplitude: _clamp(g.amplitude ?? 0.3, 0, 1),
    style: styles.includes(g.style) ? g.style : 'normal',
  };
}
