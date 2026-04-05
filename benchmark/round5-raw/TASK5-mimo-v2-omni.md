# TASK5: SDK v3.0 Breaking Change Notice

## 任务完成摘要

完成 SDK v3.0 Breaking Change 通知的中英双语编写，涵盖三大核心变更：

| 变更项 | 旧版 (v2.x) | 新版 (v3.0) | 迁移期限 |
|--------|-------------|-------------|----------|
| 认证 | API Key | OAuth 2.0 Bearer Token | 90天 |
| 响应格式 | `{data, error}` | `{data, meta}` / `{error: {code, message}}` | 立即生效 |
| 分页 | offset-based | cursor-based | 立即生效 |

---

# 中文版：SDK v3.0 破坏性变更通知

## 📢 重要通知：SDK v3.0 即将发布

亲爱的开发者，

我们很高兴地宣布 **SDK v3.0** 即将发布！此次更新带来了多项重大改进，以提升安全性、一致性和性能。请注意，本次更新包含**破坏性变更**，现有集成需要进行调整。

### 🔐 变更一：认证方式升级（API Key → OAuth 2.0 Bearer Token）

**变更原因**：提升安全性，符合行业最佳实践。

**变更内容**：
- 旧版使用静态 API Key 进行认证
- 新版采用 OAuth 2.0 Bearer Token 机制

**迁移期限**：**90 天**（v3.0 发布后 90 天内，两种认证方式并行支持）

**重要时间节点**：
- v3.0 发布日：开始支持 OAuth 2.0 Bearer Token
- 发布后 30 天：API Key 认证将触发弃用警告
- 发布后 90 天：API Key 认证将被完全移除

### 📦 变更二：响应格式标准化

**变更原因**：统一错误处理，提升开发者体验。

**变更内容**：

**旧版格式 (v2.x)**：
```json
// 成功响应
{ "data": {...}, "error": null }

// 错误响应
{ "data": null, "error": "Something went wrong" }
```

**新版格式 (v3.0)**：
```json
// 成功响应
{ "data": {...}, "meta": { "requestId": "...", "timestamp": "..." } }

// 错误响应
{ "error": { "code": "INVALID_REQUEST", "message": "..." } }
```

**核心改进**：
- 错误响应包含结构化错误码，便于程序化处理
- 成功响应新增 `meta` 字段，包含请求追踪信息
- 响应结构更加清晰，不再使用 `null` 占位

### 📄 变更三：分页机制升级（Offset → Cursor）

**变更原因**：提升大数据集查询性能，支持实时数据场景。

**变更内容**：

| 功能 | 旧版 (v2.x) | 新版 (v3.0) |
|------|-------------|-------------|
| 分页参数 | `offset`, `limit` | `cursor`, `limit` |
| 响应字段 | `{data, total, offset}` | `{data, meta: {cursor, hasMore}}` |
| 首次请求 | `?offset=0&limit=20` | `?limit=20` |
| 下一页 | `?offset=20&limit=20` | `?cursor=<next_cursor>&limit=20` |

**迁移注意**：
- `total` 字段不再提供（原因：实时计算开销大）
- 新增 `hasMore` 布尔值指示是否有更多数据
- `cursor` 为不透明字符串，不要尝试解析其内部结构

---

# English Version: SDK v3.0 Breaking Change Notice

## 📢 Important: SDK v3.0 Breaking Changes

We are excited to announce the upcoming release of **SDK v3.0**. This major version includes breaking changes that require migration.

### 🔐 Change 1: Authentication Migration (API Key → OAuth 2.0 Bearer Token)

**Rationale**: Enhanced security and industry standardization.

| Aspect | Details |
|--------|---------|
| Migration Window | 90 days |
| Legacy Support | API Key supported in parallel for 90 days |
| Deprecation Warning | Begins 30 days after v3.0 release |
| Legacy Removal | 90 days after v3.0 release |

### 📦 Change 2: Response Format Standardization

**Rationale**: Consistent error handling and better developer experience.

**Before (v2.x)**:
```json
{ "data": {...}, "error": null }
{ "data": null, "error": "string message" }
```

**After (v3.0)**:
```json
{ "data": {...}, "meta": { "requestId": "...", "timestamp": "..." } }
{ "error": { "code": "ERROR_CODE", "message": "descriptive message" } }
```

**Key Changes**:
- Structured error codes for programmatic handling
- New `meta` field with request tracing information
- Separated success/error response structures

### 📄 Change 3: Pagination Upgrade (Offset → Cursor)

**Rationale**: Better performance for large datasets and real-time data scenarios.

| Aspect | v2.x | v3.0 |
|--------|------|------|
| Parameters | `offset`, `limit` | `cursor`, `limit` |
| Response | `{data, total, offset}` | `{data, meta: {cursor, hasMore}}` |
| First Request | `?offset=0&limit=20` | `?limit=20` |
| Next Page | `?offset=20&limit=20` | `?cursor=<value>&limit=20` |

---

# Migration Guide: TypeScript Code Examples

## 1. 认证迁移 (Authentication Migration)

### Before (v2.x) - API Key

```typescript
import { Client } from '@sdk/v2';

const client = new Client({
  apiKey: process.env.API_KEY
});

const response = await client.users.list();
```

### After (v3.0) - OAuth 2.0 Bearer Token

```typescript
import { Client } from '@sdk/v3';
import { OAuth2Client } from '@sdk/v3/auth';

// Option A: Direct Bearer Token
const client = new Client({
  bearerToken: process.env.ACCESS_TOKEN
});

// Option B: OAuth2 Client (recommended)
const oauth = new OAuth2Client({
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  tokenEndpoint: '/oauth/token'
});

const { accessToken } = await oauth.getToken();
const client = new Client({ bearerToken: accessToken });

const response = await client.users.list();
```

### Token Refresh Helper

```typescript
import { Client, TokenManager } from '@sdk/v3';

const tokenManager = new TokenManager({
  clientId: process.env.CLIENT_ID!,
  clientSecret: process.env.CLIENT_SECRET!,
  refreshInterval: 50 * 60 * 1000 // 50 minutes
});

const client = new Client({
  bearerToken: await tokenManager.getAccessToken()
});

// Token auto-refreshes before expiry
const users = await client.users.list();
```

## 2. 响应格式迁移 (Response Format Migration)

### Before (v2.x)

```typescript
import { Client } from '@sdk/v2';

const client = new Client({ apiKey: 'xxx' });

async function fetchUser(id: string) {
  const response = await client.users.get(id);

  if (response.error) {
    console.error('Error:', response.error);
    return null;
  }

  return response.data;
}
```

### After (v3.0)

```typescript
import { Client, SDKError } from '@sdk/v3';

const client = new Client({ bearerToken: 'xxx' });

async function fetchUser(id: string) {
  try {
    const response = await client.users.get(id);
    // response.data contains user data
    // response.meta contains { requestId, timestamp }
    return response.data;
  } catch (error) {
    if (error instanceof SDKError) {
      console.error(`[${error.code}] ${error.message}`);
      // error.code: e.g., "USER_NOT_FOUND", "INVALID_REQUEST"
      // error.message: descriptive error message
      // error.requestId: for support tickets
    }
    throw error;
  }
}
```

### Response Type Definitions

```typescript
// v3.0 Response Types
interface SuccessResponse<T> {
  data: T;
  meta: {
    requestId: string;
    timestamp: string;
  };
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: Record<string, unknown>;
  };
}
```

## 3. 分页迁移 (Pagination Migration)

### Before (v2.x) - Offset-based

```typescript
import { Client } from '@sdk/v2';

const client = new Client({ apiKey: 'xxx' });

async function fetchAllItems() {
  const allItems: Item[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const response = await client.items.list({ offset, limit });

    if (!response.data || response.data.length === 0) break;

    allItems.push(...response.data);
    offset += limit;

    // Check if we've fetched all
    if (offset >= response.total) break;
  }

  return allItems;
}
```

### After (v3.0) - Cursor-based

```typescript
import { Client } from '@sdk/v3';

const client = new Client({ bearerToken: 'xxx' });

async function fetchAllItems() {
  const allItems: Item[] = [];
  let cursor: string | undefined = undefined;
  const limit = 100;

  while (true) {
    const response = await client.items.list({
      cursor,
      limit
    });

    allItems.push(...response.data);

    if (!response.meta.hasMore) break;
    cursor = response.meta.cursor;
  }

  return allItems;
}

// Generic pagination helper
async function* paginate<T>(
  fetchPage: (cursor?: string) => Promise<{
    data: T[];
    meta: { cursor?: string; hasMore: boolean };
  }>
): AsyncGenerator<T[]> {
  let cursor: string | undefined;

  while (true) {
    const { data, meta } = await fetchPage(cursor);
    yield data;

    if (!meta.hasMore) break;
    cursor = meta.cursor;
  }
}

// Usage
for await (const items of paginate((cursor) =>
  client.items.list({ cursor, limit: 100 })
)) {
  console.log(`Processing ${items.length} items`);
}
```

### Query Parameter Mapping

```typescript
// v2.x → v3.0 parameter adapter
function adaptListParams(v2Params: V2ListParams): V3ListParams {
  const { offset = 0, limit = 20, ...rest } = v2Params;

  if (offset === 0) {
    return { limit, ...rest };
  }

  throw new Error(
    'Offset-based pagination is not supported in v3.0. ' +
    'Use cursor-based pagination instead.'
  );
}
```

---

# 术语对照表 / Bilingual Terminology Glossary

| English | 中文 | 说明 |
|---------|------|------|
| API Key | API 密钥 | 旧版认证凭证 |
| OAuth 2.0 | OAuth 2.0 | 开放授权协议 |
| Bearer Token | 承载令牌 | OAuth 2.0 认证凭证类型 |
| Access Token | 访问令牌 | 用于 API 调用的令牌 |
| Refresh Token | 刷新令牌 | 用于获取新访问令牌 |
| Token Endpoint | 令牌端点 | OAuth 2.0 令牌获取地址 |
| Client ID | 客户端 ID | OAuth 应用标识 |
| Client Secret | 客户端密钥 | OAuth 应用凭证 |
| Response Format | 响应格式 | API 返回数据的结构 |
| Error Code | 错误码 | 结构化错误标识符 |
| Error Message | 错误信息 | 描述性错误文本 |
| Request ID | 请求 ID | 请求追踪标识符 |
| Metadata | 元数据 | 附加请求信息 |
| Pagination | 分页 | 数据分页获取机制 |
| Offset | 偏移量 | v2.x 分页位置参数 |
| Cursor | 游标 | v3.0 分页位置标识 |
| Limit | 限制数 | 每页返回数据条数 |
| Has More | 是否有更多 | 是否存在下一页数据 |
| Breaking Change | 破坏性变更 | 不兼容的 API 变更 |
| Migration | 迁移 | 版本升级适配过程 |
| Deprecation | 弃用 | 标记功能即将移除 |
| Changelog | 变更日志 | 版本变更记录 |
| SDK | SDK / 软件开发工具包 | 供开发者使用的工具库 |
| Async Generator | 异步生成器 | TypeScript 异步迭代器 |

---

# Quick Reference Card

## v2.x → v3.0 迁移清单

- [ ] 替换 `apiKey` 为 `bearerToken`
- [ ] 配置 OAuth 2.0 客户端凭证
- [ ] 更新错误处理：从 `response.error` 改为 `try/catch + SDKError`
- [ ] 更新响应解析：访问 `response.meta` 替代顶层元信息
- [ ] 替换 `offset` 分页为 `cursor` 分页
- [ ] 移除对 `total` 字段的依赖
- [ ] 使用 `hasMore` 判断是否继续分页
- [ ] 运行测试验证迁移

## Support

- Migration Guide: [文档链接]
- API Reference: [API 文档链接]
- Support: support@example.com

---

*Generated: 2026-04-04 | SDK v3.0 Migration Notice*
