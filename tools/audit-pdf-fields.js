const fs = require('fs');
const https = require('https');
const path = require('path');
const { PDFParse } = require('pdf-parse');

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const cacheDir = path.join(root, '.cache', 'pdf');
const resultPath = path.join(root, 'data', 'pdf-field-audit-result.json');
const tolerance = {
  amountYi: 0.06,
  percent: 0.08
};

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function request(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, res => {
      if (res.statusCode >= 400) {
        reject(new Error(`${res.statusCode} ${res.statusMessage}`));
        res.resume();
        return;
      }
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

function cacheName(url) {
  const match = String(url).match(/\/([^/]+\.PDF)$/i);
  return match ? match[1] : `${Buffer.from(url).toString('hex').slice(0, 32)}.pdf`;
}

async function getPdf(url) {
  ensureDir(cacheDir);
  const file = path.join(cacheDir, cacheName(url));
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return fs.readFileSync(file);
  const data = await request(url);
  fs.writeFileSync(file, data);
  return data;
}

async function extractText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const data = await parser.getText();
    return data.text || '';
  } finally {
    await parser.destroy();
  }
}

function normalizeText(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/[　 ]+/g, ' ')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function parseNumber(value) {
  const text = String(value || '').replace(/,/g, '').replace(/%/g, '').replace(/[()]/g, '').trim();
  if (!text || text === '-' || text === '--') return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function parseSignedNumber(value) {
  const raw = String(value || '').trim();
  const number = parseNumber(raw);
  if (number === null) return null;
  return /^-/.test(raw) ? -Math.abs(number) : number;
}

function normalizeBrokenNumbers(line) {
  return String(line || '')
    .replace(/-\s+(\d)/g, '-$1')
    .replace(/(\d{1,3}(?:,\d{3})*,\d{2})\s+(\d\.\d+)/g, '$1$2')
    .replace(/(\d{1,3}(?:,\d{3})*\.\d)\s+(\d)\b/g, '$1$2');
}

function numberMatches(line) {
  return Array.from(normalizeBrokenNumbers(line).matchAll(/-?\d{1,3}(?:,\d{3})*(?:\.\d+)?%?|-?\d+(?:\.\d+)?%?/g)).map(match => ({
    value: match[0],
    index: match.index || 0,
    percent: match[0].includes('%')
  }));
}

function numbersFromLine(line) {
  return numberMatches(line).map(match => match.value);
}

function compact(value) {
  return String(value || '').replace(/\s+/g, '');
}

function candidatePenalty(raw, label) {
  let penalty = 0;
  const text = compact(raw);
  if (/扣除非经常性损益|扣非|少数股东|每股|现金流|加权平均|变动原因|调整前|调整后/.test(text)) {
    penalty += 5;
  }
  if (/合并利润表|利润表|本期发生额|上期发生额/.test(text)) penalty += 4;
  if (/亿元|同比|实现/.test(text) && !/（元）|\(元\)|单位：元/.test(text)) {
    penalty += 0.4;
  }
  if (!text.includes(compact(label))) penalty += 10;
  return penalty;
}

function unitMultipliers(raw, token) {
  const text = String(raw || '');
  const nearby = text.slice(token.index, token.index + token.value.length + 16);
  const whole = compact(text.slice(Math.max(0, token.index - 80), token.index + token.value.length + 80));
  const multipliers = new Set();
  if (/亿元|亿/.test(nearby)) multipliers.add(100000000);
  if (/万元|萬元/.test(nearby)) multipliers.add(10000);
  if (/（元）|\(元\)|单位：元|單位：元/.test(whole)) multipliers.add(1);
  if (/单位：千元|單位：千元/.test(whole)) multipliers.add(1000);
  if (/单位：万元|單位：萬元/.test(whole)) multipliers.add(10000);
  if (/单位：亿元|單位：億元/.test(whole)) multipliers.add(100000000);
  [1, 1000, 10000, 100000000].forEach(item => multipliers.add(item));
  return [...multipliers];
}

function amountDistance(actualYi, expectedYi) {
  if (actualYi === null || expectedYi === null || expectedYi === undefined) return 999999;
  return Math.abs(Number(actualYi) - Number(expectedYi));
}

function growthDistance(actual, expected, expectedText, raw) {
  if (/扭亏为盈/.test(expectedText || '')) {
    return actual === null && /扭亏为盈/.test(raw) ? 0 : actual !== null && actual > 0 ? 0.08 : 99;
  }
  if (/亏损收窄/.test(expectedText || '')) {
    const expectedMatch = String(expectedText || '').match(/-?\d+(?:\.\d+)?/);
    const expectedValue = expectedMatch ? Number(expectedMatch[0]) : expected;
    if (actual !== null && Number.isFinite(expectedValue)) return Math.abs(Number(actual) - expectedValue);
    return /亏损收窄/.test(raw) ? 0.08 : 99;
  }
  if (actual === null || expected === null || expected === undefined) return expected === null || expected === undefined ? 0 : 99;
  return Math.abs(Number(actual) - Number(expected));
}

function contextualGrowthValue(raw, token) {
  const value = parseSignedNumber(token.value);
  if (value === null) return null;
  const nearby = String(raw || '').slice(Math.max(0, token.index - 16), token.index + token.value.length + 16);
  if (!String(token.value).startsWith('-') && /下降|减少|降低/.test(nearby)) return -Math.abs(value);
  return value;
}

function metricCandidates(lines, label) {
  const normalizedLabel = compact(label);
  const candidates = [];
  lines.forEach((line, index) => {
    const windows = [
      lines.slice(index, Math.min(lines.length, index + 12)).join(' '),
      lines.slice(Math.max(0, index - 1), Math.min(lines.length, index + 11)).join(' ')
    ];
    windows.forEach(windowText => {
      if (!compact(windowText).includes(normalizedLabel)) return;
      candidates.push({
        raw: normalizeBrokenNumbers(windowText),
        penalty: candidatePenalty(windowText, label)
      });
    });
  });
  return candidates;
}

function parseBestMetric(lines, label, expectedAmountYi, expectedGrowth, expectedGrowthText) {
  let best = {
    amountYuan: null,
    growth: null,
    raw: '',
    score: 999999
  };
  for (const candidate of metricCandidates(lines, label)) {
    const tokens = numberMatches(candidate.raw);
    if (!tokens.length) continue;
    const amountOptions = [];
    const growthOptions = [];
    for (const token of tokens) {
      const value = parseSignedNumber(token.value);
      if (value === null) continue;
      if (token.percent) {
        growthOptions.push({ growth: contextualGrowthValue(candidate.raw, token), token });
        continue;
      }
      for (const multiplier of unitMultipliers(candidate.raw, token)) {
        amountOptions.push({
          amountYuan: value * multiplier,
          amountYi: (value * multiplier) / 100000000,
          token
        });
      }
      if (Math.abs(value) <= 10000) growthOptions.push({ growth: contextualGrowthValue(candidate.raw, token), token });
    }
    if (!amountOptions.length) amountOptions.push({ amountYuan: null, amountYi: null, token: null });
    if (!growthOptions.length) growthOptions.push({ growth: null, token: null });
    for (const amount of amountOptions) {
      for (const growth of growthOptions) {
        const sameToken = amount.token && growth.token && amount.token.index === growth.token.index;
        const labelIndex = compact(candidate.raw).indexOf(compact(label));
        const amountBeforeLabel = amount.token && amount.token.index < labelIndex;
        const growthBeforeAmount = amount.token && growth.token && growth.token.index < amount.token.index;
        const distance = amountDistance(amount.amountYi, expectedAmountYi)
          + growthDistance(growth.growth, expectedGrowth, expectedGrowthText, candidate.raw) / 100
          + candidate.penalty
          + (sameToken ? 0.5 : 0)
          + (amountBeforeLabel ? 0.8 : 0)
          + (growthBeforeAmount ? 0.35 : 0);
        if (distance < best.score) {
          best = {
            amountYuan: amount.amountYuan,
            growth: growth.growth,
            raw: candidate.raw,
            score: distance
          };
        }
      }
    }
  }
  return best;
}

function extractMetrics(text, report) {
  const normalized = normalizeText(text);
  const lines = normalized.split('\n').map(line => line.trim()).filter(Boolean);
  const revenue = parseBestMetric(lines, '营业收入', report.revenue, report.revenueGrowth, '');
  const netProfit = parseBestMetric(
    lines,
    '归属于上市公司股东的净利润',
    report.netProfit,
    report.netProfitGrowth,
    report.netProfitGrowthText
  );
  return {
    revenue,
    netProfit,
    evidence: {
      revenueLine: revenue.raw,
      netProfitLine: netProfit.raw
    }
  };
}

function parseMetricLine(line) {
  const values = numbersFromLine(line);
  if (!values.length) return { amountYuan: null, growth: null, raw: line };
  const growthToken = [...values].reverse().find(value => value.includes('%'));
  const amountToken = values.find(value => !value.includes('%'));
  return {
    amountYuan: parseSignedNumber(amountToken),
    growth: growthToken ? parseSignedNumber(growthToken) : null,
    raw: line
  };
}

function toYi(value) {
  return value === null || value === undefined ? null : value / 100000000;
}

function closeEnough(actual, expected, kind) {
  if (actual === null || actual === undefined || expected === null || expected === undefined) return false;
  const limit = kind === 'percent' ? tolerance.percent : tolerance.amountYi;
  return Math.abs(Number(actual) - Number(expected)) <= limit;
}

function compareMetric(label, parsed, expectedAmountYi, expectedGrowth, expectedGrowthText) {
  const amountYi = toYi(parsed.amountYuan);
  const amountMatched = closeEnough(amountYi, expectedAmountYi, 'amount');
  let growthMatched = false;
  if (/扭亏为盈/.test(expectedGrowthText || '')) {
    growthMatched = parsed.growth === null || parsed.growth > 0 || /扭亏为盈/.test(parsed.raw);
  } else if (/亏损收窄/.test(expectedGrowthText || '')) {
    const expectedMatch = String(expectedGrowthText || '').match(/-?\d+(?:\.\d+)?/);
    const expectedValue = expectedMatch ? Number(expectedMatch[0]) : expectedGrowth;
    growthMatched = Number.isFinite(expectedValue)
      ? closeEnough(parsed.growth, expectedValue, 'percent')
      : /亏损收窄/.test(parsed.raw);
  } else {
    growthMatched = closeEnough(parsed.growth, expectedGrowth, 'percent');
  }
  return {
    label,
    amountYi,
    expectedAmountYi,
    amountMatched,
    growth: parsed.growth,
    expectedGrowth,
    expectedGrowthText: expectedGrowthText || '',
    growthMatched,
    raw: parsed.raw,
    matched: amountMatched && growthMatched
  };
}

function auditReport(stock, report, text) {
  const extracted = extractMetrics(text, report);
  const checks = [
    compareMetric('营业收入', extracted.revenue, report.revenue, report.revenueGrowth, ''),
    compareMetric('归母净利润', extracted.netProfit, report.netProfit, report.netProfitGrowth, report.netProfitGrowthText)
  ];
  const matched = checks.filter(check => check.matched).length;
  const parsed = checks.filter(check => check.amountYi !== null || check.growth !== null).length;
  let status = 'mismatch';
  if (matched === checks.length) status = 'matched';
  else if (matched > 0) status = 'partial';
  else if (parsed === 0) status = 'unparsed';
  return {
    name: stock.name,
    code: stock.code,
    periodCode: report.periodCode,
    sourceUrl: report.sourceUrl,
    status,
    checks,
    evidence: extracted.evidence
  };
}

function updateFiles(db) {
  db.builtInDataVersion = '2026-06-24-pdf-field-audited-v1';
  db.builtInDataUpdatedAt = new Date().toISOString();
  db.updatedAt = new Date().toISOString();
  fs.writeFileSync(path.join(root, 'data', 'stocks.json'), JSON.stringify(db, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(root, 'assets', 'js', 'default-data.js'), `window.TechStockDefaultDB=${JSON.stringify(db)};\n`, 'utf8');
}

(async () => {
  const db = JSON.parse(fs.readFileSync(path.join(root, 'data', 'stocks.json'), 'utf8'));
  const results = [];
  for (const stock of db.stocks) {
    for (const report of stock.reports || []) {
      if (!report.sourceUrl || report.verificationStatus !== 'verified') continue;
      try {
        const buffer = await getPdf(report.sourceUrl);
        const text = await extractText(buffer);
        const audit = auditReport(stock, report, text);
        report.fieldVerificationStatus = audit.status;
        report.fieldVerificationNote = audit.status === 'matched'
          ? 'PDF核心字段与数据库一致'
          : 'PDF核心字段需要复核';
        report.fieldVerifiedAt = new Date().toISOString();
        report.fieldVerification = {
          checks: audit.checks,
          evidence: audit.evidence
        };
        results.push(audit);
      } catch (error) {
        report.fieldVerificationStatus = 'unparsed';
        report.fieldVerificationNote = `PDF解析失败：${error.message}`;
        report.fieldVerifiedAt = new Date().toISOString();
        report.fieldVerification = null;
        results.push({
          name: stock.name,
          code: stock.code,
          periodCode: report.periodCode,
          sourceUrl: report.sourceUrl,
          status: 'unparsed',
          error: error.message
        });
      }
    }
  }
  const summary = results.reduce((map, item) => {
    map[item.status] = (map[item.status] || 0) + 1;
    return map;
  }, {});
  const output = {
    auditedAt: new Date().toISOString(),
    dryRun,
    summary,
    results
  };
  fs.writeFileSync(resultPath, JSON.stringify(output, null, 2) + '\n', 'utf8');
  if (!dryRun) updateFiles(db);
  console.log(JSON.stringify({
    dryRun,
    summary,
    total: results.length,
    samples: results.slice(0, 6).map(item => ({
      name: item.name,
      code: item.code,
      periodCode: item.periodCode,
      status: item.status,
      checks: item.checks?.map(check => ({
        label: check.label,
        amountMatched: check.amountMatched,
        growthMatched: check.growthMatched,
        amountYi: check.amountYi,
        expectedAmountYi: check.expectedAmountYi,
        growth: check.growth,
        expectedGrowth: check.expectedGrowth
      }))
    }))
  }, null, 2));
})();
