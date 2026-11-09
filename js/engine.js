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
  const fxOf = (sim, market) => (market === 'HK' ? sim.fx : 1);  // A股汇率恒为 1

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

  /* ============================================================
   * 交互式模拟账户 Sim：任意时间节点买卖 + 推进时间 + 全口径分红
   *   sim = {
   *     initCash, cash, startDate, cursor, fx, taxApplies, reinvest, realized,
   *     holdings:{ qid:{quoteId,name,market,shares,costCny,divTotal,firstBuyDate} },
   *     trades:[{date,quoteId,name,market,side,price,shares,amount,fee,cur,realized?}],
   *     ledger:[分红记录], applied:{ qid:[已结算的除权日] }
   *   }
   *   价格一律用「不复权」；分红按除权除息日结算（送股自动调整股数）
   * ============================================================ */
  function simPriceAt(priceMap, qid, date) {
    const rows = priceMap && priceMap[qid];
    if (!rows || !rows.length) return null;
    let lo = 0, hi = rows.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (rows[mid].date <= date) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans >= 0 ? rows[ans].close : null;
  }

  const Sim = {
    create(initCash, startDate, opts) {
      opts = opts || {};
      return {
        initCash: initCash, cash: initCash, startDate: startDate, cursor: startDate,
        fx: opts.fx != null ? opts.fx : 0.92,
        taxApplies: opts.taxApplies !== false,
        reinvest: !!opts.reinvest,
        holdings: {}, trades: [], ledger: [], applied: {}, realized: 0
      };
    },

    priceAt: simPriceAt,

    /** 市值（CNY）：期末/当前时点所有持仓按不复权价折算 */
    marketValue(sim, priceMap, date) {
      const d = date || sim.cursor;
      let v = 0;
      Object.keys(sim.holdings).forEach(q => {
        const h = sim.holdings[q];
        if (h.shares <= 0) return;
        const px = simPriceAt(priceMap, q, d);
        if (px != null) v += h.shares * px * fxOf(sim, h.market);
      });
      return v;
    },
    total(sim, priceMap, date) { return sim.cash + Sim.marketValue(sim, priceMap, date); },

    /** 下单：t = { side:'buy'|'sell', quoteId, name, market, shares, date } */
    trade(sim, priceMap, t) {
      const date = t.date || sim.cursor;
      const px = simPriceAt(priceMap, t.quoteId, date);
      if (px == null || px <= 0) throw new Error('「' + t.name + '」在 ' + date + ' 没有行情（可能早于上市日）');
      const pxCny = px * fxOf(sim, t.market), lot = LOT[t.market] || 1;
      const shares = Math.floor(t.shares);
      if (!(shares > 0)) throw new Error('股数需为大于 0 的整数');
      const cur = t.market === 'HK' ? 'HKD' : 'CNY';

      if (t.side === 'buy') {
        if (lot > 1 && shares % lot !== 0) throw new Error('买入股数需为 ' + lot + ' 的整数倍（1 手 = ' + lot + ' 股）');
        const amount = shares * pxCny, fee = COST[t.market].buy(amount);
        if (amount + fee > sim.cash + 1e-6) {
          throw new Error('可用现金不足（需 ' + U.fmt(amount + fee, 0) + ' 元，现有 ' + U.fmt(sim.cash, 0) + ' 元）');
        }
        sim.cash -= amount + fee;
        let h = sim.holdings[t.quoteId];
        if (!h) h = sim.holdings[t.quoteId] = { quoteId: t.quoteId, name: t.name, market: t.market, shares: 0, costCny: 0, divTotal: 0, firstBuyDate: null };
        if (h.shares <= 0) h.firstBuyDate = date;
        h.shares += shares; h.costCny += amount + fee; h.name = t.name;
        sim.trades.push({ date, quoteId: t.quoteId, name: t.name, market: t.market, side: 'buy', price: px, shares, amount, fee, cur });
        return { amount, fee, price: px };
      }

      const h = sim.holdings[t.quoteId];
      if (!h || h.shares <= 0) throw new Error('没有该标的的持仓');
      if (shares > h.shares) throw new Error('卖出股数超过持仓（持有 ' + h.shares + ' 股）');
      const amount = shares * pxCny, fee = COST[t.market].sell(amount);
      const avg = h.costCny / h.shares;
      const realized = amount - fee - avg * shares;
      sim.cash += amount - fee;
      h.costCny -= avg * shares; h.shares -= shares;
      if (h.shares <= 0) { h.shares = 0; h.costCny = 0; h.firstBuyDate = null; }
      sim.realized += realized;
      sim.trades.push({ date, quoteId: t.quoteId, name: t.name, market: t.market, side: 'sell', price: px, shares, amount, fee, cur, realized });
      return { amount, fee, price: px, realized };
    },

    /** 推进时间到 toDate，结算区间内全口径分红，返回入账笔数 */
    advance(sim, priceMap, divMap, toDate) {
      const to = toDate;
      if (to < sim.cursor) throw new Error('时间只能向后推进');

      const evs = [];
      Object.keys(sim.holdings).forEach(qid => {
        const h = sim.holdings[qid];
        if (h.shares <= 0) return;
        const ap = sim.applied[qid] || (sim.applied[qid] = []);
        (divMap[qid] || []).forEach(e => {
          if (e.exDate > sim.cursor && e.exDate <= to && ap.indexOf(e.exDate) < 0) evs.push({ h, e });
        });
      });
      evs.sort((a, b) => a.e.exDate < b.e.exDate ? -1 : (a.e.exDate > b.e.exDate ? 1 : 0));

      let count = 0;
      evs.forEach(({ h, e }) => {
        const ap = sim.applied[h.quoteId];
        if (h.shares <= 0) { ap.push(e.exDate); return; }
        const before = h.shares;
        const holdDays = h.firstBuyDate ? U.days(h.firstBuyDate, e.exDate) : 0;
        let grossCny = 0, tax = 0, taxRate = 0, netCny = 0;
        if (e.cashPerShare > 0) {
          grossCny = before * e.cashPerShare * fxOf(sim, e.market);
          // A股按持股期差别化：<1月 20%、1月~1年 10%、>1年 免征；港股通 20%
          if (sim.taxApplies) taxRate = e.market === 'HK' ? 0.20 : (holdDays < 30 ? 0.20 : (holdDays < 365 ? 0.10 : 0));
          tax = grossCny * taxRate; netCny = grossCny - tax;
          sim.cash += netCny;
          h.divTotal = (h.divTotal || 0) + netCny;
        }
        let newShares = 0;
        if (e.bonusPerShare > 0) { newShares = Math.floor(before * e.bonusPerShare); h.shares += newShares; }

        let dripShares = 0, dripFee = 0, dripCost = 0;
        if (sim.reinvest && netCny > 0) {
          const px = simPriceAt(priceMap, h.quoteId, e.exDate);
          if (px != null && px > 0) {
            const pxCny = px * fxOf(sim, h.market), lot = LOT[h.market] || 1;
            let sh = Math.floor((netCny / (1 + 0.0015)) / pxCny / lot) * lot;
            while (sh > 0) {
              const amt = sh * pxCny, fee = COST[h.market].buy(amt);
              if (amt + fee <= sim.cash + 1e-6) {
                sim.cash -= amt + fee; h.shares += sh; h.costCny += amt + fee;
                dripShares = sh; dripFee = fee; dripCost = amt + fee; break;
              }
              sh -= lot;
            }
          }
        }

        sim.ledger.push({ date: e.exDate, quoteId: h.quoteId, name: h.name, market: h.market, type: e.type,
          perShare: e.cashPerShare || 0, cur: e.currency, sharesBefore: before, grossCny, tax, taxRate, netCny,
          newShares, bonusPerShare: e.bonusPerShare || 0, unmodeled: !!e.unmodeled, label: e.label || '',
          dripShares, dripFee, dripCost });
        ap.push(e.exDate);
        count++;
      });

      sim.cursor = to;
      return count;
    },

    /** 账户净值序列：从 startDate 到 cursor 回放交易/分红事件；opts.noDiv=true 时忽略分红（仅股价对比） */
    nav(sim, priceMap, opts) {
      const skipDiv = !!(opts && opts.noDiv);
      const calSet = new Set();
      Object.keys(priceMap).forEach(q => {
        (priceMap[q] || []).forEach(r => { if (r.date >= sim.startDate && r.date <= sim.cursor) calSet.add(r.date); });
      });
      const cal = Array.from(calSet).sort();
      if (!cal.length) cal.push(sim.startDate);
      if (cal[cal.length - 1] !== sim.cursor) cal.push(sim.cursor);

      const evs = [];
      sim.trades.forEach(t => { if (t.date <= sim.cursor) evs.push({ date: t.date, t, d: null }); });
      sim.ledger.forEach(l => { if (l.date <= sim.cursor) evs.push({ date: l.date, t: null, d: l }); });
      evs.sort((a, b) => a.date < b.date ? -1 : (a.date > b.date ? 1 : 0));

      let cash = sim.initCash, ei = 0;
      const sh = {};
      const mkt = {};   // quoteId -> market（用于按市场折算汇率）
      sim.trades.forEach(t => { mkt[t.quoteId] = t.market; });
      sim.ledger.forEach(l => { mkt[l.quoteId] = l.market; });
      const out = [];
      cal.forEach(day => {
        while (ei < evs.length && evs[ei].date <= day) {
          const e = evs[ei++];
          if (e.t) {
            const t = e.t;
            if (t.side === 'buy') { cash -= t.amount + t.fee; sh[t.quoteId] = (sh[t.quoteId] || 0) + t.shares; }
            else { cash += t.amount - t.fee; sh[t.quoteId] = (sh[t.quoteId] || 0) - t.shares; }
          } else if (!skipDiv) {
            const l = e.d;
            cash += l.netCny;
            if (l.newShares) sh[l.quoteId] = (sh[l.quoteId] || 0) + l.newShares;
            if (l.dripShares) { cash -= (l.dripCost || 0); sh[l.quoteId] = (sh[l.quoteId] || 0) + l.dripShares; }
          }
        }
        let v = cash;
        Object.keys(sh).forEach(q => { const p = simPriceAt(priceMap, q, day); if (p != null) v += sh[q] * p * fxOf(sim, mkt[q]); });
        out.push({ date: day, value: v });
      });
      return out;
    }
  };

  App.Engine = { run, prepare, Sim };
})(window.App);
