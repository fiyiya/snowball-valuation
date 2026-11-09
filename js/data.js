/* ============================================================
 * data.js — 数据源适配层
 *   行情K线：腾讯(主) → 东财push2his(备) → 新浪(备)
 *   A股历史估值：东财 datacenter RPT_VALUEANALYSIS_DET (JSONP)
 *   港股历史估值：东财 RPT_HKF10_FN_MAININDICATOR (JSONP) × 日线 自算
 *   搜索：东财 suggest
 * ============================================================ */
(function (App) {
  'use strict';
  const U = App.U, Net = App.Net;

  const TOKEN = 'D43BF722C8E33BDC906FB84D85E326E8';
  const DC = 'https://datacenter-web.eastmoney.com/api/data/v1/get';

  /* -------------------- 搜索 -------------------- */
  function searchStock(kw) {
    if (!kw || kw.trim().length < 1) return Promise.resolve([]);
    const url = 'https://searchapi.eastmoney.com/api/suggest/get?input=' +
      encodeURIComponent(kw.trim()) + '&type=14&token=' + TOKEN + '&count=12&cb=cb';
    return Net.request(url, { type: 'jsonp', ttl: 24 * 3600 * 1000, persist: true })
      .then(d => {
        const rows = (d && d.QuotationCodeTable && d.QuotationCodeTable.Data) || [];
        return rows
          .map(r => ({
            quoteId: r.QuoteID,
            code: r.Code,
            name: r.Name,
            market: App.U.marketOf(r.QuoteID),
            typeName: r.SecurityTypeName || ''
          }))
          .filter(r => /沪A|深A|京A|港股|上证指数|深证成指|恒生/.test(r.typeName) ||
            /^1\.|^0\.|^116\./.test(r.quoteId))
          .slice(0, 10);
      })
      .catch(() => []);
  }

  /* -------------------- K线 -------------------- */
  function klineFromTencent(quoteId, start, end) {
    const tc = U.toTencentCode(quoteId);
    const MAX = 640;
    const all = new Map();          // date -> row（自动去重）
    let curEnd = end, guard = 0;

    const finalize = () => Array.from(all.values())
      .filter(r => r.date >= start && r.date <= end)
      .sort((a, b) => a.date < b.date ? -1 : 1);

    const step = () => {
      const url = 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=' +
        tc + ',day,' + start + ',' + curEnd + ',' + MAX + ',qfq';
      return Net.request(url, { ttl: 3 * 3600 * 1000, persist: true }).then(d => {
        const pack = d && d.data && d.data[tc];
        if (!pack) throw new Error('腾讯K线无数据');
        // A股：qfqday=前复权；港股：仅 day（不复权）
        const arr = (pack.qfqday && pack.qfqday.length) ? pack.qfqday : (pack.day || []);
        if (!arr.length) return finalize();
        let minDate = null;
        arr.forEach(r => {
          if (!r || r.length < 6) return;
          all.set(r[0], { date: r[0], open: +r[1], close: +r[2], high: +r[3], low: +r[4], vol: +r[5] });
          if (!minDate || r[0] < minDate) minDate = r[0];
        });
        if (arr.length >= MAX && minDate && minDate > start && guard < 15) {
          guard++;
          curEnd = U.addDays(minDate, -1);
          return step();
        }
        return finalize();
      });
    };
    return step();
  }

  function klineFromEastmoney(quoteId, start, end) {
    const url = 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=' + quoteId +
      '&fields1=f1,f2,f3&fields2=f51,f52,f53,f54,f55,f56' +
      '&klt=101&fqt=1&beg=' + start.replace(/-/g, '') + '&end=' + end.replace(/-/g, '');
    return Net.request(url, { ttl: 3 * 3600 * 1000 }).then(d => {
      const kl = d && d.data && d.data.klines;
      if (!kl || !kl.length) throw new Error('东财K线无数据');
      return kl.map(s => {
        const p = s.split(',');
        return { date: p[0], open: +p[1], close: +p[2], high: +p[3], low: +p[4], vol: +p[5] };
      });
    });
  }

  function klineFromSina(quoteId, start, end) {
    const tc = U.toTencentCode(quoteId);
    const sym = tc.startsWith('hk') ? 'hk' + tc.slice(2).padStart(5, '0') : tc;
    const url = 'https://money.finance.sina.com.cn/quotes_service/api/json_v2.php/CN_MarketData.getKLineData?symbol=' +
      sym + '&scale=240&ma=no&datalen=1023';
    return Net.request(url, { ttl: 3 * 3600 * 1000 }).then(d => {
      const arr = Array.isArray(d) ? d : (typeof d === 'string' ? JSON.parse(d) : []);
      if (!arr.length) throw new Error('新浪K线无数据');
      return arr.map(r => ({ date: String(r.day).slice(0, 10), open: +r.open, close: +r.close, high: +r.high, low: +r.low, vol: +r.volume }))
        .filter(r => r.date >= start && r.date <= end);
    });
  }

  /** 统一K线入口（自动多源回退） */
  function getKline(quoteId, start, end) {
    return klineFromTencent(quoteId, start, end)
      .then(rows => { if (!rows || rows.length < 5) throw new Error('腾讯数据不足'); return rows; })
      .catch(() => klineFromEastmoney(quoteId, start, end))
      .catch(() => klineFromSina(quoteId, start, end))
      .then(rows => rows.sort((a, b) => a.date < b.date ? -1 : 1));
  }

  /* -------------------- A股历史估值（日度） -------------------- */
  function getValuationA(code) {
    const mk = (page) => DC + '?reportName=RPT_VALUEANALYSIS_DET&columns=ALL&filter=' +
      encodeURIComponent('(SECURITY_CODE="' + code + '")') +
      '&pageSize=1000&pageNumber=' + page + '&sortColumns=TRADE_DATE&sortTypes=-1';
    const collect = (page, acc) =>
      Net.request(mk(page), { type: 'jsonp', ttl: 12 * 3600 * 1000, persist: true }).then(d => {
        const res = d && d.result;
        if (!res || !res.data) return acc;
        acc = acc.concat(res.data);
        if (page < res.pages && page < 4) return collect(page + 1, acc);
        return acc;
      });
    return collect(1, []).then(raw => {
      const rows = raw.map(r => ({
        date: String(r.TRADE_DATE).slice(0, 10),
        close: r.CLOSE_PRICE,
        pe: r.PE_TTM,
        peLyr: r.PE_LAR,
        pb: r.PB_MRQ,
        ps: r.PS_TTM,
        pcf: r.PCF_OCF_TTM,
        mktcap: r.TOTAL_MARKET_CAP,
        name: r.SECURITY_NAME_ABBR
      })).filter(r => r.close > 0);
      rows.sort((a, b) => a.date < b.date ? -1 : 1);
      return rows;
    });
  }

  /* -------------------- 港股财报（报告期） -------------------- */
  function getHkFinancials(code) {
    const url = DC + '?reportName=RPT_HKF10_FN_MAININDICATOR&columns=ALL&filter=' +
      encodeURIComponent('(SECUCODE="' + code.padStart(5, '0') + '.HK")') +
      '&pageSize=60&sortColumns=REPORT_DATE&sortTypes=-1';
    return Net.request(url, { type: 'jsonp', ttl: 24 * 3600 * 1000, persist: true }).then(d => {
      const res = d && d.result;
      if (!res || !res.data) return [];
      const rows = res.data.map(r => ({
        reportDate: String(r.REPORT_DATE).slice(0, 10),
        peTtm: r.PE_TTM, pbTtm: r.PB_TTM,
        epsTtm: r.EPS_TTM, bps: r.BPS,
        roe: r.ROE_YEARLY, name: r.SECURITY_NAME_ABBR,
        reportType: r.REPORT_TYPE
      })).filter(r => r.reportDate && r.peTtm > 0 && r.pbTtm > 0);
      rows.sort((a, b) => a.reportDate < b.reportDate ? -1 : 1);
      return rows;
    });
  }

  /* -------------------- 构建统一序列 --------------------
   * 返回 { quoteId, name, market, series:[{date, close, pe, pb, ...}], warns:[] }
   */
  function buildSeries(quoteId, opts) {
    opts = opts || {};
    const market = U.marketOf(quoteId);
    const startDate = opts.start || '2005-01-01';
    const endDate = opts.end || U.today();
    const warns = [];

    if (market === 'A') {
      const code = quoteId.split('.')[1];
      return Promise.all([getKline(quoteId, startDate, endDate), getValuationA(code)])
        .then(([kl, val]) => {
          // 价格用「前复权日线」；估值表的 CLOSE_PRICE 为不复权，单独存 rawClose（用于估值反推 EPS/BPS）
          const valMap = {};
          val.forEach(v => valMap[v.date] = v);
          const series = kl.map(k => {
            const v = valMap[k.date] || null;
            return {
              date: k.date, close: k.close, rawClose: v ? v.close : k.close,
              open: k.open, high: k.high, low: k.low, vol: k.vol,
              pe: v ? v.pe : null, peLyr: v ? v.peLyr : null, pb: v ? v.pb : null,
              ps: v ? v.ps : null, pcf: v ? v.pcf : null, mktcap: v ? v.mktcap : null
            };
          });
          // 只补齐落在 K 线区间内的估值日（区间外不补，避免复权口径不一致）
          const have = new Set(series.map(s => s.date));
          const klFirst = kl.length ? kl[0].date : null, klLast = kl.length ? kl[kl.length - 1].date : null;
          let filled = 0;
          val.forEach(v => {
            if (have.has(v.date) || !klFirst) return;
            if (v.date < klFirst || v.date > klLast) return;
            series.push({ date: v.date, close: v.close, rawClose: v.close, open: v.close, high: v.close, low: v.close,
              vol: null, pe: v.pe, peLyr: v.peLyr, pb: v.pb, ps: v.ps, pcf: v.pcf, mktcap: v.mktcap, approx: true });
            filled++;
          });
          series.sort((a, b) => a.date < b.date ? -1 : 1);
          const overlap = val.length ? series.filter(s => valMap[s.date]).length / val.length : 0;
          if (!val.length) warns.push('未取到A股历史估值（可能被限流），PE/PB 为空');
          else if (overlap < 0.95) warns.push('估值与行情日重合度仅 ' + (overlap * 100).toFixed(0) + '%（补齐 ' + filled + ' 日）');
          const lastVal = val.length ? val[val.length - 1] : null;
          return { quoteId, market, name: lastVal ? lastVal.name : '', series, warns };
        });
    }

    // 港股：日线(不复权) × 财报期指标 自算 PE/PB
    const code = quoteId.split('.')[1];
    return Promise.all([getKline(quoteId, startDate, endDate), getHkFinancials(code)])
      .then(([kl, fins]) => {
        if (!fins.length) warns.push('未取到港股财报指标，PE/PB 将为空');
        const closes = kl.map(k => k.date);
        // 每个报告期，用报告日附近收盘价与当期PE/PB反推「每股收益/每股净资产(计价货币)」
        const finPts = fins.map(f => {
          const idx = U.lowerIndex(closes, f.reportDate);
          const px = idx >= 0 ? kl[idx].close : null;
          return {
            availDate: U.addDays(f.reportDate, App.CONFIG.reportLagDays),
            reportDate: f.reportDate,
            epsCcy: px ? px / f.peTtm : null,   // 与股价同币种的每股收益
            bpsCcy: px ? px / f.pbTtm : null,
            roe: f.roe, reportType: f.reportType
          };
        }).filter(x => x.epsCcy);

        const series = kl.map(k => {
          let cur = null;
          for (let i = 0; i < finPts.length; i++) {
            if (finPts[i].availDate <= k.date) cur = finPts[i]; else break;
          }
          return {
            date: k.date, close: k.close, rawClose: k.close, open: k.open, high: k.high, low: k.low, vol: k.vol,
            pe: cur && cur.epsCcy > 0 ? k.close / cur.epsCcy : null,
            peLyr: null,
            pb: cur && cur.bpsCcy > 0 ? k.close / cur.bpsCcy : null,
            ps: null, pcf: null, mktcap: null,
            roe: cur ? cur.roe : null
          };
        });
        const name = (fins[0] && fins[0].name) || '';
        return { quoteId, market, name, series, warns };
      });
  }

  App.Data = { searchStock, getKline, getValuationA, getHkFinancials, buildSeries };
  App.CONFIG = Object.assign({ reportLagDays: 90 }, App.CONFIG || {});

})(window.App);
