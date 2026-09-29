// content-script.js
// 注入GGPoker页面，采集和下载游戏概要与手牌记录的脚本

// 侧边栏在发消息失败时会用 chrome.scripting 现场补注入一次。
// 万一补注入时脚本其实已经在了，整份文件会被再执行一遍，
// 顶层的 const D / const L 就会抛 "Identifier has already been declared"，
// 反而把原本好好的 content script 弄坏。这里加个幂等守卫。
if (window.__GG_DOWNLOADER_LOADED__) {
  console.warn("[GGPoker助手] content script 已存在，跳过重复注入");
} else {
  window.__GG_DOWNLOADER_LOADED__ = true;

  let stopFlag = false;
  let pauseFlag = false;
  // 等用户点下载按钮时，每隔多久刷新一次提示（只是提醒，不会超时放弃）。
  // 有数据就必须等到用户点，不能自动跳过 —— 跳过等于这几天永远没下载，
  // 而用户还以为同步过了。想中断请点"停止"。
  const DOWNLOAD_PROMPT_REFRESH_MS = 5000;
  // 判定"这段日期没有对局"之前额外等待数据出现的上限。
  // 这是唯一不下载也推进水位线的路径，误判等于永久漏数据，所以宁可多等几秒。
  const EMPTY_CONFIRM_MS = 8000;
  let currentStatus = {
    isRunning: false,
    currentRound: 0,
    totalRounds: 0,
    startDate: "",
    endDate: "",
    doneDays: 0,
    totalDays: 0,
    currentSpan: 0,
    syncFrom: "",
    syncTo: "",
    lastSyncedDate: null,
    lastMessage: "",
    importantLog: [], // 状态栏滚动显示的重要日志
  };

  // 国际化字典和翻译函数
  const I18N = {
    zh: {
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
      // ... 可继续补充
    },
    en: {
      // 英文翻译，后续补充
    },
  };
  let currentLang = "zh";
  function t(key, params = {}) {
    return I18N[currentLang][key] || key;
  }

  // DOM 适配层（pokercraft-dom.js，manifest 里排在本文件之前注入）。
  // PokerCraft 已升级到 Angular Material MDC，旧的类名/写死的 #mat-option-5 全部失效，
  // 所有查找元素的逻辑都收到 GGDom 里按文案+新旧类名兜底地找。
  const D = window.GGDom;
  // GG 官方下载限制（gg-limits.js，manifest 里排在最前注入）
  const L = window.GG_LIMITS;
  // 同步水位线（sync-state.js）
  const GG_SYNC = window.GG_SYNC;
  // 下载记录（download-ledger.js）：每段日期的处理结果，导出给实时GTO分析模块核对完整性
  const GG_LEDGER = window.GG_LEDGER;
  if (!GG_LEDGER) {
    console.error("[GGPoker助手] download-ledger.js 未加载，请检查 manifest.json 的 content_scripts 顺序");
  }
  if (!GG_SYNC) {
    console.error("[GGPoker助手] sync-state.js 未加载，请检查 manifest.json 的 content_scripts 顺序");
  }
  if (!L) {
    console.error("[GGPoker助手] gg-limits.js 未加载，请检查 manifest.json 的 content_scripts 顺序");
  }
  if (!D) {
    // manifest 里 pokercraft-dom.js 必须排在 content-script.js 前面注入；
    // 万一漏了，这里给个明确的报错，而不是后面一路 undefined。
    console.error("[GGPoker助手] pokercraft-dom.js 未加载，请检查 manifest.json 的 content_scripts 顺序");
  }

  // 页面结构配置。选择器不再写死在这里，只保留“这个页面有没有概要下载”这类差异。
  const PAGE_CONFIGS = {
    tournament: { hasSummary: true },
    rushAndCash: { hasSummary: false },
    holdem: { hasSummary: false },
    plo: { hasSummary: false },
  };

  function getPageTypeStrict() {
    const url = window.location.href;
    //打印URL地址
    log(`当前访问Url为：${url}`);
    // 用正则匹配路径，避免 ?query / #hash / 结尾斜杠导致 startsWith 失配
    return D.detectPageType();
  }

  // PokerCraft 是单页应用，切换 tab 不会重新注入 content script，
  // 所以 pageType 必须每次用的时候现算，不能在加载时算一次就固定下来。
  function currentPageType() {
    return D.detectPageType();
  }

  function currentPageConfig() {
    const type = currentPageType();
    return (type && PAGE_CONFIGS[type]) || { hasSummary: true };
  }

  // 仅用于注入时打一条日志；真正判断页面类型一律走 currentPageType()
  const pageType = getPageTypeStrict();
  log(`识别到页面类型: ${pageType || "不支持"}`);

  // —— 解析规则 ——
  //
  // 选择器不再写死在代码里（见 pokercraft-rules.js）。启动时先把上次存下来的
  // 远端规则装上；一旦页面结构变了导致关键元素找不到，就去拉一份新规则再试。
  // 这样 GG 改版时用户不用等插件发新版。

  function sendToBackground(msg) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage(msg, (res) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, reason: chrome.runtime.lastError.message });
        } else {
          resolve(res || {});
        }
      });
    });
  }

  /** 启动时装载已保存的远端规则（版本比内置新才用）。 */
  async function loadStoredRules() {
    const res = await sendToBackground({ action: "getStoredRules" });
    const stored = res && res.stored;
    if (!stored || !stored.rules) return false;

    const builtinVersion = window.GG_RULES ? window.GG_RULES.DEFAULT_RULES.version : 0;
    if (stored.rules.version <= builtinVersion) {
      log(`已存规则 v${stored.rules.version} 不比内置 v${builtinVersion} 新，继续用内置`, "rules");
      return false;
    }
    // 远端规则可能只覆盖部分字段，其余沿用内置默认值
    const merged = window.GG_RULES.mergeRules(window.GG_RULES.DEFAULT_RULES, stored.rules);
    return D.setRules(merged, "stored");
  }

  /**
   * 页面解析不了时，去拉一份新规则试试。
   * 校验必须在这里做（需要 DOM 才能验证选择器语法是否合法），
   * 不通过就原样退回旧规则 —— 一份坏 JSON 不能把能用的插件搞瘫。
   */
  async function tryUpdateRules(force) {
    log("当前规则找不到关键元素，尝试拉取最新解析规则...", "rules");
    const res = await sendToBackground({ action: "fetchRules", force: !!force });

    if (!res || !res.ok) {
      logWarning(`获取解析规则失败：${(res && res.reason) || "未知原因"}`, "rules");
      return false;
    }

    const builtinVersion = window.GG_RULES.DEFAULT_RULES.version;
    const current = D.rulesInfo().version;
    if (res.rules.version <= current) {
      logWarning(`远端规则 v${res.rules.version} 不比当前 v${current} 新，没有可用更新`, "rules");
      return false;
    }

    const merged = window.GG_RULES.mergeRules(window.GG_RULES.DEFAULT_RULES, res.rules);
    const err = window.GG_RULES.validateRules(merged);
    if (err) {
      logWarning(`远端规则 v${res.rules.version} 校验不通过（${err}），继续用旧规则`, "rules");
      return false;
    }

    if (!D.setRules(merged, "remote")) return false;
    await sendToBackground({ action: "saveRules", rules: res.rules });
    logSuccess(`已更新到解析规则 v${res.rules.version}（内置 v${builtinVersion}）`, "rules");
    return true;
  }

  // 自检不能在注入时立刻做。
  // content script 在 document_idle 就跑了，那时 Angular 还没 bootstrap，
  // 页面上一个 mat-* 元素都没有，diagnose() 会全报 false、materialFlavor 报成
  // legacy —— 这是假阴性，会把人往错误方向带。所以等首屏真正渲染出来再打。
  async function selfCheckWhenReady() {
    await loadStoredRules();
    if (!pageType) return;

    const waitForFilter = () => D.waitFor(() => !D.rulesLookBroken(), 30000, 500);
    let ready = await waitForFilter();

    if (!ready) {
      // 等了 30 秒还找不到：可能是 GG 改版了，拉新规则再等一轮（这次短一些，
      // 因为页面此时肯定已经渲染完了，只是规则对不上）
      logWarning("等待 30 秒仍未找到筛选栏（日期下拉 / 显示按钮），可能是页面结构变了", "selfCheck");
      if (await tryUpdateRules()) {
        ready = await D.waitFor(() => !D.rulesLookBroken(), 10000, 500);
        if (ready) logSuccess("新规则生效，已能正常识别页面", "selfCheck");
      }
    }

    if (!ready) {
      logWarning(
        "新规则也没能识别页面。可能是还没加载完、未登录 PokerCraft，或页面结构变化超出规则覆盖范围。",
        "selfCheck",
      );
    }
    const report = D.diagnose();
    log(`页面自检完成（规则 v${report.rulesVersion} / ${report.rulesSource}）`, "selfCheck");
    console.table(report);
  }
  selfCheckWhenReady();

  // PokerCraft 是 SPA，路由切换不会重新注入脚本，这里记一笔方便对时间线
  let lastLoggedUrl = location.href;
  setInterval(() => {
    if (location.href !== lastLoggedUrl) {
      log(`页面路由变化: ${lastLoggedUrl} -> ${location.href}`, "route");
      lastLoggedUrl = location.href;
    }
  }, 1000);

  // 添加错误日志函数
  function logError(error, context = "") {
    const timestamp = new Date().toLocaleTimeString();
    const errorMessage = `[错误] ${timestamp} - ${context}: ${error.message || error}`;
    console.error(
      "%c" + errorMessage,
      "color: #FF0000; font-weight: bold; background-color: #FFE4E4; padding: 2px 5px; border-radius: 3px;",
    );
    if (error.stack) {
      console.error(
        "%c错误堆栈:",
        "color: #FF0000; background-color: #FFE4E4; padding: 2px 5px; border-radius: 3px;",
        error.stack,
      );
    }
    updateStatus("error", error.message || error, context);
  }

  // 添加警告日志函数
  function logWarning(message, context = "") {
    const timestamp = new Date().toLocaleTimeString();
    const warningMessage = `[警告] ${timestamp} - ${context}: ${message}`;
    console.warn(
      "%c" + warningMessage,
      "color: #FF8C00; font-weight: bold; background-color: #FFF8E1; padding: 2px 5px; border-radius: 3px;",
    );
    updateStatus("warning", message, context);
  }

  // 添加普通日志函数
  function log(message, context = "") {
    const timestamp = new Date().toLocaleTimeString();
    const logMessage = `[信息] ${timestamp} - ${context}: ${message}`;
    console.log("%c" + logMessage, "color: #000000; background-color: #F5F5F5; padding: 2px 5px; border-radius: 3px;");
    updateStatus("info", message, context);
  }

  // 添加成功日志函数
  function logSuccess(message, context = "") {
    const timestamp = new Date().toLocaleTimeString();
    const successMessage = `[成功] ${timestamp} - ${context}: ${message}`;
    console.log(
      "%c" + successMessage,
      "color: #008000; font-weight: bold; background-color: #E8F5E9; padding: 2px 5px; border-radius: 3px;",
    );
    updateStatus("success", message, context);
  }

  // 把元素描述成一行，方便在日志里确认到底选中了什么
  function describeEl(el) {
    if (!el) return "null";
    const tag = el.tagName.toLowerCase();
    const id = el.id ? `#${el.id}` : "";
    const cls = el.getAttribute("class");
    const clsStr = cls ? `.${cls.trim().split(/\s+/).slice(0, 3).join(".")}` : "";
    const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 24);
    return `<${tag}${id}${clsStr}>${text ? ` "${text}"` : ""}`;
  }

  // 某一步找不到元素时，把整页自检结果一并打出来，省得来回问
  function logStepFailure(step, extra) {
    logError(`步骤失败: ${step}`, "loopDownload");
    console.table(D.diagnose());
    if (extra) console.log("[GGPoker助手] 附加信息", extra);
  }

  // —— 重要日志 ——
  //
  // 状态栏原来只显示最后一条消息，一刷就没了；出问题时用户看不到过程，
  // 也没法复制给开发者。所以把"重要"的那些留在状态栏里滚动显示。
  //
  // 什么算重要：警告、错误、成功，以及批次结束这类里程碑。
  // 每一步的琐碎信息（点了哪个元素、等了多久）只进控制台，不占状态栏。
  // 保留整次同步的要紧日志（线上一次同步十几分钟，60 条只剩最后两分钟，看不出前面哪一批失败了）
  const IMPORTANT_LOG_MAX = 400;

  function isImportant(type, context) {
    if (type === "error" || type === "warning" || type === "success") return true;
    // 这几个上下文的 info 也值得留
    return ["batch", "limit", "chunk", "rules", "selfCheck", "settle", "clicks", "ledger", "repair", "dlwait"].includes(
      context,
    );
  }

  function pushImportant(type, message, context) {
    const d = new Date();
    const p = (n) => String(n).padStart(2, "0");
    currentStatus.importantLog.push({
      t: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`,
      type,
      ctx: context || "",
      msg: String(message),
    });
    if (currentStatus.importantLog.length > IMPORTANT_LOG_MAX) {
      currentStatus.importantLog = currentStatus.importantLog.slice(-IMPORTANT_LOG_MAX);
    }
  }

  // 更新状态并保存到storage
  function updateStatus(type, message, context) {
    currentStatus.lastMessage = message;
    if (isImportant(type, context)) pushImportant(type, message, context);
    chrome.storage.local.set({ ggpokerStatus: currentStatus }, function () {
      if (chrome.runtime.lastError) {
        console.error("保存状态失败:", chrome.runtime.lastError);
      }
    });
  }

  // 消息监听器始终注册
  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    // ping 用来让侧边栏判断 content script 有没有注入成功，
    // 必须排在页面类型判断之前，否则非目标页会答非所问
    if (message.action === "ping") {
      sendResponse &&
        sendResponse({
          pong: true,
          url: location.href,
          pageType: currentPageType(),
          version: chrome.runtime.getManifest().version,
        });
      return;
    }
    // 同步记录的查询/清除，不依赖页面渲染状态
    if (message.action === "getSyncPlan") {
      const type = currentPageType();
      if (!type) {
        sendResponse && sendResponse({ error: "当前页面不支持操作" });
        return;
      }
      GG_SYNC.get(type).then((saved) => {
        const plan = L.planSync(saved.lastSyncedDate, L.today(), type);
        sendResponse &&
          sendResponse({
            pageType: type,
            hasSummary: L.pageConfig(type).hasSummary,
            saved,
            plan,
            rules: D.rulesInfo(),
          });
      });
      return true; // 异步回复
    }
    if (message.action === "getJournal") {
      chrome.storage.local.get(["ggSyncJournal"], (r) => {
        sendResponse && sendResponse(r && r.ggSyncJournal ? r.ggSyncJournal : null);
      });
      return true;
    }
    if (message.action === "updateRules") {
      tryUpdateRules(message.force).then((updated) => {
        sendResponse &&
          sendResponse({
            updated,
            version: D.rulesInfo().version,
            source: D.rulesInfo().source,
          });
      });
      return true;
    }
    if (message.action === "clearSync") {
      // 只清当前分类：以侧边栏传来的为准，没传就用当前页面；都不明确就什么也不清
      const type = message.pageType || currentPageType();
      if (!type) {
        sendResponse && sendResponse({ error: "无法确定当前分类，没有清除任何同步记录" });
        return;
      }
      // 连同这个分类的补下载记录一起清：补下载清单是从下载记录（没下到的日期）和
      // 待补清单算出来的，只清同步进度的话，从头同步完还会去补那些旧日期
      Promise.all([
        GG_SYNC.clear(type),
        GG_LEDGER ? GG_LEDGER.update((list) => list.filter((e) => e.pageType !== type)) : null,
        new Promise((resolve) =>
          chrome.storage.local.get(["ggRepairImport"], (r) => {
            const imp = r && r.ggRepairImport;
            if (!imp || !Array.isArray(imp.items)) return resolve();
            const items = imp.items.filter((i) => i.pageType !== type);
            if (items.length) chrome.storage.local.set({ ggRepairImport: Object.assign({}, imp, { items }) }, resolve);
            else chrome.storage.local.remove(["ggRepairImport"], resolve);
          }),
        ),
      ]).then(() => {
        log(
          `已清除 ${type} 的同步记录和补下载记录（其他分类不受影响），下次将从 ${L.fmt(L.earliestSyncDate(type))} 重新开始`,
          "onMessage",
        );
        sendResponse && sendResponse({ success: true, pageType: type });
      });
      return true;
    }
    // 诊断命令不依赖页面类型，先处理
    if (message.action === "diagnose") {
      const report = D.diagnose();
      console.table(report);
      sendResponse && sendResponse(report);
      return;
    }
    // PokerCraft 是 SPA，注入时可能还在别的路由上，这里必须实时判断
    if (!currentPageType()) {
      sendResponse && sendResponse({ error: "当前页面不支持操作" });
      return;
    }
    if (message.action === "start") {
      stopFlag = false;
      pauseFlag = false;
      currentStatus.isRunning = true;
      log(`收到 start 指令（自动同步，区间与批次跨度都由插件决定）`, "onMessage");
      updateStatus("info", "开始自动同步");
      runAutomation();
      sendResponse && sendResponse({ accepted: true });
    } else if (message.action === "repair") {
      // 按实时GTO的核对结果补下载：只下漏掉的区间和类别，不改同步进度
      const segments = Array.isArray(message.segments) ? message.segments : [];
      if (!segments.length) {
        sendResponse && sendResponse({ error: "没有需要补下载的区间" });
        return;
      }
      if (currentStatus.isRunning) {
        sendResponse && sendResponse({ error: "正在同步中，请先停止" });
        return;
      }
      stopFlag = false;
      pauseFlag = false;
      currentStatus.isRunning = true;
      log(
        `收到 repair 指令：${segments.map((s) => `${s.from}~${s.to}[${s.kinds.join("+")}]`).join("，")}`,
        "onMessage",
      );
      updateStatus("info", "开始补下载");
      runRepair(segments);
      sendResponse && sendResponse({ accepted: true });
    } else if (message.action === "stop") {
      stopFlag = true;
      currentStatus.isRunning = false;
      currentStatus.currentRound = 0;
      currentStatus.startDate = "";
      currentStatus.endDate = "";
      currentStatus.doneDays = 0;
      updateStatus("warning", "已停止");
    } else if (message.action === "pause") {
      pauseFlag = true;
      updateStatus("warning", "已暂停");
    } else if (message.action === "resume") {
      pauseFlag = false;
      updateStatus("info", "恢复中...");
    } else if (message.action === "getStatus") {
      sendResponse(currentStatus);
    }
  });

  function randomBetween(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }

  async function simulateHumanClick(element) {
    if (!element) {
      logError("尝试点击的元素不存在", "simulateHumanClick");
      return;
    }

    try {
      // 用 getBoundingClientRect 判断可见性。
      // 不能用 offsetParent —— cdk-overlay（下拉面板、日历）是 position:fixed，
      // 里面的元素 offsetParent 恒为 null，旧代码在这里会直接判定“元素不可见”返回，
      // 这也是选项/日历点不动的原因之一。
      if (!D.isVisible(element)) {
        logError("元素不可见", "simulateHumanClick");
        return;
      }

      // 滚动到元素位置
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      await wait(randomBetween(500, 1000));

      // 模拟鼠标事件
      element.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      await wait(randomBetween(100, 400));
      element.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      await wait(randomBetween(100, 300));
      element.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
      await wait(randomBetween(50, 200));
      element.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));

      // 只触发一次 click。
      //
      // 原来是 element.click() 之后，对 BUTTON 再 dispatchEvent(new MouseEvent("click"))，
      // 于是每个按钮都被点了两次：
      //   · "显示"点两次 = 两次搜索背靠背，表格连续清空重填，
      //     既制造瞬时空表（会被误判成"没有数据"），又让之前抓到的
      //     复选框/按钮引用变成游离节点；
      //   · 复选框被点两次 = 勾上又取消，条数归 0。
      // 这正是"没点下载就自动推进时间线"的诱因之一。
      element.click();

      log(`成功点击元素`, "simulateHumanClick");
      console.info(
        `成功点击元素: ${element.tagName}${element.id ? "#" + element.id : ""}${
          element.className ? "." + element.className : ""
        }`,
        "simulateHumanClick",
      );
    } catch (e) {
      logError(e, "simulateHumanClick");
    }
  }

  async function simulateHumanScroll() {
    const maxScroll = document.body.scrollHeight - window.innerHeight;
    if (maxScroll > 0) {
      const target = randomBetween(0, maxScroll);
      window.scrollTo({ top: target, behavior: "smooth" });
      await wait(randomBetween(500, 1200));
    }
  }

  async function waitIfPaused() {
    while (pauseFlag && !stopFlag) {
      await wait(500);
    }
  }

  // —— 点击统计：每轮记下点了几次下载、每次选了多少条、上限用了多少，用来分析怎么少点 ——

  const CLICK_STATS_KEY = "ggClickStats";
  const CLICK_STATS_KEEP = 30;
  let runStats = null;

  function newRunStats(pageType) {
    return {
      pageType,
      startedAt: Date.now(),
      clicks: { summary: [], history: [] }, // 每次点击：{ count, cap, inHistory, mode }
      batches: 0,
      emptyBatches: 0,
      days: 0,
      redos: {}, // 重做原因 -> 次数
      capModel: null, // 手牌窗口的上限从哪来
      currentCap: 0,
      currentInHistory: false,
      currentMode: "sync",
    };
  }

  function statClick(kind, count) {
    if (!runStats || !runStats.clicks[kind]) return;
    runStats.clicks[kind].push({
      count: count || 0,
      cap: runStats.currentCap,
      inHistory: runStats.currentInHistory,
      mode: runStats.currentMode,
    });
  }

  function statBatch(status, note, days) {
    if (!runStats) return;
    if (status === "重做") {
      // 原因里带着具体数字，只取前面的描述归类
      const reason = String(note || "其他")
        .replace(/[\d.,]+/g, "N")
        .slice(0, 18);
      runStats.redos[reason] = (runStats.redos[reason] || 0) + 1;
      return;
    }
    runStats.batches++;
    runStats.days += days || 0;
    if (status === "无数据") runStats.emptyBatches++;
  }

  /** 一轮结束：算出点击效率写进日志，并存下来（最近 30 轮）供分析。 */
  async function finishRunStats() {
    const s = runStats;
    runStats = null;
    if (!s) return null;
    const sum = (xs) => xs.reduce((a, b) => a + b, 0);
    const describe = (list) => {
      if (!list.length) return null;
      const items = sum(list.map((c) => c.count));
      const withCap = list.filter((c) => c.cap > 0);
      return {
        clicks: list.length,
        items,
        avgPerClick: Math.round(items / list.length),
        // 每次选中条数 / 当时的上限：越接近 100% 点得越省
        capUse: withCap.length ? Math.round((100 * sum(withCap.map((c) => c.count / c.cap))) / withCap.length) : null,
        repairClicks: list.filter((c) => c.mode === "repair").length,
      };
    };
    const summary = describe(s.clicks.summary);
    const history = describe(s.clicks.history);
    // 理论最少：概要一次最多 500 条；手牌一次最多 2 万手（按学到的每行手数折算）
    const minSummary = summary ? Math.ceil(summary.items / L.SUMMARY_MAX_PER_DOWNLOAD) : 0;
    const handsPerRow = s.capModel && s.capModel.handsPerRow;
    // 手牌按钮上的数现在读得出手数（"8,411"）：平均一次上百就当手数，直接按 2 万手算；
    // 否则还是行数，按每行手数折算
    const minHistory = !history
      ? 0
      : history.avgPerClick > 500
        ? Math.ceil(history.items / L.HISTORY_MAX_HANDS_PER_DOWNLOAD)
        : Math.ceil(
            (history.items * (handsPerRow || L.AUTO.HANDS_PER_SESSION_ESTIMATE)) / L.HISTORY_MAX_HANDS_PER_DOWNLOAD,
          );
    const redoTotal = sum(Object.values(s.redos));
    const stat = {
      at: GG_LEDGER ? GG_LEDGER.localIso(s.startedAt) : new Date(s.startedAt).toISOString(),
      pageType: s.pageType,
      minutes: Math.round((Date.now() - s.startedAt) / 60000),
      clicks: (summary ? summary.clicks : 0) + (history ? history.clicks : 0),
      summary,
      history,
      minClicks: minSummary + minHistory,
      batches: s.batches,
      emptyBatches: s.emptyBatches,
      days: s.days,
      redos: s.redos,
      redoTotal,
      capModel: s.capModel,
    };
    const part = (name, d) =>
      d
        ? `${name} ${d.clicks} 次（平均 ${d.avgPerClick} 条/次${d.capUse == null ? "" : `，上限用了 ${d.capUse}%`}` +
          `${d.repairClicks ? `，其中补下载 ${d.repairClicks} 次` : ""}）`
        : null;
    const parts = [part("概要", summary), part("手牌", history)].filter(Boolean);
    if (stat.clicks) {
      // 详细统计进控制台和 ggClickStats（复制日志会带上），界面上只留一句
      console.info(
        `[GG助手] 点击统计：共点下载 ${stat.clicks} 次 = ${parts.join("，")}；理论最少约 ${stat.minClicks} 次。` +
          `批次 ${s.batches}（空 ${s.emptyBatches}），重做 ${redoTotal} 次` +
          (redoTotal
            ? `（${Object.entries(s.redos)
                .map(([k, v]) => `${k}×${v}`)
                .join("，")}）`
            : "") +
          `，用时 ${stat.minutes} 分钟`,
      );
      log(
        `本次共点下载 ${stat.clicks} 次（概要 ${summary ? summary.clicks : 0}，手牌 ${history ? history.clicks : 0}），用时 ${stat.minutes} 分钟`,
        "clicks",
      );
    }
    try {
      const r = await new Promise((res) => chrome.storage.local.get([CLICK_STATS_KEY], res));
      const list = Array.isArray(r && r[CLICK_STATS_KEY]) ? r[CLICK_STATS_KEY] : [];
      list.push(stat);
      if (list.length > CLICK_STATS_KEEP) list.splice(0, list.length - CLICK_STATS_KEEP);
      await new Promise((res) => chrome.storage.local.set({ [CLICK_STATS_KEY]: list }, res));
    } catch (e) {
      console.warn("[GGPoker助手] 保存点击统计失败", e);
    }
    return stat;
  }

  /**
   * 手牌窗口每批能选多少行。GG 限的是一次 2 万手，页面上看不到手数，原来只能按
   * 每行 200 手保守估算（= 100 行），手牌窗口里的批次因此比外面多好几倍，点击也多好几倍。
   * 实时GTO 每次核对都会报回下载里真实的手数：用它算"每行多少手"，取偏高的 90 分位
   * 再留 10% 余量来定上限。样本不够时仍用老估算。
   */
  // 每个分类上次同步量出来的密度（行/天）。下次同步第一批就按它定跨度，
  // 不然每次都从 3 天、14 天这种保守起步，小范围的增量同步也要拆成好几批、多点好几次。
  const DENSITY_KEY = "ggDensity";
  const DENSITY_MAX_AGE_DAYS = 60;

  // 每个分类实测的 GG 列表加载速度（毫秒/行），下次同步第一批就能用；GG 快慢会变，只信 7 天内的
  const LOAD_SPEED_KEY = "ggLoadSpeed";
  function loadLoadSpeed(pageType) {
    return new Promise((resolve) =>
      chrome.storage.local.get([LOAD_SPEED_KEY], (r) => {
        const d = r && r[LOAD_SPEED_KEY] && r[LOAD_SPEED_KEY][pageType];
        resolve(d && d.msPerRow > 0 && Date.now() - d.at < 7 * 86400e3 ? d.msPerRow : null);
      }),
    );
  }
  function saveLoadSpeed(pageType, msPerRow) {
    return new Promise((resolve) =>
      chrome.storage.local.get([LOAD_SPEED_KEY], (r) => {
        const all = (r && r[LOAD_SPEED_KEY]) || {};
        all[pageType] = { msPerRow: Math.round(msPerRow * 10) / 10, at: Date.now() };
        chrome.storage.local.set({ [LOAD_SPEED_KEY]: all }, resolve);
      }),
    );
  }

  function loadDensity(pageType) {
    return new Promise((resolve) =>
      chrome.storage.local.get([DENSITY_KEY], (r) => {
        const d = r && r[DENSITY_KEY] && r[DENSITY_KEY][pageType];
        if (!d || !(d.rate > 0) || Date.now() - d.at > DENSITY_MAX_AGE_DAYS * 86400e3) return resolve(null);
        resolve(d);
      }),
    );
  }

  function saveDensity(pageType, rate) {
    if (!(rate > 0)) return Promise.resolve();
    return new Promise((resolve) =>
      chrome.storage.local.get([DENSITY_KEY], (r) => {
        const all = (r && r[DENSITY_KEY]) || {};
        all[pageType] = { rate: Math.round(rate * 100) / 100, at: Date.now() };
        chrome.storage.local.set({ [DENSITY_KEY]: all }, resolve);
      }),
    );
  }

  const HANDS_MODEL_MIN_SAMPLES = 3;
  const HANDS_SAFETY = 0.9;

  async function learnHandsPerRow(pageType) {
    if (!GG_LEDGER) return null;
    const list = await GG_LEDGER.getAll();
    const ratios = list
      .filter(
        (e) =>
          e.pageType === pageType &&
          e.kind === "history" &&
          (!e.chunk || e.rowsExact) &&
          e.rows > 0 &&
          e.verify &&
          (e.verify.status === "ok" || e.verify.status === "count_diff") &&
          e.verify.metrics &&
          e.verify.metrics.hands > 0,
      )
      .map((e) => e.verify.metrics.hands / e.rows)
      .sort((a, b) => a - b);
    if (ratios.length < HANDS_MODEL_MIN_SAMPLES) return { samples: ratios.length, handsPerRow: null, cap: null };
    const p90 = ratios[Math.min(ratios.length - 1, Math.ceil(ratios.length * 0.9) - 1)];
    const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
    const cap = Math.max(
      20,
      Math.min(L.SUMMARY_MAX_PER_DOWNLOAD, Math.floor((L.HISTORY_MAX_HANDS_PER_DOWNLOAD * HANDS_SAFETY) / p90)),
    );
    return { samples: ratios.length, handsPerRow: Math.round(p90 * 10) / 10, mean: Math.round(mean * 10) / 10, cap };
  }

  // 同步中途因页面异常中止时的原因：有它就不进核对阶段，状态停在这条提示上
  let loopAbortMessage = null;

  /**
   * 按下载记录把同步记录推进到连续覆盖到的最后一天（不超过 syncTo）。
   *
   * 同步中途有一批失败时，之后下成功的批次也不推进同步记录（免得跳过失败的那段）；
   * 失败的那段后来被补下载补齐、核对也通过了，同步记录却一直停在失败点之前（线上停在 06-28，
   * 下次同步要把早已下过的 93 天全部重下）。这里逐天看：同步记录之后的每一天都下过了
   * （或确认那天没打牌）才往前推，手牌只看 GG 保留的 3 个月内；遇到没覆盖的那天就停在它前一天。
   * 标着"没下到"的趟不会因此被跳过：它们还在下载记录里，同步结束的核对会补下（补到这次同步的终点为止）。
   * 同步开始前和实时GTO 确认完整后各调一次。
   */
  async function advanceWatermarkByLedger(pageType, syncTo, why) {
    if (!pageType || !syncTo || !GG_LEDGER) return;
    const saved = await GG_SYNC.get(pageType);
    const from = saved.lastSyncedDate;
    if (!from || from >= syncTo) return;
    const list = await GG_LEDGER.getAll();
    const cats = GG_LEDGER.summarize(list).filter((c) => c.pageType === pageType);
    const covered = (kind) => {
      const c = cats.find((x) => x.kind === kind);
      const days = (ranges, fn) => {
        for (const r of ranges || []) {
          for (let t = L.parse(r.from).getTime(); t <= L.parse(r.to).getTime(); t += L.MS_PER_DAY)
            fn(L.fmt(new Date(t)));
        }
      };
      const set = new Set();
      days(c && c.covered, (d) => set.add(d));
      // 还缺着的（没下到、没补上）不算下过：同步记录停在它前面，补齐核对通过后再推
      days(c && c.pending, (d) => set.delete(d));
      return set;
    };
    const cfg = currentPageConfig();
    const summaryDays = cfg.hasSummary ? covered("summary") : null;
    const historyDays = covered("history");
    const earliestHistory = L.earliestHistoryDate(L.today()).getTime();
    let last = from;
    for (let t = L.parse(from).getTime() + L.MS_PER_DAY; t <= L.parse(syncTo).getTime(); t += L.MS_PER_DAY) {
      const d = L.fmt(new Date(t));
      const okSummary = !summaryDays || summaryDays.has(d);
      const okHistory = t < earliestHistory || historyDays.has(d);
      if (!okSummary || !okHistory) break;
      last = d;
    }
    if (last > from) {
      await GG_SYNC.advance(pageType, last, {});
      currentStatus.lastSyncedDate = last;
      log(
        `${why}，同步记录从 ${from} 推进到 ${last}` +
          (last < syncTo
            ? `（${L.fmt(new Date(L.parse(last).getTime() + L.MS_PER_DAY))} 起还没有下载记录，下次从那里继续）`
            : ""),
        "ledger",
      );
    }
  }

  async function runAutomation() {
    runStats = newRunStats(currentPageType());
    loopAbortMessage = null;
    pendingStarts.length = 0; // 上一次同步遗留的等待记录不算
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
    try {
      logSuccess("开始自动化流程", "runAutomation");
      await loopDownload();
      if (stopFlag) {
        logWarning("自动化流程被手动停止", "runAutomation");
        return;
      }
      if (loopAbortMessage) {
        updateStatus("error", loopAbortMessage);
        return;
      }
      // 同步只保证"点了下载"。下没下到要等实时GTO 核对，缺的自动补，确认齐了才算完成。
      currentStatus.isRunning = true;
      // 补下载会把 currentStatus.syncTo 改成补的那一段，这次同步的终点先记下
      const syncTo = currentStatus.syncTo,
        syncFrom = currentStatus.syncFrom;
      const done = await completenessPhase(currentPageType(), syncTo);
      currentStatus.syncTo = syncTo;
      currentStatus.syncFrom = syncFrom;
      if (stopFlag) {
        logWarning("自动化流程被手动停止", "runAutomation");
        return;
      }
      if (done.confirmed) {
        const pageType = currentPageType();
        await advanceWatermarkByLedger(pageType, syncTo, "实时GTO 已确认完整");
        // 下过的都齐了，但同步记录没到终点：说明中间有日期根本没下（不是没下到），不能说全部完成
        const reached = (await GG_SYNC.get(pageType)).lastSyncedDate;
        if (syncTo && reached && reached < syncTo) {
          const next = L.fmt(new Date(L.parse(reached).getTime() + L.MS_PER_DAY));
          const message = `已下载的都核对完整，但 ${next} 起还没有下载，同步记录停在 ${reached}，再点一次开始同步会从那里继续`;
          logWarning(message, "runAutomation");
          updateStatus("warning", message);
          return;
        }
        logSuccess("全部完成：实时GTO 已确认下载完整", "runAutomation");
        updateStatus("success", "全部完成：实时GTO 已确认下载完整");
      } else {
        updateStatus("warning", done.message);
      }
    } catch (e) {
      logError(e, "runAutomation");
    } finally {
      await finishRunStats();
      // 中止了：点击统计那行别盖住中止原因
      if (loopAbortMessage) currentStatus.lastMessage = loopAbortMessage;
      // 要写回存储：侧边栏看存储里的状态，只改内存的话按钮会一直停在"停止 / 暂停"
      currentStatus.isRunning = false;
      currentStatus.isPaused = false;
      currentStatus.verifyWait = null;
      currentStatus.activity = null;
      chrome.storage.local.set({ ggpokerStatus: currentStatus });
    }
  }

  // 最多自动补几轮：某段日期一直补不上（GG 那边就是下不下来）时不能无限循环
  const MAX_REPAIR_ROUNDS = 3;

  /** 让后台把能核对的下载交给实时GTO 核一遍；返回里带着还在等的下载数和已收字节。 */
  function verifyWithRtgto() {
    return sendToBackground({ action: "rtgtoVerifyAll", trigger: "run_end" });
  }

  // 下载要时间：GG 先在服务器上打包，浏览器再下载，大文件还要下一阵。
  // 每次点击各自计时：点击后 6 分钟（GG_RTGTO.START_GRACE_MS）还没开始下载就算没下到，
  // 核对时判为缺失、自动补下载（用户要求）。已经开始下载的照常等它下完、核对完，不设总时长（用户要求）；
  // 只有连续 NO_PROGRESS_MS 毫无进展（没有新下载、字节不涨、实时GTO 也没在处理）才停，
  // 停下时没核对完的也当成没下到去补。
  const VERIFY_POLL_MS = 5000;
  const NO_PROGRESS_MS = (typeof window !== "undefined" && window.__ggTestNoProgressMs) || 150 * 1000; // 2.5 分钟（用户要求）

  /**
   * 等核对超时后，把这个分类里还没核对完的点击（没开始下载 / 还在下载 / 没核对）记成"没下到"，
   * 交给补下载。记成没下到而不是一直算"等待中"：补下载下到之后这些日期就算补齐了，
   * 下一轮不会再重复补；原来的下载要是之后才下完，多出来的一份实时GTO 导入时会去重。
   */
  async function markUnverifiedAsMissing(pageType) {
    let n = 0;
    const at = GG_LEDGER.localIso(Date.now());
    await GG_LEDGER.update((all) =>
      all.map((e) => {
        if (e.pageType !== pageType || e.status !== "clicked" || !e.clickedAtMs) return e;
        if (e.verify && e.verify.status !== "downloading") return e;
        n++;
        return Object.assign({}, e, {
          verify: {
            status: "not_detected",
            detail: "等核对时长时间毫无进展，当作没下到",
            items: null,
            matchedBy: null,
            metrics: null,
            at,
            checks: ((e.verify && e.verify.checks) || 0) + 1,
          },
        });
      }),
    );
    return n;
  }

  // —— 等实时GTO 核对时的模态进度框 ——
  // 实时GTO 导入上万手要几分钟，这段时间页面上什么都不动，用户以为卡死了。
  // 盖一层模态框显示进度（解析到第几个文件 / 还在等几个下载），期间页面和扩展都不能操作。
  const VERIFY_MODAL_ID = "gg-verify-modal";
  const RTGTO_PROGRESS_POLL_MS = 1500;

  function blockKeys(ev) {
    if (document.getElementById(VERIFY_MODAL_ID)) {
      ev.stopPropagation();
      ev.preventDefault();
    }
  }

  function showVerifyModal() {
    let el = document.getElementById(VERIFY_MODAL_ID);
    if (el) return el;
    el = document.createElement("div");
    el.id = VERIFY_MODAL_ID;
    el.setAttribute("role", "dialog");
    el.setAttribute("aria-modal", "true");
    el.style.cssText =
      "position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.55);" +
      "display:flex;align-items:center;justify-content:center;" +
      'font-family:system-ui,-apple-system,"Microsoft YaHei",sans-serif;';
    el.innerHTML =
      "<style>@keyframes gg-indet{0%{margin-left:-30%}100%{margin-left:100%}}</style>" +
      '<div style="background:#fff;color:#222;border-radius:12px;padding:22px 26px;width:min(440px,calc(100vw - 32px));box-shadow:0 10px 40px rgba(0,0,0,.35)">' +
      '<div style="font-size:16px;font-weight:600;margin-bottom:4px">正在等待实时GTO 核对下载</div>' +
      '<div data-r="sub" style="font-size:12px;color:#666;margin-bottom:14px">请不要关闭页面，核对完成后自动继续</div>' +
      '<div style="height:8px;background:#e8e8e8;border-radius:4px;overflow:hidden">' +
      '<div data-r="bar" style="height:100%;width:30%;background:#2e7d32;border-radius:4px"></div></div>' +
      '<div data-r="text" style="font-size:13px;margin-top:10px;min-height:18px">正在连接实时GTO…</div>' +
      '<div data-r="file" style="font-size:12px;color:#888;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></div>' +
      "</div>";
    for (const type of ["click", "dblclick", "mousedown", "mouseup", "pointerdown", "contextmenu"]) {
      el.addEventListener(
        type,
        (ev) => {
          ev.stopPropagation();
          ev.preventDefault();
        },
        true,
      );
    }
    document.addEventListener("keydown", blockKeys, true);
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  // fraction 为 null 时进度条来回滚动（不知道总量）
  function updateVerifyModal({ text, file, fraction, sub }) {
    const el = document.getElementById(VERIFY_MODAL_ID);
    if (el) {
      const q = (r) => el.querySelector(`[data-r="${r}"]`);
      q("text").textContent = text || "";
      q("file").textContent = file || "";
      if (sub) q("sub").textContent = sub;
      const bar = q("bar");
      if (fraction == null) {
        bar.style.width = "30%";
        bar.style.animation = "gg-indet 1.4s linear infinite";
      } else {
        bar.style.animation = "none";
        bar.style.marginLeft = "0";
        bar.style.width = `${Math.max(2, Math.min(100, Math.round(fraction * 100)))}%`;
      }
    }
    // 侧边栏据此锁住按钮并显示同样的进度
    currentStatus.verifyWait = {
      text: text || "",
      file: file || "",
      fraction: fraction == null ? null : fraction,
      at: Date.now(),
    };
    updateStatus("info", text || "等待实时GTO 核对…");
  }

  function hideVerifyModal() {
    const el = document.getElementById(VERIFY_MODAL_ID);
    if (el) el.remove();
    document.removeEventListener("keydown", blockKeys, true);
    currentStatus.verifyWait = null;
    chrome.storage.local.set({ ggpokerStatus: currentStatus });
  }

  function describeVerifyWait(rt, v, secs) {
    const base = (s) =>
      String(s || "")
        .split(/[\\/]/)
        .pop();
    const waiting = v ? (v.notStarted || 0) + (v.downloading || 0) : 0;
    const queued = rt && rt.queued ? `，还有 ${rt.queued} 批排队` : "";
    if (rt && rt.importing && rt.total > 0) {
      return {
        text: `实时GTO 正在解析导入：第 ${Math.min(rt.processed + 1, rt.total)} / ${rt.total} 个文件${queued}（已等 ${secs} 秒）`,
        file: base(rt.currentFile),
        fraction: rt.processed / rt.total,
      };
    }
    if (rt && rt.verifying) {
      return { text: `实时GTO 正在核对${queued}（已等 ${secs} 秒）`, file: "", fraction: null };
    }
    if (waiting) {
      const mb = ((v.bytes || 0) / 1048576).toFixed(1);
      return {
        text: `等待 ${waiting} 个文件下载完成（GG 准备中 ${v.notStarted || 0}，下载中 ${v.downloading || 0}，已收 ${mb} MB；已等 ${secs} 秒）`,
        file: "",
        fraction: null,
      };
    }
    return { text: `正在核对（已等 ${secs} 秒）`, file: "", fraction: null };
  }

  async function waitForVerification() {
    const started = Date.now();
    let lastChange = Date.now();
    let lastSig = "";
    let lastV = null;
    let rt = null;
    const secs = () => Math.round((Date.now() - started) / 1000);
    showVerifyModal();
    const render = () => updateVerifyModal(describeVerifyWait(rt, lastV, secs()));
    render();
    // 核对请求本身可能一等几分钟（实时GTO 在导入），进度单独轮询
    const poll = setInterval(async () => {
      const p = await sendToBackground({ action: "rtgtoProgress" });
      if (p && p.connected) rt = p;
      render();
    }, RTGTO_PROGRESS_POLL_MS);
    // 一时连不上但之前连着：多半是实时GTO 正忙着导入、顾不上回应，继续等；连续这么久都连不上才放弃
    const DISCONNECT_TOLERANCE_MS = 150 * 1000; // 2.5 分钟（用户要求）
    let everConnected = false;
    let disconnectedSince = 0;
    try {
      for (;;) {
        const v = await verifyWithRtgto();
        lastV = v;
        const lost = !v || v.ok === false || v.connected === false || v.status === "error";
        if (lost) {
          if (!everConnected) return v;
          const first = !disconnectedSince;
          if (first) disconnectedSince = Date.now();
          const gone = Date.now() - disconnectedSince;
          if (gone > DISCONNECT_TOLERANCE_MS) return v;
          updateVerifyModal({
            text: `实时GTO 暂时没有回应（可能正忙着导入），已等 ${Math.round(gone / 1000)} 秒，继续等…`,
            file: "",
            fraction: null,
          });
          if (first || secs() % 30 < VERIFY_POLL_MS / 1000)
            log(`实时GTO 暂时没有回应（${Math.round(gone / 1000)} 秒），多半在忙着导入，继续等`, "ledger");
          await wait(VERIFY_POLL_MS);
          if (stopFlag) return v;
          continue;
        }
        everConnected = true;
        disconnectedSince = 0;
        if (v.progress) rt = Object.assign({ connected: true }, v.progress);
        const waiting = (v.notStarted || 0) + (v.downloading || 0);
        if (v.status !== "busy" && !waiting) return v;
        // 实时GTO 正在解析导入也算有进展（导入上万手要几分钟，之前会被当成没动静而放弃）
        const rtBusy = rt && (rt.verifying || rt.importing || rt.queued);
        const sig = `${v.status}|${v.notStarted}|${v.downloading}|${v.bytes}|${rt ? rt.processed : ""}`;
        if (sig !== lastSig || rtBusy) {
          lastSig = sig;
          lastChange = Date.now();
        }
        if (Date.now() - lastChange > NO_PROGRESS_MS) {
          logWarning(
            `等了 ${secs()} 秒仍有 ${waiting} 个没核对完（连续 ${Math.round(NO_PROGRESS_MS / 1000)} 秒毫无进展），先停止等待`,
            "ledger",
          );
          return Object.assign({}, v, { timedOut: true });
        }
        render();
        const s = secs();
        if (s === 0 || s % 30 < VERIFY_POLL_MS / 1000) {
          log(
            `等待核对：还没开始 ${v.notStarted || 0}，下载中 ${v.downloading || 0}（${Math.round((v.bytes || 0) / 1024)} KB）` +
              `${rtBusy ? `，实时GTO 正在处理${rt.total ? `（${rt.processed}/${rt.total} 个文件）` : ""}` : ""}`,
            "ledger",
          );
        }
        await wait(VERIFY_POLL_MS);
        if (stopFlag) return v;
      }
    } finally {
      clearInterval(poll);
      hideVerifyModal();
    }
  }

  function storageGet(keys) {
    return new Promise((resolve) => chrome.storage.local.get(keys, (r) => resolve(r || {})));
  }

  /**
   * 当前分类还要补下载的日期段（按实时GTO 的核对结果和下载记录现算）。
   * 超出 GG 保留期的补不了；晚于同步进度的交给下次同步。
   * maxDate：同步结束后的核对传这次同步的终点 —— 这次同步里没下到的趟当场补，
   * 哪怕它在同步记录之后（中间有一批失败时同步记录会停在失败点之前，线上因此只提示"下次继续"而没补）。
   */
  async function planRepairFor(pageType, maxDate) {
    const [list, st, saved] = await Promise.all([
      GG_LEDGER.getAll(),
      storageGet(["ggDownloads", "ggRepairImport"]),
      GG_SYNC.get(pageType),
    ]);
    const attached = GG_LEDGER.attachDownloads(list, st.ggDownloads || []);
    const pending = GG_LEDGER.summarize(attached)
      .filter((c) => c.pageType === pageType && c.pending.length)
      .map((c) => ({ pageType, kind: c.kind, ranges: c.pending }));
    const imp = st.ggRepairImport;
    const imported =
      imp && Array.isArray(imp.items)
        ? GG_LEDGER.outstanding(imp.items, attached, imp.importedAt).filter((c) => c.pageType === pageType)
        : [];
    const today = L.today();
    const clamp = (kind) => ({
      min: L.fmt(kind === "summary" ? L.earliestSummaryDate(today) : L.earliestHistoryDate(today)),
      max: [saved.lastSyncedDate || "0000-00-00", maxDate || ""].sort().pop(),
    });
    const plan = GG_LEDGER.planRepair(pending.concat(imported), pageType, clamp);
    // 还没核完的（下载中 / 从没核对过）：这些没结果前不能说"齐了"
    plan.unverified = attached.filter(
      (x) =>
        x.pageType === pageType &&
        x.status === "clicked" &&
        x.clickedAtMs &&
        (!x.verify || x.verify.status === "downloading"),
    ).length;
    return plan;
  }

  /**
   * 同步之后的收尾：核对 -> 缺的自动补下载 -> 再核对，直到实时GTO 确认没有缺的。
   * 返回 { confirmed, message }。
   */
  async function completenessPhase(pageType, syncTo) {
    const rangeText = (g) => g.ranges.map((r) => (r.from === r.to ? r.from : `${r.from}~${r.to}`)).join("，");
    let repairedOffline = false;
    for (let round = 0; ; round++) {
      if (stopFlag) return { confirmed: false, message: "已停止" };
      updateStatus(
        "info",
        round === 0 ? "同步完成，等待实时GTO 核对下载…" : `第 ${round} 轮补下载完成，等待实时GTO 核对…`,
      );
      log(`等待实时GTO 核对（第 ${round + 1} 次）`, "ledger");
      const v = await waitForVerification();
      if (!v || v.ok === false || v.connected === false) {
        // 连不上实时GTO 也先把已经核对出来缺的日期段补下（不能因为确认不了就连补都不补）
        const known = await planRepairFor(pageType, syncTo);
        if (known.segments.length && !repairedOffline && round < MAX_REPAIR_ROUNDS) {
          repairedOffline = true;
          logWarning(
            `实时GTO 暂时连不上，先把之前核对出来缺的 ${known.segments.length} 段补下：` +
              known.segments.map((s) => `${s.from}~${s.to}[${s.kinds.join("+")}]`).join("，"),
            "repair",
          );
          const r = await repairSegments(known.segments);
          if (r.aborted) {
            return {
              confirmed: false,
              message: stopFlag ? "已停止" : "补下载中断（页面操作失败），请刷新页面后再点开始同步",
            };
          }
          continue; // 补完再试一次核对（可能已经连上了）
        }
        const message =
          "没有连上实时GTO，无法确认下载是否完整" +
          (repairedOffline ? "（已先补下之前核对出来缺的日期段）" : "") +
          "。请打开实时GTO「GG数据导入」后再点一次开始同步。";
        logWarning(message, "ledger");
        return { confirmed: false, message };
      }
      if (v.status === "error") {
        const message = `实时GTO 核对出错：${v.error || "-"}`;
        logWarning(message, "ledger");
        return { confirmed: false, message };
      }
      if (v.timedOut) {
        const n = await markUnverifiedAsMissing(pageType);
        if (n) logWarning(`还有 ${n} 个下载没核对完，当作没下到，直接重新下载这几段`, "ledger");
      }

      const plan = await planRepairFor(pageType, syncTo);
      for (const g of plan.expired) {
        logWarning(
          `${g.kind === "summary" ? "游戏概览" : "历史手牌"} ${rangeText(g)} 已超出 GG 保留期，没法再补`,
          "ledger",
        );
      }
      if (!plan.segments.length) {
        if (plan.unverified) {
          const message = `还有 ${plan.unverified} 个下载实时GTO 没核对完（可能还在下载），稍后再点一次开始同步确认。`;
          logWarning(message, "ledger");
          return { confirmed: false, message };
        }
        if (plan.notSynced.length) {
          const message = `有日期同步失败（${plan.notSynced.map(rangeText).join("；")}），下次同步会从那里继续。`;
          logWarning(message, "ledger");
          return { confirmed: false, message };
        }
        logSuccess(
          round === 0 ? "实时GTO 已确认：这一分类的下载全部完整" : `实时GTO 已确认：补下载 ${round} 轮后全部完整`,
          "ledger",
        );
        return { confirmed: true, message: "" };
      }
      if (round >= MAX_REPAIR_ROUNDS) {
        const message =
          `自动补下载 ${round} 轮后仍有 ${plan.segments.length} 段没下到：` +
          plan.segments.map((s) => `${s.from}~${s.to}`).join("，");
        logWarning(message, "ledger");
        return { confirmed: false, message };
      }
      logWarning(
        `实时GTO 核对发现 ${plan.segments.length} 段没下到，自动补下载（第 ${round + 1} 轮）：` +
          plan.segments.map((s) => `${s.from}~${s.to}[${s.kinds.join("+")}]`).join("，"),
        "repair",
      );
      const r = await repairSegments(plan.segments);
      if (r.aborted) {
        return {
          confirmed: false,
          message: stopFlag ? "已停止" : "补下载中断（页面操作失败），请刷新页面后再点开始同步",
        };
      }
    }
  }

  // 把 Date 写进 Material 的日期范围输入框。
  //
  // 旧实现有两个致命问题：
  //   1. `target.value = new Date(value).getTime()` —— 往文本框里写了个 13 位时间戳，
  //      Material 的 DateAdapter 根本解析不出来；
  //   2. 只 dispatch 了自造的 CustomEvent，没走原生 value setter，
  //      Angular 的 ControlValueAccessor 收不到变更。
  // 现在改成：按输入框自己的格式提示逐个试，写完校验 ng-invalid，全部失败再退回点日历。
  async function setDateRange(startStr, endStr) {
    try {
      log(`尝试设置日期范围: ${startStr} ~ ${endStr}`, "setDateRange");

      const inputs = await D.waitFor(() => D.findDateRangeInputs(), 8000);
      if (!inputs) {
        logError("未找到日期范围输入框（mat-date-range-input）", "setDateRange");
        return false;
      }
      const { start: startInput, end: endInput } = inputs;
      log(`找到日期输入框: ${startInput.id || "?"} / ${endInput.id || "?"}`, "setDateRange");

      const startDate = parseYmd(startStr);
      const endDate = parseYmd(endStr);
      if (!startDate || !endDate) {
        logError(`日期参数无法解析: ${startStr} / ${endStr}`, "setDateRange");
        return false;
      }

      // 逐个候选格式试，写进去后看 Angular 有没有打 ng-invalid
      const startCandidates = D.dateFormatCandidates(startDate, startInput);
      const endCandidates = D.dateFormatCandidates(endDate, endInput);

      let ok = false;
      for (let i = 0; i < startCandidates.length; i++) {
        D.typeIntoInput(startInput, startCandidates[i]);
        await wait(randomBetween(200, 400));
        D.typeIntoInput(endInput, endCandidates[i]);
        await wait(randomBetween(400, 800));

        if (D.inputAccepted(startInput) && D.inputAccepted(endInput)) {
          log(`日期已按格式 "${startCandidates[i]}" 写入成功`, "setDateRange");
          ok = true;
          break;
        }
        logWarning(`格式 "${startCandidates[i]}" 未被接受，尝试下一种`, "setDateRange");
      }

      if (!ok) {
        logWarning("直接输入日期均失败，改用日历点选", "setDateRange");
        ok = await pickDatesFromCalendar(startInput, startDate, endDate);
      }

      if (!ok) {
        logError("设置日期范围失败", "setDateRange");
        return false;
      }

      // 关掉可能弹出的日历，否则遮罩会挡住后面的“显示”按钮
      const how = D.closeOverlay();
      log(`关闭日期弹层(${how})`, "setDateRange");
      await wait(randomBetween(400, 900));
      return true;
    } catch (e) {
      logError(e, "setDateRange");
      return false;
    }
  }

  // "YYYY-MM-DD" -> 本地时区的 Date（不要用 new Date("2025-01-01")，那是 UTC，会差一天）
  function parseYmd(str) {
    const m = String(str).match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) {
      const d = new Date(str);
      return isNaN(d.getTime()) ? null : d;
    }
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  // 日历兜底：打开日历后按 aria-label / 单元格数字点选开始和结束日期。
  async function pickDatesFromCalendar(anchorInput, startDate, endDate) {
    try {
      await simulateHumanClick(anchorInput);
      const panel = await D.waitFor(() => D.findDatepickerPanel(), 6000);
      if (!panel) {
        logError("未找到日历面板", "pickDatesFromCalendar");
        return false;
      }
      const pickedStart = await clickCalendarDate(panel, startDate);
      if (!pickedStart) return false;
      await wait(randomBetween(500, 900));
      const pickedEnd = await clickCalendarDate(D.findDatepickerPanel() || panel, endDate);
      return pickedEnd;
    } catch (e) {
      logError(e, "pickDatesFromCalendar");
      return false;
    }
  }

  // 在日历里翻到目标月份并点中对应那天。
  async function clickCalendarDate(panel, target, maxHops = 24) {
    for (let hop = 0; hop < maxHops; hop++) {
      const current = readCalendarMonth(panel);
      if (!current) break;
      const delta = (target.getFullYear() - current.year) * 12 + (target.getMonth() - current.month);
      if (delta === 0) break;
      const navBtn = panel.querySelector(delta < 0 ? ".mat-calendar-previous-button" : ".mat-calendar-next-button");
      if (!navBtn || navBtn.disabled) {
        logWarning("日历无法继续翻月", "clickCalendarDate");
        break;
      }
      navBtn.click();
      await wait(randomBetween(250, 500));
    }

    const day = String(target.getDate());
    const cells = Array.from(panel.querySelectorAll(".mat-calendar-body-cell"));
    const cell = cells.find((c) => {
      const content = c.querySelector(".mat-calendar-body-cell-content");
      return content && content.textContent.trim() === day;
    });
    if (!cell) {
      logError(`日历里找不到 ${target.toDateString()}`, "clickCalendarDate");
      return false;
    }
    cell.click();
    await wait(randomBetween(300, 600));
    return true;
  }

  // 观察按钮状态变化
  function observeButtonState(button, context = "") {
    if (!button) {
      logError(`无法观察不存在的按钮: ${context}`, "observeButtonState");
      return;
    }

    // 创建观察器配置
    const config = {
      attributes: true,
      childList: true,
      subtree: true,
      characterData: true,
    };

    // 创建观察器
    const observer = new MutationObserver((mutations) => {
      mutations.forEach((mutation) => {
        // 记录状态变化
        if (mutation.type === "attributes") {
          log(`按钮属性变化 - ${context}: ${mutation.attributeName}`, "observeButtonState");
          debugButtonState(button, `${context}按钮属性变化`);
        } else if (mutation.type === "childList") {
          log(`按钮子元素变化 - ${context}`, "observeButtonState");
          debugButtonState(button, `${context}按钮子元素变化`);
        } else if (mutation.type === "characterData") {
          log(`按钮文本变化 - ${context}`, "observeButtonState");
          debugButtonState(button, `${context}按钮文本变化`);
        }
      });
    });

    // 开始观察
    observer.observe(button, config);
    log(`开始观察${context}按钮状态变化`, "observeButtonState");

    // 返回观察器，以便后续可以停止观察
    return observer;
  }

  // 在 findDownloadButtons 函数中添加观察
  async function findDownloadButtons() {
    const summaryButton = D.findSummaryButton();
    const historyButton = D.findHistoryButton();

    // 调试按钮状态
    debugButtonState(summaryButton, "游戏概要按钮");
    debugButtonState(historyButton, "历史记录按钮");

    // 开始观察按钮状态
    if (summaryButton) {
      observeButtonState(summaryButton, "游戏概要");
    }
    if (historyButton) {
      observeButtonState(historyButton, "历史记录");
    }

    return { summaryButton, historyButton };
  }

  // 尝试点击下载按钮
  async function tryClickDownloadButton(button, context) {
    if (!button) {
      logError(`未找到${context}按钮`, "tryClickDownloadButton");
      return false;
    }

    // 等待按钮可点击
    const isSummary = !!button.closest("app-download-button-game-session-summary");
    const clickableButton = await waitForButtonClickable(
      isSummary ? D.findSummaryButton : D.findHistoryButton,
      context,
    );

    if (!clickableButton) {
      logError(`${context}按钮不可点击`, "tryClickDownloadButton");
      return false;
    }

    // 记录点击前的状态
    debugButtonState(clickableButton, `${context}按钮点击前`);

    try {
      // 尝试多种点击方式
      // 1. 直接点击
      clickableButton.click();
      await wait(100);

      // 2. 模拟鼠标事件
      const events = ["mousedown", "mouseup", "click"];
      for (const eventType of events) {
        clickableButton.dispatchEvent(
          new MouseEvent(eventType, {
            bubbles: true,
            cancelable: true,
            view: window,
          }),
        );
        await wait(50);
      }

      // 3. 尝试触发 Angular 事件
      const component = clickableButton.closest(
        "app-download-button-game-session-summary, app-download-button-game-session-hand",
      );
      if (component) {
        component.dispatchEvent(
          new CustomEvent("download", {
            bubbles: true,
            detail: { type: context },
          }),
        );
      }

      // 记录点击后的状态
      debugButtonState(clickableButton, `${context}按钮点击后`);

      log(`已尝试点击${context}按钮`, "tryClickDownloadButton");
      return true;
    } catch (error) {
      logError(error, `点击${context}按钮时出错`);
      return false;
    }
  }

  /**
   * 点全选并确认真的选上了。
   *
   * 症状：有些批次表格明明有数据，两个下载按钮却停在"0 游戏概括信息/0 游戏历史记录"，
   * 插件当成"本轮 0 条"跳过，用户根本没机会点下载，还把水位线推过去了。
   *
   * 原因是点完"显示"后 Angular 会重建表格，之前抓到的复选框成了游离节点，
   * 对它 .click() 静默无效 —— 而代码从不校验结果。
   *
   * 所以：每次重试都重新查元素，点完看下载按钮上的数字有没有变成非 0，
   * 那才是"选中了多少场"的唯一真相。
   */
  async function selectAllAndVerify(rowCount, maxAttempts = 4) {
    let summaryCount = 0;
    let historyCount = 0;
    let attempts = 0;

    for (attempts = 1; attempts <= maxAttempts; attempts++) {
      if (stopFlag) break;
      await waitIfPaused();

      const box = D.findSelectAllCheckbox();
      if (!box) {
        logWarning(`第 ${attempts} 次：没找到表头全选复选框`, "selectAll");
        await wait(800);
        continue;
      }
      if (!D.isAttached(box)) {
        logWarning(`第 ${attempts} 次：复选框已从文档中移除（表格刚重渲染），重新查找`, "selectAll");
        await wait(800);
        continue;
      }

      const checkedBefore = D.isSelectAllChecked();
      log(`第 ${attempts} 次点全选 ${describeEl(box)}（当前${checkedBefore ? "已勾选" : "未勾选"}）`, "selectAll");

      // 已经勾上但条数却是 0，说明勾选状态和实际选中脱节了 —— 先取消再重勾
      if (
        checkedBefore &&
        D.downloadCount(D.findSummaryButton()) === 0 &&
        D.downloadCount(D.findHistoryButton()) === 0
      ) {
        log("勾选状态与条数不一致，先取消再重新勾选", "selectAll");
        box.click();
        await wait(randomBetween(400, 800));
      }

      const boxNow = D.findSelectAllCheckbox();
      if (boxNow && !D.isSelectAllChecked()) {
        boxNow.click();
      }

      // 等按钮上的数字更新
      await D.waitFor(
        () => {
          summaryCount = D.downloadCount(D.findSummaryButton());
          historyCount = D.downloadCount(D.findHistoryButton());
          return summaryCount > 0 || historyCount > 0;
        },
        6000,
        300,
      );

      summaryCount = D.downloadCount(D.findSummaryButton());
      historyCount = D.downloadCount(D.findHistoryButton());

      if (summaryCount > 0 || historyCount > 0) {
        log(`全选成功（第 ${attempts} 次）：概要 ${summaryCount}，手牌 ${historyCount}`, "selectAll");
        return { ok: true, summaryCount, historyCount, attempts };
      }

      logWarning(`第 ${attempts} 次全选后条数仍为 0（列表 ${rowCount} 行），重试`, "selectAll");
      await wait(randomBetween(800, 1500));
    }

    return { ok: false, summaryCount, historyCount, attempts: attempts - 1 };
  }

  /**
   * 高亮下载按钮，等用户点。
   * 返回 true 表示确实点了 —— 只有全点了本批才算完成，才允许推进水位线。
   *
   * GG 的下载要用户手势才触发，所以这一步没法自动化；能做的是确保按钮真的
   * 可点、提示清楚、并且用户没点时如实记为"本批未完成"而不是悄悄跳过。
   */
  // 点了下载之后，GG 要先在服务器上打包文件，浏览器才开始下载。GG 同一个用户的请求（看起来）是排队处理的：
  // 文件没打包好之前去加载下一段列表，列表请求会排在后面（线上一个 450 条的概要包打包了 7 分钟）。
  // 扩展不等下载开始（用户要求并行），而是在后台对上号（trackDownloadStart）；列表加载真排在后面时，
  // waitForTableSettled 把排队时间不算进超时。一个下载最多等这么久还没开始，就交给同步结束后的核对。
  // 每次点击最多等 6 分钟开始下载（和核对规则一致：6 分钟还没下载就算没下到、自动补）
  const DOWNLOAD_START_WAIT_MS = 6 * 60 * 1000;

  function ggDownloadIds() {
    return new Promise((resolve) =>
      chrome.storage.local.get(["ggDownloads"], (r) => {
        const list = Array.isArray(r && r.ggDownloads) ? r.ggDownloads : [];
        resolve(list);
      }),
    );
  }

  function setActivity(a) {
    currentStatus.activity = a;
    chrome.storage.local.set({ ggpokerStatus: currentStatus });
  }

  // —— 点了下载不等：GG 在后台打包，浏览器开始下载时在这里对上号 ——
  // 用户要求并行：点完就接着勾下一趟、加载下一段。GG 同一用户的请求排队处理，
  // 列表加载真排在打包后面时由 waitForTableSettled 多等（不算超时）；
  // 真没下到的，同步结束后的核对会发现并自动补。
  const pendingStarts = []; // [{ clickedAtMs, idsBefore, label }]，按点击先后
  let pendingTimer = null;

  function trackDownloadStart(clickedAtMs, idsBefore, label) {
    pendingStarts.push({ clickedAtMs, idsBefore, label });
    publishPending();
    schedulePendingCheck();
  }

  // 用 setTimeout 自己循环（不用 setInterval）：有等着的才继续查，查完就停
  function schedulePendingCheck() {
    if (pendingTimer || !pendingStarts.length) return;
    pendingTimer = setTimeout(async () => {
      pendingTimer = null;
      try {
        await checkPendingStarts();
      } finally {
        schedulePendingCheck();
      }
    }, 1500);
  }

  function publishPending() {
    if (!pendingStarts.length) {
      if (currentStatus.activity && currentStatus.activity.kind === "pending") setActivity(null);
      return;
    }
    const oldest = pendingStarts[0];
    currentStatus.activity = {
      kind: "pending",
      n: pendingStarts.length,
      label: oldest.label,
      secs: Math.round((Date.now() - oldest.clickedAtMs) / 1000),
      at: Date.now(),
    };
    chrome.storage.local.set({ ggpokerStatus: currentStatus });
  }

  async function checkPendingStarts() {
    if (!pendingStarts.length) {
      publishPending();
      return;
    }
    const list = await ggDownloadIds();
    // 下载按点击先后开始（GG 排队打包）：新出现的下载依次对给最早还在等的点击
    const claimed = new Set();
    for (const p of pendingStarts.slice()) {
      const hit = list.find(
        (d) => d && !p.idsBefore.has(d.id) && !claimed.has(d.id) && (d.startTime || 0) >= p.clickedAtMs - 3000,
      );
      const secs = Math.round((Date.now() - p.clickedAtMs) / 1000);
      if (hit) {
        claimed.add(hit.id);
        pendingStarts.splice(pendingStarts.indexOf(p), 1);
        // 之后的点击都不能再认这个下载
        for (const q of pendingStarts) q.idsBefore.add(hit.id);
        log(`GG 用了 ${secs} 秒准备好${p.label}文件，浏览器已开始下载`, "dlwait");
      } else if (Date.now() - p.clickedAtMs > DOWNLOAD_START_WAIT_MS) {
        pendingStarts.splice(pendingStarts.indexOf(p), 1);
        logWarning(`${p.label}点了 ${secs} 秒还没开始下载（同步结束后的核对会发现，缺了会自动补）`, "dlwait");
      } else {
        break; // 前面的还没开始，后面的更不会先开始
      }
    }
    publishPending();
  }

  async function promptDownload(kind, expectedCount, startStr, endStr, rec, opts = {}) {
    const label = kind === "summary" ? "游戏概要" : "历史手牌记录";
    const finder = kind === "summary" ? D.findSummaryButton : D.findHistoryButton;

    // 按钮不可用时不能放弃。
    //
    // 典型场景：一批里既有概要又有手牌，用户点完"概要"下载之后 GG 把选中清空了，
    // 手牌按钮的条数就变成 0、按钮 disabled。旧代码等 15 秒拿不到可点按钮就返回
    // false，外层据此判定"未全部下载"，虽然没推进水位线，但游标照样往前走 ——
    // 表现就是"概要点完，手牌还没点就自动跳到下一个时间段"。
    //
    // 正确做法：选中被清空就重新全选，然后继续等用户点。
    // 除非用户按"停止"，否则一直等下去。
    let recoverTries = 0;

    while (!stopFlag) {
      await waitIfPaused();

      const btn = finder();
      if (D.isDownloadReady(btn)) {
        const count = D.downloadCount(btn);
        log(`请点击下载${label}（${startStr} ~ ${endStr}，共 ${count} 条）`, "promptDownload");
        // 点之前记下已有的下载，点之后出现的新下载才是这一次的
        const idsBefore = new Set((await ggDownloadIds()).map((d) => d && d.id));
        const clicked = await waitForUserClick(finder, kind, label, startStr, endStr, count);
        if (clicked) {
          // 点击时刻要立刻告诉后台：浏览器随后开始的下载才能和这次点击对上，
          // 之后才知道那个文件到底下完了还是中断了
          const clickedAtMs = Date.now();
          sendToBackground({ action: "ggDownloadClick" });
          statClick(kind, count);
          log(`已点击下载${label}`, "promptDownload");
          // 点了按钮不等于下载完成：GG 可能紧接着弹一个确认/准备中的框。
          // 那个框没处理完就推进时间，这一批其实根本没下到。
          const dialogHandled = await waitForDownloadSettled(label);
          // 点了就记一笔（哪怕弹窗还没处理完就被停止了，settled=false 如实标出）。
          // 扩展看不到文件是否真的下成功，这条记录就是给实时GTO分析模块核对用的。
          if (rec) {
            recordLedger(rec, kind, "clicked", {
              count,
              settled: !!dialogHandled,
              clickedAtMs,
              clickedAt: GG_LEDGER ? GG_LEDGER.localIso(clickedAtMs) : null,
            });
          }
          if (!dialogHandled) return false; // 只有用户停止才会 false
          // 不等下载开始：记下来在后台对上号，接着做下一步
          trackDownloadStart(clickedAtMs, idsBefore, label);
          if (stopFlag) return false;
          logSuccess(`下载${label}已完成`, "promptDownload");
          return true;
        }
        logWarning(`等待下载${label}时被手动停止`, "promptDownload");
        return false; // 只有 stop 才会到这
      }

      // 表格都空了就真没得下了，这是异常状态，不能死等
      const rows = D.countRows();
      if (rows === 0) {
        logWarning(`${label}按钮不可用且列表已空（全选时曾读到 ${expectedCount} 条），页面状态异常`, "promptDownload");
        return false;
      }

      recoverTries++;
      if (opts.reselect && recoverTries > 3) {
        logWarning(
          `${label}按钮重新勾选 3 次仍不可用（按钮显示"${((btn && btn.textContent) || "").replace(/\s+/g, " ").trim()}"），这一趟放弃`,
          "promptDownload",
        );
        return false;
      }
      if (opts.reselect) {
        // 分趟时不能全选（会勾上整张表、超过上限），只重新勾回这一趟的那些行
        logWarning(
          `${label}按钮不可用（上一次下载后 GG 清空了勾选），第 ${recoverTries} 次重新勾回这一趟的行`,
          "promptDownload",
        );
        await opts.reselect();
        await wait(randomBetween(500, 900));
        continue;
      }
      logWarning(
        `${label}按钮不可用（条数 ${D.downloadCount(btn)}，列表仍有 ${rows} 行）` +
          `—— 多半是上一次下载后选中被清空，第 ${recoverTries} 次重新全选`,
        "promptDownload",
      );
      const sel = await selectAllAndVerify(rows, 2);
      if (!sel.ok) {
        updateStatus(
          "warning",
          `${label}：重新全选未成功（已试 ${recoverTries} 次），仍在重试；要中断请点"停止"`,
          "promptDownload",
        );
        await wait(randomBetween(1500, 2500));
      }
    }

    logWarning(`等待下载${label}时被手动停止`, "promptDownload");
    return false;
  }

  /**
   * 往下载记录里写一条。rec 是本批的公共信息（runId/批次/日期/页面类型/GG 可下载起始日），
   * 由 loopDownload 组好传下来；kind 决定用哪个"GG 可下载起始日"。
   * 写记录失败不能影响下载流程，所以只打日志不抛。
   */
  function recordLedger(rec, kind, status, extra) {
    if (!GG_LEDGER || !rec) return;
    const { summaryFrom, historyFrom, ...base } = rec;
    const entry = Object.assign(
      base,
      {
        kind,
        status,
        availableFrom: kind === "summary" ? summaryFrom : historyFrom,
      },
      extra || {},
    );
    GG_LEDGER.add(entry).catch((e) => console.error("[GGPoker助手] 写下载记录失败", e));
  }

  /**
   * 一直等到用户点下载按钮为止 —— 不设超时。
   *
   * 之前是 30 秒超时后自动跳到下一个时间段，用户根本来不及点，
   * 那几天就被当成"已同步"永久跳过了。有数据就必须等，
   * 要中断请点"停止"（stopFlag）。
   *
   * Angular 可能在等待期间重建按钮节点，所以每轮都重新查找：
   * 节点换了就把监听和高亮重新挂到新节点上，否则用户点了也收不到。
   */
  function waitForUserClick(finder, kind, label, startStr, endStr, count) {
    return new Promise((resolve) => {
      let done = false;
      let watched = null;
      let missingSince = 0;
      const waitingSince = Date.now();

      const onClick = () => finish(true);

      function attach(btn) {
        if (watched === btn) return;
        if (watched) watched.removeEventListener("click", onClick);
        watched = btn;
        btn.addEventListener("click", onClick);
        highlightAndPromptDownloadButton(kind);
      }

      function finish(clicked) {
        if (done) return;
        done = true;
        clearInterval(timer);
        if (watched) watched.removeEventListener("click", onClick);
        resolve(clicked);
      }

      const timer = setInterval(() => {
        if (stopFlag) return finish(false);
        if (pauseFlag) return; // 暂停时继续等，不计时也不放弃

        const btn = finder();
        if (btn && D.isAttached(btn)) {
          missingSince = 0;
          if (btn !== watched) {
            log(`下载按钮节点已被重建，重新挂监听`, "promptDownload");
            attach(btn);
          }
        } else if (!missingSince) {
          missingSince = Date.now();
        }

        const secs = Math.round((Date.now() - waitingSince) / 1000);
        if (missingSince) {
          // 按钮不见了就照实说，否则用户只会看到界面卡住不动、不知道为什么
          const gone = Math.round((Date.now() - missingSince) / 1000);
          updateStatus("warning", `下载${label}按钮已消失 ${gone} 秒（页面可能被刷新）。请点"停止"后重新同步。`);
        } else {
          updateStatus("info", `请点击「下载${label}」：${startStr} ~ ${endStr}（${count} 条）— 已等待 ${secs} 秒`);
        }
      }, DOWNLOAD_PROMPT_REFRESH_MS);

      const first = finder();
      if (first) attach(first);
      updateStatus("info", `请点击「下载${label}」：${startStr} ~ ${endStr}（${count} 条）`);
    });
  }

  /**
   * 等表格加载完成。
   *
   * 首选"网络信号"，而不是猜时间。
   *
   * 之前几版都在猜：等转圈、等 DOM 若干秒不变、等表格连续空 N 秒。
   * 问题是阈值定多少都不对 —— PokerCraft 从清空表格到填入数据实测能超过 2 秒，
   * 转圈还未必检测得到；阈值调大只是把失效点往后挪，网一慢照样判成"没有数据"，
   * 不提示下载就推进水位线。
   *
   * 真正确定的信号是网络本身：请求发出了没有、结束了没有。
   * network-probe.js 在页面里统计在途请求数，这里读它：
   *
   *   1. 点"显示"后等一个新请求发出（页面确实去取数据了）
   *   2. 等在途请求归零（数据回来了）
   *   3. 等 DOM 安静下来（Angular 渲染完了，用 MutationObserver，不轮询）
   *
   * 全程没有"等 N 秒就认为好了"的假设，网再慢也只是多等，不会误判。
   *
   * 探针没装上时（比如 Chrome 不支持 MAIN world 注入）退回旧的时间判据，
   * 并在日志里说明，免得排查时以为走的是新路径。
   */
  // GG 慢的时候每次加载要一两分钟（线上 2 天的区间用了 107 秒），2 分钟太容易误判成超时
  async function waitForTableSettled(fpBefore, netBefore, timeout = 180000) {
    const net = D.netState();
    if (!net.available) {
      logWarning("网络探针未装载，退回基于时间的判据（准确性较差）", "settle");
      return waitForTableSettledByTime(fpBefore);
    }

    const deadline = Date.now() + timeout;
    // netBefore 是点击"显示"之前的快照；没传就只能用当前值（会低估）
    const seenBefore = netBefore && netBefore.available ? netBefore.seen : net.seen;

    // 1) 确认页面确实去取数据了。
    //    请求可能在点击处理里已经同步发出（此时 seen 已经涨了），
    //    也可能 Angular 稍后才发，所以给 8 秒窗口。
    //    等不到也不算错：结果可能命中前端缓存，直接进入下一步看 DOM。
    const fired = await D.waitFor(() => D.netState().seen > seenBefore || D.netState().inflight > 0, 8000, 100);
    if (!fired) {
      log("没观察到新的网络请求（可能命中了前端缓存）", "settle");
    }

    // 2) 等在途请求归零。这一步不设短超时 —— 网慢就是多等，绝不能提前下结论。
    //    GG 还在打包我们点过的下载文件时，列表请求排在它后面：这段排队时间不算进超时
    //    （最长等到 12 分钟），也记下来（queuedMs），估加载速度、判断"空结果可疑"时扣掉。
    const waitStart = Date.now();
    let queuedMs = 0,
      lastTick = Date.now(),
      queueNoted = false,
      idle = false;
    while (true) {
      if (D.netState().inflight === 0) {
        idle = true;
        break;
      }
      const now = Date.now();
      if (pendingStarts.length) {
        queuedMs += now - lastTick;
        if (!queueNoted && now - waitStart > 30000) {
          queueNoted = true;
          log(`列表请求排在 GG 打包的 ${pendingStarts.length} 个下载文件后面，继续等`, "settle");
        }
      }
      lastTick = now;
      if (now > Math.min(waitStart + DOWNLOAD_START_WAIT_MS, deadline + queuedMs)) break;
      await new Promise((r) => setTimeout(r, 150));
    }
    if (!idle) {
      logWarning("等待网络请求结束超时", "settle");
    }

    // 3) 等 Angular 把数据渲染进 DOM
    const quiet = await D.waitForDomQuiet(700, Math.max(2000, deadline - Date.now()));

    const rows = D.countRows();
    const fp = D.tableFingerprint();
    // 这次加载期间有没有请求失败（网络错误、被中止、HTTP 4xx/5xx）
    const failedBefore = netBefore && netBefore.available ? netBefore.failed || 0 : D.netState().failed;
    const failed = D.netState().failed > failedBefore;
    const tookMs = Date.now() - waitStart;
    log(
      `加载完成：新请求=${fired ? "有" : "无"}，网络空闲=${idle}，DOM=${quiet}，${rows} 行` +
        (failed ? "，期间有请求失败" : "") +
        // 加载久的时候记下当时的状况，用来判断是不是排在 GG 打包下载文件后面
        (tookMs > 30000
          ? `（用了 ${Math.round(tookMs / 1000)} 秒，其中排队 ${Math.round(queuedMs / 1000)} 秒；` +
            `在途请求 ${D.netState().inflight}，GG 打包中 ${pendingStarts.length}）`
          : ""),
      "settle",
    );
    return {
      changed: fp !== fpBefore,
      stable: !!idle,
      queuedMs,
      failed,
      rows,
      fingerprint: fp,
      viaNetwork: true,
    };
  }

  /**
   * 退化路径：没有网络探针时只能按时间猜。
   * 保留是为了探针注入失败时还能用，但准确性不如上面那条路。
   * 空表仍然要求连续空满 EMPTY_DWELL_MS —— 判空是唯一一条不下载也推进
   * 水位线的路径，误判等于永久丢数据。
   */
  async function waitForTableSettledByTime(fpBefore, timeout = 60000) {
    const SAMPLE_MS = 300;
    const NEEDED_STABLE = 4;
    const EMPTY_DWELL_MS = 8000;
    const SAME_CONTENT_GIVEUP_MS = 12000;
    const MIN_WAIT_MS = 1200;

    await wait(MIN_WAIT_MS);

    const deadline = Date.now() + timeout;
    const started = Date.now();
    let lastFp = null;
    let stableCount = 0;
    let changed = false;
    let emptySince = 0;

    while (Date.now() < deadline) {
      if (stopFlag) break;
      await wait(SAMPLE_MS);

      if (D.isLoading()) {
        stableCount = 0;
        lastFp = null;
        emptySince = 0;
        continue;
      }

      const rows = D.countRows();
      const fp = D.tableFingerprint();
      if (fp !== fpBefore) changed = true;

      if (rows === 0) {
        if (!emptySince) emptySince = Date.now();
        const dwelled = Date.now() - emptySince;
        if (dwelled >= EMPTY_DWELL_MS) {
          return { changed, stable: true, rows: 0, fingerprint: fp, emptyDwellMs: dwelled };
        }
        continue;
      }

      emptySince = 0;

      if (fp === lastFp) {
        stableCount++;
      } else {
        stableCount = 1;
        lastFp = fp;
      }

      if (stableCount >= NEEDED_STABLE) {
        if (changed) return { changed: true, stable: true, rows, fingerprint: fp };
        if (Date.now() - started > SAME_CONTENT_GIVEUP_MS) {
          return { changed: false, stable: true, rows, fingerprint: fp };
        }
      }
    }

    return { changed, stable: false, rows: D.countRows(), fingerprint: lastFp };
  }

  /**
   * 单日场次就超过上限时，按"行"分批下载。
   *
   * 日期已经切到 1 天，再切不动了；但 GG 限的是"一次选中多少场"，
   * 所以改成每次只勾前 N 行、下载、再勾下一批 N 行，直到把这一天下完。
   *
   * 每一趟都要用户点下载（和平时一样，不点不会继续）。
   * 全部趟次都完成才返回 true —— 只要有一趟没下，这一天就不算完，不能推进水位线。
   */
  // 只下概要的那一遍被 GG 按手数拦过（说明 GG 勾选时两个上限一起查）：之后的批次每趟两个按钮都点，
  // 勾的行按手数定。分开下只在 GG 只查概要条数时才省点击。
  // 学到的结论按分类存下来，下次同步直接用，不用再被拦一次。
  let summaryHandsBound = false;
  const SUMMARY_HANDS_BOUND_KEY = "ggSummaryHandsBound";
  function loadSummaryHandsBound() {
    return new Promise((resolve) =>
      chrome.storage.local.get([SUMMARY_HANDS_BOUND_KEY], (r) => {
        const all = (r && r[SUMMARY_HANDS_BOUND_KEY]) || {};
        resolve(!!all[currentPageType()]);
      }),
    );
  }
  function saveSummaryHandsBound() {
    chrome.storage.local.get([SUMMARY_HANDS_BOUND_KEY], (r) => {
      const all = (r && r[SUMMARY_HANDS_BOUND_KEY]) || {};
      all[currentPageType()] = true;
      chrome.storage.local.set({ [SUMMARY_HANDS_BOUND_KEY]: all });
    });
  }

  // 分趟下载没下完时，是哪几类没下完（概要那一遍失败时手牌还没开始，两类都算）；null 表示这一批都没下
  let chunkFailedKinds = null;

  async function downloadInChunks(chunkSize, startStr, endStr, inHistoryWindow, rec, want = {}) {
    chunkFailedKinds = null;
    const wantSummary = want.wantSummary !== false;
    const wantHistory = want.wantHistory !== false;
    const doSummary = wantSummary && currentPageConfig().hasSummary;
    const doHistory = inHistoryWindow && wantHistory;
    // 一趟最多勾多少行（概要按钮的上限，默认 500）
    const maxRows = Math.max(1, want.maxRows || chunkSize);
    const handLimit = L.HISTORY_MAX_HANDS_PER_DOWNLOAD;
    if (!summaryHandsBound && doSummary && doHistory) summaryHandsBound = await loadSummaryHandsBound();
    const total = D.findRowCheckboxes().length;
    if (!total) {
      logWarning("按行分批时找不到行复选框，放弃本批", "chunk");
      return false;
    }
    // 剩下的行平均分：507 行、上限 500 就分 254 + 253，而不是 500 + 7
    const balanced = (rem, cap) => Math.ceil(rem / Math.ceil(rem / Math.max(1, cap)));

    // 勾第 from..to-1 行，等按钮上的数字稳定下来再读
    const pick = async (from, to) => {
      D.clearSelection();
      await wait(randomBetween(300, 600));
      const left = D.downloadCount(D.findSummaryButton());
      if (left > 0) {
        logWarning(`清空勾选后概要按钮仍是 ${left} 条（表头 ${D.selectAllState()}），可能有看不见的已选行`, "chunk");
      }
      const boxes = D.findRowCheckboxes();
      if (boxes.length !== total) {
        logWarning(`行数从 ${total} 变成 ${boxes.length}，表格被重渲染了，放弃分批`, "chunk");
        return { ok: false };
      }
      for (let r = from; r < to; r++) {
        const b = boxes[r];
        if (b && b.tagName === "INPUT" && !b.checked) b.click();
      }
      let last = "",
        stable = 0,
        s = 0,
        h = 0;
      for (let i = 0; i < 12 && stable < 2; i++) {
        await wait(i === 0 ? randomBetween(600, 900) : 300);
        s = D.downloadCount(D.findSummaryButton());
        h = D.downloadCount(D.findHistoryButton());
        const sig = `${s}|${h}`;
        stable = sig === last && (s > 0 || h > 0) ? stable + 1 : 0;
        last = sig;
      }
      // 勾多了 GG 会弹"下载限制"遮罩，先关掉再说
      const limit = D.findLimitError();
      if (limit || D.findLimitDialog()) {
        logWarning(
          `勾第 ${from + 1}-${to} 行后出现"下载限制"：概要 ${s} / 手牌 ${h}，表头 ${D.selectAllState()}`,
          "limit",
        );
        await dismissLimitDialog("分趟勾选后");
      }
      return { ok: true, sCount: s, hCount: h, limit: limit || null };
    };

    // 一种下载分几趟：wantS / wantH 决定这一遍点哪个按钮。
    // 手牌按钮上是手数：勾的行按手数调（超了按比例少勾，远没装满就多勾），每趟接近 2 万手。
    // 只下概要的那一遍如果 GG 因为手数弹了超限，也按手数把这一趟缩小。
    let round = 0;
    const pass = async (wantS, wantH, label) => {
      let from = 0;
      let size = wantH ? Math.min(maxRows, chunkSize) : balanced(total, maxRows);
      let handsBound = false; // 这一遍是否要受手数限制（手牌遍一定要；概要遍被 GG 拦过才要）
      let perRow = 0; // 量到的每行手数
      while (from < total) {
        if (stopFlag) return false;
        await waitIfPaused();
        round++;
        let to = Math.min(total, from + Math.max(1, size));
        let sel = await pick(from, to);
        if (!sel.ok) return false;

        for (let t = 0; t < 3; t++) {
          const rows = to - from;
          const handsLike = sel.hCount > rows; // 按钮数比行数还大，才当它是手数
          if (handsLike) perRow = sel.hCount / rows;
          if (sel.limit && !wantH && handsLike && sel.hCount > handLimit * L.AUTO.HANDS_OVER) {
            handsBound = true;
            if (!summaryHandsBound) {
              summaryHandsBound = true;
              saveSummaryHandsBound();
              log(`只勾概要时 GG 也按手数拦了（${sel.hCount} 手），之后每趟概要和手牌一起下`, "chunk");
            }
          }
          const bound = wantH || handsBound;
          let next = rows;
          if (sel.limit) {
            next = handsLike ? Math.floor((rows * handLimit * L.AUTO.HANDS_FILL) / sel.hCount) : Math.floor(rows / 2);
          } else if (bound && handsLike && sel.hCount > handLimit * L.AUTO.HANDS_OVER) {
            next = Math.floor((rows * handLimit * L.AUTO.HANDS_FILL) / sel.hCount);
          } else if (wantH && handsLike && sel.hCount < handLimit * 0.8 && to < total && rows < maxRows) {
            next = Math.min(maxRows, total - from, Math.floor((rows * handLimit * L.AUTO.HANDS_FILL) / sel.hCount));
          }
          next = Math.max(1, Math.min(maxRows, next));
          if (next === rows) break;
          log(
            `第 ${round} 趟：${rows} 行是 ${sel.hCount} 手${sel.limit ? "（GG 提示超限）" : ""}，改勾 ${next} 行`,
            "chunk",
          );
          to = from + next;
          sel = await pick(from, to);
          if (!sel.ok) return false;
        }
        if (sel.limit) {
          logWarning(
            `第 ${round} 趟只勾 ${to - from} 行仍然超限：${sel.limit.text}，放弃分批（下次会用更小的上限）`,
            "chunk",
          );
          return false;
        }
        // 只下手牌的一遍：这几行有比赛（概要数 > 0）却一手牌都没有 —— 它们早于 GG 手牌保留的最近 3 个月
        // （GG 的窗口比按日期算的晚一两天），没有可下的，跳过这几行，不算失败
        if (wantH && !wantS && sel.hCount === 0 && sel.sCount > 0) {
          log(
            `第 ${round} 趟：第 ${from + 1}-${to} 行有 ${sel.sCount} 场比赛但 GG 没有手牌（早于 GG 保留的最近 3 个月），跳过`,
            "chunk",
          );
          from = to;
          continue;
        }
        if ((wantS ? sel.sCount : 0) === 0 && (wantH ? sel.hCount : 0) === 0) {
          logWarning(`第 ${round} 趟勾选后条数仍为 0，放弃分批`, "chunk");
          return false;
        }

        const rows = to - from;
        log(
          `第 ${round} 趟（${label}）：第 ${from + 1}-${to} 行（共 ${total} 行），概要 ${sel.sCount} / 手牌 ${sel.hCount}`,
          "chunk",
        );
        const text = `${startStr}（第 ${round} 趟，第 ${from + 1}-${to} 行）`;
        // 同一段日期拆成几趟：记录里标上第几趟、哪几行、这一趟的行数（学每行手数时要用）
        const chunkRec =
          rec &&
          Object.assign({}, rec, {
            chunk: String(round),
            rowRange: `${from + 1}-${to}`,
            rows,
            rowsExact: true,
          });
        const reselect = () => pick(from, to);
        if (wantS) {
          const ok = await promptDownload("summary", sel.sCount, text, endStr, chunkRec, { reselect });
          if (!ok) return false;
        }
        if (stopFlag) return false;
        if (wantH && sel.hCount > 0) {
          // 概要+手牌一起下时，没有手牌的那趟不点手牌
          const ok = await promptDownload("history", sel.hCount, text, endStr, chunkRec, { reselect });
          if (!ok) return false;
        }

        from = to;
        // 下一趟：受手数限制就按量到的每行手数定，否则按上限；剩下的行平均分
        const rem = total - from;
        if (rem > 0) {
          const byHands =
            (wantH || handsBound) && perRow ? Math.floor((handLimit * L.AUTO.HANDS_FILL) / perRow) : maxRows;
          size = balanced(rem, Math.min(maxRows, byHands));
        }
      }
      return true;
    };

    log(
      `${startStr} ~ ${endStr} 共 ${total} 行，超过单次下载上限，分几趟下：勾一部分 → 点下载 → 再勾下一部分` +
        (doSummary && doHistory
          ? `（概要每趟不超过 ${maxRows} 条，手牌每趟不超过 ${handLimit} 手，分开下）`
          : doHistory
            ? `（每趟不超过 ${handLimit} 手）`
            : `（每趟不超过 ${maxRows} 条）`),
      "chunk",
    );
    // 概要和手牌分开分趟：各自装满各自的上限（概要 500 条一趟，手牌 2 万手一趟），
    // 比每趟两个都点省：同一段 1900 行、15 万手，一起点要 16 次，分开只要 4 + 8 次
    if (doSummary && doHistory && summaryHandsBound) {
      if (!(await pass(true, true, "概要+手牌"))) {
        chunkFailedKinds = ["summary", "history"];
        return false;
      }
    } else {
      if (doSummary && !(await pass(true, false, "概要"))) {
        chunkFailedKinds = doHistory ? ["summary", "history"] : ["summary"];
        return false;
      }
      if (doHistory && !(await pass(false, true, "手牌"))) {
        chunkFailedKinds = ["history"];
        return false;
      }
    }
    D.clearSelection();
    logSuccess(`${startStr} ~ ${endStr} 分 ${round} 趟下载完成`, "chunk");
    return true;
  }

  // 学到的"一次最多能选多少场"存在本地，跨轮次复用。
  // 按页面类型分开存：锦标赛和现金局的限制未必一样。
  const LEARNED_CAP_KEY = "ggLearnedCap";

  function loadLearnedCap() {
    const type = currentPageType();
    return new Promise((resolve) => {
      chrome.storage.local.get([LEARNED_CAP_KEY], (r) => {
        const all = (r && r[LEARNED_CAP_KEY]) || {};
        const v = all[type];
        resolve(typeof v === "number" && v > 0 ? v : null);
      });
    });
  }

  function saveLearnedCap(value) {
    const type = currentPageType();
    return new Promise((resolve) => {
      chrome.storage.local.get([LEARNED_CAP_KEY], (r) => {
        const all = (r && r[LEARNED_CAP_KEY]) || {};
        all[type] = value;
        chrome.storage.local.set({ [LEARNED_CAP_KEY]: all }, () => {
          log(`已记住 ${type} 的选中上限 ${value} 条，下次同步直接用`, "limit");
          resolve();
        });
      });
    });
  }

  /**
   * 关掉官方"下载限制"弹窗。
   *
   * 这个弹窗在选中数超过上限时会弹出来，带一层遮罩罩住整页 ——
   * 用户点不到下载按钮（正是"超过 500 条后没法点下载"的原因），
   * 插件也点不到日期下拉、显示按钮，整轮同步就卡死在那里。
   *
   * 所以每批开工前、以及每次检测到超限之后，都要先把它清掉。
   */
  async function dismissLimitDialog(when) {
    const dlg = D.findLimitDialog();
    if (!dlg) return false;

    logWarning(`检测到"下载限制"弹窗（${when}）：${dlg.text.slice(0, 80)}`, "limit");
    const how = D.closeLimitDialog();
    await wait(randomBetween(500, 900));

    // 关不掉就再试一次遮罩/Esc，实在不行只能如实告知
    if (D.findLimitDialog()) {
      D.closeOverlay();
      await wait(randomBetween(500, 900));
    }
    if (D.findLimitDialog()) {
      logError('"下载限制"弹窗关不掉，页面被遮罩挡住，无法继续。请手动关闭弹窗后重新点同步。', "limit");
      return true;
    }
    log(`已关闭"下载限制"弹窗（方式：${how}）`, "limit");
    return true;
  }

  /**
   * 点完下载按钮后，等这次下载真的收尾。
   *
   * "按钮被点了"不等于"下载完成了"。点完之后可能出现两种情况：
   *   · 弹一个框（确认 / 准备中）—— 没处理完这一批就没下到；
   *   · 只转圈生成文件（实测更常见，弹窗根本不出现）—— 转圈期间文件还没好。
   * 两种都得等。之前只等弹窗，遇到"只转圈"的情况 2.5 秒就返回并推进了时间。
   *
   * 除非用户按"停止"，否则一直等。等太久会把屏幕上到底挡着什么打进日志 ——
   * 光说"还在等"没用，得说清楚等的是哪个东西，这样卡住时能直接反馈。
   *
   * 返回 false 只代表被手动停止。
   */
  async function waitForDownloadSettled(label) {
    const SETTLE_QUIET_MS = 1500; // 弹窗和转圈都消失并持续这么久才算收尾
    const NAG_EVERY_MS = 5000; // 多久刷新一次状态栏
    const DUMP_AFTER_MS = 45000; // 等这么久还没完就把遮挡物快照打出来

    const since = Date.now();
    let clearSince = 0;
    let lastNag = 0;
    let dumped = false;
    let sawSomething = false;

    while (!stopFlag) {
      await waitIfPaused();

      // "下载限制"是错误提示，不该让用户去点，直接关掉
      if (D.findLimitDialog()) {
        await dismissLimitDialog(`下载${label}之后`);
        return true;
      }

      const dlg = D.findOpenDialog();
      const spin = D.findBusySpinner();

      if (!dlg && !spin) {
        if (!clearSince) clearSince = Date.now();
        if (Date.now() - clearSince >= SETTLE_QUIET_MS) {
          const secs = Math.round((Date.now() - since) / 1000);
          if (sawSomething) log(`下载${label}收尾完成（等待 ${secs} 秒）`, "promptDownload");
          return true;
        }
        await wait(300);
        continue;
      }

      clearSince = 0;
      if (!sawSomething) {
        sawSomething = true;
        logWarning(
          `下载${label}后页面还在忙：` +
            (dlg ? `弹窗「${dlg.text.slice(0, 40)}」` : "") +
            (spin ? `${dlg ? " + " : ""}转圈(${spin.where})` : ""),
          "promptDownload",
        );
      }

      const elapsed = Date.now() - since;
      if (elapsed - lastNag >= NAG_EVERY_MS) {
        lastNag = elapsed;
        const secs = Math.round(elapsed / 1000);
        updateStatus(
          "warning",
          dlg
            ? `请在弹窗中完成下载${label}（已等待 ${secs} 秒）；处理完会自动继续`
            : `正在生成${label}文件，请稍候（已等待 ${secs} 秒）；要中断请点"停止"`,
          "promptDownload",
        );
      }

      if (!dumped && elapsed >= DUMP_AFTER_MS) {
        dumped = true;
        const blockers = D.describeBlockers();
        logWarning(
          `下载${label}已等待 ${Math.round(elapsed / 1000)} 秒仍未收尾。` +
            `屏幕上：弹窗 ${blockers.dialogs.length} 个、转圈 ${blockers.spinners.length} 个、` +
            `遮罩 ${blockers.backdrops} 层。详情见控制台，可把这段发给开发者。`,
          "promptDownload",
        );
        console.log("[GGPoker助手] 当前遮挡物快照", blockers);
      }

      await wait(400);
    }

    logWarning(`等待${label}下载收尾时被手动停止`, "promptDownload");
    return false;
  }

  /**
   * 确认筛选框里显示的确实是本批要的日期区间。
   *
   * 不做这一步的话，日期写入偶尔失败时我们会拿上一批的结果继续跑：
   * 行数不对、据此缩跨度也不对，最后还可能把错的数据当成这一批下载掉。
   * 线上日志里 7 天和 3 天两个区间都返回 189 行，就是这么来的。
   *
   * 读不到输入框（比如筛选栏收起来了）就不拦截，只返回 ok —— 宁可放过，
   * 也不要因为读不到控件而把正常批次全判成失败。
   */
  function verifyFilterApplied(roundStart, roundEnd) {
    const shown = D.readDateRangeInputs();
    if (!shown || (!shown.start && !shown.end)) {
      return { ok: true, shown: null, skipped: true };
    }
    const okStart = D.sameDay(shown.start, roundStart.getFullYear(), roundStart.getMonth() + 1, roundStart.getDate());
    const okEnd = D.sameDay(shown.end, roundEnd.getFullYear(), roundEnd.getMonth() + 1, roundEnd.getDate());
    return {
      ok: okStart && okEnd,
      shown: `${shown.start} ~ ${shown.end}`,
    };
  }

  /**
   * 分批下载一段日期。
   *
   * 默认是正常同步：区间 = "上次同步到哪天的第二天 ~ 今天"，每批完成推进水位线。
   * repair 模式（按实时GTO的核对结果补下载）：
   *   opts = { repair: true, from, to, kinds: ['summary'|'history'...] }
   *   只跑给定区间、只提示下载 kinds 里的类别，不碰水位线（同步进度）。
   * 返回 { ok }：区间内每一批都完成才算 ok。
   */
  async function loopDownload(opts = {}) {
    const repair = !!opts.repair;
    const pageType = currentPageType();
    const realToday = L.today();
    const earliestSummary = L.earliestSummaryDate(realToday);
    const earliestHistory = L.earliestHistoryDate(realToday);
    // 这一轮要下哪几类。正常同步两类都要（按页面和 GG 窗口再筛）；补下载只下漏掉的那类
    const wantSummary = !opts.kinds || opts.kinds.includes("summary");
    const wantHistory = !opts.kinds || opts.kinds.includes("history");

    // 之前下过、但因为中途有批次失败没推进同步记录的日期：先按下载记录推过去，免得整段重下
    if (!repair) await advanceWatermarkByLedger(pageType, L.fmt(L.today()), "按下载记录这些日期都已经下过");
    // 同步区间不再由用户选，而是"上次同步到哪天的第二天 ~ 今天"
    const saved = await GG_SYNC.get(pageType);
    const plan = repair
      ? {
          from: opts.from,
          to: opts.to,
          days: L.diffDays(L.parse(opts.to), L.parse(opts.from)) + 1,
          hasSummary: L.pageConfig(pageType).hasSummary,
        }
      : L.planSync(saved.lastSyncedDate, realToday, pageType);

    if (plan.staleWatermark) {
      logWarning(
        `上次同步停在 ${saved.lastSyncedDate}，已超出 GG 的 ` +
          `${plan.hasSummary ? L.SUMMARY_MONTHS : L.HISTORY_MONTHS} 个月窗口，` +
          `中间缺的那段 GG 已经删了，本次从 ${plan.earliest} 重新开始`,
        "loopDownload",
      );
    }
    if (plan.nothingToDo) {
      logSuccess(`已经是最新的（上次同步到 ${saved.lastSyncedDate}），没有需要下载的日期`, "loopDownload");
      currentStatus.isRunning = false;
      updateStatus("success", "已是最新，无需下载");
      return;
    }

    const start = L.parse(plan.from);
    const end = L.parse(plan.to);
    const spanDays = plan.days;
    let doneDays = 0;

    // 批次跨度自动调整，事先算不出总批次数，进度按天数报
    // 从旧往新跑，起点通常在 3 个月窗口之外，所以按概要的起步跨度
    // 补下载的段通常只有几天，直接整段一批（超限会按密度自动缩），少让用户点几次下载
    let span = repair ? Math.min(L.AUTO.MAX_SPAN, spanDays) : L.initialSpan(start >= earliestHistory);
    // 密度跟踪器：取最近几批的最大密度（密度会往上漂，保守些少重做），
    // 空批次不清除已知密度，只是逐步放宽上界。
    const density = L.makeDensityTracker();
    // 上一批用的上限，用来发现"跨进手牌 3 个月窗口"这种上限突变
    let lastCap = 0;
    let batchNo = 0;
    let syncedBatches = 0;
    // 防打转：上一次重做的日期段、连续重做同一段的次数、下一轮是否跳过按上限缩放
    let lastRedoRange = "";
    let sameRangeRedos = 0;
    let skipRescale = false;
    const MAX_SAME_RANGE_REDOS = 3;
    // 本次同步的标识，写进每条下载记录，方便核对时按"哪一次同步"分组
    const runId = (repair ? "repair " : "") + (GG_LEDGER ? GG_LEDGER.localIso(Date.now()) : String(Date.now()));

    // 水位线的含义是"到这一天为止全都同步完了"。
    // 一旦有批次失败，后面即使成功也不能再推进水位线，
    // 否则失败的那几天会被永久跳过，下次同步也补不回来。
    let contiguous = true;

    // 连续失败保护：元素找不到时游标照样往前推（否则死循环），
    // 但连着失败多次说明页面结构真的不对了，继续跑只会白白跳过数据。
    let failStreak = 0;
    const MAX_FAIL_STREAK = 3;
    // 游标不前进的重做（瞬时空表复查 / 超限缩小跨度）必须有上限，否则会死循环
    let redoCount = 0;
    const MAX_REDO = 2;
    // 列表加载超时（网络请求一直没结束）的连续次数。超时的 0 行不能当成"没数据"：
    // 线上见过 92 天的区间请求卡住 2 分钟、页面显示 0 行，扩展当成没打牌推进了同步记录，
    // 结果 7 个多月的数据一个没下。
    let loadTimeouts = 0;
    const MAX_LOAD_TIMEOUTS = 3;
    // 本次同步里判成"没数据"的日期段：之后若在列表里看到属于这些日期的比赛，说明当时是误判，要退回去重下
    const emptyRanges = [];
    let dateMismatches = 0;
    // 可疑的空结果（期间有请求失败，或超过 2 分钟才空）：只重查前一半日期来确认。
    // 确认那一遍空且没失败就接受（哪怕也慢——GG 慢的时候小区间也要一两分钟），
    // 只推进这一半；出现了数据就说明刚才是失败。不计入超时中止：真没打牌的分类
    // （现金桌、奥马哈常是整段空的）不能因为 GG 慢就每次都中止。
    let confirmingEmpty = false;
    let confirmFromDays = 0; // 触发重查的那一批有几天
    // 重查确认过"慢但确实空"的最长跨度：不超过它的慢速空结果不再重查
    // （GG 慢的时候整段没打牌的分类每批都又慢又空，每次都重查会把跨度一路缩到 1 天）。
    // 更长的跨度仍要先确认一次；重查一旦出现数据就作废。
    let trustedEmptySpan = 0;
    // 超过 2 分钟才出来的空结果才算可疑：GG 慢的时候 1～2 分钟很常见（线上 2 天的区间 107 秒），
    // 那样的空结果照常接受，否则整段没打牌的分类每批都要多加载一次；2 分钟以上在以前就算超时了，
    // 线上漏掉 2～9 月数据的正是这一类
    const EMPTY_TRUST_MS = 120000;

    // GG 真实的"一次最多能选多少场"。
    // 内置常量（概要 500 / 手牌按 2 万手折 100 场）只是估计，线上已证明会超限；
    // 一旦页面弹出超限提示，就从提示里把真实数字读出来。
    //
    // 学到的值要存起来跨轮次复用 —— 否则每次同步都得先撞一次错才知道，
    // 而撞错那一批还得重做，白白浪费时间。
    let learnedCap = await loadLearnedCap();
    if (learnedCap) log(`沿用上次学到的选中上限：${learnedCap} 条`, "limit");

    // 手牌窗口每批上限：有实时GTO 核对过的手数就按真实的算，否则按老估算
    const handsModel = await learnHandsPerRow(pageType);
    const historyCap = handsModel && handsModel.cap ? handsModel.cap : null;
    const baseCap = (inHistory) => (inHistory && historyCap ? historyCap : L.sessionCap(inHistory));
    // GG 列表加载速度（毫秒/行）：一批的行数控制在约 LOAD_TARGET_MS 能加载完
    let msPerRow = await loadLoadSpeed(pageType);
    // 一批至少装满一趟概要（500 行）：按速度缩批只为控制加载时长，不能因此多点下载
    const oneRound = () => (learnedCap ? Math.min(learnedCap, L.sessionCap(false)) : L.sessionCap(false));
    // 按速度算出的行数再取成整趟（500 的倍数）：560 行会分成两趟、每趟 280 条，反而多点一次
    const rowsForLoad = () => {
      if (!msPerRow) return L.AUTO.BATCH_TARGET_ROWS;
      const raw = Math.floor((L.AUTO.LOAD_TARGET_MS - L.AUTO.LOAD_OVERHEAD_MS) / msPerRow);
      if (raw >= L.AUTO.BATCH_TARGET_ROWS) return L.AUTO.BATCH_TARGET_ROWS;
      const round = Math.max(L.AUTO.LOAD_MIN_ROWS, oneRound());
      return Math.max(1, Math.floor(raw / round)) * round;
    };
    if (msPerRow) log(`按上次测到的加载速度（约 ${msPerRow} 毫秒/行），每批控制在约 ${rowsForLoad()} 行`, "clicks");
    // 上次量出来的密度：第一批直接按它把这一批装到接近上限
    const savedDensity = repair ? null : await loadDensity(pageType);
    if (savedDensity) {
      // effectiveCap 在后面才定义，这里直接套一下学到的选中上限
      const base = baseCap(start >= earliestHistory);
      const capStart = Math.min(
        Math.max(learnedCap ? Math.min(learnedCap, base) : base, L.AUTO.BATCH_TARGET_ROWS),
        rowsForLoad(),
      );
      const fit = Math.max(
        L.AUTO.MIN_SPAN,
        Math.min(L.AUTO.MAX_SPAN, Math.floor((capStart * L.AUTO.DENSITY_SAFETY) / savedDensity.rate)),
      );
      if (fit > span) {
        log(`按上次的密度（约 ${savedDensity.rate} 行/天）起步跨度从 ${span} 天放大到 ${fit} 天`, "clicks");
        span = fit;
      }
    } else if (!repair && historyCap && start >= earliestHistory) {
      // 从手牌窗口里开始的同步：上限放宽了多少倍，起步跨度也放大多少倍（超了只是重做，不多点）
      const scaled = Math.min(L.AUTO.MAX_SPAN, Math.round((span * historyCap) / L.sessionCap(true)));
      if (scaled > span) {
        log(`手牌窗口上限放宽到 ${historyCap} 行，起步跨度从 ${span} 天放大到 ${scaled} 天`, "clicks");
        span = scaled;
      }
    }
    if (runStats) {
      runStats.currentMode = repair ? "repair" : "sync";
      if (!runStats.capModel) runStats.capModel = handsModel;
    }
    if (!repair) {
      log(
        historyCap
          ? `手牌窗口每批上限 ${historyCap} 行：按实时GTO 核对的 ${handsModel.samples} 次下载，` +
              `每行平均 ${handsModel.mean} 手、偏高估计 ${handsModel.handsPerRow} 手，一次 2 万手留 10% 余量`
          : `手牌窗口每批上限 ${L.sessionCap(true)} 行（按每行 ${L.AUTO.HANDS_PER_SESSION_ESTIMATE} 手估算；` +
              `实时GTO 核对满 ${HANDS_MODEL_MIN_SAMPLES} 次后会按真实手数放宽，现在 ${handsModel ? handsModel.samples : 0} 次）`,
        "clicks",
      );
    }

    const effectiveCap = (fallback) => (learnedCap ? Math.min(learnedCap, fallback) : fallback);
    // 批次大小瞄准的行数：超过单次上限的批次按行分趟下，所以瞄准 BATCH_TARGET_ROWS（的 95%），
    // 不再瞄准单次上限（那样每批都装不满，稍一超就要缩日期重做）
    // 再受加载速度限制：GG 慢的时候一批少一些行，列表不会等太久
    const sizeCapFor = (c) => Math.min(Math.max(c, L.AUTO.BATCH_TARGET_ROWS), rowsForLoad());
    // 分趟时一趟最多勾多少行：概要按钮的上限（学到的更小就用学到的）
    const roundRows = () => effectiveCap(L.sessionCap(false));

    const rememberCap = async (value) => {
      if (!value || value < 1) return;
      if (learnedCap && learnedCap <= value) return;
      learnedCap = value;
      await saveLearnedCap(value);
    };

    // 批次流水账：每一批都记下它做了什么、推进没有、为什么。
    // "怎么会没点下载就跳过去了"这类问题，光看散落的日志很难还原，
    // 跑完一张表就能直接看出哪一批 committed=false / 没弹下载提示。
    const journal = [];
    const dumpJournal = () => {
      if (!journal.length) return;
      console.log("%c[GGPoker助手] 本次同步流水账", "color:#2563eb;font-weight:bold");
      console.table(journal);
      chrome.storage.local.set({ ggSyncJournal: { at: Date.now(), pageType, journal } });
    };
    let rulesRetried = false; // 一轮同步里只自动拉一次规则，避免反复打服务器
    const bailOnFailure = async () => {
      failStreak++;
      contiguous = false; // 断了，后面不能再推进水位线
      if (failStreak < MAX_FAIL_STREAK) return false;

      // 连续失败通常意味着 GG 改版、当前选择器全失效。
      // 中止之前先去拉一份最新解析规则试试 —— 这正是规则可远程更新的意义。
      if (!rulesRetried) {
        rulesRetried = true;
        logWarning(`连续 ${failStreak} 批失败，尝试更新解析规则后重试`, "loopDownload");
        if (await tryUpdateRules()) {
          const ok = await D.waitFor(() => !D.rulesLookBroken(), 10000, 500);
          if (ok) {
            logSuccess("新规则已生效，继续同步", "loopDownload");
            failStreak = 0;
            return false; // 不中止，用新规则接着跑
          }
          logWarning("新规则仍然识别不了页面", "loopDownload");
        }
      }

      logError(
        `连续 ${failStreak} 批都没能操作页面，已中止。` +
          `请刷新 PokerCraft 页面重试；若仍失败，把控制台的自检表发给开发者。`,
        "loopDownload",
      );
      currentStatus.isRunning = false;
      return true;
    };

    if (repair) {
      logSuccess(
        `补下载 ${plan.from} ~ ${plan.to}（${spanDays} 天，只下` +
          `${[wantSummary && plan.hasSummary ? "游戏概要" : "", wantHistory ? "手牌历史" : ""].filter(Boolean).join("+")}），` +
          `不改动同步进度`,
        "repair",
      );
    } else
      log(
        `${plan.resumed ? `接着上次（${saved.lastSyncedDate}）继续` : "首次同步"}：` +
          `${plan.from} ~ ${plan.to}（共 ${spanDays} 天，起步跨度 ${span} 天）；` +
          `手牌详情仅覆盖 ${L.fmt(earliestHistory)} 之后`,
        "loopDownload",
      );

    currentStatus.totalRounds = spanDays; // 进度分母 = 总天数
    currentStatus.currentRound = 0;
    currentStatus.totalDays = spanDays;
    currentStatus.syncFrom = plan.from;
    currentStatus.syncTo = plan.to;
    updateStatus("info", `准备同步 ${plan.from} ~ ${plan.to}，共 ${spanDays} 天`);

    // 游标从最早的那天往后走。
    // 方向很重要：GG 的窗口是滑动的，最早那几天随时会过期，先抓快过期的；
    // 而且中途断了水位线也只停在"已完成的最后一天"，下次接着往后补即可。
    let cursorStart = new Date(start);
    // 跨度上限：第一批 FIRST_SPAN_MAX，之后每批最多翻倍；加载超时就减半
    let spanCeiling = L.AUTO.FIRST_SPAN_MAX;
    // 加载超时过的最短跨度：之后放大不超过它的 60%，免得再撞一次
    let slowSpan = Infinity;

    while (cursorStart <= end) {
      // 本批的日期边界和推进函数放在 try 外面。
      // 放里面的话，try 头部一旦抛异常，catch 里调用 advance() 会是 ReferenceError，
      // 游标永远不动 —— 死循环。
      batchNo++;
      const roundStart = new Date(cursorStart);
      if (span > spanCeiling) {
        log(
          `跨度 ${span} 天超过上限（第一批最多 ${L.AUTO.FIRST_SPAN_MAX} 天、每批最多翻倍、不超过超时过的跨度），这批先用 ${spanCeiling} 天`,
          "loopDownload",
        );
        span = spanCeiling;
      }
      // 批次不跨手牌窗口的边界：从边界之前开始的，最多截到边界前一天（这一批只下概要），
      // 下一批从边界开始。跨边界的批次上限只有手牌窗口那么小，还得点两次下载；
      // 更要命的是边界两侧上限不同，跨度会被来回放大缩小，线上出现过同一段日期无限重做。
      const boundaryEnd = roundStart < earliestHistory ? new Date(earliestHistory.getTime() - L.MS_PER_DAY) : null;
      const endFor = (sp) => {
        const e = new Date(roundStart.getTime() + (sp - 1) * L.MS_PER_DAY);
        if (e > end) e.setTime(end.getTime());
        if (boundaryEnd && e > boundaryEnd) e.setTime(boundaryEnd.getTime());
        return e;
      };
      // 本批是否落在手牌详情的 3 个月窗口里，决定用哪个条数上限
      const capFor = (e) => effectiveCap(baseCap(e >= earliestHistory));

      // 进入手牌窗口时上限会变小，沿用原跨度必然超限重做，所以在定下本批日期之前先按比例缩小。
      // 只往小调：上限变大时往大调交给密度跟踪器 —— 往大调曾和"超限缩小"来回打架，死循环。
      const tentativeCap = sizeCapFor(capFor(endFor(span)));
      if (lastCap && tentativeCap < lastCap && !skipRescale) {
        const rescaled = L.rescaleSpanForCap(span, lastCap, tentativeCap);
        if (rescaled < span) {
          log(`上限从 ${lastCap} 变成 ${tentativeCap}，跨度先按比例从 ${span} 天调到 ${rescaled} 天`, "loopDownload");
          span = rescaled;
        }
      }
      skipRescale = false;

      let roundEnd = endFor(span);
      // 兜底：同一段日期连续重做太多次，说明跨度计算在打转，强制折半，保证一定往下走
      const rangeKey = `${L.fmt(roundStart)}~${L.fmt(roundEnd)}`;
      sameRangeRedos = rangeKey === lastRedoRange ? sameRangeRedos + 1 : 0;
      if (sameRangeRedos >= MAX_SAME_RANGE_REDOS) {
        const days = L.diffDays(roundEnd, roundStart) + 1;
        const halved = Math.max(L.AUTO.MIN_SPAN, Math.floor(days / 2));
        logWarning(
          `${rangeKey} 已连续重做 ${sameRangeRedos} 次，跨度计算异常，强制折半到 ${halved} 天`,
          "loopDownload",
        );
        span = halved;
        roundEnd = endFor(span);
        sameRangeRedos = 0;
      }
      const startStr = L.fmt(roundStart);
      const endStr = L.fmt(roundEnd);
      const batchDays = L.diffDays(roundEnd, roundStart) + 1;
      const inHistoryWindow = roundEnd >= earliestHistory;
      const cap = capFor(roundEnd);
      if (runStats) {
        runStats.currentCap = cap;
        runStats.currentInHistory = roundEnd >= earliestHistory;
      }
      // 跨度由密度跟踪器在每批结束时给出（suggestSpan），这里只处理上限突变。
      // 目标是每批尽量装满到上限，让用户少点几次下载 —— 重做只花加载时间，
      // 点击是用户的时间。
      lastCap = sizeCapFor(cap);
      const sizeCap = sizeCapFor(cap);

      // 循环条件是游标位置，所以任何 continue 之前都必须先推进游标，
      // 否则会死循环卡在同一段日期上（缩小跨度重试是唯一例外）。
      let advanced = false;
      let committedThisBatch = false;
      let batchRows = 0;
      let batchSummary = 0;
      let batchHistory = 0;

      // 下载记录的公共部分。rows 在判空/全选之后才知道，所以每次现取。
      const batchRec = () => ({
        mode: repair ? "repair" : "sync",
        runId,
        batch: batchNo,
        pageType,
        from: startStr,
        to: endStr,
        rows: batchRows || null,
        summaryFrom: L.fmt(earliestSummary),
        historyFrom: L.fmt(earliestHistory),
      });
      // 这一批按 GG 的限制"应该有"哪几类数据：概要只有 MTT 有且回溯 12 个月，手牌只回溯 3 个月
      const expectedKinds = () => {
        const kinds = [];
        if (wantSummary && currentPageConfig().hasSummary && roundEnd >= earliestSummary) kinds.push("summary");
        if (wantHistory && roundEnd >= earliestHistory) kinds.push("history");
        return kinds;
      };
      // 流水账结局 -> 下载记录状态。点了下载的那几条已在 promptDownload 里记过；
      // 这里补"确认没数据"和"没下成"两种，核对时才能区分"本来就没有"和"漏了"。
      const LEDGER_STATUS = { 无数据: "no_data", 失败: "failed", 未下载: "failed", 异常: "failed", 中止: "failed" };

      /**
       * 写一条流水账。status 说明这批的结局，note 说明原因。
       * opts.kinds 只记这几类没下成；opts.chunk 表示分趟下到一半失败 —— 记录标成分趟的，
       * 同一批已经下完的那几趟就不会把它"覆盖"掉（日期完全一样），核对时照样补这一批。
       */
      const record = (status, note, opts = {}) => {
        statBatch(status, note, batchDays);
        const ledgerStatus = LEDGER_STATUS[status];
        if (ledgerStatus) {
          const kinds = expectedKinds().filter((k) => !opts.kinds || opts.kinds.includes(k));
          for (const kind of kinds) {
            recordLedger(
              batchRec(),
              kind,
              ledgerStatus,
              Object.assign({ note: note || status }, opts.chunk ? { chunk: "未完成" } : {}),
            );
          }
        }
        const entry = {
          批次: batchNo,
          区间: `${startStr} ~ ${endStr}`,
          天数: batchDays,
          行数: batchRows,
          概要: batchSummary,
          手牌: batchHistory,
          结局: status,
          已推进水位线: committedThisBatch,
          说明: note || "",
        };
        journal.push(entry);
        const fn = committedThisBatch ? log : logWarning;
        fn(
          `批次 ${batchNo} 结束 [${status}]：${startStr} ~ ${endStr}，` +
            `${batchRows} 行 / 概要 ${batchSummary} / 手牌 ${batchHistory}，` +
            `水位线${committedThisBatch ? "已推进" : "未推进"}${note ? "（" + note + "）" : ""}`,
          "batch",
        );
      };

      /** 结束本批并把游标推到下一段。status/note 会进流水账。 */
      const advance = (status, note, opts) => {
        if (advanced) return;
        advanced = true;
        if (status) record(status, note, opts);
        redoCount = 0; // 这一段过去了，重做计数清零
        doneDays += batchDays;
        currentStatus.currentRound = Math.min(doneDays, spanDays);
        currentStatus.doneDays = doneDays;
        cursorStart = new Date(roundEnd.getTime() + L.MS_PER_DAY);
      };

      /** 游标不动、原样重来（缩小跨度 / 瞬时空表复查），也要留痕。 */
      const redo = (status, note) => {
        lastRedoRange = `${startStr}~${endStr}`;
        skipRescale = true; // 刚按密度定过跨度，下一轮别再按上限比例改它
        record(status, note);
      };

      /** 中途被用户停止。也要写进流水账，否则"停在哪一批"完全看不出来。 */
      const stopNow = () => {
        record("已停止", "用户点了停止，本批未完成");
        updateStatus("warning", `同步已停止（停在 ${startStr} ~ ${endStr}）`);
        dumpJournal();
      };

      // 只在这一批真的走完下载流程后才推进水位线。
      // 失败/跳过的批次绝不能推进 —— 否则下次同步会从它后面开始，
      // 这几天就被永久漏掉了。
      // downloaded：这一批是否真的下载了数据（无数据批次只推进水位线，不算数据同步）
      const commit = async (downloaded) => {
        syncedBatches++;
        // 补下载补的是水位线以内的旧日期，水位线本来就在它后面，不能动
        if (repair) return;
        if (!contiguous) {
          logWarning(`本批成功但前面有批次失败，暂不推进同步记录（仍停在失败点之前）`, "loopDownload");
          return;
        }
        await GG_SYNC.advance(pageType, endStr, { batches: 1, days: batchDays, downloaded: !!downloaded });
        currentStatus.lastSyncedDate = endStr;
        committedThisBatch = true;
        log(`同步记录已推进到 ${endStr}`, "loopDownload");
      };

      try {
        if (stopFlag) {
          stopNow();
          return;
        }
        await waitIfPaused();

        // 开工前先清障：上一批要是触发了"下载限制"弹窗，它带遮罩挡住整页，
        // 不关掉的话本批连日期下拉都点不开。
        await dismissLimitDialog("批次开始前");

        log(
          `第 ${batchNo} 批: ${startStr} ~ ${endStr}（${batchDays} 天，` +
            `${inHistoryWindow ? "概要+手牌" : "仅概要"}，本批上限 ${cap} 场）`,
          "loopDownload",
        );
        currentStatus.currentSpan = batchDays;
        updateStatus("info", `第 ${batchNo} 批 ${startStr} ~ ${endStr}（${doneDays}/${spanDays} 天）`);

        // 超出 12 个月就没必要再往前跑了
        if (roundEnd < earliestSummary) {
          log(`${endStr} 已超出 ${L.SUMMARY_MONTHS} 个月范围，结束`, "loopDownload");
          break;
        }

        // 1. 展开“日期”下拉列表
        const dateSelect = D.findDateSelect();
        if (!dateSelect) {
          logStepFailure("未找到日期下拉列表(mat-select)");
          if (await bailOnFailure()) {
            record("中止", "未找到日期下拉");
            dumpJournal();
            return;
          }
          advance("失败", "未找到日期下拉列表");
          continue;
        }
        log(`找到日期下拉: ${describeEl(dateSelect)}`, "loopDownload");
        log("点击日期下拉列表...", "loopDownload");
        // mat-select 的 click 绑在内部 trigger 上，点宿主元素不一定生效
        await simulateHumanClick(D.selectTrigger(dateSelect));
        // 等面板真的渲染出来（cdk-overlay 是异步插入的）
        const opened = await D.waitFor(() => D.listOpenOptions().length > 0, 6000);
        if (!opened) {
          logStepFailure("点击后日期下拉面板没有打开", {
            "aria-expanded": dateSelect.getAttribute("aria-expanded"),
            "overlay 容器数": document.querySelectorAll(".cdk-overlay-container").length,
          });
          if (await bailOnFailure()) {
            record("中止", "日期下拉没打开");
            dumpJournal();
            return;
          }
          advance("失败", "点击后日期下拉面板没有打开");
          continue;
        }
        log(
          `下拉面板已展开，共 ${D.listOpenOptions().length} 个选项: ` +
            D.listOpenOptions()
              .map((o) => o.textContent.trim())
              .join(" | "),
          "loopDownload",
        );
        if (stopFlag) {
          stopNow();
          return;
        }
        await waitIfPaused();

        // 2. 选择“定制范围”。
        // 旧代码写死 #mat-option-5，而 mat-option 的 id 是全局自增的，
        // 页面上有几个下拉、渲染顺序怎么样都会让这个序号变，所以改成按文案找。
        const customRangeOption = D.findCustomRangeOption();
        if (!customRangeOption) {
          logStepFailure('未找到"定制范围"选项', {
            实际选项: D.listOpenOptions().map((o) => o.textContent.trim()),
          });
          D.closeOverlay();
          if (await bailOnFailure()) {
            record("中止", "未找到定制范围");
            dumpJournal();
            return;
          }
          advance("失败", '未找到"定制范围"选项');
          continue;
        }
        log(`找到定制范围选项（${customRangeOption.textContent.trim()}），准备点击...`, "loopDownload");
        await simulateHumanClick(customRangeOption);
        await wait(randomBetween(1200, 2400));
        if (stopFlag) {
          stopNow();
          return;
        }
        await waitIfPaused();

        // 3. 输入开始日期和结束日期
        log(`输入日期范围：${startStr} - ${endStr}`, "loopDownload");
        const dateRangeSuccess = await setDateRange(startStr, endStr);
        if (!dateRangeSuccess) {
          logStepFailure(`设置日期范围失败 (${startStr} ~ ${endStr})`);
          D.closeOverlay();
          if (await bailOnFailure()) {
            record("中止", "日期范围设置失败");
            dumpJournal();
            return;
          }
          advance("失败", "日期范围没能写进筛选框");
          continue;
        }
        await wait(randomBetween(800, 1600));
        if (stopFlag) {
          stopNow();
          return;
        }
        await waitIfPaused();

        // 4. 点击"显示"按钮
        const showButton = D.findShowButton();
        if (!showButton) {
          logStepFailure('未找到"显示"按钮');
          if (await bailOnFailure()) {
            record("中止", "未找到显示按钮");
            dumpJournal();
            return;
          }
          advance("失败", '未找到"显示"按钮');
          continue;
        }
        // 点之前记一份表格指纹和网络计数快照。
        // 网络快照必须在点击之前取 —— 请求是在点击处理里同步发出的，
        // 点完再取就已经涨过了，"有没有新请求"永远判成"无"。
        const fpBefore = D.tableFingerprint();
        const netBefore = D.netState();
        log(`找到显示按钮 ${describeEl(showButton)}，准备点击...`, "loopDownload");
        const showClickedAt = Date.now();
        await simulateHumanClick(showButton);

        // 5. 等列表真正稳定下来。
        //
        // 这里有个很容易踩的坑：点完"显示"后 Angular 会先清空 tbody 再填新数据，
        // 中间那一瞬间表是空的。只要在那个窗口里取快照，就会既判成"表格变了"
        // （空表指纹 "empty" 当然不等于旧指纹），又判成"没有数据" ——
        // 结果是不提示下载直接 commit + advance，那几天被当成已同步永久跳过。
        //
        // 所以不能看"变了没"，要看"稳了没"：连续几次采样指纹一致、且转圈已停，
        // 才认为这一批的数据真的加载完了。
        log("等待数据加载...", "loopDownload");
        const settle = await waitForTableSettled(fpBefore, netBefore);
        // 调整下一批的跨度上限：超时就减半并记住；否则允许比这批最多大一倍
        {
          const secs = Math.round((Date.now() - showClickedAt) / 1000);
          if (!settle.stable) {
            slowSpan = Math.min(slowSpan, batchDays);
            spanCeiling = Math.max(L.AUTO.MIN_SPAN, Math.floor(batchDays / 2));
            logWarning(
              `列表加载 ${secs} 秒仍没结束（${batchDays} 天），之后每批最多 ${spanCeiling} 天`,
              "loopDownload",
            );
          } else {
            spanCeiling = Math.max(
              L.AUTO.MIN_SPAN,
              Math.min(L.AUTO.MAX_SPAN, Math.max(spanCeiling, batchDays * 2), Math.floor(slowSpan * 0.6)),
            );
            log(`列表加载用了 ${secs} 秒（${batchDays} 天，${settle.rows} 行）`, "loopDownload");
            // 按这次的"每行多少毫秒"更新加载速度，下一批的行数据此控制在约 1 分钟能加载完
            // 排过队的加载不拿来估速度（等的是 GG 打包文件，不是列表本身）
            if (settle.rows >= L.AUTO.LOAD_SAMPLE_MIN_ROWS && !(settle.queuedMs > 0)) {
              const loadMs = Date.now() - showClickedAt - (settle.queuedMs || 0);
              const per = Math.max(1, loadMs - L.AUTO.LOAD_OVERHEAD_MS) / settle.rows;
              const before = rowsForLoad();
              msPerRow = msPerRow ? msPerRow * 0.5 + per * 0.5 : per;
              if (!repair) saveLoadSpeed(pageType, msPerRow);
              const after = rowsForLoad();
              if (Math.abs(after - before) > before * 0.1) {
                (after < before ? logWarning : log)(
                  `GG 加载速度约 ${Math.round(msPerRow)} 毫秒/行，之后每批控制在约 ${after} 行（约 ${Math.round(L.AUTO.LOAD_TARGET_MS / 1000)} 秒能加载完）`,
                  "loopDownload",
                );
              }
            }
          }
        }
        log(
          `列表已稳定：${settle.rows} 行（${settle.changed ? "内容已更新" : "与上一批相同"}` +
            `${settle.stable ? "" : "，等待超时"}）`,
          "loopDownload",
        );
        // "内容没变"只在上一批有数据时才值得警告。
        // 连续空批次的指纹都是 "empty"，changed 必然是 false，
        // 但"空→空"完全不能说明筛选没生效 —— 那只是这两段都没打牌。
        if (!settle.changed && fpBefore !== "empty" && settle.rows > 0) {
          logWarning("表格内容与点击前完全一致，筛选可能没生效", "loopDownload");
        }

        // 6. 判断这一批有没有数据。
        // 只看表格行数，不看下载按钮上的数字 —— 那个数字是"已勾选的场次数"，
        // 全选之前恒为 0。旧代码遍历所有 div 找 "没有数据"，顶层容器的
        // textContent 含整页文字，基本每批都会误判成空直接跳过。
        // 5.5 确认筛选真的按我们设的日期生效了。
        //
        // 线上见过：7 天的区间和 3 天的区间都返回 189 行，而单独查里面某一天是 0 行 ——
        // 说明有时日期没写进去，我们拿着上一批的结果在做决策（还会据此错误地缩跨度）。
        const applied = verifyFilterApplied(roundStart, roundEnd);
        if (!applied.ok) {
          filterRetries++;
          logWarning(
            `筛选框显示的是 ${applied.shown || "(空)"}，不是本批的 ${startStr} ~ ${endStr}` +
              `（第 ${filterRetries} 次）`,
            "loopDownload",
          );
          if (filterRetries <= MAX_FILTER_RETRY) {
            redo("重做", `日期筛选未生效（显示 ${applied.shown || "空"}）`);
            continue; // 不 advance：同一段日期重新设一次
          }
          logStepFailure(`日期筛选连续 ${filterRetries} 次没生效，本批放弃（不推进同步记录）`);
          if (await bailOnFailure()) {
            record("中止", "日期筛选始终不生效");
            dumpJournal();
            return;
          }
          advance("失败", "日期筛选未生效");
          continue;
        }
        filterRetries = 0;

        // 5.6 网络请求没结束、列表又是空的：是加载失败，不是没数据。
        //     缩小日期跨度重试（区间太大时 GG 的请求可能卡住）；连续几次都这样就停下，
        //     绝不推进同步记录。
        if (settle.viaNetwork && !settle.stable && settle.rows === 0 && D.countRows() === 0) {
          loadTimeouts++;
          if (loadTimeouts >= MAX_LOAD_TIMEOUTS) {
            const message =
              `GG 列表连续 ${loadTimeouts} 次加载超时（网络请求一直没结束），已停止同步，` +
              `同步记录停在 ${startStr} 之前，没下的日期一天都没有跳过。请刷新 PokerCraft 页面后再点开始同步。`;
            logStepFailure(message);
            contiguous = false;
            record("中止", "列表连续加载超时");
            dumpJournal();
            loopAbortMessage = message;
            return;
          }
          const smaller = Math.max(L.AUTO.MIN_SPAN, Math.floor(span / 2));
          logWarning(
            `${startStr} ~ ${endStr} 列表加载超时、显示 0 行 —— 不能当成没数据；` +
              `第 ${loadTimeouts} 次，跨度从 ${span} 天缩到 ${smaller} 天重试`,
            "loopDownload",
          );
          span = smaller;
          redo("重做", `列表加载超时，跨度缩到 ${smaller} 天`);
          continue; // 不 advance、不 commit
        }
        if (settle.stable) loadTimeouts = 0;

        // 5.7 列表里的比赛日期必须落在本批日期内（允许前后各 1 天的时区误差）。
        //     线上：06-05~06-27 显示 0 行被判成没数据，下一批 06-28~07-24 却列出了 6 月 6~22 日的 425 场——
        //     列表和筛选对不上（上一次查询的结果晚到了，或者日期没生效），照着下载会把数据记错日期，
        //     还会把真正的 06-28~07-24 当成已下完。
        if (settle.rows > 0) {
          const dates = D.rowDates(roundStart);
          const lo = roundStart.getTime() - L.MS_PER_DAY;
          const hi = roundEnd.getTime() + 2 * L.MS_PER_DAY;
          const outside = dates.filter((d) => d.getTime() < lo || d.getTime() >= hi);
          // 少数几行在范围外（多日赛、时区）不算：超过一半才说明列表和筛选对不上
          if (outside.length && outside.length * 2 < dates.length) {
            log(
              `有 ${outside.length}/${dates.length} 行的日期略超出本批范围（多日赛或时区），照常下载`,
              "loopDownload",
            );
          }
          if (dates.length && outside.length * 2 >= dates.length) {
            const ms = dates.map((d) => d.getTime());
            const minD = new Date(Math.min(...ms)),
              maxD = new Date(Math.max(...ms));
            dateMismatches++;
            logWarning(
              `列表里是 ${L.fmt(minD)} ~ ${L.fmt(maxD)} 的比赛（${outside.length}/${dates.length} 行不在本批日期内），` +
                `不是本批的 ${startStr} ~ ${endStr}：筛选没生效或上一次查询的结果晚到了，不能下载`,
              "loopDownload",
            );
            // 这些比赛属于本次同步里判成"没数据"的某一段：当时是误判，退回那一段重下
            const hit = emptyRanges.find(
              (r) =>
                r.start.getTime() <= maxD.getTime() + L.MS_PER_DAY && r.end.getTime() >= minD.getTime() - L.MS_PER_DAY,
            );
            if (hit) {
              const back = new Date(hit.start.getTime() - L.MS_PER_DAY);
              logWarning(
                `${hit.from} ~ ${hit.to} 之前被判成没数据，其实有对局：同步记录退回到 ${L.fmt(back)}，从 ${hit.from} 重新下`,
                "loopDownload",
              );
              if (!repair) await GG_SYNC.rewind(pageType, L.fmt(back));
              emptyRanges.splice(emptyRanges.indexOf(hit));
              doneDays = Math.max(0, doneDays - L.diffDays(roundStart, hit.start));
              cursorStart = new Date(hit.start);
              dateMismatches = 0;
              redo("重做", `误判为没数据的 ${hit.from} ~ ${hit.to} 其实有对局，退回重下`);
              continue;
            }
            if (dateMismatches <= MAX_FILTER_RETRY) {
              redo("重做", `列表日期（${L.fmt(minD)} ~ ${L.fmt(maxD)}）和本批对不上`);
              continue; // 不 advance：重新设日期、重新加载
            }
            logStepFailure(`列表日期连续 ${dateMismatches} 次和本批对不上，本批放弃（不推进同步记录）`);
            if (await bailOnFailure()) {
              record("中止", "列表日期始终对不上");
              dumpJournal();
              return;
            }
            advance("失败", "列表日期和筛选对不上");
            continue;
          }
          dateMismatches = 0;
        }

        let rowCount = settle.rows;
        log(
          `本批列表 ${rowCount} 行` +
            (settle.viaNetwork ? "（网络请求已结束、DOM 已稳定）" : "") +
            (settle.emptyDwellMs ? `（已连续空 ${Math.round(settle.emptyDwellMs / 1000)} 秒）` : ""),
          "loopDownload",
        );

        if (rowCount === 0) {
          // 判空是唯一一条"不下载也推进水位线"的路径，误判代价是永久丢数据。
          // waitForTableSettled 已经要求连续空满 8 秒，这里再抓最后一次机会：
          // 万一这会儿数据到了，直接用新行数往下走 —— 不要像以前那样丢掉重做，
          // 重做只会在同一个空窗期上反复踩，线上就是这么连着失败三次的。
          // 线上见过：网络请求结束、DOM 也安静了，数据却又晚到了一步（0 行 -> 2 秒后 789 行）。
          // 所以判空前再给最多 8 秒，期间一出现数据就立刻继续，真没数据才等满。
          // 空批次跨度会自动翻倍，数量不多，多等这几秒很划算。
          await D.waitFor(() => D.countRows() > 0, EMPTY_CONFIRM_MS, 250);
          await D.waitFor(() => D.netState().inflight === 0, 5000, 200);
          const recheck = D.countRows();
          if (recheck > 0) {
            logWarning(`判空后复查又出现 ${recheck} 行，按有数据继续（说明页面加载比预期还慢）`, "loopDownload");
            rowCount = recheck;
          } else if (D.isLoading()) {
            redoCount++;
            if (redoCount > MAX_REDO) {
              logStepFailure(`连续 ${redoCount} 次复查时仍在加载，本批放弃（不推进同步记录）`);
              if (await bailOnFailure()) {
                record("中止", "始终处于加载中");
                dumpJournal();
                return;
              }
              advance("失败", "复查时页面仍在加载");
              continue;
            }
            logWarning(`复查时页面仍在加载，第 ${redoCount} 次重做本批`, "loopDownload");
            redo("重做", "复查时页面仍在加载");
            continue; // 不 advance、不 commit，原样重来
          } else if (
            settle.viaNetwork &&
            (batchDays > 1 || !confirmingEmpty) &&
            (settle.failed ||
              (!confirmingEmpty &&
                batchDays > trustedEmptySpan &&
                Date.now() - showClickedAt - (settle.queuedMs || 0) > EMPTY_TRUST_MS))
          ) {
            // 空结果可疑：请求失败了，或者等了很久才空。只重查前一半，确认了再推进
            const half = Math.max(L.AUTO.MIN_SPAN, Math.floor(batchDays / 2));
            logWarning(
              `${startStr} ~ ${endStr} 显示 0 行，但${settle.failed ? "期间有请求失败" : `加载用了 ${Math.round((Date.now() - showClickedAt - (settle.queuedMs || 0)) / 1000)} 秒`}，` +
                `不能直接当成没数据；先重查前 ${half} 天确认`,
              "loopDownload",
            );
            confirmingEmpty = true;
            confirmFromDays = batchDays;
            span = half;
            // 请求失败是实打实的信号：记住这个跨度出过问题，之后放大不超过它的 60%
            //（只是慢不算——要等重查结果才知道）
            if (settle.failed) {
              slowSpan = Math.min(slowSpan, batchDays);
              spanCeiling = Math.min(spanCeiling, half);
            }
            redo("重做", `空结果可疑，重查前 ${half} 天`);
            continue; // 不 advance、不 commit
          } else {
            if (confirmingEmpty) {
              // 重查也空、请求也没失败：GG 只是慢。这么长的跨度，之后慢速空结果就不再重查
              if (!settle.failed) trustedEmptySpan = Math.max(trustedEmptySpan, confirmFromDays);
              log(
                `${startStr} ~ ${endStr} 重查确认没有数据（GG 只是慢；不超过 ${trustedEmptySpan} 天的慢速空结果之后直接接受）`,
                "loopDownload",
              );
            }
            confirmingEmpty = false;
            emptyRanges.push({ from: startStr, to: endStr, start: new Date(roundStart), end: new Date(roundEnd) });
            // 连续空 8 秒 + 复查仍空：这几天确实没打牌
            log(
              `${startStr} ~ ${endStr} 确认没有数据` +
                (settle.viaNetwork
                  ? "（网络请求已结束 + 复查）"
                  : `（空窗 ${Math.round((settle.emptyDwellMs || 0) / 1000)}s + 复查）`),
              "loopDownload",
            );
            failStreak = 0; // 没数据是正常情况，不算失败
            batchRows = 0;

            // 空批次最该放大跨度：一片没打牌的日期用 14 天一批地爬太慢。
            // 之前这里直接 continue 了，压根走不到下面的 grow 分支，
            // 所以连着 8 个空批次全是 14 天，白白多跑好几轮。
            // 空批次只记一笔"空"，不清除已知密度 ——
            // 之前一遇到空批次就把密度清零、跨度弹回 31 天，下一批必然再撞一次。
            density.observe(0, batchDays);
            // 空批次多半处在"这段时间没打牌"的死区，直接翻倍快速跳过。
            // 已知密度留着不清除 —— 之前一清零就会在数据重新出现时又撞一次上限。
            const next = density.suggestSpan(sizeCap, span, true);
            if (next > span) {
              log(`空批次（已连空 ${density.emptyStreak} 批），跨度 ${span} 天 -> ${next} 天`, "loopDownload");
              span = next;
            }

            await commit(false);
            advance("无数据", "这几天没有对局记录，无需下载");
            continue;
          }
        }
        batchRows = rowCount;
        if (confirmingEmpty) {
          logWarning(`重查出现 ${rowCount} 行：刚才的空结果其实是加载失败，幸好没有跳过`, "loopDownload");
          confirmingEmpty = false;
          // 慢速空结果会骗人：作废信任，并记住那个跨度出过问题
          trustedEmptySpan = 0;
          slowSpan = Math.min(slowSpan, confirmFromDays);
          spanCeiling = Math.min(spanCeiling, Math.max(L.AUTO.MIN_SPAN, Math.floor(confirmFromDays * 0.6)));
        }

        // 按已知密度重新定下一批的跨度（可大可小），瞄准每批约 BATCH_TARGET_ROWS 的 95%
        const resizeAfterBatch = () => {
          // 用最新的加载速度（这一批刚测过）
          const target = sizeCapFor(cap);
          const suggested = density.suggestSpan(target, span, false);
          if (suggested !== span) {
            log(
              `按密度（约 ${density.rate.toFixed(1)} 行/天）把跨度从 ${span} 天调到 ${suggested} 天` +
                `（目标每批约 ${Math.round(target * L.AUTO.DENSITY_SAFETY)} 行）`,
              "loopDownload",
            );
            span = suggested;
          }
        };
        // 本批超过单次下载上限：按行分几趟下完。返回 true 表示整个同步要结束（停止或连续失败）
        const chunkBatch = async (capHint) => {
          const ok = await downloadInChunks(capHint, startStr, endStr, inHistoryWindow, batchRec(), {
            wantSummary,
            wantHistory,
            maxRows: roundRows(),
          });
          if (!ok) {
            if (stopFlag) {
              stopNow();
              return true;
            }
            contiguous = false;
            const failed = { kinds: chunkFailedKinds, chunk: true };
            if (await bailOnFailure()) {
              record("中止", "分趟下载异常", failed);
              dumpJournal();
              return true;
            }
            advance("未下载", `分趟下载未完成（上限 ${capHint}）`, failed);
            return false;
          }
          failStreak = 0;
          density.observe(rowCount, batchDays);
          await commit(true);
          advance("完成", `${rowCount} 行超过单次上限，已分趟下载`);
          resizeAfterBatch();
          return false;
        };

        if (stopFlag) {
          stopNow();
          return;
        }
        await waitIfPaused();

        // 6.5 先按行数判断会不会超限 —— 别等选完被 GG 拦下来。
        //
        // 一旦选中数超过上限，GG 会弹出带遮罩的"下载限制"模态框，
        // 用户点不到下载按钮，插件也点不到任何元素，整个流程就卡死了。
        // 行数在选之前就知道，所以超限的批次压根不要去全选。
        if (rowCount > cap) {
          const perDay = rowCount / batchDays;

          // 不缩日期重做：列表已经加载出来了，按行分几趟下完（省一次一两分钟的重新加载）
          log(
            `本批 ${rowCount} 行（约 ${perDay.toFixed(1)} 行/天）超过单次下载上限 ${cap}，直接分趟下载`,
            "loopDownload",
          );
          if (await chunkBatch(cap)) return;
          continue;
        }

        // 7. 全选，并确认真的选上了。
        //
        // 不能点完就走：元素可能在 Angular 重渲染后游离，点了毫无效果；
        // 判断依据是下载按钮上的条数 —— 那才是"选中了多少场"的唯一真相。
        // 每次重试都重新查元素，不复用可能已经失效的引用。
        const selected = await selectAllAndVerify(rowCount);

        if (!selected.ok) {
          // 表格明明有行却一条都选不上，说明这一批没真正下载。
          // 绝不能 commit —— 否则水位线越过这几天，下次同步再也不会回来补。
          logStepFailure(`列表有 ${rowCount} 行但全选后仍是 0 条，本批未下载（不推进同步记录）`, {
            概要: selected.summaryCount,
            手牌: selected.historyCount,
            尝试次数: selected.attempts,
          });
          if (await bailOnFailure()) {
            record("中止", "全选始终没选上");
            dumpJournal();
            return;
          }
          advance("失败", `有 ${rowCount} 行但全选后仍是 0 条（试了 ${selected.attempts} 次）`);
          continue;
        }

        const summaryCount = selected.summaryCount;
        const historyCount = selected.historyCount;
        batchSummary = summaryCount;
        batchHistory = historyCount;
        // 上限按行算。手牌按钮上的数可能是手数（上千），比行数大得多，拿它比行上限会一直判超限；
        // 所以手牌按钮的数最多按列表行数算。
        const observed = Math.max(summaryCount, Math.min(historyCount, rowCount || historyCount));
        log(`本批已选：概要 ${summaryCount} 条，手牌 ${historyCount} 条（上限 ${cap}）`, "loopDownload");

        // 7.5 页面有没有直接抱怨"选中数量超过允许的最大数量"。
        //
        // 这是最权威的信号 —— 比我们内置的估计值可靠得多。
        // 一旦看到，就把提示里的真实数字学下来，整轮后续都按它办。
        const limitErr = D.findLimitError();
        if (limitErr) {
          logWarning(`页面提示：${limitErr.text}`, "limit");
          await dismissLimitDialog("超限提示后");
          if (limitErr.max && (!learnedCap || limitErr.max < learnedCap)) {
            await rememberCap(limitErr.max);
            logWarning(`从提示里学到真实上限 ${learnedCap} 条（内置估计是 ${cap}），后续按 ${learnedCap} 走`, "limit");
          } else if (!limitErr.max) {
            // 提示里没写数字，只能按当前实际条数往下压
            await rememberCap(Math.max(1, Math.floor(observed * 0.8)));
            logWarning(`提示里没有数字，把上限压到 ${learnedCap} 条再试`, "limit");
          }

          const capNow = effectiveCap(baseCap(inHistoryWindow));
          // 不缩日期重做：按行分几趟下（手牌按按钮上的手数装）
          D.clearSelection();
          logWarning(`${startStr} ~ ${endStr} 全选后超限，改为分趟下载（上限 ${capNow}）`, "limit");
          if (await chunkBatch(capNow)) return;
          continue;
        }

        // 兜底：行数没超但"已选条数"顶到上限（按理不该发生，这里防一手）
        const decision = L.nextSpan(span, observed, cap);
        if (decision.action === "shrink") {
          // 已选条数顶到上限：不缩日期重做，改为分趟下
          D.clearSelection();
          logWarning(`本批已选 ${observed} 条达上限 ${cap}，改为分趟下载`, "loopDownload");
          if (await chunkBatch(cap)) return;
          continue;
        }
        if (decision.action === "capped") {
          // 单日就超过我们的估计值。按行分趟下，别硬着头皮全选。
          D.clearSelection();
          logWarning(`${startStr} 单日就有 ${observed} 条，超过上限 ${cap}，改为分趟下载`, "loopDownload");
          if (await chunkBatch(cap)) return;
          continue;
        }

        // 8. 下载游戏摘要信息（只有锦标赛页面有）。
        //
        // 这一批"该下的都下了"才算成功，否则不能推进水位线 ——
        // 用户没点下载却把日期标记成已同步，下次就再也不会回来补这几天了。
        let allDownloaded = true;

        // 概要和手牌两类都有时，必须两个都点了才算这一批完成（allDownloaded），
        // 只点了概要就停下，水位线和"上次数据同步"时间都不会动。
        if (wantSummary && currentPageConfig().hasSummary && roundEnd >= earliestSummary) {
          const ok = await promptDownload("summary", summaryCount, startStr, endStr, batchRec());
          if (!ok) allDownloaded = false;
        }
        if (stopFlag) {
          stopNow();
          return;
        } // 概要那步被停止了就别再弹手牌的提示

        // 9. 下载历史手牌记录（GG 只保留最近 3 个月，更早的批次直接跳过）
        if (roundEnd < earliestHistory) {
          log(`${startStr} ~ ${endStr} 超出手牌详情的 ` + `${L.HISTORY_MONTHS} 个月范围，本批只下概要`, "loopDownload");
        } else if (!wantHistory) {
          log(`补下载只缺游戏概要，本批不下手牌`, "repair");
        } else {
          const ok = await promptDownload("history", historyCount, startStr, endStr, batchRec());
          if (!ok) allDownloaded = false;
        }

        if (stopFlag) {
          stopNow();
          return;
        }
        await waitIfPaused();

        if (!allDownloaded) {
          // 走到这里只有两种可能：
          //   1. 用户点了"停止" —— 那就停，别往前走；
          //   2. 页面状态异常（列表空了、按钮彻底没了）—— 记为失败，也不 commit。
          // 绝不能因为"用户还没点"就前进：promptDownload 已经改成不可用就重新
          // 全选并一直等，所以"没点完"不会再走到这里。
          if (stopFlag) {
            stopNow();
            return;
          }

          logStepFailure(`${startStr} ~ ${endStr} 未能完成下载（页面状态异常），不推进同步记录`);
          contiguous = false; // 后面的批次也不能再推进水位线
          if (await bailOnFailure()) {
            record("中止", "下载步骤异常");
            dumpJournal();
            return;
          }
          advance("未下载", "下载按钮不可用且列表已空");
          continue;
        }

        failStreak = 0;
        density.observe(rowCount, batchDays);
        await commit(true);
        advance("完成", "已提示并确认点击了全部下载按钮");

        // 按已知密度直接瞄准上限重新定尺寸（可大可小）。
        //
        // 之前的规则是"条数低于上限 35% 才翻倍"，太保守：一批 200~499 行时
        // 明明还能再大却不动，白白多跑好几批、让用户多点好几次下载。
        resizeAfterBatch();

        currentStatus.startDate = startStr;
        currentStatus.endDate = endStr;
        updateStatus("info", `已完成 ${doneDays}/${spanDays} 天（第 ${batchNo} 批 ${startStr} ~ ${endStr}）`);
        log("本批完成，等待下一批...", "loopDownload");
        await wait(randomBetween(1000, 3000));
      } catch (e) {
        logError(e, `loopDownload - 第 ${batchNo} 批`);
        if (await bailOnFailure()) {
          record("中止", `异常：${e.message || e}`);
          dumpJournal();
          return;
        }
        advance("异常", String(e.message || e));
      }
    }

    dumpJournal();
    // 记下这次量出来的密度，下次同步第一批就用它（补下载只跑零碎几段，不算）
    if (!repair && density.rate > 0) await saveDensity(pageType, density.rate);
    // 补下载只跑一段，结果交给 runRepair 汇总；运行状态也由它统一收尾
    if (repair) {
      const ok = contiguous && !stopFlag;
      (ok ? logSuccess : logWarning)(
        `补下载 ${plan.from} ~ ${plan.to}：${ok ? "已完成" : "有批次没完成，可稍后再补一次"}`,
        "repair",
      );
      return { ok };
    }
    const finalState = await GG_SYNC.get(pageType);
    if (contiguous) {
      logSuccess(
        `同步完成：${plan.from} ~ ${plan.to}，共 ${syncedBatches} 批 ${doneDays} 天。` +
          `下次将从 ${finalState.lastSyncedDate || plan.from} 的第二天继续`,
        "loopDownload",
      );
    } else {
      logWarning(
        `同步中途有失败批次，同步记录停在 ${finalState.lastSyncedDate || "(未推进)"}。` +
          `重新点一次同步会从那里接着补。`,
        "loopDownload",
      );
    }
    currentStatus.isRunning = false;
    currentStatus.lastSyncedDate = finalState.lastSyncedDate || null;
    return { ok: contiguous };
  }

  /**
   * 按实时GTO核对出的漏下区间补下载。segments 由侧边栏按 GG_LEDGER.planRepair 切好：
   *   [{ from, to, kinds: ['summary','history'] }]
   * 每段单独跑一遍 loopDownload（repair 模式），不改同步进度。
   */
  /** 逐段补下载。返回 { okCount, ran, aborted }；aborted = 停止或页面操作连续失败。 */
  async function repairSegments(segments) {
    const type = currentPageType();
    const today = L.today();
    const minFor = {
      summary: L.fmt(L.earliestSummaryDate(today)),
      history: L.fmt(L.earliestHistoryDate(today)),
    };
    let okCount = 0;
    let ran = 0;
    logSuccess(`开始补下载：${segments.length} 段（${type}）`, "repair");
    for (const seg of segments) {
      if (stopFlag) return { okCount, ran, aborted: true };
      // 规划时已按 GG 窗口裁过，这里再兜一次：规划到补下载之间可能跨了天，窗口又往后滑了
      const kinds = (seg.kinds || []).filter(
        (k) => (k === "history" || L.pageConfig(type).hasSummary) && seg.to >= minFor[k],
      );
      if (!kinds.length) {
        logWarning(`${seg.from} ~ ${seg.to} 已超出 GG 保留期，无法补下载`, "repair");
        continue;
      }
      // 起点取"最早还能下的那一类"的窗口起点；某类窗口更晚的部分，loopDownload 会按批次自己跳过
      const earliest = kinds.map((k) => minFor[k]).sort()[0];
      const from = seg.from < earliest ? earliest : seg.from;
      ran++;
      currentStatus.isRunning = true;
      const res = await loopDownload({ repair: true, from, to: seg.to, kinds });
      // 没有返回值 = 停止或连续失败中止（页面结构不对），后面几段也不用试了
      if (!res) return { okCount, ran, aborted: true };
      if (res.ok) okCount++;
    }
    (okCount === ran ? logSuccess : logWarning)(`补下载结束：完成 ${okCount}/${ran} 段`, "repair");
    return { okCount, ran, aborted: false };
  }

  /** 旧入口（侧边栏的 repair 消息）：补完直接收尾。现在补下载都在同步收尾阶段自动进行。 */
  async function runRepair(segments) {
    try {
      const r = await repairSegments(segments);
      if (stopFlag) {
        logWarning(`补下载已停止（完成 ${r.okCount}/${segments.length} 段）`, "repair");
      }
    } catch (e) {
      logError(e, "runRepair");
    } finally {
      currentStatus.isRunning = false;
      updateStatus(stopFlag ? "warning" : "success", stopFlag ? "补下载已停止" : "补下载结束");
    }
  }

  function sendStatus(status, progress) {
    chrome.runtime.sendMessage({
      from: "ggpoker-content-script",
      status,
      progress,
    });
  }

  function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // 日期格式化为 YYYY-MM-DD。
  // 必须用本地时间：toISOString() 会先转成 UTC，在东八区会把日期整体往前挪一天，
  // 导致筛选出来的区间跟用户选的差一天。
  function formatDate(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  // 简化日期差值计算函数
  function diffDays(date1, date2) {
    return Math.floor((date1 - date2) / (24 * 60 * 60 * 1000));
  }

  // 调试工具函数
  function debugButtonState(button, context = "") {
    if (!button) {
      logError(`按钮不存在: ${context}`, "debugButtonState");
      return;
    }

    const buttonInfo = {
      context,
      element: {
        tagName: button.tagName,
        id: button.id,
        classes: button.className,
        disabled: button.disabled,
        visible: D.isVisible(button),
        text: button.textContent.trim(),
        rect: button.getBoundingClientRect(),
      },
      parent: {
        tagName: button.parentElement?.tagName,
        classes: button.parentElement?.className,
        component: button.closest("app-download-button-game-session-summary, app-download-button-game-session-hand")
          ?.tagName,
      },
      downloadInfo: {
        count: button.querySelector("small")?.textContent.trim(),
        icon: button.querySelector(".download-icon")?.className,
      },
    };

    log(`按钮状态详情 - ${context}:`, "debugButtonState");
    console.table(buttonInfo);
    return buttonInfo;
  }

  // 检查按钮是否可点击
  function isButtonClickable(button, context = "") {
    if (!button) {
      logError(`按钮不存在: ${context}`, "isButtonClickable");
      return false;
    }

    debugButtonState(button, context);

    // 按文案匹配 "0 游戏概括信息" 太脆（换语言、换文案就失效），
    // 直接看 disabled + <small> 里的数字
    const isClickable = D.isDownloadReady(button);

    log(`按钮可点击状态: ${isClickable} (${D.downloadCount(button)} 条) - ${context}`, "isButtonClickable");
    return isClickable;
  }

  // 等待按钮可点击。finder 是个返回元素的函数（Angular 会重建节点，
  // 所以不能缓存元素引用，每轮都要重新查）。
  async function waitForButtonClickable(finder, context = "", timeout = 10000) {
    const startTime = Date.now();

    while (Date.now() - startTime < timeout) {
      const button = typeof finder === "function" ? finder() : document.querySelector(finder);
      if (button && isButtonClickable(button, context)) {
        return button;
      }
      await wait(500); // 每500ms检查一次
    }

    logError(`等待按钮可点击超时: ${context}`, "waitForButtonClickable");
    return null;
  }

  // 查找下载按钮并高亮提示用户手动点击
  function highlightAndPromptDownloadButton(type) {
    let button, tipText;
    if (type === "summary") {
      button = D.findSummaryButton();
      tipText = "请手动点击此按钮下载游戏概要信息";
    } else if (type === "history") {
      button = D.findHistoryButton();
      tipText = "请手动点击此按钮下载历史手牌记录";
    } else {
      return;
    }
    if (!button) {
      logError(`未找到${tipText}按钮`, "highlightAndPromptDownloadButton");
      return;
    }
    // 重复调用时先清掉上一轮留下的气泡
    const stale = button.parentElement && button.parentElement.querySelector(".ggpoker-download-tip");
    if (stale) stale.remove();

    // 添加高亮动画
    button.style.boxShadow = "0 0 16px 6px #ff9800, 0 0 32px 12px #fffbe6";
    button.style.position = "relative";
    button.style.transition = "box-shadow 0.3s";

    // 添加提示气泡
    let tip = document.createElement("div");
    tip.textContent = tipText;
    tip.style.position = "absolute";
    tip.style.top = "-56px";
    tip.style.left = "50%";
    tip.style.transform = "translateX(-50%)";
    tip.style.background = "#fffbe6";
    tip.style.color = "#d35400";
    tip.style.padding = "8px 20px";
    tip.style.border = "1.5px solid #ff9800";
    tip.style.borderRadius = "8px";
    tip.style.fontSize = "16px";
    tip.style.zIndex = "9999";
    tip.style.boxShadow = "0 4px 16px rgba(0,0,0,0.10)";
    tip.style.opacity = "0";
    tip.style.transition = "opacity 0.5s";
    tip.className = "ggpoker-download-tip";

    // 小三角
    let triangle = document.createElement("div");
    triangle.style.position = "absolute";
    triangle.style.top = "100%";
    triangle.style.left = "50%";
    triangle.style.transform = "translateX(-50%)";
    triangle.style.width = "0";
    triangle.style.height = "0";
    triangle.style.borderLeft = "10px solid transparent";
    triangle.style.borderRight = "10px solid transparent";
    triangle.style.borderTop = "10px solid #fffbe6";
    triangle.style.filter = "drop-shadow(0 1px 1px #ff9800)";
    tip.appendChild(triangle);

    button.parentElement.appendChild(tip);

    // 动画淡入
    setTimeout(() => {
      tip.style.opacity = "1";
    }, 50);

    // 点击后移除高亮和提示
    button.addEventListener("click", function removeTipOnce() {
      button.style.boxShadow = "";
      let oldTip = button.parentElement.querySelector(".ggpoker-download-tip");
      if (oldTip) {
        oldTip.style.opacity = "0";
        setTimeout(() => oldTip.remove(), 500);
      }
      button.removeEventListener("click", removeTipOnce);
    });
  }

  // 后续将在此实现页面内容采集与交互

  function sendMessage(action, data = {}) {
    chrome.tabs.query({ active: true, currentWindow: true }, function (tabs) {
      if (tabs[0]) {
        chrome.tabs.sendMessage(tabs[0].id, { action, ...data }, function (response) {
          if (chrome.runtime.lastError) {
            statusDiv.textContent = "请先在GGPoker目标页面（如my.pokercraft.com）激活后再操作！";
            statusDiv.style.color = "#d35400";
          }
        });
      }
    });
  }

  // 旧的 waitForUserClickOrTimeout 已删除：有数据就必须等用户点，不能超时跳过。
  // 现在用 waitForUserClick（无超时，只响应停止）。
  // 卡住时敲 ggBlockers() 看当前屏幕上到底挡着什么（弹窗/转圈/遮罩）
  window.ggBlockers = function () {
    const b = D.describeBlockers();
    console.log("%c[GGPoker助手] 当前遮挡物", "color:#2563eb;font-weight:bold");
    console.log("  弹窗:", b.dialogs.length ? b.dialogs : "无");
    console.log("  转圈:", b.spinners.length ? b.spinners : "无");
    console.log("  遮罩层:", b.backdrops, " overlay-pane:", b.overlayPanes);
    return b;
  };

  // 在页面控制台（context 切到本扩展）里敲 ggSyncLog() 就能看上次同步的流水账
  window.ggSyncLog = function () {
    chrome.storage.local.get(["ggSyncJournal"], (r) => {
      const j = r && r.ggSyncJournal;
      if (!j || !j.journal || !j.journal.length) {
        console.log("[GGPoker助手] 还没有同步流水账");
        return;
      }
      console.log(
        `%c[GGPoker助手] ${j.pageType} 于 ${new Date(j.at).toLocaleString()} 的同步流水账`,
        "color:#2563eb;font-weight:bold",
      );
      console.table(j.journal);
      const notCommitted = j.journal.filter((e) => !e["已推进水位线"]);
      if (notCommitted.length) {
        console.warn(`其中 ${notCommitted.length} 批没有推进水位线，重新同步会从那里接着补：`);
        console.table(notCommitted);
      }
    });
  };

  // 仅供自动化测试调用
  window.__test_loopDownload = loopDownload;
  window.__test_runRepair = runRepair;
  window.__test_runAutomation = runAutomation;
  window.__test_completenessPhase = completenessPhase;
  window.__test_stop = () => {
    stopFlag = true;
  };
} // end __GG_DOWNLOADER_LOADED__ guard
