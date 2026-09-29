// network-probe.js
//
// 运行在页面的 MAIN world（见 manifest.json 里 world:"MAIN" 的那条 content_scripts）。
//
// 为什么需要它：
//   判断"列表加载完了没"一直靠猜——等转圈、等 DOM 不再变、等若干秒不变。
//   实测 PokerCraft 从清空表格到填入数据能超过 2 秒，转圈还未必检测得到，
//   于是插件在空窗期里判成"没有数据"，不提示下载就推进了水位线。
//   把等待时间调大只是把阈值往后挪，网慢一点照样失效。
//
//   真正确定的信号是网络本身：请求发出了、请求结束了。
//   所以在页面里包一层 fetch / XMLHttpRequest，只统计在途请求数，
//   不读也不改任何请求内容。
//
// 跨 world 通信：
//   content script 在 isolated world，拿不到这里的变量，但两边共享同一个 DOM。
//   所以把状态写到 <html> 的 data-* 属性上，content script 读 DOM 即可。
//
// 安全边界：
//   这是纯旁路包装 —— 原样转发参数、原样返回结果、异常原样抛出。
//   任何一步出问题都吞掉，绝不能因为统计代码把 PokerCraft 本身弄坏。

(function () {
  "use strict";

  // 防止重复注入（补注入场景下可能跑第二遍）
  if (window.__GG_NET_PROBE__) return;
  window.__GG_NET_PROBE__ = true;

  const root = document.documentElement;
  let inflight = 0;
  let lastDoneAt = 0;
  let totalSeen = 0;
  // 失败的请求数（网络错误、被中止、HTTP 4xx/5xx）：列表请求失败时页面同样显示 0 行，
  // 不能当成"没数据"。只看状态码，不读内容。
  let totalFailed = 0;

  function publish() {
    try {
      root.dataset.ggInflight = String(inflight);
      root.dataset.ggLastDone = String(lastDoneAt);
      root.dataset.ggNetSeen = String(totalSeen);
      root.dataset.ggNetFailed = String(totalFailed);
    } catch (e) {
      /* 写 DOM 失败也不能影响页面 */
    }
  }

  function start() {
    inflight++;
    totalSeen++;
    publish();
  }

  function done(failed) {
    inflight = Math.max(0, inflight - 1);
    lastDoneAt = Date.now();
    if (failed) totalFailed++;
    publish();
  }

  // —— fetch ——
  const origFetch = window.fetch;
  if (typeof origFetch === "function") {
    window.fetch = function (...args) {
      let counted = false;
      try {
        start();
        counted = true;
      } catch (e) {
        /* 统计失败就当没统计 */
      }
      let p;
      try {
        p = origFetch.apply(this, args);
      } catch (e) {
        if (counted) done();
        throw e;
      }
      if (!counted) return p;
      return p.then(
        (res) => {
          let failed = false;
          try {
            failed = !!res && res.ok === false;
          } catch (e) {
            /* 读不到状态就当成功 */
          }
          done(failed);
          return res;
        },
        (err) => {
          done(true);
          throw err;
        },
      );
    };
  }

  // —— XMLHttpRequest ——
  const XHR = window.XMLHttpRequest;
  if (XHR && XHR.prototype && typeof XHR.prototype.send === "function") {
    const origSend = XHR.prototype.send;
    XHR.prototype.send = function (...args) {
      let counted = false;
      try {
        start();
        counted = true;
        const xhr = this;
        const finish = () => {
          if (!counted) return;
          counted = false;
          let failed = false;
          try {
            failed = xhr.status === 0 || xhr.status >= 400;
          } catch (e) {
            /* 同上 */
          }
          done(failed);
        };
        this.addEventListener("loadend", finish);
      } catch (e) {
        /* 挂不上监听就别统计，免得计数只增不减 */
        if (counted) {
          counted = false;
          done();
        }
      }
      try {
        return origSend.apply(this, args);
      } catch (e) {
        if (counted) {
          counted = false;
          done();
        }
        throw e;
      }
    };
  }

  publish();
})();
