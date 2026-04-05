# SDK v3.0 Breaking Change Notice

> **Status**: Generally Available (GA)
> **Release Date**: 2026-04-04
> **Affected Versions**: All `v2.x` clients
> **Deprecation Window**: Legacy API Key authentication will be sunset **90 days after the v3.2 release**.

## Overview

SDK v3.0 is now available. This major release introduces breaking changes across authentication, response payloads, and pagination. These updates improve security consistency, observability, and scalability for large datasets.

Please review the changes below and consult the [Migration Guide](./migration-guide.en.md) for runnable TypeScript examples.

---

## 1. Authentication

We have moved from static API keys to **OAuth 2.0 Bearer Tokens** to align with industry security standards.

| Version | Header Format |
|---------|---------------|
| v2 (deprecated) | `headers: { 'X-API-Key': key }` |
| v3 (required)   | `headers: { 'Authorization': 'Bearer ' + token }` |

**Timeline**
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
{ "data": { ... }, "meta": { "requestId": "req_xxx", "timestamp": 171...
}
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

**Changes**
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

**Changes**
- Query parameters changed from `page` + `size` to `cursor` + `limit`.
- Response body no longer includes `total` or `page`. Use `nextCursor` and `hasMore` to iterate.
- Omit `cursor` (or pass an empty value) for the first page.

---

## Next Steps

1. Read the [Migration Guide](./migration-guide.en.md) for complete before/after code samples.
2. Upgrade the SDK: `npm install our-sdk@^3.0.0`
3. Open a GitHub Discussion if you run into any migration issues — we’re here to help.
