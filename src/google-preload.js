'use strict';

// Google 登录窗口的预加载脚本：关闭“通行密钥/Passkey（WebAuthn）”能力。
// 目的：Google 默认会优先用通行密钥登录，从而弹出 Windows 安全中心的原生验证框
//       （扫码 / 安全密钥），体验差且容易被顺手关掉。把 WebAuthn 接口禁掉后，
//       Google 检测到“本浏览器不支持通行密钥”，会自动回退到账号+密码登录（与 Noi 一致）。
// 仅作用于这个 Google 窗口；不影响讨论用的各 AI 视图。
try {
  // 站点通常通过 window.PublicKeyCredential 是否存在来决定要不要走通行密钥。
  delete window.PublicKeyCredential;
  Object.defineProperty(window, 'PublicKeyCredential', { value: undefined, configurable: true });
} catch (_) {}
try {
  // 双保险：万一仍尝试调用，直接让通行密钥的获取/创建失败，触发回退到密码。
  if (navigator.credentials) {
    navigator.credentials.get = () => Promise.reject(new Error('passkey disabled'));
    navigator.credentials.create = () => Promise.reject(new Error('passkey disabled'));
  }
} catch (_) {}

// 注：曾在此覆盖 navigator.userAgentData 伪装“真 Google Chrome”，后证实没必要——
// Google 的拦截是“登录入口流程”问题（已用 myaccount.google.com 入口绕过），
// 而那种 JS 篡改反而是可被识破的痕迹。故移除，保持干净 Chromium。
