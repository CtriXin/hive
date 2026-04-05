# TASK 5: SDK v3.0 Breaking Change Notice / 中英双语变更通知

---

## 1. 中文版变更通知

### SDK v3.0 升级公告

> **版本**：v3.0.0
> **类型**：破坏性变更（Breaking Changes）
> **迁移窗口期**：自 v3.0 发布之日起 **90 天**（v3.2 发布后将正式移除兼容逻辑）

各位开发者，大家好：

为了提升安全性能、优化开发者体验并与行业最佳实践保持一致，SDK v3.0 对认证机制、响应格式以及分页策略进行了统一升级。以下内容请仔细阅读，以便顺利从 v2 迁移到 v3。

---

#### 变更一：认证方式（Security）

| 版本 | 方式 | 说明 |
|------|------|------|
| **v2** | `X-API-Key` | 通过请求头传递 API Key 进行认证 |
| **v3** | `Authorization: Bearer <token>` | 全面切换为 OAuth 2.0 Bearer Token |

**影响与建议**：
- v3.0 起同时支持旧版 `X-API-Key` 与新版 Bearer Token，**90 天兼容期**结束后，仅保留 Bearer Token。
- 建议尽快在服务端完成 OAuth 2.0 接入，并通过刷新令牌（Refresh Token）机制避免频繁手动更新 Token。
- 若当前在 CI/CD 脚本或环境变量中硬编码了 API Key，请一并更新为 Access Token 的获取逻辑。

---

#### 变更二：响应格式（Response Format）

**v2 格式**：
```json
{
  "data": { ... },
  "error": null
}
```

**v3 格式**：

- **成功响应**：`{ data, meta }`
  ```json
  {
    "data": { ... },
    "meta": { "requestId": "req_xxx", "timestamp": "2024-..." }
  }
  ```

- **错误响应**：`{ error: { code, message, details } }`
  ```json
  {
    "error": {
      "code": "INVALID_CURSOR",
      "message": "提供的分页游标已过期",
      "details": { "cursor": "abc123" }
    }
  }
  ```

**影响与建议**：
- 错误处理请从判断 `error !== null` 调整为判断响应中是否包含 `error` 字段，并通过 `error.code` 做精细化处理。
- `meta` 字段可用于链路追踪与幂等性校验，建议在未来版本中逐步接入。

---

#### 变更三：分页策略（Pagination）

| 版本 | 策略 | 查询参数 | 返回方式 |
|------|------|----------|----------|
| **v2** | Offset 分页 | `?page=1&size=20` | 通过 `data` 直接返回列表 |
| **v3** | Cursor 分页 | `?cursor=xxx&limit=20` | 列表在 `data` 中，下一页游标在 `meta.nextCursor` 中 |

**影响与建议**：
- Cursor 分页避免了深翻页性能抖动，适用于高并发的实时数据场景。
- 若当前 UI 依赖“总页数”或“跳转到第 N 页”的交互，建议改用无限滚动（Infinite Scroll）或仅保留上一页/下一页按钮。

---

#### 迁移时间线

1. **即日起**：升级 SDK 至 v3.0，可继续携带 `X-API-Key`，同时开始测试 Bearer Token。
2. **第 1-30 天**：完成认证与响应格式替换，内部回归测试。
3. **第 31-60 天**：完成分页接口替换，灰度发布。
4. **第 61-90 天**：全量切流，清理 v2 兼容代码。
5. **90 天以后**：`X-API-Key` 与 offset 分页参数将返回 `410 Gone`。

如有任何迁移问题，欢迎通过 Issue 或开发者社群与我们联系。感谢理解与支持！

---

## 2. English Version Change Notice

### SDK v3.0 Breaking Change Notice

> **Version**: v3.0.0
> **Type**: Breaking Changes
> **Migration Window**: **90 days** from the v3.0 release date (legacy support removed in v3.2)

To improve security, developer experience, and alignment with industry standards, SDK v3.0 introduces breaking changes in three areas: **authentication**, **response format**, and **pagination**. Please review the details below and plan your migration accordingly.

---

#### Change 1: Authentication

| Version | Mechanism | Header |
|---------|-----------|--------|
| **v2** | API Key | `X-API-Key: <api_key>` |
| **v3** | OAuth 2.0 Bearer Token | `Authorization: Bearer <token>` |

**Migration Notes**:
- SDK v3.0 continues to accept `X-API-Key` during the 90-day migration window.
- After the window closes (v3.2 release), only Bearer Tokens will be accepted.
- We recommend updating your CI/CD pipelines, backend services, and environment-variable management to use OAuth 2.0 token retrieval and refresh flows as soon as possible.

---

#### Change 2: Response Format

**v2 Response**:
```json
{
  "data": { ... },
  "error": null
}
```

**v3 Response**:

- **Success**: `{ data, meta }`
  ```json
  {
    "data": { ... },
    "meta": { "requestId": "req_xxx", "timestamp": "2024-..." }
  }
  ```

- **Error**: `{ error: { code, message, details } }`
  ```json
  {
    "error": {
      "code": "INVALID_CURSOR",
      "message": "The provided pagination cursor has expired.",
      "details": { "cursor": "abc123" }
    }
  }
  ```

**Migration Notes**:
- Replace checks like `if (res.error !== null)` with `if ('error' in res)`.
- Use `error.code` for precise error handling and fallback logic.
- The new `meta` field carries request metadata useful for tracing and idempotency.

---

#### Change 3: Pagination

| Version | Strategy | Query Params | Navigation |
|---------|----------|--------------|------------|
| **v2** | Offset-based | `?page=1&size=20` | Page numbers |
| **v3** | Cursor-based | `?cursor=xxx&limit=20` | `meta.nextCursor` |

**Migration Notes**:
- Cursor pagination replaces offset-based pagination to eliminate deep-paging performance penalties.
- If your UI currently shows total page counts or "jump to page N" controls, consider migrating to infinite scroll or simple "Previous / Next" navigation.

---

#### Migration Timeline

1. **Day 0**: Upgrade to SDK v3.0. Legacy `X-API-Key` still works; begin Bearer Token integration.
2. **Day 1-30**: Migrate auth and response-format handling; run regression tests.
3. **Day 31-60**: Migrate pagination endpoints; deploy behind a feature flag.
4. **Day 61-90**: Complete full cutover and remove v2 compatibility paths.
5. **Day 90+**: Legacy `X-API-Key` and offset pagination will return `410 Gone`.

For questions or issues, please open a GitHub Issue or reach out on the developer forum.

---

## 3. 迁移代码示例 (v2 → v3, TypeScript)

### 3.1 中文版迁移示例（带中文注释）

```typescript
import { SDKClient } from '@example/sdk';

// ==========================================
// v2 写法（即将废弃，请勿在新项目中使用）
// ==========================================
const clientV2 = new SDKClient({
  apiKey: process.env.API_KEY,          // v2: 通过 apiKey 自动注入 X-API-Key
});

async function listUsersV2(page: number) {
  const res = await clientV2.get('/users', {
    params: { page, size: 20 },          // v2: 使用 offset 分页参数
  });

  // v2: 成功时 error 为 null
  if (res.error) {
    throw new Error(res.error.message);
  }

  return res.data;                       // v2: 列表数据直接挂在 data 下
}

// ==========================================
// v3 写法（推荐）
// ==========================================
const clientV3 = new SDKClient({
  accessToken: process.env.ACCESS_TOKEN, // v3: 使用 OAuth 2.0 Bearer Token
});

async function listUsersV3(cursor?: string) {
  const res = await clientV3.get('/users', {
    params: { cursor, limit: '20' },     // v3: 使用 cursor 分页参数
  });

  // v3: 判断响应中是否包含 error 字段
  if ('error' in res) {
    // v3: 错误结构更精细，可直接读取 code、message、details
    throw new Error(`[${res.error.code}] ${res.error.message}`);
  }

  // v3: 业务数据仍在 data 中，分页元信息移至 meta
  return {
    users: res.data,
    nextCursor: res.meta.nextCursor,
    hasMore: res.meta.hasMore,
  };
}

// ---- 使用示例 ----
async function main() {
  // v3 无限滚动示例
  let cursor: string | undefined;
  do {
    const result = await listUsersV3(cursor);
    renderUsers(result.users);
    cursor = result.nextCursor;
  } while (cursor);
}
```

---

### 3.2 English Migration Example (with English comments)

```typescript
import { SDKClient } from '@example/sdk';

// ==========================================
// v2 style (deprecated, do not use in new projects)
// ==========================================
const clientV2 = new SDKClient({
  apiKey: process.env.API_KEY,          // v2: injects X-API-Key header automatically
});

async function listUsersV2(page: number) {
  const res = await clientV2.get('/users', {
    params: { page, size: 20 },          // v2: offset-based pagination
  });

  // v2: on success, error is null
  if (res.error) {
    throw new Error(res.error.message);
  }

  return res.data;                       // v2: list returned directly under data
}

// ==========================================
// v3 style (recommended)
// ==========================================
const clientV3 = new SDKClient({
  accessToken: process.env.ACCESS_TOKEN, // v3: OAuth 2.0 Bearer Token
});

async function listUsersV3(cursor?: string) {
  const res = await clientV3.get('/users', {
    params: { cursor, limit: '20' },     // v3: cursor-based pagination
  });

  // v3: check whether the response contains an error field
  if ('error' in res) {
    // v3: richer error shape with code, message, and details
    throw new Error(`[${res.error.code}] ${res.error.message}`);
  }

  // v3: payload remains in data; pagination metadata moved to meta
  return {
    users: res.data,
    nextCursor: res.meta.nextCursor,
    hasMore: res.meta.hasMore,
  };
}

// ---- usage example ----
async function main() {
  // v3 infinite-scroll example
  let cursor: string | undefined;
  do {
    const result = await listUsersV3(cursor);
    renderUsers(result.users);
    cursor = result.nextCursor;
  } while (cursor);
}
```

---

## 4. 术语对照表 (Bilingual Terminology Glossary)

| 中文 | English | 说明 / Definition |
|------|---------|-------------------|
| 破坏性变更 | Breaking Change | 升级后可能导致现有代码无法正常编译或运行的变更 |
| 废弃 | Deprecated | 仍然可用但已计划移除的功能或接口，通常会给出替代方案 |
| 迁移期 / 迁移窗口 | Migration Window | 允许新旧版本共存的过渡期，本文为 90 天 |
| API Key | API Key | 通过请求头 `X-API-Key` 传递的静态密钥 |
| OAuth 2.0 Bearer Token | OAuth 2.0 Bearer Token | 基于 OAuth 2.0 协议的短期访问令牌，通过 `Authorization: Bearer <token>` 传递 |
| 响应格式 | Response Format | 服务端返回数据的结构约定，包括成功与失败两种形态 |
| 元数据 | Meta | v3 成功响应中新增的字段，用于承载请求级附加信息（如 requestId、timestamp、分页游标等） |
| 错误详情 | Error Details | v3 错误响应中的结构化信息，包含 `code`、`message` 与可选的 `details` |
| 偏移分页 | Offset-based Pagination | 基于页码（page）和每页条数（size）进行数据切片的分页方式 |
| 游标分页 | Cursor-based Pagination | 基于不透明游标（cursor）和限制条数（limit）进行翻页的方式，更适合大数据量与实时流 |
| 深翻页 | Deep Paging | 在 offset 分页中跳转到极后排数据时出现的性能显著下降现象 |
| 无限滚动 | Infinite Scroll | 一种 UI 交互模式，用户滚动到底部时自动加载下一页数据 |
| 灰度发布 | Gradual Rollout / Canary Release | 先将新版本开放给小部分用户或流量，验证稳定后再全量推送的发布策略 |
| 全量切流 | Full Cutover | 将所有流量从旧版本完全迁移到新版本的最终步骤 |
