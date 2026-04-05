# SDK v3.0 Breaking Change Notice

---

## 1. 中文版（专业友好）

> **Hive SDK v3.0 变更通知**
> 发布日期：2026-04-04 | 迁移宽限期：90 天（截至 2026-07-03）

各位开发者，

Hive SDK v3.0 已正式发布。本次为**不兼容版本升级（Breaking Change）**，涉及认证机制、响应格式和分页方式三个核心模块的变更。我们提供 **90 天迁移宽限期**，期间 v2 接口继续可用，但不再接受新功能。

### 1.1 认证方式：API Key → OAuth 2.0 Bearer Token

| 项目 | v2.x | v3.0 |
|------|------|------|
| 请求头 | `X-API-Key: {key}` | `Authorization: Bearer {access_token}` |
| 获取方式 | 控制台直接生成 | OAuth 2.0 客户端凭据授权 |
| 令牌有效期 | 无（长期有效） | access_token 1 小时，支持 refresh_token |

迁移要点：
- 请在控制台创建 OAuth 2.0 客户端凭据（Client Credentials）
- access_token 默认有效期 1 小时，过期后使用 refresh_token 换取新令牌
- 旧版 API Key 将在宽限期结束后停止服务，请尽早完成迁移
- 宽限期内两种认证方式可并行使用

### 1.2 ��应格式：统一成功与错误结构

**v2.x 旧格式（即将废弃）：**

```json
{
  "data": { ... },
  "error": "something went wrong"
}
```

**v3.0 新格式：**

成功响应：

```json
{
  "data": { ... },
  "meta": {
    "requestId": "req_a1b2c3",
    "timestamp": "2026-04-04T12:00:00Z"
  }
}
```

错误响应：

```json
{
  "error": {
    "code": "UNAUTHORIZED",
    "message": "Invalid or expired access token."
  }
}
```

迁移要点：
- 成功响应中 `error` 字段移除，新增 `meta` 字段携带请求元信息
- 错误响应中 `error` 从字符串变为结构化对象，包含 `code` 和 `message`
- 所有响应均包含 HTTP 状态码，错误码列表请参考更新后的 API 文档

### 1.3 分页方式：offset → cursor

**v2.x 旧方式：**

```json
GET /api/v2/resources?offset=20&limit=10
```

**v3.0 新方式：**

```json
GET /api/v3/resources?cursor=eyJpZCI6MjB9&limit=10
```

响应体：

```json
{
  "data": [...],
  "meta": {
    "requestId": "req_xxx",
    "timestamp": "2026-04-04T12:00:00Z"
  },
  "pagination": {
    "nextCursor": "eyJpZCI6MzB9",
    "hasMore": true
  }
}
```

迁移要点：
- 使用游标（cursor）替代偏移量（offset），提升大数据集分页性能
- cursor 为服务端返回 opaque 字符串，客户端不可解析，直接透传即可
- 首页请求不传 cursor 参数，后续页使用上一次响应中的 `nextCursor`

---

## 2. English Version (Standard Changelog)

> **Hive SDK v3.0 Breaking Changes**
> Release Date: 2026-04-04 | Migration Grace Period: 90 days (until 2026-07-03)

### BREAKING CHANGES

#### Authentication: API Key → OAuth 2.0 Bearer Token

- **Removed**: `X-API-Key` header authentication
- **Added**: `Authorization: Bearer {access_token}` (OAuth 2.0 Client Credentials flow)
- Access tokens expire after 1 hour; use refresh tokens to obtain new ones
- Legacy API keys will be disabled after the grace period ends on 2026-07-03
- Both methods are accepted during the 90-day migration window

#### Response Format: Unified Success/Error Structure

- **Removed**: Top-level `error` string field from successful responses
- **Added**: `meta` object on success: `{ requestId, timestamp }`
- **Changed**: `error` field is now a structured object: `{ code, message }` instead of a plain string
- Error responses no longer include a `data` field
- All error codes are documented in the updated API reference

Before (v2.x):

```json
{ "data": {...}, "error": null }
```

After (v3.0):

```json
{ "data": {...}, "meta": { "requestId": "req_xxx", "timestamp": "..." } }
```

#### Pagination: offset → cursor

- **Removed**: `offset` query parameter
- **Added**: `cursor` query parameter (opaque server-generated token)
- **Added**: `pagination` object in response: `{ nextCursor, hasMore }`
- First page: omit `cursor`; subsequent pages: pass `nextCursor` from previous response
- This change ensures consistent results on large and frequently updated datasets

---

## 3. Migration Code Examples (v2 → v3, TypeScript)

### 3.1 Authentication Migration

```typescript
// --- v2.x ---
import { HiveClient } from 'hive-sdk';

const client = new HiveClient({
  apiKey: process.env.HIVE_API_KEY!,
  baseUrl: 'https://api.hive.dev/v2',
});

// --- v3.0 ---
import { HiveClient } from 'hive-sdk';

const client = new HiveClient({
  oauth: {
    clientId: process.env.HIVE_CLIENT_ID!,
    clientSecret: process.env.HIVE_CLIENT_SECRET!,
    tokenUrl: 'https://auth.hive.dev/oauth2/token',
  },
  baseUrl: 'https://api.hive.dev/v3',
});
```

### 3.2 Response Handling Migration

```typescript
// --- v2.x ---
interface V2Response<T> {
  data: T | null;
  error: string | null;
}

async function fetchResourceV2(): Promise<void> {
  const res: V2Response<{ id: string }> = await client.get('/resources/123');
  if (res.error) {
    console.error('Error:', res.error);
    return;
  }
  console.log('Data:', res.data);
}

// --- v3.0 ---
interface V3Response<T> {
  data: T;
  meta: { requestId: string; timestamp: string };
}

interface V3Error {
  error: { code: string; message: string };
}

async function fetchResourceV3(): Promise<void> {
  try {
    const res: V3Response<{ id: string }> = await client.get('/resources/123');
    console.log('Data:', res.data);
    console.log('Meta:', res.meta);
  } catch (err) {
    const apiErr = err as V3Error;
    console.error(`[${apiErr.error.code}] ${apiErr.error.message}`);
  }
}
```

### 3.3 Pagination Migration

```typescript
// --- v2.x offset-based ---
async function listAllV2(): Promise<void> {
  const limit = 50;
  let offset = 0;
  let hasMore = true;

  while (hasMore) {
    const res = await client.get('/resources', { offset, limit });
    console.log('Page items:', res.data);
    hasMore = res.data.length === limit;
    offset += limit;
  }
}

// --- v3.0 cursor-based ---
async function listAllV3(): Promise<void> {
  const limit = 50;
  let cursor: string | undefined;

  while (true) {
    const res = await client.get('/resources', { cursor, limit });
    console.log('Page items:', res.data);

    if (!res.pagination.hasMore) break;
    cursor = res.pagination.nextCursor;
  }
}
```

### 3.4 Complete Migration Wrapper

```typescript
type V3Result<T> =
  | { ok: true; data: T; meta: { requestId: string; timestamp: string } }
  | { ok: false; error: { code: string; message: string } };

async function v3Request<T>(
  client: HiveClient,
  path: string,
  params?: Record<string, unknown>,
): Promise<V3Result<T>> {
  try {
    const res = await client.get(path, params);
    return { ok: true, data: res.data, meta: res.meta };
  } catch (err: unknown) {
    const apiErr = (err as { error?: { code: string; message: string } }).error;
    return {
      ok: false,
      error: apiErr ?? { code: 'UNKNOWN', message: String(err) },
    };
  }
}

// Usage
const result = await v3Request<{ id: string }>(client, '/resources/123');
if (result.ok) {
  console.log('Success:', result.data, result.meta);
} else {
  console.error(`Error [${result.error.code}]: ${result.error.message}`);
}
```

---

## 4. Terminology Glossary (术语对照表)

| English | 中文 | 说明 |
|---------|------|------|
| API Key | API 密钥 | v2.x 使用的一种静态认证凭据 |
| OAuth 2.0 | OAuth 2.0 授权框架 | v3.0 采用的标准化认证协议 |
| Bearer Token | Bearer 令牌 | 放在 Authorization 头中的访问令牌 |
| Access Token | 访问令牌 | 用于 API 调用的短期凭据，有效期 1 小时 |
| Refresh Token | 刷新令牌 | 用于获取新访问令牌的长期凭据 |
| Client Credentials | 客户端凭据 | OAuth 2.0 中用于服务间认证的授权类型 |
| Breaking Change | 不兼容变更 / 重大变更 | 不向后兼容的接口修改 |
| Grace Period | 宽限期 | v2/v3 可并行的迁移过渡期（90 天） |
| Migration | 迁移 | 从旧版本接口升级到新版本的过程 |
| Response Format | 响应格式 | API 返回数据的结构规范 |
| Meta | 元信息 | v3.0 成功响应中的请求追踪信息 |
| Error Code | 错误码 | v3.0 错误响应中的结构化错误标识 |
| Pagination | 分页 | 大数据集分批返回的机制 |
| Offset | 偏移量 | v2.x 分页方式，基于数值跳过 |
| Cursor | 游标 | v3.0 分页方式，基于服务端令牌定位 |
| Next Cursor | 下一页游标 | 指向下一页数据的服务端令牌 |
| Has More | 是否有更多 | 标识是否还有下一页数据 |
| Request ID | 请求标识 | 每次请求的唯一追踪 ID |
| Endpoint | 端点 | API 的访问路径 |
| Deprecation | 弃用 | 标记旧接口将在未来版本中移除 |
| Opaque Token | 不可解析令牌 | cursor 类令牌，客户端不应尝试解析其内容 |
