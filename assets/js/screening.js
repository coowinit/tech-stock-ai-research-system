(function () {
  'use strict';

  let db = TechStockDB.load();
  let workflow = TechStockWorkflow.load();
  let discoveryPreview = null;
  let verificationPreview = null;
  let currentBatch = [];
  const maintenanceStats = {
    deletedStocks: 0,
    deletedReports: 0,
    lastBackupId: ''
  };

  const BACKUP_KEY = 'tech-stock-research-last-backup-at';
  const $ = selector => document.querySelector(selector);
  const $$ = selector => Array.from(document.querySelectorAll(selector));

  const els = {
    tabs: $$('.tab-control'),
    panels: $$('.tab-panel'),
    summary: $('#workflowSummary'),
    period: $('#periodSelect'),
    periodHint: $('#periodHint'),
    customWrap: $('#customPeriodWrap'),
    customCode: $('#customPeriodCode'),
    customLabel: $('#customPeriodLabel'),
    customRange: $('#customPeriodRange'),
    rev: $('#revenueThreshold'),
    exclude688: $('#exclude688'),
    excludeST: $('#excludeST'),
    excludeBSE: $('#excludeBSE'),
    scope: $('#sectorScope'),
    discoveryPrompt: $('#discoveryPrompt'),
    discoveryJson: $('#discoveryJsonInput'),
    discoverySummary: $('#discoverySummary'),
    discoveryPreview: $('#discoveryPreview'),
    discoveryValidation: $('#discoveryValidation'),
    saveCandidates: $('#saveCandidatesBtn'),
    verificationPeriod: $('#verificationPeriod'),
    batchSize: $('#verificationBatchSize'),
    batchList: $('#verificationBatchList'),
    verificationPrompt: $('#verificationPrompt'),
    verificationJson: $('#verificationJsonInput'),
    verificationSummary: $('#verificationSummary'),
    verificationPreview: $('#verificationPreview'),
    verificationValidation: $('#verificationValidation'),
    mergeVerification: $('#mergeVerificationBtn'),
    candidateStatus: $('#candidateStatusFilter'),
    candidatePeriod: $('#candidatePeriodFilter'),
    candidateList: $('#candidateList'),
    sourcePeriod: $('#sourcePeriodFilter'),
    sourceDebtList: $('#sourceDebtList'),
    dbStatus: $('#dbStatus'),
    sourceHealth: $('#sourceHealth'),
    workflowStatus: $('#workflowStatus'),
    backupStatus: $('#backupStatus'),
    backupList: $('#backupList'),
    maintenanceSearch: $('#maintenanceSearchInput'),
    maintenancePeriod: $('#maintenancePeriodSelect'),
    maintenanceIssueOnly: $('#maintenanceIssueOnly'),
    maintenanceSummary: $('#maintenanceSummary'),
    maintenanceReset: $('#maintenanceResetBtn'),
    maintenanceList: $('#maintenanceList'),
    importFile: $('#importFile'),
    workflowImportFile: $('#workflowImportFile'),
    toast: $('#toast')
  };

  const PERIODS = {
    '2025A': { label: '2025年年度报告', range: '2025年1—12月' },
    '2026Q1': { label: '2026年第一季度报告', range: '2026年1—3月' },
    '2026H1': { label: '2026年半年度报告', range: '2026年1—6月' },
    '2026Q3': { label: '2026年前三季度报告', range: '2026年1—9月' },
    '2026A': { label: '2026年年度报告', range: '2026年1—12月' }
  };

  const STATUS_LABELS = {
    pending: ['待核验', 'orange'],
    verifying: ['核验中', 'blue'],
    verified: ['已入库', 'green'],
    rejected: ['已淘汰', 'red'],
    unverified: ['无法核验', 'gray']
  };

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;'
    })[char]);
  }

  function showToast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(showToast.timer);
    showToast.timer = setTimeout(() => els.toast.classList.remove('show'), 2200);
  }

  function pill(label, tone = 'gray') {
    return `<span class="pill pill-${tone}">${escapeHtml(label)}</span>`;
  }

  function isChecked(element, fallback = true) {
    return element ? element.checked : fallback;
  }

  function selectedPeriod() {
    if (els.period.value !== 'custom') return { code: els.period.value, ...PERIODS[els.period.value] };
    return {
      code: els.customCode.value.trim().toUpperCase(),
      label: els.customLabel.value.trim(),
      range: els.customRange.value.trim()
    };
  }

  function periodLabel(code) {
    return PERIODS[code]?.label || code || '—';
  }

  function periodRange(code) {
    return PERIODS[code]?.range || selectedPeriod().range || '';
  }

  function periodEndDate(code) {
    const match = String(code || '').match(/^(\d{4})(Q1|H1|Q3|A)$/);
    if (!match) return null;
    const year = Number(match[1]);
    const ends = { Q1: [2, 31], H1: [5, 30], Q3: [8, 30], A: [11, 31] };
    const end = ends[match[2]];
    return new Date(year, end[0], end[1], 23, 59, 59);
  }

  function allKnownPeriods() {
    return [...new Set([
      ...TechStockDB.allPeriods(db),
      ...workflow.candidates.map(item => item.periodCode).filter(Boolean),
      ...Object.keys(PERIODS)
    ])].sort((a, b) => TechStockDB.periodRank(b) - TechStockDB.periodRank(a));
  }

  function chooseLatestAvailablePeriod() {
    const latest = TechStockDB.allPeriods(db)[0];
    if (latest && els.period.querySelector(`option[value="${latest}"]`)) els.period.value = latest;
  }

  function updatePeriodHint() {
    const period = selectedPeriod();
    const endDate = periodEndDate(period.code);
    const latest = TechStockDB.allPeriods(db)[0] || '';
    const notes = [];
    if (endDate && endDate > new Date()) {
      notes.push(`${period.label} 的累计区间尚未结束，当前更适合用于预设下一批查询，不建议直接入库。`);
    }
    if (latest && period.code !== latest) {
      notes.push(`正式数据库最新报告期为 ${latest}，请确认本次任务确实需要切换口径。`);
    }
    els.periodHint.textContent = notes.join(' ');
    els.periodHint.classList.toggle('hidden', notes.length === 0);
  }

  function updateVisibility() {
    els.customWrap.classList.toggle('hidden', els.period.value !== 'custom');
    updatePeriodHint();
    const code = selectedPeriod().code || '2026Q1';
    els.discoveryJson.placeholder = `请粘贴候选发现JSON，例如：{"periodCode":"${code}","candidates":[...]}`;
    els.verificationJson.placeholder = `请粘贴正式核验JSON，例如：{"periodCode":"${code}","verifiedStocks":[],"rejectedStocks":[],"unverifiedStocks":[]}`;
  }

  function selectedOptions() {
    return {
      periodCode: selectedPeriod().code,
      periodLabel: selectedPeriod().label,
      periodRange: selectedPeriod().range,
      revenueGrowthThreshold: Number(els.rev.value) || 8,
      exclude688: isChecked(els.exclude688),
      excludeST: isChecked(els.excludeST),
      excludeBSE: isChecked(els.excludeBSE),
      requireProfitGrowthFact: true
    };
  }

  function candidateSchema(period) {
    return JSON.stringify({
      periodCode: period.code,
      periodLabel: period.label,
      batchCandidates: 1,
      scanComplete: false,
      hasMore: true,
      searchedSectors: ['CPO/高速光模块'],
      remainingSectors: ['PCB/覆铜板'],
      candidates: [{
        name: '示例公司',
        code: '000001.SZ',
        sector: 'AI服务器',
        tags: ['AI服务器', '算力基础设施'],
        candidateReason: '业绩快报或公开线索显示营收和归母净利润双增长',
        reportedRevenueGrowth: 18.6,
        reportedNetProfit: 5.67,
        reportedNetProfitPositive: true,
        reportedNetProfitGrowth: 22.3,
        reportedNetProfitGrowthText: '',
        dataBasis: 'performance_flash',
        sourceType: 'financial_media',
        discoverySourceName: '候选线索来源',
        discoverySourceUrl: 'https://finance.eastmoney.com/a/example.html',
        needsOfficialVerification: true
      }]
    }, null, 2);
  }

  function formalSchema(period, batch = currentBatch) {
    return JSON.stringify({
      periodCode: period.code,
      periodLabel: period.label,
      periodRange: period.range,
      submittedCount: batch.length || 1,
      verifiedCount: 1,
      rejectedCount: 0,
      unverifiedCount: 0,
      submittedCodes: batch.length ? batch.map(item => item.code) : ['000001.SZ'],
      verifiedStocks: [{
        name: batch[0]?.name || '示例公司',
        code: batch[0]?.code || '000001.SZ',
        sector: batch[0]?.sector || 'AI服务器',
        tags: batch[0]?.tags || ['AI服务器'],
        report: {
          periodCode: period.code,
          periodLabel: period.label,
          periodRange: period.range,
          revenue: 123.45,
          revenueGrowth: 18.6,
          netProfit: 5.67,
          netProfitPositive: true,
          netProfitGrowth: 22.3,
          netProfitGrowthText: '',
          deductNetProfit: null,
          operatingCashFlow: null,
          sourceName: `${period.label}正式公告`,
          sourceUrl: 'https://static.cninfo.com.cn/finalpage/2026-04-30/example.PDF',
          sourceType: 'cninfo',
          announcementDate: '2026-04-30',
          verificationStatus: 'verified'
        }
      }],
      rejectedStocks: [],
      unverifiedStocks: []
    }, null, 2);
  }

  function generateDiscoveryPrompt() {
    const period = selectedPeriod();
    if (!period.code || !period.label || !period.range) {
      els.discoveryPrompt.value = '请先完整填写自定义报告期代码、名称和累计区间。';
      return;
    }
    const threshold = Number(els.rev.value) || 8;
    const exclusions = [
      isChecked(els.exclude688) ? '排除688科创板' : '不排除科创板',
      isChecked(els.excludeST) ? '排除ST和*ST' : '不排除ST',
      isChecked(els.excludeBSE) ? '排除北交所' : '可以包含北交所'
    ].join('；');
    els.discoveryPrompt.value = `请联网扫描中国A股科技制造相关上市公司，寻找${period.label}可能满足高增长条件的候选公司，数据口径统一采用${period.range}累计数据。
研究范围：${els.scope.value.trim() || '科技制造相关板块'}。

候选条件：
1. 营业收入同比增长线索严格大于${threshold}%
2. 归母净利润金额线索大于0
3. 归母净利润同比增长线索大于0，或明确为“扭亏为盈”

排除规则：${exclusions}。

返回要求：
1. 这是候选发现，不要声称已经完成正式核验；
2. 所有候选必须填写 needsOfficialVerification=true；
3. sourceType 可以是 financial_media、exchange、cninfo、company_website、other；
4. discoverySourceUrl 必须是真实可打开的线索链接；
5. 无法核实的数值填 null，不要估算；
6. 只返回严格 JSON，不要添加解释。

严格按以下结构返回：
${candidateSchema(period)}`;
  }

  function verificationPeriod() {
    const code = els.verificationPeriod.value || selectedPeriod().code;
    return { code, label: periodLabel(code), range: periodRange(code) };
  }

  function generateVerificationPrompt() {
    const period = verificationPeriod();
    const codes = currentBatch.map(item => item.code).join('、') || '（请先刷新批次）';
    const names = currentBatch.map(item => `${item.name}（${item.code}）`).join('、') || '（暂无待核验候选）';
    els.verificationPrompt.value = `请联网核验以下候选公司是否在${period.label}正式公告中满足高增长条件，数据口径统一采用${period.range}累计数据。

本次提交公司：${names}
本次提交代码：${codes}

核验要求：
1. 只使用巨潮资讯、上交所、深交所、北交所正式公告页面或正式报告 PDF；
2. 财经媒体、搜索结果页、公司官网不能自动作为 verified 依据；
3. 每家公司必须且只能进入 verifiedStocks、rejectedStocks、unverifiedStocks 三组之一；
4. verifiedStocks 中必须填写 sourceUrl、sourceName、announcementDate、verificationStatus="verified"；
5. rejectedStocks 需要给出正式公告来源和淘汰原因；
6. unverifiedStocks 用于公告无法找到或字段无法确认的公司，并说明原因；
7. 只返回严格 JSON，不要添加解释。

严格按以下结构返回：
${formalSchema(period, currentBatch)}`;
  }

  function candidateStatus(candidate) {
    return STATUS_LABELS[candidate.status] || ['未知', 'gray'];
  }

  function candidateItemHtml(candidate) {
    const [label, tone] = candidateStatus(candidate);
    const reason = candidate.rejectionReason || candidate.unverifiedReason || candidate.candidateReason || '—';
    return `<div class="candidate-item">
      <div class="candidate-main"><strong>${escapeHtml(candidate.name)}</strong><div class="candidate-meta mono">${escapeHtml(candidate.code)}</div></div>
      <div>${pill(candidate.periodCode, 'blue')}</div>
      <div>${pill(label, tone)}</div>
      <div class="candidate-meta">${escapeHtml(candidate.sector || '未填板块')}<div>${escapeHtml((candidate.tags || []).slice(0, 3).join(' / '))}</div></div>
      <div class="candidate-reason">${escapeHtml(reason)}</div>
    </div>`;
  }

  function renderSummary() {
    const counts = workflow.candidates.reduce((map, item) => {
      map[item.status] = (map[item.status] || 0) + 1;
      return map;
    }, {});
    const sourceDebt = sourceDebtItems().length;
    els.summary.innerHTML = [
      ['候选总数', workflow.candidates.length],
      ['待核验', counts.pending || 0],
      ['核验中', counts.verifying || 0],
      ['已入库', counts.verified || 0],
      ['待补来源', sourceDebt]
    ].map(([label, value]) => `<div class="summary-card"><span>${label}</span><strong>${value}</strong></div>`).join('');
  }

  function renderPeriodSelects() {
    const periods = allKnownPeriods();
    const options = periods.map(code => `<option value="${escapeHtml(code)}">${escapeHtml(periodLabel(code))}</option>`).join('');
    const withAll = '<option value="">全部报告期</option>' + options;
    const keepVerification = els.verificationPeriod.value || selectedPeriod().code;
    const keepCandidate = els.candidatePeriod.value;
    const keepSource = els.sourcePeriod.value;
    const keepMaintenance = els.maintenancePeriod.value;
    els.verificationPeriod.innerHTML = options;
    els.candidatePeriod.innerHTML = withAll;
    els.sourcePeriod.innerHTML = withAll;
    els.maintenancePeriod.innerHTML = withAll;
    if (periods.includes(keepVerification)) els.verificationPeriod.value = keepVerification;
    if (periods.includes(keepCandidate)) els.candidatePeriod.value = keepCandidate;
    if (periods.includes(keepSource)) els.sourcePeriod.value = keepSource;
    if (keepMaintenance === '' || periods.includes(keepMaintenance)) els.maintenancePeriod.value = keepMaintenance;
  }

  function renderBatch() {
    const periodCode = els.verificationPeriod.value || selectedPeriod().code;
    currentBatch = TechStockWorkflow.nextVerificationBatch(workflow, {
      periodCode,
      batchSize: Number(els.batchSize.value) || 6
    });
    els.batchList.innerHTML = currentBatch.length
      ? currentBatch.map(candidateItemHtml).join('')
      : '<div class="candidate-empty">当前报告期没有待核验候选。</div>';
    generateVerificationPrompt();
  }

  function renderCandidates() {
    const status = els.candidateStatus.value;
    const period = els.candidatePeriod.value;
    const items = workflow.candidates
      .filter(item => !status || item.status === status)
      .filter(item => !period || item.periodCode === period)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    els.workflowStatus.textContent = `候选池：${workflow.candidates.length}家公司，更新于 ${(workflow.updatedAt || '').slice(0, 10) || '—'}`;
    els.candidateList.innerHTML = items.length
      ? items.map(candidateItemHtml).join('')
      : '<div class="candidate-empty">没有符合筛选条件的候选。</div>';
  }

  function sourceDebtItems() {
    return db.stocks.flatMap(stock => (stock.reports || []).map(report => {
      const source = TechStockDB.inspectSourceUrl(report.sourceUrl, report.sourceType);
      const needsSource = isSourceIssue(report, source);
      return needsSource ? { stock, report, source } : null;
    }).filter(Boolean));
  }

  function isSourceIssue(report, source = TechStockDB.inspectSourceUrl(report.sourceUrl, report.sourceType)) {
    return report.verificationStatus !== 'verified' || !source.official || !report.announcementDate;
  }

  function renderSourceDebt() {
    const period = els.sourcePeriod.value;
    const items = sourceDebtItems()
      .filter(item => !period || item.report.periodCode === period)
      .sort((a, b) => TechStockDB.periodRank(b.report.periodCode) - TechStockDB.periodRank(a.report.periodCode))
      .slice(0, 120);
    els.sourceDebtList.innerHTML = items.length ? items.map(({ stock, report, source }) => {
      const reason = report.verificationStatus !== 'verified'
        ? `核验状态：${report.verificationStatus || 'pending'}`
        : !source.official
          ? source.reason
          : '缺少公告日期';
      return `<div class="candidate-item warning">
        <div class="candidate-main"><strong>${escapeHtml(stock.name)}</strong><div class="candidate-meta mono">${escapeHtml(stock.code)}</div></div>
        <div>${pill(report.periodCode, 'blue')}</div>
        <div>${pill(report.verificationStatus === 'verified' ? '来源待补' : '待核验', 'orange')}</div>
        <div class="candidate-meta">${escapeHtml(report.sourceName || '未填来源')}<div>${escapeHtml(source.host || '无域名')}</div></div>
        <div class="candidate-reason">${escapeHtml(reason)}</div>
      </div>`;
    }).join('') : '<div class="candidate-empty">当前筛选范围没有待补公告来源。</div>';
  }

  function sourceHealthStats() {
    const reports = db.stocks.flatMap(stock => (stock.reports || []).map(report => {
      const source = TechStockDB.inspectSourceUrl(report.sourceUrl, report.sourceType);
      return { report, source };
    }));
    return reports.reduce((stats, item) => {
      stats.total += 1;
      if (item.source.official) stats.official += 1;
      if (isSourceIssue(item.report, item.source)) stats.issue += 1;
      if (item.report.verificationStatus !== 'verified') stats.unverified += 1;
      if (item.report.verificationStatus === 'conflict') stats.conflict += 1;
      return stats;
    }, { total: 0, official: 0, issue: 0, unverified: 0, conflict: 0 });
  }

  function renderSourceHealth() {
    const stats = sourceHealthStats();
    const officialRate = stats.total ? Math.round((stats.official / stats.total) * 100) : 0;
    const issueTone = stats.issue ? 'warning' : 'ok';
    const conflictTone = stats.conflict ? 'danger' : 'ok';
    const cards = [
      { key: 'official', label: '官方来源', value: stats.official, meta: `${officialRate}% / ${stats.total} 条`, tone: 'ok' },
      { key: 'issue', label: '待补/异常来源', value: stats.issue, meta: '点击查看问题记录', tone: issueTone },
      { key: 'unverified', label: '未核验', value: stats.unverified, meta: 'pending 或其他状态', tone: stats.unverified ? 'warning' : 'ok' },
      { key: 'conflict', label: '冲突记录', value: stats.conflict, meta: '需人工复核', tone: conflictTone }
    ];
    els.sourceHealth.innerHTML = cards.map(card => `
      <button class="health-card ${card.tone}" data-health-filter="${card.key}" type="button">
        <span>${escapeHtml(card.label)}</span>
        <strong>${escapeHtml(card.value)}</strong>
        <em>${escapeHtml(card.meta)}</em>
      </button>
    `).join('');
  }

  function updateBackupStatus() {
    els.backupStatus.className = 'notice hidden';
    els.backupStatus.textContent = '';
  }

  function backupReasonLabel(reason) {
    const labels = {
      manual: '手动创建',
      'verified-two-step-merge': '正式核验入库后',
      'before-verified-two-step-merge': '正式核验入库前',
      'screening-import': '导入数据库后',
      'before-screening-import': '导入数据库前',
      reset: '恢复初始数据后',
      'before-reset': '恢复初始数据前',
      'restore-backup': '恢复快照后',
      'before-restore-backup': '恢复快照前',
      'dashboard-import': '旧版看板导入后',
      'before-dashboard-import': '旧版看板导入前',
      'manual-built-in-sync': '同步内置数据后',
      'before-manual-built-in-sync': '同步内置数据前',
      'auto-built-in-sync': '自动同步内置数据后',
      'before-auto-built-in-sync': '自动同步内置数据前',
      'formal-maintenance-delete-report': '删除报告期后',
      'before-formal-maintenance-delete-report': '删除报告期前',
      'formal-maintenance-delete-stock': '删除公司后',
      'before-formal-maintenance-delete-stock': '删除公司前'
    };
    return labels[reason] || reason || '自动保存';
  }

  function renderBackups() {
    const backups = TechStockDB.listBackups();
    els.backupList.innerHTML = backups.length ? backups.map(backup => {
      const reports = backup.db.stocks.reduce((count, stock) => count + stock.reports.length, 0);
      return `<div class="candidate-item backup-item" data-backup-id="${escapeHtml(backup.id)}">
        <div class="candidate-main"><strong>${escapeHtml(backupReasonLabel(backup.reason))}</strong><div class="candidate-meta">${escapeHtml(backup.createdAt.slice(0, 19).replace('T', ' '))}</div></div>
        <div>${pill(`${backup.db.stocks.length}家公司`, 'blue')}</div>
        <div>${pill(`${reports}条报告`, 'green')}</div>
        <div class="candidate-meta">${escapeHtml(backup.db.builtInDataVersion || '无版本号')}</div>
        <div class="actions inline-actions" style="padding:0"><button class="btn restore-backup-btn" data-id="${escapeHtml(backup.id)}" type="button">恢复</button><button class="btn btn-danger delete-backup-btn" data-id="${escapeHtml(backup.id)}" type="button">删除</button></div>
      </div>`;
    }).join('') : '<div class="candidate-empty">还没有本机回退快照。导入、同步、正式入库、恢复初始数据、正式维护或手动创建后会自动出现在这里。</div>';
  }

  function updateDBStatus() {
    const reports = db.stocks.reduce((count, stock) => count + stock.reports.length, 0);
    const verifiedReports = db.stocks.reduce((count, stock) => (
      count + stock.reports.filter(report => report.verificationStatus === 'verified').length
    ), 0);
    const periods = TechStockDB.allPeriods(db);
    els.dbStatus.textContent = `正式数据库：${db.stocks.length}家公司，${reports}条报告期记录，其中已核验${verifiedReports}条；最新报告期 ${periods[0] || '—'}，更新于 ${(db.updatedAt || '').slice(0, 10)}`;
    updateBackupStatus();
  }

  function renderMaintenance() {
    const keyword = (els.maintenanceSearch.value || '').trim().toLowerCase();
    const period = els.maintenancePeriod.value;
    const issueOnly = els.maintenanceIssueOnly.checked;
    const periodOrder = allKnownPeriods();
    const records = db.stocks
      .flatMap(stock => (stock.reports || []).map(report => ({ stock, report })))
      .filter(({ stock, report }) => {
        const source = TechStockDB.inspectSourceUrl(report.sourceUrl, report.sourceType);
        const text = [
          stock.name,
          stock.code,
          stock.sector,
          ...(stock.tags || []),
          report.periodCode,
          report.periodLabel,
          report.sourceName,
          report.sourceHost,
          source.host
        ].join(' ').toLowerCase();
        return (!keyword || text.includes(keyword)) &&
          (!period || report.periodCode === period) &&
          (!issueOnly || isSourceIssue(report, source));
      })
      .sort((a, b) => {
        const byCode = a.stock.code.localeCompare(b.stock.code);
        if (byCode) return byCode;
        return periodOrder.indexOf(a.report.periodCode) - periodOrder.indexOf(b.report.periodCode);
      });

    const companyCount = new Set(records.map(item => item.stock.code)).size;
    els.maintenanceSummary.innerHTML = `
      <span>显示 ${companyCount} 家公司 / ${records.length} 条报告；删除排除 ${maintenanceStats.deletedStocks} 家 / ${maintenanceStats.deletedReports} 条</span>
      ${maintenanceStats.lastBackupId ? '<button id="maintenanceLastBackupBtn" class="link-btn" type="button">查看删除前快照</button>' : ''}
    `;

    els.maintenanceList.innerHTML = records.length ? records.map(({ stock, report }) => {
      const source = TechStockDB.inspectSourceUrl(report.sourceUrl, report.sourceType);
      const statusMap = {
        verified: ['已核验', 'green'],
        conflict: ['数据冲突', 'red'],
        pending: ['待核验', 'orange']
      };
      const [statusLabel, statusTone] = statusMap[report.verificationStatus] || ['待核验', 'orange'];
      const sourceHost = report.sourceHost || source.host || '来源待补';
      const sourceName = report.sourceName || report.sourceType || '公告来源待补';
      const tags = (stock.tags || []).slice(0, 4).join(' / ') || '无标签';
      return `<div class="candidate-item maintenance-record">
        <div class="candidate-main"><strong>${escapeHtml(stock.name)}</strong><div class="candidate-meta mono">${escapeHtml(stock.code)}</div></div>
        <div class="candidate-meta maintenance-sector"><strong>${escapeHtml(stock.sector || '未分板块')}</strong><div>${escapeHtml(tags)}</div></div>
        <div class="maintenance-period">${pill(report.periodCode, 'blue')}<div class="candidate-meta">${escapeHtml(report.periodLabel || periodLabel(report.periodCode))}</div></div>
        <div class="maintenance-metrics">
          <div>营收同比：<strong>${escapeHtml(TechStockDB.formatPercent(report.revenueGrowth))}</strong></div>
          <div>净利润同比：<strong>${escapeHtml(TechStockDB.formatPercent(report.netProfitGrowth, report.netProfitGrowthText))}</strong></div>
          <div>归母净利：<strong>${escapeHtml(TechStockDB.formatNumber(report.netProfit, 4))} 亿</strong></div>
        </div>
        <div class="candidate-meta maintenance-source">
          ${pill(statusLabel, statusTone)}
          <div>${escapeHtml(sourceName)}</div>
          <div>${escapeHtml(sourceHost)}</div>
        </div>
        <div class="actions inline-actions maintenance-actions">
          <button class="btn delete-report-btn" data-code="${escapeHtml(stock.code)}" data-period="${escapeHtml(report.periodCode)}" type="button">删除本报告期</button>
          <button class="btn btn-danger delete-stock-btn" data-code="${escapeHtml(stock.code)}" type="button">删除整家公司</button>
        </div>
      </div>`;
    }).join('') : '<div class="candidate-empty">没有找到匹配的正式数据库报告。</div>';
  }

  function saveMaintainedDB(nextDB, reason) {
    const backup = TechStockDB.createBackup(db, `before-${reason}`);
    maintenanceStats.lastBackupId = backup.id;
    db = TechStockDB.save(nextDB, reason);
    chooseLatestAvailablePeriod();
    renderAll();
    generateDiscoveryPrompt();
    return backup;
  }

  function focusMaintenanceBackup() {
    if (!maintenanceStats.lastBackupId) return;
    const backupItem = els.backupList.querySelector(`[data-backup-id="${CSS.escape(maintenanceStats.lastBackupId)}"]`);
    if (!backupItem) {
      showToast('最近删除前快照已不在本机快照列表中');
      return;
    }
    backupItem.scrollIntoView({ behavior: 'smooth', block: 'center' });
    backupItem.classList.add('backup-item-highlight');
    setTimeout(() => backupItem.classList.remove('backup-item-highlight'), 1800);
  }

  function deleteMaintenanceReport(code, period) {
    const stock = db.stocks.find(item => item.code === code);
    if (!stock) return;
    const report = (stock.reports || []).find(item => item.periodCode === period);
    if (!report) return;
    if (!confirm(`确定删除 ${stock.name}（${stock.code}）的 ${period} 报告期记录吗？\n\n删除前会自动创建本机回退快照。`)) return;
    const nextDB = TechStockDB.clone(db);
    const target = nextDB.stocks.find(item => item.code === code);
    target.reports = (target.reports || []).filter(item => item.periodCode !== period);
    target.updatedAt = new Date().toISOString();
    maintenanceStats.deletedReports += 1;
    saveMaintainedDB(nextDB, 'formal-maintenance-delete-report');
    showToast(`已删除 ${stock.name} ${period} 报告期记录`);
  }

  function deleteMaintenanceStock(code) {
    const stock = db.stocks.find(item => item.code === code);
    if (!stock) return;
    const reportCount = (stock.reports || []).length;
    if (!confirm(`确定删除整家公司 ${stock.name}（${stock.code}）吗？\n\n将同时删除 ${reportCount} 条报告期记录。删除前会自动创建本机回退快照。`)) return;
    const nextDB = TechStockDB.clone(db);
    nextDB.stocks = nextDB.stocks.filter(item => item.code !== code);
    maintenanceStats.deletedStocks += 1;
    maintenanceStats.deletedReports += reportCount;
    saveMaintainedDB(nextDB, 'formal-maintenance-delete-stock');
    showToast(`已删除 ${stock.name} 及其 ${reportCount} 条报告期记录`);
  }

  function renderAll() {
    workflow = TechStockWorkflow.normalizeWorkflow(workflow);
    renderPeriodSelects();
    renderSummary();
    renderBatch();
    renderCandidates();
    renderSourceDebt();
    updateDBStatus();
    renderSourceHealth();
    renderMaintenance();
    renderBackups();
  }

  function renderDiscoveryPreview(result) {
    const validCount = result.validCandidates.length;
    discoveryPreview = result;
    els.discoverySummary.innerHTML = [
      ['返回候选', result.candidates.length],
      ['可加入候选池', validCount],
      ['错误', result.errors.length],
      ['提醒', result.warnings.length],
      ['剩余板块', result.remainingSectors.length]
    ].map(([label, value]) => `<div class="summary-mini"><span>${label}</span><strong>${value}</strong></div>`).join('');
    els.discoveryPreview.innerHTML = result.items.map(item => {
      const cls = item.errors.length ? 'error' : item.warnings.length ? 'warning' : '';
      return `<div class="preview-item ${cls}">
        <strong>${escapeHtml(item.candidate.name || '未命名')}</strong>
        <span class="mono">${escapeHtml(item.candidate.code || '无代码')}</span>
        <span>${escapeHtml(item.candidate.periodCode)}</span>
        <span>${item.valid ? pill('可入候选池', 'green') : pill('阻断', 'red')}</span>
        <span>${escapeHtml(item.errors.concat(item.warnings).join('；') || item.candidate.candidateReason || '—')}</span>
      </div>`;
    }).join('') || '<div class="candidate-empty">没有候选记录。</div>';
    els.discoveryValidation.innerHTML = result.errors.concat(result.warnings).map(note => `<li>${escapeHtml(note)}</li>`).join('');
    els.saveCandidates.disabled = validCount === 0;
  }

  function parseDiscovery() {
    try {
      const result = TechStockWorkflow.parseDiscoveryResponse(els.discoveryJson.value, selectedOptions());
      renderDiscoveryPreview(result);
      showToast('候选 JSON 解析完成');
    } catch (error) {
      discoveryPreview = null;
      els.saveCandidates.disabled = true;
      els.discoverySummary.innerHTML = '';
      els.discoveryPreview.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      els.discoveryValidation.innerHTML = '';
    }
  }

  function saveCandidates() {
    if (!discoveryPreview) return;
    const merged = TechStockWorkflow.upsertCandidates(workflow, discoveryPreview.validCandidates, selectedOptions());
    workflow = merged.workflow;
    workflow.discoveryBatches.push({
      id: `discovery-${Date.now()}`,
      periodCode: discoveryPreview.periodCode,
      candidates: discoveryPreview.validCandidates.length,
      errors: discoveryPreview.errors,
      warnings: discoveryPreview.warnings,
      createdAt: new Date().toISOString()
    });
    workflow = TechStockWorkflow.save(workflow, 'candidate-discovery');
    els.saveCandidates.disabled = true;
    renderAll();
    showToast(`候选池更新：新增${merged.result.added}家，更新${merged.result.updated}家`);
  }

  function renderVerificationPreview(result) {
    verificationPreview = result;
    els.verificationSummary.innerHTML = [
      ['提交结果', result.counts.submitted],
      ['已核验', result.counts.verified],
      ['淘汰', result.counts.rejected],
      ['无法核验', result.counts.unverified],
      ['错误', result.errors.length]
    ].map(([label, value]) => `<div class="summary-mini"><span>${label}</span><strong>${value}</strong></div>`).join('');
    const verified = result.verifiedItems.map(item => ({
      name: item.name,
      code: item.code,
      status: item.valid ? '正式可入库' : '阻断',
      tone: item.valid ? 'green' : 'red',
      detail: item.errors.concat(item.warnings).join('；') || item.source.sourceLabel
    }));
    const rejected = result.rejectedItems.map(item => ({
      name: item.name,
      code: item.code,
      status: item.valid ? '已淘汰' : '阻断',
      tone: 'red',
      detail: item.errors.join('；') || item.reason
    }));
    const unverified = result.unverifiedItems.map(item => ({
      name: item.name,
      code: item.code,
      status: item.valid ? '无法核验' : '阻断',
      tone: item.valid ? 'gray' : 'red',
      detail: item.errors.join('；') || item.reason
    }));
    els.verificationPreview.innerHTML = [...verified, ...rejected, ...unverified].map(item => `<div class="preview-item ${item.tone === 'red' ? 'error' : ''}">
      <strong>${escapeHtml(item.name || '未命名')}</strong>
      <span class="mono">${escapeHtml(item.code || '无代码')}</span>
      <span>${escapeHtml(result.periodCode)}</span>
      <span>${pill(item.status, item.tone)}</span>
      <span>${escapeHtml(item.detail || '—')}</span>
    </div>`).join('') || '<div class="candidate-empty">没有核验结果。</div>';
    els.verificationValidation.innerHTML = result.errors.concat(result.warnings).map(note => `<li>${escapeHtml(note)}</li>`).join('');
    els.mergeVerification.disabled = !result.valid || result.verifiedStocks.length + result.rejectedItems.length + result.unverifiedItems.length === 0;
  }

  function parseVerification() {
    try {
      const submittedCodes = currentBatch.map(item => item.code);
      const period = verificationPeriod();
      const result = TechStockWorkflow.parseVerificationResponse(els.verificationJson.value, {
        ...selectedOptions(),
        periodCode: period.code,
        periodLabel: period.label,
        periodRange: period.range,
        submittedCodes
      });
      renderVerificationPreview(result);
      showToast('正式核验 JSON 解析完成');
    } catch (error) {
      verificationPreview = null;
      els.mergeVerification.disabled = true;
      els.verificationSummary.innerHTML = '';
      els.verificationPreview.innerHTML = `<div class="notice error">${escapeHtml(error.message)}</div>`;
      els.verificationValidation.innerHTML = '';
    }
  }

  function updateCandidateStatuses(result, mergedResult) {
    const map = new Map(workflow.candidates.map(candidate => [candidate.id, candidate]));
    const periodCode = result.periodCode;
    const mark = (code, patch) => {
      const id = `${periodCode}|${TechStockDB.normalizeCode(code)}`;
      const item = map.get(id);
      if (!item) return;
      map.set(id, {
        ...item,
        ...patch,
        verificationAttempts: (item.verificationAttempts || 0) + 1,
        lastVerificationAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
      });
    };
    result.verifiedItems.filter(item => item.valid).forEach(item => mark(item.code, { status: 'verified', rejectionReason: '', unverifiedReason: '' }));
    result.rejectedItems.filter(item => item.valid).forEach(item => mark(item.code, { status: 'rejected', rejectionReason: item.reason, unverifiedReason: '' }));
    result.unverifiedItems.filter(item => item.valid).forEach(item => mark(item.code, { status: 'unverified', unverifiedReason: item.reason, rejectionReason: '' }));
    workflow.candidates = [...map.values()];
    workflow.verificationBatches.push({
      id: `verification-${Date.now()}`,
      periodCode,
      submittedCodes: result.submittedCodes,
      counts: result.counts,
      mergeResult: mergedResult,
      createdAt: new Date().toISOString()
    });
  }

  function mergeVerification() {
    if (!verificationPreview || !verificationPreview.valid) return;
    const period = verificationPeriod();
    const merged = TechStockDB.mergeVerifiedStocks(db, {
      periodCode: period.code,
      periodLabel: period.label,
      periodRange: period.range,
      stocks: verificationPreview.verifiedStocks
    }, {
      ...selectedOptions(),
      periodCode: period.code,
      periodLabel: period.label,
      periodRange: period.range,
      submittedCodes: verificationPreview.submittedCodes
    });
    db = TechStockDB.save(merged.db, 'verified-two-step-merge');
    updateCandidateStatuses(verificationPreview, merged.result);
    workflow = TechStockWorkflow.save(workflow, 'verification-result');
    verificationPreview = null;
    els.mergeVerification.disabled = true;
    els.verificationJson.value = '';
    els.verificationPreview.innerHTML = '<div class="notice success">正式核验结果已处理，verified 记录已写入正式数据库，候选池状态已更新。</div>';
    els.verificationSummary.innerHTML = '';
    els.verificationValidation.innerHTML = merged.result.warnings.map(warning => `<li>${escapeHtml(warning)}</li>`).join('');
    renderAll();
    showToast(`入库完成：新增报告${merged.result.reportsAdded}条，更新报告${merged.result.reportsUpdated}条`);
  }

  function markBatchVerifying() {
    if (!currentBatch.length) return;
    const ids = new Set(currentBatch.map(item => item.id));
    workflow.candidates = workflow.candidates.map(item => ids.has(item.id)
      ? { ...item, status: 'verifying', updatedAt: new Date().toISOString() }
      : item);
    workflow = TechStockWorkflow.save(workflow, 'mark-verifying');
    renderAll();
    showToast(`已标记 ${ids.size} 家为核验中`);
  }

  function exportJSON(value, filename) {
    const blob = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  async function importDB(file) {
    if (!file) return;
    try {
      const raw = await TechStockDB.readFile(file);
      const incoming = TechStockDB.normalizeDB(raw);
      const reports = incoming.stocks.reduce((count, stock) => count + stock.reports.length, 0);
      const confirmed = confirm(`即将导入 ${incoming.stocks.length} 家公司、${reports} 条报告期记录，并覆盖当前正式数据库。\n\n系统会自动创建导入前快照。是否继续？`);
      if (!confirmed) return;
      db = TechStockDB.save(incoming, 'screening-import');
      chooseLatestAvailablePeriod();
      updateVisibility();
      generateDiscoveryPrompt();
      renderAll();
      showToast(`已导入 ${db.stocks.length} 家公司`);
    } catch (error) {
      alert(`导入失败：${error.message}`);
    } finally {
      els.importFile.value = '';
    }
  }

  async function importWorkflow(file) {
    if (!file) return;
    try {
      const raw = await TechStockDB.readFile(file);
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.candidates)) {
        throw new Error('文件不是有效的候选池工作流 JSON');
      }
      const incoming = TechStockWorkflow.normalizeWorkflow(raw);
      const confirmed = confirm(`即将导入 ${incoming.candidates.length} 条候选记录，并覆盖当前 ${workflow.candidates.length} 条候选记录。\n\n是否继续？`);
      if (!confirmed) return;
      workflow = TechStockWorkflow.save(incoming, 'workflow-import');
      currentBatch = [];
      discoveryPreview = null;
      verificationPreview = null;
      els.saveCandidates.disabled = true;
      els.mergeVerification.disabled = true;
      els.discoverySummary.innerHTML = '';
      els.discoveryPreview.innerHTML = '';
      els.discoveryValidation.innerHTML = '';
      els.verificationSummary.innerHTML = '';
      els.verificationPreview.innerHTML = '';
      els.verificationValidation.innerHTML = '';
      renderAll();
      showToast(`已导入 ${workflow.candidates.length} 条候选记录`);
    } catch (error) {
      alert(`候选池导入失败：${error.message}`);
    } finally {
      els.workflowImportFile.value = '';
    }
  }

  function setActiveTab(id, updateHash = true) {
    const validIds = new Set(els.panels.map(panel => panel.id));
    const target = validIds.has(id) ? id : 'discoveryTab';
    els.tabs.forEach(tab => tab.classList.toggle('active', tab.dataset.tab === target));
    els.panels.forEach(panel => panel.classList.toggle('hidden', panel.id !== target));
    if (updateHash && history.replaceState) history.replaceState(null, '', `#${target}`);
  }

  function bindEvents() {
    els.tabs.forEach(tab => tab.addEventListener('click', () => setActiveTab(tab.dataset.tab)));
    $('#generateDiscoveryBtn').addEventListener('click', generateDiscoveryPrompt);
    $('#copyDiscoveryBtn').addEventListener('click', async () => {
      generateDiscoveryPrompt();
      await navigator.clipboard.writeText(els.discoveryPrompt.value).catch(() => {
        els.discoveryPrompt.select();
        document.execCommand('copy');
      });
      showToast('候选提问已复制');
    });
    $('#parseDiscoveryBtn').addEventListener('click', parseDiscovery);
    $('#sampleDiscoveryBtn').addEventListener('click', () => {
      els.discoveryJson.value = candidateSchema(selectedPeriod());
      els.discoveryPreview.innerHTML = '<div class="notice">已填入候选示例结构，请替换为 AI 返回的真实候选后再解析。</div>';
    });
    $('#clearDiscoveryBtn').addEventListener('click', () => {
      els.discoveryJson.value = '';
      els.discoverySummary.innerHTML = '';
      els.discoveryPreview.innerHTML = '';
      els.discoveryValidation.innerHTML = '';
      discoveryPreview = null;
      els.saveCandidates.disabled = true;
    });
    els.saveCandidates.addEventListener('click', saveCandidates);
    $('#refreshBatchBtn').addEventListener('click', renderBatch);
    $('#markVerifyingBtn').addEventListener('click', markBatchVerifying);
    $('#generateVerificationBtn').addEventListener('click', generateVerificationPrompt);
    $('#copyVerificationBtn').addEventListener('click', async () => {
      generateVerificationPrompt();
      await navigator.clipboard.writeText(els.verificationPrompt.value).catch(() => {
        els.verificationPrompt.select();
        document.execCommand('copy');
      });
      showToast('核验提问已复制');
    });
    $('#parseVerificationBtn').addEventListener('click', parseVerification);
    $('#sampleVerificationBtn').addEventListener('click', () => {
      els.verificationJson.value = formalSchema(verificationPeriod(), currentBatch);
      els.verificationPreview.innerHTML = '<div class="notice">已填入核验示例结构，请替换为正式公告核验后的真实结果。</div>';
    });
    $('#clearVerificationBtn').addEventListener('click', () => {
      els.verificationJson.value = '';
      els.verificationSummary.innerHTML = '';
      els.verificationPreview.innerHTML = '';
      els.verificationValidation.innerHTML = '';
      verificationPreview = null;
      els.mergeVerification.disabled = true;
    });
    els.mergeVerification.addEventListener('click', mergeVerification);
    [els.period, els.rev, els.exclude688, els.excludeST, els.excludeBSE, els.scope, els.customCode, els.customLabel, els.customRange].filter(Boolean).forEach(element => {
      element.addEventListener(element.tagName === 'SELECT' || element.type === 'checkbox' ? 'change' : 'input', () => {
        updateVisibility();
        generateDiscoveryPrompt();
        renderPeriodSelects();
      });
    });
    [els.verificationPeriod, els.batchSize].forEach(element => element.addEventListener('change', renderBatch));
    [els.candidateStatus, els.candidatePeriod].forEach(element => element.addEventListener('change', renderCandidates));
    els.sourcePeriod.addEventListener('change', renderSourceDebt);
    els.sourceHealth.addEventListener('click', event => {
      const card = event.target.closest('[data-health-filter]');
      if (!card) return;
      if (card.dataset.healthFilter === 'official') {
        els.maintenanceIssueOnly.checked = false;
      } else {
        els.maintenanceIssueOnly.checked = true;
      }
      els.maintenanceSearch.value = '';
      els.maintenancePeriod.value = '';
      renderMaintenance();
      document.querySelector('.maintenance-panel')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    els.maintenanceSearch.addEventListener('input', renderMaintenance);
    els.maintenancePeriod.addEventListener('change', renderMaintenance);
    els.maintenanceIssueOnly.addEventListener('change', renderMaintenance);
    els.maintenanceReset.addEventListener('click', () => {
      els.maintenanceSearch.value = '';
      els.maintenancePeriod.value = '';
      els.maintenanceIssueOnly.checked = false;
      renderMaintenance();
    });
    els.maintenanceSummary.addEventListener('click', event => {
      if (event.target.closest('#maintenanceLastBackupBtn')) focusMaintenanceBackup();
    });
    els.maintenanceList.addEventListener('click', event => {
      const reportButton = event.target.closest('.delete-report-btn');
      const stockButton = event.target.closest('.delete-stock-btn');
      if (reportButton) deleteMaintenanceReport(reportButton.dataset.code, reportButton.dataset.period);
      if (stockButton) deleteMaintenanceStock(stockButton.dataset.code);
    });
    $('#refreshSourceDebtBtn').addEventListener('click', renderSourceDebt);
    $('#exportWorkflowBtn').addEventListener('click', () => {
      exportJSON(workflow, '科技制造候选池工作流.json');
      showToast('候选池工作流已导出');
    });
    $('#importWorkflowBtn').addEventListener('click', () => els.workflowImportFile.click());
    els.workflowImportFile.addEventListener('change', event => importWorkflow(event.target.files[0]));
    $('#createBackupBtn').addEventListener('click', () => {
      TechStockDB.createBackup(db, 'manual');
      renderAll();
      showToast('已创建本机回退快照');
    });
    $('#refreshBackupsBtn').addEventListener('click', () => {
      renderBackups();
      updateBackupStatus();
      showToast('快照列表已刷新');
    });
    els.backupList.addEventListener('click', event => {
      const restoreButton = event.target.closest('.restore-backup-btn');
      const deleteButton = event.target.closest('.delete-backup-btn');
      if (restoreButton) {
        if (!confirm('确定恢复这个本地快照吗？\n\n当前正式数据库会先自动保留为回退快照，然后再被所选快照覆盖。')) return;
        db = TechStockDB.restoreBackup(restoreButton.dataset.id);
        chooseLatestAvailablePeriod();
        renderAll();
        generateDiscoveryPrompt();
        showToast('已恢复本地快照，原数据库已保留为回退记录');
      }
      if (deleteButton) {
        if (!confirm('确定删除这个本地快照吗？')) return;
        TechStockDB.deleteBackup(deleteButton.dataset.id);
        renderAll();
        showToast('已删除本地快照');
      }
    });
    $('#resetWorkflowBtn').addEventListener('click', () => {
      if (!confirm('确定清空候选池和工作流批次记录吗？\n\n正式数据库不会被删除。')) return;
      workflow = TechStockWorkflow.reset();
      renderAll();
      showToast('候选池已清空');
    });
    $('#exportBtn').addEventListener('click', () => {
      TechStockDB.exportJSON(db, '科技制造高增长股票数据库.json');
      localStorage.setItem(BACKUP_KEY, new Date().toISOString());
      updateBackupStatus();
      showToast('正式数据库已导出');
    });
    $('#importBtn').addEventListener('click', () => els.importFile.click());
    els.importFile.addEventListener('change', event => importDB(event.target.files[0]));
    $('#syncDefaultBtn').addEventListener('click', () => {
      if (!confirm('同步会用最新版内置数据更新同报告期记录，并保留你新增的扩展公司。\n\n系统会自动创建同步前快照，是否继续？')) return;
      const synced = TechStockDB.syncBuiltInData(db, { force: true });
      db = TechStockDB.save(synced.db, 'manual-built-in-sync');
      chooseLatestAvailablePeriod();
      renderAll();
      generateDiscoveryPrompt();
      showToast(`已同步 ${synced.result.reportsUpdated} 条内置报告，保留 ${synced.result.extraStocksPreserved} 家扩展公司`);
    });
    $('#resetBtn').addEventListener('click', () => {
      if (!confirm('确定恢复内置初始数据吗？\n\n本机新增的公司和报告期将被覆盖。系统会自动创建恢复前快照，是否继续？')) return;
      db = TechStockDB.reset();
      chooseLatestAvailablePeriod();
      renderAll();
      generateDiscoveryPrompt();
      showToast('已恢复初始数据，原数据库已保留为回退记录');
    });
    window.addEventListener('techstock:external-update', () => {
      db = TechStockDB.load();
      renderAll();
    });
    window.addEventListener('techstock:workflow-external-update', () => {
      workflow = TechStockWorkflow.load();
      renderAll();
    });
  }

  chooseLatestAvailablePeriod();
  updateVisibility();
  bindEvents();
  setActiveTab(location.hash.slice(1) || 'discoveryTab', false);
  generateDiscoveryPrompt();
  renderAll();
})();
