:

## 实现代码

```typescript
// router.ts
// 轻量级 HTTP 路由器，支持中间件管道

export interface Context {
  req: {
    method: string;
    url: string;
    headers: Record<string, string | string[]>;
    body?: unknown;
  };
  res: {
    statusCode: number;
    headers: Record<string, string>;
    body: unknown;
  };
  params: Record<string, string>;
  query: Record<string, string>;
}

export type Middleware = (
  ctx: Context,
  next: () => Promise<void>
) => Promise<void>;

export type Handler = (ctx: Context) => Promise<void> | void;

interface Route {
  method: string;
  path: string;
  handler: Handler;
  paramNames: string[];
  regex: RegExp;
}

interface MiddlewareEntry {
  path: string;
  middleware: Middleware;
  regex: RegExp;
}

export class Router {
  private routes: Route[] = [];
  private middlewares: MiddlewareEntry[] = [];

  private parsePath(path: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    const regexPattern = path.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    const regex = new RegExp(`^${regexPattern}$`);
    return { regex, paramNames };
  }

  private parseQuery(url: string): Record<string, string> {
    const query: Record<string, string> = {};
    const queryIndex = url.indexOf('?');
    if (queryIndex === -1) return query;

    const queryString = url.slice(queryIndex + 1);
    const params = new URLSearchParams(queryString);
    params.forEach((value, key) => {
      query[key] = value;
    });
    return query;
  }

  private getPath(url: string): string {
    const queryIndex = url.indexOf('?');
    return queryIndex === -1 ? url : url.slice(0, queryIndex);
  }

  private addRoute(method: string, path: string, handler: Handler): void {
    const { regex, paramNames } = this.parsePath(path);
    this.routes.push({ method, path, handler, paramNames, regex });
  }

  get(path: string, handler: Handler): void {
    this.addRoute('GET', path, handler);
  }

  post(path: string, handler: Handler): void {
    this.addRoute('POST', path, handler);
  }

  put(path: string, handler: Handler): void {
    this.addRoute('PUT', path, handler);
  }

  delete(path: string, handler: Handler): void {
    this.addRoute('DELETE', path, handler);
  }

  patch(path: string, handler: Handler): void {
    this.addRoute('PATCH', path, handler);
  }

  use(pathOrMiddleware: string | Middleware, middleware?: Middleware): void {
    if (typeof pathOrMiddleware === 'string') {
      // 路径前缀中间件
      const path = pathOrMiddleware;
      const mw = middleware!;
      const { regex } = this.parsePath(path + '/*');
      this.middlewares.push({ path, middleware: mw, regex: new RegExp(`^${path}`) });
    } else {
      // 全局中间件
      this.middlewares.push({ path: '/', middleware: pathOrMiddleware, regex: /^/ });
    }
  }

  private matchRoute(method: string, path: string): Route | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      if (route.regex.test(path)) {
        return route;
      }
    }
    return null;
  }

  private extractParams(route: Route, path: string): Record<string, string> {
    const params: Record<string, string> = {};
    const match = path.match(route.regex);
    if (match) {
      route.paramNames.forEach((name, index) => {
        params[name] = match[index + 1];
      });
    }
    return params;
  }

  private getMatchingMiddlewares(path: string): Middleware[] {
    return this.middlewares
      .filter(entry => entry.regex.test(path))
      .map(entry => entry.middleware);
  }

  async handle(
    method: string,
    url: string,
    headers: Record<string, string | string[]> = {},
    body?: unknown
  ): Promise<{ statusCode: number; headers: Record<string, string>; body: unknown }> {
    const path = this.getPath(url);
    const query = this.parseQuery(url);

    const ctx: Context = {
      req: { method, url, headers, body },
      res: { statusCode: 200, headers: {}, body: undefined },
      params: {},
      query,
    };

    try {
      const route = this.matchRoute(method, path);

      if (!route) {
        return {
          statusCode: 404,
          headers: { 'Content-Type': 'application/json' },
          body: { error: 'Not Found', path: url },
        };
      }

      ctx.params = this.extractParams(route, path);

      // 获取匹配的中间件
      const matchingMiddlewares = this.getMatchingMiddlewares(path);

      // 构建洋葱模型执行链
      const executeHandler = async (): Promise<void> => {
        await route.handler(ctx);
      };

      // 从后向前构建中间件链
      let chain = executeHandler;
      for (let i = matchingMiddlewares.length - 1; i >= 0; i--) {
        const mw = matchingMiddlewares[i];
        const next = chain;
        chain = async () => {
          let nextCalled = false;
          await mw(ctx, async () => {
            nextCalled = true;
            await next();
          });
          if (!nextCalled) {
            throw new Error('Middleware did not call next()');
          }
        };
      }

      await chain();

      return {
        statusCode: ctx.res.statusCode,
        headers: ctx.res.headers,
        body: ctx.res.body,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: { error: message },
      };
    }
  }
}

// 便捷函数创建路由器
export function createRouter(): Router {
  return new Router();
}
```

## 测试用例

```typescript
// router.test.ts
import { describe, it, expect } from 'vitest';
import { createRouter, Context } from './router';

describe('Router', () => {
  // Test 1: 基本路由注册和匹配
  it('should register and match basic routes', async () => {
    const router = createRouter();

    router.get('/users', (ctx) => {
      ctx.res.body = { users: [] };
    });

    const response = await router.handle('GET', '/users');

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ users: [] });
  });

  // Test 2: 路径参数解析
  it('should extract path parameters', async () => {
    const router = createRouter();

    router.get('/users/:id', (ctx) => {
      ctx.res.body = { userId: ctx.params.id };
    });

    const response = await router.handle('GET', '/users/123');

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ userId: '123' });
  });

  // Test 3: 查询参数解析
  it('should parse query parameters', async () => {
    const router = createRouter();

    router.get('/search', (ctx) => {
      ctx.res.body = { q: ctx.query.q, page: ctx.query.page };
    });

    const response = await router.handle('GET', '/search?q=test&page=2');

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ q: 'test', page: '2' });
  });

  // Test 4: 404 处理
  it('should return 404 for non-existent routes', async () => {
    const router = createRouter();

    router.get('/users', (ctx) => {
      ctx.res.body = { users: [] };
    });

    const response = await router.handle('GET', '/nonexistent');

    expect(response.statusCode).toBe(404);
    expect(response.body).toEqual({ error: 'Not Found', path: '/nonexistent' });
  });

  // Test 5: 500 错误处理
  it('should handle errors and return 500', async () => {
    const router = createRouter();

    router.get('/error', () => {
      throw new Error('Something went wrong');
    });

    const response = await router.handle('GET', '/error');

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'Something went wrong' });
  });

  // Test 6: 全局中间件 - 洋葱模型
  it('should execute global middleware in onion model', async () => {
    const router = createRouter();
    const order: string[] = [];

    router.use(async (ctx, next) => {
      order.push('middleware1-before');
      await next();
      order.push('middleware1-after');
    });

    router.use(async (ctx, next) => {
      order.push('middleware2-before');
      await next();
      order.push('middleware2-after');
    });

    router.get('/test', (ctx) => {
      order.push('handler');
      ctx.res.body = { done: true };
    });

    await router.handle('GET', '/test');

    expect(order).toEqual([
      'middleware1-before',
      'middleware2-before',
      'handler',
      'middleware2-after',
      'middleware1-after',
    ]);
  });

  // Test 7: 路径前缀中间件
  it('should apply path-specific middleware only to matching routes', async () => {
    const router = createRouter();
    const authRoutes: string[] = [];

    // 只对 /api 路径应用认证中间件
    router.use('/api', async (ctx, next) => {
      authRoutes.push(ctx.req.url);
      ctx.res.headers['X-Auth'] = 'verified';
      await next();
    });

    router.get('/api/users', (ctx) => {
      ctx.res.body = { users: [] };
    });

    router.get('/public/info', (ctx) => {
      ctx.res.body = { info: 'public' };
    });

    const apiResponse = await router.handle('GET', '/api/users');
    const publicResponse = await router.handle('GET', '/public/info');

    expect(apiResponse.headers['X-Auth']).toBe('verified');
    expect(publicResponse.headers['X-Auth']).toBeUndefined();
    expect(authRoutes).toEqual(['/api/users']);
  });

  // Test 8: 中间件修改请求/响应
  it('should allow middleware to modify request and response', async () => {
    const router = createRouter();

    // 日志中间件
    router.use(async (ctx, next) => {
      const start = Date.now();
      await next();
      const duration = Date.now() - start;
      ctx.res.headers['X-Response-Time'] = `${duration}ms`;
    });

    // 请求 ID 中间件
    router.use(async (ctx, next) => {
      ctx.res.headers['X-Request-ID'] = 'req-123';
      await next();
    });

    router.get('/test', (ctx) => {
      ctx.res.body = { message: 'ok' };
    });

    const response = await router.handle('GET', '/test');

    expect(response.headers['X-Request-ID']).toBe('req-123');
    expect(response.headers['X-Response-Time']).toBeDefined();
    expect(response.body).toEqual({ message: 'ok' });
  });

  // Test 9: 多种 HTTP 方法
  it('should support all HTTP methods', async () => {
    const router = createRouter();

    router.get('/resource', (ctx) => { ctx.res.body = { method: 'GET' }; });
    router.post('/resource', (ctx) => { ctx.res.body = { method: 'POST' }; });
    router.put('/resource', (ctx) => { ctx.res.body = { method: 'PUT' }; });
    router.delete('/resource', (ctx) => { ctx.res.body = { method: 'DELETE' }; });
    router.patch('/resource', (ctx) => { ctx.res.body = { method: 'PATCH' }; });

    const getRes = await router.handle('GET', '/resource');
    const postRes = await router.handle('POST', '/resource');
    const putRes = await router.handle('PUT', '/resource');
    const deleteRes = await router.handle('DELETE', '/resource');
    const patchRes = await router.handle('PATCH', '/resource');

    expect(getRes.body).toEqual({ method: 'GET' });
    expect(postRes.body).toEqual({ method: 'POST' });
    expect(putRes.body).toEqual({ method: 'PUT' });
    expect(deleteRes.body).toEqual({ method: 'DELETE' });
    expect(patchRes.body).toEqual({ method: 'PATCH' });
  });

  // Test 10: 复杂路径参数
  it('should handle multiple path parameters', async () => {
    const router = createRouter();

    router.get('/users/:userId/posts/:postId', (ctx) => {
      ctx.res.body = {
        userId: ctx.params.userId,
        postId: ctx.params.postId,
      };
    });

    const response = await router.handle('GET', '/users/42/posts/100');

    expect(response.statusCode).toBe(200);
    expect(response.body).toEqual({ userId: '42', postId: '100' });
  });

  // Test 11: 中间件短路（不调用 next）
  it('should throw error when middleware does not call next', async () => {
    const router = createRouter();

    router.use(async () => {
      // 不调用 next
    });

    router.get('/test', (ctx) => {
      ctx.res.body = { message: 'ok' };
    });

    const response = await router.handle('GET', '/test');

    expect(response.statusCode).toBe(500);
    expect(response.body).toEqual({ error: 'Middleware did not call next()' });
  });

  // Test 12: 状态码设置
  it('should allow handler to set custom status code', async () => {
    const router = createRouter();

    router.post('/created', (ctx) => {
      ctx.res.statusCode = 201;
      ctx.res.body = { id: '123' };
    });

    const response = await router.handle('POST', '/created');

    expect(response.statusCode).toBe(201);
    expect(response.body).toEqual({ id: '123' });
  });
});
```

## 设计说明

### 核心特性

1. **路由系统**
   - 支持 `:param` 风格的路径参数
   - 支持 `GET`, `POST`, `PUT`, `DELETE`, `PATCH` 方法
   - 自动解析 URL 查询参数

2. **中间件管道**
   - 全局中间件：`router.use(middleware)`
   - 路径前缀中间件：`router.use('/api', middleware)`
   - 洋葱模型：通过递归构建执行链实现

3. **Context 对象**
   - `req`: 请求信息（method, url, headers, body）
   - `res`: 响应信息（statusCode, headers, body）
   - `params`: 路径参数
   - `query`: 查询参数

4. **错误处理**
   - 404: 路由未匹配时返回 `{ error: "Not Found", path }`
   - 500: 处理异常时返回 `{ error: message }`

### 洋葱模型实现

中间件链通过从后向前递归构建：

```
执行顺序:
  middleware1 (before)
    middleware2 (before)
      handler
    middleware2 (after)
  middleware1 (after)
```

这种结构确保每个中间件可以在 `next()` 之前处理请求，在 `next()` 之后处理响应。
