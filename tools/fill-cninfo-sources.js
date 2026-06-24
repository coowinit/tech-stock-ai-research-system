const fs = require('fs');
const https = require('https');
const path = require('path');
const vm = require('vm');

const root = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');
const stockListUrl = 'https://www.cninfo.com.cn/new/data/szse_stock.json';
const queryUrl = 'https://www.cninfo.com.cn/new/hisAnnouncement/query';
const staticBase = 'https://static.cninfo.com.cn/';

function request(method, url, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const payload = body ? Buffer.from(body) : null;
    const req = https.request({
      method,
      hostname: target.hostname,
      path: target.pathname + target.search,
      headers: {
        'User-Agent': 'Mozilla/5.0',
        'Referer': 'https://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search',
        ...(payload ? {
          'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
          'Content-Length': payload.length
        } : {}),
        ...headers
      }
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode >= 400) {
          reject(new Error(`${res.statusCode} ${res.statusMessage}: ${text.slice(0, 120)}`));
          return;
        }
        resolve(text);
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const encodeBody = data => new URLSearchParams(data).toString();
const dateFromMs = value => {
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return '';
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
};
const exchangeColumn = code => code.endsWith('.SH') ? 'sse' : code.endsWith('.BJ') ? 'bj' : 'szse';
const plate = code => code.endsWith('.SH') ? 'sh' : code.endsWith('.BJ') ? 'bj' : 'sz';
const categoryForPeriod = period => period.endsWith('A') ? 'category_ndbg_szsh' : 'category_yjdbg_szsh';
const dateRangeForPeriod = period => period.endsWith('A') ? '2026-01-01~2026-06-30' : '2026-04-01~2026-05-15';
const titlePatterns = period => period.endsWith('A')
  ? [/年度报告(?!摘要)/, /年报(?!摘要)/]
  : period.endsWith('Q1')
    ? [/一季度报告/, /第一季度报告/]
    : period.endsWith('H1')
      ? [/半年度报告/]
      : period.endsWith('Q3')
        ? [/三季度报告/, /第三季度报告/]
        : [/报告/];

function loadDB() {
  const context = {
    console,
    URL,
    Blob,
    setTimeout,
    clearTimeout,
    location: { protocol: 'http:', href: 'http://127.0.0.1:8000/' },
    localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
    CustomEvent: class {},
    window: { location: { protocol: 'http:', href: 'http://127.0.0.1:8000/' }, dispatchEvent: () => {}, addEventListener: () => {} },
    document: { createElement: () => ({ click() {}, remove() {}, set href(v) {}, set download(v) {} }), body: { appendChild() {} } },
    FileReader: class {}
  };
  context.window.window = context.window;
  context.window.localStorage = context.localStorage;
  context.window.CustomEvent = context.CustomEvent;
  context.window.URL = URL;
  context.globalThis = context;
  vm.createContext(context);
  for (const file of ['assets/js/default-data.js', 'assets/js/database.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context, { filename: file });
  }
  return {
    DB: context.window.TechStockDB,
    raw: context.window.TechStockDefaultDB
  };
}

function pendingReports(db, DB) {
  const rows = [];
  for (const stock of db.stocks) {
    for (const report of stock.reports || []) {
      const source = DB.inspectSourceUrl(report.sourceUrl, report.sourceType);
      if (report.verificationStatus !== 'verified' || !source.official || !report.announcementDate) {
        rows.push({ stock, report });
      }
    }
  }
  return rows;
}

function chooseAnnouncement(announcements, period) {
  const patterns = titlePatterns(period);
  const clean = value => String(value || '').replace(/<[^>]+>/g, '');
  return (announcements || [])
    .filter(item => item.adjunctType === 'PDF')
    .map(item => ({ ...item, title: clean(item.announcementTitle) }))
    .filter(item => patterns.some(pattern => pattern.test(item.title)))
    .filter(item => !/摘要|英文|取消|更正|修订|公告/.test(item.title) || /一季度报告|第一季度报告|三季度报告|第三季度报告|半年度报告|年度报告/.test(item.title))
    .sort((a, b) => String(a.title).length - String(b.title).length)[0] || null;
}

async function queryAnnouncement(row, orgMap) {
  const code = row.stock.code;
  const bare = code.slice(0, 6);
  const orgId = orgMap.get(bare);
  if (!orgId) return { status: 'missing-org' };
  const body = encodeBody({
    stock: `${bare},${orgId}`,
    searchkey: '',
    plate: plate(code),
    category: categoryForPeriod(row.report.periodCode),
    trade: '',
    column: exchangeColumn(code),
    columnTitle: '历史公告查询',
    pageNum: '1',
    pageSize: '10',
    tabName: 'fulltext',
    sortName: '',
    sortType: '',
    limit: '',
    seDate: dateRangeForPeriod(row.report.periodCode)
  });
  const json = JSON.parse(await request('POST', queryUrl, { body }));
  const announcement = chooseAnnouncement(json.announcements, row.report.periodCode);
  if (!announcement) return { status: 'no-match', total: json.totalAnnouncement || 0 };
  return { status: 'matched', announcement };
}

function updateFiles(db, matched) {
  db.builtInDataVersion = `2026-06-24-cninfo-source-verified-${matched}`;
  db.builtInDataUpdatedAt = new Date().toISOString();
  db.updatedAt = new Date().toISOString();
  const jsonPath = path.join(root, 'data/stocks.json');
  const jsPath = path.join(root, 'assets/js/default-data.js');
  fs.writeFileSync(jsonPath, JSON.stringify(db, null, 2) + '\n', 'utf8');
  fs.writeFileSync(jsPath, `window.TechStockDefaultDB=${JSON.stringify(db)};\n`, 'utf8');
}

(async () => {
  const { DB, raw } = loadDB();
  const db = DB.normalizeDB(raw);
  const stockList = JSON.parse(await request('GET', stockListUrl));
  const orgMap = new Map((stockList.stockList || []).map(item => [item.code, item.orgId]));
  const rows = pendingReports(db, DB).filter(row => ['2025A', '2026Q1'].includes(row.report.periodCode));
  const result = { matched: [], missing: [], errors: [] };

  for (const row of rows) {
    try {
      const found = await queryAnnouncement(row, orgMap);
      if (found.status === 'matched') {
        const url = staticBase + found.announcement.adjunctUrl;
        row.report.sourceName = found.announcement.title;
        row.report.sourceUrl = url;
        row.report.sourceType = 'cninfo';
        row.report.sourceHost = 'static.cninfo.com.cn';
        row.report.announcementDate = dateFromMs(found.announcement.announcementTime) || found.announcement.adjunctUrl.match(/finalpage\/(\d{4}-\d{2}-\d{2})\//)?.[1] || '';
        row.report.verificationStatus = 'verified';
        row.report.verificationNote = '巨潮资讯正式公告来源核验';
        row.report.updatedAt = new Date().toISOString();
        result.matched.push({ name: row.stock.name, code: row.stock.code, periodCode: row.report.periodCode, title: found.announcement.title, url });
      } else {
        result.missing.push({ name: row.stock.name, code: row.stock.code, periodCode: row.report.periodCode, status: found.status, total: found.total || 0 });
      }
    } catch (error) {
      result.errors.push({ name: row.stock.name, code: row.stock.code, periodCode: row.report.periodCode, error: error.message });
    }
    await sleep(180);
  }

  if (!dryRun && result.matched.length) updateFiles(db, result.matched.length);
  fs.writeFileSync(path.join(root, 'data/cninfo-source-verification-result.json'), JSON.stringify(result, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({
    dryRun,
    matched: result.matched.length,
    missing: result.missing.length,
    errors: result.errors.length,
    sampleMatched: result.matched.slice(0, 8),
    sampleMissing: result.missing.slice(0, 8),
    sampleErrors: result.errors.slice(0, 3)
  }, null, 2));
})();
