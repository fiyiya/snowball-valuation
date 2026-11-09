/* ============================================================
 * ui.js — 界面渲染与交互
 * ============================================================ */
(function (App) {
  'use strict';
  const U = App.U, I = App.I, Chart = App.Chart, Data = App.Data;

  const state = App.state = {
    current: null,          // {quoteId,name,market}
    seriesCache: {},        // quoteId -> Promise<ctx>
    universe: App.Store.get('universe', []) || [],
    dashboardRangeYears: 1,
    lastBacktest: null
  };

  /* ---------------- 通用小组件 ---------------- */
  function card(label, value, sub, cls, pill) {
    return '<div class="card ' + (cls || '') + '">' +
      '<div class="c-label"><span>' + label + '</span>' + (pill || '') + '</div>' +
      '<div class="c-value">' + value + '</div>' +
      (sub ? '<div class="c-sub">' + sub + '</div>' : '') + '</div>';
  }

  function pctPill(p) {
    if (p == null) return '<span class="pill mid">无数据</span>';
    if (p < 20) return '<span class="pill good">低估 ' + p.toFixed(0) + '%</span>';
    if (p > 80) return '<span class="pill bad">高估 ' + p.toFixed(0) + '%</span>';
    if (p < 40) return '<span class="pill mid">偏低 ' + p.toFixed(0) + '%</span>';
    if (p > 60) return '<span class="pill warn">偏高 ' + p.toFixed(0) + '%</span>';
    return '<span class="pill mid">合理 ' + p.toFixed(0) + '%</span>';
  }

  /* ---------------- 搜索框 ---------------- */
  function bindSearch(inputEl, resultsEl, onPick) {
    const run = U.debounce(() => {
      const kw = inputEl.value.trim();
      if (!kw) { resultsEl.classList.add('hidden'); return; }
      Data.searchStock(kw).then(list => {
        if (!list.length) { resultsEl.innerHTML = '<div class="sr-item"><span class="sr-name">无匹配</span></div>'; resultsEl.classList.remove('hidden'); return; }
        resultsEl.innerHTML = list.map((r, i) =>
          '<div class="sr-item" data-i="' + i + '"><span class="sr-name">' + r.name +
          '<span class="sr-tag">' + (r.market === 'HK' ? '港股' : 'A股') + ' · ' + r.typeName + '</span></span>' +
          '<span class="sr-code">' + r.code + '</span></div>').join('');
        resultsEl.classList.remove('hidden');
        U.$$('.sr-item', resultsEl).forEach(el => el.addEventListener('click', () => {
          const r = list[+el.dataset.i];
          if (!r) return;
          resultsEl.classList.add('hidden'); inputEl.value = r.name;
          onPick(r);
        }));
      });
    }, 260);
    inputEl.addEventListener('input', run);
    inputEl.addEventListener('focus', () => { if (inputEl.value.trim()) run(); });
    document.addEventListener('click', e => {
      if (!resultsEl.contains(e.target) && e.target !== inputEl) resultsEl.classList.add('hidden');
    });
  }

  /* ---------------- 加载序列（带缓存） ---------------- */
  function loadSeries(quoteId, force) {
    if (!force && state.seriesCache[quoteId]) return state.seriesCache[quoteId];
    const p = Data.buildSeries(quoteId, { start: '2005-01-01', end: U.today() })
      .then(ctx => { App.Store.set('meta:' + quoteId, { name: ctx.name, market: ctx.market }); return ctx; });
    state.seriesCache[quoteId] = p;
    return p;
  }
  App.loadSeries = loadSeries;

  /* ---------------- 选中股票 ---------------- */
  function selectStock(quoteId, name) {
    const market = U.marketOf(quoteId);
    state.current = { quoteId, name: name || (App.Store.get('meta:' + quoteId, {}).name) || quoteId, market };
    showPage('dashboard');
    const dash = U.$('#dashContent'), empty = U.$('#dashEmpty');
    empty.classList.add('hidden');
    dash.classList.remove('hidden');
    U.$('#dashName').textContent = state.current.name + ' （加载中…）';
    U.$('#dashMeta').textContent = quoteId;
    U.$('#dashPrice').textContent = '…';
    U.$('#metricCards').innerHTML = '<div class="card"><span class="loading"></span>正在拉取行情与估值数据…</div>';

    loadSeries(quoteId).then(ctx => {
      state.current.name = ctx.name || state.current.name;
      renderDashboard(ctx);
      renderTarget(ctx);
      renderDrawdown(ctx);
    }).catch(err => {
      U.toast('加载失败：' + err.message + '（可点右上角"数据自检"排查）', true);
      U.$('#metricCards').innerHTML = '<div class="card">❌ 加载失败：' + err.message + '</div>';
    });
  }
  App.selectStock = selectStock;

  /* ============================================================
   * 一、估值看板
   * ============================================================ */
  function sliceYears(series, years) {
    if (!years) return series;
    const end = series[series.length - 1].date;
    const from = U.addDays(end, -Math.round(years * 365.25));
    return series.filter(s => s.date >= from);
  }

  function renderDashboard(ctx) {
    const s = ctx.series;
    if (!s.length) { U.$('#metricCards').innerHTML = '<div class="card">无数据</div>'; return; }
    const last = s[s.length - 1], prev = s[s.length - 2] || last;
    const chg = prev.close ? last.close / prev.close - 1 : 0;

    U.$('#dashName').textContent = ctx.name || ctx.quoteId;
    U.$('#dashMeta').innerHTML = ctx.quoteId + ' · ' + (ctx.market === 'HK' ? '港股' : 'A股') +
      ' · 数据区间 ' + s[0].date + ' ~ ' + last.date +
      (ctx.warns && ctx.warns.length ? ' · <span style="color:#ff9f43">' + ctx.warns.join('；') + '</span>' : '');
    U.$('#dashPrice').textContent = U.fmt(last.close, 2) + (ctx.market === 'HK' ? ' HKD' : ' CNY');
    U.$('#dashChange').className = 'change ' + U.cls(chg);
    U.$('#dashChange').textContent = U.signed(chg * 100, 2) + '%';

    // 分位（近5年）
    const r5 = sliceYears(s, 5);
    const pe5 = I.percentileRank(r5.map(x => x.pe), last.pe);
    const pb5 = I.percentileRank(r5.map(x => x.pb), last.pb);
    const peAll = I.percentileRank(s.map(x => x.pe), last.pe);
    const pbAll = I.percentileRank(s.map(x => x.pb), last.pb);
    const dd = I.currentDrawdown(s);
    const dd1 = I.drawdownInWindow(s, 365), dd3 = I.drawdownInWindow(s, 365 * 3);

    const cards = [
      card('PE (TTM)', U.fmt(last.pe, 2), '全历史分位 ' + U.fmt(peAll, 1) + '%', pe5 < 20 ? 'good' : pe5 > 80 ? 'bad' : '', pctPill(pe5)),
      card('PB (MRQ)', U.fmt(last.pb, 2), '全历史分位 ' + U.fmt(pbAll, 1) + '%', pb5 < 20 ? 'good' : pb5 > 80 ? 'bad' : '', pctPill(pb5)),
      card('当前回撤', U.fmt(dd.dd * 100, 2) + '%', '距高点 ' + dd.peakDate + ' @ ' + U.fmt(dd.peak, 2),
        dd.dd <= -0.3 ? 'good' : dd.dd <= -0.1 ? 'warn' : ''),
      card('近1年回撤', U.fmt(dd1.dd * 100, 2) + '%', '区间高点 ' + U.fmt(dd1.peak, 2), ''),
      card('近3年回撤', U.fmt(dd3.dd * 100, 2) + '%', '区间高点 ' + U.fmt(dd3.peak, 2), ''),
      card('每股净资产', last.pb > 0 ? U.fmt((last.rawClose != null ? last.rawClose : last.close) / last.pb, 2) : '—', '由价格/PB 反推', ''),
      card('当日振幅/量', s.length ? (U.fmt((last.high - last.low) / prev.close * 100, 2) + '%') : '—',
        last.vol ? ('成交 ' + U.fmt(last.vol / 10000, 0) + ' 万手') : '', '')
    ];
    U.$('#metricCards').innerHTML = cards.join('');

    renderDashCharts(ctx);
    renderPercentileTable(ctx);
  }

  function renderDashCharts(ctx) {
    const all = ctx.series;
    const view = sliceYears(all, state.dashboardRangeYears);
    const dates = view.map(s => s.date);
    const close = view.map(s => s.close);
    const pe = view.map(s => s.pe);
    const eps = view.map(s => {
      const px = s.rawClose != null ? s.rawClose : s.close;
      return (s.pe > 0 ? px / s.pe : null);
    });

    const peVals = pe.filter(v => v != null && isFinite(v));
    const p20 = I.valueAtPercentile(peVals, 20), p80 = I.valueAtPercentile(peVals, 80);
    const band = { upper: eps.map(e => e != null && p80 ? e * p80 : null), lower: eps.map(e => e != null && p20 ? e * p20 : null) };

    Chart.autoResize(U.$('#dashPriceChart'), {
      dates, height: 300, yFormat: v => U.fmt(v, 0),
      band,
      series: [
        { name: '收盘价', values: close, color: '#4a9eff', width: 1.8 },
        { name: 'PE20%分位对应价', values: band.lower, color: '#2fbf71', width: 1, dash: '4,4' },
        { name: 'PE80%分位对应价', values: band.upper, color: '#ff5c5c', width: 1, dash: '4,4' }
      ]
    });

    const pctPe = I.rollingPercentile(all, 'pe', state.dashboardRangeYears || 5);
    const pctPb = I.rollingPercentile(all, 'pb', state.dashboardRangeYears || 5);
    const mapIdx = {}; all.forEach((x, i) => mapIdx[x.date] = i);

    Chart.autoResize(U.$('#dashPeChart'), {
      dates, height: 220, zeroLine: true, yFormat: v => U.fmt(v, 0) + '%',
      series: [
        { name: 'PE分位', values: dates.map(d => pctPe[mapIdx[d]]), color: '#f0b73f', width: 1.6 }
      ]
    });
    Chart.autoResize(U.$('#dashPbChart'), {
      dates, height: 220, zeroLine: true, yFormat: v => U.fmt(v, 0) + '%',
      series: [
        { name: 'PB分位', values: dates.map(d => pctPb[mapIdx[d]]), color: '#7c5cff', width: 1.6 }
      ]
    });
  }

  function renderPercentileTable(ctx) {
    const s = ctx.series, last = s[s.length - 1];
    const windows = [{ n: '近1年', y: 1 }, { n: '近3年', y: 3 }, { n: '近5年', y: 5 }, { n: '全部', y: 0 }];
    let html = '<thead><tr><th>指标</th><th>当前值</th>' +
      windows.map(w => '<th>' + w.n + '分位</th>').join('') + '<th>区间中位</th></tr></thead><tbody>';
    [['pe', 'PE (TTM)'], ['pb', 'PB (MRQ)'], ['peLyr', 'PE (LYR)']].forEach(([f, label]) => {
      const cur = last[f];
      let row = '<tr><td>' + label + '</td><td class="mono">' + U.fmt(cur, 2) + '</td>';
      windows.forEach(w => {
        const sub = w.y ? sliceYears(s, w.y) : s;
        const p = I.percentileRank(sub.map(x => x[f]), cur);
        row += '<td class="mono">' + (p == null ? '—' : p.toFixed(1) + '%') + '</td>';
      });
      const sub5 = sliceYears(s, 5);
      row += '<td class="mono">' + U.fmt(I.valueAtPercentile(sub5.map(x => x[f]), 50), 2) + '</td></tr>';
      html += row;
    });
    html += '</tbody>';
    U.$('#dashPercentileTable').innerHTML = html;
  }

  /* ============================================================
   * 二、目标价反推
   * ============================================================ */
  function renderTarget(ctx) {
    U.$('#targetNeedStock').classList.add('hidden');
    const body = U.$('#targetBody');
    body.classList.remove('hidden');
    const s = ctx.series, last = s[s.length - 1];
    const pxLast = last.rawClose != null ? last.rawClose : last.close;
    U.$('#targetCurrent').innerHTML =
      '<span>标的：<b>' + (ctx.name || ctx.quoteId) + '</b></span>' +
      '<span>现价：<b>' + U.fmt(last.close, 2) + '</b></span>' +
      '<span>PE：<b>' + U.fmt(last.pe, 2) + '</b></span>' +
      '<span>PB：<b>' + U.fmt(last.pb, 2) + '</b></span>' +
      '<span>EPS(反推)：<b>' + (last.pe > 0 ? U.fmt(pxLast / last.pe, 3) : '—') + '</b></span>' +
      '<span>BPS(反推)：<b>' + (last.pb > 0 ? U.fmt(pxLast / last.pb, 3) : '—') + '</b></span>';

    U.$('#tgtMetric').onchange = () => {
      U.$('#tgtPctHistWrap').style.display = U.$('#tgtMetric').value === 'percentile' ? '' : 'none';
    };
    U.$('#tgtMetric').onchange();

    U.$('#btnCalcTarget').onclick = () => calcTarget(ctx);
    U.$('#btnCalcHist').onclick = () => calcHist(ctx);
    calcTarget(ctx);
  }

  function calcTarget(ctx) {
    const s = ctx.series, last = s[s.length - 1];
    const pxLast = last.rawClose != null ? last.rawClose : last.close;
    const metric = U.$('#tgtMetric').value;
    const val = U.num(U.$('#tgtValue').value);
    const box = U.$('#targetResult');
    if (val == null) { box.innerHTML = '<span style="color:#ff5c5c">请输入目标值</span>'; return; }

    let targetPrice = null, note = '';
    if (metric === 'pe') {
      if (!(last.pe > 0)) { box.innerHTML = '缺少 PE 数据'; return; }
      const eps = pxLast / last.pe;
      targetPrice = eps * val;
      note = '按当前 EPS ' + U.fmt(eps, 3) + ' 计算';
    } else if (metric === 'pb') {
      if (!(last.pb > 0)) { box.innerHTML = '缺少 PB 数据'; return; }
      const bps = pxLast / last.pb;
      targetPrice = bps * val;
      note = '按当前 BPS ' + U.fmt(bps, 3) + ' 计算';
    } else {
      const y = parseInt(U.$('#tgtPctHist').value, 10);
      const sub = y ? sliceYears(s, y) : s;
      const peAt = I.valueAtPercentile(sub.map(x => x.pe), val);
      if (peAt == null || !(last.pe > 0)) { box.innerHTML = '无法计算该分位对应估值'; return; }
      const eps = pxLast / last.pe;
      targetPrice = eps * peAt;
      note = '该分位对应 PE ≈ ' + U.fmt(peAt, 2) + '，EPS ' + U.fmt(eps, 3);
    }

    const gap = targetPrice / last.close - 1;
    box.innerHTML =
      '<div>买入限价：<span class="big">' + U.fmt(targetPrice, 2) + '</span> ' +
      (ctx.market === 'HK' ? 'HKD' : 'CNY') + '</div>' +
      '<div style="margin-top:6px">距现价：<b class="' + U.cls(gap) + '">' + U.signed(gap * 100, 2) + '%</b> ' +
      (gap < 0 ? '（需再跌 ' + U.fmt(-gap * 100, 2) + '%）' : '（已在此价之下）') + '</div>' +
      '<div style="color:#657792;font-size:12px;margin-top:6px">' + note + ' ｜ 现价 ' + U.fmt(last.close, 2) + '</div>';
  }

  function calcHist(ctx) {
    const s = ctx.series;
    const lo = U.num(U.$('#histLo').value) || 0, hi = U.num(U.$('#histHi').value) || 20;
    const pct = I.rollingPercentile(s, 'pe', 5);
    const sigDates = [];
    let inZone = false;
    s.forEach((x, i) => {
      const p = pct[i];
      const now = p != null && p >= lo && p <= hi;
      if (now && !inZone) sigDates.push(x.date);   // 进入区间的那天为一个信号
      inZone = now;
    });
    const box = U.$('#histResult');
    if (!sigDates.length) { box.innerHTML = '历史区间内没有落在该分位区间的时点。'; U.$('#histEventsTable').innerHTML = ''; return; }

    const fwd = I.forwardReturns(s, sigDates, [3, 6, 12]);
    let html = '<div>共捕捉到 <b>' + sigDates.length + '</b> 个「进入 ' + lo + '~' + hi + '% 分位」信号时点。</div>';
    html += '<table style="margin-top:10px"><thead><tr><th>持有期</th><th>样本</th><th>均值</th><th>中位</th><th>最差</th><th>最好</th><th>胜率</th></tr></thead><tbody>';
    [[3, '3个月'], [6, '6个月'], [12, '12个月']].forEach(([h, name]) => {
      const r = fwd[h];
      if (!r) { html += '<tr><td>' + name + '</td><td colspan="6">样本不足</td></tr>'; return; }
      html += '<tr><td>' + name + '</td><td>' + r.n + '</td>' +
        '<td class="' + U.cls(r.mean) + '">' + U.signed(r.mean * 100, 2) + '%</td>' +
        '<td>' + U.signed(r.median * 100, 2) + '%</td>' +
        '<td class="' + U.cls(r.min) + '">' + U.signed(r.min * 100, 2) + '%</td>' +
        '<td class="' + U.cls(r.max) + '">' + U.signed(r.max * 100, 2) + '%</td>' +
        '<td>' + U.fmt(r.win * 100, 0) + '%</td></tr>';
    });
    html += '</tbody></table>';
    box.innerHTML = html;

    // 事件明细（最近 40 个）
    const rows = sigDates.slice(-40).reverse().map(d => {
      const i = U.lowerIndex(s.map(x => x.date), d);
      const base = s[i];
      const dd = I.currentDrawdown(s.slice(0, i + 1));
      const r3 = i >= 0 ? forwardAt(s, i, 3) : null;
      const r6 = forwardAt(s, i, 6);
      const r12 = forwardAt(s, i, 12);
      return '<tr><td>' + d + '</td><td class="mono">' + U.fmt(base.close, 2) + '</td><td class="mono">' + U.fmt(base.pe, 2) +
        '</td><td class="mono">' + U.fmt(pct[i], 1) + '%</td><td class="' + U.cls(dd.dd) + '">' + U.fmt(dd.dd * 100, 1) + '%</td>' +
        '<td class="' + U.cls(r3) + '">' + (r3 == null ? '—' : U.signed(r3 * 100, 1) + '%') + '</td>' +
        '<td class="' + U.cls(r6) + '">' + (r6 == null ? '—' : U.signed(r6 * 100, 1) + '%') + '</td>' +
        '<td class="' + U.cls(r12) + '">' + (r12 == null ? '—' : U.signed(r12 * 100, 1) + '%') + '</td></tr>';
    }).join('');
    U.$('#histEventsTable').innerHTML =
      '<thead><tr><th>信号日</th><th>收盘价</th><th>PE</th><th>PE分位</th><th>当时回撤</th><th>+3月</th><th>+6月</th><th>+12月</th></tr></thead><tbody>' + rows + '</tbody>';
  }

  function forwardAt(series, i, months) {
    const target = U.addMonths(series[i].date, months);
    const j = U.lowerIndex(series.map(x => x.date), target);
    if (j <= i) return null;
    return series[j].close / series[i].close - 1;
  }

  /* ============================================================
   * 三、回撤分析
   * ============================================================ */
  function renderDrawdown(ctx) {
    U.$('#ddNeedStock').classList.add('hidden');
    U.$('#ddBody').classList.remove('hidden');
    const s = ctx.series;
    const md = I.maxDrawdown(s);
    const cur = I.currentDrawdown(s);
    const d1 = I.drawdownInWindow(s, 365), d3 = I.drawdownInWindow(s, 365 * 3), d5 = I.drawdownInWindow(s, 365 * 5);

    const ddSeries = I.drawdownSeries(s);
    const maxDD = Math.min(...ddSeries.map(x => x.dd));
    const daysInDD = ddSeries.filter(x => x.dd < -0.001).length;

    U.$('#ddCards').innerHTML = [
      card('当前回撤', U.fmt(cur.dd * 100, 2) + '%', '高点 ' + cur.peakDate, cur.dd <= -0.3 ? 'good' : cur.dd <= -0.1 ? 'warn' : ''),
      card('历史最大回撤', U.fmt(md.mdd * 100, 2) + '%', md.peakDate + ' → ' + md.troughDate, 'bad'),
      card('最大回撤修复', md.recovered ? '已修复' : '未修复', md.recovered ? ('用时 ' + md.recoverDays + ' 天') : '谷底起 ' + U.days(md.troughDate, U.today()) + ' 天仍在水下', md.recovered ? '' : 'warn'),
      card('近1年回撤', U.fmt(d1.dd * 100, 2) + '%', '高点 ' + d1.peakDate, ''),
      card('近3年回撤', U.fmt(d3.dd * 100, 2) + '%', '高点 ' + d3.peakDate, ''),
      card('近5年回撤', U.fmt(d5.dd * 100, 2) + '%', '高点 ' + d5.peakDate, ''),
      card('水下交易日占比', U.fmt(daysInDD / ddSeries.length * 100, 1) + '%', '共 ' + ddSeries.length + ' 个交易日', '')
    ].join('');

    Chart.autoResize(U.$('#ddChart'), {
      dates: s.map(x => x.date), height: 300, zeroLine: true, fillBase: 0,
      yFormat: v => U.fmt(v * 100, 0) + '%',
      series: [{ name: '回撤', values: ddSeries.map(x => x.dd), color: '#ff5c5c', fill: 'rgba(255,92,92,.22)', width: 1.5 }]
    });

    const events = I.topDrawdowns(s, 8);
    U.$('#ddTable').innerHTML =
      '<thead><tr><th>峰值日</th><th>谷底日</th><th>回撤幅度</th><th>下跌天数</th><th>修复日</th><th>修复天数</th></tr></thead><tbody>' +
      events.map(e => '<tr><td>' + e.peakDate + '</td><td>' + e.troughDate + '</td>' +
        '<td class="down">' + U.fmt(e.depth * 100, 2) + '%</td><td>' + e.days + '</td>' +
        '<td>' + (e.recoverDate || '未修复') + '</td><td>' + (e.recoverDays == null ? '—' : e.recoverDays) + '</td></tr>').join('') +
      '</tbody>';
  }

  /* ============================================================
   * 四、滚雪球回测
   * ============================================================ */
  function renderUniverse() {
    const box = U.$('#uniList');
    if (!state.universe.length) { box.innerHTML = '<div class="small-hint">还没有标的，先在上方搜索添加。</div>'; return; }
    box.innerHTML = state.universe.map((u, i) =>
      '<div class="uni-item"><span>' + u.name + ' <span class="badge">' + (u.market === 'HK' ? 'HK' : 'A') + '</span></span>' +
      '<span class="x" data-i="' + i + '">✕</span></div>').join('');
    U.$$('.uni-item .x', box).forEach(x => x.addEventListener('click', () => {
      state.universe.splice(+x.dataset.i, 1);
      App.Store.set('universe', state.universe);
      renderUniverse();
    }));
  }

  function addUniverse(r) {
    if (state.universe.some(u => u.quoteId === r.quoteId)) { U.toast('已在标的池中'); return; }
    state.universe.push({ quoteId: r.quoteId, name: r.name, market: r.market });
    App.Store.set('universe', state.universe);
    renderUniverse();
  }

  function runBacktest() {
    const cfg = {
      universe: state.universe.slice(),
      start: U.$('#btStart').value, end: U.$('#btEnd').value,
      cash: U.num(U.$('#btCash').value) || 1000000,
      high: U.num(U.$('#btHigh').value) || 80,
      low: U.num(U.$('#btLow').value) || 20,
      reduce: U.num(U.$('#btReduce').value) || 30,
      maxPos: U.num(U.$('#btMaxPos').value) || 25,
      freq: U.$('#btFreq').value,
      useDD: U.$('#btUseDD').checked,
      ddThreshold: U.num(U.$('#btDD').value) || 30,
      windowYears: parseInt(U.$('#btWindow').value, 10),
      fx: U.num(U.$('#btFx').value) || 0.92
    };
    const st = U.$('#btStatus');
    if (cfg.universe.length < 1) { U.toast('请先添加至少 1 只标的', true); return; }
    if (!(cfg.start < cfg.end)) { U.toast('开始日期需早于结束日期', true); return; }

    st.innerHTML = '<span class="loading"></span>正在加载 ' + cfg.universe.length + ' 只标的的历史数据…';
    U.$('#btEmpty').classList.add('hidden'); U.$('#btResult').classList.add('hidden');

    const jobs = cfg.universe.map(u => loadSeries(u.quoteId).then(ctx => ({ u, ctx })).catch(e => ({ u, err: e })));
    Promise.all(jobs).then(results => {
      const ok = results.filter(r => r.ctx && r.ctx.series && r.ctx.series.length > 60);
      const bad = results.filter(r => !ok.includes(r));
      if (!ok.length) { st.innerHTML = '<span style="color:#ff5c5c">所有标的数据加载失败，可能是被限流，请稍后重试或点"数据自检"。</span>'; return; }
      const seriesMap = {};
      ok.forEach(r => seriesMap[r.u.quoteId] = r.ctx);
      if (bad.length) st.innerHTML = '⚠ 部分标的跳过：' + bad.map(b => b.u.name).join('、') + '；';
      try {
        const res = App.Engine.run(Object.assign({ seriesMap }, cfg));
        state.lastBacktest = res;
        renderBacktest(res);
        st.innerHTML = (bad.length ? '⚠ 已跳过：' + bad.map(b => b.u.name).join('、') + '；' : '') +
          '<span style="color:#2fbf71">✔ 回测完成，共 ' + res.trades.length + ' 笔交易。</span>';
      } catch (e) {
        st.innerHTML = '<span style="color:#ff5c5c">回测失败：' + e.message + '</span>';
      }
    });
  }

  function renderBacktest(res) {
    U.$('#btEmpty').classList.add('hidden');
    U.$('#btResult').classList.remove('hidden');
    const sp = res.stratPerf, bp = res.bhPerf;
    const excess = sp.total - bp.total;

    U.$('#btCards').innerHTML = [
      card('策略总收益', U.signed(sp.total * 100, 2) + '%', '期末净值 ' + U.fmt(sp.lastValue, 0) + ' 元', U.cls(sp.total)),
      card('买入持有收益', U.signed(bp.total * 100, 2) + '%', '期末净值 ' + U.fmt(bp.lastValue, 0) + ' 元', U.cls(bp.total)),
      card('超额收益', U.signed(excess * 100, 2) + '%', '滚雪球 vs 躺平', U.cls(excess)),
      card('年化收益', U.signed(sp.ann * 100, 2) + '%', '持有 ' + U.fmt(sp.years, 1) + ' 年', U.cls(sp.ann)),
      card('最大回撤', U.fmt(sp.mdd * 100, 2) + '%', '基准 ' + U.fmt(bp.mdd * 100, 2) + '%', 'bad'),
      card('夏普比率', U.fmt(sp.sharpe, 2), '无风险利率按 2%', ''),
      card('卡玛比率', U.fmt(sp.calmar, 2), '年化/最大回撤', ''),
      card('波动率(年化)', U.fmt(sp.vol * 100, 2) + '%', '基准 ' + U.fmt(bp.vol * 100, 2) + '%', ''),
      card('交易笔数', res.trades.length + ' 笔', '含初始建仓', '')
    ].join('');

    const dates = res.nav.map(n => n.date);
    Chart.autoResize(U.$('#btNavChart'), {
      dates, height: 320, yFormat: v => U.fmt(v / 10000, 0) + '万',
      series: [
        { name: '滚雪球策略', values: res.nav.map(n => n.value), color: '#4a9eff', width: 2 },
        { name: '买入持有', values: res.navBH.map(n => n.value), color: '#f0b73f', width: 1.6, dash: '5,4' }
      ]
    });

    const ddS = I.drawdownSeries(res.nav.map(n => ({ date: n.date, close: n.value })));
    Chart.autoResize(U.$('#btDdChart'), {
      dates, height: 220, zeroLine: true, fillBase: 0, yFormat: v => U.fmt(v * 100, 0) + '%',
      series: [{ name: '策略回撤', values: ddS.map(x => x.dd), color: '#ff5c5c', fill: 'rgba(255,92,92,.2)' }]
    });

    const tr = res.trades.slice().reverse();
    U.$('#btTradeTable').innerHTML =
      '<thead><tr><th>日期</th><th>标的</th><th>方向</th><th>价格</th><th>数量</th><th>金额</th><th>费用</th><th>PE分位</th><th>原因</th></tr></thead><tbody>' +
      tr.map(t => '<tr><td>' + t.date + '</td><td>' + t.name + '</td>' +
        '<td class="' + (t.side === 'buy' ? 'up' : 'down') + '">' + (t.side === 'buy' ? '买入' : '卖出') + '</td>' +
        '<td class="mono">' + U.fmt(t.price, 2) + '</td><td class="mono">' + t.shares + '</td>' +
        '<td class="mono">' + U.fmt(t.amount, 0) + '</td><td class="mono">' + U.fmt(t.fee, 0) + '</td>' +
        '<td class="mono">' + (t.pct == null ? '—' : t.pct.toFixed(0) + '%') + '</td><td style="text-align:left">' + t.reason + '</td></tr>').join('') +
      '</tbody>';
  }

  /* ============================================================
   * 五、持仓账本
   * ============================================================ */
  function getLedger() { return App.Store.get('ledger', []) || []; }
  function setLedger(l) { App.Store.set('ledger', l); }

  function computePositions(ledger) {
    const byStock = {};
    ledger.slice().sort((a, b) => a.date < b.date ? -1 : 1).forEach(t => {
      const k = t.quoteId;
      byStock[k] = byStock[k] || { quoteId: k, name: t.name, shares: 0, cost: 0, realized: 0, trades: [], totalFee: 0 };
      const p = byStock[k];
      p.totalFee += t.fee || 0;
      if (t.side === 'buy') {
        p.cost += t.shares * t.price + (t.fee || 0);
        p.shares += t.shares;
      } else {
        const avg = p.shares > 0 ? p.cost / p.shares : 0;
        const s = Math.min(t.shares, p.shares);
        p.realized += s * (t.price - avg) - (t.fee || 0);
        p.cost -= avg * s; p.shares -= s;
      }
      const avgCost = p.shares > 0 ? p.cost / p.shares : 0;
      p.trades.push({ date: t.date, side: t.side, shares: t.shares, price: t.price, avgCost, sharesAfter: p.shares });
    });
    Object.values(byStock).forEach(p => { p.avgCost = p.shares > 0 ? p.cost / p.shares : 0; });
    return byStock;
  }

  function renderLedger() {
    const ledger = getLedger();
    const pos = computePositions(ledger);
    const list = Object.values(pos);

    const totalCost = list.reduce((a, p) => a + p.cost, 0);
    const totalRealized = list.reduce((a, p) => a + p.realized, 0);
    U.$('#ledgerCards').innerHTML = [
      card('持仓标的', list.filter(p => p.shares > 0).length + ' 只', '共 ' + ledger.length + ' 笔交易', ''),
      card('持仓总成本', U.fmt(totalCost, 0) + ' 元', '当前在仓', ''),
      card('已实现盈亏', U.signed(totalRealized, 0) + ' 元', '卖出部分累计', U.cls(totalRealized)),
      card('累计交易费用', U.fmt(list.reduce((a, p) => a + p.totalFee, 0), 0) + ' 元', '佣金+税费', '')
    ].join('');

    U.$('#ledgerTable').innerHTML =
      '<thead><tr><th>标的</th><th>持有股数</th><th>摊薄成本</th><th>累计成本</th><th>已实现盈亏</th><th>交易次数</th></tr></thead><tbody>' +
      (list.length ? list.map(p => '<tr><td>' + p.name + '</td><td class="mono">' + p.shares + '</td>' +
        '<td class="mono">' + U.fmt(p.avgCost, 3) + '</td><td class="mono">' + U.fmt(p.cost, 0) + '</td>' +
        '<td class="mono ' + U.cls(p.realized) + '">' + U.signed(p.realized, 0) + '</td><td>' + p.trades.length + '</td></tr>').join('')
        : '<tr><td colspan="6" style="text-align:center;color:#657792">暂无记录</td></tr>') +
      '</tbody>';

    // 成本摊薄曲线（取交易最多的标的）
    const main = list.slice().sort((a, b) => b.trades.length - a.trades.length)[0];
    if (main && main.trades.length > 1) {
      Chart.autoResize(U.$('#ledgerChart'), {
        dates: main.trades.map(t => t.date), height: 280,
        yFormat: v => U.fmt(v, 2),
        series: [
          { name: main.name + '·摊薄成本', values: main.trades.map(t => t.avgCost), color: '#4a9eff', width: 2 },
          { name: '成交价', values: main.trades.map(t => t.price), color: '#f0b73f', width: 1.3, dash: '4,3' }
        ]
      });
    } else {
      U.$('#ledgerChart').innerHTML = '<div class="empty-inline">记录 2 笔以上交易后显示成本摊薄曲线</div>';
    }
  }

  /* ---------------- 页面切换 ---------------- */
  function showPage(name) {
    U.$$('.page').forEach(p => p.classList.remove('active'));
    U.$$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    const pg = U.$('#page-' + name);
    if (pg) pg.classList.add('active');
    if (name === 'ledger') renderLedger();
    if (name === 'snowball') { renderUniverse(); if (state.lastBacktest) renderBacktest(state.lastBacktest); }
    if (name === 'dashboard' && state.current) {
      const c = state.seriesCache[state.current.quoteId];
      if (c) c.then(ctx => { renderDashCharts(ctx); });
    }
    if (name === 'target' && state.current) {
      const c = state.seriesCache[state.current.quoteId];
      if (c) c.then(ctx => renderTarget(ctx));
    }
    if (name === 'drawdown' && state.current) {
      const c = state.seriesCache[state.current.quoteId];
      if (c) c.then(ctx => renderDrawdown(ctx));
    }
  }

  /* ---------------- 初始化 ---------------- */
  function init() {
    // 顶部搜索
    bindSearch(U.$('#globalSearch'), U.$('#searchResults'), r => selectStock(r.quoteId, r.name));
    U.$$('.chip').forEach(c => c.addEventListener('click', () => {
      const q = c.dataset.sym;
      selectStock(q, c.textContent);
    }));

    // Tab
    U.$$('.tab').forEach(t => t.addEventListener('click', () => showPage(t.dataset.tab)));

    // 看板区间
    U.$$('#dashRangeSeg button').forEach(b => b.addEventListener('click', () => {
      U.$$('#dashRangeSeg button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      state.dashboardRangeYears = parseFloat(b.dataset.range);
      const c = state.seriesCache[state.current && state.current.quoteId];
      if (c) c.then(ctx => { renderDashCharts(ctx); renderPercentileTable(ctx); });
    }));

    // 回测：标的池
    bindSearch(U.$('#uniSearch'), U.$('#uniSearchResults'), r => {
      addUniverse(r);
      U.$('#uniSearch').value = '';
    });
    const end = U.today(), start = U.addDays(end, -365 * 5);
    U.$('#btStart').value = start; U.$('#btEnd').value = end;
    U.$('#btnRunBacktest').addEventListener('click', runBacktest);
    renderUniverse();

    // 账本
    U.$('#btnAddTrade').addEventListener('click', () => openTradeModal());
    U.$('#btnClearLedger').addEventListener('click', () => {
      if (confirm('确认清空全部账本记录？')) { setLedger([]); renderLedger(); }
    });
    bindTradeModal();

    // 诊断
    U.$('#btnDiagnose').addEventListener('click', openDiag);
    U.$('#btnDiagClose').addEventListener('click', () => U.$('#diagModal').classList.add('hidden'));
    U.$('#btnDiagRun').addEventListener('click', runDiag);
  }

  /* ---------------- 交易模态 ---------------- */
  let picked = null;
  function openTradeModal() {
    picked = null;
    U.$('#trDate').value = U.today();
    U.$('#trPrice').value = ''; U.$('#trShares').value = ''; U.$('#trNote').value = '';
    U.$('#trSearch').value = ''; U.$('#trPicked').textContent = '';
    U.$('#modal').classList.remove('hidden');
  }
  function bindTradeModal() {
    bindSearch(U.$('#trSearch'), U.$('#trSearchResults'), r => {
      picked = r;
      U.$('#trPicked').textContent = '已选：' + r.name + ' (' + r.code + ')';
      U.$('#trSearch').value = r.name;
    });
    U.$('#btnModalCancel').addEventListener('click', () => U.$('#modal').classList.add('hidden'));
    U.$('#btnModalSave').addEventListener('click', () => {
      const date = U.$('#trDate').value, side = U.$('#trSide').value;
      const price = U.num(U.$('#trPrice').value), shares = U.num(U.$('#trShares').value);
      if (!picked) { U.toast('请先选择股票', true); return; }
      if (!date || !price || !shares) { U.toast('请填写日期/价格/数量', true); return; }
      const market = U.marketOf(picked.quoteId);
      const amount = price * shares;
      const fee = side === 'buy' ? App.COST[market].buy(amount) : App.COST[market].sell(amount);
      const ledger = getLedger();
      ledger.push({ date, quoteId: picked.quoteId, name: picked.name, side, price, shares, fee, note: U.$('#trNote').value });
      setLedger(ledger);
      U.$('#modal').classList.add('hidden');
      renderLedger();
      U.toast('已记录（预估费用 ' + U.fmt(fee, 2) + ' 元）');
    });
  }

  /* ---------------- 数据自检 ---------------- */
  function openDiag() { U.$('#diagModal').classList.remove('hidden'); runDiag(); }
  function runDiag() {
    const tests = [
      { name: '行情K线 · 腾讯（贵州茅台）', url: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=sh600519,day,,,20,qfq', pick: d => Object.keys(d.data || {}).join(',') },
      { name: '行情K线 · 腾讯（腾讯控股）', url: 'https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=hk00700,day,,,20,qfq' },
      { name: 'A股历史估值 · 东财(JSONP)', url: 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_VALUEANALYSIS_DET&columns=SECURITY_CODE,TRADE_DATE,PE_TTM,PB_MRQ&filter=' + encodeURIComponent('(SECURITY_CODE="600519")') + '&pageSize=3&sortColumns=TRADE_DATE&sortTypes=-1', type: 'jsonp' },
      { name: '港股财报 · 东财(JSONP)', url: 'https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_HKF10_FN_MAININDICATOR&columns=SECUCODE,REPORT_DATE,PE_TTM,PB_TTM&filter=' + encodeURIComponent('(SECUCODE="00700.HK")') + '&pageSize=3&sortColumns=REPORT_DATE&sortTypes=-1', type: 'jsonp' },
      { name: '股票搜索 · 东财(JSONP)', url: 'https://searchapi.eastmoney.com/api/suggest/get?input=' + encodeURIComponent('茅台') + '&type=14&token=D43BF722C8E33BDC906FB84D85E326E8&count=3&cb=cb', type: 'jsonp' },
      { name: '行情K线 · 东财(备用域)', url: 'https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=1.600519&fields1=f1&fields2=f51,f53&klt=101&fqt=1&lmt=5&end=20500101' }
    ];
    const box = U.$('#diagList');
    box.innerHTML = tests.map(t => '<div class="diag-item"><span>' + t.name + '</span><span class="st run">测试中…</span></div>').join('');
    const items = U.$$('.diag-item .st', box);
    tests.forEach((t, i) => {
      App.Net.request(t.url, { ttl: 0, retries: 0, type: t.type === 'jsonp' ? 'jsonp' : 'fetch' })
        .then(d => {
          items[i].className = 'st ok';
          items[i].textContent = '✔ 正常 (' + (t.pick ? t.pick(d) : 'OK') + ')';
        })
        .catch(e => { items[i].className = 'st fail'; items[i].textContent = '✘ ' + e.message; });
    });
  }

  App.UI = { init, selectStock, showPage, renderLedger, loadSeries };

})(window.App);
