// sync-state.js
// 同步水位线的读写，侧边栏和 content script 共用。
//
// 水位线 = 这个页面类型上，已经成功同步到哪一天（含）。
// 下次同步从它的第二天开始，所以用户不用再选日期，点一下就把缺的补上。
//
// 按页面类型分开存：锦标赛 / 极速现金 / 德州扑克 是三份独立的数据，
// 在锦标赛页同步完不代表现金局也同步过了。
//
// 只在一批真正下载成功之后才推进水位线 —— 宁可下次重下一批，
// 也不能因为中途失败却推进了水位线而永久漏掉那几天。

(function () {
  "use strict";

  const STORAGE_KEY = "ggSyncState";

  function readAll() {
    return new Promise((resolve) => {
      chrome.storage.local.get([STORAGE_KEY], (res) => {
        resolve((res && res[STORAGE_KEY]) || {});
      });
    });
  }

  function writeAll(all) {
    return new Promise((resolve) => {
      chrome.storage.local.set({ [STORAGE_KEY]: all }, () => {
        if (chrome.runtime.lastError) {
          console.error("[同步记录] 保存失败:", chrome.runtime.lastError);
        }
        resolve();
      });
    });
  }

  const SyncState = {
    STORAGE_KEY,

    /** 取某个页面类型的同步记录。 */
    async get(pageType) {
      const all = await readAll();
      return (
        all[pageType] || {
          lastSyncedDate: null, // 已成功同步到哪一天（含）
          lastDataSyncAt: null, // 上次真正下载了数据的时间（不是点击同步的时间）
          batches: 0, // 累计批次数，纯粹给用户看
          days: 0, // 累计覆盖天数
        }
      );
    },

    async getAll() {
      return readAll();
    },

    /**
     * 推进水位线。
     * 只往前推，不往回退：一次同步里批次是从旧到新跑的，
     * 但万一有乱序（比如重试），也不能把已经同步过的日期"退回去"。
     */
    async advance(pageType, dateStr, extra) {
      const all = await readAll();
      const cur = all[pageType] || { lastSyncedDate: null, batches: 0, days: 0 };
      const prev = cur.lastSyncedDate;
      if (!prev || dateStr > prev) {
        cur.lastSyncedDate = dateStr;
      }
      // "上次同步"指数据的同步时间：只有这一批真的下载了数据才更新。
      // 点了同步但已是最新、或某段日期确认没有对局（只推进水位线、没下载任何东西）
      // 都不算 —— 否则这个时间就变成了"用户点击同步的时间"，没有意义。
      if (extra && extra.downloaded) {
        cur.lastDataSyncAt = Date.now();
      }
      if (extra) {
        cur.batches = (cur.batches || 0) + (extra.batches || 0);
        cur.days = (cur.days || 0) + (extra.days || 0);
      }
      all[pageType] = cur;
      await writeAll(all);
      return cur;
    },

    /**
     * 把水位线退回到 dateStr（只往回退）。只在确认之前某段被误判成"没数据"时用：
     * 那段其实有对局，要重新下。
     */
    async rewind(pageType, dateStr) {
      const all = await readAll();
      const cur = all[pageType];
      if (!cur || !cur.lastSyncedDate || !(dateStr < cur.lastSyncedDate)) return cur || null;
      cur.lastSyncedDate = dateStr;
      all[pageType] = cur;
      await writeAll(all);
      return cur;
    },

    /**
     * 只清除这一个分类（页面类型）的记录，其他分类不动。下次同步该分类从头来。
     * 分类必须给：以前"不传就全清"，页面还没识别出分类时点清除会把所有分类都清掉。
     */
    async clear(pageType) {
      if (!pageType) throw new Error("clear() 需要指定分类");
      const all = await readAll();
      delete all[pageType];
      await writeAll(all);
      return all;
    },

    /** 清除所有分类（目前界面上没有入口，留给调试用）。 */
    async clearAll() {
      await writeAll({});
      return {};
    },
  };

  if (typeof window !== "undefined") window.GG_SYNC = SyncState;
  if (typeof self !== "undefined") self.GG_SYNC = SyncState;
})();
