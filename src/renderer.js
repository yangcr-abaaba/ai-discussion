'use strict';

// ============================================================================
// renderer.js —— 渲染进程（主窗口 index.html 的全部交互逻辑）
// ----------------------------------------------------------------------------
// 跑在主窗口里，负责把界面和“操作各 AI 网页”的能力连起来。一切 URL / 分区 /
// userAgent / CSS 选择器都来自 config/sites.json，代码零硬编码（方便网站改版时只改配置）。
// 文件大致分这几块（从上往下）：
//   1) 配置/状态：路径常量、全局变量、读 sites.json。
//   2) 多栏视图：createWebview / createColumn / enableSite / disableSite / 最大化 / 栏头。
//   3) AI 开关：把站点做成可点的胶囊，开/关某栏，选满上限置灰（buildToggles/refreshChips/toggleSite）。
//   4) 注入收发（产品核心）：prepScript/fillTextareaScript/sendScript/injectOne —— 按输入框
//      类型分流（普通 textarea 用页内 value setter；contenteditable 富文本用 webview.insertText
//      可信输入），填字→触发发送→确认。sendToAll = 一句话群发给所有开启的 AI。
//   5) 读回答 + 自动讨论：readAnswer 读各家最新回答；continueDiscussion 把各家观点 + 抬头规则
//      转发给其他 AI，促成互相讨论。
//   6) 输入框 / 发送方式 / 收起展开 / 拖动调高 / 界面偏好持久化（ui-state.json）。
//   7) Google 登录状态、提示词面板与“提示词管理”弹层、教程弹层、删除二次确认。
// 注：函数多用“声明式”定义（function f(){}）以便被提前调用（JS 的函数声明会提升）。
// ============================================================================

const fs = require('fs');
const path = require('path');
const { ipcRenderer, shell } = require('electron');

// 只读站点配置：随程序一起打包（asar 内可正常读取）。
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'sites.json');

// 可写配置必须放在「用户数据目录」——因为开启 asar 后程序自身目录是只读的，写不进去。
// 这个目录由主进程同步返回（见 main.js 的 get-user-data-path）。
const USER_DATA = ipcRenderer.sendSync('get-user-data-path');
// 用户可编辑的提示词存这里（与 sites.json 分开，避免改动那份带注释的站点配置）。
const PROMPTS_PATH = path.join(USER_DATA, 'prompts.json');
// 界面偏好存这里：上次选了哪些 AI、发送方式、输入区高度。只存界面偏好，不存任何对话内容。
const UI_STATE_PATH = path.join(USER_DATA, 'ui-state.json');

// 状态文字已按需求移除显示；保留一个游离元素接收状态写入，避免各处代码报错。
const statusEl = document.getElementById('status') || document.createElement('span');
const viewsEl = document.getElementById('views');
const msgEl = document.getElementById('msg');
const sendBtn = document.getElementById('send');
const discussBtn = document.getElementById('discuss');
const togglesEl = document.getElementById('ai-toggles');
const aiCountEl = document.getElementById('ai-count'); // 已选/上限计数药丸

// site 配置与对应栏元素的清单（只含“当前已开启”的视图，顺序同配置）
const views = []; // [{ site, webview, col }]
const chipEls = new Map(); // site.id -> 顶部开关按钮元素
let appConfig = null; // 整份配置（含 discussionPrompt 等）
let maximizedId = null; // 当前被“最大化/独占”的栏 id（null = 多栏并排）
let uiState = loadUiState(); // 记住上次的 AI 选择 / 发送方式 / 输入区高度（loadUiState 声明已提升）

// 栏头按钮图标（内联 SVG，本地页面没引入图标字体）。
const SVG = {
  refresh: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36"/><path d="M21 4v5h-5"/></svg>',
  maximize: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/></svg>',
  restore: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="3" width="13" height="13" rx="2"/><path d="M16 18v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-9a2 2 0 0 1 2-2h1"/></svg>',
  close: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>'
};

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

// 把单个站点做成一个 webview 元素（含身份伪装与缩放），但不负责插进页面。
function createWebview(site) {
  const webview = document.createElement('webview');
  webview.setAttribute('src', site.url);
  webview.setAttribute('partition', site.partition); // ← 登录态持久化的关键（第1步已验证）
  webview.setAttribute('allowpopups', 'true');

  // 伪装成普通 Chrome，避免被判定为内嵌异常环境（第1步已验证）。
  const ua = site.userAgent || (appConfig && appConfig.userAgent);
  if (ua) webview.setAttribute('useragent', ua);

  // 按配置缩放该视图：给“为宽屏设计、塞进窄栏会挤爆/被裁”的站点（如千问）更宽的逻辑宽度。
  // 每次加载完成都重新应用（导航后缩放会重置）。
  if (site.zoomFactor && site.zoomFactor !== 1) {
    webview.addEventListener('dom-ready', () => {
      try { webview.setZoomFactor(site.zoomFactor); } catch (_) {}
    });
  }
  return webview;
}

// 建一栏：上方细栏头（AI名 + 圆点 + 刷新/最大化/关闭）+ 下方 webview。
function createColumn(site) {
  const col = document.createElement('div');
  col.className = 'col';
  col.dataset.id = site.id;

  const head = document.createElement('div');
  head.className = 'col-head';

  const name = document.createElement('div');
  name.className = 'col-name';
  name.innerHTML = '<span class="col-dot"></span>';
  name.appendChild(document.createTextNode(site.name));

  const tools = document.createElement('div');
  tools.className = 'col-tools';
  const refreshBtn = document.createElement('button');
  refreshBtn.className = 'col-tool'; refreshBtn.title = '刷新本栏'; refreshBtn.innerHTML = SVG.refresh;
  const maxBtn = document.createElement('button');
  maxBtn.className = 'col-tool'; maxBtn.dataset.role = 'max'; maxBtn.title = '最大化本栏'; maxBtn.innerHTML = SVG.maximize;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'col-tool'; closeBtn.title = '关闭本栏'; closeBtn.innerHTML = SVG.close;

  const webview = createWebview(site);
  refreshBtn.addEventListener('click', () => { try { webview.reload(); } catch (_) {} });
  maxBtn.addEventListener('click', () => toggleMaximize(site.id));
  closeBtn.addEventListener('click', () => toggleSite(site)); // 关栏 ⇄ 下方 AI 胶囊联动

  tools.append(refreshBtn, maxBtn, closeBtn);
  head.append(name, tools);
  col.append(head, webview);
  return { col, webview };
}

// 某站点当前是否已开启（有活动视图）。
function isActive(id) { return views.some(v => v.site.id === id); }

// 开启一个站点：新建栏并按“配置里的先后顺序”插到正确位置；
// 不动其它已有栏，避免它们被重新加载、丢掉正在进行的对话。
function enableSite(site) {
  if (isActive(site.id)) return;
  const order = (appConfig.sites || []).map(s => s.id);
  const myIdx = order.indexOf(site.id);
  // 找第一个“配置顺序排在我后面”的活动栏，插在它前面；没有就插到末尾。
  let beforeEl = null, at = views.length;
  for (let k = 0; k < views.length; k++) {
    if (order.indexOf(views[k].site.id) > myIdx) { beforeEl = views[k].col; at = k; break; }
  }
  const { col, webview } = createColumn(site);
  viewsEl.insertBefore(col, beforeEl); // beforeEl 为 null 时等同 appendChild
  views.splice(at, 0, { site, webview, col });
}

// 关闭一个站点：只移除它自己的栏，其它栏不受影响。
// 注意：网页对话本就保存在各 AI 网站上，关掉只是把这一栏从本工具移走；再次开启会重新加载该网页。
function disableSite(site) {
  const i = views.findIndex(v => v.site.id === site.id);
  if (i < 0) return;
  if (maximizedId === site.id) maximizedId = null; // 关掉的正好是最大化的那栏
  views[i].col.remove();
  views.splice(i, 1);
  applyMaximize();
}

// 栏头“最大化/还原”：让某栏独占整个区域，再点一次恢复多栏并排。纯界面切换，不动各 AI 内容。
function toggleMaximize(id) {
  maximizedId = (maximizedId === id) ? null : id;
  applyMaximize();
}
function applyMaximize() {
  const on = !!maximizedId && isActive(maximizedId);
  if (!on) maximizedId = null;
  viewsEl.classList.toggle('maximized', on);
  for (const v of views) {
    const isMax = on && v.site.id === maximizedId;
    v.col.classList.toggle('max', isMax);
    const btn = v.col.querySelector('[data-role="max"]');
    if (btn) {
      btn.innerHTML = isMax ? SVG.restore : SVG.maximize;
      btn.title = isMax ? '还原（恢复多栏）' : '最大化本栏';
    }
  }
}

// 顶部一排开关按钮：列出配置里的全部站点，点一下开/关对应栏。
function buildToggles() {
  togglesEl.innerHTML = '';
  chipEls.clear();
  for (const site of (appConfig.sites || [])) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    const dot = document.createElement('span'); dot.className = 'chip-dot';
    chip.append(dot, document.createTextNode(site.name));
    chip.addEventListener('click', () => toggleSite(site));
    togglesEl.appendChild(chip);
    chipEls.set(site.id, chip);
  }
  refreshChips();
}

// 同时参与讨论的 AI 上限（产品决策：最多 3 个，可在 config 的 maxAI 改）。
function maxAI() { return (appConfig && appConfig.maxAI) || 3; }

let busy = false; // 发送 / 继续讨论进行中：期间禁用所有开关

// 刷新全部开关按钮：高亮已开启的；选满上限时把“未开启”的置灰（不能再开第 4 个）；进行中全部禁用。
function refreshChips() {
  const atCap = views.length >= maxAI();
  for (const site of (appConfig.sites || [])) {
    const chip = chipEls.get(site.id);
    if (!chip) continue;
    const on = isActive(site.id);
    chip.classList.toggle('on', on);
    chip.disabled = busy || (!on && atCap);
    chip.title = on ? `点击关闭 ${site.name}`
      : (atCap ? `最多 ${maxAI()} 个，想换先关掉一个` : `点击开启 ${site.name}`);
  }
  if (aiCountEl) aiCountEl.textContent = `${views.length} / ${maxAI()}`;
}

function toggleSite(site) {
  if (isActive(site.id)) {
    disableSite(site);
  } else {
    if (views.length >= maxAI()) return; // 已选满，忽略（对应置灰的按钮）
    enableSite(site);
  }
  refreshChips();
  setReadyStatus();
  saveActiveAI(); // 记住这次的 AI 选择，下次启动还原
}

// 状态栏：显示当前讨论成员（发送/继续讨论时会被结果信息临时覆盖，属正常）。
function setReadyStatus() {
  statusEl.textContent = views.length
    ? '讨论成员：' + views.map(v => v.site.name).join('、')
    : '尚未开启任何 AI，请点左上方按钮开启';
}

function buildViews() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    statusEl.textContent = '读取配置失败：' + err.message;
    return;
  }
  appConfig = config;

  viewsEl.innerHTML = '';
  views.length = 0;

  // 启动时优先用“上次记住的 AI 选择”；没有记录就用配置里的 enabled 默认。顺序始终按配置顺序、不超上限。
  const remembered = Array.isArray(uiState.activeAI) ? uiState.activeAI : null;
  for (const site of (config.sites || [])) {
    const on = remembered ? remembered.includes(site.id) : site.enabled;
    if (on && views.length < maxAI()) {
      const { col, webview } = createColumn(site);
      viewsEl.appendChild(col);
      views.push({ site, webview, col });
    }
  }

  buildToggles();
  setReadyStatus();
}

// ---- 注入：按输入框类型分流（第2步 + 第4步三视图广播的核心）-------------------
// 两类输入框，注入方式不同：
//  A. 普通 <textarea>（DeepSeek、豆包）：React 受控组件，用原生 value setter + 派发 input 事件即可。
//  B. contenteditable 富文本编辑器（千问，Lexical 类）：合成事件一律不认（isTrusted=false），
//     必须用 Electron 的 webview.insertText() 发送“可信输入”，编辑器才会认账、发送键才会变亮。
// 发送：优先点配置的发送按钮；没配就模拟回车。确认：看输入框里我们发的字是否已消失。

// 在页内：定位输入框、聚焦、（富文本框则清空），返回类型
function prepScript(selectors) {
  const payload = JSON.stringify({ selectors });
  return `(() => {
    const { selectors } = ${payload};
    let input = selectors.input ? document.querySelector(selectors.input) : null;
    if (!input) input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
    if (!input) return { found: false, error: '找不到输入框' };
    input.focus();
    const tag = input.tagName;
    const type = (tag === 'TEXTAREA' || tag === 'INPUT') ? 'textarea' : 'contenteditable';
    if (type === 'contenteditable') {
      const s = window.getSelection();
      s.selectAllChildren(input); s.deleteFromDocument();
    } else {
      // 清空 textarea，便于“可信输入”从空白开始（对普通填字路径也无害，反正会被覆盖）
      const proto = tag === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, '');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    return { found: true, type };
  })()`;
}

// 在页内：给普通 textarea 填字（不发送）
function fillTextareaScript(text, selectors) {
  const payload = JSON.stringify({ text, selectors });
  return `(() => {
    const { text, selectors } = ${payload};
    let input = selectors.input ? document.querySelector(selectors.input) : null;
    if (!input) input = document.querySelector('textarea');
    if (!input) return false;
    const proto = input.tagName === 'INPUT' ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`;
}

// 在页内：触发发送并确认（看我们发的字是否已从输入框消失）
function sendScript(text, selectors) {
  const payload = JSON.stringify({ text, selectors });
  return `(async () => {
    const { text, selectors } = ${payload};
    let input = selectors.input ? document.querySelector(selectors.input) : null;
    if (!input) input = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
    const pressEnter = () => { if (input) for (const t of ['keydown', 'keypress', 'keyup']) input.dispatchEvent(new KeyboardEvent(t, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true })); };
    if (selectors.sendButton) {
      // 发送键可能在填字后才从“禁用”变“可用”（如 ChatGPT），实时盯着、一亮就点；最多兜底等 ~2.5s。
      let btn = null, waited = 0;
      while (waited <= 2500) {
        btn = document.querySelector(selectors.sendButton);
        if (btn && !btn.disabled) break;
        await new Promise(r => setTimeout(r, 150)); waited += 150;
      }
      // 配了发送按钮却一直不亮/找不到：直接判失败，不退回回车——富文本编辑器不认假回车，
      // 退回去也发不出去。真遇到选择器失效，用“配置发送按钮”功能改 config 解决。
      if (btn && !btn.disabled) btn.click();
    } else {
      // 没配发送按钮（DeepSeek/豆包这类普通文本框）：回车就是它们的正常发送方式。
      pressEnter();
    }
    await new Promise(r => setTimeout(r, 500));
    // 重新抓当前输入框（新对话发送后元素会被替换）
    let after = selectors.input ? document.querySelector(selectors.input) : null;
    if (!after) after = document.querySelector('textarea') || document.querySelector('[contenteditable="true"]');
    const val = after ? String(after.value !== undefined ? after.value : (after.innerText || '')) : '';
    // 发出去的判据：输入框里已不再包含我们刚发的文字（绕开千问空框里的占位符噪音）
    return { sent: !val.includes(text) };
  })()`;
}

// 对单个视图执行：定位 -> 填字（按类型分流）-> 发送确认
async function injectOne(site, webview, text) {
  const sel = site.selectors || {};
  const prep = await webview.executeJavaScript(prepScript(sel));
  if (!prep || !prep.found) return { error: (prep && prep.error) || '找不到输入框' };

  // 富文本框必须用可信输入；普通框若配了 trustedInput:true 也走可信输入（行为更像真人，
  // 降低豆包这类带风控的站点弹人机验证的概率）。
  const useTrusted = prep.type === 'contenteditable' || site.trustedInput === true;
  if (useTrusted) {
    await webview.insertText(text);
  } else {
    const ok = await webview.executeJavaScript(fillTextareaScript(text, sel));
    if (!ok) return { error: '填字失败' };
  }

  const r = await webview.executeJavaScript(sendScript(text, sel));
  return { filled: true, sent: !!(r && r.sent) };
}

async function sendToAll() {
  const text = msgEl.value.trim();
  if (!text) { statusEl.textContent = '请先输入内容'; return; }
  if (!views.length) { statusEl.textContent = '没有可用的视图'; return; }

  setBusy(true);
  statusEl.textContent = '注入中…';
  try {
    // 并行：三家同时注入（各 injectOne 只操作自己的 webview，互不共享状态）。Promise.all 保持顺序。
    const results = await Promise.all(views.map(async ({ site, webview }) => {
      try { return { site, r: await injectOne(site, webview, text) }; }
      catch (e) { return { site, r: { error: '异常（' + e.message + '）' } }; }
    }));
    const parts = [];
    let anyError = false;
    for (const { site, r } of results) {
      if (r.error) {
        anyError = true;
        parts.push(`${site.name}：失败（${r.error}）`);
      } else {
        if (!r.filled || !r.sent) anyError = true;
        parts.push(`${site.name}：${r.filled ? '已填✓' : '未填✗'} ${r.sent ? '已发✓' : '未发✗'}`);
      }
    }
    statusEl.textContent = parts.join('  |  ');

    // 全部成功发出后，清空我们自己的输入框，方便继续输入下一句。
    if (!anyError) msgEl.value = '';
  } finally {
    setBusy(false);
  }
}

// ---- 第3步核心：读取最新回答（只取正文）------------------------------------
// 用配置里的 latestResponse 选择器取“最后一个”回答容器，然后递归收集文本，
// 跳过：媒体(视频/音频/图片/svg/canvas/iframe)、按钮、以及配置 stripSelectors 指定的
// 引用资料/角标/视频卡/推荐卡等。效果等同点“复制”按钮拿到的纯正文。
function readStripSelectors(site) {
  const g = (appConfig && appConfig.stripSelectors) || [];
  const s = (site.stripSelectors) || [];
  return g.concat(s);
}
function buildReadScript(selectors, strip) {
  const payload = JSON.stringify({ selectors, strip: strip || [] });
  return `(() => {
    const { selectors, strip } = ${payload};
    const sel = selectors.latestResponse;
    if (!sel) return { error: '未配置回答选择器' };
    const nodes = document.querySelectorAll(sel);
    if (!nodes.length) return { error: '页面上还没有回答' };
    const last = nodes[nodes.length - 1];
    const SKIP_TAG = /^(VIDEO|AUDIO|IMG|SVG|CANVAS|PICTURE|IFRAME|BUTTON|STYLE|SCRIPT)$/;
    const BLOCK_TAG = /^(P|DIV|LI|UL|OL|H[1-6]|TR|BLOCKQUOTE|PRE|SECTION|ARTICLE|BR)$/;
    const isJunk = (el) => { for (const s of strip) { try { if (el.matches(s)) return true; } catch (_) {} } return false; };
    const collect = (el) => {
      let out = '';
      for (const node of el.childNodes) {
        if (node.nodeType === 3) { out += node.nodeValue; continue; }
        if (node.nodeType !== 1) continue;
        if (SKIP_TAG.test(node.tagName) || isJunk(node)) continue;
        out += collect(node);
        if (BLOCK_TAG.test(node.tagName)) out += '\\n';
      }
      return out;
    };
    const text = collect(last).replace(/[ \\t]+\\n/g, '\\n').replace(/\\n{3,}/g, '\\n\\n').trim();
    return { text, count: nodes.length };
  })()`;
}

// ---- 第5步：读回答 + 继续讨论（一个完整回合）-------------------------------
// 读回答：直接读一次最新回答即可。用户本来就在“亲眼看到 AI 答完”后才点继续讨论，
// 程序不必再自己轮询判断“答完没”——那套等稳定既慢（每家 ~2.4s），网页卡顿超阈值时
// 还会把“半截”误判成“答完”。读取本身只有几十毫秒，三家串行 <1s。
async function readAnswer(site, webview) {
  try {
    const r = await webview.executeJavaScript(buildReadScript(site.selectors || {}, readStripSelectors(site)));
    return (r && r.text) ? r.text : '';
  } catch (_) { return ''; }
}

function setBusy(b) {
  busy = b;
  sendBtn.disabled = discussBtn.disabled = b;
  // 发送/讨论进行中，禁用顶部开关（refreshChips 会同时兼顾“选满置灰”逻辑）。
  refreshChips();
}

// 继续讨论：等三家答完 → 读三家 → 给每家组合(别人观点 + 5条规则) → 逐个转发
async function continueDiscussion() {
  if (!views.length) { statusEl.textContent = '没有可用的视图'; return; }
  const eh = enabledHeaderPrompt(); // 当前启用的抬头提示词（最多 1 个）
  const prompt = (eh && eh.text) || (appConfig && appConfig.discussionPrompt) || '';
  setBusy(true);
  try {
    // 1) 逐个读一次各家最新回答（用户已确认答完才点；读取很快，无需轮询/并行）
    const answers = [];
    for (const { site, webview } of views) {
      statusEl.textContent = `读取 ${site.name}…`;
      const text = await readAnswer(site, webview);
      answers.push({ site, text });
    }

    // 2) 给每家组合“其他成员观点 + 5条规则”，逐个转发
    statusEl.textContent = '转发中…';
    // 并行转发：每家收到的是“别人的观点”（各不相同），各自只操作自己的 webview。
    const cap = (appConfig && appConfig.maxForwardChars) || 1500;
    const clip = t => (t.length > cap ? t.slice(0, cap) + '…（节选）' : t);
    const fwd = await Promise.all(views.map(async ({ site, webview }) => {
      const others = answers.filter(a => a.site.id !== site.id && a.text);
      if (!others.length) return { site, msg: '无其他观点可转发' };
      // 转发瘦身：过长的回答截断，避免一次塞超长内容触发风控/人机验证。
      const othersText = others.map(a => `【${a.site.name} 的观点】\n${clip(a.text)}`).join('\n\n');
      const message = `${prompt}\n\n以下是其他成员的观点，请基于此继续讨论：\n\n${othersText}`;
      try {
        const r = await injectOne(site, webview, message);
        return { site, msg: r.error ? '失败（' + r.error + '）' : (r.sent ? '已转发✓' : '未发✗') };
      } catch (e) {
        return { site, msg: '异常（' + e.message + '）' };
      }
    }));
    statusEl.textContent = fwd.map(f => `${f.site.name}：${f.msg}`).join('  |  ');
  } finally {
    setBusy(false);
  }
}

sendBtn.addEventListener('click', sendToAll);
discussBtn.addEventListener('click', continueDiscussion);

// ---- 界面偏好持久化（AI 选择 / 发送方式 / 输入区高度）-----------------------
// 只存界面偏好，不存任何对话内容（符合“彻底不存对话数据”的产品原则）。
function loadUiState() { try { return JSON.parse(fs.readFileSync(UI_STATE_PATH, 'utf-8')) || {}; } catch (_) { return {}; } }
function saveUiState() { try { fs.writeFileSync(UI_STATE_PATH, JSON.stringify(uiState, null, 2), 'utf-8'); } catch (e) { console.error('保存界面状态失败', e); } }
function saveActiveAI() { uiState.activeAI = views.map(v => v.site.id); saveUiState(); }

// ---- 底部输入区：整体收起 / 展开（收起按钮嵌在提示词面板右上角缺口里）---------
// 收起态是“一行精简版输入条”，与展开态共用同一套输入控件：因为两态从不同时显示，
// 直接把这些“活节点”(#ai-row / #msg / #discuss / #sendGroup)在两个骨架间搬移即可，
// 既不重复任何逻辑，又天然保留输入内容 / AI 选择 / 发送方式等状态。
const composerEl = document.getElementById('composer');
const composerMainEl = document.getElementById('composerMain');
const composerCollapsedEl = document.getElementById('composerCollapsed');
// 展开态里这些控件的“老家”容器
const inputPanelEl = document.getElementById('inputPanel');
const inputActionsEl = document.getElementById('inputActions');
const rightActionsEl = document.getElementById('rightActions');
const aiRowEl = document.getElementById('ai-row');
const sendGroupEl = document.getElementById('sendGroup');
// 收起态里的空槽位
const cAiSlot = document.getElementById('cAiSlot');
const cInputBox = document.getElementById('cInputBox');
const cInputBtns = document.getElementById('cInputBtns');
function setCollapsed(v) {
  if (v) {
    // 收起：把控件搬进精简条。AI选择→左槽位；输入框→输入盒；自动讨论/发送→输入盒内右侧。
    cAiSlot.appendChild(aiRowEl);
    cInputBox.insertBefore(msgEl, cInputBtns);
    cInputBtns.appendChild(discussBtn);
    cInputBtns.appendChild(sendGroupEl);
  } else {
    // 展开：搬回原位（顺序：#ai-row、#msg 在 #inputActions 之前；自动讨论、发送在 #rightActions 内）。
    inputPanelEl.insertBefore(aiRowEl, inputActionsEl);
    inputPanelEl.insertBefore(msgEl, inputActionsEl);
    rightActionsEl.appendChild(discussBtn);
    rightActionsEl.appendChild(sendGroupEl);
  }
  composerEl.classList.toggle('hidden', v);
  composerCollapsedEl.classList.toggle('hidden', !v);
  if (!v) ppRedraw(); // 回到展开态，提示词面板尺寸恢复，重画缺口边框
}
document.getElementById('collapseBtn').addEventListener('click', () => setCollapsed(true));
document.getElementById('expandBtn2').addEventListener('click', () => setCollapsed(false));

// ---- 输入区高度：上下拖把手调整，记住高度 -----------------------------------
// 默认/最矮 = 提示词面板约可容纳 3 栏；最高 = 约 6 栏。输入框不随字数变高，超出内部滚动。
const COMPOSER_MIN_H = 165, COMPOSER_DEFAULT_H = 165, COMPOSER_MAX_H = 400; // 最矮/默认≈2栏 / 最高≈6栏
function applyComposerHeight(h) {
  h = Math.min(COMPOSER_MAX_H, Math.max(COMPOSER_MIN_H, Math.round(h || COMPOSER_DEFAULT_H)));
  composerMainEl.style.height = h + 'px';
  ppRedraw(); // 高度变了，重画提示词面板缺口边框
  return h;
}
const resizeEl = document.getElementById('composerResize');
// 拖动时盖一层透明全屏遮罩在最上层：否则鼠标移到下方各 AI 的 webview 上时，webview 会
// “吞掉”鼠标事件，导致 mouseup 收不到、表现为“要再点一下才停”。遮罩接住 mousemove/mouseup。
const dragMask = document.createElement('div');
dragMask.style.cssText = 'position:fixed;inset:0;z-index:9999;cursor:ns-resize;display:none;';
document.body.appendChild(dragMask);
let rzStartY = 0, rzStartH = 0;
function onDragMove(e) { applyComposerHeight(rzStartH + (rzStartY - e.clientY)); } // 向上拖 = 变高
function endDrag() {
  dragMask.style.display = 'none';
  document.removeEventListener('mousemove', onDragMove);
  document.removeEventListener('mouseup', endDrag);
  uiState.composerHeight = composerMainEl.offsetHeight; saveUiState(); // 松手即记住高度
}
resizeEl.addEventListener('mousedown', (e) => {
  e.preventDefault();
  rzStartY = e.clientY; rzStartH = composerMainEl.offsetHeight;
  dragMask.style.display = 'block';
  document.addEventListener('mousemove', onDragMove);
  document.addEventListener('mouseup', endDrag);
});

// ---- 提示词面板：右上角缺口边框（SVG 画，随面板尺寸自动重绘）------------------
const promptPanelEl = document.getElementById('promptPanel');
const ppBorderSvg = document.getElementById('ppBorder');
const ppBorderPath = document.getElementById('ppBorderPath');
function ppNotchPath(w, h) {
  const nW = 50, nH = 30, r = 11;            // 缺口宽/高、圆角半径（与其它角一致）
  const x0 = 1, y0 = 1, x1 = w - 1, y1 = h - 1;
  const nx = x1 - nW, ny = y0 + nH;
  return `M${x0} ${y0 + r} Q${x0} ${y0} ${x0 + r} ${y0}`
    + ` H${nx - r} Q${nx} ${y0} ${nx} ${y0 + r}`
    + ` V${ny - r} Q${nx} ${ny} ${nx + r} ${ny}`
    + ` H${x1 - r} Q${x1} ${ny} ${x1} ${ny + r}`
    + ` V${y1 - r} Q${x1} ${y1} ${x1 - r} ${y1}`
    + ` H${x0 + r} Q${x0} ${y1} ${x0} ${y1 - r} Z`;
}
function ppRedraw() {
  const w = promptPanelEl.clientWidth, h = promptPanelEl.clientHeight;
  if (w <= 0 || h <= 0) return;
  ppBorderSvg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  ppBorderPath.setAttribute('d', ppNotchPath(w, h));
}
new ResizeObserver(ppRedraw).observe(promptPanelEl);

// ---- 发送快捷键切换（参考 QQ）----------------------------------------------
// 'enter' = Enter 发送 / Ctrl+Enter 换行（默认）；'ctrl' = Ctrl+Enter 发送 / Enter 换行。
// 仅在本次运行内有效，重启回到默认（产品不存数据）。
const sendOptsBtn = document.getElementById('sendOpts');
const sendMenu = document.getElementById('sendMenu');
let sendMode = (uiState.sendMode === 'ctrl') ? 'ctrl' : 'enter'; // 还原上次的发送方式

function applySendMode() {
  for (const b of sendMenu.querySelectorAll('button')) b.classList.toggle('active', b.dataset.mode === sendMode);
  msgEl.placeholder = sendMode === 'enter'
    ? '输入要发给 AI 的内容，Enter 发送、Ctrl+Enter 换行…'
    : '输入要发给 AI 的内容，Ctrl+Enter 发送、Enter 换行…';
}
sendOptsBtn.addEventListener('mousedown', (e) => e.preventDefault()); // 同理，点箭头不抢焦点
sendOptsBtn.addEventListener('click', (e) => {
  e.stopPropagation(); // 阻止冒泡，避免下面的“点别处关闭”立刻又把菜单关掉
  sendMenu.classList.toggle('hidden');
});
sendMenu.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-mode]');
  if (!btn) return;
  sendMode = btn.dataset.mode;
  uiState.sendMode = sendMode; saveUiState(); // 记住发送方式
  applySendMode();
  sendMenu.classList.add('hidden');
});
document.addEventListener('click', () => sendMenu.classList.add('hidden')); // 点页面别处关闭菜单
applySendMode();

// ---- AI 选择改为下拉（胶囊平铺在下拉里，支持多选；触发钮显示已选数）----------
// 为以后“接入很多 AI”留扩展空间：下拉可滚动，不挤占顶部横向空间。
const aiPicker = document.getElementById('aiPicker');
const aiMenu = document.getElementById('aiMenu');
aiPicker.addEventListener('click', (e) => { e.stopPropagation(); aiMenu.classList.toggle('hidden'); });
aiMenu.addEventListener('click', (e) => e.stopPropagation()); // 菜单内选/取消不关闭，便于连续多选
document.addEventListener('click', () => aiMenu.classList.add('hidden'));

// 收起态“提示词”按钮：点击切换提示词面板显示/隐藏（点面板内不关、点页面别处关）。
const cPromptBtn = document.getElementById('cPromptBtn');
const cPromptPop = document.getElementById('cPromptPop');
cPromptBtn.addEventListener('click', (e) => { e.stopPropagation(); cPromptPop.classList.toggle('show'); });
cPromptPop.addEventListener('click', (e) => e.stopPropagation()); // 面板内点击（含“管理”按钮）不冒泡触发关闭
document.addEventListener('click', () => cPromptPop.classList.remove('show'));

function insertNewlineAtCursor() {
  const s = msgEl.selectionStart, e2 = msgEl.selectionEnd;
  msgEl.value = msgEl.value.slice(0, s) + '\n' + msgEl.value.slice(e2);
  msgEl.selectionStart = msgEl.selectionEnd = s + 1;
}

msgEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (e.isComposing || e.keyCode === 229) return; // 中文输入法选词时的回车，不当作发送/换行
  const ctrl = e.ctrlKey || e.metaKey;
  const shouldSend = (sendMode === 'enter') ? !ctrl : ctrl;
  if (shouldSend) {
    e.preventDefault();
    if (!sendBtn.disabled) sendToAll();
  } else if (sendMode === 'enter' && ctrl) {
    // 'enter' 模式下 Ctrl+Enter 默认不会换行，手动插入；'ctrl' 模式下普通 Enter 会自然换行，无需干预。
    e.preventDefault();
    insertNewlineAtCursor();
  }
});

// ---- Google 账号登录（共享 persist:google 会话）-----------------------------
// 点「Google」请主进程弹出一个真正的顶层窗口打开 Google（不是内嵌 webview），
// 由用户自行登录/注销（产品不代填密码）。顶层窗口能绕开 Google 对内嵌环境的“不安全”拦截；
// 它与 chatgpt、gemini 共用 persist:google 分区——登一次 Google，登 ChatGPT/Gemini 时即可直接选这个账号。
function openGoogle() {
  const g = appConfig && appConfig.google;
  if (!g) { statusEl.textContent = '配置里没有 google 入口'; return; }
  ipcRenderer.send('open-google', { url: g.url, partition: g.partition, userAgent: g.userAgent || appConfig.userAgent });
}
// 按登录态更新页面上所有 Google 按钮的小圆点与文字（绿=已登录 / 灰=未登录）。
// 展开态、收起态各有一个 Google 按钮，都带 .g-status，一并更新。
function setGoogleStatus(loggedIn) {
  document.querySelectorAll('.g-status').forEach(el => {
    const dot = el.querySelector('.g-dot'), txt = el.querySelector('.g-text');
    if (dot) dot.style.background = loggedIn ? '#16a34a' : '#a1a1aa';
    if (txt) { txt.textContent = loggedIn ? '已登录' : '未登录'; txt.style.color = loggedIn ? '#16a34a' : '#a1a1aa'; }
  });
}
// 向主进程查 persist:google 分区里是否有 Google 登录 cookie。
async function refreshGoogleStatus() {
  const g = appConfig && appConfig.google;
  if (!g) return;
  try { setGoogleStatus(!!(await ipcRenderer.invoke('google-status', g.partition))); } catch (_) {}
}
document.getElementById('googleBtn').addEventListener('click', openGoogle);
document.getElementById('googleBtn2').addEventListener('click', openGoogle);
// 关掉 Google 登录窗口后、以及本窗口重新获得焦点时，重新查一次登录态。
ipcRenderer.on('google-closed', refreshGoogleStatus);
window.addEventListener('focus', refreshGoogleStatus);

// ---- 提示词：数据模型 -------------------------------------------------------
// 两类提示词，各自是一个有序列表，每条带 enabled 开关：
//   headerPrompts  = 「继续讨论」抬头提示词（最多启用 1 个，启用的那条会自动加在转发最前面）
//   regularPrompts = 常规提示词（启用数量不限）
// 只有“已启用”的会显示在右侧提示词面板。增删改/排序/启用在「提示词管理」弹层里做。
// 存到 config/prompts.json；旧格式(discussionHeader 字符串 + library)会自动迁移、不丢数据。
let promptStore = null;
function loadPromptStore() { try { return JSON.parse(fs.readFileSync(PROMPTS_PATH, 'utf-8')); } catch (_) { return null; } }
function savePromptStore() {
  try { fs.writeFileSync(PROMPTS_PATH, JSON.stringify(promptStore, null, 2), 'utf-8'); return true; }
  catch (e) { console.error('保存提示词失败', e); return false; }
}
function normPrompt(it) { return { name: String((it && it.name) || ''), text: String((it && it.text) || ''), enabled: !!(it && it.enabled) }; }
function migratePromptStore(raw) {
  // 已是新格式：规整字段后返回。
  if (raw && Array.isArray(raw.headerPrompts) && Array.isArray(raw.regularPrompts)) {
    return { headerPrompts: raw.headerPrompts.map(normPrompt), regularPrompts: raw.regularPrompts.map(normPrompt) };
  }
  // 旧格式 / 全新：迁移（保留用户已有内容）。
  const header = [];
  if (raw && typeof raw.discussionHeader === 'string' && raw.discussionHeader.trim()) {
    header.push({ name: '抬头规则', text: raw.discussionHeader, enabled: true });
  } else {
    header.push({ name: '5 条规则讨论', text: (appConfig && appConfig.discussionPrompt) || '', enabled: true });
  }
  let regular;
  if (raw && Array.isArray(raw.library)) {
    regular = raw.library.map(it => ({ name: (it && it.title) || '', text: (it && it.text) || '', enabled: true }));
  } else {
    regular = [
      { name: '总结要点', text: '请把以上讨论总结成 3-5 条要点，并指出仍存在分歧的地方。', enabled: true },
      { name: '深入反驳', text: '请针对上面最关键的一个观点，提出最有力的一种反驳或反例。', enabled: true }
    ];
  }
  return { headerPrompts: header.map(normPrompt), regularPrompts: regular.map(normPrompt) };
}
// 抬头提示词最多启用 1 个：若数据里出现多个 enabled，只保留第一个。
function enforceSingleHeader() {
  let seen = false;
  for (const p of promptStore.headerPrompts) {
    if (p.enabled && !seen) seen = true;
    else if (p.enabled) p.enabled = false;
  }
}
function initPromptStore() {
  promptStore = migratePromptStore(loadPromptStore());
  enforceSingleHeader();
  savePromptStore();
}
function enabledHeaderPrompt() { return promptStore.headerPrompts.find(p => p.enabled) || null; }

// ---- 提示词面板：只列“已启用”的提示词，点卡片=填进输入框（覆盖）----------
// 两处都用：展开态右侧面板 #pp-list，收起态“提示词管理”悬停弹层 #pp-list-c，内容一致。
const ppList = document.getElementById('pp-list');
const ppListC = document.getElementById('pp-list-c');

function applyPromptToMsg(textVal) {
  if (textVal == null) return;
  msgEl.value = textVal; // 覆盖输入框内容（输入框固定高度，超出内部滚动）
  msgEl.focus();
  cPromptPop.classList.remove('show'); // 收起态：选中提示词后收起面板
}
function buildPanelCard(title, text, isHeader) {
  const card = document.createElement('div');
  card.className = 'pp-card' + (isHeader ? ' header-rule' : '');
  card.title = text || ''; // 悬停显示全部
  const name = document.createElement('div'); name.className = 'pp-name'; name.textContent = title;
  const body = document.createElement('div'); body.className = 'pp-text'; body.textContent = text || '';
  card.append(name, body);
  card.addEventListener('click', () => applyPromptToMsg(text || '')); // 抬头卡也可点击填入
  return card;
}
// 把“已启用”的提示词渲染进指定列表容器（同一份内容可渲染到多个列表，故每次新建卡片节点）。
function renderPromptList(listEl) {
  listEl.innerHTML = '';
  const eh = enabledHeaderPrompt();
  if (eh) listEl.appendChild(buildPanelCard('当前抬头：' + (eh.name || '未命名'), eh.text, true));
  for (const p of promptStore.regularPrompts) {
    if (p.enabled) listEl.appendChild(buildPanelCard(p.name || '未命名', p.text, false));
  }
  if (!eh && !promptStore.regularPrompts.some(p => p.enabled)) {
    const empty = document.createElement('div'); empty.className = 'pp-empty';
    empty.textContent = '暂无启用的提示词，点「管理」添加并启用。';
    listEl.appendChild(empty);
  }
}
function renderPromptPanel() {
  renderPromptList(ppList);             // 展开态右侧面板
  if (ppListC) renderPromptList(ppListC); // 收起态悬停弹层
}

// ---- 提示词管理弹层：左侧两页签 + 右侧表格（增删改查 / 启用 / 拖动排序）--------
const pmModal = document.getElementById('pmModal');
const pmTableEl = document.getElementById('pmTable');
const pmContentTitle = document.getElementById('pmContentTitle');
const pmContentHint = document.getElementById('pmContentHint');
const pmTabBtns = pmModal.querySelectorAll('.pm-tab');
let pmActiveTab = 'header'; // 'header' | 'regular'
let pmDragFrom = null;

function currentList() { return pmActiveTab === 'header' ? promptStore.headerPrompts : promptStore.regularPrompts; }
function openPmModal() { pmActiveTab = 'header'; renderPmModal(); pmModal.classList.remove('hidden'); }
function closePmModal() {
  // 关闭时清掉“名称和内容都为空”的草稿行（新增后没填就直接关掉的情况）
  const clean = arr => arr.filter(p => (p.name && p.name.trim()) || (p.text && p.text.trim()));
  promptStore.headerPrompts = clean(promptStore.headerPrompts);
  promptStore.regularPrompts = clean(promptStore.regularPrompts);
  savePromptStore();
  renderPromptPanel();
  pmModal.classList.add('hidden');
}

function renderPmModal() {
  pmTabBtns.forEach(b => b.classList.toggle('active', b.dataset.tab === pmActiveTab));
  const isHeader = pmActiveTab === 'header';
  pmContentTitle.textContent = isHeader ? '“自动讨论”抬头提示词' : '常规提示词';
  pmContentHint.textContent = isHeader ? '仅启用 1 个' : '启用不限，只有“已启用”的会显示到首页';
  renderPmTable();
}
function renderPmTable() {
  const list = currentList();
  pmTableEl.innerHTML = '';
  const head = document.createElement('div'); head.className = 'pm-thead';
  head.innerHTML = '<span class="pm-no">序号</span><span class="pm-name">名称</span><span class="pm-text">内容</span><span class="pm-en">启用</span><span class="pm-op">操作</span>';
  pmTableEl.appendChild(head);
  if (!list.length) {
    const e = document.createElement('div'); e.className = 'pm-empty'; e.textContent = '还没有提示词，点「+ 新增」添加。';
    pmTableEl.appendChild(e); return;
  }
  list.forEach((item, idx) => pmTableEl.appendChild(buildPmRow(item, idx)));
}
function buildPmRow(item, idx) {
  const row = document.createElement('div'); row.className = 'pm-trow'; row.draggable = true;
  const no = document.createElement('span'); no.className = 'pm-no';
  const drag = document.createElement('span'); drag.className = 'drag'; drag.textContent = '⠿'; drag.title = '拖动排序';
  no.append(drag, document.createTextNode(String(idx + 1)));
  const name = document.createElement('span'); name.className = 'pm-name'; name.textContent = item.name || '（未命名）';
  const text = document.createElement('span'); text.className = 'pm-text'; text.textContent = item.text || ''; text.title = item.text || '';
  const en = document.createElement('span'); en.className = 'pm-en';
  const tg = document.createElement('span'); tg.className = 'tg' + (item.enabled ? ' on' : ''); tg.innerHTML = '<span class="knob"></span>';
  tg.title = item.enabled ? '已启用，点击禁用' : '已禁用，点击启用';
  tg.addEventListener('click', () => toggleEnable(idx));
  en.appendChild(tg);
  const op = document.createElement('span'); op.className = 'pm-op';
  const edit = document.createElement('a'); edit.className = 'pp-edit'; edit.textContent = '编辑';
  const del = document.createElement('a'); del.className = 'pp-del'; del.textContent = '删除';
  edit.addEventListener('click', () => openPmRowEditor(idx));
  del.addEventListener('click', () => {
    showConfirm('确定删除该提示词？删除后不可恢复。', () => {
      currentList().splice(idx, 1); savePromptStore(); renderPmTable(); renderPromptPanel();
    });
  });
  op.append(edit, document.createTextNode(' '), del);
  row.append(no, name, text, en, op);
  // 拖动排序
  row.addEventListener('dragstart', () => { pmDragFrom = idx; row.classList.add('dragging'); });
  row.addEventListener('dragend', () => row.classList.remove('dragging'));
  row.addEventListener('dragover', (e) => e.preventDefault());
  row.addEventListener('drop', (e) => { e.preventDefault(); movePmRow(pmDragFrom, idx); });
  return row;
}
function toggleEnable(idx) {
  const list = currentList(), it = list[idx];
  if (pmActiveTab === 'header') {
    const willEnable = !it.enabled;
    list.forEach(p => p.enabled = false); // 抬头单选：先全关
    it.enabled = willEnable;
  } else {
    it.enabled = !it.enabled; // 常规不限
  }
  savePromptStore(); renderPmTable(); renderPromptPanel();
}
function movePmRow(from, to) {
  if (from == null || from === to) return;
  const list = currentList();
  const [m] = list.splice(from, 1);
  list.splice(to, 0, m);
  pmDragFrom = null;
  savePromptStore(); renderPmTable(); renderPromptPanel();
}
function openPmRowEditor(idx, isNew) {
  renderPmTable(); // 先复位，确保只有一行处于编辑态
  const item = currentList()[idx];
  const row = pmTableEl.querySelectorAll('.pm-trow')[idx];
  if (!row || !item) return;
  row.innerHTML = ''; row.draggable = false; row.classList.add('editing');
  const form = document.createElement('div'); form.className = 'pm-edit';
  const ti = document.createElement('input'); ti.placeholder = '名称（必填）'; ti.value = item.name || '';
  const ta = document.createElement('textarea'); ta.rows = 4; ta.placeholder = '内容（必填）'; ta.value = item.text || '';
  const err = document.createElement('div'); err.className = 'pm-edit-err';
  const acts = document.createElement('div'); acts.className = 'pm-edit-actions';
  const save = document.createElement('button'); save.className = 'primary'; save.textContent = '保存';
  const cancel = document.createElement('button'); cancel.textContent = '取消';
  save.addEventListener('click', () => {
    const nm = ti.value.trim(), tx = ta.value.trim();
    if (!nm) { err.textContent = '请填写名称'; ti.focus(); return; } // 名称必填
    if (!tx) { err.textContent = '请填写内容'; ta.focus(); return; } // 内容必填
    item.name = ti.value; item.text = ta.value;
    savePromptStore(); renderPmTable(); renderPromptPanel();
  });
  cancel.addEventListener('click', () => {
    if (isNew) { currentList().splice(idx, 1); savePromptStore(); } // 新建未保存就取消：丢弃这条空行
    renderPmTable();
  });
  acts.append(save, cancel);
  form.append(ti, ta, err, acts);
  row.appendChild(form);
  ti.focus();
}
function addPmRow() {
  // 常规提示词新增即默认启用（填好就会出现在提示词面板）；抬头提示词默认不启用（最多只能启用 1 个，默认开会冲突）。
  const enabled = pmActiveTab === 'regular';
  currentList().push({ name: '', text: '', enabled }); // 名称默认不填，进编辑态后必填才能保存
  renderPmTable();
  openPmRowEditor(currentList().length - 1, true); // 直接进入编辑态（新建）
}

pmTabBtns.forEach(b => b.addEventListener('click', () => { pmActiveTab = b.dataset.tab; renderPmModal(); }));
document.getElementById('pmModalClose').addEventListener('click', closePmModal);
pmModal.addEventListener('click', (e) => { if (e.target === pmModal) closePmModal(); });
document.getElementById('pmAddRow').addEventListener('click', addPmRow);
document.getElementById('pmManage').addEventListener('click', openPmModal);
document.getElementById('manageBtn2').addEventListener('click', openPmModal);

// ---- 二次确认弹层（删除提示词时用）-----------------------------------------
const confirmModal = document.getElementById('confirmModal');
const confirmMsgEl = document.getElementById('confirmMsg');
let confirmCb = null;
function showConfirm(msg, cb) { confirmMsgEl.textContent = msg; confirmCb = cb; confirmModal.classList.remove('hidden'); }
function hideConfirm() { confirmModal.classList.add('hidden'); confirmCb = null; }
document.getElementById('confirmOk').addEventListener('click', () => { const cb = confirmCb; hideConfirm(); if (cb) cb(); });
document.getElementById('confirmCancel').addEventListener('click', hideConfirm);
confirmModal.addEventListener('click', (e) => { if (e.target === confirmModal) hideConfirm(); });

// ---- 教程弹层 ----------------------------------------------------------------
const tutorialModal = document.getElementById('tutorialModal');
document.getElementById('tutorialBtn').addEventListener('click', () => tutorialModal.classList.remove('hidden'));
document.getElementById('tutorialClose').addEventListener('click', () => tutorialModal.classList.add('hidden'));
tutorialModal.addEventListener('click', (e) => { if (e.target === tutorialModal) tutorialModal.classList.add('hidden'); });

// 教程“致谢”里的外链：用系统默认浏览器打开，避免点了把本应用窗口导航走。
document.addEventListener('click', (e) => {
  const a = e.target.closest('a.ext-link');
  if (a && a.href) { e.preventDefault(); try { shell.openExternal(a.href); } catch (_) {} }
});

buildViews();
initPromptStore();
renderPromptPanel();
refreshGoogleStatus();
applyComposerHeight(uiState.composerHeight || COMPOSER_DEFAULT_H); // 还原上次高度（没有则默认≈3栏）并画好缺口边框
ppRedraw();
