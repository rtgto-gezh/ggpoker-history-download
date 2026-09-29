# Code Structure

[中文](../zh/architecture.md) | **English**

[Design Notes](design.md) explains **why the product is built this way**. This page explains **where the code lives and how the pieces connect**.

## 1. Where the source is

The extension source lives in [`extension/`](../../extension/). That directory contains `manifest.json` directly, so Chrome's "Load unpacked" can point at it.

Builds are published on Releases, or you can produce one yourself with `python tools/build.py`.

## 2. Directories follow runtime context

A Chrome extension's code runs in several isolated environments, and that is the first mental model a reader needs. So the directories are split by **where the code runs**:

| Directory | Runs in | Responsibility |
| --- | --- | --- |
| `background/` | service worker | authentication, talking to RealtimeGTO |
| `content/` | injected into the PokerCraft page | sync loop, DOM adapter, selector rule table, network probe |
| `shared/` | all of the above plus the side panel | download limits, sync watermark, download ledger |
| `sidepanel/` | side panel page | UI and strings |

Three things that are easy to mix up:

- **`network-probe.js` runs in the MAIN world** — the page's own JS environment. It must wrap `fetch`/`XMLHttpRequest` before the page uses them, so it can count in-flight requests. That count is the reliable signal for "has the list finished loading". Every other content script runs in the isolated world; the two sides talk through `data-*` attributes on the DOM.
- **Files in `shared/` do not belong to one environment.** `download-ledger.js`, for example: the content script writes records with it, the side panel reads and exports them, and the service worker loads it too.
- **`pokercraft-dom.js` contains no concrete selectors.** They all live in the rule table in `pokercraft-rules.js`; the DOM adapter only knows how to *use* a rule to find an element. When the page changes, the thing you edit is data, not code.

## 3. Data flow of one sync

```
Side panel (you press "Start sync")
   │  chrome.tabs.sendMessage
   ▼
content-script.js ── main loop: pick dates → wait for the list → prompt you to click download
   │                 → write a ledger record → advance the watermark
   │                        │                    │
   │                        │                    └─► download-ledger.js (outcome per date range)
   │                        └─► pokercraft-dom.js + pokercraft-rules.js (drive the page)
   ▼
background.js ── hands finished downloads to the local RealtimeGTO client
   │  HTTP 127.0.0.1
   ▼
RealtimeGTO parses and verifies → returns the date ranges that are missing
   │
   ▼
content-script.js ── re-downloads those ranges
```

The watermark ("synced through *this date*") **only advances after a download actually succeeds**. It is better to re-download one batch next time than to advance the watermark past a failure and lose those days permanently. That constraint explains a lot of code in the main loop that otherwise looks roundabout.

## 4. Load order is a hard constraint

The isolated-world content scripts **share a single global scope**. They are not a module system: later files use objects that earlier files hang on `window` (`GG_LIMITS`, `GGDom`, `GG_SYNC`, `GG_LEDGER`). So the order matters, and files cannot be split freely.

The awkward part is that this order is written down in **three separate places**:

1. `extension/manifest.json`, in `content_scripts`
2. `extension/sidepanel/sidepanel.js`, in `CONTENT_SCRIPT_FILES`
3. `tools/check_api.js`, in its module load list

The second one exists for the case where the extension was just reloaded and an already-open page has no content script: the side panel injects them on the spot with `chrome.scripting`. When it drifts out of sync with the manifest **nothing reports an error** — the symptom is the one described in the old code comments: you press "Start sync", nothing happens, and the console is silent.

`tools/check_load_order.js` therefore asserts all three are identical, character for character. It runs automatically before packaging.

## 5. When PokerCraft changes its page

`extension/content/pokercraft-rules.js` is the built-in rule table, but it can be replaced at runtime by a remote version: a remote rule set is adopted only when its `version` is greater than the one currently in effect, and the version number only ever increases.

This exists because of what happened when PokerCraft moved from legacy Angular Material to MDC: every class name hardcoded in the source was invalidated at once, and users could only wait for a new extension version to clear review. With the rules extracted into data, publishing a new JSON on the server restores every installed user.

Selector arrays in the rule table are tried in order and stop at the first hit, so **newer structures go first and older ones after**, for compatibility. `extension/rules/pokercraft-rules.sample.json` is the template for the server side and is not shipped in the package.

## 6. Build and static checks

```bash
python tools/build.py                        # package; output at repo root as gg-download-<version>.zip
npx --yes prettier --write extension tools   # formatting
```

Two checks run before packaging, and either one failing aborts the build:

| Check | What it prevents |
| --- | --- |
| `tools/check_api.js` | calls to members that do not exist (`L.xxx`, `D.xxx`, and friends) |
| `tools/check_load_order.js` | the three copies of the load order drifting apart, or references pointing at missing files |

The reason `check_api.js` exists is in its own comments: while rewriting `gg-limits.js` a method was deleted by accident. It was only called when a sync crossed into the 3-month hands window, so no routine test reached it, and the live sync crashed and stopped at that step. A static scan catches that whole class of "called a method that does not exist" bugs without running anything.

## 7. Known issues

- `background/background.js` opens with an inline `I18N` dictionary, and `sidepanel/i18n.js` holds another. Their contents have already drifted apart. Merging them is a logic refactor that has not been done.
- `content/content-script.js` is about 3,600 lines, roughly 1,000 of which are the single function `loopDownload`. Splitting it needs real end-to-end verification, which has not been available.
