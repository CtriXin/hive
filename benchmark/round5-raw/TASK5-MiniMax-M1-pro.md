# TASK5: SDK v3.0 Breaking Change Notice

> Model: MiniMax-M1-pro
> Date: 2026-04-04

---

# Part 1: 中文版变更通知

# SDK v3.0 升级公告

> **发布状态**：正式发布（GA）
> **发布时间**：2026-04-04
> **影响版本**：所有 v2.x 客户端
> **迁移窗口**：旧版认证方式将在 **v3.2 发布后的 90 天内** 逐步下线，请尽快完成迁移。

你好，开发者！

SDK v3.0 已经正式发布。这个版本是一次重大升级（Major Release），我们重新梳理了认证机制、响应格式以及分页策略，以提供更一致、更安全、更可扩展的开发体验。

以下内容均为 **Breaking Changes**，请仔细阅读，并参考配套的迁移代码示例完成升级。

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
{ "data": { ... }, "meta": { "requestId": "req_xxx", "timestamp": 171... } }
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

1. 参考下方迁移代码示例进行升级。
2. 下载最新版 SDK：`npm install our-sdk@^3.0.0`
3. 如果在迁移中遇到问题，请在 GitHub Discussions 中与我们联系。

感谢你的理解与支持！

---

# Part 2: English Version Changelog

# SDK v3.0 Breaking Change Notice

> **Status**: Generally Available (GA)
> **Release Date**: 2026-04-04
> **Affected Versions**: All `v2.x` clients
> **Deprecation Window**: Legacy API Key authentication will be sunset **90 days after the v3.2 release**.

## Overview

SDK v3.0 is now available. This major release introduces breaking changes across authentication, response payloads, and pagination. These updates improve security consistency, observability, and scalability for large datasets.

Please review the changes below and consult the migration examples for runnable TypeScript code.

---

## 1. Authentication

We have moved from static API keys to **OAuth 2.0 Bearer Tokens** to align with industry security standards.

| Version | Header Format |
|---------|---------------|
| v2 (deprecated) | `headers: { 'X-API-Key': key }` |
| v3 (required)   | `headers: { 'Authorization': 'Bearer ' + token }` |

**Timeline**:
- v3.0: Bearer Token is the default and recommended method.
- v3.2 release + 90 days: API Key authentication will return `401 Unauthorized`.

---

## 2. Response Format

Success and error payloads are now fully structured.

### Success Response

```json
// v2
{ "data": { ... }, "error": null }

// v3
{ "data": { ... }, "meta": { "requestId": "req_xxx", "timestamp": 171... } }
```

### Error Response

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

**Changes**:
- Success responses include a new `meta` object with `requestId` and `timestamp`.
- Error responses now use a structured `error` object containing `code`, `message`, and optional `details`.

---

## 3. Pagination API

Offset-based pagination has been replaced with **cursor-based pagination** to improve performance on large result sets.

### Request

```
# v2
GET /items?page=1&size=20

# v3
GET /items?cursor=xxx&limit=20
```

### Response Body

```json
// v2
{ "items": [...], "total": 1000, "page": 1 }

// v3
{ "items": [...], "nextCursor": "eyJ...", "hasMore": true }
```

**Changes**:
- Query parameters changed from `page` + `size` to `cursor` + `limit`.
- Response body no longer includes `total` or `page`. Use `nextCursor` and `hasMore` to iterate.
- Omit `cursor` (or pass an empty value) for the first page.

---

## Next Steps

1. Use the migration code examples below to update your integration.
2. Upgrade the SDK: `npm install our-sdk@^3.0.0`
3. Open a GitHub Discussion if you run into any migration issues.

---

# Part 3: Migration Code Examples (TypeScript)

## 1. Authentication Migration

### v2 (legacy)

```typescript
const clientV2 = {
  baseURL: 'https://api.example.com',
  headers: {
    'X-API-Key': process.env.API_KEY!,
  },
};
```

### v3 (current)

```typescript
const clientV3 = {
  baseURL: 'https://api.example.com',
  headers: {
    'Authorization': `Bearer ${process.env.OAUTH_TOKEN!}`,
  },
};
```

> **Note**: Ensure your application has switched to an OAuth 2.0 flow to obtain an access token. The legacy API Key authentication will be sunset 90 days after the v3.2 release.

---

## 2. Response Format Migration

### v2 type definitions

```typescript
type ApiResponseV2<T> =
  | { data: T; error: null }
  | { data: null; error: string };

async function fetchUserV2(id: string): Promise<User> {
  const res = await fetch(`/users/${id}`);
  const json = (await res.json()) as ApiResponseV2<User>;

  if (json.error) {
    throw new Error(json.error);
  }
  return json.data;
}
```

### v3 type definitions

```typescript
type ApiSuccessV3<T> = {
  data: T;
  meta: { requestId: string; timestamp: number };
};

type ApiErrorV3 = {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
};

type ApiResponseV3<T> = ApiSuccessV3<T> | ApiErrorV3;

function isErrorV3<T>(res: ApiResponseV3<T>): res is ApiErrorV3 {
  return 'error' in res && res.error != null && typeof res.error === 'object';
}

async function fetchUserV3(id: string): Promise<User> {
  const res = await fetch(`/users/${id}`);
  const json = (await res.json()) as ApiResponseV3<User>;

  if (isErrorV3(json)) {
    console.error('Error code:', json.error.code);
    throw new Error(`[${json.error.code}] ${json.error.message}`);
  }

  console.log('Request ID:', json.meta.requestId);
  return json.data;
}
```

---

## 3. Pagination API Migration

### v2 (offset-based pagination)

```typescript
interface PaginatedResponseV2<T> {
  items: T[];
  total: number;
  page: number;
}

async function listItemsV2(page = 1, size = 20): Promise<PaginatedResponseV2<Item>> {
  const res = await fetch(`/items?page=${page}&size=${size}`);
  return (await res.json()) as PaginatedResponseV2<Item>;
}

const page1 = await listItemsV2(1, 20);
const lastPage = Math.ceil(page1.total / 20);
```

### v3 (cursor-based pagination)

```typescript
interface PaginatedResponseV3<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

async function listItemsV3(
  cursor?: string,
  limit = 20,
): Promise<PaginatedResponseV3<Item>> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);

  const res = await fetch(`/items?${params.toString()}`);
  return (await res.json()) as PaginatedResponseV3<Item>;
}

async function fetchAllItemsV3(limit = 20): Promise<Item[]> {
  const allItems: Item[] = [];
  let cursor: string | undefined;

  do {
    const page = await listItemsV3(cursor, limit);
    allItems.push(...page.items);
    cursor = page.nextCursor ?? undefined;
  } while (cursor);

  return allItems;
}
```

---

## 4. End-to-End Comparison

### v2 full example

```typescript
interface Item {
  id: string;
  name: string;
}

async function mainV2() {
  const apiKey = process.env.API_KEY!;

  try {
    const res = await fetch('https://api.example.com/items?page=1&size=20', {
      headers: { 'X-API-Key': apiKey },
    });
    const json = (await res.json()) as {
      data: { items: Item[]; total: number; page: number } | null;
      error: string | null;
    };

    if (json.error) {
      throw new Error(json.error);
    }

    console.log('Items:', json.data!.items);
    console.log('Total pages:', Math.ceil(json.data!.total / 20));
  } catch (err) {
    console.error('Failed:', err);
  }
}
```

### v3 full example

```typescript
interface Item {
  id: string;
  name: string;
}

type SuccessV3<T> = {
  data: T;
  meta: { requestId: string; timestamp: number };
};

type ErrorV3 = {
  error: { code: string; message: string; details?: unknown };
};

type ResponseV3<T> = SuccessV3<T> | ErrorV3;

function isError<T>(res: ResponseV3<T>): res is ErrorV3 {
  return 'error' in res;
}

async function mainV3() {
  const token = process.env.OAUTH_TOKEN!;

  try {
    const res = await fetch('https://api.example.com/items?limit=20', {
      headers: { 'Authorization': `Bearer ${token}` },
    });
    const json = (await res.json()) as ResponseV3<{
      items: Item[];
      nextCursor: string | null;
      hasMore: boolean;
    }>;

    if (isError(json)) {
      throw new Error(`[${json.error.code}] ${json.error.message}`);
    }

    console.log('Items:', json.data.items);
    console.log('Next cursor:', json.data.nextCursor);
    console.log('Request ID:', json.meta.requestId);
  } catch (err) {
    console.error('Failed:', err);
  }
}
```

---

# Part 4: 中英术语对照表 (Bilingual Terminology Glossary)

| 英文术语 | 中文术语 | 说明 |
|---------|---------|------|
| Breaking change | 重大变更 / 破坏性变更 | 引入后不兼容旧版本的改动，需要开发者主动修改代码才能升级。 |
| API Key authentication | API Key 认证 | v2 中使用的静态密钥认证方式，通过 `X-API-Key` 请求头传递。 |
| OAuth 2.0 Bearer Token | OAuth 2.0 Bearer Token | v3 推荐的标准认证方式，通过 `Authorization: Bearer <token>` 请求头传递。 |
| Response format | 响应格式 | API 返回数据的整体结构。 |
| Success response | 成功响应 | 请求成功时返回的 JSON 结构。 |
| Error response | 错误响应 | 请求失败时返回的 JSON 结构。 |
| Structured error | 结构化错误 | 错误信息以对象形式呈现，包含 `code`、`message`、`details` 等字段。 |
| Request ID | 请求 ID | 用于唯一标识一次 API 请求，便于日志追踪与排障。 |
| Timestamp | 时间戳 | 服务器返回响应时的 Unix 时间戳。 |
| Offset-based pagination | 偏移分页 | v2 的分页方式，通过 `page` 和 `size` 定位数据页。 |
| Cursor-based pagination | 游标分页 | v3 的分页方式，通过不透明的 `cursor` 定位下一页数据。 |
| Cursor | 游标 | 一个 opaque 字符串，用于在游标分页中获取下一页数据。 |
| Next cursor | 下一页游标 | 响应中提供的获取下一页数据所需的游标值，为 `null` 时表示没有更多数据。 |
| Has more | 是否还有更多数据 | 布尔值，指示是否还存在后续数据页。 |
| Migration guide | 迁移指南 | 帮助开发者从旧版本升级到新版本的文档。 |
| Deprecation window / Sunset period | 迁移期 / 弃用缓冲期 | 旧功能仍可使用的过渡时间段，结束后将彻底下线。 |
| Authorization header | 授权请求头 | HTTP 请求中用于携带身份凭证的请求头字段。 |
| Meta | 元数据 | 成功响应中附带的额外信息（如 `requestId`、`timestamp`）。 |
| Error code | 错误码 | 结构化错误中的机器可读标识符，如 `INVALID_CURSOR`。 |
| Error message | 错误信息 | 面向开发者的可读错误描述文本。 |
| Error details | 错误详情 | 结构化错误中的可选字段，携带与错误相关的上下文数据。 |
| Query parameter | 查询参数 | URL 中跟在 `?` 后的键值对参数。 |
| Limit | 单次返回数量上限 | 游标分页中用于控制每页返回条目数的参数。 |
| End-to-end example | 端到端示例 | 从请求发起、响应处理到异常捕获的完整代码示例。 |
