/* ============================================================
 * util.js — 基础工具 / 本地存储 / 限流网关（JSONP + fetch 缓存重试）
 * ============================================================ */
window.App = window.App || {};

(function (App) {
  'use strict';

  /* ---------------- 基础工具 ---------------- */
  const U = {
    $: (sel, root) => (root || document).querySelector(sel),
    $$: (sel, root) => Array.from((root || document).querySelectorAll(sel)),

    el(tag, cls, html) {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (html != null) e.innerHTML = html;
      return e;
    },

    fmt(n, digits) {
      if (n == null || !isFinite(n)) return '—';
      const d = digits == null ? 2 : digits;
      return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: d, maximumFractionDigits: d });
    },
    pct(n, digits) {
      if (n == null || !isFinite(n)) return '—';
      return U.fmt(n, digits == null ? 2 : digits) + '%';
    },
    signed(n, digits) {
      if (n == null || !isFinite(n)) return '—';
      return (n >= 0 ? '+' : '') + U.fmt(n, digits == null ? 2 : digits);
    },
    num(n) { return (n == null || n === '' || !isFinite(n)) ? null : Number(n); },

    cls(n, invert) {
      if (n == null || !isFinite(n) || n === 0) return 'flat';
      const up = invert ? n < 0 : n > 0;
      return up ? 'up' : 'down';
    },

    dateStr(d) {
      const x = d instanceof Date ? d : new Date(d);
      const p = n => String(n).padStart(2, '0');
      return x.getFullYear() + '-' + p(x.getMonth() + 1) + '-' + p(x.getDate());
    },
    today() { return U.dateStr(new Date()); },
    addDays(dateStr, n) {
      const d = new Date(dateStr + 'T00:00:00');
      d.setDate(d.getDate() + n);
      return U.dateStr(d);
    },
    addMonths(dateStr, n) {
      const d = new Date(dateStr + 'T00:00:00');
      d.setMonth(d.getMonth() + n);
      return U.dateStr(d);
    },
    parseDate(s) { return new Date(String(s).slice(0, 10) + 'T00:00:00'); },
    days(a, b) { return Math.round((U.parseDate(b) - U.parseDate(a)) / 86400000); },

    // 在已排序日期数组中，找 <= target 的最后一个索引（二分）
    lowerIndex(dates, target) {
      let lo = 0, hi = dates.length - 1, ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (dates[mid] <= target) { ans = mid; lo = mid + 1; } else hi = mid - 1;
      }
      return ans;
    },

    toast(msg, isErr) {
      const t = U.$('#toast');
      t.textContent = msg;
      t.className = 'toast' + (isErr ? ' err' : '');
      clearTimeout(U._tt);
      U._tt = setTimeout(() => t.classList.add('hidden'), isErr ? 5200 : 2600);
    },

    debounce(fn, ms) {
      let t; return function (...a) { clearTimeout(t); t = setTimeout(() => fn.apply(this, a), ms); };
    },

    // 市场判定：QuoteID 形如 "1.600519" / "0.000858" / "116.00700"
    marketOf(quoteId) {
      const m = String(quoteId).split('.')[0];
      if (m === '116') return 'HK';
      if (m === '1' || m === '0') return 'A';
      return 'A';
    },
    isHK: quoteId => String(quoteId).split('.')[0] === '116',

    // 转为腾讯行情代码：sh600519 / sz000858 / hk00700
    toTencentCode(quoteId) {
      const [m, code] = String(quoteId).split('.');
      if (m === '116') return 'hk' + code;
      if (m === '1') return 'sh' + code;
      return 'sz' + code;
    }
  };
  App.U = U;

  /* ---------------- 本地存储 ---------------- */
  App.Store = {
    get(k, def) {
      try { const v = localStorage.getItem('snowball.' + k); return v ? JSON.parse(v) : def; }
      catch (e) { return def; }
    },
    set(k, v) {
      try { localStorage.setItem('snowball.' + k, JSON.stringify(v)); } catch (e) { }
    }
  };

  /* ---------------- 限流网关 ----------------
   * 所有外网请求都走这里：串行排队 + 间隔 + 内存/本地缓存 + 重试 + 并发上限
   */
  const Net = {
    _memCache: new Map(),
    _queue: [],
    _running: false,
    _gapMs: 220,          // 请求最小间隔，避免触发限流
    _lastAt: 0,

    _cacheKey(url) { return url; },

    _fromCache(url, ttl) {
      const now = Date.now();
      const m = Net._memCache.get(url);
      if (m && now - m.at < ttl) return m.value;
      if (ttl > 5 * 60 * 1000) {
        const l = App.Store.get('cache:' + url, null);
        if (l && l.value && now - l.at < ttl) { Net._memCache.set(url, l); return l.value; }
      }
      return null;
    },
    _toCache(url, value, persist) {
      const rec = { at: Date.now(), value };
      Net._memCache.set(url, rec);
      if (persist) { try { App.Store.set('cache:' + url, rec); } catch (e) { } }
    },

    /**
     * 统一入口。opts: {type:'json'|'jsonp', ttl, persist, retries}
     */
    request(url, opts) {
      opts = Object.assign({ type: /[?&]cb=|callback=/.test(url) ? 'jsonp' : 'json', ttl: 6 * 3600 * 1000, persist: false, retries: 2 }, opts || {});
      const hit = Net._fromCache(url, opts.ttl);
      if (hit != null) return Promise.resolve(hit);

      return new Promise((resolve, reject) => {
        Net._queue.push({ url, opts, resolve, reject, tries: 0 });
        Net._pump();
      });
    },

    _pump() {
      if (Net._running) return;
      if (!Net._queue.length) return;
      const job = Net._queue.shift();
      Net._running = true;
      const gap = Math.max(0, Net._gapMs - (Date.now() - Net._lastAt));
      setTimeout(() => {
        Net._lastAt = Date.now();
        Net._exec(job).then(
          v => { Net._running = false; Net._pump(); job.resolve(v); },
          e => {
            Net._running = false;
            if (job.tries < job.opts.retries) {
              job.tries++;
              setTimeout(() => { Net._queue.unshift(job); Net._pump(); }, 600 * job.tries);
            } else {
              Net._pump();
              job.reject(e);
            }
          }
        );
      }, gap);
    },

    _exec(job) {
      const { url, opts } = job;
      const p = opts.type === 'jsonp' ? Net._jsonp(url) : Net._fetch(url);
      return p.then(data => {
        if (data == null) throw new Error('空响应');
        Net._toCache(url, data, opts.persist);
        return data;
      });
    },

    _fetch(url) {
      return fetch(url, { method: 'GET', mode: 'cors', credentials: 'omit' }).then(r => {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      }).then(t => {
        const s = t.trim();
        if (!s) throw new Error('空响应体');
        if (s[0] === '<') throw new Error('返回了HTML(可能被限流)');
        try { return JSON.parse(s); }
        catch (e) {
          // 兼容 jsonp 包裹
          const m = s.match(/^[^(]*\((.*)\)[;\s]*$/s);
          if (m) return JSON.parse(m[1]);
          throw new Error('JSON解析失败');
        }
      });
    },

    _jsonp(url) {
      return new Promise((resolve, reject) => {
        const cbName = 'emcb_' + Math.random().toString(36).slice(2, 10);
        // 兼容两种回调参数名：东财 suggest 用 cb=，datacenter 用 callback=
        let full;
        if (/[?&]cb=/.test(url)) full = url.replace(/([?&]cb=)[^&]*/, '$1' + cbName);
        else if (/[?&]callback=/.test(url)) full = url.replace(/([?&]callback=)[^&]*/, '$1' + cbName);
        else full = url + (url.includes('?') ? '&' : '?') + 'callback=' + cbName;
        const script = document.createElement('script');
        let done = false;
        const cleanup = () => {
          delete window[cbName];
          if (script.parentNode) script.parentNode.removeChild(script);
        };
        window[cbName] = data => { done = true; cleanup(); resolve(data); };
        script.onerror = () => { if (done) return; cleanup(); reject(new Error('JSONP加载失败')); };
        setTimeout(() => { if (done) return; cleanup(); reject(new Error('JSONP超时')); }, 15000);
        script.src = full;
        document.head.appendChild(script);
      });
    }
  };
  App.Net = Net;

  /* 诊断：并发探测若干 URL */
  App.diagnose = function (tests) {
    return Promise.all(tests.map(t => {
      const started = Date.now();
      return App.Net.request(t.url, { ttl: 0, retries: 0, type: t.type })
        .then(d => ({ name: t.name, ok: true, ms: Date.now() - started, sample: t.pick ? t.pick(d) : '' }))
        .catch(e => ({ name: t.name, ok: false, ms: Date.now() - started, err: e.message }));
    }));
  };

})(window.App);
