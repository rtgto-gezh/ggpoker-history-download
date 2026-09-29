// gg-limits.js
// GGPoker / PokerCraft 自身的下载限制，侧边栏和 content script 共用一份。
//
// 官方限制，来自 PokerCraft 页面上的"下载限制"弹窗原文：
//   · 游戏摘要    ：最多可下载最近 12 个月内的 500 个摘要
//   · 游戏历史记录：最多可下载最近  3 个月内的 20,000 个手牌
//
// 注意两者单位不同：摘要按"个"（= 场次，和下载按钮上的数字同口径，可直接比），
// 手牌按"手"（页面上读不到手数，只能按场次估算，见下面 HANDS_PER_SESSION_ESTIMATE）。
// 两者的时间范围也不同，这是整个日期逻辑的关键。
//
// 所以一次跨 12 个月的任务里，只有最近 3 个月那部分能拿到手牌详情，
// 更早的日期只有概要 —— 这不是 bug，是 GG 的限制，界面上要讲清楚。
//
// 单次条数上限靠"日期间隔"分批来规避：间隔越小，每批的场次/手数越少。

(function () {
  "use strict";

  const MS_PER_DAY = 24 * 60 * 60 * 1000;

  /**
   * 往前推 N 个自然月。
   * 用自然月而不是固定天数：GG 说的是"12 个月""3 个月"，
   * 按 365/90 天算在月份长度不齐时会差一两天，边界上就会被服务端拒掉。
   * 月末要夹紧，例如 3 月 31 日往前推 1 个月应该是 2 月 28/29 日，
   * 直接 setMonth 会溢出成 3 月 2/3 日。
   */
  function monthsAgo(date, months) {
    const d = new Date(date.getFullYear(), date.getMonth(), date.getDate());
    const targetMonth = d.getMonth() - months;
    const probe = new Date(d.getFullYear(), targetMonth, 1);
    const lastDayOfTarget = new Date(probe.getFullYear(), probe.getMonth() + 1, 0).getDate();
    probe.setDate(Math.min(d.getDate(), lastDayOfTarget));
    return probe;
  }

  /** 本地时区的今天（零点），避免 toISOString 的 UTC 偏移。 */
  function today() {
    const n = new Date();
    return new Date(n.getFullYear(), n.getMonth(), n.getDate());
  }

  /**
   * 格式化成 YYYY-MM-DD。
   * 不能用 toISOString().slice(0,10)：它先转 UTC，东八区在当天 08:00 之前
   * 会整体退回前一天，日期范围就跟用户选的对不上。
   */
  function fmt(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  /** 解析 YYYY-MM-DD 为本地零点的 Date（new Date("2025-01-01") 是 UTC，会差一天）。 */
  function parse(str) {
    if (str instanceof Date) return str;
    const m = String(str).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (!m) {
      const d = new Date(str);
      return isNaN(d.getTime()) ? null : d;
    }
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  function diffDays(a, b) {
    return Math.round((a - b) / MS_PER_DAY);
  }

  const LIMITS = {
    MS_PER_DAY,

    // —— GG 官方限制（与页面"下载限制"弹窗一致，改动前请先核对那个弹窗）——
    SUMMARY_MONTHS: 12, // 最近 12 个月
    SUMMARY_MAX_PER_DOWNLOAD: 500, // 500 个摘要
    HISTORY_MONTHS: 3, // 最近 3 个月
    HISTORY_MAX_HANDS_PER_DOWNLOAD: 20000, // 20,000 个手牌

    monthsAgo,
    today,
    fmt,
    parse,
    diffDays,

    /** 这个页面类型能往回同步到哪天：MTT 12 个月，其它只有手牌的 3 个月。 */
    earliestSyncDate(pageType, ref) {
      const now = ref || today();
      return LIMITS.pageConfig(pageType).hasSummary ? LIMITS.earliestSummaryDate(now) : LIMITS.earliestHistoryDate(now);
    },

    /** 概要能查到的最早日期（今天往前 12 个月）。 */
    earliestSummaryDate(ref) {
      return monthsAgo(ref || today(), LIMITS.SUMMARY_MONTHS);
    },

    /** 手牌详情能查到的最早日期（今天往前 3 个月）。 */
    earliestHistoryDate(ref) {
      return monthsAgo(ref || today(), LIMITS.HISTORY_MONTHS);
    },

    /**
     * 校验用户选的日期范围，返回 { ok, errorKey, params } 。
     * errorKey 交给各自的 t() 去翻译，这里不碰文案。
     */
    validateRange(startStr, endStr, ref) {
      const now = ref || today();
      const start = parse(startStr);
      const end = parse(endStr);

      if (!start || !end) return { ok: false, errorKey: "error_select_date" };
      if (start > end) return { ok: false, errorKey: "error_start_end_date" };
      if (end > now) return { ok: false, errorKey: "error_end_date_future" };

      const earliest = LIMITS.earliestSummaryDate(now);
      if (start < earliest) {
        return {
          ok: false,
          errorKey: "error_earliest_date",
          params: { date: fmt(earliest), months: LIMITS.SUMMARY_MONTHS },
        };
      }
      return { ok: true };
    },

    // —— 自动日期间隔 ——
    //
    // 每批该切多少天，取决于那几天实际打了多少场 —— 用户事先根本猜不到，
    // 所以不让用户选，改成边跑边按实际条数调整。
    //
    // 可直接测量的只有下载按钮上 <small> 里的数字（"N 游戏概括信息"）：
    //   · 摘要上限 500 个，和这个数字同口径，可以直接比 —— 这部分不是猜的。
    //   · 手牌上限是 20,000"手"，不是场次，页面上读不到手数。
    //     只能用场次做保守代理：按单场 <= HANDS_PER_SESSION_ESTIMATE 手估算。
    //     这是整套逻辑里唯一靠估计的地方，偏保守，宁可多切几批也不要被截断。
    //     真撞上超限提示时会从提示里学到真实值并覆盖它（见 content-script 的 learnedCap）。
    AUTO: {
      MIN_SPAN: 1,
      // 一次最多加载 31 天（约一个月）。放宽到 92 天时，长区间在 GG 上常常要等很久列表才出来，
      // 甚至超时（线上 92 天、62 天都卡住过）；用户要求一次最多一个月。
      // 代价：打得很少的人一年要多加载几批，每批可能要多点一次下载。
      MAX_SPAN: 31,
      INITIAL_SPAN_SUMMARY: 14, // 只有概要的区段，可以跨大一点
      INITIAL_SPAN_HISTORY: 3, // 3 个月窗口内要同时下手牌，起步保守
      HANDS_PER_SESSION_ESTIMATE: 200,
      GROW_BELOW_RATIO: 0.35, // 仅用于没有密度信息时的保守放大

      // 目标：每批尽量装满到上限，让用户少点几次下载。
      //
      // 取舍是明确的：重做只花加载时间（约 25 秒），而每多一个有效批次，
      // 用户就要多点两次下载按钮。所以宁可多重做几次，也要把每批装满。
      // 0.95 是拿真实日志 + 6 种玩牌模式跑模拟选出来的：
      // 再高（1.0）超限太频繁，反而因为反复重做把跨度压小、点击变多。
      DENSITY_SAFETY: 0.95,
      DENSITY_EMA_ALPHA: 0.6, // 密度用指数滑动平均，偏重最近几批

      // 超过单次下载上限的批次不缩日期重做，按行分几趟下（勾一部分 → 点下载 → 再勾下一部分），
      // 列表多长都行（线上 1828 行完整显示）。GG 每次加载列表要几十秒到一两分钟、跟跨度关系不大，
      // 所以一批尽量大、加载次数尽量少：瞄准 2000 行的 95%（概要正好 4 趟，每趟接近 500 条）。
      BATCH_TARGET_ROWS: 2000,

      // 跨度上限：第一批最多 31 天（之后也不超过 MAX_SPAN）；加载超时就减半，
      // 并记住超时过的跨度，之后不超过它的 60%（线上 92 天、62 天都超时过）。
      // 不按加载快慢缩跨度：线上 2 天用了 107 秒、31 天 68 秒，缩跨度只会多加载、多点击。
      FIRST_SPAN_MAX: 31,

      // 每批行数还要看 GG 当前加载多快：按实测"每行多少毫秒"把一次加载控制在约 1 分钟。
      // 一个月打得很多的人，一批自动缩到十来天，列表不会等太久才出来。
      LOAD_TARGET_MS: 60000,
      LOAD_OVERHEAD_MS: 5000, // 不管多少行都要花的固定时间
      // 行数太少的加载不拿来估速度：GG 慢的时候小列表也要一两分钟（97 行 107 秒），
      // 那是固定开销，按行摊会把速度估得很慢
      LOAD_SAMPLE_MIN_ROWS: 300,
      LOAD_MIN_ROWS: 200, // 再慢也至少一批 200 行；实际还不低于一趟概要（500 行），见 content-script
      // 手牌一趟装到约 2 万手的 95%；勾完超过 98% 就按比例少勾几行
      HANDS_FILL: 0.95,
      HANDS_OVER: 0.98,
    },

    /** 本批允许的最大场次数。在手牌窗口内要同时受 2 万手的约束。 */
    sessionCap(inHistoryWindow) {
      const summaryCap = LIMITS.SUMMARY_MAX_PER_DOWNLOAD;
      if (!inHistoryWindow) return summaryCap;
      const handCap = Math.floor(LIMITS.HISTORY_MAX_HANDS_PER_DOWNLOAD / LIMITS.AUTO.HANDS_PER_SESSION_ESTIMATE);
      return Math.min(summaryCap, handCap);
    },

    /** 起步跨度。 */
    initialSpan(inHistoryWindow) {
      return inHistoryWindow ? LIMITS.AUTO.INITIAL_SPAN_HISTORY : LIMITS.AUTO.INITIAL_SPAN_SUMMARY;
    },

    /**
     * 按"实际密度"直接算出该用多大跨度，而不是盲目对半砍。
     *
     * 盲砍的代价很实在：每砍一次就要重新设日期、点显示、等加载，一轮 20~30 秒。
     * 线上见过 28天 -> 14 -> 7 -> 3 -> 1 连砍四次，白白花掉两分钟。
     * 而这批跑完其实已经知道密度了（行数 ÷ 天数），一次就能算准。
     *
     * 留 20% 余量：各天场次并不均匀，按平均值顶着上限切容易再次超。
     * 结果强制小于当前跨度，保证一定有进展、不会原地打转。
     */
    spanForDensity(rowsSeen, daysSeen, cap, currentSpan, safety) {
      const A = LIMITS.AUTO;
      if (!rowsSeen || !daysSeen) return A.MIN_SPAN;
      const perDay = rowsSeen / daysSeen;
      if (perDay <= 0) return A.MAX_SPAN;

      const sf = typeof safety === "number" && safety > 0 ? safety : A.DENSITY_SAFETY;
      const ideal = Math.floor((cap * sf) / perDay);
      let next = Math.max(A.MIN_SPAN, Math.min(A.MAX_SPAN, ideal));
      if (currentSpan && next >= currentSpan) {
        next = Math.max(A.MIN_SPAN, currentSpan - 1);
      }
      return next;
    },

    /** 直接按"每天多少行"算跨度（不需要凑 rows/days 两个数）。 */
    spanForRate(perDay, cap, safety) {
      const A = LIMITS.AUTO;
      if (!perDay || perDay <= 0) return A.MAX_SPAN;
      const sf = typeof safety === "number" && safety > 0 ? safety : A.DENSITY_SAFETY;
      const ideal = Math.floor((cap * sf) / perDay);
      return Math.max(A.MIN_SPAN, Math.min(A.MAX_SPAN, ideal));
    },

    /**
     * 跨进"手牌 3 个月窗口"时上限会从 500 掉到 100（差 5 倍），
     * 沿用原来的跨度必然一超再超，所以按上限比例先缩一把。
     * 反方向（离开窗口、上限变大）同理按比例放大。
     */
    rescaleSpanForCap(span, oldCap, newCap) {
      const A = LIMITS.AUTO;
      if (!oldCap || !newCap || oldCap === newCap) return span;
      const scaled = Math.floor((span * newCap) / oldCap);
      return Math.max(A.MIN_SPAN, Math.min(A.MAX_SPAN, scaled || A.MIN_SPAN));
    },

    /**
     * 密度跟踪器：记住"每天大概多少场"，用它直接给出下一批该跨多少天。
     *
     * 为什么需要它：线上出现过"某批超限 -> 按密度缩小 -> 下一批恰好没数据 ->
     * 把密度清零、跨度放大回顶 -> 再下一批又超限"的循环。
     * 一个空批次就把刚学到的东西全丢了。
     *
     * 密度用指数滑动平均（偏重最近）：只看最后一批太抖，取最近最大值又太保守，
     * 爆量日会把平日的跨度也压死。
     */
    makeDensityTracker() {
      const A = LIMITS.AUTO;
      let ema = 0;
      let emptyStreak = 0;

      return {
        /** 记一批的实测结果。rows 可以是 0（空批次）。 */
        observe(rows, days) {
          if (!days || days <= 0) return;
          if (rows > 0) {
            emptyStreak = 0;
            const r = rows / days;
            ema = ema ? ema * (1 - A.DENSITY_EMA_ALPHA) + r * A.DENSITY_EMA_ALPHA : r;
          } else {
            emptyStreak++;
          }
        },

        get rate() {
          return ema;
        },
        get emptyStreak() {
          return emptyStreak;
        },

        /**
         * 下一批该跨多少天。
         *
         * · 刚跑完的是空批次 —— 多半处在"这段时间没打牌"的死区，直接翻倍快速跳过，
         *   已知密度留着，等数据出现时再用；
         * · 有密度 —— 直接瞄准 cap * DENSITY_SAFETY 行，一次到位，不用逐步试；
         * · 还没见过任何数据 —— 大胆翻倍。
         */
        suggestSpan(cap, currentSpan, wasEmpty) {
          if (wasEmpty) {
            return Math.max(A.MIN_SPAN, Math.min(A.MAX_SPAN, (currentSpan || A.MIN_SPAN) * 2));
          }
          if (ema > 0) return LIMITS.spanForRate(ema, cap, A.DENSITY_SAFETY);
          return Math.max(A.MIN_SPAN, Math.min(A.MAX_SPAN, (currentSpan || A.MIN_SPAN) * 2));
        },
      };
    },

    /**
     * 看完这批的实际条数后决定下一步。
     *   shrink —— 这批已经碰到上限了，本批作废，缩小跨度重来
     *   grow   —— 条数远低于上限，下批可以跨大一点，少跑几轮
     *   keep   —— 维持
     * 跨度已经是 1 天还超限就只能认了（GG 会截断），返回 capped。
     */
    nextSpan(span, maxCount, cap) {
      const A = LIMITS.AUTO;
      if (maxCount >= cap) {
        if (span <= A.MIN_SPAN) return { action: "capped", span: A.MIN_SPAN };
        return { action: "shrink", span: Math.max(A.MIN_SPAN, Math.floor(span / 2)) };
      }
      if (maxCount <= cap * A.GROW_BELOW_RATIO && span < A.MAX_SPAN) {
        return { action: "grow", span: Math.min(A.MAX_SPAN, span * 2) };
      }
      return { action: "keep", span };
    },

    // —— 页面类型 ——
    // 只有锦标赛(MTT)页面有"游戏概要"下载按钮；极速现金和德州扑克只有手牌详情。
    PAGE_TYPES: {
      tournament: { key: "tournament", hasSummary: true },
      rushAndCash: { key: "rushAndCash", hasSummary: false },
      holdem: { key: "holdem", hasSummary: false },
      plo: { key: "plo", hasSummary: false },
    },

    pageConfig(pageType) {
      return LIMITS.PAGE_TYPES[pageType] || { key: pageType, hasSummary: false };
    },

    /**
     * 规划这次要同步哪一段。
     *
     * 方向是"从旧到新"：GG 的窗口是滑动的，最早那几天随时会过期消失，
     * 所以先抓快过期的。中途断了也只丢最新那几天，下次跑一样能补上。
     *
     * lastSyncedDate = 上次成功同步到的日期（含），null 表示从没同步过。
     * 下次从它的第二天开始；但不能早于 GG 的 12 个月上限 —— 如果上次同步
     * 已经是一年前，中间那段在 GG 那边本来就没了，只能从当前窗口的最早一天起。
     */
    planSync(lastSyncedDate, ref, pageType) {
      const now = ref || today();
      const historyFrom = LIMITS.earliestHistoryDate(now);

      // 能往回追多久，取决于这个页面有没有"游戏概要"：
      //   · 锦标赛(MTT) 有概要，概要能查 12 个月，所以窗口是 12 个月；
      //   · 极速现金 / 德州扑克只有手牌详情，GG 只留 3 个月 ——
      //     再往前跑就是空转，那些日子服务端本来就没有记录。
      const hasSummary = pageType ? LIMITS.pageConfig(pageType).hasSummary : true;
      const earliest = hasSummary ? LIMITS.earliestSummaryDate(now) : historyFrom;

      let from = earliest;
      let resumed = false;
      let staleWatermark = false;

      const mark = lastSyncedDate ? parse(lastSyncedDate) : null;
      if (mark) {
        const next = new Date(mark.getTime() + MS_PER_DAY);
        if (next > earliest) {
          from = next;
          resumed = true;
        } else {
          // 水位线太旧，中间缺的那段 GG 已经删了，补不回来
          staleWatermark = true;
        }
      }

      if (from > now) {
        return {
          nothingToDo: true,
          from: fmt(now),
          to: fmt(now),
          days: 0,
          resumed,
          staleWatermark,
          hasSummary,
          earliest: fmt(earliest),
          historyFrom: fmt(historyFrom),
        };
      }

      return {
        nothingToDo: false,
        from: fmt(from),
        to: fmt(now),
        days: diffDays(now, from) + 1,
        resumed,
        staleWatermark,
        hasSummary,
        earliest: fmt(earliest),
        historyFrom: fmt(historyFrom),
        // 这段里哪部分能拿到手牌详情
        ...LIMITS.splitByCapability(fmt(from), fmt(now), now),
      };
    },

    /**
     * 把用户选的范围拆成"有手牌详情"和"只有概要"两段，
     * 界面上直接把这两段日期显示出来，省得用户以为手牌没下全是 bug。
     */
    splitByCapability(startStr, endStr, ref) {
      const now = ref || today();
      const start = parse(startStr);
      const end = parse(endStr);
      const historyFrom = LIMITS.earliestHistoryDate(now);

      // 手牌详情区间 = 用户范围 ∩ [今天-3个月, 今天]
      const hStart = start > historyFrom ? start : historyFrom;
      const hEnd = end;
      const hasHistory = hStart <= hEnd;

      // 只有概要的区间 = 用户范围里早于 historyFrom 的部分
      const sOnlyEnd = new Date(historyFrom.getTime() - MS_PER_DAY);
      const hasSummaryOnly = start <= sOnlyEnd;

      return {
        history: hasHistory ? { start: fmt(hStart), end: fmt(hEnd) } : null,
        summaryOnly: hasSummaryOnly ? { start: fmt(start), end: fmt(sOnlyEnd < end ? sOnlyEnd : end) } : null,
      };
    },
  };

  if (typeof window !== "undefined") window.GG_LIMITS = LIMITS;
  if (typeof self !== "undefined") self.GG_LIMITS = LIMITS;
})();
