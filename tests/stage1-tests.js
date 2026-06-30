const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const root = path.resolve(__dirname, '..');
const store = new Map();
const context = {
  console,
  URL,
  Blob,
  setTimeout,
  clearTimeout,
  location: { protocol: 'http:', href: 'http://localhost:8000/' },
  localStorage: {
    getItem: key => store.has(key) ? store.get(key) : null,
    setItem: (key, value) => store.set(key, value),
    removeItem: key => store.delete(key)
  },
  CustomEvent: class CustomEvent { constructor(type, init={}) { this.type=type; this.detail=init.detail; } },
  window: {
    location: { protocol: 'http:', href: 'http://localhost:8000/' },
    dispatchEvent: () => {},
    addEventListener: () => {}
  },
  document: {
    createElement: () => ({ click(){}, remove(){}, set href(v){}, set download(v){} }),
    body: { appendChild(){} }
  },
  FileReader: class {},
};
context.window.window = context.window;
context.window.localStorage = context.localStorage;
context.window.CustomEvent = context.CustomEvent;
context.window.URL = URL;
context.globalThis = context;
vm.createContext(context);
for (const file of ['assets/js/default-data.js','assets/js/database.js','assets/js/research-workflow.js']) {
  vm.runInContext(fs.readFileSync(`${root}/${file}`, 'utf8'), context, { filename: file });
}
const DB = context.window.TechStockDB;
const WF = context.window.TechStockWorkflow;

const db = DB.load();
assert.equal(db.stocks.length, 99, 'default stock count');
assert.equal(db.settings.excludeBSE, true, 'excludeBSE defaults true');
assert.equal(db.schemaVersion, '2.1.0');
const sourceDebt = db.stocks.flatMap(stock => stock.reports.map(report => ({
  report,
  source: DB.inspectSourceUrl(report.sourceUrl, report.sourceType)
}))).filter(item => item.report.verificationStatus !== 'verified' || !item.source.official || !item.report.announcementDate);
assert.equal(sourceDebt.length, 0, 'default data has no pending official source debt');

const parsed = WF.parseJsonText('这里是结果：\n```json\n{"a":1,"b":[2,3]}\n```\n谢谢');
assert.equal(parsed.a, 1, 'extract JSON from prose and fence');

const validStock = {
  name: '测试股份', code: '000001.SZ', sector: 'AI服务器', tags: ['AI'],
  report: {
    periodCode: '2026H1', periodLabel: '2026年半年度报告', periodRange: '2026年1—6月',
    revenue: 100, revenueGrowth: 12, netProfit: 5, netProfitGrowth: null,
    netProfitGrowthText: '扭亏为盈', sourceName: '2026年半年度报告',
    sourceUrl: 'https://static.cninfo.com.cn/finalpage/2026-08-20/test.pdf',
    announcementDate: '2026-08-20', verificationStatus: 'verified',
    fieldVerificationStatus: 'matched',
    fieldVerificationNote: 'PDF字段一致',
    fieldVerifiedAt: '2026-06-24T00:00:00.000Z',
    fieldVerification: { checks: [{ label: 'revenue', matched: true }] }
  }
};
const ok = DB.validateFormalStock(validStock, {periodCode:'2026H1', excludeBSE:true});
assert.equal(ok.valid, true, ok.errors.join(';'));
assert.equal(ok.source.official, true);

const media = JSON.parse(JSON.stringify(validStock));
media.report.sourceUrl = 'https://finance.eastmoney.com/a/test.html';
assert.equal(DB.validateFormalStock(media, {periodCode:'2026H1'}).valid, false, 'media rejected');

const pending = JSON.parse(JSON.stringify(validStock));
pending.report.verificationStatus = 'pending';
assert.equal(DB.validateFormalStock(pending, {periodCode:'2026H1'}).valid, false, 'pending rejected');

const badCode = JSON.parse(JSON.stringify(validStock));
badCode.code = 'example.com';
assert.equal(DB.validateFormalStock(badCode, {periodCode:'2026H1'}).valid, false, 'bad code rejected');

const base = DB.normalizeDB({
  stocks:[{
    name:'测试股份', code:'000001.SZ', reports:[{
      periodCode:'2026H1', periodLabel:'旧报告', revenueGrowth:12, netProfit:5,
      netProfitGrowth:25, netProfitGrowthText:'', sourceName:'旧来源',
      sourceUrl:'https://static.cninfo.com.cn/old.pdf', verificationStatus:'verified'
    }]
  }]
});
const merged = DB.mergeVerifiedStocks(base, {periodCode:'2026H1', stocks:[validStock]}, {periodCode:'2026H1'});
assert.equal(merged.result.reportsUpdated, 1);
const report = merged.db.stocks[0].reports[0];
assert.equal(report.netProfitGrowth, null, 'null authoritatively replaces old value');
assert.equal(report.netProfitGrowthText, '扭亏为盈');
assert.equal(report.fieldVerificationStatus, 'matched', 'field audit status is preserved');
assert.equal(report.fieldVerification.checks.length, 1, 'field audit evidence is preserved');

store.delete(DB.BACKUP_STORAGE_KEY);
const savedForBackup = DB.save(merged.db, 'test-save-backup');
const backupsAfterSave = DB.listBackups();
assert.equal(backupsAfterSave.length, 1, 'save creates local backup snapshot');
assert.equal(backupsAfterSave[0].db.stocks.length, savedForBackup.stocks.length);
const manualBackup = DB.createBackup(db, 'manual');
assert.equal(DB.listBackups().length, 2, 'manual backup is added');
const restoredBackup = DB.restoreBackup(manualBackup.id);
assert.equal(restoredBackup.stocks.length, db.stocks.length, 'restore backup replaces active database');
DB.deleteBackup(manualBackup.id);
assert.equal(DB.listBackups().some(item => item.id === manualBackup.id), false, 'delete backup removes snapshot');


const failedFinancial = JSON.parse(JSON.stringify(validStock));
failedFinancial.report.netProfitGrowth = -5;
failedFinancial.report.netProfitGrowthText = '';
assert.equal(DB.validateFormalStock(failedFinancial, {periodCode:'2026H1'}).valid, false, 'financial failure rejected from verified gate');

const candidateResult = WF.parseDiscoveryResponse({
  taskType:'candidate_discovery', periodCode:'2025A', periodLabel:'2025年年度报告',
  batchCandidates:1, scanComplete:false, hasMore:true, remainingSectors:['高速连接'],
  candidates:[{
    name:'候选股份', code:'300001.SZ', sector:'CPO/高速光模块', tags:['高速光模块'],
    candidateReason:'公开线索显示双增长', reportedRevenueGrowth:18.6,
    reportedNetProfit:5.67, reportedNetProfitPositive:true, reportedNetProfitGrowth:22.3,
    reportedNetProfitGrowthText:'', dataBasis:'performance_flash', sourceType:'financial_media',
    discoverySourceName:'财经线索', discoverySourceUrl:'https://finance.eastmoney.com/a/20250101.html',
    needsOfficialVerification:true
  }]
}, {periodCode:'2025A', revenueGrowthThreshold:8, exclude688:true, excludeBSE:true, excludeST:true});
assert.equal(candidateResult.validCandidates.length, 1, candidateResult.errors.join(';'));
assert.equal(candidateResult.valid, true, candidateResult.errors.join(';'));

const invalidCandidate = WF.parseDiscoveryResponse({
  periodCode:'2025A', batchCandidates:1, scanComplete:false, hasMore:true, remainingSectors:['CPO'],
  candidates:[{
    name:'错误候选', code:'688001.SH', sector:'CPO', candidateReason:'线索',
    reportedRevenueGrowth:null, reportedNetProfit:1, reportedNetProfitGrowth:2,
    dataBasis:'financial_media', sourceType:'financial_media',
    discoverySourceUrl:'https://finance.eastmoney.com/a/test.html', needsOfficialVerification:true
  }]
}, {periodCode:'2025A', exclude688:true});
assert.equal(invalidCandidate.validCandidates.length, 0, '688 and missing revenue evidence blocked');

const verification = WF.parseVerificationResponse({
  periodCode:'2026H1', submittedCount:1, verifiedCount:1, rejectedCount:0, unverifiedCount:0,
  submittedCodes:['000001.SZ'], verifiedStocks:[validStock], rejectedStocks:[], unverifiedStocks:[]
}, {periodCode:'2026H1', submittedCodes:['000001.SZ']});
assert.equal(verification.valid, true, verification.errors.join(';'));
assert.equal(verification.verifiedStocks.length, 1);

const mismatch = WF.parseVerificationResponse({
  periodCode:'2026H1', submittedCount:2, verifiedCount:1, rejectedCount:0, unverifiedCount:0,
  submittedCodes:['000001.SZ','000002.SZ'], verifiedStocks:[validStock], rejectedStocks:[], unverifiedStocks:[]
}, {periodCode:'2026H1', submittedCodes:['000001.SZ','000002.SZ']});
assert.equal(mismatch.valid, false, 'missing submitted company rejected');
assert(mismatch.errors.some(e => e.includes('000002.SZ')));

console.log('All stage-1 tests passed.');

// v1.1.1: stale localStorage must be upgraded from the versioned built-in snapshot.
const stale = DB.clone(db);
stale.builtInDataVersion = '';
stale.stocks[0].reports.find(r => r.periodCode === '2025A').netProfit = null;
stale.stocks[0].reports.find(r => r.periodCode === '2025A').netProfitGrowth = null;
stale.stocks[0].reports.find(r => r.periodCode === '2025A').netProfitGrowthText = '待补归母净利润同比';
stale.stocks.push({
  name:'用户扩展公司', code:'300999.SZ', sector:'测试板块', tags:[], reports:[],
  createdAt:'2026-06-24T00:00:00.000Z', updatedAt:'2026-06-24T00:00:00.000Z'
});
store.set(DB.STORAGE_KEY, JSON.stringify(stale));
const migrated = DB.load();
const migratedReport = DB.getReport(migrated.stocks.find(s => s.code === '000988.SZ'), '2025A');
assert.equal(migratedReport.netProfit, 14.7079470416, 'stale 2025A net profit auto-upgraded');
assert.equal(migratedReport.netProfitGrowth, 20.48, 'stale 2025A growth auto-upgraded');
assert(migrated.stocks.some(s => s.code === '300999.SZ'), 'user-added stock preserved');
assert.equal(migrated.builtInDataVersion, '2026-06-30-physical-ai-core-v3');
console.log('Built-in data migration tests passed.');


// Existing local-only legacy rows receive supplemental reports without being added to clean installs.
const legacyLocal = DB.clone(db);
legacyLocal.builtInDataVersion = '';
legacyLocal.stocks.push({
  name:'鹏鼎控股', code:'002938.SZ', sector:'PCB', tags:['PCB'], reports:[],
  createdAt:'2026-06-23T00:00:00.000Z', updatedAt:'2026-06-23T00:00:00.000Z'
});
legacyLocal.stocks.push({
  name:'富士达', code:'920640.BJ', sector:'高速连接', tags:['连接器'], reports:[],
  createdAt:'2026-06-23T00:00:00.000Z', updatedAt:'2026-06-23T00:00:00.000Z'
});
store.set(DB.STORAGE_KEY, JSON.stringify(legacyLocal));
const legacyMigrated = DB.load();
assert.equal(DB.getReport(legacyMigrated.stocks.find(s => s.code === '002938.SZ'), '2026Q1').netProfitGrowth, -5.21);
assert.equal(DB.getReport(legacyMigrated.stocks.find(s => s.code === '920640.BJ'), '2026Q1').netProfitGrowth, 2.21);
const cleanDefault = DB.normalizeDB(context.window.TechStockDefaultDB);
assert(!cleanDefault.stocks.some(s => s.code === '002938.SZ'), 'supplement does not add local-only stock to clean default');
assert(!cleanDefault.stocks.some(s => s.code === '920640.BJ'), 'BSE supplement does not add stock to clean default');
console.log('Legacy supplemental migration tests passed.');


// v1.2.1: destructive database operations keep a pre-operation rollback snapshot.
store.delete(DB.BACKUP_STORAGE_KEY);
const beforeImportDb = DB.normalizeDB({
  stocks: [{ name: '导入前公司', code: '000001.SZ', reports: [] }],
  builtInDataVersion: 'before-import'
});
store.set(DB.STORAGE_KEY, JSON.stringify(beforeImportDb));
const importedDb = DB.normalizeDB({
  stocks: [{ name: '导入后公司', code: '000002.SZ', reports: [] }],
  builtInDataVersion: 'after-import'
});
DB.save(importedDb, 'screening-import');
const importBackups = DB.listBackups();
assert(importBackups.some(item => item.reason === 'before-screening-import'), 'import keeps pre-operation snapshot');
assert(importBackups.some(item => item.reason === 'screening-import'), 'import keeps resulting snapshot');

// v1.2.1: the dashboard is read-only for database maintenance; management is centralized.
const indexHtml = fs.readFileSync(`${root}/index.html`, 'utf8');
const screeningHtml = fs.readFileSync(`${root}/screening.html`, 'utf8');
assert(!indexHtml.includes('id="exportBtn"'), 'dashboard export button removed');
assert(!indexHtml.includes('id="importBtn"'), 'dashboard import button removed');
assert(!indexHtml.includes('id="resetBtn"'), 'dashboard reset button removed');
assert(!indexHtml.includes('id="syncDefaultBtn"'), 'dashboard built-in sync button removed');
assert(screeningHtml.includes('id="managementTab"'), 'centralized management tab exists');
assert(screeningHtml.includes('id="importWorkflowBtn"'), 'workflow import button exists');
assert(screeningHtml.includes('id="syncDefaultBtn"'), 'built-in sync moved to screening center');
assert(screeningHtml.includes('id="maintenanceSearchInput"'), 'formal data maintenance search exists');
assert(screeningHtml.includes('id="maintenancePeriodSelect"'), 'formal data maintenance period selector exists');
assert(screeningHtml.includes('id="maintenanceList"'), 'formal data maintenance list exists');
assert(!screeningHtml.includes('id="exportBackupsBtn"'), 'snapshot collection export removed');
console.log('Centralized data-management tests passed.');
