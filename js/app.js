/* ============================================================
 * app.js — 启动
 * ============================================================ */
(function (App) {
  'use strict';
  function boot() {
    // 默认配置
    App.CONFIG = Object.assign({
      reportLagDays: 90,
      rf: 0.02
    }, App.CONFIG || {});

    App.UI.init();

    // 首次访问给个演示标的
    const univ = App.Store.get('universe', null);
    if (!univ) {
      const demo = [
        { quoteId: '1.600519', name: '贵州茅台', market: 'A' },
        { quoteId: '1.601318', name: '中国平安', market: 'A' },
        { quoteId: '1.600036', name: '招商银行', market: 'A' },
        { quoteId: '116.00700', name: '腾讯控股', market: 'HK' }
      ];
      App.Store.set('universe', demo);
      App.state.universe = demo;
    }

    // 若上次看过某只股票则自动恢复
    const last = App.Store.get('lastStock', null);
    if (last && last.quoteId) {
      App.selectStock(last.quoteId, last.name);
    }

    // 记录当前标的
    const origSelect = App.selectStock;
    App.selectStock = function (q, n) { App.Store.set('lastStock', { quoteId: q, name: n }); return origSelect(q, n); };

    window.addEventListener('beforeunload', () => {
      App.Store.set('universe', App.state.universe);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window.App);
