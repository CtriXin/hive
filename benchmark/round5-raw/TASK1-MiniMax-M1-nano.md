# TASK1: 轻量级 HTTP 路由器（带中间件管道）

## TypeScript 实现

```typescript
// router.ts
export interface Context {
  request: Request;
  url: URL;
  params: Record<string, string>;
  state: Record<string, unknown>;
  response?: Response;
}

export type Middleware = (
  ctx: Context,
  next: () => Promise<void>
) => Promise<void>;

export type Handler = Middleware;

interface Route {
  method: string;
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: Handler;
}

interface MiddlewareLayer {
  prefix: string;
  middleware: Middleware;
}

export class Router {
  private routes: Route[] = [];
  private middlewares: MiddlewareLayer[] = [];

  get(pattern: string, handler: Handler): void {
    this.addRoute("GET", pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.addRoute("POST", pattern, handler);
  }

  put(pattern: string, handler: Handler): void {
    this.addRoute("PUT", pattern, handler);
  }

  delete(pattern: string, handler: Handler): void {
    this.addRoute("DELETE", pattern, handler);
  }

  patch(pattern: string, handler: Handler): void {
    this.addRoute("PATCH", pattern, handler);
  }

  use(prefixOrMiddleware: string | Middleware, maybeMiddleware?: Middleware): void {
    const prefix = typeof prefixOrMiddleware === "string" ? prefixOrMiddleware : "/";
    const middleware = typeof prefixOrMiddleware === "string" ? maybeMiddleware! : prefixOrMiddleware;
    this.middlewares.push({ prefix, middleware });
  }

  private addRoute(method: string, pattern: string, handler: Handler): void {
    const { regex, paramNames } = this.buildPattern(pattern);
    this.routes.push({ method, pattern, regex, paramNames, handler });
  }

  private buildPattern(pattern: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    const normalized = pattern.replace(/\/$/, "") || "/";
    const regexSource = normalized.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return "([^/]+)";
    });
    const regex = new RegExp(`^${regexSource.replace(/\//g, "\\/")}$`);
    return { regex, paramNames };
  }

  async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const ctx: Context = {
      request,
      url,
      params: {},
      state: {},
    };

    try {
      const match = this.findRoute(request.method, url.pathname);
      if (!match) {
        return new Response(
          JSON.stringify({ error: "Not Found", path: url.pathname }),
          { status: 404, headers: { "Content-Type": "application/json" } }
        );
      }

      ctx.params = match.params;
      const stack = this.buildMiddlewareStack(match.route.handler, url.pathname);
      await stack(ctx);

      return ctx.response ?? new Response(null, { status: 204 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return new Response(
        JSON.stringify({ error: message }),
        { status: 500, headers: { "Content-Type": "application/json" } }
      );
    }
  }

  private findRoute(
    method: string,
    pathname: string
  ): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.regex);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, index) => {
          params[name] = match[index + 1]!;
        });
        return { route, params };
      }
    }
    return null;
  }

  private buildMiddlewareStack(finalHandler: Handler, pathname: string): Middleware {
    const matched = this.middlewares.filter((m) =>
      pathname === m.prefix || pathname.startsWith(m.prefix.replace(/\/$/, "") + "/")
    );
    const stack = [...matched.map((m) => m.middleware), finalHandler];

    return async (ctx: Context) => {
      let index = 0;
      const next = async (): Promise<void> => {
        if (index >= stack.length) return;
        const mw = stack[index++]!;
        await mw(ctx, next);
      };
      await next();
    };
  }
}

export function createRouter(): Router {
  return new Router();
}
```

## 测试文件

```typescript
// router.test.ts
import { assertEquals } from "https://deno.land/std@0.200.0/testing/asserts.ts";
import { Context, createRouter, Middleware } from "./router.ts";

Deno.test("GET /users/:id returns params and body", async () => {
  const router = createRouter();
  router.get("/users/:id", async (ctx, next) => {
    await next();
    ctx.response = new Response(`User ${ctx.params.id}`);
  });

  const req = new Request("http://localhost/users/42");
  const res = await router.handle(req);
  assertEquals(res.status, 200);
  assertEquals(await res.text(), "User 42");
});

Deno.test("404 returns structured JSON", async () => {
  const router = createRouter();
  const req = new Request("http://localhost/missing");
  const res = await router.handle(req);
  assertEquals(res.status, 404);
  assertEquals(await res.json(), { error: "Not Found", path: "/missing" });
});

Deno.test("500 returns error message for thrown exception", async () => {
  const router = createRouter();
  router.get("/boom", async () => {
    throw new Error("Something went wrong");
  });

  const req = new Request("http://localhost/boom");
  const res = await router.handle(req);
  assertEquals(res.status, 500);
  assertEquals(await res.json(), { error: "Something went wrong" });
});

Deno.test("global middleware runs before and after handler (onion model)", async () => {
  const router = createRouter();
  const order: string[] = [];

  const mw: Middleware = async (ctx, next) => {
    order.push("before");
    await next();
    order.push("after");
    ctx.response = new Response(JSON.stringify(order));
  };

  router.use(mw);
  router.get("/test", async (ctx, next) => {
    order.push("handler");
    await next();
  });

  const req = new Request("http://localhost/test");
  const res = await router.handle(req);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), ["before", "handler", "after"]);
});

Deno.test("prefix middleware only matches path prefix", async () => {
  const router = createRouter();
  const hits: string[] = [];

  router.use("/api", async (ctx, next) => {
    hits.push("api");
    await next();
  });

  router.get("/api/users", async (ctx, next) => {
    await next();
    ctx.response = new Response("ok");
  });

  router.get("/other", async (ctx, next) => {
    await next();
    ctx.response = new Response("ok");
  });

  const apiReq = new Request("http://localhost/api/users");
  const otherReq = new Request("http://localhost/other");

  await router.handle(apiReq);
  await router.handle(otherReq);

  assertEquals(hits, ["api"]);
});

Deno.test("multiple middleware layers compose in order", async () => {
  const router = createRouter();
  const order: number[] = [];

  router.use(async (ctx, next) => {
    order.push(1);
    await next();
    order.push(4);
  });

  router.use("/api", async (ctx, next) => {
    order.push(2);
    await next();
    order.push(5);
  });

  router.get("/api/data", async (ctx, next) => {
    order.push(3);
    await next();
    ctx.response = new Response("done");
  });

  const req = new Request("http://localhost/api/data");
  const res = await router.handle(req);

  assertEquals(res.status, 200);
  assertEquals(order, [1, 2, 3, 5, 4]);
});
```

## 运行方式

```bash
deno test router.test.ts
```

## 设计说明

- **Context**：统一上下文，包含 `request`、`url`、`params`、`state`、`response`。
- **中间件签名**：`(ctx, next) => Promise<void>`，严格异步洋葱模型。
- **路由匹配**：将 `:param` 转换为正则捕获组，按注册顺序匹配。
- **中间件前缀匹配**：`pathname === prefix` 或 `pathname.startsWith(prefix + "/")`。
- **错误处理**：统一捕获异常，返回 `500 + { error: message }`；无匹配路由返回 `404 + { error: "Not Found", path }`。
- **无外部依赖**：仅使用 Deno 标准断言测试；标准 `Request` / `Response` 为 Web API。
