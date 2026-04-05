# SDK v3.0 变更通知

> **版本**: 3.0.0
> **发布日期**: 待定
> **迁移截止**: v3.2 发布后 90 天

SDK v3.0 包含若干破坏性变更，请务必在升级前完成迁移准备。本文档将逐一说明每项变更、影响范围及推荐迁移路径。

---

## 目录

1. [认证方式变更](#一认证方式变更)
2. [响应格式变更](#二响应格式变更)
3. [分页 API 变更](#三分页-api-变更)
4. [迁移时间线](#四迁移时间线)
5. [术语对照](#五术语对照)

---

## 一、认证方式变更

### 变更说明

v2 使用 API Key 进行请求认证：

```typescript
// v2（即将废弃）
const client = new SDKClient({
  headers: { 'X-API-Key': apiKey }
});
```

v3 改用 OAuth 2.0 Bearer Token：

```typescript
// v3（推荐）
const client = new SDKClient({
  headers: { 'Authorization': `Bearer ${token}` }
});
```

### 迁移要点

- 旧的 `X-API-Key` 头将在 **v3.2 发布后 90 天**停止支持
- 迁移期内 v2 和 v3 认证方式均可使用
- 建议尽早切换到 OAuth 2.0，获取 `token` 的流程请参考 OAuth 服务端文档
- 若使用 SDK 内置认证模块，更新到 v3 后调用 `client.authenticate()` 即可自动切换

### 影响范围

- 所有需要认证的 API 请求
- CI/CD 管道中硬编码 API Key 的脚本
- 服务端间调用的配置文件

---

## 二、响应格式变更

### 成功响应

v2 成功响应格式：

```typescript
// v2
interface SuccessResponse<T> {
  data: T;
  error: null;
}
```

v3 成功响应格式：

```typescript
// v3
interface SuccessResponse<T> {
  data: T;
  meta: {
    requestId: string;
    timestamp: number;
  };
}
```

新增 `meta` 字段，包含请求唯一标识和时间戳，方便调���和链路追踪。`error` 字段已从成功响应中移除。

### 错误响应

v2 错误响应格式：

```typescript
// v2
interface ErrorResponse {
  data: null;
  error: string;
}
```

v3 错误响应格式：

```typescript
// v3
interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}
```

错误信息结构化，新增 `code` 用于程序化处理，`details` 提供额外上下文。`data` 字段已从错误响应中移除。

### 迁移要点

- 检查代码中是否有 `response.error === null` 的判断，改为检查 `'data' in response && !('error' in response)` 或使用 SDK 提供的类型守卫
- 读取 `response.error` 字符串的地方改为 `response.error.message`
- 利用新增的 `response.meta.requestId` 替代自行生成的请求追踪 ID

---

## 三、分页 API 变更

### 变更说明

v2 使用 offset 分页：

```typescript
// v2 请求
GET /api/items?page=1&size=20

// v2 响应
interface PaginatedResponse<T> {
  items: T[];
  total: number;
  page: number;
}
```

v3 改用游标分页：

```typescript
// v3 请求
GET /api/items?cursor=xxx&limit=20

// v3 响应
interface CursorPaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}
```

### 为什么要改用游标分页

- offset 分页在数据频繁变动时会产生重复或遗漏
- 大偏移量（如 `page=1000`）性能较差
- 游标分页在大数据集下有稳定且可预测的性能表现

### 迁移要点

- 将 `page` 参数替换为上一页返回的 `nextCursor`
- 将 `size` 参数重命名为 `limit`
- `total` 字段不再返回——若需总数，请调用专用的 count 接口或使用聚合查询
- 遍历逻辑从"循环 page 直到 page > totalPages"改为"循环直到 `nextCursor === null` 或 `hasMore === false`"

---

## 四、迁移时间线

| 阶段 | 时间 | 说明 |
|------|------|------|
| v3.0 发布 | T | v3 新接口可用，v2 旧接口仍可使用 |
| v3.1 | T + 约 1 个月 | 建议完成认证和响应格式迁移 |
| v3.2 发布 | T + 约 2 个月 | v2 认证方式进入 90 天倒计时 |
| v3.2 + 90 天 | T + 约 5 个月 | v2 认证方式正式下线 |

---

## 五、术语对照

| 中文 | English |
|------|---------|
| API Key 认证 | API Key Authentication |
| Bearer Token 认证 | Bearer Token Authentication |
| 游标分页 | Cursor-based Pagination |
| 偏移分页 | Offset-based Pagination |
| 请求标识 | Request ID |
| 响应格式 | Response Format |
| 结构化错误 | Structured Error |
| 迁移期 | Migration Period |
| 破坏性变更 | Breaking Change |
| 链路追踪 | Distributed Tracing |

---

如有疑问，请参阅完整迁移指南（`migration-guide-v3.en.md` / `migration-guide-v3.zh.md`）或联系技术支持。
