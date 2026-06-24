(function () {
  'use strict';

  const STORAGE_KEY = 'tech-stock-research-database-v2';
  const BACKUP_STORAGE_KEY = 'tech-stock-research-database-backups-v1';
  const CHANNEL_NAME = 'tech-stock-research-sync-v2';
  const PERIOD_ORDER = { Q1: 1, H1: 2, Q3: 3, A: 4 };
  const STOCK_CODE_RE = /^\d{6}\.(SZ|SH|BJ)$/;
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL_NAME) : null;
  let lastLoadInfo = { source: 'default', builtInSync: null };

  const OFFICIAL_SOURCE_RULES = [
    { type: 'cninfo', label: '巨潮资讯', domains: ['cninfo.com.cn'] },
    { type: 'exchange', label: '上海证券交易所', domains: ['sse.com.cn'] },
    { type: 'exchange', label: '深圳证券交易所', domains: ['szse.cn'] },
    { type: 'exchange', label: '北京证券交易所', domains: ['bse.cn'] }
  ];

  const MEDIA_DOMAINS = [
    'eastmoney.com',
    '10jqka.com.cn',
    'sina.com.cn',
    'qq.com',
    'sohu.com',
    'stcn.com',
    'cls.cn',
    'xueqiu.com',
    'baidu.com'
  ];

  const clone = value => JSON.parse(JSON.stringify(value));
  const numberOrNull = value => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };
  const text = value => String(value ?? '').trim();
  const uniq = values => [...new Set((Array.isArray(values) ? values : [values]).map(text).filter(Boolean))];
  const now = () => new Date().toISOString();

  function normalizeCode(code) {
    return text(code).toUpperCase().replace(/\s+/g, '');
  }

  function isValidStockCode(code) {
    return STOCK_CODE_RE.test(normalizeCode(code));
  }

  function normalizePeriodCode(code) {
    return text(code).toUpperCase().replace(/\s+/g, '');
  }

  function periodRank(code) {
    const match = normalizePeriodCode(code).match(/^(\d{4})(Q1|H1|Q3|A)$/);
    return match ? Number(match[1]) * 10 + (PERIOD_ORDER[match[2]] || 0) : 0;
  }

  function hostMatches(host, domain) {
    return host === domain || host.endsWith(`.${domain}`);
  }

  function inspectSourceUrl(url, declaredType = '') {
    const rawUrl = text(url);
    const declared = text(declaredType).toLowerCase();

    if (!rawUrl) {
      return {
        url: '',
        validUrl: false,
        host: '',
        sourceType: declared || 'unknown',
        sourceLabel: '缺少来源',
        official: false,
        reason: '缺少正式公告链接'
      };
    }

    if (/xxxx|示例|公告链接|正式报告链接|占位/i.test(rawUrl)) {
      return {
        url: rawUrl,
        validUrl: false,
        host: '',
        sourceType: declared || 'unknown',
        sourceLabel: '占位链接',
        official: false,
        reason: 'sourceUrl包含占位内容，不是真实公告链接'
      };
    }

    let parsed;
    try {
      parsed = new URL(rawUrl, window.location?.href || 'https://localhost/');
    } catch (error) {
      return {
        url: rawUrl,
        validUrl: false,
        host: '',
        sourceType: declared || 'unknown',
        sourceLabel: '无效链接',
        official: false,
        reason: 'sourceUrl不是有效网址'
      };
    }

    const protocolValid = ['http:', 'https:'].includes(parsed.protocol);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, '');

    for (const rule of OFFICIAL_SOURCE_RULES) {
      if (rule.domains.some(domain => hostMatches(host, domain))) {
        return {
          url: parsed.href,
          validUrl: protocolValid,
          host,
          sourceType: rule.type,
          sourceLabel: rule.label,
          official: protocolValid,
          reason: protocolValid ? '' : '正式来源链接必须使用http或https'
        };
      }
    }

    if (MEDIA_DOMAINS.some(domain => hostMatches(host, domain))) {
      return {
        url: parsed.href,
        validUrl: protocolValid,
        host,
        sourceType: 'media',
        sourceLabel: '财经媒体或搜索页面',
        official: false,
        reason: '财经媒体不能代替正式公告来源'
      };
    }

    return {
      url: parsed.href,
      validUrl: protocolValid,
      host,
      sourceType: declared === 'company_website' ? 'company_website' : (declared || 'unknown'),
      sourceLabel: declared === 'company_website' ? '上市公司官网（待人工确认）' : '未知来源',
      official: false,
      reason: declared === 'company_website'
        ? '上市公司官网需要人工确认后才可入库'
        : '来源域名不在自动认可的正式公告白名单中'
    };
  }

  function normalizeReport(report = {}) {
    const growthText = text(report.netProfitGrowthText);
    const netProfit = numberOrNull(report.netProfit);
    const source = inspectSourceUrl(report.sourceUrl, report.sourceType);

    return {
      periodCode: normalizePeriodCode(report.periodCode),
      periodLabel: text(report.periodLabel),
      periodRange: text(report.periodRange),
      revenue: numberOrNull(report.revenue),
      revenueGrowth: numberOrNull(report.revenueGrowth),
      netProfit,
      netProfitPositive:
        report.netProfitPositive === true || report.netProfitPositive === 'true'
          ? true
          : report.netProfitPositive === false || report.netProfitPositive === 'false'
            ? false
            : netProfit === null
              ? null
              : netProfit > 0,
      netProfitGrowth: numberOrNull(report.netProfitGrowth),
      netProfitGrowthText: growthText,
      deductNetProfit: numberOrNull(report.deductNetProfit),
      operatingCashFlow: numberOrNull(report.operatingCashFlow),
      sourceName: text(report.sourceName),
      sourceUrl: text(report.sourceUrl),
      sourceType: source.sourceType,
      sourceHost: source.host,
      sourceConfirmedByUser: report.sourceConfirmedByUser === true,
      announcementDate: text(report.announcementDate),
      verificationStatus: ['verified', 'pending', 'conflict'].includes(report.verificationStatus)
        ? report.verificationStatus
        : 'pending',
      verificationNote: text(report.verificationNote),
      fieldVerificationStatus: ['matched', 'partial', 'mismatch', 'unparsed', 'pending'].includes(report.fieldVerificationStatus)
        ? report.fieldVerificationStatus
        : 'pending',
      fieldVerificationNote: text(report.fieldVerificationNote),
      fieldVerifiedAt: text(report.fieldVerifiedAt),
      fieldVerification: report.fieldVerification && typeof report.fieldVerification === 'object'
        ? clone(report.fieldVerification)
        : null,
      updatedAt: text(report.updatedAt) || now()
    };
  }

  function normalizeStock(stock = {}) {
    const reports = Array.isArray(stock.reports)
      ? stock.reports.map(normalizeReport).filter(report => report.periodCode)
      : [];
    const reportMap = new Map();
    reports.forEach(report => reportMap.set(report.periodCode, report));

    return {
      name: text(stock.name),
      code: normalizeCode(stock.code),
      sector: text(stock.sector),
      tags: uniq(stock.tags),
      watchStatus: text(stock.watchStatus) || 'normal',
      notes: text(stock.notes),
      reports: [...reportMap.values()].sort((a, b) => periodRank(a.periodCode) - periodRank(b.periodCode)),
      createdAt: text(stock.createdAt) || now(),
      updatedAt: text(stock.updatedAt) || now()
    };
  }

  function normalizeDB(raw) {
    const base = raw && typeof raw === 'object' ? raw : {};
    const stocks = Array.isArray(base.stocks)
      ? base.stocks.map(normalizeStock).filter(stock => stock.name && stock.code)
      : [];
    const stockMap = new Map();
    stocks.forEach(stock => stockMap.set(stock.code, stock));

    return {
      schemaVersion: '2.1.0',
      builtInDataVersion: text(base.builtInDataVersion),
      builtInDataUpdatedAt: text(base.builtInDataUpdatedAt),
      title: text(base.title) || '科技制造高增长股票研究数据库',
      description: text(base.description),
      settings: {
        revenueGrowthThreshold: numberOrNull(base.settings?.revenueGrowthThreshold) ?? 8,
        requirePositiveNetProfit: base.settings?.requirePositiveNetProfit !== false,
        requirePositiveNetProfitGrowth: base.settings?.requirePositiveNetProfitGrowth !== false,
        exclude688: base.settings?.exclude688 !== false,
        excludeST: base.settings?.excludeST !== false,
        excludeBSE: base.schemaVersion === '2.1.0' ? base.settings?.excludeBSE !== false : true,
        verifiedGateEnabled: base.settings?.verifiedGateEnabled !== false
      },
      updatedAt: text(base.updatedAt) || now(),
      migrationSupplements: Array.isArray(base.migrationSupplements)
        ? base.migrationSupplements.map(normalizeStock).filter(stock => stock.name && stock.code)
        : [],
      stocks: [...stockMap.values()]
    };
  }

  function reportTimestamp(report) {
    const value = Date.parse(text(report?.updatedAt));
    return Number.isFinite(value) ? value : 0;
  }

  function isCompleteOfficialReport(report) {
    if (!report || report.verificationStatus !== 'verified') return false;
    const source = inspectSourceUrl(report.sourceUrl, report.sourceType);
    return source.official && report.netProfit !== null && (
      report.netProfitGrowth !== null || Boolean(text(report.netProfitGrowthText))
    );
  }

  function shouldKeepSavedReport(savedReport, builtInReport, force = false) {
    if (force || !savedReport) return false;
    // 用户后来通过正式公告核验、且更新时间晚于内置快照时，保留用户版本。
    return isCompleteOfficialReport(savedReport)
      && reportTimestamp(savedReport) > reportTimestamp(builtInReport);
  }

  function syncBuiltInData(currentDb, options = {}) {
    const builtIn = normalizeDB(window.TechStockDefaultDB || {});
    const merged = normalizeDB(currentDb || {});
    const force = options.force === true;
    const result = {
      changed: false,
      stocksAdded: 0,
      stocksMatched: 0,
      reportsAdded: 0,
      reportsUpdated: 0,
      reportsPreserved: 0,
      extraStocksPreserved: 0,
      supplementalStocksMatched: 0,
      supplementalReportsAdded: 0,
      supplementalReportsUpdated: 0,
      fromVersion: merged.builtInDataVersion || '',
      toVersion: builtIn.builtInDataVersion || ''
    };

    const stockMap = new Map(merged.stocks.map(stock => [stock.code, stock]));

    for (const builtStock of builtIn.stocks) {
      let target = stockMap.get(builtStock.code);
      if (!target) {
        target = clone(builtStock);
        merged.stocks.push(target);
        stockMap.set(target.code, target);
        result.stocksAdded += 1;
        result.changed = true;
        continue;
      }

      result.stocksMatched += 1;
      target.name = builtStock.name || target.name;
      target.sector = builtStock.sector || target.sector;
      target.tags = uniq([...(builtStock.tags || []), ...(target.tags || [])]);
      const reportMap = new Map((target.reports || []).map(report => [report.periodCode, report]));

      for (const builtReport of builtStock.reports || []) {
        const savedReport = reportMap.get(builtReport.periodCode);
        if (!savedReport) {
          target.reports.push(clone(builtReport));
          reportMap.set(builtReport.periodCode, builtReport);
          result.reportsAdded += 1;
          result.changed = true;
          continue;
        }

        if (shouldKeepSavedReport(savedReport, builtReport, force)) {
          result.reportsPreserved += 1;
          continue;
        }

        const index = target.reports.findIndex(report => report.periodCode === builtReport.periodCode);
        target.reports[index] = clone(builtReport);
        result.reportsUpdated += 1;
        result.changed = true;
      }

      target.reports.sort((a, b) => periodRank(a.periodCode) - periodRank(b.periodCode));
      target.updatedAt = builtStock.updatedAt || target.updatedAt || now();
    }

    // 兼容旧本地数据库中已经存在、但不属于当前内置80家公司基线的记录。
    // 这些补充项只更新已存在公司，不会自动加入全新数据库。
    for (const supplement of builtIn.migrationSupplements || []) {
      const target = stockMap.get(supplement.code);
      if (!target) continue;
      result.supplementalStocksMatched += 1;
      target.name = supplement.name || target.name;
      target.sector = supplement.sector || target.sector;
      target.tags = uniq([...(supplement.tags || []), ...(target.tags || [])]);
      for (const supplementReport of supplement.reports || []) {
        const index = target.reports.findIndex(report => report.periodCode === supplementReport.periodCode);
        if (index < 0) {
          target.reports.push(clone(supplementReport));
          result.reportsAdded += 1;
          result.supplementalReportsAdded += 1;
          result.changed = true;
          continue;
        }
        if (shouldKeepSavedReport(target.reports[index], supplementReport, force)) {
          result.reportsPreserved += 1;
          continue;
        }
        target.reports[index] = clone(supplementReport);
        result.reportsUpdated += 1;
        result.supplementalReportsUpdated += 1;
        result.changed = true;
      }
      target.reports.sort((a, b) => periodRank(a.periodCode) - periodRank(b.periodCode));
      target.updatedAt = supplement.updatedAt || target.updatedAt || now();
    }

    result.extraStocksPreserved = merged.stocks.filter(stock => !builtIn.stocks.some(item => item.code === stock.code)).length;
    merged.builtInDataVersion = builtIn.builtInDataVersion;
    merged.builtInDataUpdatedAt = builtIn.builtInDataUpdatedAt || builtIn.updatedAt;
    merged.schemaVersion = builtIn.schemaVersion || merged.schemaVersion;
    merged.updatedAt = now();

    if (result.fromVersion !== result.toVersion) result.changed = true;
    return { db: normalizeDB(merged), result };
  }

  function load() {
    const builtIn = normalizeDB(window.TechStockDefaultDB || {});
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) {
        lastLoadInfo = { source: 'default', builtInSync: null };
        return builtIn;
      }

      const current = normalizeDB(JSON.parse(saved));
      const needsSync = Boolean(builtIn.builtInDataVersion)
        && current.builtInDataVersion !== builtIn.builtInDataVersion;

      if (needsSync) {
        const synced = syncBuiltInData(current);
        try {
          createBackup(current, 'before-auto-built-in-sync');
          localStorage.setItem(STORAGE_KEY, JSON.stringify(synced.db));
          createBackup(synced.db, 'auto-built-in-sync');
        } catch (error) {
          console.warn('自动同步内置数据后保存失败', error);
        }
        lastLoadInfo = { source: 'localStorage', builtInSync: synced.result };
        return synced.db;
      }

      lastLoadInfo = { source: 'localStorage', builtInSync: null };
      return current;
    } catch (error) {
      console.warn('读取本地数据库失败，使用默认数据', error);
      lastLoadInfo = { source: 'default-fallback', builtInSync: null, error: error.message };
      return builtIn;
    }
  }

  function getLastLoadInfo() {
    return clone(lastLoadInfo);
  }

  function normalizeBackups(raw) {
    const list = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    return list
      .filter(item => item && typeof item === 'object' && item.db)
      .map(item => ({
        id: text(item.id) || `backup-${Date.parse(text(item.createdAt)) || Date.now()}`,
        reason: text(item.reason) || 'manual',
        createdAt: text(item.createdAt) || now(),
        db: normalizeDB(item.db)
      }))
      .filter(item => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  function listBackups() {
    try {
      return normalizeBackups(JSON.parse(localStorage.getItem(BACKUP_STORAGE_KEY) || '[]'));
    } catch (error) {
      console.warn('读取本地快照失败', error);
      return [];
    }
  }

  function saveBackups(backups) {
    const normalized = normalizeBackups(backups).slice(0, 20);
    try {
      localStorage.setItem(BACKUP_STORAGE_KEY, JSON.stringify(normalized));
    } catch (error) {
      console.warn('保存本地快照失败', error);
    }
    return normalized;
  }

  function createBackup(db, reason = 'manual') {
    const normalized = normalizeDB(db);
    const backups = listBackups();
    const fingerprint = JSON.stringify({
      version: normalized.builtInDataVersion,
      updatedAt: normalized.updatedAt,
      stocks: normalized.stocks.length,
      reports: normalized.stocks.reduce((count, stock) => count + stock.reports.length, 0)
    });
    const latest = backups[0];
    const latestFingerprint = latest ? JSON.stringify({
      version: latest.db.builtInDataVersion,
      updatedAt: latest.db.updatedAt,
      stocks: latest.db.stocks.length,
      reports: latest.db.stocks.reduce((count, stock) => count + stock.reports.length, 0)
    }) : '';
    if (fingerprint === latestFingerprint && reason !== 'manual') return latest;

    const backup = {
      id: `backup-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
      reason,
      createdAt: now(),
      db: normalized
    };
    saveBackups([backup, ...backups]);
    return backup;
  }

  function deleteBackup(id) {
    return saveBackups(listBackups().filter(item => item.id !== id));
  }

  function restoreBackup(id) {
    const backup = listBackups().find(item => item.id === id);
    if (!backup) throw new Error('未找到指定快照');
    return save(backup.db, 'restore-backup');
  }

  const PRE_OPERATION_BACKUP_REASONS = new Set([
    'screening-import',
    'dashboard-import',
    'manual-built-in-sync',
    'verified-two-step-merge',
    'restore-backup',
    'reset'
  ]);

  function createPreOperationBackup(reason) {
    if (!PRE_OPERATION_BACKUP_REASONS.has(reason)) return null;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return null;
      return createBackup(normalizeDB(JSON.parse(saved)), `before-${reason}`);
    } catch (error) {
      console.warn('创建操作前快照失败', error);
      return null;
    }
  }

  function save(db, reason = 'update') {
    const normalized = normalizeDB(db);
    normalized.updatedAt = now();
    try {
      createPreOperationBackup(reason);
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
      createBackup(normalized, reason);
    } catch (error) {
      console.warn('本地保存失败', error);
    }
    if (channel) channel.postMessage({ type: 'database-updated', reason, updatedAt: normalized.updatedAt });
    window.dispatchEvent(new CustomEvent('techstock:database-updated', { detail: { reason, db: normalized } }));
    return normalized;
  }

  function reset() {
    return save(clone(window.TechStockDefaultDB), 'reset');
  }

  function getLatestReport(stock) {
    return [...(stock.reports || [])].sort((a, b) => periodRank(b.periodCode) - periodRank(a.periodCode))[0] || null;
  }

  function getReport(stock, periodCode) {
    return (stock.reports || []).find(report => report.periodCode === periodCode) || null;
  }

  function reportQualities(report, settings = {}) {
    if (!report) {
      return {
        hasData: false,
        basic: false,
        strong: false,
        revenuePass: false,
        profitPositive: false,
        profitGrowthPass: false
      };
    }

    const threshold = Number(settings.revenueGrowthThreshold ?? 8);
    const revenuePass = report.revenueGrowth !== null && report.revenueGrowth > threshold;
    const profitPositive = report.netProfit !== null ? report.netProfit > 0 : report.netProfitPositive === true;
    const turnaround = /扭亏为盈/.test(report.netProfitGrowthText || '');
    const profitGrowthPass = (report.netProfitGrowth !== null && report.netProfitGrowth > 0) || turnaround;

    return {
      hasData: true,
      basic: revenuePass && profitPositive,
      strong: revenuePass && profitPositive && profitGrowthPass,
      revenuePass,
      profitPositive,
      profitGrowthPass,
      turnaround
    };
  }

  function stockStatus(stock, periodCode, settings) {
    const reports = [...(stock.reports || [])].sort((a, b) => periodRank(a.periodCode) - periodRank(b.periodCode));
    const current = periodCode ? reports.find(report => report.periodCode === periodCode) : reports[reports.length - 1];
    if (!current) return { key: 'pending', label: '待更新', tone: 'gray', streak: 0, report: null };

    const quality = reportQualities(current, settings);
    const index = reports.findIndex(report => report.periodCode === current.periodCode);
    let streak = 0;
    for (let cursor = index; cursor >= 0; cursor -= 1) {
      if (reportQualities(reports[cursor], settings).strong) streak += 1;
      else break;
    }

    const hadEarlier = reports
      .slice(0, Math.max(index, 0))
      .some(report => {
        const earlierQuality = reportQualities(report, settings);
        return earlierQuality.basic || earlierQuality.strong;
      });

    if (quality.strong) {
      return {
        key: streak >= 2 ? 'continuous' : 'current',
        label: streak >= 2 ? '连续双增' : '本期双增',
        tone: 'green',
        streak,
        report: current
      };
    }
    if (quality.revenuePass && quality.profitPositive && !quality.profitGrowthPass) {
      return { key: 'revenue_only', label: '增收不增利', tone: 'orange', streak: 0, report: current };
    }
    if (!quality.revenuePass && quality.profitPositive && quality.profitGrowthPass) {
      return {
        key: hadEarlier ? 'dropped' : 'profit_only',
        label: hadEarlier ? '跌出条件' : '利润增长',
        tone: 'purple',
        streak: 0,
        report: current
      };
    }
    if (!quality.profitPositive) {
      return {
        key: hadEarlier ? 'dropped' : 'loss',
        label: hadEarlier ? '跌出条件' : '利润为负',
        tone: 'red',
        streak: 0,
        report: current
      };
    }
    if (hadEarlier) return { key: 'dropped', label: '跌出条件', tone: 'red', streak: 0, report: current };
    return { key: 'not_qualified', label: '未达条件', tone: 'gray', streak: 0, report: current };
  }

  function allPeriods(db) {
    const periods = new Set();
    db.stocks.forEach(stock => (stock.reports || []).forEach(report => periods.add(report.periodCode)));
    return [...periods].sort((a, b) => periodRank(b) - periodRank(a));
  }

  function validateStockIdentity(raw, options = {}) {
    const name = text(raw?.name);
    const code = normalizeCode(raw?.code);
    const errors = [];

    if (!name) errors.push('缺少股票名称');
    if (!code) errors.push('缺少股票代码');
    else if (!isValidStockCode(code)) errors.push('股票代码格式必须为000001.SZ、600000.SH或430000.BJ');

    if (options.exclude688 !== false && /^688\d{3}\.SH$/.test(code)) errors.push('排除688科创板');
    if (options.excludeBSE !== false && /\.BJ$/.test(code)) errors.push('排除北交所');
    if (options.excludeST !== false && /(^|\*)ST/i.test(name)) errors.push('排除ST或*ST公司');

    return { name, code, errors };
  }

  function validateFormalStock(raw, options = {}) {
    const identity = validateStockIdentity(raw, options);
    const reportRaw = raw?.report || raw || {};
    const report = normalizeReport({
      ...reportRaw,
      periodCode: reportRaw.periodCode || options.periodCode,
      periodLabel: reportRaw.periodLabel || options.periodLabel,
      periodRange: reportRaw.periodRange || options.periodRange
    });
    const errors = [...identity.errors];
    const warnings = [];

    if (!report.periodCode) errors.push('缺少periodCode');
    if (options.periodCode && report.periodCode !== normalizePeriodCode(options.periodCode)) {
      errors.push(`报告期不一致：应为${normalizePeriodCode(options.periodCode)}`);
    }
    if (report.verificationStatus !== 'verified') errors.push('verificationStatus必须为verified');
    if (report.revenueGrowth === null) errors.push('缺少营业收入同比');
    if (report.netProfit === null) errors.push('缺少归母净利润金额');

    const turnaround = /扭亏为盈/.test(report.netProfitGrowthText || '');
    if (options.requireProfitGrowthFact !== false && report.netProfitGrowth === null && !turnaround) {
      errors.push('缺少归母净利润同比或扭亏为盈说明');
    }

    if (!report.sourceName) errors.push('缺少sourceName');

    const quality = reportQualities(report, {
      revenueGrowthThreshold: Number(options.revenueGrowthThreshold ?? 8)
    });
    const financialPass = options.requireProfitGrowthFact === false ? quality.basic : quality.strong;
    if (options.requireQualified !== false && !financialPass) {
      errors.push(options.requireProfitGrowthFact === false
        ? '正式财务数据未满足营收增长和净利润为正条件'
        : '正式财务数据未满足营收与归母净利润双增长条件');
    }

    const source = inspectSourceUrl(report.sourceUrl, report.sourceType);
    const confirmedUrls = new Set((options.confirmedSourceUrls || []).map(text));
    const companyWebsiteConfirmed =
      source.sourceType === 'company_website' &&
      options.allowConfirmedCompanyWebsite === true &&
      confirmedUrls.has(report.sourceUrl);

    if (!source.official && !companyWebsiteConfirmed) errors.push(source.reason || '来源未通过正式公告校验');
    if (!report.announcementDate) warnings.push('缺少公告日期');

    const submittedCodes = options.submittedCodes
      ? new Set(options.submittedCodes.map(normalizeCode).filter(Boolean))
      : null;
    if (submittedCodes && !submittedCodes.has(identity.code)) errors.push('股票不在本次提交核验名单中');

    report.sourceType = source.sourceType;
    report.sourceHost = source.host;
    report.sourceConfirmedByUser = companyWebsiteConfirmed;

    return {
      valid: errors.length === 0,
      name: identity.name,
      code: identity.code,
      report,
      source,
      errors,
      warnings,
      stock: {
        ...raw,
        name: identity.name,
        code: identity.code,
        sector: text(raw?.sector),
        tags: uniq(raw?.tags),
        report
      }
    };
  }

  function mergePayload(db, payload, options = {}) {
    const normalized = normalizeDB(db);
    const periodCode = normalizePeriodCode(payload?.periodCode || payload?.report?.periodCode);
    const periodLabel = text(payload?.periodLabel || payload?.report?.periodLabel);
    const items = Array.isArray(payload) ? payload : (Array.isArray(payload?.stocks) ? payload.stocks : []);
    const result = {
      added: 0,
      updated: 0,
      reportsAdded: 0,
      reportsUpdated: 0,
      skipped: 0,
      errors: [],
      changes: []
    };

    for (const raw of items) {
      const identity = validateStockIdentity(raw, options);
      if (identity.errors.length) {
        result.skipped += 1;
        result.errors.push(`${identity.name || identity.code || '未知记录'}：${identity.errors.join('、')}`);
        continue;
      }

      const reportRaw = raw.report || raw;
      const report = normalizeReport({
        ...reportRaw,
        periodCode: reportRaw.periodCode || periodCode,
        periodLabel: reportRaw.periodLabel || periodLabel
      });
      if (!report.periodCode) {
        result.skipped += 1;
        result.errors.push(`${identity.name} 缺少periodCode`);
        continue;
      }

      let stock = normalized.stocks.find(item => item.code === identity.code);
      if (!stock) {
        stock = normalizeStock({
          name: identity.name,
          code: identity.code,
          sector: raw.sector,
          tags: raw.tags,
          reports: []
        });
        normalized.stocks.push(stock);
        result.added += 1;
      } else {
        result.updated += 1;
      }

      stock.name = identity.name || stock.name;
      stock.sector = text(raw.sector) || stock.sector;
      stock.tags = uniq([...(stock.tags || []), ...(raw.tags || [])]);
      stock.updatedAt = now();

      const reportIndex = stock.reports.findIndex(item => item.periodCode === report.periodCode);
      if (reportIndex >= 0) {
        if (options.replaceReports === true) {
          stock.reports[reportIndex] = report;
        } else {
          stock.reports[reportIndex] = {
            ...stock.reports[reportIndex],
            ...Object.fromEntries(Object.entries(report).filter(([, value]) => value !== null && value !== ''))
          };
        }
        result.reportsUpdated += 1;
        result.changes.push({ name: identity.name, code: identity.code, action: '更新报告', period: report.periodCode });
      } else {
        stock.reports.push(report);
        result.reportsAdded += 1;
        result.changes.push({ name: identity.name, code: identity.code, action: '新增报告', period: report.periodCode });
      }
      stock.reports.sort((a, b) => periodRank(a.periodCode) - periodRank(b.periodCode));
    }

    normalized.updatedAt = now();
    return { db: normalizeDB(normalized), result };
  }

  function mergeVerifiedStocks(db, payload, options = {}) {
    const normalized = normalizeDB(db);
    const items = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.verifiedStocks)
        ? payload.verifiedStocks
        : Array.isArray(payload?.stocks)
          ? payload.stocks
          : [];

    const periodCode = normalizePeriodCode(options.periodCode || payload?.periodCode);
    const periodLabel = text(options.periodLabel || payload?.periodLabel);
    const periodRange = text(options.periodRange || payload?.periodRange);
    const result = {
      added: 0,
      updated: 0,
      reportsAdded: 0,
      reportsUpdated: 0,
      skipped: 0,
      errors: [],
      warnings: [],
      changes: []
    };
    const seen = new Set();

    for (const raw of items) {
      const validation = validateFormalStock(raw, {
        ...options,
        periodCode,
        periodLabel,
        periodRange
      });
      const label = validation.name || validation.code || '未知记录';

      if (validation.code && seen.has(validation.code)) {
        validation.errors.push('同一批次股票代码重复');
      }
      if (validation.code) seen.add(validation.code);

      if (!validation.valid || validation.errors.length) {
        result.skipped += 1;
        result.errors.push(`${label}：${validation.errors.join('、')}`);
        result.changes.push({
          name: validation.name,
          code: validation.code,
          action: '拒绝入库',
          reason: validation.errors.join('、')
        });
        continue;
      }

      let stock = normalized.stocks.find(item => item.code === validation.code);
      if (stock && options.skipExistingStocks === true) {
        result.skipped += 1;
        result.changes.push({
          name: validation.name,
          code: validation.code,
          action: '跳过',
          reason: '数据库已收录该公司'
        });
        continue;
      }

      if (!stock) {
        stock = normalizeStock({
          name: validation.name,
          code: validation.code,
          sector: validation.stock.sector,
          tags: validation.stock.tags,
          reports: []
        });
        normalized.stocks.push(stock);
        result.added += 1;
      } else {
        result.updated += 1;
      }

      stock.name = validation.name || stock.name;
      stock.sector = validation.stock.sector || stock.sector;
      stock.tags = uniq([...(stock.tags || []), ...(validation.stock.tags || [])]);
      stock.updatedAt = now();

      const reportIndex = stock.reports.findIndex(report => report.periodCode === validation.report.periodCode);
      if (reportIndex >= 0) {
        // 正式核验结果是权威快照，允许null覆盖旧错误值。
        stock.reports[reportIndex] = normalizeReport(validation.report);
        result.reportsUpdated += 1;
        result.changes.push({
          name: validation.name,
          code: validation.code,
          action: '权威替换报告',
          period: validation.report.periodCode
        });
      } else {
        stock.reports.push(normalizeReport(validation.report));
        result.reportsAdded += 1;
        result.changes.push({
          name: validation.name,
          code: validation.code,
          action: '新增已核验报告',
          period: validation.report.periodCode
        });
      }

      stock.reports.sort((a, b) => periodRank(a.periodCode) - periodRank(b.periodCode));
      validation.warnings.forEach(warning => result.warnings.push(`${label}：${warning}`));
    }

    normalized.updatedAt = now();
    return { db: normalizeDB(normalized), result };
  }

  function exportJSON(db, filename = 'tech-stock-database.json') {
    const blob = new Blob([JSON.stringify(normalizeDB(db), null, 2)], {
      type: 'application/json;charset=utf-8'
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    setTimeout(() => URL.revokeObjectURL(url), 500);
  }

  function readFile(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        try {
          resolve(JSON.parse(reader.result));
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = reject;
      reader.readAsText(file, 'utf-8');
    });
  }

  function formatNumber(value, digits = 2) {
    return value === null || value === undefined || value === ''
      ? '—'
      : Number(value).toLocaleString('zh-CN', {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits
        });
  }

  function formatPercent(value, textValue = '') {
    if (textValue) return textValue;
    if (value === null || value === undefined || value === '') return '待补';
    const number = Number(value);
    return `${number > 0 ? '+' : ''}${formatNumber(number, 2)}%`;
  }

  function isLocalFile() {
    return location.protocol === 'file:';
  }

  window.TechStockDB = {
    STORAGE_KEY,
    BACKUP_STORAGE_KEY,
    load,
    getLastLoadInfo,
    listBackups,
    createBackup,
    deleteBackup,
    restoreBackup,
    syncBuiltInData,
    save,
    reset,
    normalizeDB,
    normalizeStock,
    normalizeReport,
    normalizeCode,
    isValidStockCode,
    normalizePeriodCode,
    periodRank,
    getLatestReport,
    getReport,
    reportQualities,
    stockStatus,
    allPeriods,
    inspectSourceUrl,
    validateStockIdentity,
    validateFormalStock,
    mergePayload,
    mergeVerifiedStocks,
    exportJSON,
    readFile,
    formatNumber,
    formatPercent,
    isLocalFile,
    clone
  };

  if (channel) {
    channel.addEventListener('message', event => {
      if (event.data?.type === 'database-updated') {
        window.dispatchEvent(new CustomEvent('techstock:external-update', { detail: event.data }));
      }
    });
  }
})();
