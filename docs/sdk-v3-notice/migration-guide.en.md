# SDK v3.0 Migration Guide (English)

This guide provides complete, runnable TypeScript examples for migrating from v2 to v3.

---

## 1. Authentication Migration

### v2 (legacy)
```typescript
const clientV2 = {
  baseURL: 'https://api.example.com',
  headers: {
    'X-API-Key': process.env.API_KEY!,   // deprecated
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
    throw new Error(json.error);        // plain string error
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
    // Structured error code and traceable request ID
    console.error('Error code:', json.error.code);
    throw new Error(`[${json.error.code}] ${json.error.message}`);
  }

  // Log the request ID for tracing
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

// Usage
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

async function listItemsV3(cursor?: string, limit = 20): Promise<PaginatedResponseV3<Item>> {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (cursor) params.set('cursor', cursor);

  const res = await fetch(`/items?${params.toString()}`);
  return (await res.json()) as PaginatedResponseV3<Item>;
}

// Sequential paging
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

Below is a realistic scenario: fetching a list of items and handling errors in v2 and v3.

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

For more details, see the [Breaking Change Notice](./breaking-change.en.md) or open a GitHub Discussion.
