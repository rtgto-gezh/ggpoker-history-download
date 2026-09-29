// tools/check_api.js
// 打包前的静态检查：代码里调用的 L.xxx / D.xxx / GG_SYNC.xxx 等成员都必须真的存在。
//
// 起因：重写 gg-limits.js 时误删了 rescaleSpanForCap。它只在"跨进手牌 3 个月窗口"
// 时才调用，平时的测试都没走到，结果线上同步跑到那一步直接崩溃中断。
// 这类"调用了不存在的方法"不用真跑流程，静态扫一遍就能全部抓出来。
//
// 用法：node tools/check_api.js   （build.py 会自动调用；失败时退出码为 1）

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const ROOT = path.resolve(__dirname, "..", "extension");

// 这几个模块加载时不碰 DOM，用最小的 window 桩就能把导出对象拿到
const ctx = {
  console,
  Date,
  Math,
  JSON,
  Object,
  Array,
  String,
  Number,
  RegExp,
  isNaN,
  Error,
  Promise,
  chrome: { storage: { local: { get() {}, set() {} } }, runtime: { lastError: null } },
  document: {
    querySelector() {
      return null;
    },
  },
};
ctx.window = ctx;
ctx.self = ctx;
vm.createContext(ctx);
for (const f of [
  "shared/gg-limits.js",
  "shared/sync-state.js",
  "shared/download-ledger.js",
  "shared/rtgto-bridge.js",
  "content/pokercraft-rules.js",
  "content/pokercraft-dom.js",
]) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), "utf8"), ctx, { filename: f });
}

const OBJS = {
  "L.AUTO": ctx.GG_LIMITS && ctx.GG_LIMITS.AUTO,
  L: ctx.GG_LIMITS,
  D: ctx.GGDom,
  GG_SYNC: ctx.GG_SYNC,
  GG_LEDGER: ctx.GG_LEDGER,
  Ledger: ctx.GG_LEDGER, // 侧边栏里的别名
  Bridge: ctx.GG_RTGTO, // 实时GTO 通信
  "window.GG_RULES": ctx.GG_RULES,
};
for (const [name, obj] of Object.entries(OBJS)) {
  if (!obj) {
    console.error(`✗ ${name} 没有加载出来，检查对应文件是否正常导出`);
    process.exit(1);
  }
}

const FILES = [
  "content/content-script.js",
  "sidepanel/sidepanel.js",
  "shared/gg-limits.js",
  "content/pokercraft-dom.js",
  "shared/download-ledger.js",
];
let problems = 0;
let checked = 0;

for (const f of FILES) {
  const src = fs.readFileSync(path.join(ROOT, f), "utf8");
  for (const [name, obj] of Object.entries(OBJS)) {
    const re = new RegExp("(?<![\\w.])" + name.replace(/\./g, "\\.") + "\\.([A-Za-z_][A-Za-z0-9_]*)", "g");
    const seen = new Set();
    for (const m of src.matchAll(re)) {
      const key = m[1];
      if (seen.has(key)) continue;
      seen.add(key);
      checked++;
      if (!(key in obj)) {
        problems++;
        const line = src.slice(0, m.index).split("\n").length;
        console.error(`✗ ${f}:${line}  ${name}.${key} 不存在`);
      }
    }
  }
}

if (problems) {
  console.error(`接口检查失败：${problems} 处调用了不存在的成员（共检查 ${checked} 个）`);
  process.exit(1);
}
console.log(`接口检查通过：${checked} 个成员引用都有定义`);
