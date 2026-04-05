# SDK v3.0 升级公告

> **发布状态**：正式发布（GA）
> **发布时间**：2026-04-04
> **影响版本**：所有 v2.x 客户端
> **迁移窗口**：旧版认证方式将在 **v3.2 发布后的 90 天内** 逐步下线，请尽快完成迁移。

你好，开发者！

SDK v3.0 已经正式发布。这个版本是一次重大升级（Major Release），我们重新梳理了认证机制、响应格式以及分页策略，以提供更一致、更安全、更可扩展的开发体验。

以下内容均为 **Breaking Changes**，请仔细阅读，并参考配套的[迁移指南](./migration-guide.zh.md)完成升级。

---

## 1. 认证方式变更

为了提升安全性并与行业标准对齐，v3.0 全面切换为 **OAuth 2.0 Bearer Token** 认证。

- **废弃**：`headers: { 'X-API-Key': key }`（v2 旧方式）
- **启用**：`headers: { 'Authorization': 'Bearer ' + token }`
- **迁移期**：旧方式继续可用，但将在 **v3.2 发布后的 90 天** 停止支持。

如果你还在使用 `X-API-Key`，请尽快迁移到 Bearer Token，届时未迁移的请求将收到 `401 Unauthorized`。

---

## 2. 响应格式变更

v3.0 对成功响应和错误响应都进行了结构化改造，便于日志追踪和异常处理。

### 成功响应
```json
// v2
{ "data": { ... }, "error": null }

// v3
{ "data": { ... }, "meta": { "requestId": "req_xxx", "timestamp": 171...
}
```

### 错误响应
```json
// v2
{ "data": null, "error": "Something went wrong" }

// v3
{
  "error": {
    "code": "INVALID_CURSOR",
    "message": "The provided cursor is expired or malformed.",
    "details": { "cursor": "abc123" }
  }
}
```

**关键变化**：
- 成功响应中新增了 `meta` 对象，包含 `requestId` 和 `timestamp`。
- 错误响应中 `error` 从字符串升级为对象，包含 `code`、`message` 和可选的 `details`。

---

## 3. 分页 API 变更

v3.0 的分页策略从**偏移分页（offset-based pagination）**升级为**游标分页（cursor-based pagination）**，以支持大规模数据集的高效翻页。

### 请求参数
```
# v2
GET /items?page=1&size=20

# v3
GET /items?cursor=xxx&limit=20
```

### 响应体
```json
// v2
{ "items": [...], "total": 1000, "page": 1 }

// v3
{ "items": [...], "nextCursor": "eyJ...", "hasMore": true }
```

**关键变化**：
- 查询参数由 `page` + `size` 改为 `cursor` + `limit`。
- 响应体不再返回 `total` 和 `page`，改为返回 `nextCursor` 和 `hasMore`。
- 首次请求可省略 `cursor`，或传 `cursor=` 空值。

---

## 下一步

1. 阅读 [SDK v3.0 迁移指南（中文）](./migration-guide.zh.md) 获取完整代码示例。
2. 下载最新版 SDK：`npm install our-sdk@^3.0.0`
3. 如果在迁移中遇到问题，请在 GitHub Discussions 中与我们联系，我们会尽力协助。

感谢你的理解与支持！
