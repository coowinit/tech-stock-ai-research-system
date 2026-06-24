# 数据结构说明

## 一、正式数据库

### localStorage 键

```text
tech-stock-research-database-v2
```

保留原键名，现有浏览器数据可以直接升级。

### 根结构

```json
{
  "schemaVersion": "2.1.0",
  "settings": {
    "revenueGrowthThreshold": 8,
    "requirePositiveNetProfit": true,
    "requirePositiveNetProfitGrowth": true,
    "exclude688": true,
    "excludeST": true,
    "excludeBSE": true,
    "verifiedGateEnabled": true
  },
  "stocks": []
}
```

### 公司结构

```json
{
  "name": "示例公司",
  "code": "000001.SZ",
  "sector": "AI服务器",
  "tags": ["AI服务器", "算力基础设施"],
  "watchStatus": "normal",
  "notes": "",
  "reports": []
}
```

### 正式报告结构

```json
{
  "periodCode": "2026H1",
  "periodLabel": "2026年半年度报告",
  "periodRange": "2026年1—6月",
  "revenue": 123.45,
  "revenueGrowth": 18.6,
  "netProfit": 5.67,
  "netProfitPositive": true,
  "netProfitGrowth": 22.3,
  "netProfitGrowthText": "",
  "deductNetProfit": 5.21,
  "operatingCashFlow": 6.78,
  "sourceName": "示例公司2026年半年度报告",
  "sourceUrl": "https://static.cninfo.com.cn/finalpage/2026-08-20/actual-report.pdf",
  "sourceType": "cninfo",
  "sourceHost": "static.cninfo.com.cn",
  "sourceConfirmedByUser": false,
  "announcementDate": "2026-08-20",
  "verificationStatus": "verified",
  "verificationNote": "",
  "updatedAt": "2026-08-20T12:00:00.000Z"
}
```

金额统一为亿元，同比字段为纯数字。

### 扭亏为盈

```json
{
  "netProfitGrowth": null,
  "netProfitGrowthText": "扭亏为盈"
}
```

正式核验更新允许 `null` 覆盖旧数据。

### 核验状态

- `verified`：已经通过正式来源和页面规则校验；
- `pending`：历史整理数据或仍待确认；
- `conflict`：来源之间存在冲突。

`screening.html` 的正式入口只允许 `verified` 数据写入。

---

## 二、AI 工作流数据库

### localStorage 键

```text
tech-stock-research-workflow-v1
```

### 根结构

```json
{
  "schemaVersion": "1.0.0",
  "settings": {
    "verificationBatchSize": 6
  },
  "candidates": [],
  "discoveryBatches": [],
  "verificationBatches": [],
  "updatedAt": "2026-06-24T00:00:00.000Z"
}
```

### 候选结构

候选唯一键：

```text
报告期代码|股票代码
```

示例：

```json
{
  "id": "2025A|300001.SZ",
  "periodCode": "2025A",
  "periodLabel": "2025年年度报告",
  "name": "示例公司",
  "code": "300001.SZ",
  "sector": "CPO/高速光模块",
  "tags": ["高速光模块"],
  "candidateReason": "公开线索显示营收和归母净利润双增长",
  "reportedRevenueGrowth": 18.6,
  "reportedRevenueGrowthMin": null,
  "reportedRevenueGrowthMax": null,
  "reportedNetProfit": 5.67,
  "reportedNetProfitMin": null,
  "reportedNetProfitMax": null,
  "reportedNetProfitPositive": true,
  "reportedNetProfitGrowth": 22.3,
  "reportedNetProfitGrowthMin": null,
  "reportedNetProfitGrowthMax": null,
  "reportedNetProfitGrowthText": "",
  "dataBasis": "performance_flash",
  "sourceType": "financial_media",
  "discoverySourceName": "线索名称",
  "discoverySourceUrl": "https://finance.example.com/article",
  "needsOfficialVerification": true,
  "discoveredBy": ["DeepSeek"],
  "status": "pending",
  "verificationAttempts": 0,
  "rejectionReason": "",
  "unverifiedReason": ""
}
```

### 候选状态

- `pending`：等待正式核验；
- `verifying`：已经进入当前核验批次；
- `verified`：正式核验通过；
- `rejected`：正式数据不满足条件；
- `unverified`：无法找到或打开正式报告。

候选线索允许使用财经媒体，但不能因此进入正式数据库。

---

## 三、正式核验响应

```json
{
  "taskType": "official_verification",
  "periodCode": "2025A",
  "periodLabel": "2025年年度报告",
  "submittedCount": 6,
  "verifiedCount": 3,
  "rejectedCount": 2,
  "unverifiedCount": 1,
  "verifiedStocks": [],
  "rejectedStocks": [],
  "unverifiedStocks": []
}
```

必须满足：

```text
submittedCount
= verifiedCount + rejectedCount + unverifiedCount
= 本次提交候选数量
```

同一股票不能同时出现在多个结果数组中，也不能返回本次未提交的公司。

---

## 四、正式来源规则

自动认可：

- `cninfo.com.cn` 及其子域名；
- `sse.com.cn` 及其子域名；
- `szse.cn` 及其子域名；
- `bse.cn` 及其子域名。

不能自动认可：

- 东方财富、同花顺、雪球、证券时报等财经媒体；
- 搜索结果页面；
- 短网址；
- 未知域名；
- 包含 `xxxx`、`示例`、`公告链接` 等占位内容的网址；
- 未经人工确认的上市公司官网链接。

浏览器纯前端环境只能检查 URL 格式和域名，不能保证远端文件真实存在，因此最终仍应人工打开来源复核。
