// sidepanel.js
let isRunning = false;
let isPaused = false;
let statusUpdateInterval = null;

// 获取DOM元素
const autoIntervalSpan = document.getElementById("auto-interval");
const syncPageTypeSpan = document.getElementById("sync-page-type");
const syncBadgeSpan = document.getElementById("sync-badge");
const syncWatermarkSpan = document.getElementById("sync-watermark");
const syncPendingSpan = document.getElementById("sync-pending");
const syncLastRunSpan = document.getElementById("sync-last-run");
const clearSyncBtn = document.getElementById("clear-sync-btn");
const copyLogBtn = document.getElementById("copy-log-btn");
const rulesInfoSpan = document.getElementById("rules-info");
const updateRulesLink = document.getElementById("update-rules-link");
const startStopBtn = document.getElementById("start-stop-btn");
const pauseResumeBtn = document.getElementById("pause-resume-btn");
const statusDiv = document.getElementById("status");
const loginForm = document.getElementById("login-form");
const loginBtn = document.getElementById("login-btn");
const clearBtn = document.getElementById("clear-btn");
const registerBtn = document.getElementById("register-btn");
const loginUser = document.getElementById("login-username");
const loginPwd = document.getElementById("login-password");
const loginError = document.getElementById("login-error");
const mainPanel = document.getElementById("main-panel");
// 退出按钮在顶栏右侧，和账号区分开，要单独控制显示
const rememberPwd = document.getElementById("remember-pwd");
const logoutBtn = document.getElementById("logout-btn");
const langSwitch = document.getElementById("lang-switch");
const langZh = document.getElementById("lang-zh");
const langEn = document.getElementById("lang-en");
const coverageHint = document.getElementById("coverage-hint");

// GG 自身的下载限制（gg-limits.js，HTML 里排在本文件之前加载）
const L = window.GG_LIMITS;

// 更新UI状态
let wasRunning = false;
function updateUI(status) {
  // 一轮同步结束（运行 -> 停止）后，水位线变了，卡片要重新拉一次
  if (wasRunning && !isRunning) {
    wasRunning = false;
    refreshSyncCard();
    // 最后一个文件可能刚开始下载，等几秒再核对；没下完的实时GTO 会报"下载中"，稍后自动再核
    if (typeof verifyWithRtgto === "function") setTimeout(() => verifyWithRtgto(true), 5000);
  } else if (isRunning) {
    wasRunning = true;
  }

  // 更新按钮文本
  startStopBtn.textContent = isRunning ? t("stop") : t("sync_now");
  pauseResumeBtn.textContent = isPaused ? t("resume") : t("pause");

  // 更新按钮状态
  pauseResumeBtn.disabled = !isRunning;
  // 同步/补下载共用一个运行状态：跑着的时候不能再开补下载
  if (typeof rtgtoVerifyBtn !== "undefined" && rtgtoVerifyBtn) {
    if (rtgtoVerifyBtn) rtgtoVerifyBtn.disabled = !rtgto.ok || rtgtoVerifying || isRunning;
  }

  renderVerifyLock(status.verifyWait);
  lastRunStatus = status;
  renderActivity();
  // 更新状态显示
  renderLog(status);
  // 进度按"天"算：批次跨度会自动调整，总批次数事先算不出来
  const totalRounds = status.totalRounds !== undefined ? status.totalRounds : 0;
  const currentRound = status.currentRound !== undefined ? status.currentRound : 0;
  if (autoIntervalSpan) {
    autoIntervalSpan.textContent = status.currentSpan
      ? t("interval_auto_n", { n: status.currentSpan })
      : t("interval_auto");
  }
  const totalRoundsSpan = document.getElementById("total-rounds");
  const currentRoundSpan = document.getElementById("current-round");
  // 环形进度条百分比
  const percent = totalRounds > 0 ? Math.floor((currentRound / totalRounds) * 100) : 0;
  const circle = document.getElementById("progress-bar");
  const text = document.getElementById("progress-text");
  const circumference = 2 * Math.PI * 20; // r=20
  const offset = circumference * (1 - percent / 100);
  if (circle) circle.setAttribute("stroke-dashoffset", offset);
  if (text) text.textContent = `${percent}%`;
  if (totalRoundsSpan) totalRoundsSpan.textContent = totalRounds;
  if (currentRoundSpan) currentRoundSpan.textContent = currentRound;
}

// —— 下载核对卡片里的"正在进行"：让用户随时知道扩展在等什么 ——
let lastRunStatus = null;
let rtProgress = null; // 实时GTO 此刻在做什么（hello 里的 progress）
let rtProgressAt = 0;

function renderActivity() {
  const el = document.getElementById("rtgto-activity");
  if (!el) return;
  const lines = [];
  const now = Date.now();
  const a = lastRunStatus && lastRunStatus.activity;
  if (a && a.kind === "dlwait" && now - (a.at || 0) < 5000) {
    lines.push(t("activity_dlwait", { label: a.label || "", secs: a.secs || 0 }));
  }
  if (a && a.kind === "pending" && now - (a.at || 0) < 10000) {
    lines.push(t("activity_pending", { n: a.n || 1, secs: a.secs || 0 }));
  }
  const running = (lastDownloads || []).filter((d) => d && d.state === "in_progress");
  if (running.length) {
    const mb = (running.reduce((n, d) => n + (d.bytes || 0), 0) / 1048576).toFixed(1);
    lines.push(t("activity_downloading", { n: running.length, mb }));
  }
  if (rtProgress && now - rtProgressAt < 10000) {
    if (rtProgress.importing && rtProgress.total > 0) {
      lines.push(
        t("activity_rt_import", { i: Math.min(rtProgress.processed + 1, rtProgress.total), n: rtProgress.total }),
      );
    } else if (rtProgress.verifying) {
      lines.push(t("activity_rt_verify", { q: rtProgress.queued || 0 }));
    }
  }
  const waiting = (lastLedger || []).filter(
    (x) => x.status === "clicked" && x.clickedAtMs && (!x.verify || x.verify.status === "downloading"),
  ).length;
  if (waiting && (lines.length || (lastRunStatus && lastRunStatus.isRunning))) {
    lines.push(t("activity_waiting_verify", { n: waiting }));
  }
  el.innerHTML = lines.map((l) => `<div>${escapeHtml(l)}</div>`).join("");
}

// 有事在进行时每 2 秒问一次实时GTO 在做什么（没事就不问，省得一直发请求）
setInterval(async () => {
  if (document.visibilityState !== "visible" || !Bridge || !rtgto.ok) return;
  const busy =
    (lastRunStatus && lastRunStatus.isRunning) ||
    rtgtoVerifying ||
    (lastDownloads || []).some((d) => d && d.state === "in_progress") ||
    (lastLedger || []).some(
      (x) => x.status === "clicked" && x.clickedAtMs && (!x.verify || x.verify.status === "downloading"),
    );
  if (!busy) {
    rtProgress = null;
    renderActivity();
    return;
  }
  try {
    const p = await Bridge.progress();
    rtProgress = p && p.connected ? p : null;
    rtProgressAt = Date.now();
  } catch (e) {
    rtProgress = null;
  }
  renderActivity();
}, 2000);

// 等实时GTO 核对期间（页面上有模态进度框）侧边栏也整个锁住，显示同样的进度
function renderVerifyLock(wait) {
  let el = document.getElementById("verify-lock");
  // 页面每 1.5 秒刷新一次；很久没刷新说明页面已关掉或刷新了，不能一直锁着
  if (!wait || !wait.at || Date.now() - wait.at > 20000) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement("div");
    el.id = "verify-lock";
    el.style.cssText =
      "position:fixed;inset:0;z-index:9999;background:rgba(255,255,255,.92);" +
      "display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;text-align:center";
    el.innerHTML =
      "<style>@keyframes gg-indet{0%{margin-left:-30%}100%{margin-left:100%}}</style>" +
      `<div style="font-size:15px;font-weight:600;margin-bottom:4px">${t("verify_lock_title")}</div>` +
      `<div style="font-size:12px;color:#666;margin-bottom:14px">${t("verify_lock_sub")}</div>` +
      '<div style="width:100%;max-width:320px;height:8px;background:#e8e8e8;border-radius:4px;overflow:hidden">' +
      '<div data-r="bar" style="height:100%;width:30%;background:#2e7d32;border-radius:4px"></div></div>' +
      '<div data-r="text" style="font-size:12px;margin-top:10px"></div>' +
      '<div data-r="file" style="font-size:11px;color:#888;margin-top:4px;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>';
    el.addEventListener(
      "click",
      (ev) => {
        ev.stopPropagation();
        ev.preventDefault();
      },
      true,
    );
    document.body.appendChild(el);
  }
  el.querySelector('[data-r="text"]').textContent = wait.text || "";
  el.querySelector('[data-r="file"]').textContent = wait.file || "";
  const bar = el.querySelector('[data-r="bar"]');
  if (wait.fraction == null) {
    bar.style.width = "30%";
    bar.style.animation = "gg-indet 1.4s linear infinite";
  } else {
    bar.style.animation = "none";
    bar.style.marginLeft = "0";
    bar.style.width = `${Math.max(2, Math.min(100, Math.round(wait.fraction * 100)))}%`;
  }
}

// 定期更新状态
function startStatusUpdate() {
  // 清除可能存在的旧定时器
  stopStatusUpdate();

  // 立即更新一次
  updateStatus();

  // 每秒更新一次
  statusUpdateInterval = setInterval(updateStatus, 1000);
}

// 停止状态更新
function stopStatusUpdate() {
  if (statusUpdateInterval) {
    clearInterval(statusUpdateInterval);
    statusUpdateInterval = null;
  }
}

// 从storage获取状态并更新UI
function updateStatus() {
  chrome.storage.local.get(["ggpokerStatus"], function (result) {
    if (result.ggpokerStatus) {
      isRunning = result.ggpokerStatus.isRunning;
      isPaused = result.ggpokerStatus.isPaused;
      updateUI(result.ggpokerStatus);
    }
  });
}

// 发送消息到 content script。
//
// 原来的写法是 chrome.tabs.sendMessage(id, msg) —— 不传回调，
// chrome.runtime.lastError 就没人读，失败被完全吞掉：
// 点"开始"后界面一点反应都没有，控制台也什么都不打。
// 最常见的触发场景是刚重装/刷新过扩展，已经打开的 PokerCraft 标签页里
// 跑的还是旧的(或根本没有) content script，消息自然送不到。
//
// 现在：找不到接收端就用 chrome.scripting 现场注入一次再重试，
// 还不行就把原因明确写到状态栏。

// 顺序必须和 manifest.json 的 content_scripts 一致
// （tools/check_load_order.js 会强制校验，改这里别忘了改 manifest）
const CONTENT_SCRIPT_FILES = [
  "shared/gg-limits.js",
  "shared/sync-state.js",
  "shared/download-ledger.js",
  "content/pokercraft-rules.js",
  "content/pokercraft-dom.js",
  "content/content-script.js",
];

function setStatus(msg, color) {
  if (!statusDiv) return;
  statusDiv.textContent = msg;
  statusDiv.style.color = color || "";
}

function queryTargetTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      resolve(tabs && tabs[0] ? tabs[0] : null);
    });
  });
}

function tabSendMessage(tabId, msg) {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, msg, (res) => {
      if (chrome.runtime.lastError) {
        resolve({ __error: chrome.runtime.lastError.message });
      } else {
        resolve(res);
      }
    });
  });
}

// 网络探针要注入页面自己的 JS 环境（MAIN world）才能包住 fetch/XHR，
// 和上面那批隔离环境的脚本不是一回事，得单独注一次。
const MAIN_WORLD_FILES = ["content/network-probe.js"];

async function injectContentScript(tabId) {
  console.log("[侧边栏] content script 不在，尝试现场注入", CONTENT_SCRIPT_FILES);
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: MAIN_WORLD_FILES,
    });
  } catch (e) {
    // 探针注入失败不致命，content script 会退回基于时间的判据
    console.warn("[侧边栏] 网络探针注入失败，将退回时间判据:", e && e.message);
  }
  await chrome.scripting.executeScript({
    target: { tabId },
    files: CONTENT_SCRIPT_FILES,
  });
}

// opts.quiet: 轮询类调用（比如刷新同步卡片）失败时不要往状态栏刷红字
async function sendMessage(action, data = {}, opts = {}) {
  const quiet = !!opts.quiet;
  const fail = (key) => {
    if (!quiet) setStatus(t(key), "#d35400");
    return null;
  };

  const tab = await queryTargetTab();
  if (!tab) return fail("error_no_tab");
  if (!/^https:\/\/my\.pokercraft\.com\//.test(tab.url || "")) {
    if (!quiet) console.warn("[侧边栏] 当前标签页不是 PokerCraft:", tab.url);
    return fail("error_wrong_page");
  }

  let res = await tabSendMessage(tab.id, { action, ...data });

  if (res && res.__error) {
    console.warn("[侧边栏] 首次发送失败:", res.__error);
    try {
      await injectContentScript(tab.id);
      await new Promise((r) => setTimeout(r, 300));
      res = await tabSendMessage(tab.id, { action, ...data });
    } catch (e) {
      console.error("[侧边栏] 注入失败:", e);
      if (!quiet) setStatus(t("error_inject_failed") + " " + (e.message || e), "#d35400");
      return null;
    }
  }

  if (res && res.__error) {
    console.error("[侧边栏] 注入后仍然发送失败:", res.__error);
    return fail("error_refresh_page");
  }

  if (res && res.error) {
    if (!quiet) setStatus(res.error, "#d35400");
    return null;
  }

  console.log(`[侧边栏] ${action} 已送达`, res);
  return res || {};
}

// —— 运行日志 ——
//
// 原来状态栏只显示最后一条消息，一刷新就没了，用户看不到过程，
// 出问题也没法把上下文发给开发者。现在把重要日志（警告/错误/成功/批次里程碑）
// 滚动列在这里，并提供"复制日志"一键取走。

let lastLogCount = -1;

function renderLog(status) {
  const entries = (status && status.importantLog) || [];

  if (!entries.length) {
    // 没有重要日志时退回显示最后一条，免得一片空白
    if (status && status.lastMessage) {
      statusDiv.textContent = status.lastMessage;
    } else {
      statusDiv.textContent = t("log_empty");
    }
    lastLogCount = 0;
    return;
  }

  // 条数没变就不重绘，避免用户往回翻的时候被强行拉到底部
  if (entries.length === lastLogCount) return;
  const atBottom =
    statusDiv.parentElement.scrollTop + statusDiv.parentElement.clientHeight >=
    statusDiv.parentElement.scrollHeight - 30;

  statusDiv.innerHTML = entries
    .map((e) => {
      // 分类标签（[batch] 之类）只在"复制日志"里保留，界面上占地方又看不懂
      return (
        `<div class="log-line ${e.type}"${e.ctx ? ` title="${escapeHtml(e.ctx)}"` : ""}>` +
        `<span class="lt">${escapeHtml(String(e.t || "").slice(0, 5))}</span>` +
        `<span class="lm">${escapeHtml(e.msg)}</span></div>`
      );
    })
    .join("");

  lastLogCount = entries.length;
  // 本来就在底部才自动跟随
  if (atBottom) {
    statusDiv.parentElement.scrollTop = statusDiv.parentElement.scrollHeight;
  }
}

// 日志内容来自页面，必须转义后再塞进 innerHTML
function escapeHtml(str) {
  return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

copyLogBtn &&
  copyLogBtn.addEventListener("click", async function () {
    const res = await new Promise((r) =>
      chrome.storage.local.get(["ggpokerStatus", "ggRtgtoLastVerify", "ggClickStats"], r),
    );
    const st = (res && res.ggpokerStatus) || {};
    const lastVerify = res && res.ggRtgtoLastVerify;
    const clickStats = Array.isArray(res && res.ggClickStats) ? res.ggClickStats.slice(-10) : [];
    const entries = st.importantLog || [];
    // 版本号测试期间不变，靠构建编号看出用的是哪一版扩展
    let build = "-";
    try {
      const r = await fetch(chrome.runtime.getURL("build-info.json"));
      if (r.ok) build = (await r.json()).build || "-";
    } catch (e) {
      /* 没有打包信息（直接加载源码） */
    }
    const header = [
      `GGPoker助手 运行日志`,
      `扩展: v${chrome.runtime.getManifest().version} 构建 ${build}`,
      `时间: ${new Date().toLocaleString()}`,
      `同步区间: ${st.syncFrom || "-"} ~ ${st.syncTo || "-"}`,
      `已同步至: ${st.lastSyncedDate || "-"}`,
      `进度: ${st.currentRound || 0}/${st.totalRounds || 0} 天`,
      "---",
    ].join("\n");
    let body = entries.length ? entries.map((e) => `${e.t} [${e.ctx || "-"}] ${e.type}: ${e.msg}`).join("\n") : "(无)";
    // 下载有没有到手是实时GTO 核对的，出问题时它那边的每一步都要一起发给开发者
    // 最近几轮的点击统计：分析怎么减少点击用
    if (clickStats.length) {
      body +=
        "\n--- 最近 " + clickStats.length + " 轮点击统计 ---\n" + clickStats.map((s) => JSON.stringify(s)).join("\n");
    }
    if (lastVerify) {
      body +=
        "\n--- 最近一次实时GTO核对 " +
        (lastVerify.at || "") +
        " ---\n" +
        (lastVerify.sent || []).join("\n") +
        "\n" +
        (lastVerify.log || []).join("\n") +
        (lastVerify.error ? "\n错误: " + lastVerify.error : "");
    }

    try {
      await navigator.clipboard.writeText(header + "\n" + body);
      setStatusHint(t("log_copied", { n: entries.length }));
    } catch (err) {
      console.error("[侧边栏] 复制失败", err);
      setStatusHint(t("log_copy_failed"));
    }
  });

// 复制结果这类一次性提示不进日志列表，2 秒后自动消失
function setStatusHint(text) {
  const tip = document.createElement("div");
  tip.className = "log-line success";
  tip.innerHTML = `<span class="lm">${escapeHtml(text)}</span>`;
  statusDiv.appendChild(tip);
  statusDiv.parentElement.scrollTop = statusDiv.parentElement.scrollHeight;
  setTimeout(() => tip.remove(), 2000);
}

// —— 同步卡片 ——
//
// 用户不再选日期。插件记住"这个页面类型已经同步到哪一天"，
// 每次点同步就把从那天之后到今天的记录补齐。

const PAGE_TYPE_KEY = {
  tournament: "page_tournament",
  rushAndCash: "page_rush_and_cash",
  holdem: "page_holdem",
  plo: "page_plo",
};

let currentPlan = null; // 最近一次从页面拿到的同步计划

function renderSyncCard(info) {
  currentPlan = info || null;
  // 切换分类后，下载核对卡片也换成这个分类的情况
  try {
    renderRtgto();
  } catch (e) {
    /* 页面初始化时还没准备好，稍后会再画 */
  }

  if (clearSyncBtn) {
    clearSyncBtn.disabled = !info;
    clearSyncBtn.textContent = info
      ? t("clear_sync_page", { page: t(PAGE_TYPE_KEY[info.pageType] || "badge_unknown") })
      : t("clear_sync");
  }
  if (!info) {
    syncPageTypeSpan.textContent = "—";
    syncBadgeSpan.textContent = t("badge_unknown");
    syncBadgeSpan.style.background = "#334155";
    syncWatermarkSpan.textContent = "—";
    syncLastRunSpan.textContent = "—";
    syncPendingSpan.textContent = "—";
    coverageHint.innerHTML = "";
    startStopBtn.disabled = true;
    return;
  }

  const { pageType, hasSummary, saved, plan } = info;

  syncPageTypeSpan.textContent = t(PAGE_TYPE_KEY[pageType] || "badge_unknown");
  // 只有锦标赛(MTT)有"游戏概要"，其它两种只有手牌详情 —— 直接标出来
  syncBadgeSpan.textContent = hasSummary ? t("badge_summary_hands") : t("badge_hands_only");
  syncBadgeSpan.style.background = hasSummary ? "#1e3a2f" : "#3a2f1e";
  syncBadgeSpan.style.color = hasSummary ? "#4ade80" : "#fbbf24";

  syncWatermarkSpan.textContent = saved.lastSyncedDate || t("never_synced");
  // 只看"真正下载了数据"的时间。旧版本记录的 lastRunAt 混着点击同步的时间，不再使用。
  renderLastRun(saved.lastDataSyncAt, !!saved.lastSyncedDate);

  if (plan.nothingToDo) {
    syncPendingSpan.textContent = t("up_to_date");
    syncPendingSpan.style.color = "#64748b";
    startStopBtn.disabled = true;
  } else {
    syncPendingSpan.textContent = `${plan.from} ~ ${plan.to}（${plan.days} ${t("progress_days")}）`;
    syncPendingSpan.style.color = "#4ade80";
    startStopBtn.disabled = false;
  }

  const lines = [];
  if (plan.staleWatermark) {
    lines.push(`<span style="color:#f87171;">● ${t("stale_watermark")}</span>`);
  }
  if (!plan.nothingToDo) {
    if (plan.history && hasSummary) {
      lines.push(
        `<span style="color:#4ade80;">● ${t("coverage_both")}</span>：${plan.history.start} ~ ${plan.history.end}`,
      );
    } else if (plan.history) {
      lines.push(
        `<span style="color:#4ade80;">● ${t("coverage_hands")}</span>：${plan.history.start} ~ ${plan.history.end}`,
      );
    }
    // 非 MTT 页面的同步窗口本来就只有 3 个月，不会有"仅概要"那一段
    if (plan.summaryOnly && hasSummary) {
      lines.push(
        `<span style="color:#fbbf24;">● ${t("coverage_summary_only")}</span>：${plan.summaryOnly.start} ~ ${plan.summaryOnly.end}`,
      );
    }
  }
  lines.push(`<span style="color:#64748b;">${hasSummary ? t("coverage_note") : t("coverage_note_hands_only")}</span>`);
  coverageHint.innerHTML = lines.join("<br>");
  // 分类或同步进度变了，能补的范围也跟着变
  if (typeof renderRepair === "function") renderRepair();
}

// "上次数据同步"：最近一次真正下载到数据的时间（不是点击同步的时间）。
// 绝对时间用本地时区，相对时间让人一眼看出离上次拿到新数据过了多久。
function renderLastRun(ts, hasWatermark) {
  if (!ts) {
    // 有水位线但没时间：是旧版本同步的，那时还没记录这个字段
    syncLastRunSpan.textContent = hasWatermark ? "—" : t("never_synced");
    return;
  }
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, "0");
  const abs = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  syncLastRunSpan.innerHTML = `${escapeHtml(abs)}<span class="ago">${escapeHtml(timeAgo(ts))}</span>`;
}

function timeAgo(ts) {
  const sec = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (sec < 60) return t("ago_just_now");
  const min = Math.round(sec / 60);
  if (min < 60) return t("ago_minutes", { n: min });
  const hr = Math.round(min / 60);
  if (hr < 24) return t("ago_hours", { n: hr });
  return t("ago_days", { n: Math.round(hr / 24) });
}

// 向页面要一份最新的同步计划（页面类型、水位线、本次待同步区间）
async function refreshSyncCard() {
  const res = await sendMessage("getSyncPlan", {}, { quiet: true });
  renderSyncCard(res && res.pageType ? res : null);
  renderRulesInfo(res && res.rules);
}

// 在 MTT / 极速 / 德扑 / PLO 之间切换时，卡片要跟着显示当前分类的同步状态。
// PokerCraft 是单页应用，切 tab 只是 pushState，不会重新加载页面，
// 所以既听标签页事件，也每 2 秒比对一次地址兜底（只查地址，地址变了才去问页面）。
let lastTabUrl = null;
let cardRefreshTimer = null;

function scheduleCardRefresh() {
  clearTimeout(cardRefreshTimer);
  cardRefreshTimer = setTimeout(() => {
    if (mainPanel.style.display === "flex") refreshSyncCard();
  }, 300);
}

function watchTabUrl() {
  queryTargetTab().then((tab) => {
    const url = tab ? tab.url || "" : "";
    if (url !== lastTabUrl) {
      lastTabUrl = url;
      scheduleCardRefresh();
    }
  });
}

chrome.tabs.onUpdated &&
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.url && tab && tab.active) watchTabUrl();
  });
chrome.tabs.onActivated && chrome.tabs.onActivated.addListener(() => watchTabUrl());
setInterval(() => {
  if (document.visibilityState === "visible") watchTabUrl();
}, 2000);

let lastRulesInfo = null; // 记下来，切语言时要重新渲染
function renderRulesInfo(rules) {
  if (!rulesInfoSpan) return;
  lastRulesInfo = rules || null;
  if (!rules) {
    rulesInfoSpan.textContent = "—";
    return;
  }
  rulesInfoSpan.textContent = t("rules_version", {
    version: rules.version,
    source: t("rules_source_" + rules.source),
  });
}

// 手动检查规则更新。平时不用点 —— 页面解析不了时插件会自己去拉。
updateRulesLink &&
  updateRulesLink.addEventListener("click", async function (e) {
    e.preventDefault();
    setStatus(t("rules_checking"));
    const res = await sendMessage("updateRules", { force: true });
    if (res && res.updated) {
      setStatus(t("rules_updated", { version: res.version }));
    } else {
      setStatus(t("rules_no_update") + (res && res.reason ? `（${res.reason}）` : ""));
    }
    await refreshSyncCard();
  });

// 按钮事件监听
startStopBtn.addEventListener("click", function () {
  if (!isRunning) {
    statusDiv.style.color = "";
    announceRtgto();
    // 先确认 content script 真的收下了，再把按钮切成"停止"。
    // 原来是无条件先切 UI，消息没送到时界面显示"运行中"但其实什么都没发生。
    sendMessage("start").then((res) => {
      if (!res || !res.accepted) return; // 失败原因已由 sendMessage 写进状态栏
      isRunning = true;
      isPaused = false;
      updateUI({ isRunning: true, isPaused: false });
    });
  } else {
    isRunning = false;
    isPaused = false;
    updateUI({ isRunning: false, isPaused: false });
    sendMessage("stop");
  }
});

pauseResumeBtn.addEventListener("click", function () {
  if (isPaused) {
    isPaused = false;
    updateUI({ isRunning: true, isPaused: false });
    sendMessage("resume");
  } else {
    isPaused = true;
    updateUI({ isRunning: true, isPaused: true });
    sendMessage("pause");
  }
});

// 清除同步记录 —— 会导致下次从 12 个月前重新下一遍，所以要二次确认
clearSyncBtn &&
  clearSyncBtn.addEventListener("click", async function () {
    if (isRunning) {
      statusDiv.textContent = t("stop_before_clear");
      statusDiv.style.color = "#d35400";
      return;
    }
    // 只清当前分类：分类都没识别出来就不清，免得误伤
    if (!currentPlan || !currentPlan.pageType) {
      setStatus(t("clear_sync_no_page"), "#d35400");
      return;
    }
    const pageType = currentPlan.pageType;
    const label = t(PAGE_TYPE_KEY[pageType] || "badge_unknown");
    const since = L.fmt(L.earliestSyncDate(pageType));
    if (!window.confirm(t("confirm_clear_sync", { page: label, since }))) return;

    const res = await sendMessage("clearSync", { pageType });
    if (!res || !res.success) return; // 失败原因已由 sendMessage 写进状态栏
    await refreshSyncCard();
    statusDiv.textContent = t("sync_cleared", { page: label });
    statusDiv.style.color = "";
  });

// —— 下载记录 ——
//
// 扩展只看得到"用户点了下载"，文件到底下没下成功它不知道（网络一断就静默失败）。
// 这里按"页面类型 × 概要/手牌"列出处理过的日期段，并能导出给实时GTO分析模块核对。

const Ledger = window.GG_LEDGER;
const ledgerCount = document.getElementById("ledger-count");
const ledgerList = document.getElementById("ledger-list");
const ledgerExportJson = document.getElementById("ledger-export-json");
const ledgerExportCsv = document.getElementById("ledger-export-csv");
const ledgerClear = document.getElementById("ledger-clear");

let lastLedger = []; // 切语言时重画用（已对上浏览器下载）
let lastDownloads = []; // background.js 记的 GG 下载

// 中文用全角冒号，英文用半角
const colon = () => (currentLang === "zh" ? "：" : ": ");

function formatRanges(ranges, max = 3) {
  if (!ranges.length) return "—";
  const shown = ranges.slice(0, max).map((r) => (r.from === r.to ? r.from : `${r.from} ~ ${r.to}`));
  if (ranges.length > max) shown.push(t("ledger_more", { n: ranges.length - max }));
  return shown.join(currentLang === "zh" ? "，" : ", ");
}

function renderLedger(list) {
  if (!ledgerList) return;
  lastLedger = Ledger.attachDownloads(list || [], lastDownloads);
  const has = lastLedger.length > 0;
  ledgerExportJson.disabled = !has;
  ledgerExportCsv.disabled = !has;
  ledgerClear.disabled = !has;
  if (ledgerCount) ledgerCount.textContent = has ? t("ledger_entries", { n: lastLedger.length }) : "";
  renderRtgto();

  if (!has) {
    ledgerList.innerHTML = `<div class="ledger-empty">${escapeHtml(t("ledger_empty"))}</div>`;
    if (typeof renderRepair === "function") renderRepair();
    return;
  }

  ledgerList.innerHTML = Ledger.summarize(lastLedger)
    .map((c) => {
      const cat = `${t(PAGE_TYPE_KEY[c.pageType] || "badge_unknown")} · ${t("ledger_kind_" + c.kind)}`;
      const pending = c.pending.length
        ? `<div class="pending">● ${escapeHtml(t("ledger_pending"))}${colon()}${escapeHtml(formatRanges(c.pending))}</div>`
        : "";
      // 下载 / 核对情况：浏览器报的中断扩展自己就知道，下没下全要等实时GTO核对
      const vf = [];
      if (c.verifiedOk) vf.push(`<span class="ok">${escapeHtml(t("ledger_verified_ok", { n: c.verifiedOk }))}</span>`);
      if (c.verifyBad) vf.push(`<span class="bad">${escapeHtml(t("ledger_verified_bad", { n: c.verifyBad }))}</span>`);
      if (c.interrupted)
        vf.push(`<span class="bad">${escapeHtml(t("ledger_interrupted", { n: c.interrupted }))}</span>`);
      if (c.unverified && c.downloadClicks) vf.push(escapeHtml(t("ledger_unverified", { n: c.unverified })));
      const vfLine = vf.length ? `<div class="vf">${vf.join(" · ")}</div>` : "";
      return (
        `<div class="ledger-row">` +
        `<div class="cat"><span>${escapeHtml(cat)}</span>` +
        `<span class="n">${escapeHtml(t("ledger_clicks", { n: c.downloadClicks }))}</span></div>` +
        `<div class="rng">${escapeHtml(t("ledger_covered"))}${colon()}${escapeHtml(formatRanges(c.covered))}</div>` +
        vfLine +
        pending +
        `</div>`
      );
    })
    .join("");
  if (typeof renderRepair === "function") renderRepair();
}

function refreshLedger() {
  if (!Ledger) return;
  chrome.storage.local.get(["ggDownloads"], (r) => {
    lastDownloads = Array.isArray(r && r.ggDownloads) ? r.ggDownloads : [];
    Ledger.getAll().then(renderLedger);
  });
}

// content script 每写一条记录，这里就跟着刷新，不用轮询
chrome.storage.onChanged &&
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && Ledger && changes[Ledger.STORAGE_KEY]) {
      renderLedger(changes[Ledger.STORAGE_KEY].newValue || []);
    }
  });

function saveTextFile(text, filename, mime) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

function exportStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

ledgerExportJson &&
  ledgerExportJson.addEventListener("click", async function () {
    const list = await Ledger.getAll();
    if (!list.length) return;
    const data = Ledger.buildExport(list, {
      extensionVersion: chrome.runtime.getManifest ? chrome.runtime.getManifest().version : null,
      rtgtoUser: (window.userInfoForI18n && window.userInfoForI18n.userName) || null,
    });
    saveTextFile(JSON.stringify(data, null, 2), `gg-download-ledger-${exportStamp()}.json`, "application/json");
    setStatusHint(t("ledger_exported", { n: list.length }));
  });

ledgerExportCsv &&
  ledgerExportCsv.addEventListener("click", async function () {
    const list = await Ledger.getAll();
    if (!list.length) return;
    saveTextFile(Ledger.toCSV(list), `gg-download-ledger-${exportStamp()}.csv`, "text/csv;charset=utf-8");
    setStatusHint(t("ledger_exported", { n: list.length }));
  });

// 清空只影响记录本身，不影响同步进度（水位线）
ledgerClear &&
  ledgerClear.addEventListener("click", async function () {
    if (isRunning) {
      setStatus(t("stop_before_clear"), "#d35400");
      return;
    }
    if (!window.confirm(t("confirm_clear_ledger"))) return;
    await Ledger.clear();
    renderLedger([]);
  });

// —— 补下载 ——
//
// 实时GTO分析模块核对出漏下的区间后，把它的结果（gg-missing-ranges JSON）导入这里，
// 扩展只补下漏掉的日期和类别，不改同步进度。
// "还剩哪些没补"不单独存状态，而是拿下载记录现算：导入之后点过下载或确认没数据的日期就算补上了。

const REPAIR_KEY = "ggRepairImport";
const repairImportBtn = document.getElementById("repair-import");
const repairFile = document.getElementById("repair-file");
const repairInfo = document.getElementById("repair-info");
const repairActions = document.getElementById("repair-actions");
const repairClearBtn = document.getElementById("repair-clear");

let repairImport = null; // { importedAt, source, items }
let repairSegments = []; // 当前分类可以直接跑的段

function loadRepair() {
  chrome.storage.local.get([REPAIR_KEY], (r) => {
    repairImport = (r && r[REPAIR_KEY]) || null;
    renderRepair();
  });
}

// 每类数据能补的日期范围：早于 GG 保留期的补不了；晚于同步进度的交给正常同步
function repairClamp(kind) {
  const today = L.today();
  const min = L.fmt(kind === "summary" ? L.earliestSummaryDate(today) : L.earliestHistoryDate(today));
  const watermark = currentPlan && currentPlan.saved && currentPlan.saved.lastSyncedDate;
  return { min, max: watermark || "0000-00-00" };
}

function catLabel(pageType, kind) {
  return `${t(PAGE_TYPE_KEY[pageType] || "badge_unknown")} · ${t("ledger_kind_" + kind)}`;
}

function renderRepair() {
  if (!repairInfo || !Ledger) return;
  repairSegments = [];
  if (!repairImport || !repairImport.items || !repairImport.items.length) {
    repairInfo.innerHTML = "";
    repairActions.style.display = "none";
    syncStartWithRepair();
    return;
  }

  const lines = [];
  const left = Ledger.outstanding(repairImport.items, lastLedger, repairImport.importedAt);
  repairActions.style.display = "";

  if (!left.length) {
    repairInfo.innerHTML = "";
    syncStartWithRepair();
    return;
  }

  const curType = currentPlan && currentPlan.pageType;
  // 当前分类放最前面
  left.sort((a, b) => (b.pageType === curType) - (a.pageType === curType));
  for (const c of left) {
    const cls = c.pageType === curType ? "cur" : "muted";
    lines.push(
      `<span class="${cls}">● ${escapeHtml(catLabel(c.pageType, c.kind))}${colon()}${escapeHtml(formatRanges(c.ranges, 4))}</span>`,
    );
  }

  if (curType) {
    const plan = Ledger.planRepair(left, curType, repairClamp);
    repairSegments = plan.segments;
    for (const g of plan.expired) {
      lines.push(
        `<span class="bad">${escapeHtml(t("repair_expired", { cat: t("ledger_kind_" + g.kind) }))}${colon()}${escapeHtml(formatRanges(g.ranges))}</span>`,
      );
    }
    for (const g of plan.notSynced) {
      lines.push(
        `<span class="muted">${escapeHtml(t("repair_not_synced", { cat: t("ledger_kind_" + g.kind) }))}${colon()}${escapeHtml(formatRanges(g.ranges))}</span>`,
      );
    }
  }
  if (!repairSegments.length) {
    const others = [...new Set(left.filter((c) => c.pageType !== curType).map((c) => t(PAGE_TYPE_KEY[c.pageType])))];
    if (others.length)
      lines.push(escapeHtml(t("repair_switch_page", { pages: others.join(currentLang === "zh" ? "、" : ", ") })));
  }

  if (repairSegments.length) {
    const days = repairSegments.reduce((n, s) => n + s.days, 0);
    lines.push(`<span class="cur">${escapeHtml(t("repair_auto_next", { n: repairSegments.length, days }))}</span>`);
  }
  repairInfo.innerHTML = lines.join("<br>");
  syncStartWithRepair();
}

// 补下载不再单独点：它是每次同步的收尾。所以已是最新、但还有要补的日期时，
// 「开始同步」照样能点，点了就只做核对 + 补下载。
function syncStartWithRepair() {
  const plan = currentPlan && currentPlan.plan;
  if (!plan || isRunning) return;
  if (plan.nothingToDo) {
    startStopBtn.disabled = !repairSegments.length;
    syncPendingSpan.textContent = repairSegments.length
      ? t("up_to_date_with_repair", { n: repairSegments.length })
      : t("up_to_date");
    syncPendingSpan.style.color = repairSegments.length ? "#fbbf24" : "#64748b";
  }
}

repairImportBtn && repairImportBtn.addEventListener("click", () => repairFile.click());

repairFile &&
  repairFile.addEventListener("change", function () {
    const file = repairFile.files && repairFile.files[0];
    repairFile.value = ""; // 同一个文件改完再导一次也能触发 change
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let data;
      try {
        data = JSON.parse(String(reader.result).replace(/^﻿/, ""));
      } catch (e) {
        setStatus(t("repair_import_failed", { reason: e.message }), "#d35400");
        return;
      }
      const { items, errors } = Ledger.parseMissing(data);
      if (!items.length) {
        setStatus(t("repair_import_failed", { reason: errors[0] || t("repair_empty") }), "#d35400");
        return;
      }
      repairImport = { importedAt: Ledger.localIso(Date.now()), source: file.name, items };
      chrome.storage.local.set({ [REPAIR_KEY]: repairImport });
      renderRepair();
      setStatusHint(
        t("repair_imported", { n: items.length }) +
          (errors.length ? " " + t("repair_import_warn", { n: errors.length }) : ""),
      );
      if (errors.length) console.warn("[侧边栏] 核对结果里有格式不对的条目：", errors);
    };
    reader.readAsText(file);
  });

repairClearBtn &&
  repairClearBtn.addEventListener("click", function () {
    if (isRunning) {
      setStatus(t("stop_before_clear"), "#d35400");
      return;
    }
    if (!window.confirm(t("confirm_clear_repair"))) return;
    repairImport = null;
    chrome.storage.local.remove(REPAIR_KEY);
    renderRepair();
  });

// —— 实时GTO 核对 ——
//
// 实时GTO 打开「GG数据导入」页后在本机监听。每轮同步 / 补下载结束，
// 把这轮"点了下载"的记录连同对应的浏览器下载文件交给它：它逐个打开文件核对、
// 导入并备份，返回每条的结果。没下到的日期段直接变成下面的补下载清单。

const Bridge = window.GG_RTGTO;
const DOWNLOADS_KEY = "ggDownloads";
const rtgtoStatus = document.getElementById("rtgto-status");
const rtgtoVerifyBtn = document.getElementById("rtgto-verify");
const rtgtoResult = document.getElementById("rtgto-result");

let rtgto = { ok: false }; // 最近一次探测结果
let rtgtoVerifying = false;
let rtgtoLastResult = null; // { ok, bad, downloading, error }
let rtgtoRetryTimer = null;

// 同步开始时才显示：实时GTO 开着就告诉用户去「GG数据导入」看核对状态，
// 没开就提醒现在打开，否则这轮下载没人核对
const rtgtoSyncHint = document.getElementById("rtgto-sync-hint");
let syncHintShown = false;

function renderSyncHint() {
  if (!rtgtoSyncHint) return;
  if (!syncHintShown) {
    rtgtoSyncHint.className = "";
    rtgtoSyncHint.textContent = "";
    return;
  }
  rtgtoSyncHint.className = rtgto.ok ? "on" : "off";
  rtgtoSyncHint.textContent = rtgto.ok ? t("rtgto_sync_hint_on") : t("rtgto_sync_hint_off");
}

async function announceRtgto() {
  syncHintShown = true;
  if (Bridge) rtgto = await Bridge.hello();
  renderRtgto();
}

function renderRtgto() {
  renderSyncHint();
  if (!rtgtoStatus) return;
  rtgtoStatus.className = "rtgto-status " + (rtgtoVerifying ? "busy" : rtgto.ok ? "on" : "off");
  rtgtoStatus.textContent = rtgtoVerifying
    ? t("rtgto_verifying")
    : rtgto.ok
      ? t("rtgto_connected", { v: (rtgto.info && rtgto.info.appVersion) || "" })
      : t("rtgto_not_connected");
  if (rtgtoVerifyBtn) rtgtoVerifyBtn.disabled = !rtgto.ok || rtgtoVerifying || isRunning;

  const r = rtgtoLastResult;
  if (r && r.error) {
    rtgtoResult.innerHTML = `<span class="bad">${escapeHtml(t("rtgto_verify_failed", { reason: r.error }))}</span>`;
    return;
  }
  // 显示当前分类的整体情况（按下载记录算），而不是最近一次核对那几个 ——
  // 最近一次可能只核了 2 个，"核对通过 2 个"看着像只下到 2 个
  const type = currentPlan && currentPlan.pageType;
  const cats =
    type && Array.isArray(lastLedger) && lastLedger.length && Ledger
      ? Ledger.summarize(lastLedger).filter((c) => c.pageType === type)
      : [];
  const sum = (k) => cats.reduce((n, c) => n + (Array.isArray(c[k]) ? c[k].length : c[k] || 0), 0);
  const clicks = sum("downloadClicks");
  if (!clicks) {
    rtgtoResult.innerHTML = rtgto.ok ? "" : `<span class="muted">${escapeHtml(t("rtgto_how_to_connect_short"))}</span>`;
    return;
  }
  const pending = sum("pending");
  const waiting = sum("unverified");
  const parts = [escapeHtml(t("rtgto_cat_clicks", { n: clicks }))];
  if (pending) parts.push(`<span class="bad">${escapeHtml(t("rtgto_cat_pending", { n: pending }))}</span>`);
  if (waiting) parts.push(escapeHtml(t("rtgto_cat_waiting", { n: waiting })));
  if (!pending && !waiting) parts.push(`<span class="ok">${escapeHtml(t("rtgto_cat_all_ok"))}</span>`);
  let html = parts.join(" · ");
  if (r && r.imported && (r.imported.newHands || r.imported.mttSessions)) {
    html += `<div class="muted" style="font-size:11px;margin-top:2px">${escapeHtml(t("rtgto_result_imported", { hands: r.imported.newHands || 0, mtt: r.imported.mttSessions || 0 }))}</div>`;
  }
  rtgtoResult.innerHTML = html;
}

// 构建编号是打包时间 202609241630，显示成 2026-09-24 16:30
function fmtBuild(build) {
  const s = String(build || "");
  if (s.length !== 12) return t("ext_build_unknown");
  return `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)} ${s.slice(8, 10)}:${s.slice(10, 12)}`;
}

// 实时GTO 里内置的扩展比现在装的新，就提示更新
const extUpdateBanner = document.getElementById("ext-update-banner");
async function renderUpdateBanner() {
  if (!extUpdateBanner || !Bridge) return;
  const old = rtgto.ok ? await Bridge.outdated(rtgto.info) : null;
  if (!old) {
    extUpdateBanner.className = "";
    extUpdateBanner.innerHTML = "";
    return;
  }
  extUpdateBanner.className = "show";
  extUpdateBanner.innerHTML =
    `<b>${escapeHtml(t("ext_update_title"))}</b>` +
    escapeHtml(
      t("ext_update_desc", {
        mine: fmtBuild(old.mine),
        latest: fmtBuild(old.latest),
        mineVersion: old.mineVersion || "-",
        latestVersion: old.latestVersion || "-",
      }),
    );
}

async function pingRtgto() {
  if (!Bridge) return;
  const r = await Bridge.hello();
  const changed = r.ok !== rtgto.ok;
  rtgto = r;
  renderRtgto();
  renderUpdateBanner();
  // 刚连上时把之前没核对的补核一次（比如同步时实时GTO还没打开）
  if (changed && r.ok && !isRunning) verifyWithRtgto(true, "connected");
}

// 核对本身在 rtgto-bridge.js（Bridge.verifyPending），后台"下载一完成就自动解析"也用它。
// 这里只负责触发和显示；结果（无论谁触发的）都从 storage 里的 ggRtgtoLastVerify 读。
function applyLastVerify(v) {
  if (!v) return;
  rtgtoLastResult = v.error
    ? { error: v.error }
    : Object.assign({ imported: v.imported || null }, v.counts || { ok: 0, bad: 0, downloading: 0 });
  renderRtgto();
}

chrome.storage.local.get([Bridge ? Bridge.LAST_VERIFY_KEY : "ggRtgtoLastVerify"], (r) => {
  const v = r && r[Bridge ? Bridge.LAST_VERIFY_KEY : "ggRtgtoLastVerify"];
  if (v) applyLastVerify(v);
});

async function verifyWithRtgto(auto, trigger) {
  if (!Bridge || !Ledger || rtgtoVerifying || isRunning) return;
  clearTimeout(rtgtoRetryTimer);
  rtgtoVerifying = true;
  renderRtgto();
  let out;
  try {
    out = await Bridge.verifyPending({ trigger: trigger || (auto ? "run_end" : "manual") });
  } finally {
    rtgtoVerifying = false;
  }
  if (out.status === "nothing" && !auto) setStatusHint(t("rtgto_nothing_to_verify"));
  if (out.status === "not_connected") rtgto = { ok: false };
  if (out.status === "error") {
    rtgtoLastResult = { error: out.error === "not_connected" ? t("rtgto_not_connected") : out.error };
    rtgto = { ok: false };
  }
  // 不只靠 storage.onChanged：自己核对完就直接把结果和补下载清单读回来显示
  if (out.status === "done" || out.status === "error") {
    chrome.storage.local.get([Bridge.LAST_VERIFY_KEY], (r) => applyLastVerify(r && r[Bridge.LAST_VERIFY_KEY]));
    loadRepair();
  }
  // 还在下载的过半分钟再核一次
  if (out.status === "done" && out.counts && out.counts.downloading) {
    rtgtoRetryTimer = setTimeout(() => verifyWithRtgto(true, "retry"), 30000);
  }
  renderRtgto();
}

rtgtoVerifyBtn && rtgtoVerifyBtn.addEventListener("click", () => verifyWithRtgto(false));

// 后台自动核对时侧边栏不在场：结果、"正在核对"、补下载清单都从 storage 变化里拿
chrome.storage.onChanged &&
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (Bridge && changes[Bridge.LAST_VERIFY_KEY]) applyLastVerify(changes[Bridge.LAST_VERIFY_KEY].newValue);
    if (Bridge && changes[Bridge.LOCK_KEY]) {
      rtgtoVerifying = !!changes[Bridge.LOCK_KEY].newValue;
      renderRtgto();
    }
    if (changes[REPAIR_KEY]) {
      repairImport = changes[REPAIR_KEY].newValue || null;
      renderRepair();
    }
  });

// 下载状态变了（完成 / 中断），记录卡片跟着更新
chrome.storage.onChanged &&
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[DOWNLOADS_KEY]) {
      lastDownloads = changes[DOWNLOADS_KEY].newValue || [];
      if (Ledger) Ledger.getAll().then(renderLedger);
    }
  });

setInterval(() => {
  if (document.visibilityState === "visible" && mainPanel.style.display === "flex") pingRtgto();
}, 10000);

// 监听 side panel 的显示/隐藏
document.addEventListener("visibilitychange", function () {
  if (document.visibilityState === "visible") {
    // 当 side panel 变为可见时,立即更新状态
    updateStatus();
    // 如果正在运行,则开始定时更新
    if (isRunning) {
      startStatusUpdate();
    }
  } else {
    // 当 side panel 隐藏时,停止定时更新以节省资源
    stopStatusUpdate();
  }
});

// 页面卸载时清理资源
window.addEventListener("unload", function () {
  stopStatusUpdate();
});

// —— 三种视图：校验中 / 登录表单 / 主界面 ——
//
// 注意：显示时必须写明 display 值（block/flex）。样式表里这几块默认是 none，
// 写 style.display = '' 只会退回样式表的 none，界面会一片空白。
const authLoading = document.getElementById("auth-loading");
const authLoadingText = document.getElementById("auth-loading-text");

function showAuthLoading(text) {
  authLoading.style.display = "block";
  authLoadingText.textContent = text || t("auth_checking");
  loginForm.style.display = "none";
  mainPanel.style.display = "none";
  logoutBtn.style.display = "none";
}

function showLoginForm(errorMsg) {
  authLoading.style.display = "none";
  loginForm.style.display = "block";
  mainPanel.style.display = "none";
  logoutBtn.style.display = "none";
  loginError.textContent = errorMsg || "";
  loginUser.value = "";
  loginPwd.value = "";
  // 预填上次的用户名/密码；复选框没存过偏好时默认勾上（多数人都想自动登录）
  chrome.storage.local.get(["lastUserName", "lastPassword", "rememberPwd"], (result) => {
    if (result.lastUserName) loginUser.value = result.lastUserName;
    const remember = result.rememberPwd === undefined ? true : !!result.rememberPwd;
    rememberPwd.checked = remember;
    if (remember && result.lastPassword) loginPwd.value = result.lastPassword;
    (loginUser.value ? loginPwd : loginUser).focus();
  });
}

function showMainPanel(userInfo) {
  authLoading.style.display = "none";
  loginForm.style.display = "none";
  mainPanel.style.display = "flex";
  logoutBtn.style.display = "inline-block";
  // 记录到全局，便于切换语言时刷新
  window.userInfoForI18n = userInfo;
  const errDiv = document.getElementById("logout-error");
  if (errDiv) errDiv.style.display = "none";
}

function enterMainPanel(userInfo) {
  showMainPanel(userInfo);
  refreshSyncCard();
  refreshLedger();
  loadRepair();
  renderRtgto();
  pingRtgto();
  if (document.visibilityState === "visible") startStatusUpdate();
}

// 打开侧边栏时：校验 token；失效且勾了自动登录，后台会用保存的账号密码静默重登
function checkAuthOnLoad() {
  showAuthLoading(t("auth_checking"));
  chrome.storage.local.get(["autoLogin", "lastUserName"], (st) => {
    if (st.autoLogin && st.lastUserName) {
      showAuthLoading(t("auto_logging_in", { userName: st.lastUserName }));
    }
    chrome.runtime.sendMessage({ action: "checkAuth" }, (res) => {
      if (chrome.runtime.lastError) {
        showLoginForm(t("network_error_or_service_exception"));
        return;
      }
      if (res && res.authenticated && res.userInfo) {
        enterMainPanel(res.userInfo);
        return;
      }
      if (res && res.autoLoginFailed) {
        // 密码改了/账号被锁：后台已关闭自动登录，这里说清楚原因
        showLoginForm(t("auto_login_failed", { reason: res.error || "" }));
        return;
      }
      showLoginForm(res && res.error ? res.error : "");
    });
  });
}

// 登录事件
loginBtn &&
  loginBtn.addEventListener("click", function () {
    const user = loginUser.value.trim();
    const pwd = loginPwd.value;
    if (!user || !pwd) {
      loginError.textContent = t("error_input_username_password");
      return;
    }
    loginBtn.disabled = true;
    loginError.textContent = t("login_in_progress");
    chrome.runtime.sendMessage({ action: "login", userName: user, password: pwd }, (res) => {
      loginBtn.disabled = false;
      if (res && res.success && res.userInfo) {
        // 登录成功后根据复选框缓存用户名和密码
        // 勾了就保存账号密码并开启自动登录；没勾就只记用户名
        if (rememberPwd.checked) {
          chrome.storage.local.set({ lastUserName: user, lastPassword: pwd, rememberPwd: true, autoLogin: true });
        } else {
          chrome.storage.local.set({ lastUserName: user, lastPassword: "", rememberPwd: false, autoLogin: false });
        }
        enterMainPanel(res.userInfo);
      } else {
        loginError.textContent = res && res.error ? res.error : t("login_failed_retry");
        console.warn("登录失败", res);
      }
    });
  });

// 注册按钮事件
registerBtn &&
  registerBtn.addEventListener("click", function () {
    window.open("https://www.rtgto.net/#/", "_blank");
  });

// 清空按钮
clearBtn &&
  clearBtn.addEventListener("click", function () {
    loginUser.value = "";
    loginPwd.value = "";
    loginError.textContent = "";
    loginUser.focus();
    // 清除本地缓存的用户名和密码，同时关掉自动登录
    chrome.storage.local.set({ lastUserName: "", lastPassword: "", rememberPwd: false, autoLogin: false });
  });

// 支持回车提交
loginPwd &&
  loginPwd.addEventListener("keydown", function (e) {
    if (e.key === "Enter") loginBtn.click();
  });

loginUser &&
  loginUser.addEventListener("keydown", function (e) {
    if (e.key === "Enter") loginBtn.click();
  });

// 退出按钮事件
logoutBtn &&
  logoutBtn.addEventListener("click", function () {
    logoutBtn.disabled = true;
    logoutBtn.textContent = t("logout_in_progress");
    chrome.runtime.sendMessage({ action: "logout" }, (res) => {
      logoutBtn.disabled = false;
      logoutBtn.textContent = t("logout");
      if (res && res.success) {
        stopStatusUpdate();
        showLoginForm();
      } else {
        showLogoutError(res && res.error ? res.error : t("logout_failed"));
      }
    });
  });

function showLogoutError(msg) {
  logoutBtn.disabled = false;
  logoutBtn.textContent = t("logout");
  let errDiv = document.getElementById("logout-error");
  if (!errDiv) {
    errDiv = document.createElement("div");
    errDiv.id = "logout-error";
    errDiv.style.color = "#ef4444";
    errDiv.style.fontSize = "14px";
    errDiv.style.marginTop = "6px";
    document.querySelector(".topbar").after(errDiv);
  }
  errDiv.textContent = msg;
  errDiv.style.display = "";
}

// 语言切换逻辑
function updateI18nText() {
  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const key = el.getAttribute("data-i18n");
    el.textContent = t(key);
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const key = el.getAttribute("data-i18n-placeholder");
    el.setAttribute("placeholder", t(key));
  });
  // 按钮高亮
  if (currentLang === "zh") {
    langZh.style.color = "#38bdf8";
    langZh.style.fontWeight = "bold";
    langEn.style.color = "#bfc9d9";
    langEn.style.fontWeight = "normal";
  } else {
    langZh.style.color = "#bfc9d9";
    langZh.style.fontWeight = "normal";
    langEn.style.color = "#38bdf8";
    langEn.style.fontWeight = "bold";
  }
  // 同步卡片、规则版本是 JS 动态渲染的，data-i18n 管不到，切语言时要重画一遍
  if (typeof renderSyncCard === "function" && currentPlan) renderSyncCard(currentPlan);
  if (typeof renderRulesInfo === "function" && lastRulesInfo) renderRulesInfo(lastRulesInfo);
  if (typeof renderLedger === "function" && mainPanel.style.display === "flex") renderLedger(lastLedger);
  if (typeof renderRtgto === "function") renderRtgto();
  if (typeof renderUpdateBanner === "function") renderUpdateBanner(); // 顺带重画补下载
  // 按钮文字跟运行状态走：data-i18n 只写了静态文案，运行中切语言会被覆盖成"开始同步"
  startStopBtn.textContent = isRunning ? t("stop") : t("sync_now");
  pauseResumeBtn.textContent = isPaused ? t("resume") : t("pause");
}

// 语言选择要记住：否则每次打开侧边栏都会按浏览器语言重置，用户得反复切换
const LANG_KEY = "uiLang";

function setLang(lang) {
  if (lang !== "zh" && lang !== "en") return;
  if (currentLang !== lang) {
    currentLang = lang;
    updateI18nText();
  }
  chrome.storage.local.set({ [LANG_KEY]: lang });
}

langZh &&
  langZh.addEventListener("click", function () {
    setLang("zh");
  });
langEn &&
  langEn.addEventListener("click", function () {
    setLang("en");
  });

document.addEventListener("DOMContentLoaded", function () {
  // 先恢复上次选的语言，再渲染 —— 否则会先闪一下浏览器默认语言
  chrome.storage.local.get([LANG_KEY], (r) => {
    const saved = r && r[LANG_KEY];
    if (saved === "zh" || saved === "en") currentLang = saved;
    updateI18nText();
    checkAuthOnLoad();
  });
});
