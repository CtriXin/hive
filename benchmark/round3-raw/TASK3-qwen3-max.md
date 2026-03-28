# Round 3 TASK3 — Spec Adherence (Router with contradictory specs) 原始答案

## qwen3-max
**耗时: 78284ms**

```typescript
/**
 * API Gateway Router - Conflict Resolution: A (ERRATA) > B (Design Spec) > C (Impl Guide)
 */

interface RouteConfig { handler: string; timeout: number; middleware: string[]; }
type HandlerFunction = (req: Request) => Promise<Response>;

class Router {
  private routes: Map<string, RouteConfig> = new Map();
  private handlers: Map<string, HandlerFunction> = new Map();

  addRoute(path: string, config: RouteConfig): void { this.routes.set(path, config); }
  addHandler(name: string, handler: HandlerFunction): void { this.handlers.set(name, handler); }

  async handleRequest(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const matchResult = this.findMatchingRoute(path);
    if (!matchResult) {
      return new Response(JSON.stringify({ error: "Not Found", path: path }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    const { routePath, params } = matchResult;
    const routeConfig = this.routes.get(routePath)!;
    const handler = this.handlers.get(routeConfig.handler);
    if (!handler) return new Response(JSON.stringify({ error: "Handler not found", path: path }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    const reqWithParams = this.attachParamsToRequest(req, params);
    try {
      const timeoutPromise = new Promise<Response>((_, reject) => { setTimeout(() => reject(new Error('Request timeout')), routeConfig.timeout); });
      const responsePromise = handler(reqWithParams);
      const response = await Promise.race([responsePromise, timeoutPromise]);
      return response;
    } catch (error) {
      if (error instanceof Error && error.message === 'Request timeout') return new Response(JSON.stringify({ error: "Request timeout" }), { status: 504, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ error: "Internal Server Error" }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
  }

  private findMatchingRoute(path: string): { routePath: string; params: Record<string, string> } | null {
    if (this.routes.has(path)) return { routePath: path, params: {} };
    for (const routePath of this.routes.keys()) {
      if (routePath.includes('/:')) { const params = this.matchParamRoute(routePath, path); if (params !== null) return { routePath, params }; }
    }
    for (const routePath of this.routes.keys()) {
      if (routePath.endsWith('/*')) { const wildcardMatch = this.matchWildcardRoute(routePath, path); if (wildcardMatch) return { routePath, params: { '*': path.substring(routePath.length - 1) } }; }
    }
    return null;
  }

  private matchParamRoute(routePath: string, actualPath: string): Record<string, string> | null {
    const routeParts = routePath.split('/');
    const actualParts = actualPath.split('/');
    if (routeParts.length !== actualParts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) params[routeParts[i].substring(1)] = actualParts[i];
      else if (routeParts[i] !== actualParts[i]) return null;
    }
    return params;
  }

  private matchWildcardRoute(routePath: string, actualPath: string): boolean {
    const basePath = routePath.substring(0, routePath.length - 1);
    return actualPath.startsWith(basePath);
  }

  private attachParamsToRequest(req: Request, params: Record<string, string>): Request {
    (req as any).params = params;
    return req;
  }
}

function runTests() {
  const router = new Router();
  router.addHandler('exactHandler', async (req) => new Response(JSON.stringify({ matched: 'exact', params: (req as any).params || {} })));
  router.addHandler('paramHandler', async (req) => new Response(JSON.stringify({ matched: 'param', params: (req as any).params || {} })));
  router.addHandler('wildcardHandler', async (req) => new Response(JSON.stringify({ matched: 'wildcard', params: (req as any).params || {} })));

  router.addRoute('/api/users/123', { handler: 'exactHandler', timeout: 5000, middleware: [] });
  router.addRoute('/api/users/:id', { handler: 'paramHandler', timeout: 5000, middleware: [] });
  router.addRoute('/api/*', { handler: 'wildcardHandler', timeout: 5000, middleware: [] });

  const test1 = async () => {
    const req = new Request('http://example.com/api/users/123');
    const res = await router.handleRequest(req);
    const data = await res.json();
    console.assert(data.matched === 'exact');
    console.log("Test 1 passed: Exact match highest priority");
  };
  const test2 = async () => {
    const req = new Request('http://example.com/api/users/456');
    const res = await router.handleRequest(req);
    const data = await res.json();
    console.assert(data.matched === 'param');
    console.assert(data.params.id === '456');
    console.log("Test 2 passed: Param > Wildcard");
  };
  const test3 = async () => {
    const req = new Request('http://example.com/api/anything/else');
    const res = await router.handleRequest(req);
    const data = await res.json();
    console.assert(data.matched === 'wildcard');
    console.log("Test 3 passed: Wildcard fallback");
  };
  const test4 = async () => {
    const req = new Request('http://example.com/nonexistent');
    const res = await router.handleRequest(req);
    console.assert(res.status === 404);
    const data = await res.json();
    console.assert(data.error === "Not Found");
    console.assert(data.path === '/nonexistent');
    console.log("Test 4 passed: 404 format correct");
  };

  Promise.all([test1(), test2(), test3(), test4()])
    .then(() => console.log("All tests passed!"))
    .catch(err => console.error("Test failed:", err));
}

if (typeof window === 'undefined' && typeof require !== 'undefined') {
  global.Request = class Request { url: string; constructor(url: string) { this.url = url; } } as any;
  global.Response = class Response { body: any; status: number; headers: Headers; constructor(body: any, options?: { status?: number; headers?: Record<string, string> }) { this.body = body; this.status = options?.status || 200; this.headers = new Headers(options?.headers || {}); } async json() { return JSON.parse(this.body); } } as any;
  global.Headers = class Headers { constructor(init?: Record<string, string>) {} } as any;
  runTests();
}

export { Router, RouteConfig };
```
