// pokercraft-dom.js
// PokerCraft 页面 DOM 适配层。
//
// 背景：PokerCraft 前端已升级到 Angular Material MDC（v15+，当前页面用的是
// v19/20 的 `--mat-sys-*` 主题变量），旧版 Material 的类名全部改名，例如
//   .mat-header-row     -> .mat-mdc-header-row
//   .mat-checkbox-frame -> .mdc-checkbox__background（真正可点的是里面的原生 input）
//   .mat-option         -> mat-option.mat-mdc-option
//   button.mat-button-base -> button.mat-mdc-button-base
// 同时页面自身的结构也变了（`.list-submit-buttons` 已不存在，"显示" 按钮变成
// `button[btn-red].search-form-button`）。
//
// 教训是：写死在代码里的选择器一定会过期。所以具体选什么全部放在
// pokercraft-rules.js 的规则表里，本文件只负责"怎么用这些规则找元素"：
//   · 选择器数组按顺序试，命中即止（新结构在前、旧结构在后做兼容）；
//   · 能按文案找的就按文案找，不依赖 #mat-option-5 这种会变的 id；
//   · 找不到时返回 null，由调用方决定怎么处理。
//
// 规则可以在运行时被远端版本替换（GGDom.setRules），页面改版后不用发新插件。
//
// 暴露为 window.GGDom，供 content-script.js 使用。

(function () {
  "use strict";

  const RULES_MODULE = window.GG_RULES;
  if (!RULES_MODULE) {
    console.error("[GGPoker助手] pokercraft-rules.js 未加载，DOM 适配层无法工作");
  }

  // 当前生效的规则。默认用内置的，之后可能被远端规则替换。
  let RULES = RULES_MODULE ? RULES_MODULE.DEFAULT_RULES : { version: 0, selectors: {}, pageTypes: {} };
  let rulesSource = "builtin"; // builtin | stored | remote，文案由调用方翻译

  /** 取某条规则；规则表里没有就返回空数组，调用处自然降级为"找不到"。 */
  function R(key) {
    const v = RULES.selectors && RULES.selectors[key];
    return Array.isArray(v) ? v : [];
  }

  // ---------------------------------------------------------------- 基础工具

  /** 依次尝试多个选择器，返回第一个命中的元素。 */
  function qsAny(selectors, root) {
    const scope = root || document;
    for (const sel of selectors) {
      if (!sel) continue;
      try {
        const el = scope.querySelector(sel);
        if (el) return el;
      } catch (e) {
        /* 忽略非法选择器 */
      }
    }
    return null;
  }

  /** 依次尝试多个选择器，返回所有命中元素的合集（去重）。 */
  function qsaAny(selectors, root) {
    const scope = root || document;
    const out = [];
    for (const sel of selectors) {
      if (!sel) continue;
      try {
        scope.querySelectorAll(sel).forEach((el) => {
          if (!out.includes(el)) out.push(el);
        });
      } catch (e) {
        /* 忽略非法选择器 */
      }
    }
    return out;
  }

  /** 归一化文本：去空白、转小写，便于比较。 */
  function norm(text) {
    return (text || "").replace(/\s+/g, "").toLowerCase();
  }

  /** 元素文本是否包含候选文案之一。 */
  function textMatches(el, candidates) {
    const t = norm(el && el.textContent);
    if (!t) return false;
    return (candidates || []).some((c) => t.includes(norm(c)));
  }

  /**
   * 元素是否真的可见。
   * 不用 offsetParent —— 祖先一旦是 position:fixed（cdk-overlay 就是），
   * offsetParent 会是 null，旧代码因此误判"元素不可见"。
   */
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden") return false;
    // MDC 的原生 checkbox input 是 opacity:0 叠在背景上的，仍然算可见可点
    return true;
  }

  function wait(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  /** 轮询等待 fn() 返回真值，超时返回 null。 */
  async function waitFor(fn, timeout = 10000, interval = 300) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      try {
        const v = fn();
        if (v) return v;
      } catch (e) {
        /* 继续等 */
      }
      await wait(interval);
    }
    return null;
  }

  // ---------------------------------------------------------------- 日期下拉

  /**
   * 找"日期"下拉框（mat-select）。
   * 优先按 mat-form-field 里的 mat-label 文案匹配，找不到再退回规则里的
   * fallback 选择器（当前锦标赛页里第一个 mat-select 正好就是日期）。
   */
  function findDateSelect() {
    const labels = R("dateSelectLabels");
    const fields = document.querySelectorAll("mat-form-field");
    for (const field of fields) {
      const label = field.querySelector("mat-label");
      const select = field.querySelector("mat-select");
      if (select && label && textMatches(label, labels)) return select;
    }
    return qsAny(R("dateSelectFallback"));
  }

  /** mat-select 真正绑定 click 的是内部的 trigger，不是宿主元素。 */
  function selectTrigger(select) {
    if (!select) return null;
    return qsAny(R("selectTrigger"), select) || select;
  }

  function isSelectOpen(select) {
    return !!select && select.getAttribute("aria-expanded") === "true";
  }

  /** 当前打开的下拉面板里的所有选项。 */
  function listOpenOptions() {
    return qsaAny(R("openOptions"));
  }

  /** 在已打开的下拉面板里找"定制范围"选项。 */
  function findCustomRangeOption() {
    const options = listOpenOptions();
    if (!options.length) return null;
    const hit = options.find((o) => textMatches(o, R("customRangeLabels")));
    // 兜底：PokerCraft 的日期下拉里"定制范围"一直是最后一项
    return hit || options[options.length - 1] || null;
  }

  // ------------------------------------------------------------ 日期范围输入

  /** 找 mat-date-range-input 的开始/结束两个输入框。 */
  function findDateRangeInputs() {
    let inputs = qsaAny(R("dateRangeInputs"));
    if (inputs.length < 2) {
      // 最后兜底：按 id 前缀找（id 序号不固定，所以用前缀匹配而不是写死 -0/-1）
      inputs = qsaAny(R("dateRangeInputsFallback"));
    }
    if (inputs.length < 2) return null;
    return { start: inputs[0], end: inputs[1] };
  }

  /**
   * 按输入框实际期望的格式生成日期字符串。
   * 优先看 placeholder（PokerCraft 会给出 MM/DD/YYYY 之类的提示），
   * 看不出来就返回一组候选格式让调用方逐个试。
   */
  function dateFormatCandidates(date, input) {
    const y = String(date.getFullYear());
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const m1 = String(date.getMonth() + 1);
    const d1 = String(date.getDate());

    const byPattern = (p) =>
      p.replace(/YYYY/gi, y).replace(/MM/g, m).replace(/DD/g, d).replace(/\bM\b/g, m1).replace(/\bD\b/g, d1);

    const hint = (input && input.placeholder) || "";
    const out = [];
    if (/[YMD年月日]/i.test(hint)) {
      // 把 "年/月/日" 这种本地化提示也换成 YYYY/MM/DD 再套值
      const pattern = hint.replace(/年/g, "YYYY").replace(/月/g, "MM").replace(/日/g, "DD");
      out.push(byPattern(pattern));
    }
    out.push(`${m}/${d}/${y}`, `${y}-${m}-${d}`, `${d}/${m}/${y}`, `${y}/${m}/${d}`);
    return out.filter((v, i, a) => v && a.indexOf(v) === i);
  }

  /**
   * 写入 input 的值。
   * 必须走原生 value setter，否则 Angular 的 ControlValueAccessor 读不到变化；
   * 旧代码直接 `target.value = 时间戳` 是解析不出来的（写进去的是一串数字）。
   */
  function setNativeValue(input, value) {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(input, value);
    else input.value = value;
  }

  /** 模拟一次完整的"用户输入并离开"，让 Angular 解析日期。 */
  function typeIntoInput(input, value) {
    input.focus();
    input.dispatchEvent(new Event("focus", { bubbles: true }));
    setNativeValue(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.dispatchEvent(new Event("blur", { bubbles: true }));
  }

  /** 读回日期范围输入框当前显示的值，用来确认筛选到底生效没有。 */
  function readDateRangeInputs() {
    const inputs = findDateRangeInputs();
    if (!inputs) return null;
    return { start: inputs.start.value || "", end: inputs.end.value || "" };
  }

  /**
   * 判断输入框里显示的日期是不是我们想要的那一天。
   * 各种格式都可能（MM/DD/YYYY、YYYY-MM-DD、YYYY/MM/DD…），
   * 所以不比字符串，只比年月日三个数。
   */
  function sameDay(inputValue, y, m, d) {
    const nums = String(inputValue).match(/\d+/g);
    if (!nums || nums.length < 3) return false;
    const set = nums.map(Number);
    return set.includes(y) && set.includes(m) && set.includes(d);
  }

  /** Angular 解析失败会给 input 打上 ng-invalid。 */
  function inputAccepted(input) {
    if (!input) return false;
    if (input.classList.contains("ng-invalid")) return false;
    return !!input.value;
  }

  // ------------------------------------------------------------ 日历弹层

  function findDatepickerPanel() {
    return qsAny(R("datepickerPanel"));
  }

  function findOverlayBackdrop() {
    return qsAny(R("overlayBackdrop"));
  }

  function findCalendarPrevButton(panel) {
    return qsAny(R("calendarPrevButton"), panel);
  }

  function findCalendarNextButton(panel) {
    return qsAny(R("calendarNextButton"), panel);
  }

  function listCalendarCells(panel) {
    return qsaAny(R("calendarCell"), panel);
  }

  function calendarCellText(cell) {
    const content = qsAny(R("calendarCellContent"), cell);
    return (content || cell).textContent.trim();
  }

  /** 关闭日历/下拉弹层：先找关闭按钮，再退回点遮罩，最后按 Esc。 */
  function closeOverlay() {
    const closeBtn = qsAny(R("datepickerCloseButton"));
    if (closeBtn) {
      closeBtn.click();
      return "close-button";
    }
    const backdrop = findOverlayBackdrop();
    if (backdrop) {
      backdrop.click();
      return "backdrop";
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
    return "escape";
  }

  // ------------------------------------------------------------ 显示 / 全选

  /** 找筛选栏的"显示"按钮。 */
  function findShowButton() {
    const direct = qsAny(R("showButton"));
    if (direct) return direct;
    // 兜底：按文案在筛选区里找
    const scope = qsAny(R("filterScope")) || document;
    return (
      Array.from(scope.querySelectorAll("button")).find(
        (b) => textMatches(b, R("showButtonLabels")) && !b.closest("[class*='btn-download']"),
      ) || null
    );
  }

  /**
   * 找表头"全选"复选框。
   * MDC 下真正能触发 change 的是隐藏的原生 input，点 .mdc-checkbox__background
   * 不一定会冒泡到 Angular，所以规则里 input 排在最前面。
   */
  function findSelectAllCheckbox() {
    const headerRow = qsAny(R("headerRow"));
    if (!headerRow) return null;
    return qsAny(R("selectAll"), headerRow);
  }

  /**
   * 找"选中数量超过允许的最大数量"这类提示，并尽量从里面读出那个上限数字。
   *
   * 这个上限不该由我们猜。之前把它写死成 500 场 / 2 万手换算的 100 场，
   * 结果线上照样超限被 GG 拒绝 —— 说明猜错了。
   * 现在改成：真超了就从页面提示里读真实数字，读到多少就按多少办。
   */
  function findLimitError() {
    const labels = R("limitErrorLabels");
    if (!labels.length) return null;

    const scopes = qsaAny(R("limitErrorScope"));
    const roots = scopes.length ? scopes : [document.body];

    for (const root of roots) {
      // 只看叶子节点，否则父容器的 textContent 会把整页文字算进来
      const leaves = Array.from(root.querySelectorAll("div, span, p, td, li, strong")).filter(
        (el) => el.children.length === 0 && el.textContent.trim(),
      );
      for (const el of leaves) {
        if (!isVisible(el)) continue;
        if (!textMatches(el, labels)) continue;
        const text = el.textContent.replace(/\s+/g, " ").trim();
        return { found: true, text, max: parseLimitNumber(text), element: el };
      }
    }
    return null;
  }

  /**
   * 从超限文案里解析上限数字。
   *
   * 两个坑：
   *   · 千分位逗号 —— "20,000 个手牌" 直接 \d+ 会拆成 20 和 000；
   *   · 文案里往往还有月份数 —— "最近 12 个月内的 500 个摘要"，
   *     取最大值会把 20000（手牌上限）当成摘要上限，取最小值又会取到 12。
   * 所以先去掉千分位，再把明显是"月份"的数字排掉，剩下的取最大。
   */
  function parseLimitNumber(text) {
    // 去千分位。逗号可能连着出现（1,234,567），循环到不再变化为止。
    let cleaned = String(text);
    let prev;
    do {
      prev = cleaned;
      cleaned = cleaned.replace(/(\d),(\d)/g, "$1$2");
    } while (cleaned !== prev);

    // 把 "12 个月" / "3 months" 这类时间跨度剔除，免得被当成上限数字
    const withoutMonths = cleaned.replace(/\d+\s*(个月内|個月內|个月|個月|months?)/gi, " ");
    const nums = (withoutMonths.match(/\d+/g) || []).map(Number).filter((n) => n > 0);
    return nums.length ? Math.max(...nums) : null;
  }

  /**
   * 官方"下载限制"弹窗。超限时会弹出来，带遮罩挡住整页 ——
   * 不关掉的话用户点不到下载按钮，插件也点不到任何元素。
   */
  function findLimitDialog() {
    const labels = R("limitDialogLabels");
    if (!labels.length) return null;
    const containers = qsaAny([
      "mat-dialog-container",
      ".cdk-overlay-container .cdk-overlay-pane",
      ".cdk-overlay-container",
    ]);
    for (const c of containers) {
      if (!isVisible(c)) continue;
      if (textMatches(c, labels)) {
        return { element: c, text: c.textContent.replace(/\s+/g, " ").trim().slice(0, 300) };
      }
    }
    return null;
  }

  /** 关掉"下载限制"弹窗：先找关闭按钮，再退回遮罩/Esc。 */
  function closeLimitDialog() {
    const dlg = findLimitDialog();
    if (!dlg) return "no-dialog";

    const btn = qsAny(R("limitDialogClose"), dlg.element) || qsAny(R("limitDialogClose"));
    if (btn) {
      btn.click();
      return "close-button";
    }
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", keyCode: 27, bubbles: true }));
    const backdrop = findOverlayBackdrop();
    if (backdrop) backdrop.click();
    return "escape/backdrop";
  }

  /**
   * 当前有没有挡住页面的模态弹窗。
   *
   * 点完下载按钮 GG 可能还会弹确认框/准备中的框 —— 那个框没处理完，
   * 这一批其实根本没下到。所以"按钮被点了"不等于"下载完成了"，
   * 推进时间之前必须确认页面上没有未处理的弹窗。
   *
   * 只认带遮罩的模态框，下拉菜单、日历、提示气泡都不算
   * （它们也在 cdk-overlay 里，但不该阻塞流程）。
   */
  function findOpenDialog() {
    const backdrop = qsAny(R("modalBackdrop"));
    const panes = qsaAny(R("dialogContainer"));
    for (const el of panes) {
      if (!isVisible(el)) continue;
      // mat-dialog-container / role=dialog 本身就说明是模态框；
      // 泛 overlay-pane 则要求同时有遮罩，才不会把下拉面板算进来
      const isDialogish =
        el.tagName.toLowerCase() === "mat-dialog-container" ||
        el.getAttribute("role") === "dialog" ||
        !!el.querySelector("mat-dialog-container, [role='dialog']");
      if (!isDialogish && !backdrop) continue;
      if (!isDialogish && !el.querySelector("button")) continue;
      const text = el.textContent.replace(/\s+/g, " ").trim();
      if (!text) continue;
      return { element: el, text: text.slice(0, 200) };
    }
    return null;
  }

  /**
   * 页面上有没有正在转的圈（下载准备中 / 列表加载中）。
   *
   * 点完下载按钮后 GG 常常只转圈生成文件，并不弹框。转圈期间文件还没好，
   * 这时推进时间就等于这一批没下到。所以"等弹窗"和"等转圈"都要算。
   */
  function findBusySpinner() {
    const list = qsaAny(R("busySpinner"));
    for (const el of list) {
      if (isVisible(el)) {
        return { element: el, where: el.closest(".cdk-overlay-container") ? "弹层内" : "页面内" };
      }
    }
    return null;
  }

  /**
   * 卡住时把屏幕上的遮挡物快照出来，方便直接看出在等什么。
   * 光说"还在等"没用，得说清楚等的是哪个东西。
   */
  function describeBlockers() {
    const out = { dialogs: [], spinners: [], backdrops: 0, overlayPanes: 0 };
    qsaAny(R("dialogContainer")).forEach((el) => {
      if (!isVisible(el)) return;
      out.dialogs.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute("class") || "").slice(0, 60),
        text: el.textContent.replace(/\s+/g, " ").trim().slice(0, 80),
      });
    });
    qsaAny(R("busySpinner")).forEach((el) => {
      if (!isVisible(el)) return;
      out.spinners.push({
        tag: el.tagName.toLowerCase(),
        cls: (el.getAttribute("class") || "").slice(0, 60),
        inOverlay: !!el.closest(".cdk-overlay-container"),
      });
    });
    out.backdrops = qsaAny(R("modalBackdrop")).filter(isVisible).length;
    out.overlayPanes = qsaAny([".cdk-overlay-pane"]).filter(isVisible).length;
    return out;
  }

  /** 表格里每一行自己的复选框。 */
  function findRowCheckboxes() {
    const scope = qsAny(R("sessionsScope")) || document;
    return qsaAny(R("rowCheckbox"), scope);
  }

  /**
   * 只勾选前 n 行。
   * 单日场次就超过上限时，按日期已经切不动了，只能按行分批。
   * 返回实际勾上的行数。
   */
  function selectFirstRows(n) {
    const boxes = findRowCheckboxes();
    let checked = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      const want = i < n;
      const isChecked = box.tagName === "INPUT" ? box.checked : false;
      if (want !== isChecked) box.click();
      if (want) checked++;
    }
    return checked;
  }

  /** 取消所有行的勾选（含表头全选）。 */
  function clearSelection() {
    const rows = findRowCheckboxes().filter((b) => b.tagName === "INPUT");
    const header = findSelectAllCheckbox();
    // 只在每一行都勾着时才点表头取消全选：只勾了一部分时点表头会变成"全选"，
    // 勾上几百行超过 500 就弹"下载限制"遮罩
    if (header && header.tagName === "INPUT" && header.checked && rows.length && rows.every((b) => b.checked)) {
      header.click();
    }
    findRowCheckboxes().forEach((b) => {
      if (b.tagName === "INPUT" && b.checked) b.click();
    });
  }

  /** 表头全选框的状态（排查"下载限制"弹窗时写进日志） */
  function selectAllState() {
    const h = findSelectAllCheckbox();
    if (!h) return "无表头";
    const input = h.tagName === "INPUT" ? h : h.querySelector && h.querySelector("input[type='checkbox']");
    if (!input) return "表头无 input";
    return `checked=${input.checked} indeterminate=${input.indeterminate} aria=${input.getAttribute("aria-checked")}`;
  }

  function isSelectAllChecked() {
    const box = findSelectAllCheckbox();
    if (!box) return false;
    if (box.tagName === "INPUT") return box.checked;
    const host = box.closest("mat-checkbox");
    const input = host && host.querySelector("input[type='checkbox']");
    return !!(input && input.checked);
  }

  // ------------------------------------------------------------ 下载按钮

  function findSummaryButton() {
    return qsAny(R("summaryButton"));
  }

  function findHistoryButton() {
    return qsAny(R("historyButton"));
  }

  /** 按钮上 <small> 里的数字就是本次可下载的条数，0 条时按钮是 disabled。 */
  function downloadCount(button) {
    if (!button) return 0;
    const small = qsAny(R("downloadCountText"), button);
    return small ? parseCount(small.textContent) : 0;
  }

  // "8,411 游戏历史记录" 是 8411：只取开头一串数字会读成 8（线上核对就因此把按钮条数记错）。
  // 千位分隔符可能是逗号、点、空格或撇号。
  // 只认开头的数字：手牌按钮在选中的比赛超出 3 个月时显示"最近3个月"（不可用），
  // 以前把里面的 3 当成了手数。
  function parseCount(text) {
    const m = String(text || "").match(/^\s*(\d{1,3}(?:[,.\s  ']\d{3})+(?!\d)|\d+)/);
    return m ? parseInt(m[1].replace(/\D/g, ""), 10) : 0;
  }

  function isDownloadReady(button) {
    if (!button) return false;
    if (button.disabled || button.getAttribute("disabled") !== null) return false;
    if (!isVisible(button)) return false;
    return downloadCount(button) > 0;
  }

  // ------------------------------------------------------------ 数据状态

  function sessionsScope() {
    return qsAny(R("sessionsScope")) || document.body;
  }

  /**
   * 判断当前筛选结果是否为空。
   * 旧代码遍历所有 div 做 textContent.includes("没有数据")，会把包含整页文本的
   * 顶层容器也算进去，几乎必然误报。这里只看表格区域里的叶子节点。
   */
  function hasNoData() {
    // 加载中绝不能下"没有数据"的结论。
    // 点完"显示"后 Angular 会先清空 tbody 再填新数据，那一瞬间表是空的；
    // 在那个窗口里判成"没有数据"会导致整批被当成已同步跳过 —— 既不提示下载，
    // 又推进了水位线，这几天就永远补不回来了。
    if (isLoading()) return false;

    const scope = sessionsScope();
    const labels = R("noDataLabels");

    const table = scope.querySelector("table");
    if (table) {
      const rows = table.querySelectorAll("tbody tr");
      if (rows.length === 0) return true;
      // 只有一行且写着"没有数据"，那是占位行
      return rows.length === 1 && textMatches(rows[0], labels);
    }

    // 连表格都没渲染出来，只能退回找提示文案（只看叶子节点，
    // 否则顶层容器的 textContent 包含整页文字，必然误判）
    const leaves = Array.from(scope.querySelectorAll("div, span, td, p")).filter((el) => el.children.length === 0);
    return leaves.some((el) => textMatches(el, labels));
  }

  /** 列表加载中的转圈。 */
  function isLoading() {
    const spinner = qsAny(R("spinner"));
    return !!spinner && isVisible(spinner);
  }

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

  /**
   * 每一行比赛的开始日期（行首单元格，如 "Jun 22, 02:00"、"6月22日"、"2026-06-22"）。
   * 页面上一般不带年份，取离 ref 最近的那一年。解析不了的行跳过。
   */
  function rowDates(ref) {
    const scope = qsAny(R("sessionsScope"));
    if (!scope) return [];
    const refMs = ref ? ref.getTime() : Date.now();
    const refYear = new Date(refMs).getFullYear();
    const out = [];
    scope.querySelectorAll("tbody tr").forEach((tr) => {
      const cells = tr.querySelectorAll("td");
      const text = ((cells[1] || cells[0] || tr).textContent || "") + " " + (tr.textContent || "").slice(0, 80);
      let y = null,
        mo = null,
        d = null,
        m;
      if ((m = text.match(/(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/))) {
        y = +m[1];
        mo = +m[2] - 1;
        d = +m[3];
      } else if ((m = text.match(/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?\s+(\d{1,2})\b/i))) {
        mo = MONTHS[m[1].slice(0, 3).toLowerCase()];
        d = +m[2];
      } else if ((m = text.match(/(\d{1,2})月(\d{1,2})日/))) {
        mo = +m[1] - 1;
        d = +m[2];
      }
      if (mo == null || !d) return;
      if (y == null) {
        let best = null;
        for (const yy of [refYear - 1, refYear, refYear + 1]) {
          const t = new Date(yy, mo, d).getTime();
          if (best == null || Math.abs(t - refMs) < Math.abs(best - refMs)) best = t;
        }
        out.push(new Date(best));
      } else {
        out.push(new Date(y, mo, d));
      }
    });
    return out;
  }

  function countRows() {
    const scope = qsAny(R("sessionsScope"));
    if (!scope) return 0;
    return scope.querySelectorAll("tbody tr").length;
  }

  /**
   * 表格内容指纹，用来判断"显示"之后列表是不是真的换了一批数据。
   *
   * 不能只靠 isLoading() 判断：点完"显示"后转圈要过一会儿才出现，
   * 这期间 isLoading() 是 false，直接往下走就会拿着上一批的旧表格操作 ——
   * 等 Angular 真正换掉 DOM，之前抓到的复选框已经是游离节点，点了也没反应。
   */
  function tableFingerprint() {
    const scope = qsAny(R("sessionsScope"));
    if (!scope) return "no-scope";
    const rows = scope.querySelectorAll("tbody tr");
    if (!rows.length) return "empty";
    const first = rows[0].textContent.replace(/\s+/g, " ").trim().slice(0, 80);
    const last = rows[rows.length - 1].textContent.replace(/\s+/g, " ").trim().slice(0, 80);
    return `${rows.length}|${first}|${last}`;
  }

  /** 表头全选复选框当前是否还挂在文档里（Angular 重渲染后旧引用会游离）。 */
  function isAttached(el) {
    return !!el && el.isConnected;
  }

  // ------------------------------------------------------- 网络探针 / DOM 观察

  /**
   * 读 network-probe.js 写在 <html> 上的在途请求状态。
   * 探针跑在 MAIN world（页面自己的 JS 环境），这里是 isolated world，
   * 两边只能靠共享的 DOM 传话。
   * available=false 表示探针没装上，调用方要退回基于时间的旧判据。
   */
  function netState() {
    const ds = document.documentElement.dataset;
    if (ds.ggInflight === undefined) {
      return { available: false, inflight: 0, lastDoneAt: 0, seen: 0, failed: 0 };
    }
    return {
      available: true,
      inflight: Number(ds.ggInflight) || 0,
      lastDoneAt: Number(ds.ggLastDone) || 0,
      seen: Number(ds.ggNetSeen) || 0,
      failed: Number(ds.ggNetFailed) || 0,
    };
  }

  /**
   * 等到 DOM 不再变动。
   * 用 MutationObserver 而不是轮询快照：Angular 一填数据就会触发，
   * 不会像定时采样那样在两次渲染之间的空隙里误判成"已经稳定"。
   *
   * quietMs 内没有任何变动就算稳；maxMs 是总上限。
   */
  function waitForDomQuiet(quietMs = 700, maxMs = 20000) {
    return new Promise((resolve) => {
      const target = qsAny(R("sessionsScope")) || document.body;
      let quietTimer = null;
      let observer = null;
      let finished = false;

      const finish = (reason) => {
        if (finished) return;
        finished = true;
        if (quietTimer) clearTimeout(quietTimer);
        if (observer) observer.disconnect();
        clearTimeout(hardStop);
        resolve(reason);
      };

      const arm = () => {
        if (quietTimer) clearTimeout(quietTimer);
        quietTimer = setTimeout(() => finish("quiet"), quietMs);
      };

      const hardStop = setTimeout(() => finish("timeout"), maxMs);

      try {
        observer = new MutationObserver(arm);
        observer.observe(target, { childList: true, subtree: true, characterData: true });
      } catch (e) {
        return finish("observer-failed");
      }
      arm();
    });
  }

  // ------------------------------------------------------------ 页面类型

  function detectPageType() {
    const url = window.location.href;
    const map = RULES.pageTypes || {};
    for (const [type, pattern] of Object.entries(map)) {
      try {
        if (new RegExp(pattern).test(url)) return type;
      } catch (e) {
        /* 规则里的正则不合法就跳过 */
      }
    }
    return null;
  }

  // ------------------------------------------------------------ 规则管理

  /** 换一套规则（通常来自远端）。返回是否成功。 */
  function setRules(rules, source) {
    if (!RULES_MODULE) return false;
    const err = RULES_MODULE.validateRules(rules);
    if (err) {
      console.error(`[GGPoker助手] 规则校验失败，继续用当前规则(${rulesSource})：${err}`);
      return false;
    }
    RULES = rules;
    rulesSource = source || "remote";
    console.log(`[GGPoker助手] 已启用解析规则 v${rules.version}（来源 ${rulesSource}）`);
    return true;
  }

  function getRules() {
    return RULES;
  }

  function rulesInfo() {
    return { version: RULES.version, source: rulesSource, updatedAt: RULES.updatedAt };
  }

  /**
   * 关键元素是不是都找得到。
   * 这是判断"要不要去拉新规则"的依据：日期下拉和显示按钮是整个流程的入口，
   * 这两个找不到就说明页面结构变了，当前规则已经不适用。
   */
  function rulesLookBroken() {
    return !findDateSelect() || !findShowButton();
  }

  /** 自检：把关键元素的命中情况打成一张表，排查"解析不了"时最有用。 */
  function diagnose() {
    return {
      url: location.href,
      pageType: detectPageType(),
      rulesVersion: RULES.version,
      rulesSource,
      dateSelect: !!findDateSelect(),
      showButton: !!findShowButton(),
      selectAllCheckbox: !!findSelectAllCheckbox(),
      summaryButton: !!findSummaryButton(),
      historyButton: !!findHistoryButton(),
      summaryCount: downloadCount(findSummaryButton()),
      historyCount: downloadCount(findHistoryButton()),
      rows: countRows(),
      netProbe: netState().available ? `已装（累计 ${netState().seen} 次请求）` : "未装",
      busySpinner: findBusySpinner() ? "有（页面正在忙）" : "无",
      openDialog: findOpenDialog() ? "有" : "无",
      materialFlavor: qsAny(R("mdcProbe")) ? "MDC (Material 15+)" : "legacy (Material <=14)",
    };
  }

  window.GGDom = {
    // 工具
    qsAny,
    qsaAny,
    norm,
    textMatches,
    isVisible,
    wait,
    waitFor,
    // 日期下拉
    findDateSelect,
    selectTrigger,
    isSelectOpen,
    listOpenOptions,
    findCustomRangeOption,
    // 日期输入
    findDateRangeInputs,
    readDateRangeInputs,
    sameDay,
    dateFormatCandidates,
    setNativeValue,
    typeIntoInput,
    inputAccepted,
    // 弹层 / 日历
    findDatepickerPanel,
    findOverlayBackdrop,
    findCalendarPrevButton,
    findCalendarNextButton,
    listCalendarCells,
    calendarCellText,
    closeOverlay,
    // 筛选栏
    findShowButton,
    findSelectAllCheckbox,
    isSelectAllChecked,
    findLimitError,
    findLimitDialog,
    closeLimitDialog,
    findOpenDialog,
    findBusySpinner,
    describeBlockers,
    parseLimitNumber,
    findRowCheckboxes,
    selectFirstRows,
    selectAllState,
    rowDates,
    clearSelection,
    // 下载
    findSummaryButton,
    findHistoryButton,
    downloadCount,
    parseCount,
    isDownloadReady,
    // 状态
    hasNoData,
    isLoading,
    countRows,
    tableFingerprint,
    isAttached,
    netState,
    waitForDomQuiet,
    // 规则
    setRules,
    getRules,
    rulesInfo,
    rulesLookBroken,
    // 其他
    detectPageType,
    diagnose,
  };
})();
