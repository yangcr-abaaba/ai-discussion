# AI讨论会

## 产品简介

一个**不存任何数据**的「AI 讨论主持台」：在一个桌面窗口里并排嵌入多个 AI 网页（DeepSeek、豆包、千问、ChatGPT、Gemini…），让你**一句话同时发给多个 AI**，再**自动把各家的回答转发给其他 AI**，促成它们围绕同一个问题互相讨论、互相碰撞。你当主持人，随时插话、重定向。

> 它是「指挥棒，不是记事本」——产品本身不保存对话，讨论记录天然留在你各个 AI 网站的账号里。

## 核心特点

- **一句话群发**：同时把问题发给多个已登录的 AI 网页。
- **自动讨论**：等各 AI 答完，一键把每家的观点转发给其他 AI，并自动附上几条讨论规则，让它们真正"对话"而非各说各话。
- **主持人在场**：随时插话、继续追问。
- **多栏布局**：每个 AI 一栏，可刷新 / 最大化 / 关闭。
- **共享 Google 登录**：登一次 Google，ChatGPT / Gemini 可复用。
- **提示词管理**：维护可复用的提示词与"自动讨论"抬头规则。
- **零成本、零密钥、纯本地**：不调用付费 API，直接操作你已登录的 AI 网页；不连服务器、不存数据。

## 使用指南

1. 选 AI：在底部输入区选 1~3 个 AI，登录 AI 本身的账号，本产品不存储任何信息。
2. 群发提问：在输入框输入问题，点「发送」，同时发给所有 AI。发送方式（Enter / Ctrl+Enter）可点击发送旁的小箭头切换。
3. 自动讨论：等各 AI 答完后点「自动讨论」，自动把各 AI 的回答加上「自动讨论提示词」转发给其他 AI，让它们互相碰撞、深入讨论。
4. Google 登录：点「Google」按钮登录后，ChatGPT / Gemini 可共享这个登录。
5. AI 管理：每个 AI 栏顶部可刷新、最大化、关闭。
6. 提示词管理：右侧面板列出常用提示词，点一下即填进输入框；点「⚙ 管理」可增删改提示词；「自动讨论」提示词只能启用 1 条，会自动加在每次转发的最前面；常规提示词可启用多条。
7. 收起 / 调高：提示词面板右上角的按钮可收起整块输入区；上下拖动输入区顶部小横条调整高度。

## 下载安装（普通用户）

到本仓库的 **[Releases](../../releases)** 页面下载最新的 `AIDiscussion-Setup-x.x.x.exe`，双击安装即可。

> 因为没有购买代码签名证书，安装时 Windows SmartScreen 或安全软件可能提示"未知发布者"，点「仍要运行 / 允许」即可。

## 本地运行（开发者）

需要 [Node.js](https://nodejs.org/)。

```bash
npm install
npm start
```

## 打包成安装包

```bash
npm run dist
```

产物在 `dist/`。中国大陆网络下，安装依赖与打包建议用国内镜像：

```bash
# 安装依赖（跳过会从 GitHub 下载二进制的脚本）
npm install -D electron-builder --ignore-scripts --registry=https://registry.npmmirror.com

# 打包时让构建二进制走国内镜像
set ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/
npm run dist
```

> 若安全软件（如 360）在打包时锁住新生成的 exe 报 `EBUSY`，可把项目/输出目录加入其信任区，或临时暂停实时防护后重试。

## 技术说明

基于 **Electron**，用内嵌的 `<webview>`（隔离分区）直接驱动各 AI 网页：定位输入框 → 填字 → 触发发送 → 读取回答 → 转发。**没有用纯 `<iframe>`**，因为绝大多数 AI 站点用 `X-Frame-Options` / 同源策略 / 第三方 Cookie 限制，纯网页 iframe 既嵌不进也操作不了；webview 才能以"第一方顶层页面 + 可信注入"的方式绕过这些限制。

配置都在 `config/sites.json`（URL / 分区 / 选择器），代码不硬编码，方便适配网站改版。

## 项目结构（每个文件干什么）

```
ai-discussion/
├─ package.json          依赖清单 + 启动/打包脚本 + electron-builder 打包配置
├─ package-lock.json     依赖精确版本锁定（npm 自动维护，保证别人装到相同版本）
├─ README.md             就是本说明
├─ LICENSE               MIT 开源许可证
├─ .gitignore            告诉 git 哪些文件不入库（node_modules、dist、本地数据等）
│
├─ src/                  源代码（全部手写代码都在这里）
│  ├─ main.js            【主进程】Electron 入口：建窗口、自定义标题栏、开 webview 能力、
│  │                      Google 登录顶层窗口、外部链接走系统浏览器、窗口图标、Ctrl+R 重载等
│  ├─ index.html         【界面】整个 UI 的结构 + 全部样式（CSS 内联）：多栏区、底部输入区、
│  │                      提示词面板、提示词管理弹层、教程弹层、二次确认弹层等
│  ├─ renderer.js        【渲染进程】界面的全部交互逻辑：建多栏 webview、AI 开关、
│  │                      群发注入、读回答、自动讨论转发、提示词增删改、收起/拖高、记住偏好等
│  ├─ google-toolbar.html Google 登录窗口顶部的简易地址栏（前往/后退/刷新/复制）
│  └─ google-preload.js   Google 登录窗口的预加载脚本：禁用通行密钥(Passkey)，让 Google 回退到账号密码登录
│
├─ config/              外部配置（与代码分离，改它即可适配，不用动代码）
│  └─ sites.json         各 AI 站点的 URL、登录分区、CSS 选择器、讨论规则提示词、AI 上限等
│      （注：prompts.json / ui-state.json 是程序运行时自动生成的本地数据，已被 .gitignore 排除、不入库）
│
├─ assets/              图标资源
│  ├─ icon.svg           图标源文件（矢量）
│  ├─ icon.png           位图图标（256×256）
│  └─ icon.ico           Windows 用图标（多尺寸，窗口/任务栏/exe 都用它）
│
└─ dist/                打包输出目录（运行 npm run dist 后生成，已被 .gitignore 排除、不入库）
```

> 一句话：你真正要读/改的，都在 `src/`（代码）和 `config/sites.json`（配置）；其余要么是说明文件，要么是自动生成的东西。

## 免责声明

本工具只是自动化操作**你自己已登录的** AI 网站的网页界面，不隶属于、也不代表任何 AI 服务商。请遵守各 AI 服务的使用条款，合理、低频使用，避免触发其风控。

## 许可证

[MIT](LICENSE)

## 致谢
产品灵感来自日常使用多个AI共同讨论命题，希望能一个屏幕看到各AI，能做到统一发送、转发。后来了解到已经有相关开源项目了，遂在其他人开源项目的基础上开发此产品，感谢先行者的开源精神。

参考了以下两个开源项目，感兴趣的可移步：

https://github.com/lencx/Noi  参考了此项目的一屏管理多个AI，统一发送的设计。

https://github.com/axtonliu/ai-roundtable   参考了此项目的获取多个AI的输出，将AI的输入加上提示词发送给其他AI的设计。