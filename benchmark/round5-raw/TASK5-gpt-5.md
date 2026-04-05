# SDK v3.0 Breaking Change Notice

---

## 中文版（变更通知）

### 概述

Hive SDK v3.0 是一次重大版本升级，包含若干破坏性变更。为确保平滑迁移，我们提供了 **90 天过渡期**（从 2026-04-04 至 2026-07-03），期间 v2.x API 仍可使用但会返回 deprecation 警告。

### 破坏性变更详情

#### 1. 认证方式变更

| 版本 | 认证方式 | 请求头 |
|------|----------|--------|
| v2.x | API Key | `X-API-Key: your_api_key` |
| v3.0 | OAuth 2.0 Bearer Token | `Authorization: Bearer <token>` |

**迁移说明**：
- 现有 API Key 可通过 `/v3/auth/exchange` 端点换取 Bearer Token
- Token 有效期为 24 小时，支持自动刷新
- 90 天过渡期内，API Key 仍可正常使用

#### 2. 响应格式变更

**v2.x 格式：**
```json
{
  "data": { ... },
  "error": "error message"
}
```

**v3.0 格式：**
```json
// 成功响应
{
  "data": { ... },
  "meta": {
    "request_id": "req_xxx",
    "timestamp": "2026-04-04T12:00:00Z"
  }
}

// 错误响应
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "The requested resource was not found",
    "details": { ... }
  }
}
```

#### 3. 分页参数变更

| 版本 | 分页方式 | 参数 |
|------|----------|------|
| v2.x | Offset 分页 | `?offset=0&limit=20` |
| v3.0 | Cursor 分页 | `?cursor=eyJpZCI6MTB9&limit=20` |

**优势**：Cursor 分页在数据频繁变更场景下更稳定，避免数据重复或遗漏。

### 迁移代码示例（TypeScript）

```typescript
// ============================================
// v2.x 旧代码（即将废弃）
// ============================================

import { HiveClient } from '@hive/sdk-v2';

const client = new HiveClient({
  apiKey: process.env.HIVE_API_KEY!,
});

// 旧版认证 + Offset 分页
const oldResponse = await client.get('/tasks', {
  headers: { 'X-API-Key': apiKey },
  params: { offset: 0, limit: 20 },
});

// 旧版响应处理
if (oldResponse.error) {
  console.error('Error:', oldResponse.error);
} else {
  console.log('Data:', oldResponse.data);
  const nextOffset = oldResponse.data.length + oldResponse.offset;
}

// ============================================
// v3.0 新代码（推荐）
// ============================================

import { HiveClientV3 } from '@hive/sdk-v3';

const clientV3 = new HiveClientV3({
  baseURL: 'https://api.hive.dev/v3',
});

// 新版认证：获取 Bearer Token
async function authenticate(): Promise<string> {
  const tokenResponse = await fetch('https://api.hive.dev/v3/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'api_key',
      api_key: process.env.HIVE_API_KEY!,
    }),
  });
  const { access_token } = await tokenResponse.json();
  return access_token;
}

// 新版请求：Cursor 分页
async function listTasks(cursor?: string) {
  const token = await authenticate();

  const response = await fetch(
    `https://api.hive.dev/v3/tasks?${cursor ? `cursor=${cursor}&` : ''}limit=20`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  // 新版响应处理
  const result = await response.json();

  if (result.error) {
    // 结构化错误处理
    throw new HiveSDKError(
      result.error.code,
      result.error.message,
      result.error.details
    );
  }

  return {
    data: result.data,
    meta: result.meta,
    nextCursor: result.meta.next_cursor, // Cursor 分页
  };
}

// 分页遍历示例
async function paginateAllTasks() {
  const allTasks = [];
  let cursor: string | undefined;

  do {
    const page = await listTasks(cursor);
    allTasks.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);

  return allTasks;
}

// ============================================
// 兼容层（过渡期内快速迁移）
// ============================================

class HiveSDKCompat {
  private token: string | null = null;
  private tokenExpiry: Date | null = null;

  constructor(private apiKey: string) {}

  private async ensureToken(): Promise<string> {
    if (this.token && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.token;
    }

    const response = await fetch('https://api.hive.dev/v3/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'api_key',
        api_key: this.apiKey,
      }),
    });

    const { access_token, expires_in } = await response.json();
    this.token = access_token;
    this.tokenExpiry = new Date(Date.now() + expires_in * 1000);
    return this.token;
  }

  async request<T>(
    endpoint: string,
    options: { offset?: number; limit?: number } = {}
  ): Promise<{ data: T; hasMore: boolean }> {
    const token = await this.ensureToken();

    // 将 offset 转换为 cursor（简化示例）
    const cursor = options.offset ? btoa(JSON.stringify({ offset: options.offset })) : undefined;

    const response = await fetch(
      `https://api.hive.dev/v3${endpoint}?${cursor ? `cursor=${cursor}&` : ''}limit=${options.limit || 20}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const result = await response.json();

    if (result.error) {
      throw new Error(result.error.message);
    }

    return {
      data: result.data,
      hasMore: !!result.meta.next_cursor,
    };
  }
}
```

---

## English Version (Changelog)

### Overview

Hive SDK v3.0 is a major release containing breaking changes. A **90-day migration period** is provided (from 2026-04-04 to 2026-07-03), during which v2.x APIs remain functional but will return deprecation warnings.

### Breaking Changes

#### 1. Authentication Migration

| Version | Method | Header |
|---------|--------|--------|
| v2.x | API Key | `X-API-Key: your_api_key` |
| v3.0 | OAuth 2.0 Bearer Token | `Authorization: Bearer <token>` |

**Migration Notes:**
- Existing API Keys can be exchanged for Bearer Tokens via `/v3/auth/exchange`
- Tokens expire after 24 hours and support automatic refresh
- API Keys remain valid during the 90-day migration period

#### 2. Response Format Changes

**v2.x Format:**
```json
{
  "data": { ... },
  "error": "error message"
}
```

**v3.0 Format:**
```json
// Success response
{
  "data": { ... },
  "meta": {
    "request_id": "req_xxx",
    "timestamp": "2026-04-04T12:00:00Z"
  }
}

// Error response
{
  "error": {
    "code": "RESOURCE_NOT_FOUND",
    "message": "The requested resource was not found",
    "details": { ... }
  }
}
```

#### 3. Pagination Changes

| Version | Method | Parameters |
|---------|--------|------------|
| v2.x | Offset pagination | `?offset=0&limit=20` |
| v3.0 | Cursor pagination | `?cursor=eyJpZCI6MTB9&limit=20` |

**Benefits:** Cursor pagination is more stable when data changes frequently, preventing duplicates or missing items.

### Migration Code Examples (TypeScript)

```typescript
// ============================================
// v2.x Legacy Code (deprecated)
// ============================================

import { HiveClient } from '@hive/sdk-v2';

const client = new HiveClient({
  apiKey: process.env.HIVE_API_KEY!,
});

// Legacy auth + offset pagination
const oldResponse = await client.get('/tasks', {
  headers: { 'X-API-Key': apiKey },
  params: { offset: 0, limit: 20 },
});

// Legacy response handling
if (oldResponse.error) {
  console.error('Error:', oldResponse.error);
} else {
  console.log('Data:', oldResponse.data);
  const nextOffset = oldResponse.data.length + oldResponse.offset;
}

// ============================================
// v3.0 New Code (recommended)
// ============================================

import { HiveClientV3 } from '@hive/sdk-v3';

const clientV3 = new HiveClientV3({
  baseURL: 'https://api.hive.dev/v3',
});

// New auth: obtain Bearer Token
async function authenticate(): Promise<string> {
  const tokenResponse = await fetch('https://api.hive.dev/v3/auth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'api_key',
      api_key: process.env.HIVE_API_KEY!,
    }),
  });
  const { access_token } = await tokenResponse.json();
  return access_token;
}

// New request: cursor pagination
async function listTasks(cursor?: string) {
  const token = await authenticate();

  const response = await fetch(
    `https://api.hive.dev/v3/tasks?${cursor ? `cursor=${cursor}&` : ''}limit=20`,
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
    }
  );

  // New response handling
  const result = await response.json();

  if (result.error) {
    // Structured error handling
    throw new HiveSDKError(
      result.error.code,
      result.error.message,
      result.error.details
    );
  }

  return {
    data: result.data,
    meta: result.meta,
    nextCursor: result.meta.next_cursor, // Cursor pagination
  };
}

// Pagination example
async function paginateAllTasks() {
  const allTasks = [];
  let cursor: string | undefined;

  do {
    const page = await listTasks(cursor);
    allTasks.push(...page.data);
    cursor = page.nextCursor;
  } while (cursor);

  return allTasks;
}

// ============================================
// Compatibility Layer (quick migration during transition)
// ============================================

class HiveSDKCompat {
  private token: string | null = null;
  private tokenExpiry: Date | null = null;

  constructor(private apiKey: string) {}

  private async ensureToken(): Promise<string> {
    if (this.token && this.tokenExpiry && new Date() < this.tokenExpiry) {
      return this.token;
    }

    const response = await fetch('https://api.hive.dev/v3/auth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'api_key',
        api_key: this.apiKey,
      }),
    });

    const { access_token, expires_in } = await response.json();
    this.token = access_token;
    this.tokenExpiry = new Date(Date.now() + expires_in * 1000);
    return this.token;
  }

  async request<T>(
    endpoint: string,
    options: { offset?: number; limit?: number } = {}
  ): Promise<{ data: T; hasMore: boolean }> {
    const token = await this.ensureToken();

    // Convert offset to cursor (simplified example)
    const cursor = options.offset ? btoa(JSON.stringify({ offset: options.offset })) : undefined;

    const response = await fetch(
      `https://api.hive.dev/v3${endpoint}?${cursor ? `cursor=${cursor}&` : ''}limit=${options.limit || 20}`,
      {
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const result = await response.json();

    if (result.error) {
      throw new Error(result.error.message);
    }

    return {
      data: result.data,
      hasMore: !!result.meta.next_cursor,
    };
  }
}
```

---

## 术语对照表 / Terminology Glossary

| 中文 | English | 说明 / Description |
|------|---------|-------------------|
| API Key | API Key | 旧版认证方式，通过请求头 `X-API-Key` 传递 |
| OAuth 2.0 | OAuth 2.0 | 行业标准授权协议，v3.0 采用 Bearer Token 模式 |
| Bearer Token | Bearer Token | OAuth 2.0 访问令牌，通过 `Authorization` 请求头传递 |
| 偏移分页 | Offset Pagination | 基于偏移量的分页方式，使用 `offset` 和 `limit` 参数 |
| 游标分页 | Cursor Pagination | 基于游标的分页方式，使用 `cursor` 和 `limit` 参数 |
| 破坏性变更 | Breaking Change | 不向后兼容的 API 变更 |
| 迁移期 | Migration Period | 新旧版本共存的过渡期（本例为 90 天） |
| 响应元数据 | Response Metadata | v3.0 新增的 `meta` 字段，包含请求 ID、时间戳等 |
| 结构化错误 | Structured Error | v3.0 错误响应格式，包含 `code`、`message`、`details` |
| 兼容层 | Compatibility Layer | 封装新旧 API 差异的适配代码 |
| 废弃警告 | Deprecation Warning | 提示 API 即将停止支持的警告信息 |
| 访问令牌 | Access Token | OAuth 2.0 流程中用于访问资源的短期凭证 |
| 刷新令牌 | Refresh Token | 用于获取新访问令牌的长期凭证 |
| 请求 ID | Request ID | 唯一标识每次 API 请求的字符串，用于问题排查 |
| 限流 | Rate Limiting | API 调用频率限制，v3.0 在 `meta` 中返回限流信息 |

---

## 时间线 / Timeline

| 日期 | 事件 / Event |
|------|-------------|
| 2026-04-04 | SDK v3.0 发布，90 天迁移期开始 |
| 2026-05-04 | v2.x API 返回 deprecation 警告（迁移期 1/3） |
| 2026-06-03 | 最终提醒（迁移期 2/3） |
| 2026-07-03 | v2.x API 正式停止服务（EOL） |

---

## 支持资源 / Support Resources

- **迁移指南**: https://docs.hive.dev/migration/v3
- **API 参考**: https://docs.hive.dev/api/v3
- **示例代码**: https://github.com/hiveco/sdk-examples
- **技术支持**: support@hive.dev

---

*文档版本: 1.0 | 最后更新: 2026-04-04*

