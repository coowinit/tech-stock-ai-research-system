# 工作流技术说明

## 改造范围

阶段 1 建设两步 AI 工作流所需的数据层和防错层；当前版本已经把 `screening.html` 改造成“候选发现 / 正式核验 / 候选池与数据管理”三个标签页。

## 新增模块

### `research-workflow.js`

负责：

- AI JSON 清洗；
- 候选发现结果解析；
- 正式核验结果解析；
- 候选池标准化和去重；
- 批次计数校验；
- 提交名单完整性校验；
- 下一批 5—8 家候选选择；
- 工作流 localStorage 保存。
- 三标签页面状态渲染；
- 待补公告来源清单；
- 正式数据库备份状态提示。

## 数据库准入门

`database.js` 新增：

```javascript
TechStockDB.validateFormalStock()
TechStockDB.mergeVerifiedStocks()
TechStockDB.inspectSourceUrl()
TechStockDB.isValidStockCode()
```

`mergeVerifiedStocks()` 是 AI 正式数据的专用入口。

### 拒绝条件

- 名称或代码为空；
- 代码格式错误；
- 688、BJ 或 ST 不符合当前设置；
- 报告期错误；
- `verificationStatus` 不是 `verified`；
- 关键财务字段为空；
- 页面重新计算后不符合财务条件；
- 来源不是正式公告域名；
- 链接包含占位符；
- 公司不在本次提交名单；
- 同批次代码重复。

## 权威替换

旧版本采用“只覆盖非空值”的更新方式。

新正式入口对同一股票、同一报告期执行整条替换：

```javascript
stock.reports[reportIndex] = normalizeReport(verifiedReport)
```

因此正式核验中的 `null` 能清除旧错误值。

## 兼容策略

- 正式数据库键不变；
- 旧数据加载后自动标准化到 `2.1.0`；
- 候选工作流使用全新键，不污染正式数据库；
- `mergePayload()` 暂时保留供旧数据格式兼容；
- 页面主流程已经改为候选发现和正式核验两步，AI 入库操作统一使用 `mergeVerifiedStocks()`。

## 已完成测试

- 4 个原有 JavaScript 文件和新增模块语法检查；
- 默认 80 家公司数据加载；
- 旧设置迁移；
- 带代码围栏和解释文字的 JSON 清洗；
- 正式来源白名单；
- 媒体来源阻断；
- `pending` 状态阻断；
- 错误股票代码阻断；
- 财务条件重新计算；
- 候选条件校验；
- 正式报告 `null` 权威覆盖；
- 正式核验数量和提交名单一致性校验。
- 三标签工作流页面浏览器加载；
- 候选发现解析、入候选池、正式核验入库浏览器验证；
- 移动端 390px 布局无横向溢出。
