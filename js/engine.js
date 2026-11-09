/* ============================================================
 * engine.js — 滚雪球回测引擎
 *   规则：估值分位驱动的「高估减仓 → 低估买入」再平衡
 *   对比：等权买入持有(Buy & Hold)
 * ============================================================ */
(function (App) {
  'use strict';
  const U = App.U, I = App.I;

  /* ---------- 交易成本模型 ---------- */
  const COST = {
    A: {
      name: 'A股',
      buy(amt) {
        const commission = Math.max(5, amt * 0.00025);
        const transfer = amt * 0.00001;
        return commission + transfer;
      },
      sell(amt) {
        const commission = Math.max(5, amt * 0.00025);
        const stamp = amt * 0.0005;
        const transfer = amt * 0.00001;
        return commission + stamp + transfer;
      }
    },
    HK: {
      name: '港股',
      buy(amt) {
        return Math.max(3, amt * 0.00025) + amt * 0.001 + amt * 0.0000565 + amt * 0.00002 + amt * 0.000027 + amt * 0.0000015;
      },
      sell(amt) {
        return Math.max(3, amt * 0.00025) + amt * 0.001 + amt * 0.0000565 + amt * 0.00002 + amt * 0.000027 + amt * 0.0000015;
      }
    }
  };
  App.COST = COST;

  const LOT = { A: 100, HK: 100 };  // 近似手数

  /** 预处理：把 series 转成回测用的列式数据 */
  function prepare(series, windowYears) {
    const pct = I.rollingPercentile(series, 'pe', windowYears);
    const pctPb = I.rollingPercentile(series, 'pb', windowYears);
    const dates = series.map(s => s.date);
    const close = series.map(s => s.close);
    const pe = series.map(s => s.pe);
    const pb = series.map(s => s.pb);
    // 回撤（相对历史最高收盘）
    const dd = []; let peak = -Infinity;
    for (const c of close) { if (c > peak) peak = c; dd.push(peak > 0 ? c / peak - 1 : 0); }
    return { dates, close, pe, pb, pct, pctPb, dd };
  }

  /** 找 <= date 的最近索引 */
  function idxOn(pre, date) { return U.lowerIndex(pre.dates, date); }

  function firstOfPeriod(dateStr, freq) {
    const d = U.parseDate(dateStr);
    if (freq === 'M') return true;  // 每个交易日都算首次？用月判断
    return false;
  }

  /**
   * 运行回测
   * cfg: { universe:[{quoteId,name,market}], seriesMap:{}, start,end, cash,
   *        high, low, reduce, maxPos, freq, useDD, ddThreshold, windowYears, fx }
   */
  function run(cfg) {
    const universe = cfg.universe.filter(u => cfg.seriesMap[u.quoteId]);
    if (!universe.length) throw new Error('没有可用的标的（可能数据未加载成功）');

    const pre = {};
    universe.forEach(u => {
      pre[u.quoteId] = prepare(cfg.seriesMap[u.quoteId].series, cfg.windowYears);
    });

    // 合并交易日历
    const calSet = new Set();
    Object.values(pre).forEach(p => p.dates.forEach(d => { if (d >= cfg.start && d <= cfg.end) calSet.add(d); }));
    const calendar = Array.from(calSet).sort();
    if (calendar.length < 30) throw new Error('区间内交易日太少，请放宽时间范围');

    const fxOf = u => u.market === 'HK' ? cfg.fx : 1;
    const calKey = d => {
      const dt = U.parseDate(d);
      if (cfg.freq === 'M') return dt.getFullYear() + '-' + dt.getMonth();
      if (cfg.freq === 'Q') return dt.getFullYear() + '-Q' + Math.floor(dt.getMonth() / 3);
      if (cfg.freq === 'H') return dt.getFullYear() + '-H' + Math.floor(dt.getMonth() / 6);
      return String(dt.getFullYear());
    };

    let cash = cfg.cash;
    const pos = {};       // quoteId -> shares
    const costBasis = {}; // quoteId -> 累计成本(CNY) 用于记录
    const trades = [];
    const nav = [];
    const navBH = [];

    const priceOf = (qid, i) => { const p = pre[qid]; return i >= 0 ? p.close[i] : null; };
    const priceCny = (u, i) => { const p = priceOf(u.quoteId, i); return p == null ? null : p * fxOf(u); };

    const portfolioValue = date => {
      let v = cash;
      universe.forEach(u => {
        const i = idxOn(pre[u.quoteId], date);
        const pc = priceCny(u, i);
        if (pc != null && pos[u.quoteId]) v += pos[u.quoteId] * pc;
      });
      return v;
    };

    const doBuy = (u, date, budgetCny, reason) => {
      const i = idxOn(pre[u.quoteId], date);
      const pc = priceCny(u, i);
      if (pc == null || pc <= 0) return 0;
      const lot = LOT[u.market] || 1;
      let shares = Math.floor(budgetCny / (pc * (1 + 0.0015)) / lot) * lot;
      while (shares > 0) {
        const amt = shares * pc;
        const fee = COST[u.market].buy(amt);
        if (amt + fee <= cash + 1e-6) {
          cash -= amt + fee;
          pos[u.quoteId] = (pos[u.quoteId] || 0) + shares;
          costBasis[u.quoteId] = (costBasis[u.quoteId] || 0) + amt + fee;
          trades.push({ date, quoteId: u.quoteId, name: u.name, side: 'buy', price: priceOf(u.quoteId, i),
            shares, amount: amt, fee, reason, pct: pre[u.quoteId].pct[i], cur: u.market === 'HK' ? 'HKD' : 'CNY' });
          return shares;
        }
        shares -= lot;
      }
      return 0;
    };

    const doSell = (u, date, sharesToSell, reason) => {
      sharesToSell = Math.min(sharesToSell, pos[u.quoteId] || 0);
      if (sharesToSell <= 0) return 0;
      const i = idxOn(pre[u.quoteId], date);
      const pc = priceCny(u, i);
      const amt = sharesToSell * pc;
      const fee = COST[u.market].sell(amt);
      cash += amt - fee;
      pos[u.quoteId] -= sharesToSell;
      costBasis[u.quoteId] = Math.max(0, (costBasis[u.quoteId] || 0) * (pos[u.quoteId] / (pos[u.quoteId] + sharesToSell)));
      trades.push({ date, quoteId: u.quoteId, name: u.name, side: 'sell', price: priceOf(u.quoteId, i),
        shares: sharesToSell, amount: amt, fee, reason, pct: pre[u.quoteId].pct[i], cur: u.market === 'HK' ? 'HKD' : 'CNY' });
      return sharesToSell;
    };

    /* -------- 初始建仓：等权 -------- */
    const firstDate = calendar[0];
    const perName = cfg.cash / universe.length;
    universe.forEach(u => {
      const budget = Math.min(perName, cfg.cash * cfg.maxPos / 100);
      doBuy(u, firstDate, budget, '初始建仓');
    });
    nav.push({ date: firstDate, value: portfolioValue(firstDate) });

    /* -------- Buy & Hold 基准：同样等权买入后不动 -------- */
    const bhPos = {}, bhSelf = {};
    let bhCash = cfg.cash;
    universe.forEach(u => {
      const i = idxOn(pre[u.quoteId], firstDate);
      const pc = priceCny(u, i);
      const budget = Math.min(perName, cfg.cash * cfg.maxPos / 100);
      const lot = LOT[u.market] || 1;
      let shares = Math.floor(budget / pc / lot) * lot;
      bhCash -= shares * pc;
      bhPos[u.quoteId] = shares;
    });
    const bhValue = date => {
      let v = bhCash;
      universe.forEach(u => { const i = idxOn(pre[u.quoteId], date); const pc = priceCny(u, i); if (pc != null) v += (bhPos[u.quoteId] || 0) * pc; });
      return v;
    };
    navBH.push({ date: firstDate, value: bhValue(firstDate) });

    /* -------- 主循环 -------- */
    let lastKey = calKey(firstDate);
    for (let t = 1; t < calendar.length; t++) {
      const date = calendar[t];
      const key = calKey(date);
      if (key !== lastKey) {
        lastKey = key;
        rebalance(date);
      }
      nav.push({ date, value: portfolioValue(date) });
      navBH.push({ date, value: bhValue(date) });
    }

    function rebalance(date) {
      // 1) 计算每只标的当前状态
      const state = universe.map(u => {
        const p = pre[u.quoteId], i = idxOn(p, date);
        return { u, i, pct: i >= 0 ? p.pct[i] : null, dd: i >= 0 ? p.dd[i] : null,
          price: i >= 0 ? p.close[i] : null, pcny: i >= 0 ? p.close[i] * fxOf(u) : null };
      }).filter(s => s.pcny != null);

      const total = portfolioValue(date);

      // 2) 卖出：分位 >= 高估阈值 → 按比例减仓
      state.filter(s => s.pct != null && s.pct >= cfg.high).forEach(s => {
        const held = pos[s.u.quoteId] || 0;
        if (held <= 0) return;
        const sell = Math.floor(held * cfg.reduce / 100 / (LOT[s.u.market] || 1)) * (LOT[s.u.market] || 1);
        if (sell > 0) doSell(s.u, date, sell, '高估减仓·PE分位' + s.pct.toFixed(0) + '%');
      });

      // 3) 买入：分位 <= 低估阈值（且满足回撤条件）→ 按最低分位优先补仓
      const buys = state.filter(s => s.pct != null && s.pct <= cfg.low && (!cfg.useDD || (s.dd != null && s.dd <= -cfg.ddThreshold / 100)))
        .sort((a, b) => a.pct - b.pct);

      if (buys.length) {
        // 目标：每只候选达到 等权目标（1/n），且不超过 maxPos%
        const target = Math.min(1 / buys.length, cfg.maxPos / 100) * total;
        buys.forEach(s => {
          const heldVal = (pos[s.u.quoteId] || 0) * s.pcny;
          const need = target - heldVal;
          const budget = Math.min(need, cash);
          if (budget > s.pcny * (LOT[s.u.market] || 1)) {
            doBuy(s.u, date, budget, '低估买入·PE分位' + s.pct.toFixed(0) + '%');
          }
        });
        // 若仍有现金且候选充足，做一轮「再平衡式」补充：拉平所有候选到最低持有比例
        if (cash > total * 0.02) {
          const heldVals = buys.map(s => ({ s, v: (pos[s.u.quoteId] || 0) * s.pcny }));
          heldVals.sort((a, b) => a.v - b.v);
          for (const hv of heldVals) {
            if (cash < total * 0.01) break;
            const budget = Math.min(cash, total * cfg.maxPos / 100 - hv.v);
            if (budget > hv.s.pcny * (LOT[hv.s.u.market] || 1)) {
              doBuy(hv.s.u, date, budget, '低估加仓·PE分位' + hv.s.pct.toFixed(0) + '%');
            }
          }
        }
      }
    }

    const stratPerf = I.perf(nav);
    const bhPerf = I.perf(navBH);

    return {
      nav, navBH, trades, stratPerf, bhPerf,
      universe: universe.map(u => ({ quoteId: u.quoteId, name: u.name, market: u.market })),
      cfg
    };
  }

  App.Engine = { run, prepare };
})(window.App);
