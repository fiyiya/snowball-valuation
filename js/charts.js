/* ============================================================
 * charts.js — 轻量 SVG 图表（折线/面积/区间带/多序列 + 悬浮提示）
 * ============================================================ */
(function (App) {
  'use strict';
  const U = App.U;
  const NS = 'http://www.w3.org/2000/svg';

  function el(name, attrs) {
    const e = document.createElementNS(NS, name);
    if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function niceTicks(min, max, count) {
    if (min === max) { min -= 1; max += 1; }
    const span = max - min;
    const step0 = span / count;
    const mag = Math.pow(10, Math.floor(Math.log10(step0)));
    const norm = step0 / mag;
    let step = mag * (norm >= 5 ? 10 : norm >= 2 ? 5 : norm >= 1 ? 2 : 1);
    const start = Math.ceil(min / step) * step;
    const ticks = [];
    for (let v = start; v <= max + 1e-9; v += step) ticks.push(+v.toFixed(10));
    return ticks;
  }

  const Chart = {};

  /**
   * 通用折线图
   * opts: { dates:[], series:[{name,values,color,fill,dash,width,axis:'left'|'right'}],
   *         band:{upper:[],lower:[],color}, yFormat, y2Format, height, zeroLine, markers }
   */
  Chart.render = function (container, opts) {
    const dates = opts.dates || [];
    const series = (opts.series || []).filter(s => s.values && s.values.some(v => v != null && isFinite(v)));
    container.innerHTML = '';
    container.style.position = 'relative';
    if (!dates.length || !series.length) {
      container.innerHTML = '<div class="empty-inline">暂无数据</div>';
      return;
    }

    const W = container.clientWidth || 600;
    const H = opts.height || container.clientHeight || 280;
    const pad = { l: 58, r: (opts.y2Format || series.some(s => s.axis === 'right')) ? 58 : 16, t: 14, b: 26 };
    const pw = Math.max(10, W - pad.l - pad.r);
    const ph = Math.max(10, H - pad.t - pad.b);
    const n = dates.length;

    const leftVals = [], rightVals = [];
    series.forEach(s => (s.axis === 'right' ? rightVals : leftVals).push(...s.values.filter(v => v != null && isFinite(v))));
    if (opts.band) { leftVals.push(...opts.band.upper.filter(v => v != null && isFinite(v)), ...opts.band.lower.filter(v => v != null && isFinite(v))); }

    const scale = (vals) => {
      let mn = Math.min(...vals), mx = Math.max(...vals);
      if (!isFinite(mn) || !isFinite(mx)) { mn = 0; mx = 1; }
      if (opts.zeroLine) { mn = Math.min(mn, 0); mx = Math.max(mx, 0); }
      const p = (mx - mn) * 0.06 || 0.5;
      return { mn: mn - (opts.zeroLine ? 0 : p), mx: mx + p };
    };
    const L = scale(leftVals.length ? leftVals : [0, 1]);
    const R = rightVals.length ? scale(rightVals) : null;

    const X = i => pad.l + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
    const YL = v => pad.t + ph - ((v - L.mn) / (L.mx - L.mn)) * ph;
    const YR = v => R ? (pad.t + ph - ((v - R.mn) / (R.mx - R.mn)) * ph) : 0;

    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });

    // 网格 + 左侧 y 轴
    const ticks = niceTicks(L.mn, L.mx, 5);
    const fmt = opts.yFormat || (v => U.fmt(v, v >= 1000 ? 0 : 2));
    ticks.forEach(t => {
      const y = YL(t);
      if (y < pad.t - 1 || y > pad.t + ph + 1) return;
      svg.appendChild(el('line', { x1: pad.l, x2: pad.l + pw, y1: y, y2: y, stroke: '#243044', 'stroke-width': 1 }));
      const tx = el('text', { x: pad.l - 8, y: y + 4, fill: '#657792', 'font-size': 10.5, 'text-anchor': 'end' });
      tx.textContent = fmt(t); svg.appendChild(tx);
    });
    if (R) {
      niceTicks(R.mn, R.mx, 4).forEach(t => {
        const y = YR(t);
        if (y < pad.t - 1 || y > pad.t + ph + 1) return;
        const tx = el('text', { x: pad.l + pw + 8, y: y + 4, fill: '#657792', 'font-size': 10.5, 'text-anchor': 'start' });
        tx.textContent = (opts.y2Format || fmt)(t); svg.appendChild(tx);
      });
    }

    // x 轴标签
    const xticks = Math.min(6, n);
    for (let k = 0; k < xticks; k++) {
      const i = Math.round(k * (n - 1) / Math.max(1, xticks - 1));
      const tx = el('text', { x: X(i), y: H - 8, fill: '#657792', 'font-size': 10.5, 'text-anchor': 'middle' });
      tx.textContent = String(dates[i]).slice(0, 7); svg.appendChild(tx);
    }

    // 区间带
    if (opts.band) {
      let d = '';
      for (let i = 0; i < n; i++) if (opts.band.upper[i] != null) d += (d ? 'L' : 'M') + X(i) + ' ' + YL(opts.band.upper[i]);
      for (let i = n - 1; i >= 0; i--) if (opts.band.lower[i] != null) d += 'L' + X(i) + ' ' + YL(opts.band.lower[i]);
      if (d) svg.appendChild(el('path', { d: d + 'Z', fill: opts.band.color || 'rgba(74,158,255,.12)', stroke: 'none' }));
    }

    // 折线
    series.forEach(s => {
      const Y = s.axis === 'right' ? YR : YL;
      let d = '', started = false;
      for (let i = 0; i < n; i++) {
        const v = s.values[i];
        if (v == null || !isFinite(v)) { started = false; continue; }
        d += (started ? 'L' : 'M') + X(i) + ' ' + Y(v);
        started = true;
      }
      if (s.fill && d) {
        let dd = d;
        const lastV = [...s.values].reverse().find(v => v != null && isFinite(v));
        const baseY = opts.fillBase != null ? YL(opts.fillBase) : pad.t + ph;
        dd += 'L' + X(n - 1) + ' ' + baseY + 'L' + X(0) + ' ' + baseY + 'Z';
        svg.appendChild(el('path', { d: dd, fill: s.fill, stroke: 'none', opacity: .9 }));
      }
      svg.appendChild(el('path', {
        d, fill: 'none', stroke: s.color || '#4a9eff',
        'stroke-width': s.width || 1.6, 'stroke-dasharray': s.dash || 'none',
        'stroke-linejoin': 'round', 'stroke-linecap': 'round'
      }));
    });

    // 标记点
    (opts.markers || []).forEach(m => {
      const i = U.lowerIndex(dates, m.date);
      if (i < 0) return;
      const v = series[0].values[i];
      if (v == null) return;
      svg.appendChild(el('circle', { cx: X(i), cy: YL(v), r: 3.2, fill: m.color || '#f0b73f', stroke: '#0d1117', 'stroke-width': 1.2 }));
    });

    // 悬浮层
    const hoverX = el('line', { x1: 0, x2: 0, y1: pad.t, y2: pad.t + ph, stroke: '#4a9eff', 'stroke-width': 1, 'stroke-dasharray': '3,3', opacity: 0 });
    svg.appendChild(hoverX);
    const dots = series.map(() => { const c = el('circle', { r: 3.5, fill: '#fff', stroke: '#4a9eff', 'stroke-width': 1.5, opacity: 0 }); svg.appendChild(c); return c; });

    container.appendChild(svg);
    const tip = U.el('div', 'chart-tip hidden');
    container.appendChild(tip);

    const overlay = el('rect', { x: pad.l, y: pad.t, width: pw, height: ph, fill: 'transparent' });
    svg.appendChild(overlay);
    overlay.addEventListener('mousemove', ev => {
      const rect = svg.getBoundingClientRect();
      const mx = ev.clientX - rect.left;
      let i = Math.round((mx - pad.l) / pw * (n - 1));
      i = Math.max(0, Math.min(n - 1, i));
      hoverX.setAttribute('x1', X(i)); hoverX.setAttribute('x2', X(i)); hoverX.setAttribute('opacity', 1);
      let html = '<b>' + dates[i] + '</b>';
      series.forEach((s, k) => {
        const v = s.values[i];
        const Y = s.axis === 'right' ? YR : YL;
        if (v == null || !isFinite(v)) { dots[k].setAttribute('opacity', 0); return; }
        dots[k].setAttribute('cx', X(i)); dots[k].setAttribute('cy', Y(v)); dots[k].setAttribute('opacity', 1);
        dots[k].setAttribute('stroke', s.color || '#4a9eff');
        html += '<br><span style="color:' + (s.color || '#4a9eff') + '">●</span> ' + s.name + ': ' +
          ((s.axis === 'right' ? opts.y2Format : opts.yFormat) || (v => U.fmt(v, 2)))(v) + (s.suffix || '');
      });
      tip.innerHTML = html;
      tip.classList.remove('hidden');
      const tw = tip.offsetWidth;
      let left = X(i) + 14; if (left + tw > W) left = X(i) - tw - 14;
      tip.style.left = left + 'px';
      tip.style.top = (pad.t + 6) + 'px';
    });
    overlay.addEventListener('mouseleave', () => {
      hoverX.setAttribute('opacity', 0); tip.classList.add('hidden');
      dots.forEach(d => d.setAttribute('opacity', 0));
    });
  };

  /** 柱状图（用于收益分布） */
  Chart.bars = function (container, opts) {
    container.innerHTML = '';
    const labels = opts.labels || [], values = opts.values || [];
    const W = container.clientWidth || 600, H = opts.height || 200;
    const pad = { l: 50, r: 12, t: 12, b: 34 };
    const pw = Math.max(10, W - pad.l - pad.r), ph = Math.max(10, H - pad.t - pad.b);
    const svg = el('svg', { width: W, height: H, viewBox: `0 0 ${W} ${H}` });
    const mn = Math.min(0, ...values), mx = Math.max(0, ...values);
    const Y = v => pad.t + ph - ((v - mn) / (mx - mn || 1)) * ph;
    niceTicks(mn, mx, 4).forEach(t => {
      const y = Y(t);
      svg.appendChild(el('line', { x1: pad.l, x2: pad.l + pw, y1: y, y2: y, stroke: '#243044' }));
      const tx = el('text', { x: pad.l - 6, y: y + 4, fill: '#657792', 'font-size': 10.5, 'text-anchor': 'end' });
      tx.textContent = U.fmt(t, 0) + '%'; svg.appendChild(tx);
    });
    const bw = pw / Math.max(1, values.length) * 0.62;
    const step = pw / Math.max(1, values.length);
    values.forEach((v, i) => {
      const x = pad.l + i * step + (step - bw) / 2;
      const y0 = Y(0), y1 = Y(v);
      svg.appendChild(el('rect', {
        x, y: Math.min(y0, y1), width: bw, height: Math.abs(y1 - y0),
        fill: (opts.colors && opts.colors[i]) || (v >= 0 ? 'rgba(255,92,92,.75)' : 'rgba(47,191,113,.75)'), rx: 3
      }));
      const tx = el('text', { x: x + bw / 2, y: H - 10, fill: '#657792', 'font-size': 10, 'text-anchor': 'middle' });
      tx.textContent = labels[i]; svg.appendChild(tx);
    });
    container.appendChild(svg);
  };

  Chart.autoResize = function (container, opts) {
    Chart.render(container, opts);
    if (!container._ro) {
      container._ro = true;
      let t;
      window.addEventListener('resize', () => {
        clearTimeout(t);
        t = setTimeout(() => { if (container._lastOpts) Chart.render(container, container._lastOpts); }, 200);
      });
    }
    container._lastOpts = opts;
  };

  App.Chart = Chart;
})(window.App);
