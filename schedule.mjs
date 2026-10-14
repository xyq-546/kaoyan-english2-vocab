/**
 * 复习排期算法
 *
 * 设计意图（这是用户最关心的一点）：**词的"重要性"直接决定复习频率**。
 * 核心词/高频词在真题里反复出现，必须滚瓜烂熟，所以间隔推得短、复习得勤；
 * 超纲词性价比低，间隔就放长，把有限的时间让给核心词。
 *
 * 两层控制：
 *   1. 分档系数 tierFactor —— 按词汇等级拉开基础差距
 *   2. 难度因子 ease        —— 按你自己的作答情况微调（老忘的词会自动往前排）
 *
 * 纯函数，无副作用，浏览器和 Node 都能跑（方便写单元测试）。
 */

// ---------------------------------------------------------------- 词档定义

export const TIERS = {
  core: {
    id: 'core', label: '核心词', order: 0, factor: 0.55,
    desc: '英语二真题里跨 3 年以上反复考，或英语一几乎年年出现的词，必须优先吃透',
  },
  high: {
    id: 'high', label: '高频词', order: 1, factor: 0.75,
    desc: '英语二真题里考过、红宝书主推、或英语一高频的词',
  },
  syllabus: {
    id: 'syllabus', label: '大纲词', order: 2, factor: 1.0,
    desc: '在大纲词汇表内，但真题里没考过或只考过一次',
  },
  beyond: {
    id: 'beyond', label: '超纲词', order: 3, factor: 1.5,
    desc: '不在大纲内、英语二真题也没考过，多半只需认识、不必死磕',
  },
};

export const TIER_ORDER = ['core', 'high', 'syllabus', 'beyond'];

// 掌握等级 -> 基础间隔（天）。等级越高，间隔越长。
//
// 起点刻意从 5 天开始。原因：间隔要取整到"天"，若起点只有 1-2 天，
// 核心词(×0.55)和超纲词(×1.5)算出来的值会在舍入后撞成同一个数，
// 分档系数等于白设 —— 而这个工具的核心承诺恰恰是"核心词复习得更勤"。
// 起点取 5 天可保证相邻档位在任何等级下都至少差 1 天。
export const BASE_INTERVALS = [5, 7, 10, 15, 25, 45, 80, 150, 300];
export const MAX_LEVEL = BASE_INTERVALS.length - 1;

export const GRADES = {
  1: { id: 1, label: '不认识', hint: '完全没印象 / 记错了' },
  2: { id: 2, label: '模糊',   hint: '有印象，但想不准确切含义' },
  3: { id: 3, label: '认识',   hint: '看到就懂，没卡壳' },
};

// ---------------------------------------------------------------- 日期工具

/** 取本地时区的 YYYY-MM-DD（不能用 toISOString，那是 UTC，会错一天） */
export function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function addDays(dateStr, n) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return todayStr(dt);
}

/** b - a，单位天。同一天为 0，b 在 a 之后为正 */
export function daysBetween(a, b) {
  const pa = String(a).split('-').map(Number);
  const pb = String(b).split('-').map(Number);
  const da = Date.UTC(pa[0], pa[1] - 1, pa[2]);
  const db = Date.UTC(pb[0], pb[1] - 1, pb[2]);
  return Math.round((db - da) / 86400000);
}

/** 中式友好日期：今天 / 明天 / 3 天后 / 09-14 */
export function humanDate(dateStr, today = todayStr()) {
  if (!dateStr) return '—';
  const diff = daysBetween(today, dateStr);
  if (diff < 0) return `逾期 ${-diff} 天`;
  if (diff === 0) return '今天';
  if (diff === 1) return '明天';
  if (diff === 2) return '后天';
  if (diff <= 30) return `${diff} 天后`;
  const [, m, d] = String(dateStr).split('-');
  return `${Number(m)}月${Number(d)}日`;
}

// ---------------------------------------------------------------- 词库比对

export function normWord(w) {
  return String(w || '')
    .trim()
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[“”]/g, '"');
}

/**
 * 生成一个词的候选还原形（lemma）。
 *
 * 为什么必须有这层：用户粘进来的多半是**变形词** —— 做完题从原文里抄的
 * deteriorated / strategies / running，而词库存的是原形 deteriorate / strategy。
 * 不做还原，这些词会被一律判成"超纲词"，而超纲词在本工具里复习优先级最低，
 * 等于把最该背的词排到了最不重要的位置，正好和工具的目的相反。
 *
 * 实现上是保守的后缀剥离（不引入词典文件），按可能性从高到低返回候选，
 * 调用方逐个去词库试，命中即止。
 */
export function lemmaCandidates(word) {
  const w = normWord(word);
  const out = [];
  const push = (s) => { if (s && s !== w && s.length >= 2 && !out.includes(s)) out.push(s); };

  // 不规则变化，硬编码一小批高频的，比规则剥离靠谱得多
  const IRREGULAR = {
    was: 'be', were: 'be', been: 'be', being: 'be', am: 'be', is: 'be', are: 'be',
    had: 'have', has: 'have', having: 'have',
    did: 'do', does: 'do', done: 'do', doing: 'do',
    went: 'go', gone: 'go', going: 'go',
    made: 'make', making: 'make',
    took: 'take', taken: 'take', taking: 'take',
    came: 'come', coming: 'come',
    got: 'get', gotten: 'get', getting: 'get',
    said: 'say', says: 'say',
    found: 'find', felt: 'feel', left: 'leave', kept: 'keep',
    thought: 'think', brought: 'bring', bought: 'buy',
    held: 'hold', met: 'meet', paid: 'pay',
    ran: 'run', sat: 'sit', stood: 'stand', told: 'tell',
    wrote: 'write', written: 'write', spoke: 'speak', spoken: 'speak',
    began: 'begin', begun: 'begin', became: 'become',
    children: 'child', men: 'man', women: 'woman', feet: 'foot',
    teeth: 'tooth', mice: 'mouse', people: 'person',
    better: 'good', best: 'good', worse: 'bad', worst: 'bad',
    less: 'little', least: 'little', more: 'much', most: 'much',
    further: 'far', furthest: 'far', farther: 'far', farthest: 'far',
    analyses: 'analysis', crises: 'crisis', theses: 'thesis',
    phenomena: 'phenomenon', criteria: 'criterion',
  };
  if (IRREGULAR[w]) { out.push(IRREGULAR[w]); return out; }

  const len = w.length;

  // 名词复数
  if (w.endsWith('ies') && len > 4) push(w.slice(0, -3) + 'y');
  if (w.endsWith('ves') && len > 4) { push(w.slice(0, -3) + 'f'); push(w.slice(0, -3) + 'fe'); }
  if (/(ses|xes|zes|ches|shes)$/.test(w) && len > 4) push(w.slice(0, -2));
  if (w.endsWith('oes') && len > 4) push(w.slice(0, -2));
  if (w.endsWith('s') && !/(ss|us|is)$/.test(w) && len > 3) push(w.slice(0, -1));

  // 动词 -ing（running -> run, making -> make）
  if (w.endsWith('ing') && len > 5) {
    const stem = w.slice(0, -3);
    push(stem);
    push(stem + 'e');
    if (/([bdfglmnprt])$/.test(stem) && stem.length > 3) push(stem.slice(0, -1));
  }
  // 动词 -ed（planned -> plan, studied -> study）
  if (w.endsWith('ied') && len > 4) push(w.slice(0, -3) + 'y');
  if (w.endsWith('ed') && len > 4) {
    const stem = w.slice(0, -2);
    push(stem);
    push(stem + 'e');
    if (/([bdfglmnprt])$/.test(stem) && stem.length > 3) push(stem.slice(0, -1));
  }
  // 副词 -ly
  if (w.endsWith('ily') && len > 5) push(w.slice(0, -3) + 'y');
  if (w.endsWith('ly') && len > 4) { push(w.slice(0, -2)); push(w.slice(0, -2) + 'e'); }
  // 名词化派生后缀。词表往往只收动词原形（有 supervise 没有 supervision，
  // 有 agree 没有 agreement），而真题和阅读原文里出现的大多是派生名词。
  // 不还原的话这些词会被判成"超纲词"，复习优先级被压到最低 —— 正好弄反。
  //
  // -ion 统一处理，不再按 -ation/-sion/-tion 细分：
  // 细分时偏移量极易算错（supervision 曾被错误切成 supervde）。
  // 统一按"去掉 ion 得到词干"再试几种常见补全，命中率反而更高。
  if (w.endsWith('ations') && len > 7) push(w.slice(0, -6));            // implementations -> implement
  if (w.endsWith('ation') && len > 6) { push(w.slice(0, -5)); push(w.slice(0, -5) + 'e'); push(w.slice(0, -5) + 'y'); }
  if (w.endsWith('ions') && len > 6) push(w.slice(0, -4) + 'e');
  if (w.endsWith('ion') && len > 5) {
    const stem = w.slice(0, -3);         // supervision -> supervis, construction -> construct
    push(stem);                           // construction -> construct
    push(stem + 'e');                     // supervision -> supervise
    if (stem.endsWith('s')) push(stem.slice(0, -1) + 'de');  // decision -> decide
    if (stem.endsWith('ss')) push(stem.slice(0, -1));        // permission -> permit 类似
  }
  if (w.endsWith('ment') && len > 5) push(w.slice(0, -4));
  if (w.endsWith('ness') && len > 5) { push(w.slice(0, -4)); push(w.slice(0, -4) + 'y'); }
  if (w.endsWith('ance') && len > 5) { push(w.slice(0, -4) + 'e'); push(w.slice(0, -4)); }
  if (w.endsWith('ence') && len > 5) { push(w.slice(0, -4) + 'e'); push(w.slice(0, -4)); }
  if (w.endsWith('ency') && len > 5) { push(w.slice(0, -3) + 'ent'); push(w.slice(0, -3) + 'e'); }
  if (w.endsWith('ancy') && len > 5) { push(w.slice(0, -3) + 'ant'); push(w.slice(0, -3) + 'e'); }
  if (w.endsWith('ity') && len > 5) { push(w.slice(0, -3) + 'e'); push(w.slice(0, -3)); }
  if (w.endsWith('ical') && len > 6) { push(w.slice(0, -4)); push(w.slice(0, -4) + 'y'); }
  if (w.endsWith('ally') && len > 6) { push(w.slice(0, -4)); push(w.slice(0, -4) + 'e'); }
  if (w.endsWith('able') && len > 5) { push(w.slice(0, -4)); push(w.slice(0, -4) + 'e'); }
  if (w.endsWith('ible') && len > 5) { push(w.slice(0, -4)); push(w.slice(0, -4) + 'e'); }
  if (w.endsWith('ive') && len > 5) { push(w.slice(0, -3) + 'e'); push(w.slice(0, -3)); }
  if (w.endsWith('ous') && len > 5) { push(w.slice(0, -3)); push(w.slice(0, -3) + 'e'); }
  if (w.endsWith('ful') && len > 4) push(w.slice(0, -3));
  if (w.endsWith('less') && len > 5) push(w.slice(0, -4));
  if (w.endsWith('ist') && len > 4) { push(w.slice(0, -3)); push(w.slice(0, -3) + 'e'); }
  if (w.endsWith('ism') && len > 4) { push(w.slice(0, -3)); push(w.slice(0, -3) + 'e'); }

  // 动词派生：validate -> valid，scrutinize -> scrutiny，classify -> class?
  // 这类后缀剥离要保守，只在词干仍有足够长度时才试，否则容易造出假词。
  if (w.endsWith('ate') && len > 5) { push(w.slice(0, -3)); push(w.slice(0, -3) + 'e'); }
  if (w.endsWith('ize') && len > 5) { push(w.slice(0, -3)); push(w.slice(0, -3) + 'e'); push(w.slice(0, -3) + 'y'); }
  if (w.endsWith('ise') && len > 5) { push(w.slice(0, -3)); push(w.slice(0, -3) + 'e'); }
  if (w.endsWith('ify') && len > 5) { push(w.slice(0, -3)); push(w.slice(0, -3) + 'e'); }
  if (w.endsWith('fy') && len > 4) push(w.slice(0, -2) + 'y');

  // 比较级
  if (w.endsWith('est') && len > 5) push(w.slice(0, -3));
  if (w.endsWith('er') && len > 4) push(w.slice(0, -2));

  return out;
}

/**
 * 在词库里查一个词（含词形还原）；返回命中方式，便于前端提示"这是变形词"。
 *
 * 需要**多层递归**：一个词的变形可能连着剥两层才对得上词库。
 * 例：researchers → researcher（第一层）→ research（第二层，词库里只有这个）。
 * 只做一层的话 researchers 会被判成超纲词 —— 而它恰恰是阅读原文里的高频形态。
 *
 * 限制深度为 3，避免长词被一路剥到只剩两三个字母而误命中无关短词。
 */
export function lookupInVocab(word, vocab) {
  if (!vocab || !vocab.words) return { entry: null, matched: null, lemmatized: false };
  const key = normWord(word);
  if (vocab.words[key]) return { entry: vocab.words[key], matched: key, lemmatized: false };

  const seen = new Set([key]);
  let frontier = [key];
  for (let depth = 0; depth < 3 && frontier.length; depth++) {
    const next = [];
    for (const cur of frontier) {
      for (const c of lemmaCandidates(cur)) {
        if (seen.has(c)) continue;
        seen.add(c);
        if (vocab.words[c]) return { entry: vocab.words[c], matched: c, lemmatized: true };
        next.push(c);
      }
    }
    frontier = next;
  }
  return { entry: null, matched: null, lemmatized: false };
}

/** 短语的 key：只在大小写/引号层面归一，保留空格结构 */
function phraseKey(word) {
  return normWord(word).split(/\s+/).filter(Boolean).join(' ');
}

/**
 * 功能词（虚词）。用于短语释义拼装时跳过它们 ——
 * 否则 "in terms of" 的释义会变成「in 在…里；terms 术语；of …的」这种噪音。
 */
const FUNCTION_WORDS = new Set(('a an the of to in on at by for with from as is are was were be been being ' +
  'and or but if then than that this these those it its he she they we you his her their our your ' +
  'do does did have has had will would shall should can could may might must not no nor so up down out off ' +
  'over under again more most very just only also there here when where why how which who whom whose').split(/\s+/));

/**
 * 词库是否"真的可用于判定"。
 * 空词库文件（{} 或 {words:{}}）和没有词库是一回事：都无权把词判成超纲。
 * 这个区分很重要 —— 谎报"超纲"会让用户以为这些词不重要而少复习。
 */
export function vocabUsable(vocab) {
  return !!(vocab && vocab.words && Object.keys(vocab.words).length > 0);
}

/**
 * 拿一个词去词库里比对。
 *
 * 词库不可用时返回 inVocab:null，表示"不知道"，调用方应展示为"词库未加载"。
 * 绝不能在词库缺失时返回 beyond —— 那是把"没数据"说成"这词超纲"。
 *
 * 短语（含空格，如 "in terms of"）单独处理：词库里通常没有短语条目，
 * 但短语几乎都由大纲词组成，直接判超纲会把最该背的短语放走。
 * 所以短语按组成词逐个查，取其中"最核心"的档位作为整个短语的档位。
 */
export function classify(word, vocab) {
  const key = phraseKey(word);

  if (!vocabUsable(vocab)) {
    return { key, inVocab: null, tier: 'syllabus', meaning: '', phonetic: '', freq: 0, rank: 0 };
  }

  // 整体命中优先（含词形还原）
  const direct = lookupInVocab(key, vocab);
  if (direct.entry) {
    const e = direct.entry;
    return {
      key,
      inVocab: true,
      tier: TIERS[e.t] ? e.t : 'syllabus',
      // m 是词典释义，em 是真题语境释义。
      // 有 770 个词（只来自真题词表、大纲与红宝书都没收）没有 m 只有 em，
      // 这时用 em 兜底，否则前端会显示"词库里没有释义"，
      // 而这些词恰恰是用户抄进生词本的真题词。
      meaning: e.m || e.em || '',
      phonetic: e.p || '',
      freq: e.f || 0,
      rank: e.r || 0,
      // 英语二真题数据（来自用户提供的《单词之间》PDF）
      en2Years: e.e2 || 0,        // 英语二真题出现年数（16 套：2010–2025）
      en2YearList: e.e2y || [],   // 具体年份
      examMeaning: e.em || '',    // 真题语境释义（与词典释义不同，可能只覆盖考的义项）
      lemmatized: direct.lemmatized,
      matched: direct.matched,
    };
  }

  const parts = key.split(/\s+/).filter(Boolean);
  if (parts.length > 1) {
    let best = null;
    let hits = 0;
    const meanings = [];
    for (const p of parts) {
      const hit = lookupInVocab(p, vocab);
      if (!hit.entry) continue;
      hits++;
      const e = hit.entry;
      const t = TIERS[e.t] ? e.t : 'syllabus';
      if (!best || TIERS[t].order < TIERS[best].order) best = t;
      // 只给组成词里"有实义"的那些配释义（跳过 in/of/to 这类虚词），
      // 否则短语释义会变成「in 在…里；terms 术语；of …的」这种噪音。
      if (e.m && hit.matched.length > 3 && !FUNCTION_WORDS.has(hit.matched)) {
        meanings.push(`${hit.matched} ${e.m}`);
      }
    }
    // 只要有一个组成词在大纲内，就不能判超纲
    return {
      key,
      inVocab: hits > 0,
      // 短语的档位取组成词里最高的那个：它至少和里面最难的词一样难。
      // 但绝不因此升到 core —— 短语不是"核心词汇"，只是由核心词组成。
      tier: hits > 0 ? (best === 'core' ? 'high' : (best || 'syllabus')) : 'beyond',
      meaning: meanings.join('；'),
      phonetic: '',
      freq: 0,
      rank: 0,
      isPhrase: true,
    };
  }

  return { key, inVocab: false, tier: 'beyond', meaning: '', phonetic: '', freq: 0, rank: 0 };
}

// ---------------------------------------------------------------- 排期核心

/** 根据 档位 + 掌握等级 + 难度因子 算出下次间隔（天） */
export function intervalFor(tierId, level, ease = 2.5) {
  const t = TIERS[tierId] || TIERS.syllabus;
  const lvl = Math.max(0, Math.min(MAX_LEVEL, Math.round(level || 0)));
  const base = BASE_INTERVALS[lvl];
  const e = Math.max(1.3, Math.min(3.2, ease || 2.5));
  return Math.max(1, Math.round(base * t.factor * (e / 2.5)));
}

/** 新录入的词：立刻进入复习队列（当天就能见到） */
export function initSchedule(tier, today = todayStr()) {
  return {
    level: 0,
    ease: 2.5,
    reviews: 0,
    lapses: 0,
    lastReview: null,
    nextReview: today,
    history: [],
  };
}

/**
 * 给一次作答打分，返回新的排期字段（不改动入参）。
 * g: 1 不认识 / 2 模糊 / 3 认识
 */
export function applyGrade(rec, g, today = todayStr()) {
  const level0 = Math.max(0, Math.min(MAX_LEVEL, Math.round(rec.level || 0)));
  const ease0 = Math.max(1.3, Math.min(3.2, rec.ease || 2.5));
  let level, ease, lapses = rec.lapses || 0;

  if (g === 3) {
    level = Math.min(MAX_LEVEL, level0 + 1);
    ease = Math.min(3.2, ease0 + 0.08);
  } else if (g === 2) {
    level = level0;                       // 原地踏步，下次还是这个间隔
    ease = Math.max(1.3, ease0 - 0.18);
  } else {
    level = Math.max(0, level0 - 2);      // 掉两级，明显往前排
    ease = Math.max(1.3, ease0 - 0.35);
    lapses += 1;
  }

  // 「不认识」的词当天就再来一遍（本轮复习末尾重现），间隔固定为明天，
  // 不受档位系数影响 —— 已经忘了的词不该因为"是核心词"就等更久或更短，
  // 它需要的是一次确认。
  const interval = g === 1 ? 1 : intervalFor(rec.tier, level, ease);

  const history = Array.isArray(rec.history) ? rec.history.slice(-39) : [];
  history.push({ d: today, g, itv: interval });

  return {
    level,
    ease: Math.round(ease * 100) / 100,
    reviews: (rec.reviews || 0) + 1,
    lapses,
    lastReview: today,
    nextReview: addDays(today, interval),
    history,
    lastInterval: interval,
  };
}

export function isDue(rec, today = todayStr()) {
  if (!rec.nextReview) return true;
  return daysBetween(today, rec.nextReview) <= 0;
}

export function overdueDays(rec, today = todayStr()) {
  if (!rec.nextReview) return 0;
  return Math.max(0, daysBetween(rec.nextReview, today));
}

/**
 * 生成今日复习队列。
 * 排序依据：逾期越久越先来 → 词档越核心越先来 → 复习次数少的先来。
 * 这样即使今天排不下，先做的也是"最该做"的。
 */
export function buildQueue(words, today = todayStr(), limit = 0) {
  const due = words.filter((w) => isDue(w, today));
  due.sort((a, b) => {
    const oa = overdueDays(a, today), ob = overdueDays(b, today);
    if (oa !== ob) return ob - oa;
    const ta = TIERS[a.tier]?.order ?? 9, tb = TIERS[b.tier]?.order ?? 9;
    if (ta !== tb) return ta - tb;
    return (a.reviews || 0) - (b.reviews || 0);
  });
  return limit > 0 ? due.slice(0, limit) : due;
}

/** 某天的预估复习量（用于给用户看"接下来几天有多忙"） */
export function forecast(words, days = 7, today = todayStr()) {
  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(today, i);
    out.push({
      date: d,
      count: words.filter((w) => w.nextReview === d).length,
      overdue: i === 0 ? words.filter((w) => isDue(w, today)).length : 0,
    });
  }
  return out;
}

// ---------------------------------------------------------------- 统计

export function stats(words, today = todayStr()) {
  const byTier = { core: 0, high: 0, syllabus: 0, beyond: 0 };
  let due = 0, mastered = 0, learning = 0, fresh = 0;

  for (const w of words) {
    if (byTier[w.tier] !== undefined) byTier[w.tier]++;
    if (isDue(w, today)) due++;
    const lv = w.level || 0;
    if (lv >= 5) mastered++;
    else if ((w.reviews || 0) > 0) learning++;
    else fresh++;
  }
  return { total: words.length, byTier, due, mastered, learning, fresh };
}

/** 档位权重：核心词占比高说明这一批词挑得对（都是真题要害） */
export function priorityScore(words) {
  let s = 0;
  for (const w of words) {
    s += w.tier === 'core' ? 4 : w.tier === 'high' ? 3 : w.tier === 'syllabus' ? 1.5 : 0.5;
  }
  return Math.round(s);
}
