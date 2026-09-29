// rtgto-bridge.js
// 和同一台机器上的实时GTO（RtGTO）通信，核对下载是否完整。侧边栏使用。
//
// 实时GTO 开着一个只监听本机（127.0.0.1）的服务，本机请求都接受，不做来源校验（本地便利通道）。
// X-GG-Extension 头只是告诉它扩展版本。
//
//   GET  /gg-bridge/v1/hello   -> { app, protocol, appVersion, downloadDir, backupDir }
//   POST /gg-bridge/v1/verify  -> 按每次"点了下载"对应的浏览器下载文件逐个核对，
//                                 导入并备份下到的文件，返回每条的结果和漏下的区间
//
// 端口固定从 47651 开始试，被占用时实时GTO 会顺延到后面两个。

(function () {
  "use strict";

  const PORTS = [47651, 47652, 47653];
  const BASE = "/gg-bridge/v1";
  const PROTOCOL = 1;
  // 实时GTO 导入上万手时一时顾不上回应，1.5 秒太短会被误当成"没打开"（线上同步因此半路放弃核对）
  const HELLO_TIMEOUT_MS = 5000;
  // 核对时实时GTO 要解析、导入、备份文件，文件多时要一会儿
  const VERIFY_TIMEOUT_MS = 10 * 60 * 1000;

  let port = null; // 上次连通的端口

  // 探测时带上扩展版本，实时GTO 据此显示「扩展已连接（v…）」
  function extVersion() {
    try {
      return typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.getManifest
        ? chrome.runtime.getManifest().version
        : "";
    } catch (e) {
      return "";
    }
  }

  // 构建编号（build.py 打包时写入 build-info.json）。版本号测试期间不变，
  // 实时GTO 靠它判断这份扩展是不是比它内置的旧。没有这个文件（旧版扩展）按 0 算。
  let buildInfo = null;
  async function loadBuildInfo() {
    if (buildInfo) return buildInfo;
    try {
      const res = await fetch(chrome.runtime.getURL("build-info.json"));
      buildInfo = res.ok ? await res.json() : {};
    } catch (e) {
      buildInfo = {};
    }
    return buildInfo;
  }

  async function request(p, path, opts, timeoutMs) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      // 顺带告诉实时GTO 扩展版本和构建编号（它据此显示「扩展已连接」和「版本过低」）
      const b = await loadBuildInfo();
      const headers = Object.assign(
        { "X-GG-Extension": `${extVersion() || "1"}+${b.build || 0}` },
        (opts && opts.headers) || {},
      );
      const res = await fetch(
        `http://127.0.0.1:${p}${BASE}${path}`,
        Object.assign({ signal: ctrl.signal }, opts, { headers }),
      );
      const body = await res.json().catch(() => null);
      if (!res.ok) {
        const msg = (body && body.error) || `HTTP ${res.status}`;
        throw new Error(msg);
      }
      return body;
    } finally {
      clearTimeout(timer);
    }
  }

  const Bridge = {
    PORTS,
    PROTOCOL,

    /** 这份扩展的构建信息 { version, build, commit }；旧版扩展没有，build 为 0。 */
    buildInfo: loadBuildInfo,

    /**
     * 实时GTO 内置的扩展是不是比这份新。hello 的回应里带着 bundledExtension。
     * 返回 null 表示没法判断（实时GTO 太旧、没带这个信息）。
     */
    async outdated(helloInfo) {
      const bundled = helloInfo && helloInfo.bundledExtension;
      if (!bundled || (!bundled.build && !bundled.version)) return null;
      const mine = (await loadBuildInfo()).build || 0;
      const old = { mine, latest: bundled.build || 0, mineVersion: extVersion(), latestVersion: bundled.version || "" };
      // 先比版本号：高于实时GTO 内置的不提醒，低于就提醒；相同再比构建编号的先后
      const cmp = Bridge.compareVersions(extVersion(), bundled.version || "");
      if (cmp > 0) return false;
      if (cmp < 0) return old;
      return mine < (bundled.build || 0) ? old : false;
    },

    /** "1.2.10" 和 "1.2.9" 按数字逐段比；返回 -1 / 0 / 1。空的算 0。 */
    compareVersions(a, b) {
      const pa = String(a || "")
        .split(".")
        .map((x) => parseInt(x, 10) || 0);
      const pb = String(b || "")
        .split(".")
        .map((x) => parseInt(x, 10) || 0);
      for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d) return d > 0 ? 1 : -1;
      }
      return 0;
    },

    /** 找到正在运行的实时GTO。连不上返回 { ok: false }，不抛异常。 */
    async hello() {
      const order = port ? [port].concat(PORTS.filter((x) => x !== port)) : PORTS;
      for (const p of order) {
        try {
          const b = await loadBuildInfo();
          const info = await request(
            p,
            `/hello?ext=${encodeURIComponent(extVersion())}&build=${b.build || 0}`,
            { method: "GET" },
            HELLO_TIMEOUT_MS,
          );
          if (info && info.app === "RtGTO") {
            port = p;
            return { ok: true, port: p, info };
          }
        } catch (e) {
          /* 这个端口没有，试下一个 */
        }
      }
      port = null;
      return { ok: false };
    },

    /**
     * 把"点了下载"的记录交给实时GTO核对。
     * entries 里每条带 download（浏览器下载的文件路径和状态），实时GTO 按文件逐个检查。
     */
    async verify(payload) {
      if (!port) {
        const h = await Bridge.hello();
        if (!h.ok) throw new Error("not_connected");
      }
      return request(
        port,
        "/verify",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(Object.assign({ protocol: PROTOCOL }, payload)),
        },
        VERIFY_TIMEOUT_MS,
      );
    },
  };

  // —— 核对：侧边栏（手动 / 同步结束 / 刚连上）和后台（下载一完成就自动）共用 ——

  const DOWNLOADS_KEY = "ggDownloads";
  const LAST_VERIFY_KEY = "ggRtgtoLastVerify";
  const REPAIR_KEY = "ggRepairImport";
  // 两个地方（侧边栏、后台）可能同时想核对，用一个带时间的软锁错开；锁超时防止卡死
  const LOCK_KEY = "ggRtgtoVerifying";
  // 核对进行中每 30 秒续一次锁（导入上万手要几分钟）；扩展被关掉时锁 90 秒后自然失效
  const LOCK_MS = 90 * 1000;
  const LOCK_HEARTBEAT_MS = 30 * 1000;
  // 核对过但结论可疑的（类型不符 / 没对上下载 / 条数不符）：多半是下载和点击配错了，
  // 点击后 2 小时内再交给实时GTO 按文件内容重新配对，最多核 3 次
  const RECHECK = ["wrong_kind", "not_detected", "count_diff"];
  const RECHECK_MS = 2 * 60 * 60 * 1000;
  const MAX_CHECKS = 3;
  // 点了下载之后 GG 要先在服务器上打包，浏览器过一会儿才开始下载。
  // 这段时间里还没对上下载的点击先不核对（否则会被判成"没出现下载"去白补一次）。
  // 每次点击各自计时：点击后 6 分钟还没开始下载就算没下到（用户要求），核对判为缺失、自动补下载
  const START_GRACE_MS = 6 * 60 * 1000;
  function inGrace(Ledger, e, downloads, now) {
    return now - Ledger.graceStart(e) < START_GRACE_MS;
  }
  // 同一次点击因"文件类型不符"最多解开重配几次
  const MAX_UNPIN = 3;

  const storageGet = (keys) => new Promise((r) => chrome.storage.local.get(keys, r));
  const storageSet = (obj) => new Promise((r) => chrome.storage.local.set(obj, r));
  const storageRemove = (keys) => new Promise((r) => chrome.storage.local.remove(keys, r));

  // 发给实时GTO 的字段：日期段、类别、点下载时的条数，以及浏览器下载的文件和状态
  function pickForVerify(e) {
    const d = e.download;
    return {
      id: e.id,
      mode: e.mode,
      pageType: e.pageType,
      kind: e.kind,
      from: e.from,
      to: e.to,
      count: e.count,
      chunk: e.chunk,
      clickedAt: e.clickedAt,
      clickedAtMs: e.clickedAtMs || null,
      download: d
        ? {
            id: d.id,
            file: d.file,
            state: d.state,
            error: d.error,
            bytes: d.bytes,
            totalBytes: d.totalBytes,
            startTime: d.startTime,
            endTime: d.endTime,
          }
        : null,
    };
  }

  function describe(e) {
    const d = e.download;
    return (
      `[扩展] ${e.pageType}/${e.kind} ${e.from}~${e.to}${e.chunk ? " 第" + e.chunk + "趟" : ""} ` +
      `按钮 ${e.count == null ? "-" : e.count} 条，点击 ${e.clickedAt || "-"}，` +
      (d
        ? `下载 #${d.id} ${d.state}${d.error ? "(" + d.error + ")" : ""} ${d.file || "(无文件名)"}`
        : "没有对上浏览器下载")
    );
  }

  /**
   * 把还没核对的"点了下载"交给实时GTO，结果写回下载记录，没下到的日期写进补下载清单。
   *
   * opts.onlyFinished  只发浏览器已经下完（或已中断）的 —— 后台"下载一完成就自动解析"用；
   *                    这时若实时GTO 关了自动解析就不发，留到同步结束再一起核对。
   * opts.trigger       记日志用：manual / run_end / connected / auto
   *
   * 返回 { status: 'nothing' | 'not_connected' | 'auto_off' | 'busy' | 'done' | 'error', counts, error }
   */
  Bridge.verifyPending = async function (opts) {
    const o = Object.assign({ onlyFinished: false, trigger: "manual" }, opts || {});
    const Ledger = (typeof window !== "undefined" && window.GG_LEDGER) || self.GG_LEDGER;
    if (!Ledger) return { status: "error", error: "no ledger" };

    const [list, dl] = await Promise.all([Ledger.getAll(), storageGet([DOWNLOADS_KEY])]);
    const downloads = Array.isArray(dl[DOWNLOADS_KEY]) ? dl[DOWNLOADS_KEY] : [];
    const attached = Ledger.attachDownloads(list, downloads);
    // 有点击时间（能和浏览器下载对上）、还没核对过或上次还在下载中的
    const now = Date.now();
    const recheck = (e) =>
      e.verify &&
      RECHECK.includes(e.verify.status) &&
      (e.verify.checks || 1) < MAX_CHECKS &&
      now - e.clickedAtMs < RECHECK_MS;
    // 已下完、还没被核对通过的点击占用的 GG 下载：刚点不久的点击也可能是它们的主人
    const okPinned = new Set(
      attached
        .filter((e) => e.download && e.download.id != null && e.verify && e.verify.status === "ok")
        .map((e) => e.download.id),
    );
    // 已知的文件类型（实时GTO 告诉过的）：类型对不上的文件不算这次点击的候选
    const knownKind = new Map();
    for (const x of attached) {
      for (const r of x.rejectedDownloads || []) if (r && r.fileKind) knownKind.set(r.id, r.fileKind);
      if (x.download && x.download.id != null && x.download.fileKind) knownKind.set(x.download.id, x.download.fileKind);
    }
    const hasFileAfter = (e) =>
      downloads.some((d) => {
        if (d.state !== "complete" || okPinned.has(d.id) || (d.startTime || 0) < e.clickedAtMs - 3000) return false;
        if ((e.rejectedDownloads || []).some((r) => r && r.id === d.id)) return false;
        const k = knownKind.get(d.id);
        return !k || k === "mixed" || k === e.kind;
      });
    let toSend = attached.filter(
      (e) =>
        e.status === "clicked" &&
        e.clickedAtMs &&
        (!e.verify || e.verify.status === "downloading" || recheck(e)) &&
        // 下载还没开始、但刚点不久：再等等。不过点击之后已经有下完的文件时照样发——
        // 实时GTO 按内容配对，这次点击的文件可能被按时间配给了别的点击
        !(!e.download && inGrace(Ledger, e, downloads, now) && !hasFileAfter(e)),
    );
    if (o.onlyFinished) toSend = toSend.filter((e) => e.download && e.download.state !== "in_progress");
    if (!toSend.length) return { status: "nothing" };

    const lock = (await storageGet([LOCK_KEY]))[LOCK_KEY];
    if (lock && Date.now() - lock < LOCK_MS) return { status: "busy" };

    const h = await Bridge.hello();
    if (!h.ok) return { status: "not_connected" };
    if (o.onlyFinished && h.info && h.info.autoParse === false) return { status: "auto_off" };

    await storageSet({ [LOCK_KEY]: Date.now() });
    let result = null;
    const sent = toSend.map(describe);
    console.groupCollapsed(`[实时GTO核对] ${o.trigger}：发送 ${toSend.length} 条`);
    sent.forEach((l) => console.log(l));
    console.groupEnd();
    const saveLog = (extra) =>
      storageSet({
        [LAST_VERIFY_KEY]: Object.assign({ at: Ledger.localIso(Date.now()), trigger: o.trigger, sent }, extra),
      });
    const done = downloads.find((d) => d.state === "complete" && d.file);
    const downloadDir = done ? done.file.replace(/[\\/][^\\/]*$/, "") : null;
    // 下载不一定按点击顺序开始，按时间配的难免配错。把最近的 GG 下载都交给实时GTO，
    // 它读文件内容（类型、条数）重新配。已经核对通过、这次不重核的那些下载不用给。
    const sendIds = new Set(toSend.map((e) => e.id));
    const settled = new Set(
      attached
        .filter(
          (e) => !sendIds.has(e.id) && e.download && e.download.id != null && e.verify && e.verify.status === "ok",
        )
        .map((e) => e.download.id),
    );
    const candidates = downloads
      .filter((d) => !settled.has(d.id))
      .map((d) => ({ id: d.id, file: d.file, state: d.state, error: d.error, startTime: d.startTime }));
    const heartbeat = setInterval(() => {
      storageSet({ [LOCK_KEY]: Date.now() });
    }, LOCK_HEARTBEAT_MS);

    try {
      const res = await Bridge.verify({
        extensionVersion: extVersion() || null,
        trigger: o.trigger,
        downloadDir,
        entries: toSend.map(pickForVerify),
        candidates,
      });
      const results = new Map((res.results || []).map((r) => [r.id, r]));
      console.groupCollapsed(`[实时GTO核对] 结果 ${(res.results || []).length} 条`);
      (res.log || []).forEach((l) => console.log("[实时GTO] " + l));
      console.groupEnd();

      const attachedById = new Map(attached.map((e) => [e.id, e]));
      const at = Ledger.localIso(Date.now());
      let unpinned = 0;
      // 这一轮有配反的，同一轮"没对上下载"的结论也不可靠（它的下载可能正被配反的那条占着），先不记，重配后再核
      const anyWrongKind = (res.results || []).some((r) => r.status === "wrong_kind");
      const downloadsById = new Map(downloads.map((d) => [d.id, d]));
      let repaired = 0;
      await Ledger.update((all) =>
        all.map((e) => {
          const a = attachedById.get(e.id);
          const r = results.get(e.id);
          if (!r) return e;
          const n = Object.assign({}, e);
          if (a && a.download) n.download = a.download; // 对上的下载固定下来，旧下载滚出列表后也不丢
          // 实时GTO 按文件内容重新配过：用它配的那个下载（没有合适的就先解开，等它自己的文件）。
          // 解开不重新计时：每次点击的 6 分钟从点击算起（线上每核一次就重算一次，
          // 被取消的那趟一直"下载中"，6 分钟过了也没去补）
          if (r.repaired) {
            repaired++;
            const d = r.downloadId != null ? downloadsById.get(r.downloadId) : null;
            n.download = d ? Object.assign({}, d) : null;
          }
          // 文件类型不对：多半是下载没按点击顺序开始、和相邻那次点击配反了（手牌包打包慢）。
          // 不算漏下，解开重新配：记下这个文件是什么，下次配对跳过它。同一条最多解开几次，防止打转。
          if (
            r.status === "wrong_kind" &&
            !r.repaired &&
            a &&
            a.download &&
            (e.rejectedDownloads || []).length < MAX_UNPIN
          ) {
            const fileKind = r.fileKind || (e.kind === "summary" ? "history" : "summary");
            n.rejectedDownloads = (e.rejectedDownloads || []).concat([
              { id: a.download.id, fileKind, file: a.download.file || null },
            ]);
            n.download = null;
            delete n.verify;
            n.unpinnedAtMs = Date.now();
            unpinned++;
            return n;
          }
          if (r && r.status === "not_detected" && anyWrongKind && !(a && a.download)) return n;
          if (r && r.fileKind && n.download) n.download = Object.assign({}, n.download, { fileKind: r.fileKind });
          n.verify = {
            status: r.status,
            detail: r.detail || "",
            items: r.items == null ? null : r.items,
            matchedBy: r.matchedBy || null,
            metrics: r.metrics || null,
            at,
            checks: ((e.verify && e.verify.checks) || 0) + 1,
          };
          return n;
        }),
      );

      const count = (pred) => (res.results || []).filter(pred).length;
      const counts = {
        ok: count((r) => r.status === "ok" || r.status === "count_diff"),
        bad: count((r) => Ledger.VERIFY_BAD.includes(r.status)),
        downloading: count((r) => r.status === "downloading"),
      };

      // 所有类别里"没下到、之后也没补上"的日期段，直接变成补下载清单
      const fresh = await Ledger.getAll();
      const pending = Ledger.summarize(Ledger.attachDownloads(fresh, downloads)).flatMap((c) =>
        c.pending.map((r) => ({ pageType: c.pageType, kind: c.kind, from: r.from, to: r.to })),
      );
      if (pending.length) {
        await storageSet({
          [REPAIR_KEY]: { importedAt: Ledger.localIso(Date.now()), source: "rtgto", items: pending },
        });
      }
      const log = (res.log || []).slice();
      if (repaired) log.push(`[扩展] 实时GTO 按文件内容重新配对了 ${repaired} 次点击的下载`);
      if (unpinned) log.push(`[扩展] ${unpinned} 个下载和点击配反了（文件类型不符），已按文件类型重新配对再核对`);
      await saveLog({ log, counts, imported: res.import || null, unpinned, repaired });
      result = { status: "done", counts, imported: res.import || null, unpinned, repaired };
    } catch (e) {
      const error = String((e && e.message) || e);
      console.warn("[实时GTO核对] 失败", e);
      await saveLog({ error });
      return { status: "error", error };
    } finally {
      clearInterval(heartbeat);
      await storageRemove([LOCK_KEY]);
    }
    // 解开了配反的：马上按类型重新配一次再核对，配反的另一方往往就在手边
    if (result.unpinned && (o.depth || 0) < 2) {
      const again = await Bridge.verifyPending(Object.assign({}, o, { depth: (o.depth || 0) + 1 }));
      if (again.status === "done")
        return Object.assign({}, again, { unpinned: result.unpinned + (again.unpinned || 0) });
    }
    return result;
  };

  /**
   * 还在等的：点了但下载还没开始（宽限期内）、或正在下载 / 实时GTO 说还在下载。
   * bytes 是正在下载的已收字节数，用来判断有没有进展。
   */
  Bridge.waitingDownloads = async function () {
    const Ledger = (typeof window !== "undefined" && window.GG_LEDGER) || self.GG_LEDGER;
    const [list, dl] = await Promise.all([Ledger.getAll(), storageGet([DOWNLOADS_KEY])]);
    const attached = Ledger.attachDownloads(list, Array.isArray(dl[DOWNLOADS_KEY]) ? dl[DOWNLOADS_KEY] : []);
    const now = Date.now();
    const mine = attached.filter((e) => e.status === "clicked" && e.clickedAtMs);
    const dls = Array.isArray(dl[DOWNLOADS_KEY]) ? dl[DOWNLOADS_KEY] : [];
    const notStarted = mine.filter((e) => !e.verify && !e.download && inGrace(Ledger, e, dls, now));
    const downloading = mine.filter((e) =>
      e.verify ? e.verify.status === "downloading" : e.download && e.download.state === "in_progress",
    );
    return {
      notStarted: notStarted.length,
      downloading: downloading.length,
      bytes: downloading.reduce((n, e) => n + ((e.download && e.download.bytes) || 0), 0),
    };
  };

  /**
   * 实时GTO 此刻在做什么（给"等待核对"的进度条用）：
   * { connected, verifying, queued, importing, processed, total, currentFile }
   */
  Bridge.progress = async function () {
    const h = await Bridge.hello();
    if (!h.ok) return { connected: false };
    const p = (h.info && h.info.progress) || {};
    return Object.assign({ connected: true, verifying: !!(h.info && h.info.busy) }, p);
  };

  Bridge.START_GRACE_MS = START_GRACE_MS;
  Bridge.LAST_VERIFY_KEY = LAST_VERIFY_KEY;
  Bridge.LOCK_KEY = LOCK_KEY;

  if (typeof window !== "undefined") window.GG_RTGTO = Bridge;
  if (typeof self !== "undefined") self.GG_RTGTO = Bridge;
})();
