'use strict';

// ============================================================================
// main.js —— Electron「主进程」（整个应用的入口与后台总管）
// ----------------------------------------------------------------------------
// Electron 应用分两类进程：
//   · 主进程（本文件）：全程只有一个，管窗口、菜单、系统集成等“幕后”事务，可用 Node / 系统 API。
//   · 渲染进程（src/renderer.js）：每个窗口一个，负责界面 DOM 与用户交互。
// 本文件主要做这几件事：
//   1) 创建主窗口（自定义标题栏 + 允许内嵌 AI 网页的 <webview> 能力）；
//   2) 打开 Google 登录用的顶层窗口（用 WebContentsView，绕开 Google 对内嵌环境的“不安全”拦截）；
//   3) 查 Google 登录态（读 cookie），供界面显示“已登录 / 未登录”小圆点；
//   4) AI 网页里点“外部链接”→ 交给系统默认浏览器打开（不在产品里弹窗）；
//   5) 给所有窗口设产品图标；把数据目录固定回原英文目录（防止改中文产品名后丢失登录态）；
//   6) 提供 Ctrl+R / F5 重载窗口，方便开发期边改边看。
// 关键概念：webview / WebContentsView 使用 "persist:xxx" 持久化分区 → cookie 写入磁盘，
//           关掉应用重开仍保持登录。这正是本产品“用网页登录、自己不存任何密码”的基础。
// ============================================================================

const { app, BrowserWindow, WebContentsView, Menu, ipcMain, session, shell } = require('electron');
const path = require('path');

// 从真实内核版本动态生成“普通 Chrome”身份（升级 Electron 后自动跟着变，无需手改版本号）。
const CHROME_MAJOR = (process.versions.chrome || '138').split('.')[0]; // 例 "138"
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_MAJOR}.0.0.0 Safari/537.36`;

// 产品图标（窗口/任务栏用）。assets/icon.ico 由 assets 下的设计生成。
const ICON_PATH = path.join(__dirname, '..', 'assets', 'icon.ico');

// ⚠️ 当前已停用（精简伪装实验）：曾把 Sec-CH-UA 伪装成“真 Chrome”做反检测，但实测发现
//    这类请求头/JS 篡改本身会被 Google 反机器人脚本识破，反而坏事。现改为“只去掉 UA 里的
//    Electron、其余保持干净 Chromium 原样”。保留此函数，若日后需要可再启用。
let googleHeadersPatched = false;
function patchGoogleHeaders(partition) {
  if (googleHeadersPatched) return;
  googleHeadersPatched = true;
  const ses = session.fromPartition(partition);
  ses.webRequest.onBeforeSendHeaders((details, cb) => {
    const h = details.requestHeaders;
    for (const k of Object.keys(h)) {
      if (/^sec-ch-ua/i.test(k) || /^x-requested-with$/i.test(k)) delete h[k];
    }
    h['User-Agent'] = CHROME_UA;
    h['Sec-CH-UA'] = `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not?A_Brand";v="99"`;
    h['Sec-CH-UA-Mobile'] = '?0';
    h['Sec-CH-UA-Platform'] = '"Windows"';
    cb({ requestHeaders: h });
  });
}

// 显示用产品名已改中文（package.json 的 productName=AI讨论会）。但 Electron 默认会把
// 数据目录也按新名字换成 %APPDATA%/AI讨论会，导致已保存的各 AI / Google 登录态全部丢失。
// 这里把数据目录固定回原英文目录，保住登录态。必须在 app ready 之前调用。
app.setPath('userData', path.join(app.getPath('appData'), 'ai-discussion'));

// 把「用户数据目录」路径同步给渲染进程。开启 asar 打包后，程序自身目录变为只读，
// 可写的配置（界面偏好 ui-state.json、提示词 prompts.json）必须改存到这个可写目录。
ipcMain.on('get-user-data-path', (e) => { e.returnValue = app.getPath('userData'); });

// 去掉 Electron 自带的英文默认菜单栏（File/Edit/View/Window/Help），界面更干净。
Menu.setApplicationMenu(null);

// AI 网页（webview）里点到“外部链接”→ 用系统默认浏览器打开，不在产品里弹窗。
// 只处理跨站(http/https 且域名不同)的新窗口；同站弹窗/特殊协议保持原样不动。
// 注意：Google 登录窗口用的是 WebContentsView（不是 <webview>），不在此列、行为不变。
app.on('web-contents-created', (e, contents) => {
  if (contents.getType() !== 'webview') return;
  contents.setWindowOpenHandler(({ url }) => {
    try {
      if (/^https?:\/\//i.test(url)) {
        const tgt = new URL(url), cur = new URL(contents.getURL());
        if (tgt.host !== cur.host) { shell.openExternal(url); return { action: 'deny' }; }
      }
    } catch (_) {}
    return { action: 'allow' }; // 同站弹窗等：保持原行为
  });
});

// 给所有新建窗口（含 Google 登录流程弹出的子窗口）统一设成产品图标，
// 否则那些弹窗会用 Electron 默认图标。
app.on('browser-window-created', (e, w) => { try { w.setIcon(ICON_PATH); } catch (_) {} });

// 宿主窗口引用：用于在 Google 登录窗口关闭后通知它重新查登录态。
let hostWin = null;

// 查 persist:google 分区里是否已登录 Google：看有没有登录态 cookie。
// 渲染进程的「Google」按钮据此显示「已登录 / 未登录」的小圆点。
ipcMain.handle('google-status', async (e, partition) => {
  try {
    const ses = session.fromPartition(partition || 'persist:google');
    const cookies = await ses.cookies.get({ domain: 'google.com' });
    const names = new Set(cookies.map(c => c.name));
    // 这几个是 Google 登录后才会下发的会话 cookie，任一存在即视为已登录。
    return ['SAPISID', '__Secure-1PSID', '__Secure-3PSID', 'SID', 'SSID'].some(n => names.has(n));
  } catch (_) { return false; }
});

// 打开 Google 登录窗口：顶部一条地址栏 + 下方真实网页内容（用 WebContentsView，
// 内容是真实 webContents、不是被 Google 严防的 <webview> 标签）。
// 精简伪装：唯一处理是把窗口 UA 里的 "Electron" 去掉（呈现为干净 Chromium 138）；
// 不再删通行密钥 / 覆盖 userAgentData / 改请求头——那些篡改痕迹反而会被反机器人脚本识破。
let googleWin = null, googleContent = null, googleToolbar = null;
const TOOLBAR_H = 44;

function layoutGoogle() {
  if (!googleWin || googleWin.isDestroyed()) return;
  const b = googleWin.getContentBounds();
  googleToolbar.setBounds({ x: 0, y: 0, width: b.width, height: TOOLBAR_H });
  googleContent.setBounds({ x: 0, y: TOOLBAR_H, width: b.width, height: Math.max(0, b.height - TOOLBAR_H) });
}
function sendGoogleUrl() {
  if (googleToolbar && !googleToolbar.webContents.isDestroyed() && googleContent && !googleContent.webContents.isDestroyed()) {
    googleToolbar.webContents.send('url', googleContent.webContents.getURL());
  }
}

ipcMain.on('open-google', (e, opts) => {
  if (googleWin && !googleWin.isDestroyed()) { googleWin.focus(); return; } // 已开就聚焦
  googleWin = new BrowserWindow({ width: 1200, height: 860, title: 'AI讨论会', icon: ICON_PATH });
  googleWin.maximize();

  // 顶部地址栏（本地可信页面，开放 node 以便用 ipc / clipboard）
  googleToolbar = new WebContentsView({ webPreferences: { nodeIntegration: true, contextIsolation: false } });
  googleWin.contentView.addChildView(googleToolbar);
  googleToolbar.webContents.loadFile(path.join(__dirname, 'google-toolbar.html'));

  // 下方网页内容（真实 Google 页面；与 chatgpt/gemini 共用 persist:google 分区 → 共享登录态）
  // 挂 google-preload.js：禁用通行密钥(Passkey)，避免登录时弹 Windows 原生验证框、回退到密码。
  googleContent = new WebContentsView({ webPreferences: {
    partition: opts.partition,
    preload: path.join(__dirname, 'google-preload.js'),
    contextIsolation: false  // 让预加载脚本能直接改页面里的 PublicKeyCredential
  } });
  googleContent.webContents.setUserAgent(CHROME_UA); // 唯一伪装：UA 去掉 Electron
  googleWin.contentView.addChildView(googleContent);

  layoutGoogle();
  googleWin.on('resize', layoutGoogle);
  googleContent.webContents.on('did-navigate', sendGoogleUrl);
  googleContent.webContents.on('did-navigate-in-page', sendGoogleUrl);

  // 加载失败兜底：google.com 需走代理，代理抖动会失败。重试几次，仍失败显示提示。
  let tries = 0; const MAX_TRIES = 3;
  const load = () => googleContent.webContents.loadURL(opts.url).catch(() => {});
  googleContent.webContents.on('did-fail-load', (ev, code, desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    if (tries < MAX_TRIES) { tries++; setTimeout(() => { if (googleContent && !googleContent.webContents.isDestroyed()) load(); }, 2000); }
    else if (googleContent && !googleContent.webContents.isDestroyed()) {
      const html = '<body style="font-family:system-ui,sans-serif;padding:48px;color:#27272a"><h2 style="font-weight:500">无法打开 Google</h2><p style="color:#52525b;line-height:1.7">加载失败（' + desc + '）。最常见原因：<b>需要科学上网/代理（如 Clash）但未开启或已断开</b>。请确认代理已连接后，在上方地址栏输入 accounts.google.com 前往。</p></body>';
      googleContent.webContents.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    }
  });
  load();

  googleWin.on('closed', () => {
    googleWin = null; googleContent = null; googleToolbar = null;
    // 通知宿主窗口：登录窗口已关，重新查一次 Google 登录态，刷新按钮上的圆点。
    if (hostWin && !hostWin.isDestroyed()) hostWin.webContents.send('google-closed');
  });
});

// 地址栏：前往 / 后退 / 刷新
ipcMain.on('google-nav', (e, url) => {
  if (!googleContent || googleContent.webContents.isDestroyed()) return;
  url = String(url || '').trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  googleContent.webContents.loadURL(url).catch(() => {});
});
ipcMain.on('google-back', () => {
  if (!googleContent || googleContent.webContents.isDestroyed()) return;
  const nh = googleContent.webContents.navigationHistory;
  if (nh && nh.canGoBack()) nh.goBack();
});
ipcMain.on('google-reload', () => {
  if (googleContent && !googleContent.webContents.isDestroyed()) googleContent.webContents.reload();
});

function createWindow() {
  const win = new BrowserWindow({
    width: 1200,
    height: 860,
    icon: ICON_PATH,
    // 启动防闪屏：先不显示窗口（show:false），等页面首帧渲染好（ready-to-show）再一次性显示；
    // 同时把窗口底色设成与界面一致的白色，这样即便有极短的空窗期也只是白色、不会黑屏。
    // 配合下方的 win.once('ready-to-show', ...)，可消除“先黑屏几秒、再白屏几秒”的启动闪烁。
    show: false,
    backgroundColor: '#ffffff',
    // 自定义标题栏：隐藏原生标题栏，但保留右上角原生的最小化/最大化/关闭按钮（覆盖层）。
    // 这样可以在标题栏里自己加“教程”按钮，放在这三个按钮左边。高度与 index.html 的 #titlebar 一致。
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f4f4f5', symbolColor: '#3f3f46', height: 36 },
    webPreferences: {
      // 宿主页面（index.html）是本地可信页面，开启 webview 标签能力。
      webviewTag: true,
      // 仅宿主页面需要读本地配置文件，这里放开 node 能力。
      // 注意：远程 AI 网页跑在各自隔离的 <webview> 里，不受此影响。
      nodeIntegration: true,
      contextIsolation: false
    }
  });

  // 打开即最大化（width/height 作为还原窗口时的尺寸）。
  win.maximize();

  hostWin = win; // 记下宿主窗口，供 Google 登录窗口关闭后回调通知

  // 方便边改边看：按 Ctrl+R 或 F5 重新加载窗口（改完 index.html / renderer.js 即时生效，
  // 不用关掉重开）。注意：改 main.js 仍需重新 npm start。
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return;
    const key = (input.key || '').toLowerCase();
    if (key === 'f5' || ((input.control || input.meta) && key === 'r')) win.webContents.reload();
  });

  win.loadFile(path.join(__dirname, 'index.html'));

  // 页面首帧渲染完成后再显示窗口，避免启动时露出黑屏/白屏空窗。
  // 兜底：万一某些环境下 ready-to-show 迟迟不触发，最多等 3 秒也强制显示，绝不卡在隐藏状态。
  let shown = false;
  const reveal = () => { if (shown || win.isDestroyed()) return; shown = true; win.show(); };
  win.once('ready-to-show', reveal);
  setTimeout(reveal, 3000);
}

app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
