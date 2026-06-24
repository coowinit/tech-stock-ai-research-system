(function () {
  'use strict';

  const DB = window.TechStockDB;
  const STORAGE_KEY = 'tech-stock-research-workflow-v1';
  const CHANNEL_NAME = 'tech-stock-research-workflow-sync-v1';
  const VALID_STATUSES = ['pending', 'verifying', 'verified', 'rejected', 'unverified'];
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(CHANNEL_NAME) : null;

  const text = value => String(value ?? '').trim();
  const now = () => new Date().toISOString();
  const clone = value => JSON.parse(JSON.stringify(value));
  const uniq = values => [...new Set((Array.isArray(values) ? values : [values]).map(text).filter(Boolean))];
  const numberOrNull = value => {
    if (value === null || value === undefined || value === '') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  };

  function stripWrappers(input) {
    let value = text(input).replace(/^\uFEFF/, '').trim();
    const fenced = value.match(/^```(?:json|javascript|js)?\s*([\s\S]*?)\s*```$/i);
    if (fenced) value = fenced[1].trim();

    for (let index = 0; index < 2; index += 1) {
      if (value.startsWith('**') && value.endsWith('**')) value = value.slice(2, -2).trim();
      else break;
    }
    return value;
  }

  function extractBalancedJson(input) {
    const value = stripWrappers(input);
    const starts = [];
    for (let index = 0; index < value.length; index += 1) {
      if (value[index] === '{' || value[index] === '[') starts.push(index);
    }

    for (const start of starts) {
      const stack = [];
      let inString = false;
      let escaped = false;

      for (let index = start; index < value.length; index += 1) {
        const char = value[index];

        if (inString) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === '"') inString = false;
          continue;
        }

        if (char === '"') {
          inString = true;
          continue;
        }

        if (char === '{' || char === '[') stack.push(char);
        else if (char === '}' || char === ']') {
          const expected = char === '}' ? '{' : '[';
          if (stack.pop() !== expected) break;
          if (stack.length === 0) return value.slice(start, index + 1);
        }
      }
    }
    return '';
  }

  function parseJsonText(input) {
    const cleaned = stripWrappers(input);
    if (!cleaned) throw new Error('没有可解析的JSON内容');

    try {
      return JSON.parse(cleaned);
    } catch (directError) {
      const extracted = extractBalancedJson(cleaned);
      if (!extracted) throw new Error(`JSON格式错误：${directError.message}`);
      try {
        return JSON.parse(extracted);
      } catch (extractedError) {
        throw new Error(`JSON格式错误：${extractedError.message}`);
      }
    }
  }

  function normalizeCandidate(candidate = {}, context = {}) {
    const periodCode = DB.normalizePeriodCode(candidate.periodCode || context.periodCode);
    const code = DB.normalizeCode(candidate.code);
    const status = VALID_STATUSES.includes(candidate.status) ? candidate.status : 'pending';
    const discoveredAt = text(candidate.discoveredAt) || now();

    return {
      id: `${periodCode}|${code}`,
      periodCode,
      periodLabel: text(candidate.periodLabel || context.periodLabel),
      name: text(candidate.name),
      code,
      sector: text(candidate.sector),
      tags: uniq(candidate.tags),
      candidateReason: text(candidate.candidateReason || candidate.reason),
      reportedRevenueGrowth: numberOrNull(candidate.reportedRevenueGrowth),
      reportedRevenueGrowthMin: numberOrNull(candidate.reportedRevenueGrowthMin),
      reportedRevenueGrowthMax: numberOrNull(candidate.reportedRevenueGrowthMax),
      reportedNetProfit: numberOrNull(candidate.reportedNetProfit),
      reportedNetProfitMin: numberOrNull(candidate.reportedNetProfitMin),
      reportedNetProfitMax: numberOrNull(candidate.reportedNetProfitMax),
      reportedNetProfitPositive:
        candidate.reportedNetProfitPositive === true || candidate.reportedNetProfitPositive === 'true'
          ? true
          : candidate.reportedNetProfitPositive === false || candidate.reportedNetProfitPositive === 'false'
            ? false
            : null,
      reportedNetProfitGrowth: numberOrNull(candidate.reportedNetProfitGrowth),
      reportedNetProfitGrowthMin: numberOrNull(candidate.reportedNetProfitGrowthMin),
      reportedNetProfitGrowthMax: numberOrNull(candidate.reportedNetProfitGrowthMax),
      reportedNetProfitGrowthText: text(candidate.reportedNetProfitGrowthText),
      dataBasis: text(candidate.dataBasis),
      sourceType: text(candidate.sourceType).toLowerCase(),
      discoverySourceName: text(candidate.discoverySourceName || candidate.sourceName),
      discoverySourceUrl: text(candidate.discoverySourceUrl || candidate.sourceUrl),
      needsOfficialVerification: candidate.needsOfficialVerification !== false,
      discoveredBy: uniq(candidate.discoveredBy || context.discoveredBy),
      status,
      verificationAttempts: Number.isFinite(Number(candidate.verificationAttempts))
        ? Number(candidate.verificationAttempts)
        : 0,
      discoveredAt,
      updatedAt: text(candidate.updatedAt) || discoveredAt,
      lastVerificationAt: text(candidate.lastVerificationAt),
      rejectionReason: text(candidate.rejectionReason),
      unverifiedReason: text(candidate.unverifiedReason)
    };
  }

  function normalizeWorkflow(raw) {
    const base = raw && typeof raw === 'object' ? raw : {};
    const candidates = Array.isArray(base.candidates)
      ? base.candidates.map(item => normalizeCandidate(item)).filter(item => item.periodCode && item.code)
      : [];
    const candidateMap = new Map();
    candidates.forEach(candidate => candidateMap.set(candidate.id, candidate));

    return {
      schemaVersion: '1.0.0',
      settings: {
        verificationBatchSize: Math.min(8, Math.max(5, Number(base.settings?.verificationBatchSize) || 6))
      },
      candidates: [...candidateMap.values()],
      discoveryBatches: Array.isArray(base.discoveryBatches) ? base.discoveryBatches : [],
      verificationBatches: Array.isArray(base.verificationBatches) ? base.verificationBatches : [],
      updatedAt: text(base.updatedAt) || now()
    };
  }

  function load() {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      return normalizeWorkflow(saved ? JSON.parse(saved) : {});
    } catch (error) {
      console.warn('读取AI工作流数据失败，使用空工作流', error);
      return normalizeWorkflow({});
    }
  }

  function save(workflow, reason = 'update') {
    const normalized = normalizeWorkflow(workflow);
    normalized.updatedAt = now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
    } catch (error) {
      console.warn('保存AI工作流数据失败', error);
    }
    if (channel) channel.postMessage({ type: 'workflow-updated', reason, updatedAt: normalized.updatedAt });
    window.dispatchEvent(new CustomEvent('techstock:workflow-updated', { detail: { reason, workflow: normalized } }));
    return normalized;
  }

  function reset() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      console.warn('清除AI工作流数据失败', error);
    }
    return save({}, 'reset');
  }

  function validateCandidate(candidate, options = {}) {
    const normalized = normalizeCandidate(candidate, options);
    const identity = DB.validateStockIdentity(normalized, options);
    const errors = [...identity.errors];
    const warnings = [];

    if (!normalized.periodCode) errors.push('缺少候选报告期');
    if (options.periodCode && normalized.periodCode !== DB.normalizePeriodCode(options.periodCode)) {
      errors.push(`候选报告期不一致：应为${DB.normalizePeriodCode(options.periodCode)}`);
    }
    if (!normalized.sector) warnings.push('缺少板块');
    if (!normalized.candidateReason) warnings.push('缺少候选理由');
    if (!normalized.dataBasis) warnings.push('缺少数据依据说明');

    const threshold = Number(options.revenueGrowthThreshold ?? 8);
    const revenueEvidence = normalized.reportedRevenueGrowth !== null
      ? normalized.reportedRevenueGrowth
      : normalized.reportedRevenueGrowthMin;
    const profitEvidence = normalized.reportedNetProfit !== null
      ? normalized.reportedNetProfit
      : normalized.reportedNetProfitMin;
    const profitGrowthEvidence = normalized.reportedNetProfitGrowth !== null
      ? normalized.reportedNetProfitGrowth
      : normalized.reportedNetProfitGrowthMin;
    const turnaround = /扭亏为盈/.test(normalized.reportedNetProfitGrowthText);

    if (revenueEvidence === null) errors.push('缺少营收同比增长线索');
    else if (revenueEvidence <= threshold) errors.push(`营收同比线索未严格大于${threshold}%`);
    if (profitEvidence === null) errors.push('缺少归母净利润金额线索');
    else if (profitEvidence <= 0) errors.push('归母净利润金额线索不大于0');
    if (profitGrowthEvidence === null && !turnaround) errors.push('缺少归母净利润同比增长或扭亏线索');
    else if (profitGrowthEvidence !== null && profitGrowthEvidence <= 0) errors.push('归母净利润同比线索不大于0');
    if (normalized.needsOfficialVerification !== true) errors.push('候选记录必须标记needsOfficialVerification=true');

    const allowedBasis = ['annual_report', 'annual_report_summary', 'performance_flash', 'performance_forecast', 'financial_media', 'other_clue'];
    if (normalized.dataBasis && !allowedBasis.includes(normalized.dataBasis)) warnings.push('dataBasis不在推荐枚举中');
    const allowedSourceTypes = ['exchange', 'cninfo', 'company_website', 'financial_media', 'social_media', 'other'];
    if (normalized.sourceType && !allowedSourceTypes.includes(normalized.sourceType)) warnings.push('sourceType不在推荐枚举中');

    if (!normalized.discoverySourceUrl) {
      warnings.push('缺少候选线索链接');
    } else {
      const inspected = DB.inspectSourceUrl(normalized.discoverySourceUrl,
        normalized.sourceType === 'financial_media' ? 'media' : normalized.sourceType);
      const actualType = inspected.sourceType;
      const declaredType = normalized.sourceType;
      const typeMatches =
        !declaredType ||
        (declaredType === 'financial_media' && actualType === 'media') ||
        (declaredType === actualType) ||
        (declaredType === 'other' && actualType === 'unknown');
      if (!inspected.validUrl) errors.push(inspected.reason || '候选线索链接无效');
      else if (!typeMatches && !['social_media', 'other'].includes(declaredType)) {
        warnings.push(`sourceType与实际域名不一致，实际识别为${actualType}`);
      }
    }

    return {
      valid: errors.length === 0,
      candidate: normalized,
      errors,
      warnings
    };
  }

  function parseDiscoveryResponse(input, options = {}) {
    let raw = typeof input === 'string' ? parseJsonText(input) : clone(input);
    if (Array.isArray(raw)) raw = { candidates: raw };
    if (!Array.isArray(raw?.candidates)) throw new Error('候选发现结果缺少candidates数组');

    const items = raw.candidates.map(candidate => validateCandidate(candidate, {
      ...options,
      periodCode: raw.periodCode || options.periodCode,
      periodLabel: raw.periodLabel || options.periodLabel
    }));
    const errors = [];
    const warnings = [];
    const seen = new Set();

    items.forEach(item => {
      if (item.candidate.code && seen.has(item.candidate.code)) item.errors.push('候选结果中股票代码重复');
      if (item.candidate.code) seen.add(item.candidate.code);
      item.errors.forEach(error => errors.push(`${item.candidate.name || item.candidate.code || '未知候选'}：${error}`));
      item.warnings.forEach(warning => warnings.push(`${item.candidate.name || item.candidate.code || '未知候选'}：${warning}`));
    });

    const declaredCount = Number(raw.batchCandidates);
    if (Number.isFinite(declaredCount) && declaredCount !== raw.candidates.length) {
      errors.push(`batchCandidates=${declaredCount}，但candidates实际为${raw.candidates.length}条`);
    }
    if (raw.scanComplete === true && raw.hasMore === true) errors.push('scanComplete与hasMore状态矛盾');
    if (raw.scanComplete === false && raw.hasMore === false) errors.push('扫描未完成时hasMore不能为false');
    if (raw.scanComplete === false && raw.hasMore === true && !(raw.remainingSectors || []).length) {
      warnings.push('扫描未完成但remainingSectors为空，请核对扫描进度');
    }
    if (raw.scanComplete === true && (raw.remainingSectors || []).length) {
      errors.push('scanComplete为true时remainingSectors应为空');
    }

    return {
      raw,
      periodCode: DB.normalizePeriodCode(raw.periodCode || options.periodCode),
      periodLabel: text(raw.periodLabel || options.periodLabel),
      scanComplete: raw.scanComplete === true,
      hasMore: raw.hasMore === true,
      searchedSectors: uniq(raw.searchedSectors),
      remainingSectors: uniq(raw.remainingSectors),
      candidates: items.map(item => item.candidate),
      items,
      validCandidates: items.filter(item => item.valid && item.errors.length === 0).map(item => item.candidate),
      errors,
      warnings,
      valid: errors.length === 0
    };
  }

  function validateReasonRecord(record, options = {}, kind = 'rejected') {
    const identity = DB.validateStockIdentity(record, options);
    const reason = text(record.reason || record.rejectionReason || record.unverifiedReason)
      || uniq(record.reasons).join('；');
    const errors = [...identity.errors];
    if (!reason) errors.push(kind === 'rejected' ? '缺少淘汰原因' : '缺少无法核验原因');

    const submittedCodes = options.submittedCodes
      ? new Set(options.submittedCodes.map(DB.normalizeCode).filter(Boolean))
      : null;
    if (submittedCodes && !submittedCodes.has(identity.code)) errors.push('股票不在本次提交核验名单中');

    if (kind === 'rejected') {
      const source = DB.inspectSourceUrl(record.sourceUrl, record.sourceType);
      if (!source.official) errors.push(source.reason || '淘汰结果缺少正式公告来源');
    }
    return {
      valid: errors.length === 0,
      code: identity.code,
      name: identity.name,
      reason,
      raw: record,
      errors
    };
  }

  function parseVerificationResponse(input, options = {}) {
    const raw = typeof input === 'string' ? parseJsonText(input) : clone(input);
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('正式核验结果必须是JSON对象');

    const verifiedRaw = Array.isArray(raw.verifiedStocks) ? raw.verifiedStocks : [];
    const rejectedRaw = Array.isArray(raw.rejectedStocks) ? raw.rejectedStocks : [];
    const unverifiedRaw = Array.isArray(raw.unverifiedStocks) ? raw.unverifiedStocks : [];
    if (!Array.isArray(raw.verifiedStocks) && !Array.isArray(raw.rejectedStocks) && !Array.isArray(raw.unverifiedStocks)) {
      throw new Error('正式核验结果缺少verifiedStocks、rejectedStocks和unverifiedStocks数组');
    }

    const periodCode = DB.normalizePeriodCode(raw.periodCode || options.periodCode);
    const submittedCodes = uniq(options.submittedCodes || raw.submittedCodes).map(DB.normalizeCode);
    const validationOptions = {
      ...options,
      periodCode,
      periodLabel: raw.periodLabel || options.periodLabel,
      periodRange: raw.periodRange || options.periodRange,
      submittedCodes: submittedCodes.length ? submittedCodes : undefined
    };

    const verifiedItems = verifiedRaw.map(stock => DB.validateFormalStock(stock, validationOptions));
    const rejectedItems = rejectedRaw.map(stock => validateReasonRecord(stock, validationOptions, 'rejected'));
    const unverifiedItems = unverifiedRaw.map(stock => validateReasonRecord(stock, validationOptions, 'unverified'));
    const allItems = [
      ...verifiedItems.map(item => ({ group: 'verified', code: item.code, name: item.name, errors: item.errors })),
      ...rejectedItems.map(item => ({ group: 'rejected', code: item.code, name: item.name, errors: item.errors })),
      ...unverifiedItems.map(item => ({ group: 'unverified', code: item.code, name: item.name, errors: item.errors }))
    ];
    const errors = [];
    const warnings = [];
    const seen = new Map();

    allItems.forEach(item => {
      if (item.code && seen.has(item.code)) {
        errors.push(`${item.name || item.code}同时出现在${seen.get(item.code)}和${item.group}结果中`);
      } else if (item.code) {
        seen.set(item.code, item.group);
      }
      item.errors.forEach(error => errors.push(`${item.name || item.code || '未知记录'}：${error}`));
    });

    const actualCount = verifiedRaw.length + rejectedRaw.length + unverifiedRaw.length;
    const declaredSubmitted = Number(raw.submittedCount);
    const declaredVerified = Number(raw.verifiedCount);
    const declaredRejected = Number(raw.rejectedCount);
    const declaredUnverified = Number(raw.unverifiedCount);

    if (Number.isFinite(declaredSubmitted) && declaredSubmitted !== actualCount) {
      errors.push(`submittedCount=${declaredSubmitted}，但三组结果合计为${actualCount}`);
    }
    if (Number.isFinite(declaredVerified) && declaredVerified !== verifiedRaw.length) {
      errors.push(`verifiedCount=${declaredVerified}，但verifiedStocks实际为${verifiedRaw.length}条`);
    }
    if (Number.isFinite(declaredRejected) && declaredRejected !== rejectedRaw.length) {
      errors.push(`rejectedCount=${declaredRejected}，但rejectedStocks实际为${rejectedRaw.length}条`);
    }
    if (Number.isFinite(declaredUnverified) && declaredUnverified !== unverifiedRaw.length) {
      errors.push(`unverifiedCount=${declaredUnverified}，但unverifiedStocks实际为${unverifiedRaw.length}条`);
    }

    if (submittedCodes.length) {
      const resultCodes = new Set(allItems.map(item => item.code).filter(Boolean));
      submittedCodes.forEach(code => {
        if (!resultCodes.has(code)) errors.push(`本次提交的${code}未出现在任何核验结果数组中`);
      });
      resultCodes.forEach(code => {
        if (!submittedCodes.includes(code)) errors.push(`核验结果包含未提交的股票${code}`);
      });
      if (actualCount !== submittedCodes.length) {
        errors.push(`本次提交${submittedCodes.length}家公司，但核验结果合计${actualCount}家`);
      }
    } else {
      warnings.push('未提供submittedCodes，无法执行提交名单完整性校验');
    }

    return {
      raw,
      periodCode,
      periodLabel: text(raw.periodLabel || options.periodLabel),
      submittedCodes,
      verifiedItems,
      rejectedItems,
      unverifiedItems,
      verifiedStocks: verifiedItems.filter(item => item.valid).map(item => item.stock),
      errors,
      warnings,
      valid: errors.length === 0,
      counts: {
        submitted: actualCount,
        verified: verifiedRaw.length,
        rejected: rejectedRaw.length,
        unverified: unverifiedRaw.length
      }
    };
  }

  function parseLegacyStocksResponse(input, options = {}) {
    let raw = typeof input === 'string' ? parseJsonText(input) : clone(input);
    if (Array.isArray(raw)) {
      raw = {
        periodCode: options.periodCode,
        periodLabel: options.periodLabel,
        stocks: raw
      };
    }
    if (!Array.isArray(raw?.stocks)) throw new Error('JSON中缺少stocks数组');
    return raw;
  }

  function upsertCandidates(workflow, candidates, context = {}) {
    const normalized = normalizeWorkflow(workflow);
    const map = new Map(normalized.candidates.map(candidate => [candidate.id, candidate]));
    const result = { added: 0, updated: 0, skipped: 0, errors: [] };

    candidates.forEach(raw => {
      const validation = validateCandidate(raw, context);
      if (!validation.valid) {
        result.skipped += 1;
        result.errors.push(`${validation.candidate.name || validation.candidate.code || '未知候选'}：${validation.errors.join('、')}`);
        return;
      }

      const incoming = validation.candidate;
      const existing = map.get(incoming.id);
      if (!existing) {
        map.set(incoming.id, incoming);
        result.added += 1;
        return;
      }

      map.set(incoming.id, {
        ...existing,
        name: incoming.name || existing.name,
        sector: incoming.sector || existing.sector,
        tags: uniq([...(existing.tags || []), ...(incoming.tags || [])]),
        candidateReason: incoming.candidateReason || existing.candidateReason,
        dataBasis: incoming.dataBasis || existing.dataBasis,
        discoverySourceName: incoming.discoverySourceName || existing.discoverySourceName,
        discoverySourceUrl: incoming.discoverySourceUrl || existing.discoverySourceUrl,
        discoveredBy: uniq([...(existing.discoveredBy || []), ...(incoming.discoveredBy || [])]),
        updatedAt: now()
      });
      result.updated += 1;
    });

    normalized.candidates = [...map.values()];
    normalized.updatedAt = now();
    return { workflow: normalizeWorkflow(normalized), result };
  }

  function nextVerificationBatch(workflow, options = {}) {
    const normalized = normalizeWorkflow(workflow);
    const batchSize = Math.min(8, Math.max(5, Number(options.batchSize) || normalized.settings.verificationBatchSize));
    const periodCode = DB.normalizePeriodCode(options.periodCode);
    return normalized.candidates
      .filter(candidate => candidate.status === 'pending')
      .filter(candidate => !periodCode || candidate.periodCode === periodCode)
      .sort((a, b) => a.discoveredAt.localeCompare(b.discoveredAt))
      .slice(0, batchSize);
  }

  window.TechStockWorkflow = {
    STORAGE_KEY,
    load,
    save,
    reset,
    normalizeWorkflow,
    normalizeCandidate,
    stripWrappers,
    extractBalancedJson,
    parseJsonText,
    parseDiscoveryResponse,
    parseVerificationResponse,
    parseLegacyStocksResponse,
    validateCandidate,
    upsertCandidates,
    nextVerificationBatch
  };

  if (channel) {
    channel.addEventListener('message', event => {
      if (event.data?.type === 'workflow-updated') {
        window.dispatchEvent(new CustomEvent('techstock:workflow-external-update', { detail: event.data }));
      }
    });
  }
})();
