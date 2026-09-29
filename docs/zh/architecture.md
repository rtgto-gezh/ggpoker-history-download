# 代码结构

**[English](../en/architecture.md)** | 中文

[设计思路](design.md) 讲的是**为什么这么设计**，本篇讲**代码放在哪、怎么串起来**。

## 1. 源码在哪

扩展源码在仓库的 [`extension/`](../../extension/) 目录，那一层直接包含 `manifest.json`，可以用 Chrome 的「加载已解压的扩展程序」选中它。

构建产物在 Releases，也可以用 `python tools/build.py` 自己打。

## 2. 按运行上下文分目录

Chrome 扩展的代码跑在几个互相隔离的环境里，读代码时最先要建立的就是这个心智模型。所以目录是按**跑在哪**分的：

| 目录 | 跑在哪 | 职责 |
| --- | --- | --- |
| `background/` | service worker | 登录鉴权、与实时GTO 通信 |
| `content/` | 注入到 PokerCraft 页面 | 同步主控、DOM 适配、选择器规则表、网络探针 |
| `shared/` | 上面两处 + 侧边栏都加载 | 下载限制、同步水位线、下载记录 |
| `sidepanel/` | 侧边栏页面 | 界面与文案 |

几个容易混的点：

- **`network-probe.js` 单独跑在 MAIN world**，也就是页面自己的 JS 环境。它要在页面调用 `fetch`/`XMLHttpRequest` 之前把它们包一层，统计在途请求数——这是判断"列表加载完了没"的确定性信号。其余 content script 都在隔离世界，两者靠 DOM 上的 `data-*` 属性互通。
- **`shared/` 里的文件不属于某一个环境**。比如 `download-ledger.js`，content script 用它写记录，侧边栏用它读和导出，service worker 也加载它。
- **`pokercraft-dom.js` 不含任何具体选择器**。选择器全在 `pokercraft-rules.js` 的规则表里，前者只负责"怎么用规则找元素"。这样页面改版时改的是数据，不是代码。

## 3. 一次同步的数据流

```
侧边栏（你点「开始同步」）
   │  chrome.tabs.sendMessage
   ▼
content-script.js ── 主循环：选日期 → 等列表 → 提示你点下载 → 记流水账 → 推进水位线
   │                        │                    │
   │                        │                    └─► download-ledger.js（每段日期的处理结果）
   │                        └─► pokercraft-dom.js + pokercraft-rules.js（操作页面）
   ▼
background.js ── 下载完成后把文件交给本机实时GTO
   │  HTTP 127.0.0.1
   ▼
实时GTO 解析核对 → 返回漏下的日期区间
   │
   ▼
content-script.js ── 按区间补下载
```

水位线（"已同步至哪天"）**只在真正下载成功之后才推进**。宁可下次重下一批，也不能因为中途失败却推进了水位线而永久漏掉那几天。这条约束决定了主循环里很多看起来绕的地方。

## 4. 加载顺序是硬约束

隔离世界的几个 content script **共享同一个全局作用域**——它们不是一个模块系统，后面的文件直接用前面文件挂在 `window` 上的对象（`GG_LIMITS`、`GGDom`、`GG_SYNC`、`GG_LEDGER`）。所以顺序不能乱，也不能随便拆文件。

麻烦的是，这份顺序在仓库里写在**三个地方**：

1. `extension/manifest.json` 的 `content_scripts`
2. `extension/sidepanel/sidepanel.js` 的 `CONTENT_SCRIPT_FILES`
3. `tools/check_api.js` 的模块加载清单

第 2 份是给"扩展重装后，已经打开的页面里没有 content script"这个场景用的——侧边栏会用 `chrome.scripting` 现场补注入一次。它和 manifest 走神时**不会报任何错**，症状就是老代码里遇到过的那句话：点「开始同步」界面没反应，控制台一片安静。

所以有 `tools/check_load_order.js` 强制三者逐字一致，打包时自动跑。

## 5. 页面改版了怎么办

`extension/content/pokercraft-rules.js` 是内置规则表，但它可以在运行时被远端版本替换：远端规则的 `version` 大于当前生效版本时才会被采用，版本号只增不减。

这是为 PokerCraft 上次从 Angular Material 传统版升级到 MDC 那类改版准备的——当时写死在代码里的类名全部作废，用户只能等新版本发布过审。抽出规则表之后，服务端放一份新 JSON 就能让已安装的用户恢复。

规则表里的选择器数组按顺序尝试、命中即止，所以**新结构放前面、旧结构放后面**做兼容。`extension/rules/pokercraft-rules.sample.json` 是给服务端参考的模板，不打进安装包。

## 6. 构建与静态检查

```bash
python tools/build.py        # 打包，产物在仓库根 gg-download-<version>.zip
npx --yes prettier --write extension tools   # 格式化
```

打包前自动跑两道检查，任一不过就中止：

| 检查 | 防的是什么 |
| --- | --- |
| `tools/check_api.js` | 调用了不存在的成员（`L.xxx`、`D.xxx` 等） |
| `tools/check_load_order.js` | 三份加载顺序副本走神、引用指向不存在的文件 |

`check_api.js` 的由来写在它自己的注释里：重写 `gg-limits.js` 时误删了一个只在"跨进手牌 3 个月窗口"时才调用到的方法，平时测试都走不到，线上同步跑到那一步直接崩溃中断。这类"调用了不存在的方法"静态扫一遍就能全抓出来。

## 7. 已知问题

- `background/background.js` 开头有一份内联的 `I18N` 字典，`sidepanel/i18n.js` 里另有一份，两者内容已经不完全一致。合并属于逻辑重构，尚未进行。
- `content/content-script.js` 约 3600 行，其中主循环 `loopDownload` 一个函数就占了约 1000 行。拆分需要真实的端到端验证条件，尚未进行。
