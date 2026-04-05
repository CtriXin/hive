# TASK1: 带中间件的 HTTP 路由器 — mimo-v2-pro

## 概述

实现了一个零依赖的轻量级 HTTP 路由器，支持中间件管道和洋葱模型。

## 设计决策

| 决策点 | 方案 | 理由 |
|--------|------|------|
| 路由匹配 | 正则表达式 | 简单高效，无外部依赖，支持 `:param` 语法 |
| 中间件注册 | 统一 `use()` 重载 | 全局/前缀两种模式，API 一致 |
| 执行模型 | 递归 `next()` | 自然实现洋葱模型，中间件可在 `next()` 前后操作 |
| Context 设计 | 可变对象 | 允许中间件链传递状态，性能优于 immutable |
| 404 判断 | 先匹配再执行 | 无匹配时直接返回，不跑中间件 |
| 错误捕获 | try/catch 包裹执行链 | handler 和中间件异常统一处理 |

## 文件结构

```
router.ts          — 主实现（183 行）
router.test.ts     — 测试套件（278 行，12 个用例）
```

## 实现

```typescript
// router.ts

export interface Context {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
  status: number;
  responseBody: unknown;
  state: Record<string, unknown>;
}

export type Handler = (ctx: Context) => Promise<void> | void;
export type Middleware = (ctx: Context, next: () => Promise<void>) => Promise<void>;

interface Route {
  method: string;
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: Handler;
}

interface MiddlewareEntry {
  prefix: string | null;
  middleware: Middleware;
}

export class Router {
  private routes: Route[] = [];
  private middlewares: MiddlewareEntry[] = [];

  get(pattern: string, handler: Handler): void {
    this.addRoute('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.addRoute('POST', pattern, handler);
  }

  delete(pattern: string, handler: Handler): void {
    this.addRoute('DELETE', pattern, handler);
  }

  put(pattern: string, handler: Handler): void {
    this.addRoute('PUT', pattern, handler);
  }

  patch(pattern: string, handler: Handler): void {
    this.addRoute('PATCH', pattern, handler);
  }

  use(prefixOrMiddleware: string | Middleware, middleware?: Middleware): void {
    if (typeof prefixOrMiddleware === 'string' && middleware) {
      this.middlewares.push({ prefix: prefixOrMiddleware, middleware });
    } else if (typeof prefixOrMiddleware === 'function') {
      this.middlewares.push({ prefix: null, middleware: prefixOrMiddleware });
    }
  }

  private addRoute(method: string, pattern: string, handler: Handler): void {
    const { regex, paramNames } = this.patternToRegex(pattern);
    this.routes.push({ method, pattern, regex, paramNames, handler });
  }

  private patternToRegex(pattern: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    const regexPattern = pattern.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    return {
      regex: new RegExp(`^${regexPattern}$`),
      paramNames
    };
  }

  private parseQuery(queryString: string): Record<string, string> {
    const query: Record<string, string> = {};
    if (!queryString) return query;
    const params = new URLSearchParams(queryString);
    params.forEach((value, key) => { query[key] = value; });
    return query;
  }

  private matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = path.match(route.regex);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, index) => { params[name] = match[index + 1]; });
        return { route, params };
      }
    }
    return null;
  }

  async handle(request: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  }): Promise<{ status: number; body: unknown }> {
    const [pathWithoutQuery, queryString] = request.path.split('?');

    const ctx: Context = {
      method: request.method,
      path: pathWithoutQuery,
      params: {},
      query: this.parseQuery(queryString || ''),
      body: request.body ?? null,
      headers: request.headers ?? {},
      status: 200,
      responseBody: null,
      state: {}
    };

    const routeMatch = this.matchRoute(request.method, pathWithoutQuery);

    if (!routeMatch) {
      return { status: 404, body: { error: 'Not Found', path: ctx.path } };
    }

    ctx.params = routeMatch.params;
    const matchedRoute = routeMatch.route;

    const applicableMiddlewares = this.middlewares.filter(mw => {
      if (mw.prefix === null) return true;
      return ctx.path.startsWith(mw.prefix);
    });

    try {
      await this.executeMiddlewares(ctx, applicableMiddlewares, matchedRoute.handler);
      return { status: ctx.status, body: ctx.responseBody };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      return { status: 500, body: { error: message } };
    }
  }

  private async executeMiddlewares(
    ctx: Context,
    middlewares: MiddlewareEntry[],
    finalHandler: Handler
  ): Promise<void> {
    let index = 0;
    const next = async (): Promise<void> => {
      if (index < middlewares.length) {
        const { middleware } = middlewares[index++];
        await middleware(ctx, next);
      } else {
        await finalHandler(ctx);
      }
    };
    await next();
  }
}

export function createRouter(): Router {
  return new Router();
}
```

## 测试

```typescript
// router.test.ts

import { describe, it, expect } from 'vitest';
import { Router, Context, createRouter, Middleware } from './router';

describe('HTTP Router', () => {
  it('basic route matching with params', async () => {
    const router = createRouter();
    let capturedId: string | null = null;

    router.get('/users/:id', async (ctx: Context) => {
      capturedId = ctx.params.id;
      ctx.status = 200;
      ctx.responseBody = { userId: ctx.params.id };
    });

    const response = await router.handle({
      method: 'GET',
      path: '/users/123'
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: '123' });
    expect(capturedId).toBe('123');
  });

  it('query parameter parsing', async () => {
    const router = createRouter();

    router.get('/search', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = { query: ctx.query };
    });

    const response = await router.handle({
      method: 'GET',
      path: '/search?q=test&page=1'
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ query: { q: 'test', page: '1' } });
  });

  it('global middleware execution order', async () => {
    const router = createRouter();
    const order: string[] = [];

    router.use(async (ctx: Context, next: () => Promise<void>) => {
      order.push('global-before');
      await next();
      order.push('global-after');
    });

    router.get('/test', async (ctx: Context) => {
      order.push('handler');
      ctx.status = 200;
      ctx.responseBody = { ok: true };
    });

    await router.handle({ method: 'GET', path: '/test' });

    expect(order).toEqual(['global-before', 'handler', 'global-after']);
  });

  it('path prefix middleware only matches corresponding paths', async () => {
    const router = createRouter();
    const logs: string[] = [];

    router.use('/api', async (ctx: Context, next: () => Promise<void>) => {
      logs.push('api-middleware');
      await next();
    });

    router.get('/api/users', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = { api: true };
    });

    router.get('/public/users', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = { public: true };
    });

    const apiResponse = await router.handle({ method: 'GET', path: '/api/users' });
    const publicResponse = await router.handle({ method: 'GET', path: '/public/users' });

    expect(logs).toEqual(['api-middleware']);
    expect(apiResponse.body).toEqual({ api: true });
    expect(publicResponse.body).toEqual({ public: true });
  });

  it('onion model: middleware can read responseBody after next()', async () => {
    const router = createRouter();
    let capturedResponse: unknown = null;

    router.use(async (ctx: Context, next: () => Promise<void>) => {
      await next();
      capturedResponse = ctx.responseBody;
      ctx.responseBody = { ...ctx.responseBody as object, modified: true };
    });

    router.get('/data', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = { original: true };
    });

    const response = await router.handle({ method: 'GET', path: '/data' });

    expect(capturedResponse).toEqual({ original: true });
    expect(response.body).toEqual({ original: true, modified: true });
  });

  it('error handling: handler throws exception', async () => {
    const router = createRouter();

    router.get('/error', async (ctx: Context) => {
      throw new Error('Something went wrong');
    });

    const response = await router.handle({ method: 'GET', path: '/error' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Something went wrong' });
  });

  it('error handling: middleware catches error', async () => {
    const router = createRouter();
    let capturedError: Error | null = null;

    router.use(async (ctx: Context, next: () => Promise<void>) => {
      try {
        await next();
      } catch (err) {
        capturedError = err as Error;
        ctx.status = 500;
        ctx.responseBody = { caught: true, message: (err as Error).message };
      }
    });

    router.get('/error', async (ctx: Context) => {
      throw new Error('Handler error');
    });

    const response = await router.handle({ method: 'GET', path: '/error' });

    expect(capturedError).not.toBeNull();
    expect(capturedError?.message).toBe('Handler error');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ caught: true, message: 'Handler error' });
  });

  it('404 for unmatched route', async () => {
    const router = createRouter();

    router.get('/exists', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = { ok: true };
    });

    const response = await router.handle({ method: 'GET', path: '/not-exists' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not Found', path: '/not-exists' });
  });

  it('state sharing between middlewares', async () => {
    const router = createRouter();

    router.use(async (ctx: Context, next: () => Promise<void>) => {
      ctx.state.user = { id: '123', name: 'Test' };
      await next();
    });

    router.use(async (ctx: Context, next: () => Promise<void>) => {
      ctx.state.requestTime = Date.now();
      await next();
    });

    router.get('/profile', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = {
        user: ctx.state.user,
        requestTime: ctx.state.requestTime
      };
    });

    const response = await router.handle({ method: 'GET', path: '/profile' });

    expect(response.status).toBe(200);
    expect((response.body as any).user).toEqual({ id: '123', name: 'Test' });
    expect((response.body as any).requestTime).toBeDefined();
  });

  it('POST and DELETE methods', async () => {
    const router = createRouter();
    const calls: string[] = [];

    router.post('/users', async (ctx: Context) => {
      calls.push('post');
      ctx.status = 201;
      ctx.responseBody = { created: true };
    });

    router.delete('/users/:id', async (ctx: Context) => {
      calls.push('delete');
      ctx.status = 204;
      ctx.responseBody = { deleted: ctx.params.id };
    });

    const postResponse = await router.handle({
      method: 'POST',
      path: '/users',
      body: { name: 'Test' }
    });

    const deleteResponse = await router.handle({
      method: 'DELETE',
      path: '/users/456'
    });

    expect(calls).toEqual(['post', 'delete']);
    expect(postResponse.status).toBe(201);
    expect(deleteResponse.status).toBe(204);
    expect(deleteResponse.body).toEqual({ deleted: '456' });
  });

  it('multiple path params', async () => {
    const router = createRouter();

    router.get('/users/:userId/posts/:postId', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = {
        userId: ctx.params.userId,
        postId: ctx.params.postId
      };
    });

    const response = await router.handle({
      method: 'GET',
      path: '/users/42/posts/100'
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: '42', postId: '100' });
  });

  it('middleware execution order: global then prefix then handler', async () => {
    const router = createRouter();
    const order: string[] = [];

    router.use(async (ctx: Context, next: () => Promise<void>) => {
      order.push('global-before');
      await next();
      order.push('global-after');
    });

    router.use('/api', async (ctx: Context, next: () => Promise<void>) => {
      order.push('api-before');
      await next();
      order.push('api-after');
    });

    router.get('/api/users', async (ctx: Context) => {
      order.push('handler');
      ctx.status = 200;
      ctx.responseBody = { ok: true };
    });

    await router.handle({ method: 'GET', path: '/api/users' });

    expect(order).toEqual([
      'global-before',
      'api-before',
      'handler',
      'api-after',
      'global-after'
    ]);
  });
});
```

## 测试结果

```
 ✓ router.test.ts (12 tests)
   ✓ basic route matching with params
   ✓ query parameter parsing
   ✓ global middleware execution order
   ✓ path prefix middleware only matches corresponding paths
   ✓ onion model: middleware can read responseBody after next()
   ✓ error handling: handler throws exception
   ✓ error handling: middleware catches error
   ✓ 404 for unmatched route
   ✓ state sharing between middlewares
   ✓ POST and DELETE methods
   ✓ multiple path params
   ✓ middleware execution order: global then prefix then handler

 Tests  12 passed (12)
```

## 要求覆盖清单

| 要求 | 实现位置 | 状态 |
|------|----------|------|
| router.get('/users/:id', handler) | `router.ts:36-54` | ✅ |
| router.use(middleware) 全局 | `router.ts:56-62` | ✅ |
| router.use('/api', middleware) 路径前缀 | `router.ts:56-62` | ✅ |
| Middleware 签名 `(ctx, next) => Promise<void>` | `router.ts:17` | ✅ |
| 洋葱模型 next() 前/后阶段 | `router.ts:160-177` | ✅ |
| 500 + { error: message } | `router.ts:151-157` | ✅ |
| 404 + { error: "Not Found", path } | `router.ts:130-135` | ✅ |
| 测试 ≥ 5 个 | 12 个测试用例 | ✅ |
| 零外部依赖 | 纯 TypeScript | ✅ |
