// tools/check_load_order.js
// 加载顺序一致性检查（打包前必跑；build.py 会自动调用）。
//
// 起因：content script 的文件清单在仓库里存在**三份互不引用的独立副本** ——
//   1. manifest.json 的 content_scripts
//   2. sidepanel.js 的 CONTENT_SCRIPT_FILES（重装扩展后"现场补注入"用）
//   3. tools/check_api.js 的模块加载清单（静态检查用）
//
// 它们必须逐字一致、顺序一致。走神了不会报任何错：
// 第 2 份指错文件，症状是点"开始"没反应、控制台一片安静 ——
// 正是 sidepanel.js 里那段注释描述过的老毛病。
//
// 所以把这份一致性用代码锁死。改目录结构时改坏了，这里会红。
//
// 用法：node tools/check_load_order.js

const fs = require("fs");
const path = require("path");

const SRC = path.resolve(__dirname, "..", "extension");
const problems = [];

// 扩展在**任意上下文**里会加载的全部脚本（扩展根相对路径）。
// content script、MAIN world、importScripts、侧边栏 <script src> 汇总。
// 用来校验工具的加载清单没有指向一个扩展根本不会加载的文件。
const allLoaded = new Set();

function toExtRel(absPath) {
  return path.relative(SRC, absPath).split(path.sep).join("/");
}

function fail(msg) {
  problems.push(msg);
}

function read(rel) {
  const full = path.join(SRC, rel);
  if (!fs.existsSync(full)) {
    fail(`文件不存在: ${rel}`);
    return null;
  }
  return fs.readFileSync(full, "utf8");
}

/** 从 JS 源码里抠出 `const NAME = ['a','b'];` 的字符串数组。 */
function extractArrayLiteral(src, constName, where) {
  const re = new RegExp("const\\s+" + constName + "\\s*=\\s*\\[([\\s\\S]*?)\\]");
  const m = src.match(re);
  if (!m) {
    fail(`${where}: 找不到 ${constName}`);
    return null;
  }
  return [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
}

function sameArray(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// 浏览器只认正斜杠。Windows 上 path.resolve 能识别反斜杠，于是带反斜杠的引用
// 在这里能通过、到 Chrome 那边却找不到文件。这类错必须单独拦。
// （build.py 开头那段注释就是为这个坑写的。）
function checkSlashes(ref, where) {
  if (ref.includes("\\")) {
    fail(`${where} 的引用含反斜杠，Chrome 无法解析: ${ref}`);
  }
}

// ---- 1. manifest 里声明的两组 content script ----------------------------
const manifestSrc = read("manifest.json");
if (!manifestSrc) {
  console.error(problems.join("\n"));
  process.exit(1);
}
const manifest = JSON.parse(manifestSrc);

const cs = manifest.content_scripts || [];
const mainWorld = cs.find((e) => e.world === "MAIN");
const isolated = cs.find((e) => e.world !== "MAIN");

if (!mainWorld) fail('manifest.json: 找不到 world:"MAIN" 的 content_scripts 条目');
if (!isolated) fail("manifest.json: 找不到隔离世界的 content_scripts 条目");

const MAIN_FILES = mainWorld ? mainWorld.js : [];
const ISOLATED_FILES = isolated ? isolated.js : [];

// manifest 引用的每个文件都得真实存在
for (const f of [...MAIN_FILES, ...ISOLATED_FILES]) {
  checkSlashes(f, "manifest.json");
  if (!fs.existsSync(path.join(SRC, f))) fail(`manifest.json 引用的文件不存在: ${f}`);
  allLoaded.add(f);
}

// ---- 2. sidepanel.js 的现场补注入清单必须和 manifest 完全一致 ----------
const sidepanelSrc = read("sidepanel/sidepanel.js");
if (sidepanelSrc) {
  const injected = extractArrayLiteral(sidepanelSrc, "CONTENT_SCRIPT_FILES", "sidepanel.js");
  const injectedMain = extractArrayLiteral(sidepanelSrc, "MAIN_WORLD_FILES", "sidepanel.js");

  if (injected && !sameArray(injected, ISOLATED_FILES)) {
    fail(
      "sidepanel.js 的 CONTENT_SCRIPT_FILES 与 manifest.json 的 content_scripts 不一致\n" +
        `    manifest     : [${ISOLATED_FILES.join(", ")}]\n` +
        `    sidepanel.js : [${injected.join(", ")}]\n` +
        "    后果：重装扩展后现场补注入失效，界面点了没反应且无报错。",
    );
  }
  if (injectedMain && !sameArray(injectedMain, MAIN_FILES)) {
    fail(
      "sidepanel.js 的 MAIN_WORLD_FILES 与 manifest.json 的 MAIN world 条目不一致\n" +
        `    manifest     : [${MAIN_FILES.join(", ")}]\n` +
        `    sidepanel.js : [${injectedMain.join(", ")}]`,
    );
  }
}

// ---- 3. sidepanel.html 的 <script src> 必须都存在 ----------------------
const htmlSrc = read("sidepanel/sidepanel.html");
if (htmlSrc) {
  const srcs = [...htmlSrc.matchAll(/<script[^>]+src=["']([^"']+)["']/g)].map((m) => m[1]);
  if (srcs.length === 0) fail("sidepanel.html: 一个 <script src> 都没找到，解析可能失效");
  for (const s of srcs) {
    if (/^https?:|^\/\//.test(s)) continue; // 外链不管
    checkSlashes(s, "sidepanel.html");
    // 相对 sidepanel.html 自身解析
    const full = path.resolve(path.join(SRC, "sidepanel"), s);
    if (!fs.existsSync(full)) fail(`sidepanel.html 引用的脚本不存在: ${s}`);
    else allLoaded.add(toExtRel(full));
  }
}

// ---- 4. background.js 的 importScripts 必须都存在 ----------------------
const bgSrc = read("background/background.js");
if (bgSrc) {
  const m = bgSrc.match(/importScripts\(([^)]*)\)/);
  if (!m) {
    fail("background/background.js: 找不到 importScripts");
  } else {
    const args = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    if (args.length === 0) fail("background/background.js: importScripts 参数为空");
    for (const a of args) {
      checkSlashes(a, "background.js 的 importScripts");
      // 相对 service worker 自身解析
      const full = path.resolve(path.join(SRC, "background"), a);
      if (!fs.existsSync(full)) fail(`background.js 的 importScripts 目标不存在: ${a}`);
      else allLoaded.add(toExtRel(full));
    }
  }
}

// ---- 5. manifest 其余引用（side_panel / icons / web_accessible）--------
const misc = [];
misc.push(...Object.values(manifest.icons || {}));
misc.push(...Object.values((manifest.action || {}).default_icon || {}));
if (manifest.background && manifest.background.service_worker) {
  misc.push(manifest.background.service_worker);
}
if (manifest.side_panel && manifest.side_panel.default_path) {
  misc.push(manifest.side_panel.default_path);
}
for (const r of (manifest.web_accessible_resources || []).flatMap((w) => w.resources || [])) {
  if (r.endsWith("/*")) {
    const dir = path.join(SRC, r.slice(0, -2));
    if (!fs.existsSync(dir)) fail(`web_accessible_resources 目录不存在: ${r}`);
  } else if (!fs.existsSync(path.join(SRC, r))) {
    fail(`web_accessible_resources 文件不存在: ${r}`);
  }
}
for (const r of misc) {
  checkSlashes(r, "manifest.json");
  if (!fs.existsSync(path.join(SRC, r))) fail(`manifest.json 引用的文件不存在: ${r}`);
}

// ---- 6. check_api.js 的模块加载清单必须都在 ----------------------------
// 注意：check_api.js 和本脚本同在 tools/，不在扩展目录下，不能走 read()
const checkApiPath = path.join(__dirname, "check_api.js");
const checkSrc = fs.existsSync(checkApiPath) ? fs.readFileSync(checkApiPath, "utf8") : null;
if (!checkSrc) {
  fail("tools/check_api.js 不存在");
} else {
  const m = checkSrc.match(/for \(const f of \[([\s\S]*?)\]\)/);
  if (!m) {
    fail("tools/check_api.js: 找不到模块加载清单");
  } else {
    const mods = [...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((x) => x[1]);
    for (const f of mods) {
      if (!fs.existsSync(path.join(SRC, f))) fail(`check_api.js 加载的模块不存在: ${f}`);
      // 必须是扩展在某个上下文里真的会加载的文件。
      // 注意不能要求它全在 content script 清单里 —— rtgto-bridge.js 就不在，
      // 它由 background 的 importScripts 和侧边栏各自加载。
      else if (!allLoaded.has(f)) {
        fail(`check_api.js 加载了扩展任何上下文都不会加载的文件: ${f}`);
      }
    }
    // 落在 content script 清单里的那些，相对顺序必须和 manifest 一致，
    // 否则检查的是一批顺序错乱的文件（共享全局作用域下顺序是有意义的）。
    let cursor = -1;
    for (const f of mods) {
      const at = ISOLATED_FILES.indexOf(f);
      if (at === -1) continue; // 非 content script（如 rtgto-bridge.js），不参与顺序校验
      if (at < cursor) fail(`check_api.js 的加载顺序与 manifest 不一致（${f} 位置提前了）`);
      else cursor = at;
    }
  }
}

// ---- 汇总 --------------------------------------------------------------
if (problems.length) {
  console.error("加载顺序检查失败：");
  for (const p of problems) console.error("  ✗ " + p);
  process.exit(1);
}
console.log("加载顺序检查通过：manifest / sidepanel.js / check_api.js 三份清单一致，引用文件齐全");
