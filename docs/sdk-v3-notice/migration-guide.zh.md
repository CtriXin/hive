# SDK v3.0 迁移指南（中文版）

本文档提供从 v2 到 v3 的完整代码迁移示例，所有示例均使用 TypeScript，可直接复制到项目中运行。

---

## 1. 认证方式迁移

### v2（旧方式）
```typescript
const clientV2 = {
  baseURL: 'https://api.example.com',
  headers: {
    'X-API-Key': process.env.API_KEY!,   // 废弃
  },
};
```

### v3（新方式）
```typescript
const clientV3 = {
  baseURL: 'https://api.example.com',
  headers: {
    'Authorization': `Bearer ${process.env.OAUTH_TOKEN!}`,
  },
};
```

> **提示**：请确保你的应用已经从 API Key 切换到 OAuth 2.0 流程获取 Access Token。旧方式将在 v3.2 发布 90 天后下线。

---

## 2. 响应格式迁移

### v2 类型定义
```typescript
type ApiResponseV2<T> =
  | { data: T; error: null }
  | { data: null; error: string };

async function fetchUserV2(id: string): Promise<User> {
  const res = await fetch(`/users/${id}`);
  const json = (await res.json()) as ApiResponseV2<User>;

  if (json.error) {
    throw new Error(json.error);        // 字符串错误
  }
  return json.data;
}
```

### v3 类型定义
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
    // 现在可以拿到结构化的错误码和请求追踪 ID
    console.error('Request ID:', json.error.code);
    throw new Error(`[${json.error.code}] ${json.error.message}`);
  }

  // 如需日志追踪，可读取 meta.requestId
  console.log('Request ID:', json.meta.requestId);
  return json.data;
}
```

---

## 3. 分页 API 迁移

### v2（偏移分页）
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

// 用法
const page1 = await listItemsV2(1, 20);
const lastPage = Math.ceil(page1.total / 20);
```

### v3（游标分页）
```typescript
interface PaginatedResponseV3<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

async function listItemsV3(cursor?: string, limit = 20): Promise<PaginatedResponseV3<Item>> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);

  const res = await fetch(`/items?${params.toString()}`);
  return (await res.json()) as PaginatedResponseV3<Item>;
}

// 顺序翻页
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

## 4. 完整端到端对比示例

下面是一段贴近真实场景的代码：在 v2 和 v3 中分别获取用户列表并处理异常。

### v2 完整示例
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

### v3 完整示例
```typescript
interface Item {
  id: string;
  name: string;
}

type SuccessV3<T> = { data: T; meta: { requestId: string; timestamp: number } };
type ErrorV3 = { error: { code: string; message: string; details?: unknown } };
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

如有疑问，欢迎查阅 [变更通知](./breaking-change.zh.md) 或在社区发起讨论。
