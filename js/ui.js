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
    lastBacktest: null,
    tmRows: null,           // 回到那一天：[{u,ctx,snap}]
    tmSymbol: null,         // 当前展开的标的
    tmWindow: 5,            // 回看窗口（年，0=全部）
    tmDate: null,           // 最近一次复盘的日期
    acSim: null,            // 交互式模拟账户引擎状态（cash/holdings/trades/ledger/cursor…）
    acWatch: [],            // 交易标的（自选）：[{quoteId,name,market}]
    acActiveId: null,       // 当前交易标 quoteId
    acSide: 'buy',          // 交易方向 buy / sell
    acPriceMap: {},         // quoteId -> [{date,close}] 不复权
    acDivMap: {}            // quoteId -> [分红事件]
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
  function renderUniverseList() {
    ['#uniList', '#tmUniList'].forEach(sel => {
      const box = U.$(sel);
      if (!box) return;
      if (!state.universe.length) { box.innerHTML = '<div class="small-hint">还没有标的，先在上方搜索添加。</div>'; return; }
      box.innerHTML = state.universe.map((u, i) =>
        '<div class="uni-item"><span>' + u.name + ' <span class="badge">' + (u.market === 'HK' ? 'HK' : 'A') + '</span></span>' +
        '<span class="x" data-i="' + i + '">✕</span></div>').join('');
      U.$$('.uni-item .x', box).forEach(x => x.addEventListener('click', () => {
        state.universe.splice(+x.dataset.i, 1);
        App.Store.set('universe', state.universe);
        renderUniverseList();
      }));
    });
  }

  function addUniverse(r) {
    if (state.universe.some(u => u.quoteId === r.quoteId)) { U.toast('已在标的池中'); return; }
    state.universe.push({ quoteId: r.quoteId, name: r.name, market: r.market });
    App.Store.set('universe', state.universe);
    renderUniverseList();
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

  /* ============================================================
   * 六、回到那一天（时间旅行复盘）
   * ============================================================ */
  /** 计算某标的在 dateStr（该日或之前最近交易日）的快照 */
  function tmSnapshot(ctx, dateStr, windowYears) {
    const s = ctx.series;
    if (!s.length) return null;
    const i = U.lowerIndex(s.map(x => x.date), dateStr);
    if (i < 0) return null;
    const row = s[i];
    // 分位窗口：截至那天、往前 windowYears 年（0=全部历史）
    const from = windowYears ? U.addDays(row.date, -Math.round(windowYears * 365.25)) : null;
    let win = from ? s.slice(0, i + 1).filter(x => x.date >= from) : s.slice(0, i + 1);
    const pePct = I.percentileRank(win.map(x => x.pe), row.pe);
    const pbPct = I.percentileRank(win.map(x => x.pb), row.pb);
    // 距当时历史高点回撤
    let peak = -Infinity, peakDate = null;
    for (let j = 0; j <= i; j++) if (s[j].close > peak) { peak = s[j].close; peakDate = s[j].date; }
    const prev = i > 0 ? s[i - 1] : row;
    return {
      i, date: row.date, close: row.close, pe: row.pe, pb: row.pb,
      chg: prev.close ? row.close / prev.close - 1 : 0,
      dd: peak > 0 ? row.close / peak - 1 : 0, peak, peakDate,
      pePct, pbPct
    };
  }

  function runTimeMachine() {
    const dateStr = U.$('#tmDate').value;
    const wy = parseInt(U.$('#tmWindow').value, 10) || 0;
    const st = U.$('#tmStatus');
    if (!state.universe.length) { U.toast('请先添加至少 1 只标的', true); return; }
    if (!dateStr) { U.toast('请先选择日期', true); return; }

    U.$('#tmResult').classList.add('hidden');
    st.innerHTML = '<span class="loading"></span>正在加载 ' + state.universe.length + ' 只标的的历史数据…';
    state.tmWindow = wy;

    const jobs = state.universe.map(u => loadSeries(u.quoteId).then(ctx => ({ u, ctx })).catch(e => ({ u, err: e })));
    Promise.all(jobs).then(results => {
      const ok = results.filter(r => r.ctx && r.ctx.series && r.ctx.series.length);
      const bad = results.filter(r => !ok.includes(r));
      if (!ok.length) { st.innerHTML = '<span style="color:#ff5c5c">所有标的数据加载失败，可能被限流，请稍后重试或点「数据自检」。</span>'; return; }

      const rows = ok.map(r => ({ u: r.u, ctx: r.ctx, snap: tmSnapshot(r.ctx, dateStr, wy) })).filter(r => r.snap);
      if (!rows.length) { st.innerHTML = '<span style="color:#ff5c5c">所选日期早于所有标的的数据起点，请选晚一点。</span>'; return; }

      state.tmRows = rows;
      state.tmDate = dateStr;
      if (!state.tmSymbol || !rows.some(r => r.u.quoteId === state.tmSymbol)) state.tmSymbol = rows[0].u.quoteId;

      U.$('#tmResultTitle').textContent = '回到 ' + dateStr;
      U.$('#tmResultMeta').textContent = '各标的取该日或之前最近交易日 · 分位窗口 ' + (wy ? '近' + wy + '年' : '全部历史');
      renderTmTable(rows);
      renderTmCharts();
      U.$('#tmResult').classList.remove('hidden');
      st.innerHTML = (bad.length ? '⚠ 已跳过：' + bad.map(b => b.u.name).join('、') + '；' : '') +
        '<span style="color:#2fbf71">✔ 已回到 ' + rows[0].snap.date + '（点击表中标的大图查看其K线）</span>';
    });
  }

  function renderTmTable(rows) {
    const head = '<thead><tr><th>标的</th><th>当日收盘</th><th>当日涨跌</th><th>PE</th><th>PE分位</th>' +
      '<th>PB</th><th>PB分位</th><th>距当时高点回撤</th></tr></thead>';
    const body = rows.map(r => {
      const s = r.snap, c = r.ctx;
      const cur = c.market === 'HK' ? ' HKD' : '';
      const sel = r.u.quoteId === state.tmSymbol ? ' class="row-sel"' : '';
      return '<tr data-qid="' + r.u.quoteId + '"' + sel + '>' +
        '<td>' + r.u.name + ' <span class="badge">' + (c.market === 'HK' ? 'HK' : 'A') + '</span></td>' +
        '<td class="mono">' + U.fmt(s.close, 2) + cur + '</td>' +
        '<td class="' + U.cls(s.chg) + '">' + U.signed(s.chg * 100, 2) + '%</td>' +
        '<td class="mono">' + U.fmt(s.pe, 2) + '</td>' +
        '<td>' + (s.pePct == null ? '—' : pctPill(s.pePct)) + '</td>' +
        '<td class="mono">' + U.fmt(s.pb, 2) + '</td>' +
        '<td>' + (s.pbPct == null ? '—' : pctPill(s.pbPct)) + '</td>' +
        '<td class="' + U.cls(s.dd) + '">' + U.fmt(s.dd * 100, 2) + '%</td>' +
        '</tr>';
    }).join('');
    U.$('#tmTable').innerHTML = head + '<tbody>' + body + '</tbody>';
    U.$$('#tmTable tbody tr').forEach(tr => tr.addEventListener('click', () => {
      state.tmSymbol = tr.dataset.qid;
      renderTmTable(state.tmRows);
      renderTmCharts();
    }));
  }

  function renderTmCharts() {
    const rows = state.tmRows || [];
    const row = rows.find(r => r.u.quoteId === state.tmSymbol);
    if (!row || !row.snap) return;
    const s = row.ctx.series;
    const wy = state.tmWindow;
    const snap = row.snap;

    // 只取到那一天为止，且按窗口截取
    const viewAll = s.slice(0, snap.i + 1);
    const from = wy ? U.addDays(viewAll[viewAll.length - 1].date, -Math.round(wy * 365.25)) : null;
    const view = from ? viewAll.filter(x => x.date >= from) : viewAll;
    const dates = view.map(x => x.date);
    const close = view.map(x => x.close);
    const eps = view.map(x => {
      const px = x.rawClose != null ? x.rawClose : x.close;
      return x.pe > 0 ? px / x.pe : null;
    });
    const peVals = view.map(x => x.pe).filter(v => v != null && isFinite(v));
    const p20 = I.valueAtPercentile(peVals, 20), p80 = I.valueAtPercentile(peVals, 80);
    const band = { upper: eps.map(e => e != null && p80 ? e * p80 : null), lower: eps.map(e => e != null && p20 ? e * p20 : null) };

    U.$('#tmChartTitle').textContent = row.u.name + ' · 截至 ' + snap.date + ' 的K线';
    Chart.autoResize(U.$('#tmPriceChart'), {
      dates, height: 300, yFormat: v => U.fmt(v, 0),
      band, markers: [{ date: snap.date, color: '#f0b73f' }],
      series: [
        { name: '收盘价', values: close, color: '#4a9eff', width: 1.8 },
        { name: 'PE20%分位对应价', values: band.lower, color: '#2fbf71', width: 1, dash: '4,4' },
        { name: 'PE80%分位对应价', values: band.upper, color: '#ff5c5c', width: 1, dash: '4,4' }
      ]
    });

    // 分位曲线：在完整序列上滚动计算，再按 view 日期取用（口径与表中分位一致）
    const idxOf = {}; s.forEach((x, i) => idxOf[x.date] = i);
    const pctPe = I.rollingPercentile(s, 'pe', wy);
    const pctPb = I.rollingPercentile(s, 'pb', wy);
    Chart.autoResize(U.$('#tmPeChart'), {
      dates, height: 220, zeroLine: true, yFormat: v => U.fmt(v, 0) + '%',
      markers: [{ date: snap.date, color: '#f0b73f' }],
      series: [{ name: 'PE分位', values: dates.map(d => pctPe[idxOf[d]]), color: '#f0b73f', width: 1.6 }]
    });
    Chart.autoResize(U.$('#tmPbChart'), {
      dates, height: 220, zeroLine: true, yFormat: v => U.fmt(v, 0) + '%',
      markers: [{ date: snap.date, color: '#7c5cff' }],
      series: [{ name: 'PB分位', values: dates.map(d => pctPb[idxOf[d]]), color: '#7c5cff', width: 1.6 }]
    });
  }

  /* ============================================================
   * 七、模拟账户 · 交互交易台
   * ============================================================ */
  const Sim = App.Engine.Sim;
  const AC_KEY = 'acSim';

  /** 用当前「穿越设置」表单创建全新账户状态 */
  function acNewSim() {
    const start = U.$('#acStartDate').value || U.addDays(U.today(), -365 * 5);
    const cash = U.num(U.$('#acCash').value) || 1000000;
    const fx = U.num(U.$('#acFx').value) || 0.92;
    return Sim.create(cash, start, {
      fx, taxApplies: U.$('#acTax').checked, reinvest: U.$('#acReinvest').checked
    });
  }

  function acSave() {
    App.Store.set(AC_KEY, { sim: state.acSim, watch: state.acWatch, active: state.acActiveId });
  }

  function acRestore() {
    const saved = App.Store.get(AC_KEY, null);
    if (saved && saved.sim && saved.sim.startDate) {
      state.acSim = saved.sim;
      state.acWatch = saved.watch || [];
      state.acActiveId = saved.active || null;
      return true;
    }
    return false;
  }

  /** 加载某标的的不复权行情 + 分红（带缓存；缓存不持久化，刷新后按需重载） */
  function acEnsure(quoteId) {
    if (state.acPriceMap[quoteId]) return Promise.resolve(state.acPriceMap[quoteId]);
    const start = U.addDays(state.acSim.startDate, -10), end = U.today();
    return Promise.all([
      Data.getKlineRaw(quoteId, start, end),
      Data.getDividends(quoteId)
    ]).then(([rows, divs]) => {
      state.acPriceMap[quoteId] = rows || [];
      state.acDivMap[quoteId] = divs || [];
      return state.acPriceMap[quoteId];
    });
  }

  function acLoadAll() {
    const ids = {};
    state.acWatch.forEach(w => { ids[w.quoteId] = 1; });
    Object.keys(state.acSim.holdings).forEach(q => { ids[q] = 1; });
    return Promise.all(Object.keys(ids).map(q => acEnsure(q).catch(() => null)));
  }

  function acWatchItem(quoteId) { return state.acWatch.find(w => w.quoteId === quoteId) || null; }
  function acActive() {
    const id = state.acActiveId; if (!id) return null;
    const w = acWatchItem(id); if (w) return w;
    const h = state.acSim.holdings[id];
    return h ? { quoteId: id, name: h.name, market: h.market } : null;
  }

  function acAddWatch(r) {
    if (!acWatchItem(r.quoteId)) state.acWatch.push({ quoteId: r.quoteId, name: r.name, market: r.market });
    state.acActiveId = r.quoteId;
    acSave();
    acEnsure(r.quoteId).catch(() => null).then(() => acRenderAll());
  }

  function acRemoveWatch(quoteId) {
    state.acWatch = state.acWatch.filter(w => w.quoteId !== quoteId);
    if (state.acActiveId === quoteId) state.acActiveId = state.acWatch.length ? state.acWatch[0].quoteId : null;
    acSave(); acRenderAll();
  }

  /* ---------------- 下单 ---------------- */
  function acDoTrade() {
    const sim = state.acSim, w = acActive();
    if (!w) { U.toast('请先选择标的', true); return; }
    const side = state.acSide;
    const shares = Math.floor(U.num(U.$('#acShares').value) || 0);
    if (!(shares > 0)) { U.toast('请输入股数（整数）', true); return; }
    acEnsure(w.quoteId).then(() => {
      try {
        const r = Sim.trade(sim, state.acPriceMap, {
          side, quoteId: w.quoteId, name: w.name, market: w.market, shares, date: sim.cursor
        });
        acSave(); acRenderAll();
        const cur = w.market === 'HK' ? ' HKD' : ' 元';
        U.toast((side === 'buy' ? '✔ 买入 ' : '✔ 卖出 ') + w.name + ' ' + shares + ' 股 @ ' +
          U.fmt(r.price, 3) + cur + '（手续费 ' + U.fmt(r.fee, 2) + ' 元）');
      } catch (e) { U.toast(e.message, true); }
    }).catch(e => U.toast('行情加载失败：' + e.message, true));
  }

  /* ---------------- 时间推进 ---------------- */
  function acDoAdvance() {
    const sim = state.acSim;
    const to = U.$('#acTargetDate').value;
    if (!to) { U.toast('请选择推进到的日期', true); return; }
    if (to < sim.cursor) { U.toast('时间只能向后推进（当前 ' + sim.cursor + '）', true); return; }
    if (to > U.today()) { U.toast('无未来数据，最远到今天 ' + U.today(), true); return; }
    const qids = Object.keys(sim.holdings).filter(q => sim.holdings[q].shares > 0);
    Promise.all(qids.map(q => acEnsure(q).catch(() => null))).then(() => {
      const n = Sim.advance(sim, state.acPriceMap, state.acDivMap, to);
      acSave(); acRenderAll();
      const total = sim.cash + Sim.marketValue(sim, state.acPriceMap);
      U.toast('⏩ 已推进到 ' + to + '，结算 ' + n + ' 笔分红 / 送股 · 总资产 ' + U.fmt(total, 0) + ' 元');
    }).catch(e => U.toast('数据加载失败：' + e.message, true));
  }

  function acReset() {
    if (!confirm('重置账户？将清空全部交易、持仓与分红记录。')) return;
    state.acSim = acNewSim();
    state.acWatch = []; state.acActiveId = null;
    state.acPriceMap = {}; state.acDivMap = {};
    U.$('#acTargetDate').value = state.acSim.cursor;
    U.$('#acSetupStatus').innerHTML = '';
    acSave(); acRenderAll();
    U.toast('账户已重置：起始 ' + state.acSim.startDate + ' · 资金 ' + U.fmt(state.acSim.initCash, 0) + ' 元');
  }

  function acBoot() {
    const restored = acRestore();
    if (!restored) state.acSim = acNewSim();
    const sim = state.acSim;
    U.$('#acStartDate').value = sim.startDate;
    U.$('#acCash').value = sim.initCash;
    U.$('#acFx').value = sim.fx;
    U.$('#acTax').checked = !!sim.taxApplies;
    U.$('#acReinvest').checked = !!sim.reinvest;
    U.$('#acTargetDate').value = sim.cursor;
    if (!state.acActiveId && state.acWatch.length) state.acActiveId = state.acWatch[0].quoteId;
    acSave();
    acRenderAll();
    acLoadAll().then(() => acRenderAll());
  }

  /* ---------------- 渲染 ---------------- */
  function acRenderAll() {
    renderAcState(); renderAcWatch(); renderAcTradeBox();
    renderAcAdvMeta(); renderAcNav();
    renderAcHold(); renderAcTrades(); renderAcDiv(); renderAcKline();
  }

  function renderAcState() {
    const sim = state.acSim, pm = state.acPriceMap;
    const mkt = Sim.marketValue(sim, pm);
    const total = sim.cash + mkt;
    const divTotal = sim.ledger.reduce((a, l) => a + (l.netCny || 0), 0);
    let floating = 0, nHold = 0;
    Object.keys(sim.holdings).forEach(q => {
      const h = sim.holdings[q];
      if (h.shares <= 0) return;
      nHold++;
      const px = Sim.priceAt(pm, q, sim.cursor);
      if (px != null) floating += h.shares * px * (h.market === 'HK' ? sim.fx : 1) - h.costCny;
    });
    const retTotal = sim.initCash > 0 ? total / sim.initCash - 1 : 0;
    const nBuy = sim.trades.filter(t => t.side === 'buy').length;
    const nSell = sim.trades.length - nBuy;
    U.$('#acCurDate').textContent = '当前时间节点：' + sim.cursor;
    U.$('#acCards').innerHTML = [
      card('账户总资产', U.fmt(total, 0) + ' 元', '初始 ' + U.fmt(sim.initCash, 0) + ' 元', U.cls(total - sim.initCash)),
      card('总收益', U.signed(retTotal * 100, 2) + '%', '自 ' + sim.startDate, U.cls(retTotal)),
      card('可用现金', U.fmt(sim.cash, 0) + ' 元', '含分红沉淀', ''),
      card('持仓市值', U.fmt(mkt, 0) + ' 元', nHold + ' 只持仓', ''),
      card('累计分红（税后）', U.fmt(divTotal, 0) + ' 元', '共 ' + sim.ledger.length + ' 笔入账', 'good'),
      card('已实现盈亏', U.signed(sim.realized, 0) + ' 元', '卖出落袋', U.cls(sim.realized)),
      card('浮动盈亏', U.signed(floating, 0) + ' 元', '按当前不复权价', U.cls(floating)),
      card('交易次数', String(sim.trades.length), '买 ' + nBuy + ' / 卖 ' + nSell, '')
    ].join('');
  }

  function renderAcWatch() {
    const box = U.$('#acWatchList'); if (!box) return;
    const sim = state.acSim;
    if (!state.acWatch.length) { box.innerHTML = '<div class="small-hint">还没有标的，先在上方搜索添加。</div>'; return; }
    box.innerHTML = state.acWatch.map(w => {
      const h = sim.holdings[w.quoteId];
      const px = Sim.priceAt(state.acPriceMap, w.quoteId, sim.cursor);
      const cur = w.market === 'HK' ? 'HKD' : '元';
      const sel = w.quoteId === state.acActiveId ? ' on' : '';
      const hold = (h && h.shares > 0) ? ('持 ' + h.shares + ' 股') : '未持仓';
      const priceTxt = px != null ? U.fmt(px, 3) + ' ' + cur : '加载中…';
      return '<div class="ac-pos-item' + sel + '" data-qid="' + w.quoteId + '">' +
        '<div class="ac-pos-name">' + w.name + ' <span class="badge">' + (w.market === 'HK' ? 'HK' : 'A') + '</span> ' +
        '<span class="small-hint">' + hold + '</span></div>' +
        '<div class="ac-pos-amt mono">' + priceTxt + '</div>' +
        '<span class="x" data-qid="' + w.quoteId + '">✕</span></div>';
    }).join('');
    U.$$('.ac-pos-item', box).forEach(el => el.addEventListener('click', e => {
      if (e.target.classList.contains('x')) return;
      state.acActiveId = el.dataset.qid; acSave();
      renderAcWatch(); renderAcTradeBox(); renderAcKline();
    }));
    U.$$('.ac-pos-item .x', box).forEach(x => x.addEventListener('click', ev => { ev.stopPropagation(); acRemoveWatch(x.dataset.qid); }));
  }

  function renderAcTradeBox() {
    const box = U.$('#acTradeInfo'); if (!box) return;
    const w = acActive(), sim = state.acSim;
    const quick = U.$('#acQuick');
    if (!w) { box.innerHTML = '请先在上方选择或添加标的'; quick.innerHTML = ''; return; }
    const px = Sim.priceAt(state.acPriceMap, w.quoteId, sim.cursor);
    const cur = w.market === 'HK' ? 'HKD' : '元';
    const h = sim.holdings[w.quoteId];
    const lot = 100;
    let s = '<b>' + w.name + '</b> <span class="badge">' + (w.market === 'HK' ? 'HK' : 'A') + '</span>　' +
      sim.cursor + ' 收盘价 <b class="mono">' + (px != null ? U.fmt(px, 3) + ' ' + cur : '无行情') + '</b>';
    if (px != null && w.market === 'HK') s += ' <span class="small-hint">≈ ' + U.fmt(px * sim.fx, 3) + ' 元</span>';
    if (h && h.shares > 0) s += '<br><span class="small-hint">持仓 ' + h.shares + ' 股 · 成本均价 ' +
      U.fmt(h.costCny / h.shares, 3) + ' 元 · 累计分红 ' + U.fmt(h.divTotal || 0, 0) + ' 元</span>';
    box.innerHTML = s;

    const side = state.acSide;
    let maxBuy = 0;
    if (px != null && px > 0) {
      const pxCny = px * sim.fx;
      maxBuy = Math.floor((sim.cash / (1 + 0.0015)) / pxCny / lot) * lot;
    }
    const labels = side === 'buy' ? ['1手', '5手', '10手', '全仓'] : ['1手', '半仓', '全部'];
    quick.innerHTML = labels.map(q => '<button class="ac-quick-btn" data-q="' + q + '">' + q + '</button>').join('');
    U.$$('.ac-quick-btn', quick).forEach(b => b.addEventListener('click', () => {
      const q = b.dataset.q, held = h ? h.shares : 0;
      let sh = lot;
      if (q === '5手') sh = lot * 5;
      else if (q === '10手') sh = lot * 10;
      else if (q === '全仓') sh = maxBuy;
      else if (q === '半仓') sh = Math.floor((held / 2) / lot) * lot;
      else if (q === '全部') sh = held;
      U.$('#acShares').value = sh > 0 ? sh : '';
    }));
  }

  function renderAcAdvMeta() {
    U.$('#acAdvMeta').textContent = '当前 ' + state.acSim.cursor + ' · 最远可推进到 ' + U.today();
  }

  function renderAcNav() {
    const sim = state.acSim, pm = state.acPriceMap;
    const nav = Sim.nav(sim, pm);
    const navNo = Sim.nav(sim, pm, { noDiv: true });
    const total = nav.length ? nav[nav.length - 1].value : sim.cash;
    U.$('#acNavMeta').textContent = nav.length + ' 个交易日 · ' + U.fmt(sim.initCash, 0) + ' → ' + U.fmt(total, 0) + ' 元';
    if (nav.length < 2) { U.$('#acNavChart').innerHTML = '<div class="empty-inline">买入并推进时间后显示净值曲线</div>'; return; }
    Chart.autoResize(U.$('#acNavChart'), {
      dates: nav.map(n => n.date), height: 300, yFormat: v => U.fmt(v / 10000, 0) + '万',
      series: [
        { name: '账户总资产（含分红）', values: nav.map(n => n.value), color: '#4a9eff', width: 2 },
        { name: '不计分红', values: navNo.map(n => n.value), color: '#96a5bd', width: 1.4, dash: '5,4' }
      ]
    });
  }

  function renderAcHold() {
    const sim = state.acSim, pm = state.acPriceMap;
    const qids = Object.keys(sim.holdings).filter(q => sim.holdings[q].shares > 0);
    const tbl = U.$('#acHoldTable');
    if (!qids.length) { tbl.innerHTML = '<tbody><tr><td style="text-align:center;color:#657792">当前无持仓</td></tr></tbody>'; return; }
    tbl.innerHTML =
      '<thead><tr><th>标的</th><th>持股</th><th>成本均价(元)</th><th>现价</th><th>市值(元)</th><th>浮动盈亏</th><th>累计分红</th></tr></thead><tbody>' +
      qids.map(q => {
        const h = sim.holdings[q];
        const px = Sim.priceAt(pm, q, sim.cursor);
        const cur = h.market === 'HK' ? ' HKD' : '';
        const mkt = px != null ? h.shares * px * (h.market === 'HK' ? sim.fx : 1) : null;
        const fl = mkt != null ? mkt - h.costCny : null;
        const sel = q === state.acActiveId ? ' class="row-sel"' : '';
        return '<tr data-qid="' + q + '"' + sel + '>' +
          '<td>' + h.name + ' <span class="badge">' + (h.market === 'HK' ? 'HK' : 'A') + '</span></td>' +
          '<td class="mono">' + h.shares + '</td>' +
          '<td class="mono">' + U.fmt(h.costCny / h.shares, 3) + '</td>' +
          '<td class="mono">' + (px != null ? U.fmt(px, 3) + cur : '—') + '</td>' +
          '<td class="mono">' + (mkt != null ? U.fmt(mkt, 0) : '—') + '</td>' +
          '<td class="mono ' + U.cls(fl) + '">' + (fl != null ? U.signed(fl, 0) : '—') + '</td>' +
          '<td class="mono down">' + U.fmt(h.divTotal || 0, 0) + '</td>' +
          '</tr>';
      }).join('') + '</tbody>';
    U.$$('#acHoldTable tbody tr').forEach(tr => tr.addEventListener('click', () => {
      if (!tr.dataset.qid) return;
      state.acActiveId = tr.dataset.qid; acSave();
      renderAcWatch(); renderAcTradeBox(); renderAcHold(); renderAcKline();
    }));
  }

  function renderAcTrades() {
    const rows = state.acSim.trades.slice().reverse();
    U.$('#acTradeTable').innerHTML =
      '<thead><tr><th>日期</th><th>标的</th><th>方向</th><th>成交价</th><th>股数</th><th>金额</th><th>费用</th><th>实现盈亏</th></tr></thead><tbody>' +
      (rows.length ? rows.map(t => {
        const cur = t.cur === 'HKD' ? ' HKD' : ' 元';
        return '<tr>' +
          '<td>' + t.date + '</td>' +
          '<td>' + t.name + '</td>' +
          '<td class="' + (t.side === 'buy' ? 'up' : 'down') + '">' + (t.side === 'buy' ? '买入' : '卖出') + '</td>' +
          '<td class="mono">' + U.fmt(t.price, 3) + cur + '</td>' +
          '<td class="mono">' + t.shares + '</td>' +
          '<td class="mono">' + U.fmt(t.amount, 0) + '</td>' +
          '<td class="mono">' + U.fmt(t.fee, 2) + '</td>' +
          '<td class="mono ' + (t.realized == null ? 'flat' : U.cls(t.realized)) + '">' + (t.realized == null ? '—' : U.signed(t.realized, 0)) + '</td>' +
          '</tr>';
      }).join('') : '<tr><td colspan="8" style="text-align:center;color:#657792">还没有交易</td></tr>') +
      '</tbody>';
  }

  function renderAcDiv() {
    const typeName = { annual: '年报', interim: '中报/季报', special: '特别', bonus: '送转' };
    const rows = state.acSim.ledger.slice().reverse();
    U.$('#acDivTable').innerHTML =
      '<thead><tr><th>除权除息日</th><th>标的</th><th>类型</th><th>每股分红</th><th>送转</th><th>除权前持股</th><th>税前金额</th><th>红利税</th><th>税后入账</th></tr></thead><tbody>' +
      (rows.length ? rows.map(l => {
        const cur = l.cur === 'HKD' ? 'HKD' : '元';
        const per = l.perShare > 0 ? U.fmt(l.perShare, 4) + ' ' + cur : '—';
        const bonus = l.newShares > 0 ? ('+' + l.newShares + ' 股') : (l.bonusPerShare > 0 ? '送转' : '—');
        const taxNote = l.taxRate > 0 ? '（' + U.fmt(l.taxRate * 100, 0) + '%）' : '';
        return '<tr' + (l.unmodeled ? ' class="row-warn"' : '') + '>' +
          '<td>' + l.date + '</td>' +
          '<td>' + l.name + '</td>' +
          '<td>' + (typeName[l.type] || l.type) + (l.unmodeled ? ' ⚠' : '') + '</td>' +
          '<td class="mono">' + per + '</td>' +
          '<td class="mono">' + bonus + '</td>' +
          '<td class="mono">' + l.sharesBefore + '</td>' +
          '<td class="mono">' + (l.grossCny ? U.fmt(l.grossCny, 0) : '—') + '</td>' +
          '<td class="mono">' + (l.tax ? U.fmt(l.tax, 0) + taxNote : '—') + '</td>' +
          '<td class="mono down">' + (l.netCny ? U.fmt(l.netCny, 0) : '—') +
          (l.dripShares ? ' <span class="small-hint">再投' + l.dripShares + '股</span>' : '') + '</td>' +
          '</tr>';
      }).join('') : '<tr><td colspan="9" style="text-align:center;color:#657792">区间内没有分红 / 送股</td></tr>') +
      '</tbody>';
  }

  function renderAcKline() {
    const sim = state.acSim, pm = state.acPriceMap;
    const w = acActive() || state.acWatch[0] || null;
    const el = U.$('#acKlineChart');
    if (!w) { U.$('#acKlineTitle').textContent = '历史K线（不复权）'; el.innerHTML = '<div class="empty-inline">请先添加标的</div>'; return; }
    const rows = (pm[w.quoteId] || []).filter(x => x.date >= sim.startDate && x.date <= sim.cursor);
    const cur = w.market === 'HK' ? ' HKD' : ' CNY';
    U.$('#acKlineTitle').textContent = w.name + ' · 历史K线（不复权） ' + sim.startDate + ' → ' + sim.cursor;
    if (!rows.length) { el.innerHTML = '<div class="empty-inline">暂无K线数据</div>'; return; }
    const markers = [];
    sim.trades.forEach(t => {
      if (t.quoteId === w.quoteId && t.date >= sim.startDate && t.date <= sim.cursor)
        markers.push({ date: t.date, color: t.side === 'buy' ? '#f0b73f' : '#4a9eff' });
    });
    (state.acDivMap[w.quoteId] || []).forEach(e => {
      if (e.exDate >= sim.startDate && e.exDate <= sim.cursor) markers.push({ date: e.exDate, color: '#2fbf71' });
    });
    Chart.autoResize(el, {
      dates: rows.map(x => x.date), height: 300, yFormat: v => U.fmt(v, 2),
      markers,
      series: [{ name: w.name + cur, values: rows.map(x => x.close), color: '#4a9eff', width: 1.8 }]
    });
  }

  /* ---------------- 页面切换 ---------------- */
  function showPage(name) {
    U.$$('.page').forEach(p => p.classList.remove('active'));
    U.$$('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
    const pg = U.$('#page-' + name);
    if (pg) pg.classList.add('active');
    if (name === 'ledger') renderLedger();
    if (name === 'snowball') { renderUniverseList(); if (state.lastBacktest) renderBacktest(state.lastBacktest); }
    if (name === 'timemachine') { renderUniverseList(); if (state.tmRows) { renderTmTable(state.tmRows); renderTmCharts(); } }
    if (name === 'account') { if (state.acSim) acRenderAll(); }
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
    renderUniverseList();

    // 回到那一天
    bindSearch(U.$('#tmSearch'), U.$('#tmSearchResults'), r => {
      addUniverse(r);
      U.$('#tmSearch').value = '';
    });
    U.$('#tmDate').value = U.addDays(U.today(), -365 * 5);
    U.$('#tmDate').max = U.today();
    U.$('#btnTmRun').addEventListener('click', runTimeMachine);
    U.$('#tmWindow').addEventListener('change', () => { if (state.tmRows) runTimeMachine(); });

    // 模拟账户 · 交互交易台
    U.$('#acStartDate').value = U.addDays(U.today(), -365 * 5);
    U.$('#acStartDate').max = U.today();
    U.$('#acTargetDate').max = U.today();
    bindSearch(U.$('#acSearch'), U.$('#acSearchResults'), r => {
      acAddWatch(r);
      U.$('#acSearch').value = '';
    });
    U.$$('#acJumpSeg button').forEach(b => b.addEventListener('click', () => {
      const m = parseInt(b.dataset.m, 10) || 0;
      let to = U.addMonths(state.acSim.cursor, m);
      if (to > U.today()) to = U.today();
      U.$('#acTargetDate').value = to;
    }));
    U.$$('#acSideSeg button').forEach(b => b.addEventListener('click', () => {
      U.$$('#acSideSeg button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      state.acSide = b.dataset.side;
      renderAcTradeBox();
    }));
    U.$('#btnAcTrade').addEventListener('click', acDoTrade);
    U.$('#btnAcAdvance').addEventListener('click', acDoAdvance);
    U.$('#btnAcReset').addEventListener('click', acReset);
    ['#acFx'].forEach(sel => U.$(sel).addEventListener('change', () => {
      state.acSim.fx = U.num(U.$('#acFx').value) || 0.92; acSave(); acRenderAll();
    }));
    U.$('#acTax').addEventListener('change', () => { state.acSim.taxApplies = U.$('#acTax').checked; acSave(); });
    U.$('#acReinvest').addEventListener('change', () => { state.acSim.reinvest = U.$('#acReinvest').checked; acSave(); });
    ['#acStartDate', '#acCash'].forEach(sel => U.$(sel).addEventListener('change', () => {
      U.$('#acSetupStatus').innerHTML = '<span style="color:#ff9f43">⚠ 起始日期 / 初始资金的改动需点「重置账户」后才会生效。</span>';
    }));
    acBoot();

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
