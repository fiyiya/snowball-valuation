/* ============================================================
 * indicators.js — 估值分位 / 回撤 / 收益统计
 * ============================================================ */
(function (App) {
  'use strict';
  const U = App.U;

  const I = {};

  /** 分位：值 v 在 values 中的百分位（0~100，越大越贵） */
  I.percentileRank = function (values, v) {
    if (v == null || !values.length) return null;
    let cnt = 0, n = 0;
    for (let i = 0; i < values.length; i++) {
      const x = values[i];
      if (x == null || !isFinite(x)) continue;
      n++; if (x <= v) cnt++;
    }
    return n ? cnt / n * 100 : null;
  };

  /** 取分位对应的值（线性近似）：p(0~100) 对应的估值水平 */
  I.valueAtPercentile = function (values, p) {
    const arr = values.filter(v => v != null && isFinite(v)).slice().sort((a, b) => a - b);
    if (!arr.length) return null;
    const idx = Math.min(arr.length - 1, Math.max(0, Math.round((p / 100) * (arr.length - 1))));
    return arr[idx];
  };

  /** 滚动分位：返回与 series 等长的分位数组（windowYears=0 表示全历史扩张窗口） */
  I.rollingPercentile = function (series, field, windowYears) {
    const out = new Array(series.length).fill(null);
    const startIdx = i => {
      if (!windowYears) return 0;
      const from = U.addDays(series[i].date, -Math.round(windowYears * 365.25));
      // 向前找第一个 >= from 的索引
      let lo = 0, hi = i, ans = 0;
      while (lo <= hi) {
        const m = (lo + hi) >> 1;
        if (series[m].date >= from) { ans = m; hi = m - 1; } else lo = m + 1;
      }
      return ans;
    };
    for (let i = 0; i < series.length; i++) {
      const cur = series[i][field];
      if (cur == null || !isFinite(cur)) continue;
      const s = startIdx(i);
      let cnt = 0, n = 0;
      for (let j = s; j <= i; j++) {
        const x = series[j][field];
        if (x == null || !isFinite(x)) continue;
        n++; if (x <= cur) cnt++;
      }
      out[i] = n >= 20 ? cnt / n * 100 : null;   // 样本太少不给分位
    }
    return out;
  };

  /** 回撤序列：dd = close/历史最高 - 1 */
  I.drawdownSeries = function (series) {
    let peak = -Infinity;
    return series.map(s => {
      if (s.close > peak) peak = s.close;
      return { date: s.date, dd: peak > 0 ? s.close / peak - 1 : 0, peak };
    });
  };

  /** 当前回撤 & 距高点 */
  I.currentDrawdown = function (series) {
    if (!series.length) return null;
    const last = series[series.length - 1];
    let peak = -Infinity, peakDate = null;
    for (const s of series) { if (s.close > peak) { peak = s.close; peakDate = s.date; } }
    return { dd: last.close / peak - 1, peak, peakDate, last: last.close, lastDate: last.date };
  };

  /** 指定天数窗口内的高点回撤 */
  I.drawdownInWindow = function (series, days) {
    if (!series.length) return null;
    const last = series[series.length - 1];
    if (!days) return I.currentDrawdown(series);
    const from = U.addDays(last.date, -days);
    let peak = -Infinity, peakDate = null;
    for (const s of series) { if (s.date >= from && s.close > peak) { peak = s.close; peakDate = s.date; } }
    if (peak === -Infinity) peak = last.close;
    return { dd: last.close / peak - 1, peak, peakDate, last: last.close, lastDate: last.date };
  };

  /** 最大回撤（全区间）＋ 修复情况 */
  I.maxDrawdown = function (series) {
    let peak = -Infinity, peakDate = null, mdd = 0, mPeakDate = null, mTroughDate = null, mTrough = null;
    for (const s of series) {
      if (s.close > peak) { peak = s.close; peakDate = s.date; }
      const dd = peak > 0 ? s.close / peak - 1 : 0;
      if (dd < mdd) { mdd = dd; mPeakDate = peakDate; mTroughDate = s.date; mTrough = s.close; }
    }
    // 修复日：谷底之后首次回到峰值
    let recoveryDate = null;
    if (mPeakDate && mTroughDate) {
      const peakV = series.find(s => s.date === mPeakDate).close;
      for (const s of series) { if (s.date > mTroughDate && s.close >= peakV) { recoveryDate = s.date; break; } }
    }
    const last = series[series.length - 1];
    const curDD = I.currentDrawdown(series);
    return {
      mdd, peakDate: mPeakDate, troughDate: mTroughDate, trough: mTrough,
      recoveryDate, recovered: !!recoveryDate,
      ddDays: mPeakDate && mTroughDate ? U.days(mPeakDate, mTroughDate) : null,
      recoverDays: recoveryDate && mTroughDate ? U.days(mTroughDate, recoveryDate) : null,
      curDD: curDD ? curDD.dd : 0, curPeakDate: curDD ? curDD.peakDate : null, lastDate: last.date
    };
  };

  /** 历史主要回撤区间（按深度排序取前 n） */
  I.topDrawdowns = function (series, n) {
    const eps = 0.001; // 0.1% 内视为回到高点
    const events = [];
    let peak = -Infinity, peakDate = null, trough = Infinity, troughDate = null, inDD = false;
    for (const s of series) {
      if (s.close >= peak * (1 - 1e-9)) {
        if (inDD && peakDate && troughDate) {
          events.push({ peakDate, troughDate, depth: trough / peak - 1, recoverDate: s.date,
            days: U.days(peakDate, troughDate), recoverDays: U.days(troughDate, s.date) });
        }
        peak = s.close; peakDate = s.date; trough = Infinity; troughDate = null; inDD = false;
      } else {
        if (s.close / peak - 1 < -eps) inDD = true;
        if (s.close < trough) { trough = s.close; troughDate = s.date; }
      }
    }
    if (inDD && peakDate && troughDate) {
      events.push({ peakDate, troughDate, depth: trough / peak - 1, recoverDate: null,
        days: U.days(peakDate, troughDate), recoverDays: null });
    }
    return events.sort((a, b) => a.depth - b.depth).slice(0, n || 8);
  };

  /** 净值绩效指标 */
  I.perf = function (nav, rf) {
    if (!nav || nav.length < 2) return null;
    const first = nav[0], last = nav[nav.length - 1];
    const days = Math.max(1, U.days(first.date, last.date));
    const years = days / 365.25;
    const total = last.value / first.value - 1;
    const ann = Math.pow(last.value / first.value, 1 / years) - 1;
    const rets = [];
    for (let i = 1; i < nav.length; i++) rets.push(nav[i].value / nav[i - 1].value - 1);
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / Math.max(1, rets.length - 1);
    const vol = Math.sqrt(variance * 252);
    const rfv = rf == null ? 0.02 : rf;
    const sharpe = vol > 0 ? (ann - rfv) / vol : null;
    const mdd = I.maxDrawdown(nav.map(n => ({ date: n.date, close: n.value })));
    const calmar = mdd.mdd < 0 ? ann / Math.abs(mdd.mdd) : null;
    // 胜率（按日）
    const win = rets.filter(r => r > 0).length / rets.length;
    return { total, ann, vol, sharpe, mdd: mdd.mdd, calmar, years, days, win, lastValue: last.value, firstValue: first.value };
  };

  /** 给定「信号日」列表，统计之后 h 个自然月的收益分布 */
  I.forwardReturns = function (series, signalDates, horizonsMonths) {
    const dates = series.map(s => s.date);
    const closeOf = d => { const i = U.lowerIndex(dates, d); return i >= 0 ? series[i].close : null; };
    const result = {};
    horizonsMonths.forEach(h => result[h] = []);
    signalDates.forEach(d => {
      const base = closeOf(d);
      if (!base) return;
      horizonsMonths.forEach(h => {
        const i = U.lowerIndex(dates, U.addMonths(d, h));
        if (i < 0) return;
        const future = series[i].close;
        if (future == null) return;
        result[h].push(future / base - 1);
      });
    });
    const summary = {};
    horizonsMonths.forEach(h => {
      const arr = result[h];
      if (!arr.length) { summary[h] = null; return; }
      const sorted = arr.slice().sort((a, b) => a - b);
      const q = p => sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))];
      summary[h] = {
        n: arr.length,
        mean: arr.reduce((a, b) => a + b, 0) / arr.length,
        median: q(0.5), p25: q(0.25), p75: q(0.75),
        min: sorted[0], max: sorted[sorted.length - 1],
        win: arr.filter(x => x > 0).length / arr.length
      };
    });
    return summary;
  };

  App.I = I;
})(window.App);
