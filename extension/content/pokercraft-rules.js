// pokercraft-rules.js
// PokerCraft 页面的解析规则（内置默认版）。
//
// GG 的前端随时可能改版 —— 上一次从 Angular Material 传统版升级到 MDC，
// 就把写死在代码里的类名全部作废了，用户只能等插件发新版本。
// 所以把"怎么找元素"从代码里抽出来变成一份数据：
//
//   内置默认规则（本文件） → 远端规则（storage 里，来自 RULES_URL）
//
// 页面结构一变，只要在服务端放一份新的 JSON，装了插件的人自动就能用上，
// 不必重新发版、不必等审核。
//
// 版本号只增不减。远端规则的 version 必须大于当前生效的版本才会被采用。
//
// 选择器数组按顺序尝试，命中即止 —— 所以新结构放前面、旧结构放后面做兼容。
// labels 类字段是按文案匹配（忽略大小写和空白），用来对付 id 会变、
// class 会改名但界面文字相对稳定的情况。

(function () {
  "use strict";

  const DEFAULT_RULES = {
    version: 6,
    updatedAt: "2026-09-24",
    note: "Angular Material MDC (v15+/v19)",

    // 页面类型识别：正则字符串（不带斜杠），对 location.href 匹配
    pageTypes: {
      tournament: "my\\.pokercraft\\.com/tournament",
      rushAndCash: "my\\.pokercraft\\.com/rush-and-cash",
      holdem: "my\\.pokercraft\\.com/holdem",
      // 奥马哈：和德扑现金局一样只有手牌历史，筛选栏多一个"游戏"下拉，不影响按"日期"找下拉
      plo: "my\\.pokercraft\\.com/plo(?:[/?#]|$)",
    },

    selectors: {
      // —— 日期下拉 ——
      dateSelectLabels: ["日期", "日期範圍", "date", "period", "기간"],
      dateSelectFallback: ["mat-select"],
      selectTrigger: [".mat-mdc-select-trigger", ".mat-select-trigger"],
      openOptions: [
        ".cdk-overlay-container mat-option",
        ".mat-mdc-select-panel mat-option",
        ".mat-select-panel mat-option",
        ".cdk-overlay-container [role='option']",
      ],
      customRangeLabels: [
        "定制范围",
        "自定义范围",
        "自訂範圍",
        "定制範圍",
        "自定义",
        "custom range",
        "customrange",
        "custom",
      ],

      // —— 日期范围输入 ——
      dateRangeInputs: [
        "mat-date-range-input input",
        ".mat-date-range-input-container input",
        "input[matstartdate]",
        "input[matenddate]",
      ],
      dateRangeInputsFallback: ["input[id^='mat-date-range-input-']"],

      // —— 日历弹层 ——
      datepickerPanel: ["mat-datepicker-content", ".mat-datepicker-content", ".mat-datepicker-popup"],
      datepickerCloseButton: [".mat-datepicker-close-button", "mat-datepicker-content button[mat-raised-button]"],
      overlayBackdrop: [".cdk-overlay-backdrop.cdk-overlay-backdrop-showing", ".cdk-overlay-backdrop"],
      calendarPrevButton: [".mat-calendar-previous-button"],
      calendarNextButton: [".mat-calendar-next-button"],
      calendarPeriodButton: [".mat-calendar-period-button"],
      calendarCell: [".mat-calendar-body-cell"],
      calendarCellContent: [".mat-calendar-body-cell-content"],

      // —— 筛选栏 ——
      showButton: [
        "app-search-filter button[btn-red].search-form-button",
        "button[btn-red].search-form-button",
        ".search-form-container button[btn-red]",
        ".list-submit-buttons button[btn-red]",
        "button[btn-red].uppercase",
      ],
      showButtonLabels: ["显示", "顯示", "show", "search", "apply"],
      filterScope: ["app-search-filter", ".search-form-container"],

      // —— 表格 ——
      headerRow: ["thead .mat-mdc-header-row", ".mat-mdc-header-row", ".mat-header-row", "thead tr"],
      selectAll: [
        "input.mdc-checkbox__native-control",
        "input[type='checkbox']",
        ".mdc-checkbox__background",
        ".mat-checkbox-frame",
      ],
      sessionsScope: ["app-sessions", ".table-wrapper"],
      spinner: ["app-page-spinner#session-spinner", "app-page-spinner", ".page-spinner"],
      noDataLabels: ["没有数据", "沒有數據", "no data", "无数据", "無數據"],

      // —— 选中数量超限 ——
      // GG 对"一次能选多少场"有上限，超了会在页面上弹提示并拒绝下载。
      // 具体数字我们不猜，从这条提示里读（下面 limitErrorLabels 用来找它，
      // 数字由代码从文案里解析）。文案随时可能改，所以放在可远程更新的规则里。
      limitErrorLabels: [
        // 选中过多时的报错
        "超过允许的最大数量",
        "超出允许的最大数量",
        "超过允许",
        "超過允許",
        "最大数量",
        "最大數量",
        "exceeds the maximum",
        "exceed the maximum",
        "maximum number",
        "too many",
        // 官方"下载限制"弹窗（超限时会弹出来，带遮罩挡住整页）
        "最多可下载",
        "最多可下載",
        "you can download at most",
        "download limit",
      ],
      // "下载限制"弹窗本身：带遮罩，不关掉的话用户和插件都点不到任何东西
      limitDialogLabels: ["下载限制", "下載限制", "download limit"],
      limitDialogClose: [
        "mat-dialog-container button[mat-dialog-close]",
        "mat-dialog-container .close",
        "mat-dialog-container button",
        ".cdk-overlay-container .close",
        ".cdk-overlay-container button[aria-label='Close']",
        ".cdk-overlay-container button[aria-label='关闭']",
      ],
      // 提示可能出现在弹窗、吐司或筛选区里，这里给几个常见容器
      limitErrorScope: [
        ".cdk-overlay-container",
        "mat-dialog-container",
        "simple-snack-bar",
        ".mat-mdc-snack-bar-label",
        "app-search-filter",
        "app-sessions",
      ],

      // 任意模态弹窗（点下载后 GG 可能还会弹确认/准备中的框，
      // 没处理完就推进时间等于这一批根本没下到）
      dialogContainer: [
        "mat-dialog-container",
        ".cdk-overlay-container [role='dialog']",
        ".cdk-overlay-container .cdk-overlay-pane",
      ],
      // 点完下载后 GG 可能只转圈准备文件（不弹框）。
      // 转圈期间文件还没生成，这时推进时间等于这一批没下到。
      busySpinner: [
        "mat-spinner",
        "mat-progress-spinner",
        ".mat-mdc-progress-spinner",
        "mat-progress-bar",
        ".mat-mdc-progress-bar",
        "app-page-spinner",
        ".page-spinner",
        ".cdk-overlay-container .spinner",
        ".cdk-overlay-container [class*='loading']",
      ],

      // 判定"确实是挡住页面的模态框"，而不是下拉菜单/提示气泡
      modalBackdrop: [".cdk-overlay-backdrop.cdk-overlay-backdrop-showing", ".cdk-overlay-dark-backdrop"],

      // 表格里每一行自己的复选框（单日超限时要改成只选前 N 行）
      rowCheckbox: ["tbody tr input.mdc-checkbox__native-control", "tbody tr input[type='checkbox']"],

      // —— 下载按钮 ——
      summaryButton: [
        "app-download-button-game-session-summary button",
        "app-download-button-game-session-summary .btn-download",
      ],
      historyButton: [
        "app-download-button-game-session-hand button",
        "app-download-button-game-session-hand .btn-download",
      ],
      downloadCountText: ["small"],

      // 判断页面用的是不是 MDC 版 Material，只用于自检报告
      mdcProbe: [".mat-mdc-header-row", ".mat-mdc-select"],
    },
  };

  // 规则更新地址。页面结构变了之后，在这里放一份新 JSON 即可，不用发新版插件。
  // 用户也可以在 storage 里改 ggRulesUrl 指到自己的地址。
  const RULES_URL = "https://gateway.rtgto.net/extension/open/pokercraft-rules.json";

  /**
   * 校验一份规则是否可用。
   * 远端内容不可全信 —— 格式不对就退回当前规则，绝不能因为一份坏 JSON
   * 把本来能用的插件搞瘫。
   */
  function validateRules(rules) {
    if (!rules || typeof rules !== "object") return "不是对象";
    if (typeof rules.version !== "number" || !(rules.version > 0)) return "version 无效";
    if (!rules.selectors || typeof rules.selectors !== "object") return "缺少 selectors";

    // 关键选择器一个都不能少，否则整个流程跑不起来
    const required = [
      "dateSelectFallback",
      "selectTrigger",
      "openOptions",
      "customRangeLabels",
      "dateRangeInputs",
      "showButton",
      "headerRow",
      "selectAll",
      "summaryButton",
      "historyButton",
    ];
    for (const key of required) {
      const v = rules.selectors[key];
      if (!Array.isArray(v) || v.length === 0) return `selectors.${key} 必须是非空数组`;
      if (!v.every((x) => typeof x === "string" && x.trim())) {
        return `selectors.${key} 里有非字符串项`;
      }
    }

    // 选择器语法必须合法，否则运行时每次 querySelector 都抛异常
    const cssKeys = [
      "dateSelectFallback",
      "selectTrigger",
      "openOptions",
      "dateRangeInputs",
      "showButton",
      "headerRow",
      "selectAll",
      "summaryButton",
      "historyButton",
    ];
    for (const key of cssKeys) {
      for (const sel of rules.selectors[key]) {
        try {
          document.querySelector(sel);
        } catch (e) {
          return `selectors.${key} 里的 "${sel}" 不是合法 CSS 选择器`;
        }
      }
    }

    if (rules.pageTypes) {
      for (const [k, pattern] of Object.entries(rules.pageTypes)) {
        try {
          new RegExp(pattern);
        } catch (e) {
          return `pageTypes.${k} 不是合法正则: ${pattern}`;
        }
      }
    }
    return null; // 通过
  }

  /** 远端规则可以只给要改的字段，其余沿用内置默认值。 */
  function mergeRules(base, patch) {
    return {
      ...base,
      ...patch,
      pageTypes: { ...base.pageTypes, ...(patch.pageTypes || {}) },
      selectors: { ...base.selectors, ...(patch.selectors || {}) },
    };
  }

  const RulesModule = {
    DEFAULT_RULES,
    RULES_URL,
    STORAGE_KEY: "ggRules",
    URL_STORAGE_KEY: "ggRulesUrl",
    validateRules,
    mergeRules,
  };

  if (typeof window !== "undefined") window.GG_RULES = RulesModule;
  if (typeof self !== "undefined") self.GG_RULES = RulesModule;
})();
