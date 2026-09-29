# 扩展源码说明

这一层就是扩展本体：直接包含 `manifest.json`，可以用 Chrome 的「加载已解压的扩展程序」选中它。

上层的 `README.md` 面向使用者，这里面向读代码的人。

## 目录

按**运行上下文**分，而不是按抽象层次——Chrome 扩展里首先要知道的是"这段代码跑在哪"。

| 目录 | 跑在哪 | 内容 |
| --- | --- | --- |
| `background/` | service worker | 登录鉴权、下载记录、与实时GTO 通信 |
| `content/` | 注入页面 | `content-script.js` 是同步主控；`pokercraft-dom.js` 是 DOM 适配层；`pokercraft-rules.js` 是内置选择器规则表；`network-probe.js` 单独跑在 MAIN world |
| `shared/` | 三者都加载 | content script、service worker、侧边栏共用：下载限制、同步水位线、下载记录、实时GTO 桥 |
| `sidepanel/` | 侧边栏页面 | 界面、文案字典 |
| `rules/` | —— | 给服务端参考的规则模板，不打进安装包 |
| `icons/` | —— | 图标 |

## 加载顺序有约束，而且写在三个地方

隔离世界的 content script 共享同一个全局作用域，**顺序有意义**：后面的文件依赖前面文件挂到 `window` 上的对象（`GG_LIMITS`、`GGDom`、`GG_SYNC`、`GG_LEDGER`）。

这份顺序在仓库里存在**三份互不引用的副本**：

1. `manifest.json` 的 `content_scripts`
2. `sidepanel/sidepanel.js` 的 `CONTENT_SCRIPT_FILES`（重装扩展后"现场补注入"用）
3. `tools/check_api.js` 的模块加载清单（静态检查用）

第 2 份走神不会报任何错：症状是点「开始同步」没反应、控制台一片安静。所以有 `tools/check_load_order.js` 强制三者一致——**改目录结构时它会把漏改的地方点出来**，别绕过它。

## 构建

```bash
python tools/build.py
```

产物在仓库根目录 `gg-download-<version>.zip`。打包前会先跑两道静态检查（接口检查、加载顺序检查），任一不过就中止。

`tools/build.py` 里有一段关于 Windows 下 `Compress-Archive` 写反斜杠路径的说明，改打包逻辑前值得先读。

## 格式化

```bash
npx --yes prettier --write extension tools
```

配置见仓库根的 `.prettierrc`（与原先 `.vscode/settings.json` 一致）。仓库**不引入 npm 依赖**，`tools/check_api.js` 用裸 `node` 就能跑，装不装 prettier 都能构建。

## 已知问题

- `background/background.js` 开头有一份内联的 `I18N` 字典，`sidepanel/i18n.js` 里另有一份，两者内容已经不完全一致。合并属于逻辑重构，尚未进行。
- `icons/icon64.png`、`icon256.png` 没被 manifest 引用，但会打进安装包。无害。
