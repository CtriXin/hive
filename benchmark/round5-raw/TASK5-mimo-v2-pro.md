# SDK v3.0 Breaking Change Notice

---

## 📋 中文版变更通知

### SDK v3.0 重大变更说明

尊敬的开发者：

感谢您一直以来对本 SDK 的支持。为了提升 API 的安全性、可扩展性和国际化能力，v3.0 版本引入以下重大变更。请您仔细阅读并参照迁移指南完成升级。

---

### 变更一：认证方式升级（迁移期 90 天）

**旧版本**：API Key
```
Authorization: Api-Key sk-xxxxxxxxxxxx
```

**新版本**：OAuth 2.0 Bearer Token
```
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

**迁移时间线**：
| 阶段 | 时间 | 说明 |
|------|------|------|
| 并行期 | 第 1-60 天 | 两种认证方式均可使用 |
| 告警期 | 第 61-90 天 | API Key 方式返回 Deprecation 警告 |
| 停用期 | 第 91 天起 | 仅支持 OAuth 2.0 |

---

### 变更二：响应格式重构

**旧版本**：
```json
{
  "data": { ... },
  "error": null
}
```

**新版本**：成功响应 → `{ data, meta }`
```json
{
  "data": { ... },
  "meta": {
    "requestId": "req_abc123",
    "timestamp": "2026-04-04T12:00:00Z",
    "cursor": "cursor_xyz"
  }
}
```

失败响应 → `{ error: { code, message } }`
```json
{
  "error": {
    "code": "INVALID_TOKEN",
    "message": "The provided token has expired."
  }
}
```

---

### 变更三：分页机制替换

**旧版本**：Offset 分页
```
GET /items?page=2&per_page=20
```

**新版本**：Cursor 分页
```
GET /items?cursor=cursor_xyz&limit=20
```

---

### 迁移截止日期

**2026-07-03**（90 天后停止对 v2.x 的支持）

如有疑问，请联系 support@yourcompany.com。

---

## 📝 English Changelog

### SDK v3.0 — Breaking Changes

**Release Date**: 2026-04-04
**Migration Deadline**: 2026-07-03 (90 days)

---

#### 1. Authentication: API Key → OAuth 2.0 Bearer Token

**Before:**
```
Authorization: Api-Key sk-xxxxxxxxxxxx
```

**After:**
```
Authorization: Bearer eyJhbGciOiJSUzI1NiIs...
```

**Migration Timeline:**
| Phase | Duration | Behavior |
|-------|----------|----------|
| Parallel | Day 1–60 | Both methods accepted |
| Warning | Day 61–90 | API Key returns Deprecation warning header |
| Deprecation | Day 91+ | OAuth 2.0 only |

---

#### 2. Response Format Restructure

**Before:**
```json
{
  "data": { ... },
  "error": null
}
```

**After — Success:**
```json
{
  "data": { ... },
  "meta": {
    "requestId": "req_abc123",
    "timestamp": "2026-04-04T12:00:00Z",
    "cursor": "cursor_xyz"
  }
}
```

**After — Error:**
```json
{
  "error": {
    "code": "INVALID_TOKEN",
    "message": "The provided token has expired."
  }
}
```

---

#### 3. Pagination: Offset → Cursor

**Before:**
```
GET /items?page=2&per_page=20
```

**After:**
```
GET /items?cursor=cursor_xyz&limit=20
```

---

## 💻 Migration Code Examples (TypeScript)

### 1. Authentication Migration

```typescript
// Before — API Key
const oldHeaders = {
  'Authorization': `Api-Key ${process.env.API_KEY}`,
  'Content-Type': 'application/json'
};

// After — OAuth 2.0 Bearer Token
async function getAccessToken(): Promise<string> {
  const res = await fetch('https://auth.example.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.CLIENT_ID!,
      client_secret: process.env.CLIENT_SECRET!,
      scope: 'read write'
    })
  });
  const data = await res.json();
  return data.access_token;
}

const newHeaders = {
  'Authorization': `Bearer ${await getAccessToken()}`,
  'Content-Type': 'application/json'
};
```

### 2. Response Handling Migration

```typescript
// Before
interface OldResponse<T> {
  data: T | null;
  error: string | null;
}

function handleOld(res: OldResponse<User>) {
  if (res.error) throw new Error(res.error);
  return res.data;
}

// After
interface SuccessResponse<T> {
  data: T;
  meta: {
    requestId: string;
    timestamp: string;
    cursor?: string;
  };
}

interface ErrorResponse {
  error: {
    code: string;
    message: string;
  };
}

type NewResponse<T> = SuccessResponse<T> | ErrorResponse;

function isNewError<T>(res: NewResponse<T>): res is ErrorResponse {
  return 'error' in res;
}

function handleNew(res: NewResponse<User>) {
  if (isNewError(res)) {
    throw new Error(`[${res.error.code}] ${res.error.message}`);
  }
  return res.data;
}
```

### 3. Pagination Migration

```typescript
// Before — Offset pagination
interface OldPaginationParams {
  page: number;
  per_page: number;
}

async function fetchOldPage(params: OldPaginationParams) {
  const url = `/items?page=${params.page}&per_page=${params.per_page}`;
  return fetch(url).then(r => r.json());
}

// Usage
for (let page = 1; page <= totalPages; page++) {
  const data = await fetchOldPage({ page, per_page: 20 });
  process(data);
}

// After — Cursor pagination
interface NewPaginationParams {
  cursor?: string;
  limit: number;
}

interface CursorResult<T> {
  data: T[];
  meta: {
    cursor: string;
    hasMore: boolean;
  };
}

async function fetchNextPage(params: NewPaginationParams): Promise<CursorResult<Item>> {
  const query = params.cursor
    ? `?cursor=${params.cursor}&limit=${params.limit}`
    : `?limit=${params.limit}`;
  const res = await fetch(`/items${query}`);
  const body = await res.json();
  if ('error' in body) throw new Error(body.error.message);
  return body;
}

// Usage
let cursor: string | undefined;
let hasMore = true;

while (hasMore) {
  const result = await fetchNextPage({ cursor, limit: 20 });
  process(result.data);
  cursor = result.meta.cursor;
  hasMore = result.meta.hasMore;
}
```

---

## 📖 Bilingual Terminology Glossary 术语对照表

| English Term | 中文术语 | Context / 说明 |
|---|---|---|
| Breaking Change | 重大变更 / 破坏性��更 | API 向后不兼容的修改 |
| Migration Deadline | 迁移截止日期 | 旧版本停止支持的时间 |
| Deprecation | 弃用 / 过时 | 标记即将移除的功能 |
| API Key | API 密钥 | 旧版认证凭证 |
| OAuth 2.0 | OAuth 2.0 开放授权协议 | 新版认证标准 |
| Bearer Token | 持有者令牌 | 用于身份验证的令牌 |
| Client Credentials | 客户端凭证 | OAuth 2.0 的一种授权类型 |
| Access Token | 访问令牌 | 授权后获得的短期令牌 |
| Refresh Token | 刷新令牌 | 用于获取新 Access Token 的长效令牌 |
| Response Format | 响应格式 | API 返回数据的结构 |
| Success Response | 成功响应 | 操作成功的返回格式 |
| Error Response | 错误响应 | 操作失败的返回格式 |
| Error Code | 错误码 | 错误类型的唯一标识 |
| Error Message | 错误信息 | 错误的可读描述 |
| Pagination | 分页 | 分批次获取数据 |
| Offset Pagination | 偏移分页 / 页码分页 | 通过 page/offset 参数分页 |
| Cursor Pagination | 游标分页 / 光标分页 | 通过游标值分页 |
| Cursor | 游标 / 光标 | 分页的定位标记 |
| Has More | 是否有更多 | 分页是否还有后续数据 |
| Request ID | 请求 ID | 单次请求的唯一标识 |
| Timestamp | 时间戳 | 请求处理的时间点 |
| Scope | 权限范围 | OAuth Token 的授权范围 |
| Backward Compatibility | 向后兼容性 | 新版本对旧接口的兼容程度 |
| Parallel Period | 并行期 | 新旧版本同时可用的阶段 |
| Warning Period | 告警期 | 返回警告但仍然可用的阶段 |
| Deprecation Period | 停用期 | 旧接口完全停止服务的阶段 |

---

*Generated on: 2026-04-04*
*Document Version: 1.0*
