(function () {
  'use strict';

  let db = TechStockDB.load();
  const expanded = new Set();

  const $ = selector => document.querySelector(selector);
  const els = {
    search: $('#searchInput'),
    sector: $('#sectorFilter'),
    period: $('#periodFilter'),
    pool: $('#poolFilter'),
    verify: $('#verificationFilter'),
    sort: $('#sortSelect'),
    body: $('#tableBody'),
    result: $('#resultText'),
    empty: $('#emptyState'),
    stats: {
      current: $('#statCurrent'),
      watch: $('#statWatch'),
      sectors: $('#statSectors'),
      period: $('#statPeriod')
    },
    toast: $('#toast'),
    serverHint: $('#serverHint')
  };

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    }[ch]));
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  function pill(label, tone = 'gray') {
    return `<span class="pill pill-${tone}">${esc(label)}</span>`;
  }

  function currentPeriod() {
    return els.period.value || TechStockDB.allPeriods(db)[0] || '';
  }

  function periodLabel(code) {
    const labels = { Q1: '第一季度', H1: '半年度', Q3: '前三季度', A: '年度' };
    const match = String(code || '').match(/^(\d{4})(Q1|H1|Q3|A)$/);
    return match ? `${match[1]}年${labels[match[2]]}` : code;
  }

  function fieldStatusMeta(status) {
    return {
      matched: { label: 'PDF字段一致', tone: 'green' },
      partial: { label: '字段部分一致', tone: 'orange' },
      mismatch: { label: '字段需复核', tone: 'red' },
      unparsed: { label: 'PDF未解析', tone: 'orange' },
      pending: { label: '待字段核验', tone: 'gray' }
    }[status || 'pending'] || { label: '待字段核验', tone: 'gray' };
  }

  function fieldStatusPill(report) {
    const meta = fieldStatusMeta(report?.fieldVerificationStatus);
    return pill(meta.label, meta.tone);
  }

  function refreshFilters() {
    const sectorNow = els.sector.value;
    const periodNow = els.period.value;
    const sectors = [...new Set(db.stocks.map(stock => stock.sector).filter(Boolean))]
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
    els.sector.innerHTML = '<option value="">全部板块</option>'
      + sectors.map(value => `<option>${esc(value)}</option>`).join('');
    if (sectors.includes(sectorNow)) els.sector.value = sectorNow;

    const periods = TechStockDB.allPeriods(db);
    els.period.innerHTML = periods.map((period, index) => (
      `<option value="${esc(period)}" ${!periodNow && index === 0 ? 'selected' : ''}>${esc(periodLabel(period))}</option>`
    )).join('');
    if (periods.includes(periodNow)) els.period.value = periodNow;
  }

  function filtered() {
    const key = els.search.value.trim().toLowerCase();
    const sector = els.sector.value;
    const period = currentPeriod();
    const pool = els.pool.value;
    const verify = els.verify.value;
    const rows = db.stocks.map(stock => {
      const report = TechStockDB.getReport(stock, period);
      const status = TechStockDB.stockStatus(stock, period, db.settings);
      return { stock, report, status };
    }).filter(item => {
      const haystack = [item.stock.name, item.stock.code, item.stock.sector, ...item.stock.tags].join(' ').toLowerCase();
      if (key && !haystack.includes(key)) return false;
      if (sector && item.stock.sector !== sector) return false;
      if (pool === 'current' && !['current', 'continuous'].includes(item.status.key)) return false;
      if (pool === 'watch' && !['dropped', 'revenue_only', 'profit_only', 'loss', 'not_qualified'].includes(item.status.key)) return false;
      if (pool === 'pending' && item.status.key !== 'pending') return false;
      const verification = item.report?.verificationStatus || 'missing';
      return !verify || verification === verify;
    });

    const [sortKey, direction] = els.sort.value.split('|');
    const multiplier = direction === 'asc' ? 1 : -1;
    rows.sort((a, b) => {
      let av;
      let bv;
      if (sortKey === 'name') {
        av = a.stock.name;
        bv = b.stock.name;
      } else if (sortKey === 'sector') {
        av = a.stock.sector;
        bv = b.stock.sector;
      } else if (sortKey === 'revenue') {
        av = a.report?.revenueGrowth ?? -Infinity;
        bv = b.report?.revenueGrowth ?? -Infinity;
      } else if (sortKey === 'profit') {
        av = a.report?.netProfitGrowth ?? (/扭亏/.test(a.report?.netProfitGrowthText || '') ? 999999 : -Infinity);
        bv = b.report?.netProfitGrowth ?? (/扭亏/.test(b.report?.netProfitGrowthText || '') ? 999999 : -Infinity);
      } else {
        av = a.status.streak;
        bv = b.status.streak;
      }
      return typeof av === 'string' ? av.localeCompare(bv, 'zh-CN') * multiplier : (av - bv) * multiplier;
    });
    return rows;
  }

  function metricClass(value) {
    return value === null || value === undefined ? 'neutral' : value >= 0 ? 'positive' : 'negative';
  }

  function growthHtml(report, key, textKey) {
    if (!report) return '<span class="muted">待更新</span>';
    const value = report[key];
    const text = report[textKey] || '';
    return `<span class="metric ${metricClass(value)}">${esc(TechStockDB.formatPercent(value, text))}</span>`;
  }

  function rowHtml({ stock, report, status }, period) {
    const open = expanded.has(stock.code);
    return `<tr class="stock-row" data-code="${esc(stock.code)}">
<td class="col-name" data-label="股票"><div class="company-name">${esc(stock.name)}</div><div class="company-code mono">${esc(stock.code)}</div></td>
<td class="col-sector" data-label="所属板块">${pill(stock.sector, 'blue')}</td>
<td class="col-period" data-label="报告期">${report ? esc(report.periodCode) : '<span class="muted">待更新</span>'}</td>
<td class="col-metric" data-label="营收同比">${growthHtml(report, 'revenueGrowth', '')}</td>
<td class="col-metric" data-label="净利润同比">${growthHtml(report, 'netProfitGrowth', 'netProfitGrowthText')}</td>
<td class="col-profit" data-label="归母净利润"><span class="metric neutral">${report?.netProfit !== null && report?.netProfit !== undefined ? TechStockDB.formatNumber(report.netProfit, 4) + ' 亿' : (report?.netProfitPositive === true ? '盈利（待补金额）' : '—')}</span></td>
<td class="col-streak" data-label="连续双增">${status.streak ? pill(String(status.streak) + '期', 'green') : pill('0期', 'gray')}</td>
<td class="col-status" data-label="状态">${pill(status.label, status.tone)}</td>
<td class="col-action" data-label="操作"><button class="btn detail-btn" data-code="${esc(stock.code)}">${open ? '收起' : '详情'}</button></td></tr>${open ? detailHtml(stock, period) : ''}`;
  }

  function detailHtml(stock, period) {
    const selected = TechStockDB.getReport(stock, period);
    const history = [...stock.reports].sort((a, b) => TechStockDB.periodRank(b.periodCode) - TechStockDB.periodRank(a.periodCode));
    return `<tr class="detail-row"><td colspan="9"><div class="detail-box"><section class="detail-section"><h3>报告期历史</h3><div class="report-history">${history.map(report => {
      const status = TechStockDB.stockStatus(stock, report.periodCode, db.settings);
      return `<div class="history-item"><strong>${esc(report.periodCode)}</strong><span>营收 ${esc(TechStockDB.formatPercent(report.revenueGrowth))}</span><span>利润 ${esc(TechStockDB.formatPercent(report.netProfitGrowth, report.netProfitGrowthText))}</span><span>${report.netProfit !== null ? TechStockDB.formatNumber(report.netProfit, 4) + ' 亿' : '利润金额待补'}</span>${fieldStatusPill(report)}${pill(status.label, status.tone)}</div>`;
    }).join('')}</div></section><section class="detail-section"><h3>公司与数据状态</h3><div class="detail-meta"><div class="meta-card"><div class="meta-label">概念标签</div><div class="meta-value">${stock.tags.map(tag => `<span class="tag">${esc(tag)}</span>`).join('') || '—'}</div></div><div class="meta-card"><div class="meta-label">当前来源核验</div><div class="meta-value">${selected?.verificationStatus === 'verified' ? pill('已核验', 'green') : selected?.verificationStatus === 'conflict' ? pill('数据冲突', 'red') : pill('待补来源', 'orange')}</div></div><div class="meta-card"><div class="meta-label">PDF字段核验</div><div class="meta-value">${fieldStatusPill(selected)}<div class="meta-hint">${esc(selected?.fieldVerificationNote || '尚未执行字段级核验')}</div></div></div><div class="meta-card"><div class="meta-label">数据来源</div><div class="meta-value">${selected?.sourceUrl ? `<a href="${esc(selected.sourceUrl)}" target="_blank" rel="noopener">${esc(selected.sourceName || '打开公告')}</a>` : esc(selected?.sourceName || '尚未填写')}</div></div><div class="meta-card"><div class="meta-label">最后更新</div><div class="meta-value">${esc((selected?.fieldVerifiedAt || selected?.updatedAt || stock.updatedAt || '').slice(0, 10) || '—')}</div></div></div></section></div></td></tr>`;
  }

  function updateStats(period) {
    const items = db.stocks.map(stock => TechStockDB.stockStatus(stock, period, db.settings));
    els.stats.current.textContent = items.filter(item => ['current', 'continuous'].includes(item.key)).length;
    els.stats.watch.textContent = items.filter(item => ['dropped', 'revenue_only', 'profit_only', 'loss', 'not_qualified'].includes(item.key)).length;
    els.stats.sectors.textContent = new Set(db.stocks.map(stock => stock.sector)).size;
    els.stats.period.textContent = periodLabel(period);
  }

  function render() {
    refreshFilters();
    const rows = filtered();
    const period = currentPeriod();
    els.body.innerHTML = rows.map(item => rowHtml(item, period)).join('');
    els.empty.classList.toggle('hidden', rows.length > 0);
    els.result.textContent = `显示 ${rows.length} 家 / 数据库共 ${db.stocks.length} 家；当前报告期：${periodLabel(period)}`;
    updateStats(period);
    bindRowEvents();
  }

  function bindRowEvents() {
    document.querySelectorAll('.detail-btn').forEach(button => button.addEventListener('click', () => {
      if (expanded.has(button.dataset.code)) expanded.delete(button.dataset.code);
      else expanded.add(button.dataset.code);
      render();
    }));
  }


  ['input', 'change'].forEach(event => els.search.addEventListener(event, render));
  [els.sector, els.period, els.pool, els.verify, els.sort].forEach(element => element.addEventListener('change', render));
  $('#printBtn').addEventListener('click', () => window.print());

  window.addEventListener('techstock:external-update', () => {
    db = TechStockDB.load();
    render();
    showToast('已同步AI筛选中心的数据更新');
  });
  window.addEventListener('storage', event => {
    if (event.key === TechStockDB.STORAGE_KEY) {
      db = TechStockDB.load();
      render();
    }
  });

  if (TechStockDB.isLocalFile()) {
    els.serverHint.innerHTML = '当前为直接打开模式。为确保核心看板与 AI 筛选中心稳定共享数据，请运行 <strong>start-server.bat</strong>；数据库导入、导出和恢复统一在“AI财报筛选中心 → 候选池与数据管理”中操作。';
  } else {
    els.serverHint.innerHTML = '当前为本地服务模式：AI筛选中心与核心看板会自动共享数据；数据库导入、导出和恢复统一在“AI财报筛选中心 → 候选池与数据管理”中操作。';
  }

  render();
  const loadInfo = TechStockDB.getLastLoadInfo?.();
  if (loadInfo?.builtInSync?.changed) {
    const info = loadInfo.builtInSync;
    showToast(`已自动同步最新版本数据：更新 ${info.reportsUpdated} 条报告，保留 ${info.extraStocksPreserved} 家扩展公司`);
  }
})();
