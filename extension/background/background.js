// background.js
// GGPoker记录下载助手后台脚本

// 下载记录和实时GTO 通信：后台在 GG 下载一完成就自动交给实时GTO 解析核对
importScripts("../shared/download-ledger.js", "../shared/rtgto-bridge.js");

// 国际化字典和翻译函数
const I18N = {
  zh: {
    login_tip: "请登录以使用插件",
    username_placeholder: "用户名",
    password_placeholder: "密码",
    login: "登录",
    register: "注册",
    clear: "清空",
    remember_pwd: "记住密码",
    logout: "退出",
    start: "开始",
    stop: "停止",
    pause: "暂停",
    start_date: "开始日期",
    end_date: "结束日期",
    date_interval: "日期间隔",
    interval_1: "1天",
    interval_2: "2天",
    interval_3: "3天",
    notice: "注意事项：",
    notice_1: "1. 下载过程中鼠标请勿频繁操作页面。",
    notice_2: "2. 若遇到异常、卡顿、操作无反应，请刷新页面后重新操作。",
    notice_3: "3. 按照提示手动下载概括信息或历史手牌记录。",
    notice_4: "4. 本插件只能下载锦标赛、极速现金局、德州扑克，三种游戏。",
    notice_5: "5. 如果一天玩的游戏记录比较多，建议间隔时间为一天。",
    help_link: "使用说明介绍",
    website_link: "RtGTO官网",
    privacy_policy_link: "隐私政策",
    // JS相关
    error_no_token: "未获取到登录凭证，请重新登录",
    error_network: "网络异常，操作失败",
    error_login: "请输入用户名和密码",
    error_login_failed: "登录失败，请重试",
    info_start: "开始自动化流程",
    info_stop: "已停止",
    info_pause: "已暂停",
    info_resume: "恢复中...",
    info_done: "全部操作完成！",
    error_no_date_select: "未找到日期下拉列表",
    error_no_custom_range: "未找到定制范围选项",
    error_no_summary_btn: "未找到游戏概要按钮",
    error_no_history_btn: "未找到历史手牌按钮",
    error_no_data: "没有数据",
    warning_manual: "请手动点击此按钮下载",
    side_panel_may_already_be_closed: "Side panel 可能已经关闭",
    error_updating_side_panel_availability: "更新 Side Panel 可用性时出错",
    chrome_version_not_supported: "Chrome 版本 {0} 不受支持，请升级到114或更高版本。",
    ggpoker_record_download_assistant: "GGPoker记录下载助手",
    this_page_does_not_support_ggpoker_record_download_assistant_please_use_ggpoker_website:
      "此页面不支持 GGPoker记录下载助手，请在 GGPoker 网站上使用。",
    error_opening_side_panel: "打开 Side Panel 时发生错误",
    an_error_occurred_while_opening_the_assistant_please_try_again: "打开助手时发生错误，请重试。",
    error_during_initialization: "初始化时发生错误",
    network_error_or_service_exception: "网络错误或服务异常",
    login_failed_or_invalid_account: "登录失败或账号无效",
    logout_failed: "退出失败",
    // ... 其他key
  },
  en: {
    // 英文翻译，后续补充
    login_tip: "Please log in to use the extension",
    username_placeholder: "Username",
    password_placeholder: "Password",
    login: "Login",
    register: "Register",
    clear: "Clear",
    remember_pwd: "Remember password",
    logout: "Logout",
    start: "Start",
    stop: "Stop",
    pause: "Pause",
    start_date: "Start Date",
    end_date: "End Date",
    date_interval: "Date Interval",
    interval_1: "1 day",
    interval_2: "2 days",
    interval_3: "3 days",
    notice: "Notice:",
    notice_1: "1. Please do not operate the page frequently during download.",
    notice_2: "2. If you encounter an exception、no response or freeze, please refresh the page and try again.",
    notice_3: "3. Follow the prompts to manually download summary or hand history records.",
    notice_4: "4. This plugin only supports downloading My Tournaments, Rush&Cash, and Hold'em, three types of games.",
    notice_5: "5. If you have played many game sessions in one day, it is recommended to take a one-day break.",
    help_link: "Help & Guide",
    website_link: "RtGTO Website",
    privacy_policy_link: "Privacy Policy",
    // JS相关
    error_no_token: "No login credential found, please log in again",
    error_network: "Network error, operation failed",
    error_login: "Please enter username and password",
    error_login_failed: "Login failed, please try again",
    info_start: "Automation started",
    info_stop: "Stopped",
    info_pause: "Paused",
    info_resume: "Resuming...",
    info_done: "All operations completed!",
    error_no_date_select: "Date dropdown not found",
    error_no_custom_range: "Custom range option not found",
    error_no_summary_btn: "Summary download button not found",
    error_no_history_btn: "Hand history download button not found",
    error_no_data: "No data",
    warning_manual: "Please click this button to download manually",
    side_panel_may_already_be_closed: "Side panel may already be closed",
    error_updating_side_panel_availability: "Error updating side panel availability",
    chrome_version_not_supported: "Chrome version {0} is not supported. Please upgrade to 114 or higher.",
    ggpoker_record_download_assistant: "GGPoker Record Download Assistant",
    this_page_does_not_support_ggpoker_record_download_assistant_please_use_ggpoker_website:
      "This page does not support GGPoker Record Download Assistant. Please use it on the GGPoker website.",
    error_opening_side_panel: "Error opening side panel",
    an_error_occurred_while_opening_the_assistant_please_try_again:
      "An error occurred while opening the assistant, please try again.",
    error_during_initialization: "Error during initialization",
    network_error_or_service_exception: "Network error or service exception",
    login_failed_or_invalid_account: "Login failed or account invalid",
    logout_failed: "Logout failed",
  },
};
let currentLang = "zh";
function t(key) {
  return I18N[currentLang][key] || key;
}

// 支持的网站列表
const SUPPORTED_SITES = ["https://my.pokercraft.com/*", "https://*.ggpoker.com/*"];

// 检查 URL 是否在支持的网站列表中
function isUrlSupported(url) {
  return SUPPORTED_SITES.some((pattern) => {
    const regex = new RegExp("^" + pattern.replace(/\*/g, ".*") + "$");
    return regex.test(url);
  });
}

// 更新 Side Panel 的可用性
async function updateSidePanelAvailability(tab) {
  try {
    if (!chrome.sidePanel) return;

    // 只允许 my.pokercraft.com
    const isSupported = tab.url && /^https:\/\/my\.pokercraft\.com\//.test(tab.url);

    await chrome.sidePanel.setOptions({
      enabled: isSupported,
      path: "sidepanel/sidepanel.html",
    });
  } catch (error) {
    console.error(t("error_updating_side_panel_availability"), error);
  }
}

// 检查 Chrome 版本
function getChromeVersion() {
  const match = navigator.userAgent.match(/Chrome\/(\d+)/);
  return match ? parseInt(match[1]) : 0;
}

// 检查是否支持 Side Panel API
function isSidePanelSupported() {
  const version = getChromeVersion();
  if (version < 114) {
    console.error(t("chrome_version_not_supported"), version);
    return false;
  }
  return chrome.sidePanel !== undefined;
}

// 显示版本提示
function showVersionWarning() {
  chrome.tabs.create({
    url: "sidepanel/version-warning.html",
    active: true,
  });
}

// 监听扩展图标点击
chrome.action.onClicked.addListener(async (tab) => {
  try {
    if (!isSidePanelSupported()) {
      showVersionWarning();
      return;
    }

    // 检查当前标签页是否支持
    if (!isUrlSupported(tab.url)) {
      // 如果当前页面不支持，直接显示一个通知
      chrome.notifications.create({
        type: "basic",
        iconUrl: "icons/icon128.png",
        title: t("ggpoker_record_download_assistant"),
        message: t("this_page_does_not_support_ggpoker_record_download_assistant_please_use_ggpoker_website"),
      });
      return;
    }

    // 打开 side panel
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    console.error(t("error_opening_side_panel"), error);
    // 显示错误通知
    chrome.notifications.create({
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: t("ggpoker_record_download_assistant"),
      message: t("an_error_occurred_while_opening_the_assistant_please_try_again"),
    });
  }
});

// 监听标签页更新
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status === "complete" && tab.url) {
    await updateSidePanelAvailability(tab);
  }
});

// 监听标签页切换
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tab = await chrome.tabs.get(activeInfo.tabId);
  await updateSidePanelAvailability(tab);
});

// 初始化设置
chrome.runtime.onInstalled.addListener(async () => {
  try {
    if (!isSidePanelSupported()) {
      showVersionWarning();
      return;
    }

    // 获取当前活动标签页
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tabs[0]) {
      await updateSidePanelAvailability(tabs[0]);
    }
  } catch (error) {
    console.error(t("error_during_initialization"), error);
  }
});

// ---------------------------------------------------------------- 调试日志
//
// service worker 的 console 在 chrome://extensions -> 本扩展 -> "检查视图 Service Worker"
// 里看。MV3 的 worker 会被挂起，console 历史会丢，所以同时写一份环形缓冲到
// chrome.storage.local，侧边栏/控制台可以用 { action: 'getLogs' } 取回来。

const LOG_RING_SIZE = 300;
const LOG_RING_KEY = "ggLogs";
let logRing = [];

function nowStamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** token / 密码一律不落日志，只留够认人的前后几位。 */
function mask(value) {
  if (!value) return "(空)";
  const s = String(value);
  if (s.length <= 8) return "*".repeat(s.length);
  return `${s.slice(0, 4)}...${s.slice(-4)} (长度${s.length})`;
}

function bgLog(level, scope, message, detail) {
  const line = `[BG][${nowStamp()}][${scope}] ${message}`;
  const style =
    {
      info: "color:#2563eb",
      ok: "color:#16a34a;font-weight:bold",
      warn: "color:#d97706;font-weight:bold",
      error: "color:#dc2626;font-weight:bold",
    }[level] || "";

  if (detail !== undefined) console.log("%c" + line, style, detail);
  else console.log("%c" + line, style);

  logRing.push({ t: Date.now(), level, scope, message, detail: safeDetail(detail) });
  if (logRing.length > LOG_RING_SIZE) logRing = logRing.slice(-LOG_RING_SIZE);
  try {
    chrome.storage.local.set({ [LOG_RING_KEY]: logRing });
  } catch (e) {
    /* storage 满了也不能影响主流程 */
  }
}

/** detail 里可能有不可序列化的东西（Error、Response），转成能存的形式。 */
function safeDetail(detail) {
  if (detail === undefined || detail === null) return undefined;
  if (detail instanceof Error) return { name: detail.name, message: detail.message };
  try {
    JSON.stringify(detail);
    return detail;
  } catch (e) {
    return String(detail);
  }
}

// ---------------------------------------------------------------- 后端地址
//
// 后端域名从 realtimegto.com 迁到了 rtgto.net。
// 旧域名虽然还解析得到同一台机器(47.242.138.218)，但那台机器出示的证书是
// CN=gateway.rtgto.net，SAN 里只有 gateway.rtgto.net / www.gateway.rtgto.net，
// 不含任何 realtimegto.com —— 所以 fetch 在 TLS 握手阶段就被拒，
// 表现为登录时直接落到 catch 里报"网络错误或服务异常"。
const API_BASE = "https://gateway.rtgto.net";
const API_TIMEOUT_MS = 20000;
const API = {
  login: `${API_BASE}/extension/anonymous/login`,
  userInfo: `${API_BASE}/extension/user/getUserInfo`,
  exit: `${API_BASE}/extension/user/exit`,
};

/**
 * 统一的接口调用：记录耗时、HTTP 状态、业务 code/msg，并把各类失败区分开。
 * 网络/TLS 失败和"接口返回了但业务失败"是两回事，之前混在一起报同一句话，
 * 完全没法判断是域名挂了还是账号密码错了。
 */
async function apiCall(name, url, { token, body } = {}) {
  const started = Date.now();
  const headers = { "Content-Type": "application/json" };
  if (token) headers["AccessToken"] = token;

  bgLog("info", name, `请求 ${url}`, {
    带token: token ? mask(token) : "否",
    // 密码绝不落日志
    参数: body ? Object.keys(body).filter((k) => k !== "password") : undefined,
  });

  // fetch 默认没有超时。走代理/VPN 时连接可能一直挂着不返回，
  // 界面就停在"登录中..."永远不动，什么日志都没有 —— 最难排查的情况。
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), API_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: ac.signal,
    });
  } catch (e) {
    const ms = Date.now() - started;
    if (e.name === "AbortError") {
      bgLog("error", name, `请求超时（${ms}ms，上限 ${API_TIMEOUT_MS}ms）`, { url });
      throw Object.assign(new Error("请求超时"), { kind: "timeout", url });
    }
    bgLog("error", name, `网络层失败（${ms}ms）：${e.message}`, {
      提示:
        "fetch 在这里抛异常通常是 DNS 解析不到、TLS 证书不匹配、" +
        "或者 manifest.json 的 host_permissions 没覆盖这个域名",
      url,
    });
    throw Object.assign(new Error(e.message), { kind: "network", url });
  } finally {
    clearTimeout(timer);
  }

  const ms = Date.now() - started;
  let data = null;
  let raw = "";
  try {
    raw = await res.text();
    data = raw ? JSON.parse(raw) : null;
  } catch (e) {
    bgLog("error", name, `响应不是合法 JSON（HTTP ${res.status}，${ms}ms）`, {
      前200字符: raw.slice(0, 200),
    });
    throw Object.assign(new Error("响应格式错误"), { kind: "badjson", status: res.status });
  }

  bgLog(
    res.ok && data && data.success ? "ok" : "warn",
    name,
    `HTTP ${res.status}（${ms}ms）success=${data && data.success} code=${data && data.code}`,
    { msg: data && data.msg },
  );

  return data;
}

// 工具函数：判断用户信息是否有效
// 注意 data.data 可能是 null（登录失败时后端返回 {success:false, msg:..., data:null}），
// 旧代码直接取 data.data.expireTime 会抛 TypeError，被外层 catch 吞掉后
// 统一报成"网络错误"，真正的失败原因（比如账号密码错误）反而看不到。
function isUserValid(data) {
  if (!data || data.success !== true || !data.data) return false;
  const expire = data.data.expireTime;
  if (!expire) {
    bgLog("warn", "auth", "接口返回 success 但没有 expireTime", data.data);
    return false;
  }
  const expireAt = new Date(expire);
  if (isNaN(expireAt.getTime())) {
    bgLog("warn", "auth", `expireTime 无法解析: ${expire}`);
    return false;
  }
  const valid = expireAt > new Date();
  if (!valid) bgLog("warn", "auth", `账号已过期: ${expire}`);
  return valid;
}

// 获取用户信息接口
async function fetchUserInfo(token) {
  return apiCall("getUserInfo", API.userInfo, { token });
}

// 登录接口
async function fetchLogin(userName, password) {
  return apiCall("login", API.login, { body: { userName, password } });
}

// 消息监听：鉴权与登录
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getLogs") {
    sendResponse({ logs: logRing });
    return true;
  }

  if (message.action === "clearLogs") {
    logRing = [];
    chrome.storage.local.remove(LOG_RING_KEY);
    sendResponse({ success: true });
    return true;
  }

  if (message.action === "checkAuth") {
    bgLog("info", "checkAuth", "开始校验本地登录状态");
    checkAuthWithAutoLogin().then(sendResponse);
    // 必须返回 true 以支持异步 sendResponse
    return true;
  }

  if (message.action === "login") {
    const { userName, password } = message;
    bgLog("info", "login", `尝试登录，用户名=${userName || "(空)"}，密码长度=${(password || "").length}`);

    fetchLogin(userName, password)
      .then((data) => {
        if (isUserValid(data)) {
          bgLog("ok", "login", `登录成功，到期 ${data.data.expireTime}`, {
            token: mask(data.data.accessToken),
          });
          chrome.storage.local.set(
            {
              accessToken: data.data.accessToken,
              expireTime: data.data.expireTime,
              userInfo: data.data,
            },
            () => {
              if (chrome.runtime.lastError) {
                bgLog("error", "login", `写入本地存储失败: ${chrome.runtime.lastError.message}`);
              }
              sendResponse({ success: true, userInfo: data.data });
            },
          );
        } else {
          // 到这里说明接口是通的，纯粹是业务失败 —— 把后端的 msg 原样透出去
          const msg = (data && data.msg) || t("login_failed_or_invalid_account");
          bgLog("warn", "login", `登录被拒绝：${msg}`, { code: data && data.code });
          sendResponse({ success: false, error: msg });
        }
      })
      .catch((e) => {
        bgLog("error", "login", `登录请求异常：${e.message}`, { kind: e.kind });
        sendResponse({ success: false, error: describeError(e) });
      });
    return true;
  }

  if (message.action === "logout") {
    bgLog("info", "logout", "开始退出登录");
    // 退出以本地为准：用户点了退出就必须退出。
    // 原来服务端接口一失败（token 已失效、断网）就原样返回，
    // 本地 token 和自动登录都还在，用户点了退出却还是登录状态。
    // 现在先清本地并关掉自动登录，再尽力通知服务端，失败只记日志。
    chrome.storage.local.get(["accessToken"], async (result) => {
      const token = result.accessToken;
      await storageSetP({ autoLogin: false }); // 用户主动退出，别再自动登回去
      await storageRemoveP(["accessToken", "expireTime", "userInfo"]);
      bgLog("ok", "logout", "已清除本地登录态并关闭自动登录（用户名/密码保留，方便下次手动登录）");
      sendResponse({ success: true });

      if (!token) return;
      try {
        const data = await apiCall("exit", API.exit, { token });
        if (!(data && data.success)) {
          bgLog("warn", "logout", `服务端退出未成功（不影响本地）：${data && data.msg}`);
        }
      } catch (e) {
        bgLog("warn", "logout", `服务端退出请求异常（不影响本地）：${e.message}`);
      }
    });
    return true;
  }
});

// ---------------------------------------------------------------- 自动登录
//
// 侧边栏每次打开都会发 checkAuth。流程：
//   1. 本地 token 有效 -> 直接放行；
//   2. token 缺失/失效，且用户勾了"记住密码，下次自动登录" -> 用保存的账号密码静默重登；
//   3. 都不行 -> 让侧边栏显示登录表单。
//
// 两个容易踩的坑：
//   · 自动登录因"密码错误/账号不存在"失败时，必须立刻关掉自动登录，
//     否则每次打开侧边栏都拿错误密码去撞服务器，可能把账号撞锁
//     （后端对这种情况返回的就是 "User does not exist or is locked"）；
//   · 网络错误不能清 token。原来网络抖一下就把 token 删了，等于断网一次就被登出。

function storageGetP(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSetP(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}
function storageRemoveP(keys) {
  return new Promise((resolve) => chrome.storage.local.remove(keys, resolve));
}

async function checkAuthWithAutoLogin() {
  const st = await storageGetP(["accessToken", "expireTime", "userInfo", "autoLogin", "lastUserName", "lastPassword"]);
  bgLog("info", "checkAuth", "读取本地凭证", {
    token: mask(st.accessToken),
    expireTime: st.expireTime || "(无)",
    autoLogin: !!st.autoLogin,
  });

  let lastError;

  // 1) 已有 token：先验证
  if (st.accessToken && st.expireTime && new Date(st.expireTime) > new Date()) {
    try {
      const data = await fetchUserInfo(st.accessToken);
      if (isUserValid(data)) {
        bgLog("ok", "checkAuth", `凭证有效，到期 ${data.data.expireTime}`);
        await storageSetP({ userInfo: data.data, expireTime: data.data.expireTime });
        return { authenticated: true, userInfo: data.data };
      }
      bgLog("warn", "checkAuth", "服务端判定凭证无效，清除本地 token", { msg: data && data.msg });
      await storageRemoveP(["accessToken", "expireTime", "userInfo"]);
      lastError = (data && data.msg) || undefined;
    } catch (e) {
      // 网络问题：保留 token，下次还能用；也别急着拿密码去重登（多半同样连不上）
      bgLog("error", "checkAuth", `校验失败（网络）：${e.message}，保留本地 token`, { kind: e.kind });
      return { authenticated: false, networkError: true, error: describeError(e) };
    }
  } else {
    bgLog("warn", "checkAuth", "本地无 token 或已过期");
  }

  // 2) 自动登录
  if (!st.autoLogin || !st.lastUserName || !st.lastPassword) {
    return { authenticated: false, error: lastError };
  }

  bgLog("info", "autoLogin", `尝试自动登录：${st.lastUserName}`);
  try {
    const data = await fetchLogin(st.lastUserName, st.lastPassword);
    if (isUserValid(data)) {
      await storageSetP({
        accessToken: data.data.accessToken,
        expireTime: data.data.expireTime,
        userInfo: data.data,
      });
      bgLog("ok", "autoLogin", `自动登录成功，到期 ${data.data.expireTime}`, {
        token: mask(data.data.accessToken),
      });
      return { authenticated: true, userInfo: data.data, autoLoggedIn: true };
    }
    // 业务失败（密码改了 / 账号被锁 / 已过期）：关掉自动登录，别反复撞
    const msg = (data && data.msg) || t("login_failed_or_invalid_account");
    await storageSetP({ autoLogin: false });
    bgLog("warn", "autoLogin", `自动登录被拒绝：${msg}，已关闭自动登录`, { code: data && data.code });
    return { authenticated: false, autoLoginFailed: true, error: msg };
  } catch (e) {
    bgLog("error", "autoLogin", `自动登录请求异常：${e.message}`, { kind: e.kind });
    return { authenticated: false, networkError: true, error: describeError(e) };
  }
}

/** 把底层异常翻译成用户能看懂、同时又能指明排查方向的一句话。 */
function describeError(e) {
  if (e && e.kind === "network") {
    return `${t("network_error_or_service_exception")}（无法连接 ${API_BASE}，请检查网络或代理设置）`;
  }
  if (e && e.kind === "timeout") {
    return `连接 ${API_BASE} 超时（${API_TIMEOUT_MS / 1000}秒），请检查网络或代理设置`;
  }
  if (e && e.kind === "badjson") {
    return `${t("network_error_or_service_exception")}（服务端返回异常，HTTP ${e.status}）`;
  }
  return t("network_error_or_service_exception");
}

// ---------------------------------------------------------------- 解析规则更新
//
// GG 前端改版会让写死的选择器全部失效（上次 Material 传统版 -> MDC 就是如此）。
// 所以解析规则做成可远程更新：页面解析不出来时，content script 会请求这里
// 去 RULES_URL 拉一份新规则，校验通过就存下来，下次注入立即生效 —— 不用发版。
//
// 抓取放在 service worker 而不是 content script：
// content script 受页面 CSP 约束，跨域抓取会被拦；worker 只受 host_permissions 管。

const RULES_STORAGE_KEY = "ggRules";
const RULES_URL_STORAGE_KEY = "ggRulesUrl";
const DEFAULT_RULES_URL = "https://gateway.rtgto.net/extension/open/pokercraft-rules.json";
const RULES_FETCH_TIMEOUT_MS = 15000;
// 规则拉取失败时不要每次解析失败都去打一次服务器
const RULES_RETRY_COOLDOWN_MS = 10 * 60 * 1000;
let lastRulesFetchAt = 0;

function storageGet(keys) {
  return new Promise((resolve) => chrome.storage.local.get(keys, resolve));
}
function storageSet(obj) {
  return new Promise((resolve) => chrome.storage.local.set(obj, resolve));
}

/**
 * 去远端拉一份解析规则。
 * 只做抓取和最基本的形状检查 —— 真正的校验（选择器语法是否合法等）需要 DOM，
 * 放在 content script 里用 GG_RULES.validateRules 做。
 */
async function fetchRemoteRules(force) {
  const now = Date.now();
  if (!force && now - lastRulesFetchAt < RULES_RETRY_COOLDOWN_MS) {
    const waitSec = Math.ceil((RULES_RETRY_COOLDOWN_MS - (now - lastRulesFetchAt)) / 1000);
    bgLog("info", "rules", `距上次拉取不足冷却时间，${waitSec}s 后再试`);
    return { ok: false, reason: "cooldown", retryAfterSec: waitSec };
  }
  lastRulesFetchAt = now;

  const stored = await storageGet([RULES_URL_STORAGE_KEY]);
  const url = stored[RULES_URL_STORAGE_KEY] || DEFAULT_RULES_URL;

  bgLog("info", "rules", `拉取解析规则: ${url}`);
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RULES_FETCH_TIMEOUT_MS);
  const started = Date.now();

  let res;
  try {
    res = await fetch(url, { method: "GET", cache: "no-cache", signal: ac.signal });
  } catch (e) {
    const ms = Date.now() - started;
    const reason = e.name === "AbortError" ? "超时" : e.message;
    bgLog("error", "rules", `拉取失败（${ms}ms）：${reason}`, {
      url,
      提示: "DNS 解析不到、证书不匹配、或 host_permissions 没覆盖这个域名",
    });
    return { ok: false, reason: `无法连接规则服务器：${reason}` };
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    bgLog("warn", "rules", `规则服务器返回 HTTP ${res.status}`, { url });
    return { ok: false, reason: `规则服务器返回 HTTP ${res.status}` };
  }

  let rules;
  try {
    rules = await res.json();
  } catch (e) {
    bgLog("error", "rules", "规则不是合法 JSON");
    return { ok: false, reason: "规则文件不是合法 JSON" };
  }

  if (!rules || typeof rules !== "object" || typeof rules.version !== "number") {
    bgLog("error", "rules", "规则缺少 version 字段", rules);
    return { ok: false, reason: "规则格式不对（缺少 version）" };
  }

  bgLog("ok", "rules", `拉到规则 v${rules.version}（${Date.now() - started}ms）`, {
    updatedAt: rules.updatedAt,
  });
  return { ok: true, rules, url };
}

/** 存下一份已经被 content script 校验通过的规则。 */
async function saveRules(rules) {
  await storageSet({
    [RULES_STORAGE_KEY]: { rules, savedAt: Date.now() },
  });
  bgLog("ok", "rules", `解析规则 v${rules.version} 已保存`);
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "fetchRules") {
    fetchRemoteRules(message.force).then(sendResponse);
    return true;
  }
  if (message.action === "saveRules") {
    saveRules(message.rules).then(() => sendResponse({ success: true }));
    return true;
  }
  if (message.action === "getStoredRules") {
    storageGet([RULES_STORAGE_KEY, RULES_URL_STORAGE_KEY]).then((r) => {
      sendResponse({
        stored: r[RULES_STORAGE_KEY] || null,
        url: r[RULES_URL_STORAGE_KEY] || DEFAULT_RULES_URL,
      });
    });
    return true;
  }
  if (message.action === "resetRules") {
    // 回到内置规则：把远端那份删掉即可
    chrome.storage.local.remove([RULES_STORAGE_KEY], () => {
      bgLog("info", "rules", "已清除远端规则，回退到内置规则");
      sendResponse({ success: true });
    });
    return true;
  }
});

// ---------------------------------------------------------------- GG 下载跟踪
//
// 用户每点一次 GG 的下载按钮，content script 发一条 ggDownloadClick 过来。
// 之后一段时间里浏览器开始的下载，都记下它的文件路径和最终状态（完成 / 中断）。
// 侧边栏按时间顺序把下载和"点下载"那条记录对上（GG_LEDGER.attachDownloads），
// 再交给实时GTO读取对应文件核对 —— 这样网络中断导致的下载失败也能发现。
//
// 只记点击之后 15 分钟内开始的下载，不记录用户其它无关的下载。

const GG_DOWNLOADS_KEY = "ggDownloads";
const GG_LAST_CLICK_KEY = "ggLastDownloadClickAt";
const GG_DOWNLOAD_WINDOW_MS = 15 * 60 * 1000;
const GG_DOWNLOADS_MAX = 300;

// 串行化：onCreated / onChanged 可能连着来，读-改-写不能交错
let ggDownloadsChain = Promise.resolve();

function updateGgDownloads(mutator) {
  ggDownloadsChain = ggDownloadsChain
    .then(async () => {
      const r = await storageGet([GG_DOWNLOADS_KEY]);
      const list = Array.isArray(r[GG_DOWNLOADS_KEY]) ? r[GG_DOWNLOADS_KEY] : [];
      const next = mutator(list);
      if (!next) return;
      if (next.length > GG_DOWNLOADS_MAX) next.splice(0, next.length - GG_DOWNLOADS_MAX);
      await storageSet({ [GG_DOWNLOADS_KEY]: next });
    })
    .catch((e) => bgLog("error", "download", `更新下载记录失败：${e && e.message}`));
  return ggDownloadsChain;
}

function ggDownloadRecord(item) {
  return {
    id: item.id,
    // 只留地址的前段，够判断来源就行
    url: String(item.finalUrl || item.url || "").slice(0, 200),
    file: item.filename || "",
    state: item.state || "in_progress",
    error: item.error || null,
    startTime: item.startTime ? Date.parse(item.startTime) : Date.now(),
    endTime: item.endTime ? Date.parse(item.endTime) : null,
    bytes: item.bytesReceived || 0,
    totalBytes: item.totalBytes || 0,
  };
}

if (chrome.downloads) {
  chrome.downloads.onCreated.addListener(async (item) => {
    // 扩展自己发起的下载（比如导出下载记录）不算
    if (item.byExtensionId) return;
    const r = await storageGet([GG_LAST_CLICK_KEY]);
    const clickAt = r[GG_LAST_CLICK_KEY] || 0;
    if (!clickAt || Date.now() - clickAt > GG_DOWNLOAD_WINDOW_MS) return;
    const rec = ggDownloadRecord(item);
    bgLog("info", "download", `GG 下载开始 #${rec.id}（点击后 ${Math.round((Date.now() - clickAt) / 1000)} 秒）`);
    updateGgDownloads((list) => list.filter((d) => d.id !== rec.id).concat([rec]));
  });

  chrome.downloads.onChanged.addListener((delta) => {
    updateGgDownloads((list) => {
      const d = list.find((x) => x.id === delta.id);
      if (!d) return null; // 不是我们跟踪的下载
      if (delta.filename) d.file = delta.filename.current;
      if (delta.state) d.state = delta.state.current;
      if (delta.error) d.error = delta.error.current;
      if (delta.endTime) d.endTime = Date.parse(delta.endTime.current);
      if (delta.bytesReceived) d.bytes = delta.bytesReceived.current;
      if (delta.totalBytes) d.totalBytes = delta.totalBytes.current;
      if (delta.state && delta.state.current !== "in_progress") {
        const ok = delta.state.current === "complete";
        bgLog(
          ok ? "ok" : "warn",
          "download",
          `GG 下载 #${d.id} ${ok ? "完成" : "中断"}${d.error ? "：" + d.error : ""}（${d.file || "无文件名"}）`,
        );
        scheduleAutoVerify(`下载 #${d.id} ${ok ? "完成" : "中断"}`);
      }
      return list;
    });
  });
}

// —— 自动解析 ——
//
// 每个 GG 下载一完成（或中断），就把它交给实时GTO 解析核对，不等整轮同步结束。
// 下载可能比"点了下载"那条记录先写好（content script 要等 GG 的弹窗处理完才记），
// 所以记录写入时也再触发一次；两个触发靠防抖合并。
// 实时GTO 没开、或关了自动解析时不发，留给侧边栏在同步结束 / 连上时一起核对。
let autoVerifyTimer = null;
let autoVerifyRunning = false;
let autoVerifyAgain = false;

function scheduleAutoVerify(reason) {
  clearTimeout(autoVerifyTimer);
  autoVerifyTimer = setTimeout(() => runAutoVerify(reason), 3000);
}

async function runAutoVerify(reason) {
  if (!self.GG_RTGTO) return;
  if (autoVerifyRunning) {
    autoVerifyAgain = true;
    return;
  }
  autoVerifyRunning = true;
  try {
    const out = await self.GG_RTGTO.verifyPending({ onlyFinished: true, trigger: "auto" });
    if (out.status === "done") {
      const c = out.counts || {};
      bgLog(
        c.bad ? "warn" : "ok",
        "rtgto",
        `自动解析（${reason}）：核对通过 ${c.ok || 0}，没下到 ${c.bad || 0}，下载中 ${c.downloading || 0}`,
      );
    } else if (out.status === "error") {
      bgLog("warn", "rtgto", `自动解析失败（${reason}）：${out.error}`);
    } else if (out.status !== "nothing") {
      bgLog("info", "rtgto", `自动解析跳过（${reason}）：${out.status}`);
    }
  } catch (e) {
    bgLog("error", "rtgto", `自动解析异常：${e && e.message}`);
  } finally {
    autoVerifyRunning = false;
    if (autoVerifyAgain) {
      autoVerifyAgain = false;
      scheduleAutoVerify("期间又有新下载");
    }
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.ggDownloadLedger) return;
  // 只在新增了"点了下载"的记录时触发；核对结果写回记录不算（否则自己触发自己）
  const before = changes.ggDownloadLedger.oldValue || [];
  const after = changes.ggDownloadLedger.newValue || [];
  if (after.length > before.length && after.slice(before.length).some((e) => e.status === "clicked")) {
    scheduleAutoVerify("新的下载记录");
  }
});

// 同步结束的收尾：把能核对的交给实时GTO 核一遍，并报告还在等的下载。
// 下载要时间：content script 按这里报的"还在等几个 / 下了多少字节"判断有没有进展，
// 有进展就接着等，而不是一到点就把没下完的判成缺失。
async function verifyOnce(trigger) {
  const R = self.GG_RTGTO;
  const out = await R.verifyPending({ trigger });
  const waiting = await R.waitingDownloads();
  const h = out.status === "not_connected" ? { ok: false } : await R.hello();
  bgLog(
    out.status === "error" ? "warn" : "info",
    "rtgto",
    `同步收尾核对：${out.status}，待下载开始 ${waiting.notStarted}，下载中 ${waiting.downloading}` +
      `${h.ok ? "" : "（实时GTO 未连接）"}`,
  );
  const progress = h.ok && h.info && h.info.progress ? h.info.progress : null;
  return Object.assign(
    { status: out.status, error: out.error || null, counts: out.counts || null, connected: h.ok, progress },
    waiting,
  );
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "rtgtoVerifyAll") {
    verifyOnce(message.trigger || "run_end")
      .then(sendResponse)
      .catch((e) => sendResponse({ status: "error", error: String((e && e.message) || e), connected: false }));
    return true;
  }
  if (message.action === "rtgtoProgress") {
    self.GG_RTGTO.progress()
      .then(sendResponse)
      .catch(() => sendResponse({ connected: false }));
    return true;
  }
  if (message.action === "ggDownloadClick") {
    storageSet({ [GG_LAST_CLICK_KEY]: Date.now() }).then(() => sendResponse({ ok: true }));
    return true;
  }
});

// Service Worker 控制台里可以直接改规则地址，方便自测
self.setRulesUrl = function (url) {
  return storageSet({ [RULES_URL_STORAGE_KEY]: url }).then(() => {
    bgLog("info", "rules", `规则地址已改为 ${url}`);
    return url;
  });
};

// 在 Service Worker 控制台里直接敲 dumpLogs() 就能看全部日志，
// copyLogs() 把日志拷成 JSON 文本（方便贴给别人排查）。
self.dumpLogs = function () {
  console.table(
    logRing.map((l) => ({
      时间: new Date(l.t).toLocaleTimeString(),
      级别: l.level,
      模块: l.scope,
      内容: l.message,
    })),
  );
  return logRing;
};
self.copyLogs = function () {
  return JSON.stringify(logRing, null, 2);
};

bgLog("info", "boot", `Service Worker 启动，后端 ${API_BASE}`);
