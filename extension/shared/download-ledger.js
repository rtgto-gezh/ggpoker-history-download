// download-ledger.js
// 下载记录：按"页面类型 × 数据类型"逐条记下每一段日期是怎么处理的。
// content script 负责写，侧边栏负责展示和导出。
//
// 为什么要有它：扩展只能看到"用户点了下载按钮"，看不到文件到底有没有下成功 ——
// 网络一断，GG 那边的下载就失败了，而扩展照样以为这段已经同步过。
// 所以把每一段日期的处理结果完整留档，导出给实时GTO（RtGTO）分析模块，
// 用实际导入的数据去核对哪几段缺了。
//
// 每条记录的 status：
//   clicked  用户点了下载，GG 的后续弹窗也处理完了（文件是否到手扩展无法确认）
//   no_data  页面确认这段日期没有对局，不需要下载
//   failed   这段日期没能完成下载（页面异常、按钮失效等），需要补
//
// 实时GTO核对出漏下的区间后，导入它的结果（parseMissing），扩展按 planRepair 切段补下载；
// 补下载的记录 mode=repair，不会改动同步进度（水位线）。
//
// 日期都是 PokerCraft 筛选框里的日期（YYYY-MM-DD，含首尾两天），按浏览器本地时区。

(function () {
  "use strict";

  const STORAGE_KEY = "ggDownloadLedger";
  // 一整年的同步大约一两百条，留 8000 条足够；再多就丢最旧的，免得撑爆 storage 配额
  const MAX_ENTRIES = 8000;

  // 超过上限时删最旧的，但"没下到 / 失败"的记录留到最后才删：补下载清单靠它们，
  // 删掉了那段日期就再也不会被补（重启浏览器也不会丢，记录都在本地存储里）
  function trimOldest(list, n) {
    const bad = (e) => e.status === "failed" || (e.verify && VERIFY_BAD.includes(e.verify.status));
    for (let i = 0; i < list.length && n > 0;) {
      if (!bad(list[i])) {
        list.splice(i, 1);
        n--;
      } else i++;
    }
    if (n > 0) list.splice(0, n);
  }
  const FORMAT_VERSION = 1;

  const KINDS = ["summary", "history"];
  const PAGE_TYPES = ["tournament", "rushAndCash", "holdem", "plo"];

  function readAll() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        const list = res && res[STORAGE_KEY];
        resolve(Array.isArray(list) ? list : []);
      });
    });
  }

  function writeAll(list) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: list }, () => {
        if (chrome.runtime.lastError) {
          console.error("[下载记录] 保存失败:", chrome.runtime.lastError);
        }
        resolve();
      });
    });
  }

  /** 带时区偏移的本地时间，例如 2026-09-24T10:29:43+08:00 */
  function localIso(ts) {
    const d = new Date(ts);
    const p = (n) => String(Math.abs(n)).padStart(2, "0");
    const off = -d.getTimezoneOffset();
    return (
      `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
      `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}` +
      `${off >= 0 ? "+" : "-"}${p(Math.floor(Math.abs(off) / 60))}:${p(Math.abs(off) % 60)}`
    );
  }

  // 写入串行化：同一页面里连续 add 时，读-改-写不能交错，否则会丢记录
  let chain = Promise.resolve();

  const makeId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // 实时GTO核对后判定为"没下到"的状态；count_diff 只是条数对不上，算警告不算缺
  const VERIFY_BAD = ["interrupted", "not_detected", "file_missing", "unreadable", "wrong_kind", "wrong_range"];

  /**
   * 一条记录"实际上"算什么：点了下载但浏览器下载中断、或实时GTO核对没找到文件，
   * 都按 failed 算 —— 这几天需要补。
   */
  function effectiveStatus(e) {
    if (e.status !== "clicked") return e.status;
    if (e.verify && VERIFY_BAD.includes(e.verify.status)) return "failed";
    if (e.download && e.download.state === "interrupted") return "failed";
    return "clicked";
  }

  // —— 日期区间运算（按天） ——

  const DAY = 86400000;
  const toDay = (s) => Math.round(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)) / DAY);
  const fromDay = (n) => new Date(n * DAY).toISOString().slice(0, 10);

  /** 一组 {from,to} 展开成天的集合 */
  function daySet(ranges) {
    const set = new Set();
    for (const r of ranges) {
      if (!r.from || !r.to) continue;
      for (let d = toDay(r.from), e = toDay(r.to); d <= e; d++) set.add(d);
    }
    return set;
  }

  /** 天的集合合并回连续区间 */
  function toRanges(set) {
    const days = [...set].sort((a, b) => a - b);
    const out = [];
    for (const d of days) {
      const last = out[out.length - 1];
      if (last && d === last.e + 1) last.e = d;
      else out.push({ s: d, e: d });
    }
    return out.map((r) => ({ from: fromDay(r.s), to: fromDay(r.e), days: r.e - r.s + 1 }));
  }

  const Ledger = {
    STORAGE_KEY,
    FORMAT_VERSION,
    KINDS,
    PAGE_TYPES,
    localIso,

    /**
     * 追加一条记录。必填：pageType, kind, from, to, status。
     * 其余字段（runId, batch, count, rows, chunk, rowRange, availableFrom, settled, note）可选。
     */
    add(entry) {
      const rec = Object.assign(
        {
          mode: "sync", // sync 正常同步 / repair 按核对结果补下载
          runId: null,
          batch: null,
          pageType: null,
          kind: null,
          from: null,
          to: null,
          status: null,
          count: null,
          rows: null,
          chunk: null,
          rowRange: null,
          availableFrom: null,
          settled: null,
          note: "",
        },
        entry,
        { id: (entry && entry.id) || makeId(), at: localIso(Date.now()) },
      );
      chain = chain.then(async () => {
        const list = await readAll();
        list.push(rec);
        if (list.length > MAX_ENTRIES) trimOldest(list, list.length - MAX_ENTRIES);
        await writeAll(list);
      });
      return chain;
    },

    getAll() {
      return chain.then(readAll);
    },

    clear() {
      chain = chain.then(() => writeAll([]));
      return chain;
    },

    /** 改写全部记录（mutator 返回新数组）。和 add 共用一条串行链，不会互相覆盖。 */
    update(mutator) {
      chain = chain.then(async () => {
        const list = await readAll();
        const next = mutator(list.map((e) => (e.id ? e : Object.assign({}, e, { id: makeId() }))));
        if (Array.isArray(next)) await writeAll(next);
      });
      return chain;
    },

    VERIFY_BAD,
    effectiveStatus,

    /** 等下载开始的宽限期从哪儿算：点击时刻；配错类型被解开后从解开时重新算。 */
    graceStart(e) {
      return Math.max(e.clickedAtMs || 0, e.unpinnedAtMs || 0);
    },

    /**
     * 把浏览器下载（background.js 记的 ggDownloads）按时间对到"点了下载"的记录上。
     *
     * 用户是一次一次按顺序点的，每点一次 GG 就开始一个下载，所以按点击时间排好，
     * 每条取"点击后最早开始、还没被占用"的那个下载即可。已经对上的保持不变，只刷新状态。
     * 返回新数组，每条 clicked 记录多一个 download 字段（对不上的为 null）。
     *
     * 但下载不一定按点击顺序开始：手牌包大，GG 打包慢，下一批概要的下载可能先开始，
     * 按先后配就会两两配反。实时GTO 核对后知道文件实际是什么（download.fileKind，
     * 或配错后记在 rejectedDownloads 里），类型不符的下载不再配给这次点击。
     */
    attachDownloads(list, downloads) {
      const byId = new Map((downloads || []).map((d) => [d.id, d]));
      const used = new Set();
      const out = list.map((e) => Object.assign({}, e));
      for (const e of out) {
        if (e.download && e.download.id != null) {
          used.add(e.download.id);
          const fresh = byId.get(e.download.id);
          if (fresh) e.download = Object.assign({}, e.download, fresh);
        }
      }
      // 实时GTO 告诉过我们的文件类型：summary / history / mixed
      const knownKind = new Map();
      for (const e of out) {
        for (const r of e.rejectedDownloads || []) if (r && r.fileKind) knownKind.set(r.id, r.fileKind);
        if (e.download && e.download.id != null && e.download.fileKind)
          knownKind.set(e.download.id, e.download.fileKind);
      }
      const fits = (e, d) => {
        if ((e.rejectedDownloads || []).some((r) => r && r.id === d.id)) return false;
        const k = knownKind.get(d.id);
        return !k || k === "mixed" || k === e.kind;
      };
      const pool = (downloads || []).filter((d) => !used.has(d.id)).sort((a, b) => a.startTime - b.startTime);
      const clicks = out
        .filter((e) => e.status === "clicked" && e.clickedAtMs && !(e.download && e.download.id != null))
        .sort((a, b) => a.clickedAtMs - b.clickedAtMs);
      const WINDOW = 15 * 60 * 1000;
      for (const e of clicks) {
        const i = pool.findIndex(
          (d) => d.startTime >= e.clickedAtMs - 3000 && d.startTime <= e.clickedAtMs + WINDOW && fits(e, d),
        );
        if (i >= 0) {
          e.download = Object.assign({}, pool[i]);
          pool.splice(i, 1);
        } else if (!e.download) {
          e.download = null;
        }
      }
      return out;
    },

    /**
     * 按"页面类型 × 数据类型"汇总：
     *   covered   点过下载或确认无数据的日期（扩展认为处理过的）
     *   clicked   点过下载的日期
     *   pending   失败过、而且之后也没补上的日期 —— 一定缺数据
     */
    summarize(list) {
      const out = [];
      for (const pageType of PAGE_TYPES) {
        for (const kind of KINDS) {
          const mine = list.filter((e) => e.pageType === pageType && e.kind === kind);
          if (!mine.length) continue;
          const clicked = mine.filter((e) => effectiveStatus(e) === "clicked");
          const noData = mine.filter((e) => e.status === "no_data");
          const failed = mine.filter((e) => effectiveStatus(e) === "failed");
          const allClicked = mine.filter((e) => e.status === "clicked");

          const clickedDays = daySet(clicked);
          const coveredDays = daySet(clicked.concat(noData));
          // 没下到的日期。分趟下载的每一趟只下了其中几行，记录上的日期却是整段：
          // 某一趟下到了不能算别的趟也下到了（不管是不是同一次同步）——以前兄弟趟、
          // 甚至上一次同步的某一趟都会把缺的那一趟"覆盖"掉，补下载的一趟被取消了照样显示完成。
          // 分趟的记录只有整组（同一次、同一批、同一段日期）每一趟都没问题，才算这段日期下齐了。
          const groupKey = (e) => [e.runId || "", e.batch || "", e.from, e.to].join("|");
          const brokenGroups = new Set(mine.filter((e) => e.chunk && effectiveStatus(e) === "failed").map(groupKey));
          const coverList = clicked.concat(noData).filter((x) => !x.chunk || !brokenGroups.has(groupKey(x)));
          const pendingDays = new Set();
          for (const f of failed) {
            const cover = daySet(coverList.filter((x) => x !== f));
            for (const d of daySet([f])) if (!cover.has(d)) pendingDays.add(d);
          }

          out.push({
            pageType,
            kind,
            downloadClicks: allClicked.length,
            itemsSelected: clicked.reduce((n, e) => n + (e.count || 0), 0),
            lastClickedAt: allClicked.length ? allClicked[allClicked.length - 1].at : null,
            // 浏览器报告下载中断的次数（扩展自己就能看到）
            interrupted: allClicked.filter((e) => e.download && e.download.state === "interrupted").length,
            // 实时GTO核对：确认下到的 / 判定没下到的 / 还没核对的
            verifiedOk: allClicked.filter(
              (e) => e.verify && (e.verify.status === "ok" || e.verify.status === "count_diff"),
            ).length,
            verifyBad: allClicked.filter((e) => e.verify && VERIFY_BAD.includes(e.verify.status)).length,
            // 只算能核对的（有点击时间，才能和浏览器下载对上；旧版本记的没有）
            unverified: allClicked.filter((e) => e.clickedAtMs && (!e.verify || e.verify.status === "downloading"))
              .length,
            covered: toRanges(coveredDays),
            clicked: toRanges(clickedDays),
            noData: toRanges(daySet(noData)),
            pending: toRanges(pendingDays),
          });
        }
      }
      return out;
    },

    /** 导出给其他程序核对用的 JSON 对象 */
    buildExport(list, meta) {
      return Object.assign(
        {
          format: "gg-download-ledger",
          formatVersion: FORMAT_VERSION,
          exportedAt: localIso(Date.now()),
          timezone: (Intl.DateTimeFormat().resolvedOptions() || {}).timeZone || null,
          dateSemantics: "from/to 为 PokerCraft 日期筛选的起止日（含首尾），按浏览器本地时区",
          statusSemantics: {
            clicked: "用户点击了下载且 GG 弹窗已处理完；文件是否真正下载成功需另行核实",
            no_data: "页面确认该日期段没有对局，无需下载",
            failed: "该日期段未能完成下载，需要补下",
          },
          // 实时GTO核对完，按这个格式把漏下的区间交回扩展补下载
          missingRangesFormat: {
            format: "gg-missing-ranges",
            formatVersion: 1,
            example: {
              format: "gg-missing-ranges",
              formatVersion: 1,
              missing: [
                { pageType: "tournament", kind: "history", from: "2026-07-01", to: "2026-07-03" },
                { pageType: "plo", from: "2026-08-10", to: "2026-08-10" },
              ],
            },
            notes: "pageType: tournament/rushAndCash/holdem/plo；kind: summary/history，省略表示两类都补",
          },
        },
        meta || {},
        { categories: Ledger.summarize(list), entries: list },
      );
    },

    /**
     * 解析实时GTO分析模块给出的"漏下区间"。
     *
     * 约定格式（也接受直接给数组）：
     *   { "format": "gg-missing-ranges", "formatVersion": 1,
     *     "missing": [ { "pageType": "tournament", "kind": "history", "from": "2026-07-01", "to": "2026-07-03" } ] }
     *
     * pageType 接受 tournament/mtt、rushAndCash/rush、holdem/nlh、plo/omaha；
     * kind 接受 summary / history，不写表示这段日期两类都要补（非 MTT 只有手牌）。
     * 返回 { items, errors }，items 已展开成单一 kind。
     */
    parseMissing(data) {
      const PT = {
        tournament: "tournament",
        mtt: "tournament",
        rushandcash: "rushAndCash",
        "rush-and-cash": "rushAndCash",
        rush: "rushAndCash",
        holdem: "holdem",
        nlh: "holdem",
        plo: "plo",
        omaha: "plo",
      };
      const KD = {
        summary: "summary",
        summaries: "summary",
        history: "history",
        histories: "history",
        hands: "history",
        hand: "history",
        handhistory: "history",
      };
      const isDate = (s) => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s);
      const raw = Array.isArray(data) ? data : data && Array.isArray(data.missing) ? data.missing : null;
      const items = [];
      const errors = [];
      if (!raw) {
        errors.push("找不到 missing 数组");
        return { items, errors };
      }
      raw.forEach((r, i) => {
        const pageType = r && PT[String(r.pageType || "").toLowerCase()];
        if (!pageType) return errors.push(`第 ${i + 1} 条：不认识的 pageType ${r && r.pageType}`);
        if (!isDate(r.from) || !isDate(r.to) || r.from > r.to) {
          return errors.push(`第 ${i + 1} 条：日期不对（${r.from} ~ ${r.to}）`);
        }
        let kinds;
        if (r.kind === undefined || r.kind === null || r.kind === "" || r.kind === "both") {
          kinds = pageType === "tournament" ? ["summary", "history"] : ["history"];
        } else {
          const k = KD[String(r.kind).toLowerCase()];
          if (!k) return errors.push(`第 ${i + 1} 条：不认识的 kind ${r.kind}`);
          if (k === "summary" && pageType !== "tournament") {
            return errors.push(`第 ${i + 1} 条：只有锦标赛有游戏概要`);
          }
          kinds = [k];
        }
        for (const kind of kinds) items.push({ pageType, kind, from: r.from, to: r.to });
      });
      return { items, errors };
    },

    /**
     * 导入的漏下区间里，还有哪些没补上。
     * 导入之后（since 之后）点过下载、或页面确认没数据的日期算补上了。
     * 返回 [{ pageType, kind, ranges:[{from,to,days}] }]，已补完的类别不出现。
     */
    outstanding(items, list, since) {
      const sinceMs = since ? Date.parse(since) : 0;
      const out = [];
      for (const pageType of PAGE_TYPES) {
        for (const kind of KINDS) {
          const want = items.filter((e) => e.pageType === pageType && e.kind === kind);
          if (!want.length) continue;
          const done = daySet(
            list.filter(
              (e) =>
                e.pageType === pageType &&
                e.kind === kind &&
                (effectiveStatus(e) === "clicked" || e.status === "no_data") &&
                Date.parse(e.at) >= sinceMs,
            ),
          );
          const left = new Set([...daySet(want)].filter((d) => !done.has(d)));
          if (left.size) out.push({ pageType, kind, ranges: toRanges(left) });
        }
      }
      return out;
    },

    /**
     * 把某个页面类型的待补区间切成可以直接跑的段：
     * 相邻日期要补的类别相同就并成一段（例如 7/1~7/3 两类都要补、7/4 只补手牌 => 两段）。
     * clamp(kind) 返回该类别能补的最早/最晚日期 { min, max }，超出的部分单独返回，由调用方解释原因。
     */
    planRepair(outstandingList, pageType, clamp) {
      const byDay = new Map();
      const skipped = [];
      for (const c of outstandingList.filter((x) => x.pageType === pageType)) {
        const { min, max } = clamp(c.kind);
        for (const r of c.ranges) {
          for (let d = toDay(r.from), e = toDay(r.to); d <= e; d++) {
            const s = fromDay(d);
            if (min && s < min) {
              skipped.push({ kind: c.kind, day: d, why: "expired" });
              continue;
            }
            if (max && s > max) {
              skipped.push({ kind: c.kind, day: d, why: "not_synced" });
              continue;
            }
            if (!byDay.has(d)) byDay.set(d, new Set());
            byDay.get(d).add(c.kind);
          }
        }
      }
      const days = [...byDay.keys()].sort((a, b) => a - b);
      const segments = [];
      for (const d of days) {
        const kinds = KINDS.filter((k) => byDay.get(d).has(k));
        const last = segments[segments.length - 1];
        if (last && d === last.e + 1 && last.kinds.join() === kinds.join()) last.e = d;
        else segments.push({ s: d, e: d, kinds });
      }
      const group = (why) => {
        const res = [];
        for (const kind of KINDS) {
          const set = new Set(skipped.filter((x) => x.why === why && x.kind === kind).map((x) => x.day));
          if (set.size) res.push({ kind, ranges: toRanges(set) });
        }
        return res;
      };
      return {
        segments: segments.map((g) => ({ from: fromDay(g.s), to: fromDay(g.e), days: g.e - g.s + 1, kinds: g.kinds })),
        expired: group("expired"),
        notSynced: group("not_synced"),
      };
    },

    CSV_COLUMNS: [
      "at",
      "mode",
      "runId",
      "batch",
      "pageType",
      "kind",
      "from",
      "to",
      "status",
      "count",
      "rows",
      "chunk",
      "rowRange",
      "availableFrom",
      "settled",
      "note",
      "id",
      "clickedAt",
      "downloadState",
      "downloadFile",
      "verifyStatus",
      "verifyDetail",
    ],

    toCSV(list) {
      const esc = (v) => {
        if (v === null || v === undefined) return "";
        const s = String(v);
        return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      };
      const cols = Ledger.CSV_COLUMNS;
      const lines = [cols.join(",")];
      // 下载和核对结果是嵌套字段，CSV 里摊平成几列
      const val = (e, c) => {
        if (c === "downloadState") return e.download && e.download.state;
        if (c === "downloadFile") return e.download && e.download.file;
        if (c === "verifyStatus") return e.verify && e.verify.status;
        if (c === "verifyDetail") return e.verify && e.verify.detail;
        return e[c];
      };
      for (const e of list) lines.push(cols.map((c) => esc(val(e, c))).join(","));
      // 带 BOM，Excel 打开中文不乱码
      return "﻿" + lines.join("\r\n") + "\r\n";
    },
  };

  if (typeof window !== "undefined") window.GG_LEDGER = Ledger;
  if (typeof self !== "undefined") self.GG_LEDGER = Ledger;
})();
