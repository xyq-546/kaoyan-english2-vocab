/**
 * 考研英语（二）词汇辅助 —— 前端主逻辑
 *
 * 数据策略：
 *   服务端（电脑上的 records.json）是权威副本，localStorage 只是镜像。
 *   改动词 → 先落内存和 localStorage → 进 outbox → 推给服务端。
 *   断网/服务停了也不丢数据，恢复后自动补推（按 updatedAt 谁新听谁的）。
 */

import * as S from './schedule.mjs';
import * as C from './crypto.mjs';

const $  = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/**
 * 数据同步模型（这里踩过坑，说明一下为什么这么设计）
 *
 *   服务端 data/records.json  = 权威副本
 *   localStorage              = 缓存 + 待发送队列（outbox）
 *
 * 一开始我写的是「服务端 ∪ 本地镜像」取并集，看着安全，实际是错的：
 * 本地镜像里没有删除记录，于是任何被删掉的词都会在下次刷新时
 * 从镜像里"复活"，还会被反推回服务端 —— 用户在手机和电脑之间
 * 永远删不掉一个词。删除语义必须被尊重。
 *
 * 正确模型：
 *   bootstrap 时以服务端为基准，只把**待发送的本地改动**叠上去。
 *   镜像里既不在服务端、也不在 outbox 的记录 = 已被别处删除，直接丢弃。
 *
 * 因此 outbox（dirty / removed）必须持久化，否则离线新建的词一刷新就丢。
 */

const LS_KEY = 'kaoyan2.vocab.v1';

// ---------------------------------------------------------------- 状态

const state = {
  records: [],
  vocab: null,
  vocabMeta: null,
  settings: {
    examDate: '',
    dailyLimit: 0,
    reviewDirection: 'en2zh',
  },
  // 'server' = 本机跑 server.mjs（数据存电脑上，手机同 WiFi 访问）
  // 'static' = 部署在静态站点（数据只存当前浏览器，随时可访问、不依赖电脑）
  mode: 'static',
  online: false,
  serverLan: [],
  serverPort: 8848,
  dirty: new Set(),      // 有未发送改动的词
  removed: new Set(),    // 待删除的词
  saveTimer: null,
};

let vocabLoaded = false;

// ---------------------------------------------------------------- 小工具

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

let toastTimer = null;
function toast(msg, ms = 1900) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), ms);
}

function setSync(stateName, text) {
  const el = $('#sync');
  el.dataset.state = stateName;
  el.textContent = text;
}

function today() { return S.todayStr(); }

// ---------------------------------------------------------------- 本地镜像

function mirrorToLocal() {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify({
      records: state.records,
      settings: state.settings,
      // outbox 必须一起存，否则离线期间新建/删除的词一刷新就丢
      dirty: [...state.dirty],
      removed: [...state.removed],
      savedAt: new Date().toISOString(),
    }));
  } catch (e) {
    if (e && e.name === 'QuotaExceededError') toast('本地缓存已满，仍会存到电脑上');
  }
}

function loadMirror() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw);
    return d && Array.isArray(d.records) ? d : null;
  } catch { return null; }
}

// ---------------------------------------------------------------- 服务端通讯

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function bootstrap() {
  const local = loadMirror();

  // 先探一下有没有本机后端。探不到就当纯静态站点跑。
  //
  // 为什么要探而不是写死：同一套 public/ 要同时支持两种用法 ——
  //   · 双击 start.bat：本机有 server.mjs，数据存电脑上，手机同 WiFi 能访问
  //   · 部署到 GitHub Pages：没有后端，数据存浏览器本地，随时随地能打开
  // 探测失败很正常（静态站点上 /api/bootstrap 会返回 404 或 HTML），
  // 所以这里不报错，直接降级。
  let serverData = null;
  try {
    const res = await fetch('./api/bootstrap', {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(4000),
    });
    // 静态托管的 SPA 兜底会把 404 变成 200 + HTML，所以要验 content-type
    const ct = res.headers.get('content-type') || '';
    if (res.ok && ct.includes('application/json')) {
      serverData = await res.json();
    }
  } catch { /* 没有后端，正常 */ }

  if (serverData) {
    state.mode = 'server';
    state.online = true;
    state.serverLan = serverData.lan || [];
    state.serverPort = serverData.port || 8848;
    state.settings = { ...state.settings, ...(serverData.settings || {}) };
    // 服务端是权威副本，本地只叠加"还没发出去的改动"
    state.records = mergeWithOutbox(serverData.records || [], local);
    state.vocabMeta = serverData.vocabMeta || null;
    mirrorToLocal();
    setSync('ok', '已同步');
    if (state.dirty.size || state.removed.size) scheduleFlush();
    return;
  }

  // 静态模式：localStorage 就是唯一权威，没有服务器可同步。
  // 不搞 outbox —— 没有"发送"这回事，写进本地即持久化。
  state.mode = 'static';
  state.online = false;
  if (local) {
    state.records = local.records || [];
    state.settings = { ...state.settings, ...(local.settings || {}) };
    // 静态模式下 outbox 概念已废弃，清空以免残留数据干扰
    state.dirty = new Set();
    state.removed = new Set();
    setSync('local', '已存本机');
  } else {
    state.records = [];
    setSync('local', '已存本机');
  }
  mirrorToLocal();
}

/**
 * 把服务端记录和本地待发送改动合并。
 *
 * 规则（顺序很重要）：
 *   1. 以服务端记录为基准
 *   2. **先执行删除** —— outbox 里的 removed 必须逐个删掉，
 *      不管那个词还在不在本地 records 里
 *   3. 本地 outbox（dirty）里的记录覆盖/补入 —— 新建和改动都会进 dirty，
 *      所以这一步已经涵盖了"离线新建的词"
 *   4. 其余本地记录一律忽略 —— 它们不是"本地独有"，是已被别处删除的陈旧数据，
 *      保留它们会让删除失效
 *
 * 两个曾经写错的地方（都是这个 bug 的成因）：
 *   · removed 检查塞在"遍历本地 records"的循环里。但用户删词时那个词已经
 *     从本地列表移除了，循环根本碰不到它 → 服务端的记录永远删不掉。
 *   · 额外加了一段"本地有、服务端没有 → 补进来"，本意是保住离线新建的词，
 *     但离线新建的词本来就在 dirty 里，这段实际只起到了"让已删除的词复活"
 *     的作用 → 表现就是"删了刷新又回来"。
 */
function mergeWithOutbox(serverRecords, local) {
  const map = new Map();
  for (const r of serverRecords) {
    if (r && r.word) map.set(r.word, r);
  }
  if (!local) return [...map.values()];

  const dirty = new Set(local.dirty || []);
  const removed = new Set(local.removed || []);

  // 删除必须无条件生效，不能依赖该词是否还在本地列表里
  for (const w of removed) map.delete(w);

  // outbox 里的改动：既覆盖服务端同名记录，也补入服务端还没有的新词
  for (const r of local.records || []) {
    if (!r || !r.word) continue;
    if (removed.has(r.word) || !dirty.has(r.word)) continue;
    map.set(r.word, r);
  }

  state.dirty = dirty;
  state.removed = removed;
  return [...map.values()];
}

async function loadVocab() {
  if (vocabLoaded) return state.vocab;

  // 本机模式：后端直接给明文词库。
  if (state.mode === 'server') {
    try {
      const res = await fetch('./api/vocab', { headers: { Accept: 'application/json' } });
      const ct = res.headers.get('content-type') || '';
      if (res.ok && ct.includes('application/json')) {
        const data = await res.json();
        if (data && data.words) {
          state.vocab = data;
          vocabLoaded = true;
          state.vocabMeta = {
            count: Object.keys(data.words).length,
            builtAt: data.builtAt,
            sources: data.sources || [],
          };
          return state.vocab;
        }
      }
    } catch { /* 落到下面报错 */ }
    state.vocab = null;
    return state.vocab;
  }

  // 静态模式：词库是加密的（见 tools/build-web.mjs）。
  // 先看本地有没有存过密码，能解开就直接进；不行就弹解锁框。
  const pw = loadSavedPassword();
  if (pw) {
    const ok = await tryUnlock(pw, { silent: true });
    if (ok) return state.vocab;
  }
  showGate();
  return null;
}

// ---------------------------------------------------------------- 词库解锁

const PW_KEY = 'kaoyan2.vocab.pw';

function loadSavedPassword() {
  try { return localStorage.getItem(PW_KEY) || ''; } catch { return ''; }
}
function savePassword(pw) {
  try { localStorage.setItem(PW_KEY, pw); } catch { /* 无痕模式可能失败 */ }
}
function clearSavedPassword() {
  try { localStorage.removeItem(PW_KEY); } catch { /* 忽略 */ }
}

function showGate(msg = '') {
  const g = $('#gate');
  if (!g) return;
  g.hidden = false;
  document.body.style.overflow = 'hidden';
  const m = $('#gate-msg');
  m.textContent = msg;
  m.classList.toggle('ok', false);
  setTimeout(() => $('#gate-pw')?.focus(), 60);
}

function hideGate() {
  const g = $('#gate');
  if (!g) return;
  g.hidden = true;
  document.body.style.overflow = '';
}

/**
 * 用密码解词库。成功返回 true 并填好 state.vocab。
 * @param {string} pw
 * @param {{silent?: boolean}} opts silent=true 时失败不弹提示（用于自动试缓存密码）
 */
async function tryUnlock(pw, { silent = false } = {}) {
  const msg = $('#gate-msg');
  try {
    const res = await fetch('./vocab.enc.json', { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('拿不到词库文件');
    const bundle = await res.json();

    const data = await C.decryptJSON(bundle, pw);
    if (!data || !data.words) throw new Error('内容不对');

    state.vocab = data;
    vocabLoaded = true;
    state.vocabMeta = {
      count: Object.keys(data.words).length,
      builtAt: data.builtAt,
      sources: data.sources || [],
    };
    if ($('#gate-remember')?.checked !== false) savePassword(pw);
    hideGate();
    return true;
  } catch (e) {
    if (!silent) {
      msg.textContent = (e.message === '密码不对')
        ? '密码不对'
        : `解锁失败：${e.message}`;
      // 密码错了就别留着旧的缓存密码，免得下次又自动试一遍
      clearSavedPassword();
    }
    vocabLoaded = false;
    state.vocab = null;
    return false;
  }
}

/** 把本地改动推给服务端；失败就留着，下次再推 */
async function flush() {
  // 静态模式下 localStorage 就是唯一存储，没有远端可推 —— 直接返回。
  // （每次改动都已由 mirrorToLocal() 落盘）
  if (state.mode === 'static') { saveNow(); return; }
  if (state.dirty.size === 0 && state.removed.size === 0) return;

  const byWord = new Map(state.records.map((r) => [r.word, r]));
  const payload = {
    records: [...state.dirty].map((w) => byWord.get(w)).filter(Boolean),
    removed: [...state.removed],
  };
  if (!payload.records.length && !payload.removed.length) return;

  setSync('saving', '保存中…');
  try {
    await api('/api/records', { method: 'POST', body: JSON.stringify(payload) });
    for (const w of payload.records) state.dirty.delete(w.word);
    for (const w of payload.removed) state.removed.delete(w);
    state.online = true;
    setSync('ok', '已同步');
    mirrorToLocal();
  } catch {
    state.online = false;
    setSync('offline', '离线，稍后自动补传');
    mirrorToLocal();
  }
}

/** 静态模式下的即时落盘（localStorage 写入是同步的，不会有竞态） */
function saveNow() {
  mirrorToLocal();
  if (state.mode === 'static') setSync('local', '已存本机');
}

function scheduleFlush() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => flush(), 350);
}

// ---------------------------------------------------------------- 记录读写

/**
 * 两组记录按 updatedAt 求并集（导入备份用）。
 * 与同步路径不同：这里没有"删除"语义，两边都保留，同名词取较新的。
 */
function unionRecords(a, b) {
  const map = new Map();
  for (const r of [...a, ...b]) {
    if (!r || !r.word) continue;
    const cur = map.get(r.word);
    if (!cur) { map.set(r.word, r); continue; }
    const ta = Date.parse(cur.updatedAt || 0) || 0;
    const tb = Date.parse(r.updatedAt || 0) || 0;
    // 时间戳相同或缺失时取复习次数多的（信息更多，不丢进度）
    if (tb > ta || (tb === ta && (r.reviews || 0) > (cur.reviews || 0))) map.set(r.word, r);
  }
  return [...map.values()];
}

function byWord(word) { return state.records.find((r) => r.word === word); }

function addRecord(word, info, note = '') {
  const t = today();
  const rec = {
    word,
    tier: info.tier,
    inVocab: info.inVocab,
    meaning: info.meaning || '',
    phonetic: info.phonetic || '',
    freq: info.freq || 0,
    rank: info.rank || 0,
    // 英语二真题信息（来自《单词之间》PDF）。en2Years 是这套卷子里的出现年数，
    // 比英语一的 freq 更贴用户实际要考的试，所以界面上优先显示它。
    en2Years: info.en2Years || 0,
    en2YearList: info.en2YearList || [],
    examMeaning: info.examMeaning || '',
    note,
    source: '',
    addedAt: t,
    updatedAt: new Date().toISOString(),
    ...S.initSchedule(info.tier, t),
  };
  state.records.push(rec);
  state.dirty.add(word);
  return rec;
}

/**
 * 组成"真题证据"徽标。优先用英语二年份，没有才退回英语一。
 * 这两个是不同口径，标签必须写清是哪个，不能混着显示成一个数字。
 */
function examBadges(rec) {
  const out = [];
  if (rec.en2Years > 0) {
    out.push(`<span class="badge plain" title="英语二真题中出现过的年份：${escapeHtml((rec.en2YearList || []).join('、'))}">英语二 ${rec.en2Years} 年</span>`);
  }
  if (rec.freq > 0) {
    out.push(`<span class="badge plain" title="英语一 25 套真题中出现年数，仅作参考">英语一 ${rec.freq} 年</span>`);
  }
  return out.join('');
}

function patchRecord(rec, fields) {
  Object.assign(rec, fields, { updatedAt: new Date().toISOString() });
  state.dirty.add(rec.word);
  scheduleFlush();
}

function removeRecord(word) {
  const i = state.records.findIndex((r) => r.word === word);
  if (i < 0) return;
  state.records.splice(i, 1);
  state.dirty.delete(word);
  state.removed.add(word);
  scheduleFlush();
}

// ---------------------------------------------------------------- 输入解析

// 从整段文字里挑词时用的高频功能词，这些不是"生词"
const STOP = new Set(('a an the and or but if of to in on at by for with from as is are was were be been being am ' +
  'do does did doing done have has had having it its this that these those they them their he him his she her hers ' +
  'we us our you your i me my mine who whom whose which what when where why how will would shall should can could ' +
  'may might must not no nor so than then there here also too very just only more most much many some any all both ' +
  'each every other another such own same up down out off over under again further once during before after above ' +
  'below between into through about against because while until unless since though although however therefore thus ' +
  'hence etc upon within without among along across behind beyond toward towards upon per via').split(/\s+/));

const MAX_ITEMS = 800;

/**
 * 解析输入框内容。
 * 规则：换行/分号/竖线切分条目；条目内超过 3 个英文词（或超长）就当整段文字处理，
 * 抽词并过滤功能词。这样"粘一段阅读原文"和"一行一个词"两种用法都成立。
 */
function parseInput(text, autoSplit) {
  const items = [];
  const seen = new Set();
  let skipped = 0;

  const chunks = String(text || '').split(/[\n\r;；|]+/).map((s) => s.trim()).filter(Boolean);

  for (const rawChunk of chunks) {
    let body = rawChunk;
    let note = '';

    // "deteriorate, 恶化" 这种自带注释的写法
    const cm = rawChunk.match(/^([^,，\t]+)[,，\t]\s*(.+)$/);
    if (cm && /[\u4e00-\u9fa5]/.test(cm[2]) && !/[\u4e00-\u9fa5]/.test(cm[1])) {
      body = cm[1].trim();
      note = cm[2].trim();
    } else {
      // "deteriorate 恶化"
      const sm = rawChunk.match(/^([A-Za-z][A-Za-z''\- ]*?)\s+([\u4e00-\u9fa5].*)$/);
      if (sm) { body = sm[1].trim(); note = sm[2].trim(); }
    }

    const words = body.match(/[A-Za-z][A-Za-z''\-]*/g) || [];
    if (!words.length) { skipped++; continue; }

    const looksLikePassage = words.length > 3 || body.length > 40;

    if (autoSplit && looksLikePassage) {
      for (const tok of words) {
        const w = tok.replace(/^[-']+|[-']+$/g, '').toLowerCase();
        if (w.length < 3 || STOP.has(w) || seen.has(w)) continue;
        seen.add(w);
        items.push({ word: w, note: '' });
        if (items.length >= MAX_ITEMS) break;
      }
      if (items.length >= MAX_ITEMS) break;
      continue;
    }

    // 单词或短语：整条保留（"in terms of" 不该被拆散）
    const w = body.replace(/\s+/g, ' ').replace(/[.。]+$/, '').trim().toLowerCase();
    if (!w || !/[a-z]/.test(w) || seen.has(w)) { skipped++; continue; }
    seen.add(w);
    items.push({ word: w, note });
    if (items.length >= MAX_ITEMS) break;
  }

  return { items, skipped };
}

// ---------------------------------------------------------------- 视图：录入

let lastPreview = [];

function renderParseHint() {
  const text = $('#input').value;
  if (!text.trim()) { $('#parse-hint').textContent = '等待输入…'; return; }
  const { items } = parseInput(text, $('#opt-split').checked);
  $('#parse-hint').textContent = items.length
    ? `识别到 ${items.length} 个待处理条目`
    : '没识别出英文单词';
}

async function renderPreview() {
  const text = $('#input').value;
  const { items } = parseInput(text, $('#opt-split').checked);
  if (!items.length) { toast('没识别出英文单词'); return; }

  await loadVocab();
  const card = $('#preview-card');
  card.hidden = false;

  const rows = items.slice(0, 60).map((it) => {
    const info = S.classify(it.word, state.vocab);
    const dup = !!byWord(it.word);
    const t = S.TIERS[info.tier];
    const meaning = info.meaning || it.note || '';
    const unk = info.inVocab === null;
    // 词库不可用时不能显示"超纲词"，那是在撒谎
    const badge = unk
      ? '<span class="badge plain">待判定</span>'
      : `<span class="badge ${info.tier}">${escapeHtml(t.label)}</span>`;
    // 真题证据：英语二年份优先（用户考的就是它）
    const ev = [];
    if (info.en2Years > 0) {
      ev.push(`<span class="badge plain" title="英语二真题出现年份：${escapeHtml((info.en2YearList || []).join('、'))}">英语二 ${info.en2Years} 年</span>`);
    }
    if (info.freq > 0) ev.push(`<span class="badge plain">英语一 ${info.freq} 年</span>`);
    return `<div class="preview-item${dup ? ' dup' : ''}">
      <span class="grow">
        <span class="pw">${escapeHtml(it.word)}</span>
        ${meaning ? ` <span class="pm">${escapeHtml(meaning)}</span>` : ''}
        ${unk ? ' <span class="pm">词库未导入</span>' : ''}
        ${info.lemmatized ? ` <span class="pm">← ${escapeHtml(info.matched)}</span>` : ''}
      </span>
      ${badge}
      ${ev.join('')}
    </div>`;
  }).join('');

  const counts = {};
  for (const it of items) {
    const info = S.classify(it.word, state.vocab);
    counts[info.tier] = (counts[info.tier] || 0) + 1;
  }
  const sum = S.vocabUsable(state.vocab)
    ? S.TIER_ORDER.filter((t) => counts[t]).map((t) => `${S.TIERS[t].label} ${counts[t]}`).join(' · ')
    : '词库未导入，暂时无法判定等级';

  $('#preview-sum').textContent = sum;
  $('#preview-body').innerHTML = rows +
    (items.length > 60 ? `<div class="preview-more">…还有 ${items.length - 60} 条</div>` : '');
  card.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function doAdd() {
  const text = $('#input').value;
  const { items } = parseInput(text, $('#opt-split').checked);
  if (!items.length) { toast('没识别出英文单词'); return; }

  await loadVocab();
  const skipDup = $('#opt-dedupe').checked;
  let added = 0, dup = 0;

  for (const it of items) {
    if (byWord(it.word)) {
      dup++;
      if (skipDup) continue;
      // 不跳过的话，至少把用户新写的注释补上
      if (it.note) patchRecord(byWord(it.word), { note: it.note });
      continue;
    }
    const info = S.classify(it.word, state.vocab);
    addRecord(it.word, info, it.note);
    added++;
  }

  mirrorToLocal();
  scheduleFlush();
  $('#input').value = '';
  $('#preview-card').hidden = true;
  renderParseHint();
  renderRecent();
  renderNavBadge();
  renderDueStats();

  toast(added ? `已加入 ${added} 个${dup ? `（${dup} 个已存在）` : ''}` : `这些都已经在生词本里了（${dup} 个）`);
}

function renderRecent() {
  const recent = [...state.records].slice(-8).reverse();
  if (!recent.length) {
    $('#recent-body').innerHTML = '<div class="empty small">还没有录入。做完一套题就把生词粘到上面吧。</div>';
    return;
  }
  $('#recent-body').innerHTML = '<div class="wordlist">' + recent.map((r) => {
    const t = S.TIERS[r.tier];
    return `<div class="wrow">
      <div class="w-main">
        <div class="w-term">${escapeHtml(r.word)}</div>
        ${r.meaning ? `<div class="w-note">${escapeHtml(r.meaning)}</div>` : ''}
        <div class="w-meta"><span class="badge ${r.tier}">${escapeHtml(t.label)}</span>${examBadges(r)}${dueBadge(r)}</div>
      </div>
      <div class="w-act"><button class="iconbtn danger" data-del="${escapeHtml(r.word)}">删除</button></div>
    </div>`;
  }).join('') + '</div>';
}

function dueBadge(r) {
  if (S.isDue(r, today())) return '<span class="badge due">待复习</span>';
  return `<span class="badge plain">${escapeHtml(S.humanDate(r.nextReview, today()))}</span>`;
}

// ---------------------------------------------------------------- 视图：复习

const session = {
  queue: [],
  idx: 0,
  revealed: false,
  total: 0,
  done: 0,
  tally: { 1: 0, 2: 0, 3: 0 },
  requeued: new Set(),
  active: false,
};

function renderNavBadge() {
  const n = state.records.filter((r) => S.isDue(r, today())).length;
  const el = $('#nav-due');
  el.hidden = n === 0;
  el.textContent = n > 99 ? '99+' : String(n);
}

function renderDueStats() {
  const st = S.stats(state.records, today());
  $('#due-stats').innerHTML = `
    <div class="stat"><b>${st.due}</b><span>待复习</span></div>
    <div class="stat"><b>${st.total}</b><span>生词总数</span></div>
    <div class="stat"><b>${st.mastered}</b><span>已掌握</span></div>`;

  const exam = state.settings.examDate;
  const parts = [];
  if (exam) {
    const d = S.daysBetween(today(), exam);
    parts.push(d >= 0 ? `距考试 ${d} 天` : '考试日期已过');
  }
  if (st.due === 0 && st.total > 0) parts.push('今天的复习都清完了');
  if (st.total === 0) parts.push('还没有生词，先去「录入」加几个');
  $('#due-note').textContent = parts.join('　·　');
  $('#nav-due').hidden = st.due === 0;
  $('#nav-due').textContent = st.due > 99 ? '99+' : String(st.due);
}

function startSession(all) {
  const t = today();
  let q = all ? [...state.records] : S.buildQueue(state.records, t, 0);
  const limit = Number(state.settings.dailyLimit) || 0;
  if (!all && limit > 0 && q.length > limit) q = q.slice(0, limit);

  if (!q.length) { toast('今天没有要复习的词'); return; }

  session.queue = q.map((r) => r.word);
  session.idx = 0;
  session.done = 0;
  session.total = q.length;
  session.tally = { 1: 0, 2: 0, 3: 0 };
  session.requeued = new Set();
  session.active = true;
  session.revealed = false;

  $('#review-start').hidden = true;
  $('#review-done').hidden = true;
  $('#review-card').hidden = false;
  showCard();
}

function showCard() {
  if (session.idx >= session.queue.length) return finishSession();

  const word = session.queue[session.idx];
  const rec = byWord(word);
  if (!rec) { session.idx++; return showCard(); }

  session.revealed = false;
  const t = S.TIERS[rec.tier];

  $('#rv-word').textContent = rec.word;
  $('#rv-word').classList.toggle('smaller', rec.word.length > 16);
  // 音标按词典习惯加斜杠。存的是纯音标（əkˈnɒlɪdʒ），这里补上 / /
  $('#rv-phon').textContent = rec.phonetic ? `/${rec.phonetic}/` : '';

  $('#rv-badges').innerHTML =
    `<span class="badge ${rec.tier}">${escapeHtml(t.label)}</span>` +
    examBadges(rec) +
    ((rec.reviews || 0) > 0 ? `<span class="badge plain">已复习 ${rec.reviews} 次</span>` : '') +
    ((rec.lapses || 0) > 0 ? `<span class="badge due">忘过 ${rec.lapses} 次</span>` : '');

  $('#rv-answer').hidden = true;
  $('#rv-grades').hidden = true;
  $('#rv-reveal-wrap').hidden = false;

  const left = session.queue.length - session.idx;
  $('#rv-progress').textContent = `第 ${session.idx + 1} / ${session.total} 个`;
  $('#rv-left').textContent = `剩余 ${left}`;
  $('#rv-bar').style.width = `${(session.idx / Math.max(1, session.total)) * 100}%`;
}

function reveal() {
  if (session.revealed) return;
  const word = session.queue[session.idx];
  const rec = byWord(word);
  if (!rec) return;
  session.revealed = true;

  const meaning = rec.meaning || rec.note || '';
  const rv = $('#rv-answer');

  // 注意：这里用 innerHTML 重写 rv-answer 的内部结构，
  // 所以 #rv-meaning / #rv-prov 会被重建，不能先引用再写。
  // 真题语境释义单独一行展示 —— 它和词典释义不是一回事：
  // 它是"这词在这篇真题里是什么意思"，常常只覆盖考的那一个义项
  // （如 preserve 在真题里就考「保护，维护」）。两者都要给，不能互相替代。
  const examLine = (rec.examMeaning && rec.examMeaning !== meaning)
    ? `<div class="exam-meaning"><b>真题里考的是</b>${escapeHtml(rec.examMeaning)}</div>`
    : '';
  rv.innerHTML =
    `<div class="meaning">${escapeHtml(meaning || '（词库里没有释义，按你自己的笔记记）')}</div>` +
    examLine +
    '<div class="prov" id="rv-prov"></div>';

  const bits = [];
  if (rec.tier === 'beyond') bits.push('不在大纲内、真题也没考过，认识即可');
  else if (rec.tier === 'core') bits.push('核心词，务必记牢');
  else if (rec.tier === 'high') bits.push('高频词，值得花时间');
  if (rec.en2Years > 0) bits.push(`英语二真题考过 ${rec.en2Years} 年（${(rec.en2YearList || []).join('、')}）`);
  if (rec.note) bits.push(`笔记：${rec.note}`);
  const lv = rec.level || 0;
  bits.push(`当前掌握等级 ${lv}/${S.MAX_LEVEL}`);
  $('#rv-prov').textContent = bits.join('　·　');

  rv.hidden = false;
  $('#rv-reveal-wrap').hidden = true;
  $('#rv-grades').hidden = false;
}

function grade(g) {
  if (!session.revealed) return;
  const word = session.queue[session.idx];
  const rec = byWord(word);
  if (!rec) return;

  const next = S.applyGrade(rec, g, today());
  patchRecord(rec, next);

  session.tally[g]++;
  session.done++;
  $('#rv-bar').style.width = `${(session.done / Math.max(1, session.total)) * 100}%`;

  // 「不认识」的当天再考一遍：插到本轮末尾，每个词每轮只补一次，不会无限循环
  if (g === 1 && !session.requeued.has(word)) {
    session.requeued.add(word);
    session.queue.push(word);
  }

  session.idx++;
  showCard();
}

function finishSession() {
  session.active = false;
  $('#review-card').hidden = true;
  $('#review-done').hidden = false;

  const t = session.tally;
  $('#done-emoji').textContent = t[3] >= t[1] + t[2] ? '🎉' : '👍';
  $('#done-text').textContent = `本轮复习了 ${session.done} 次`;

  const lines = [];
  lines.push(`认识 ${t[3]} · 模糊 ${t[2]} · 不认识 ${t[1]}`);
  const due = state.records.filter((r) => S.isDue(r, today())).length;
  if (due) lines.push(`还有 ${due} 个到期未复习`);
  else lines.push('今天的复习任务清空了');

  const worst = state.records.filter((r) => (r.lapses || 0) >= 2)
    .sort((a, b) => (b.lapses || 0) - (a.lapses || 0)).slice(0, 5);
  if (worst.length) {
    lines.push('反复忘的词：' + worst.map((r) => r.word).join('、'));
  }

  $('#done-summary').innerHTML = '<div class="small muted center" style="margin-top:6px">' +
    lines.map(escapeHtml).join('<br>') + '</div>';

  mirrorToLocal();
  scheduleFlush();
  renderDueStats();
  renderRecent();
}

function quitSession() {
  if (!session.active) return;
  const n = session.done;
  session.active = false;
  $('#review-card').hidden = true;
  $('#review-start').hidden = false;
  renderDueStats();
  toast(n ? `本轮已复习 ${n} 个` : '已结束');
}

// ---------------------------------------------------------------- 视图：生词本

const listFilter = { tier: 'all', state: 'all', q: '' };
let listLimit = 120;

function renderFilters() {
  const tiers = [['all', '全部'], ...S.TIER_ORDER.map((t) => [t, S.TIERS[t].label])];
  $('#filter-tier').innerHTML = tiers.map(([id, label]) => {
    const n = id === 'all' ? state.records.length : state.records.filter((r) => r.tier === id).length;
    return `<button data-tier="${id}" class="${listFilter.tier === id ? 'on' : ''}">${label} ${n}</button>`;
  }).join('');

  const states = [['all', '全部'], ['due', '待复习'], ['new', '没复习过'], ['hard', '老忘'], ['done', '已掌握']];
  $('#filter-state').innerHTML = states.map(([id, label]) =>
    `<button data-state="${id}" class="${listFilter.state === id ? 'on' : ''}">${label}</button>`).join('');
}

function filteredRecords() {
  const t = today();
  const q = listFilter.q.trim().toLowerCase();
  let out = state.records;
  if (listFilter.tier !== 'all') out = out.filter((r) => r.tier === listFilter.tier);
  if (listFilter.state === 'due') out = out.filter((r) => S.isDue(r, t));
  else if (listFilter.state === 'new') out = out.filter((r) => !(r.reviews || 0));
  else if (listFilter.state === 'hard') out = out.filter((r) => (r.lapses || 0) >= 2);
  else if (listFilter.state === 'done') out = out.filter((r) => (r.level || 0) >= 5);
  if (q) out = out.filter((r) => r.word.includes(q) || (r.meaning || '').includes(listFilter.q.trim()));
  // 排序：待复习优先，其次按词档，再按录入时间
  return [...out].sort((a, b) => {
    const da = S.isDue(a, t) ? 0 : 1, db = S.isDue(b, t) ? 0 : 1;
    if (da !== db) return da - db;
    const ta = S.TIERS[a.tier]?.order ?? 9, tb = S.TIERS[b.tier]?.order ?? 9;
    if (ta !== tb) return ta - tb;
    return (a.word > b.word ? 1 : -1);
  });
}

function renderWordList() {
  renderFilters();
  const all = filteredRecords();
  const shown = all.slice(0, listLimit);

  $('#list-count').textContent = all.length
    ? `共 ${all.length} 个${all.length > shown.length ? `，显示前 ${shown.length}` : ''}`
    : '没有匹配的词';

  if (!all.length) {
    $('#word-list').innerHTML = '<div class="empty"><div class="big-emoji">🔍</div>这里什么都没有</div>';
    return;
  }

  $('#word-list').innerHTML = shown.map((r) => {
    const t = S.TIERS[r.tier];
    const lv = r.level || 0;
    const prov = [];
    if (r.en2Years > 0) prov.push(`英语二 ${r.en2Years} 年`);
    if (r.freq) prov.push(`英语一 ${r.freq} 年`);
    if ((r.reviews || 0) > 0) prov.push(`复习 ${r.reviews} 次`);
    prov.push(S.humanDate(r.nextReview, today()));
    return `<div class="wrow">
      <div class="w-main">
        <div class="w-term">${escapeHtml(r.word)}</div>
        ${r.meaning ? `<div class="w-note">${escapeHtml(r.meaning)}</div>` : ''}
        <div class="w-meta">
          <span class="badge ${r.tier}">${escapeHtml(t.label)}</span>
          ${S.isDue(r, today()) ? '<span class="badge due">待复习</span>' : ''}
          ${(r.lapses || 0) >= 2 ? '<span class="badge due">老忘</span>' : ''}
          <span class="tiny muted">${escapeHtml(prov.join(' · '))}</span>
        </div>
      </div>
      <div class="w-act">
        <span class="tiny muted">L${lv}</span>
        <button class="iconbtn danger" data-del="${escapeHtml(r.word)}">删除</button>
      </div>
    </div>`;
  }).join('') + (all.length > shown.length
    ? `<div class="preview-more"><button class="iconbtn" id="btn-more">加载更多（还有 ${all.length - shown.length}）</button></div>`
    : '');
}

// ---------------------------------------------------------------- 视图：我的

function renderMe() {
  const st = S.stats(state.records, today());
  $('#me-stats').innerHTML = `
    <div class="stat"><b>${st.total}</b><span>生词总数</span></div>
    <div class="stat"><b>${st.due}</b><span>待复习</span></div>
    <div class="stat"><b>${st.mastered}</b><span>已掌握</span></div>
    <div class="stat"><b>${st.learning}</b><span>复习中</span></div>
    <div class="stat"><b>${st.byTier.core}</b><span>核心词</span></div>
    <div class="stat"><b>${S.priorityScore(state.records)}</b><span>价值分</span></div>`;

  const total = st.total || 1;
  const colors = { core: 'var(--t-core)', high: 'var(--t-high)', syllabus: 'var(--t-syllabus)', beyond: 'var(--t-beyond)' };
  $('#me-bar').innerHTML = S.TIER_ORDER.map((t) =>
    `<i style="width:${(st.byTier[t] / total) * 100}%;background:${colors[t]}"></i>`).join('');
  $('#me-legend').innerHTML = S.TIER_ORDER.map((t) =>
    `<span><i style="background:${colors[t]}"></i>${S.TIERS[t].label} ${st.byTier[t]}</span>`).join('');

  const fc = S.forecast(state.records, 7, today());
  const max = Math.max(1, ...fc.map((f) => f.count));
  // 高度固定在 CSS 里（.fc-col），不要在这里塞内联高度 ——
  // 手机上如果只给内层高度，flex 会把柱子拉满整屏。
  $('#me-forecast').innerHTML = fc.map((f, i) => {
    const h = f.count ? Math.max(4, Math.round((f.count / max) * 40)) : 0;
    const label = i === 0 ? '今天' : `${Number(f.date.slice(5, 7))}/${Number(f.date.slice(8, 10))}`;
    return `<div class="fc-col">
      <div class="fc-bar"><i style="height:${h}px;opacity:${i === 0 ? 1 : .55}"></i></div>
      <div class="fc-label">${label}</div>
      <div class="fc-count${f.count ? '' : ' zero'}">${f.count}</div>
    </div>`;
  }).join('');

  $('#set-exam').value = state.settings.examDate || '';
  $('#set-limit').value = state.settings.dailyLimit || 0;
  $('#set-show').checked = state.settings.reviewDirection === 'en2zh';

  // 访问方式：两种模式说明完全不同
  const lan = state.serverLan || [];
  if (state.mode === 'static') {
    // 静态站点：任何时候打开这个网址都能用，不依赖那台电脑。
    // 代价是数据存当前浏览器，所以这里要讲清怎么备份、怎么换设备。
    $('#lan-body').innerHTML =
      '<div class="tiny">你正在用<b>线上版</b>（网址打开即用，不用开电脑）。'
      + '记录存在<b>当前这个浏览器</b>里。</div>'
      + '<div class="tiny" style="margin-top:8px">换设备 / 换浏览器时：'
      + '在老设备上点下面的「导出备份 JSON」，在新设备上点「导入备份」，进度就过去了。'
      + '<b>清浏览器数据会丢记录</b>，建议隔段时间导出一份存着。</div>';
    $('#qr-wrap').hidden = true;
  } else if (state.online && lan.length) {
    $('#lan-body').innerHTML = lan.map((ip) =>
      `<div style="margin-bottom:6px">在手机上打开：<br>
        <b style="font-size:16px;user-select:all">http://${escapeHtml(ip)}:${state.serverPort}/</b></div>`).join('')
      + '<div class="tiny">需要手机和这台电脑连同一个 WiFi。</div>';
    $('#qr-wrap').hidden = false;
    drawQR(`http://${lan[0]}:${state.serverPort}/`);
  } else {
    $('#lan-body').innerHTML = '<div class="notice warn">当前没连上服务，无法获取局域网地址。确认电脑上的服务还在跑。</div>';
    $('#qr-wrap').hidden = true;
  }

  // 词库
  const vm = state.vocabMeta;
  if (vm && vm.count) {
    const built = vm.builtAt ? new Date(vm.builtAt).toLocaleDateString('zh-CN') : '未知';
    $('#vocab-body').innerHTML = `已装载 <b>${vm.count}</b> 个词条（构建于 ${built}）。<br>
      <span class="tiny">核心依据是<b>英语二 2010–2025 共 16 套真题</b>：真题里出现过的词会标出年份，
      反复考的判为核心词。另有英语一 25 套真题年数与红宝书分区作辅助。
      词库只用于比对和标注，不会覆盖你自己写的笔记。</span>`;
  } else {
    $('#vocab-body').innerHTML = '<div class="notice warn">词库还没导入，现在所有词都会被标成「超纲」。导入 <code>data/vocab.json</code> 后重启服务即可。</div>';
  }

  $('#tier-explain').innerHTML = S.TIER_ORDER.map((t) => {
    const x = S.TIERS[t];
    return `<div style="margin-bottom:6px"><b>${x.label}</b>（复习间隔 ×${x.factor}）—— ${x.desc}</div>`;
  }).join('') + '<div>间隔越短 = 复习越频繁。核心词的间隔只有超纲词的约三分之一，'
    + '所以同样认识一次，核心词会更早回到你的复习队列里。</div>'
    + '<div style="margin-top:8px"><b>真题证据怎么看</b>：'
    + '徽标里的「英语二 N 年」是这个词在 2010–2025 共 16 套英语二真题里出现过的年数，'
    + '鼠标悬停能看到具体年份；「英语一 N 年」是 25 套英语一真题，仅作参考。'
    + '两个数字口径不同，别混着比。</div>';
}

// ---------------------------------------------------------------- 二维码

let qrMod = null;
async function drawQR(text) {
  try {
    if (!qrMod) qrMod = await import('./qr.mjs');
    const canvas = $('#qr');
    qrMod.renderToCanvas(canvas, text);
  } catch (e) {
    $('#qr-wrap').hidden = true;
  }
}

// ---------------------------------------------------------------- 导出 / 备份

function download(filename, text, type = 'application/json') {
  const blob = new Blob([text], { type: `${type};charset=utf-8` });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function exportTSV() {
  const rows = filteredRecords();
  if (!rows.length) { toast('没有可导出的词'); return; }
  const head = ['单词', '释义', '真题语境释义', '等级', '英语二年数', '英语二年份',
    '英语一年数', '掌握等级', '复习次数', '忘过', '下次复习', '笔记'];
  const body = rows.map((r) => [
    r.word, r.meaning || '', r.examMeaning || '', S.TIERS[r.tier].label,
    r.en2Years || '', (r.en2YearList || []).join(' '),
    r.freq || '', r.level || 0, r.reviews || 0, r.lapses || 0,
    r.nextReview || '', (r.note || '').replace(/\s+/g, ' '),
  ]);
  const tsv = [head, ...body].map((r) => r.join('\t')).join('\r\n');
  download(`考研英语二生词_${today()}.tsv`, tsv, 'text/tab-separated-values');
  toast(`导出 ${rows.length} 个词`);
}

// ---------------------------------------------------------------- 路由

const TITLES = { add: '录入生词', review: '复习', words: '生词本', me: '我的' };
const VALID = Object.keys(TITLES);

function route() {
  let v = (location.hash || '#add').slice(1);
  if (!VALID.includes(v)) v = 'add';
  if (session.active && v !== 'review') quitSession();

  for (const x of VALID) $(`#view-${x}`).hidden = x !== v;
  $('#page-title').textContent = TITLES[v];
  $$('nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === v));

  if (v === 'words') { listLimit = 120; renderWordList(); }
  if (v === 'me') renderMe();
  if (v === 'review') { if (!session.active) { $('#review-start').hidden = false; $('#review-card').hidden = true; $('#review-done').hidden = true; } renderDueStats(); }
  if (v === 'add') renderRecent();
  window.scrollTo(0, 0);
}

// ---------------------------------------------------------------- 事件绑定

function bind() {
  // --- 词库解锁（仅线上加密版会用到）
  const gateGo = async () => {
    const pw = $('#gate-pw').value;
    if (!pw) { $('#gate-msg').textContent = '请输入密码'; return; }
    const btn = $('#gate-go');
    btn.disabled = true;
    $('#gate-msg').textContent = '正在解密…';
    const ok = await tryUnlock(pw);
    btn.disabled = false;
    if (ok) {
      $('#gate-pw').value = '';
      // 解锁后要把界面按词库已就绪重画一遍
      renderParseHint();
      renderRecent();
      renderNavBadge();
      renderDueStats();
      route();
    }
  };
  $('#gate-go')?.addEventListener('click', gateGo);
  $('#gate-pw')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); gateGo(); }
  });

  // --- 录入
  $('#input').addEventListener('input', renderParseHint);
  $('#opt-split').addEventListener('change', renderParseHint);
  $('#btn-preview').addEventListener('click', renderPreview);
  $('#btn-add').addEventListener('click', doAdd);

  $('#recent-body').addEventListener('click', (e) => {
    const w = e.target.dataset?.del;
    if (!w) return;
    if (confirm(`删除「${w}」？`)) { removeRecord(w); renderRecent(); renderNavBadge(); renderDueStats(); toast('已删除'); }
  });

  // --- 复习
  $('#btn-start-review').addEventListener('click', () => startSession(false));
  $('#btn-start-all').addEventListener('click', () => {
    if (!state.records.length) { toast('还没有生词'); return; }
    if (confirm(`要把全部 ${state.records.length} 个词过一遍吗？`)) startSession(true);
  });
  $('#btn-reveal').addEventListener('click', reveal);
  $('#rv-grades').addEventListener('click', (e) => {
    const g = Number(e.target.dataset?.g);
    if (g) grade(g);
  });
  $('#btn-rv-skip').addEventListener('click', () => { session.idx++; showCard(); });
  $('#btn-rv-quit').addEventListener('click', quitSession);
  $('#btn-done-back').addEventListener('click', () => { location.hash = '#review'; });

  // 桌面端顺手支持空格翻卡、1/2/3 打分
  document.addEventListener('keydown', (e) => {
    if (!session.active) return;
    if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); session.revealed ? null : reveal(); }
    if (session.revealed && ['1', '2', '3'].includes(e.key)) grade(Number(e.key));
  });

  // --- 生词本
  $('#filter-tier').addEventListener('click', (e) => {
    const t = e.target.dataset?.tier;
    if (!t) return;
    listFilter.tier = t; listLimit = 120; renderWordList();
  });
  $('#filter-state').addEventListener('click', (e) => {
    const s = e.target.dataset?.state;
    if (!s) return;
    listFilter.state = s; listLimit = 120; renderWordList();
  });
  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    const v = e.target.value;
    searchTimer = setTimeout(() => { listFilter.q = v; listLimit = 120; renderWordList(); }, 160);
  });
  $('#word-list').addEventListener('click', (e) => {
    if (e.target.id === 'btn-more') { listLimit += 200; renderWordList(); return; }
    const w = e.target.dataset?.del;
    if (w && confirm(`删除「${w}」？`)) { removeRecord(w); renderWordList(); renderNavBadge(); toast('已删除'); }
  });
  $('#btn-export').addEventListener('click', exportTSV);
  $('#btn-clear-done').addEventListener('click', () => {
    const done = state.records.filter((r) => (r.level || 0) >= S.MAX_LEVEL && (r.lapses || 0) === 0);
    if (!done.length) { toast('还没有已掌握的词'); return; }
    if (!confirm(`清理 ${done.length} 个已掌握的词？\n（可先用「我的 → 导出备份」留底）`)) return;
    for (const r of done) removeRecord(r.word);
    renderWordList(); renderNavBadge(); renderDueStats();
    toast(`已清理 ${done.length} 个`);
  });

  // --- 我的
  $('#btn-save-set').addEventListener('click', async () => {
    state.settings.examDate = $('#set-exam').value;
    state.settings.dailyLimit = Number($('#set-limit').value) || 0;
    state.settings.reviewDirection = $('#set-show').checked ? 'en2zh' : 'zh2en';
    mirrorToLocal();
    if (state.mode === 'static') {
      toast('设置已保存到本机');
      renderDueStats();
      return;
    }
    try {
      await api('/api/settings', { method: 'PUT', body: JSON.stringify(state.settings) });
      toast('设置已保存');
    } catch {
      toast('设置已存在本机，等服务恢复后同步');
    }
    renderDueStats();
  });

  $('#btn-backup').addEventListener('click', () => {
    download(`考研英语二生词备份_${today()}.json`, JSON.stringify({
      app: 'kaoyan2-vocab', version: 1, exportedAt: new Date().toISOString(),
      settings: state.settings, records: state.records,
    }, null, 2));
    toast('备份已导出');
  });
  $('#btn-import').addEventListener('click', () => $('#file-import').click());
  $('#file-import').addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      const incoming = Array.isArray(data) ? data : data.records;
      if (!Array.isArray(incoming)) throw new Error('格式不对');
      const before = state.records.length;
      // 导入是"用户主动合并"，用不着 outbox 那套删除语义：
      // 直接按 updatedAt 新的赢，两边都保留。
      state.records = unionRecords(state.records, incoming);
      for (const r of incoming) if (r && r.word) state.dirty.add(r.word);
      mirrorToLocal(); scheduleFlush();
      renderMe(); renderNavBadge(); renderDueStats();
      toast(`导入完成，生词数 ${before} → ${state.records.length}`);
    } catch (err) {
      toast('导入失败：' + err.message);
    }
    e.target.value = '';
  });

  // --- 导航
  window.addEventListener('hashchange', route);

  // 回到前台时补推一次，并重算到期
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { flush(); renderNavBadge(); renderDueStats(); }
  });
  window.addEventListener('online', () => flush());
  // 静态模式没有远端可推，不用轮询
  setInterval(() => {
    if (state.mode !== 'static' && (state.dirty.size || state.removed.size || !state.online)) flush();
  }, 20000);
}

// ---------------------------------------------------------------- 启动

async function main() {
  bind();
  await bootstrap();
  await loadVocab();
  route();
  renderParseHint();
  renderRecent();
  renderNavBadge();
  renderDueStats();
  // 本机模式下若是离线启动，补推一次；静态模式没有远端，flush 内部会直接落盘
  if (state.mode === 'server' && !state.online) flush();
}

main();
