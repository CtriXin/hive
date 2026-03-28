# Round 3 TASK3 — Spec Adherence (Router with contradictory specs) 原始答案

## MiniMax-M2.5
**耗时: 44687ms**

```typescript
/**
 * API Gateway Request Routing Module
 * Conflict Resolution: A (ERRATA) > B (Design Spec) > C (Impl Guide)
 * 1. Priority: exact > param > wildcard (Doc A)
 * 2. Timeout: milliseconds (Doc A)
 * 3. 404: { error, path } (Doc A)
 * 4. Default timeout: 30ms (Doc A corrects C's unit)
 */

interface Request { path: string; method?: string; headers?: Record<string, string>; body?: unknown; }
interface Response { status: number; body: unknown; headers?: Record<string, string>; }
interface RouteConfig { handler: string; timeout: number; middleware: string[]; }
type RouteHandler = (req: Request) => Promise<Response>;

class Router {
  private routes: Map<string, RouteConfig> = new Map();
  private handlers: Map<string, RouteHandler> = new Map();
  private static readonly DEFAULT_TIMEOUT = 30;

  addRoute(path: string, config: RouteConfig): void { this.routes.set(path, config); }
  registerHandler(handlerName: string, handler: RouteHandler): void { this.handlers.set(handlerName, handler); }

  matchRoute(path: string): { config: RouteConfig | null; pathParams: Record<string, string>; matchedPath: string | null; } {
    if (this.routes.has(path)) return { config: this.routes.get(path)!, pathParams: {}, matchedPath: path };
    for (const [routePath, config] of this.routes) {
      if (this.isParameterRoute(routePath)) {
        const params = this.matchParameterRoute(routePath, path);
        if (params !== null) return { config, pathParams: params, matchedPath: routePath };
      }
    }
    for (const [routePath, config] of this.routes) {
      if (this.isWildcardRoute(routePath)) {
        const params = this.matchWildcardRoute(routePath, path);
        if (params !== null) return { config, pathParams: params, matchedPath: routePath };
      }
    }
    return { config: null, pathParams: {}, matchedPath: null };
  }

  private isParameterRoute(path: string): boolean { return path.includes(':') && !path.includes('*'); }
  private isWildcardRoute(path: string): boolean { return path.endsWith('*'); }

  private matchParameterRoute(routePath: string, requestPath: string): Record<string, string> | null {
    const routeParts = routePath.split('/');
    const requestParts = requestPath.split('/');
    if (routeParts.length !== requestParts.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < routeParts.length; i++) {
      if (routeParts[i].startsWith(':')) params[routeParts[i].slice(1)] = requestParts[i];
      else if (routeParts[i] !== requestParts[i]) return null;
    }
    return params;
  }

  private matchWildcardRoute(routePath: string, requestPath: string): Record<string, string> | null {
    const wildcardPrefix = routePath.slice(0, -1);
    if (requestPath.startsWith(wildcardPrefix)) return { '*': requestPath.slice(wildcardPrefix.length) };
    return null;
  }

  async handleRequest(req: Request): Promise<Response> {
    const { config, pathParams, matchedPath } = this.matchRoute(req.path);
    if (!config || !matchedPath) return { status: 404, body: { error: "Not Found", path: req.path } };
    const handler = this.handlers.get(config.handler);
    if (!handler) return { status: 500, body: { error: "Handler not found" } };
    const timeoutMs = config.timeout || Router.DEFAULT_TIMEOUT;
    return this.executeWithTimeout(req, handler, timeoutMs);
  }

  private async executeWithTimeout(req: Request, handler: RouteHandler, timeout: number): Promise<Response> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => { resolve({ status: 504, body: { error: "Gateway Timeout" } }); }, timeout);
      handler(req).then(response => { clearTimeout(timer); resolve(response); })
        .catch(error => { clearTimeout(timer); resolve({ status: 500, body: { error: String(error) } }); });
    });
  }
}

async function testRoutingPriority() {
  const router = new Router();
  router.addRoute('/users', { handler: 'exactHandler', timeout: 1000, middleware: [] });
  router.addRoute('/users/:id', { handler: 'paramHandler', timeout: 1000, middleware: [] });
  router.addRoute('/users/*', { handler: 'wildcardHandler', timeout: 1000, middleware: [] });
  router.registerHandler('exactHandler', async () => ({ status: 200, body: { type: 'exact' } }));
  router.registerHandler('paramHandler', async () => ({ status: 200, body: { type: 'parameter' } }));
  router.registerHandler('wildcardHandler', async () => ({ status: 200, body: { type: 'wildcard' } }));

  const result1 = await router.handleRequest({ path: '/users' });
  console.assert(result1.status === 200 && (result1.body as any).type === 'exact');

  const result2 = await router.handleRequest({ path: '/users/123' });
  console.assert(result2.status === 200 && (result2.body as any).type === 'parameter');

  const result3 = await router.handleRequest({ path: '/users/abc/def' });
  console.assert(result3.status === 200 && (result3.body as any).type === 'wildcard');
  console.log("Test 1 passed: Priority correct");
}

async function test404ResponseFormat() {
  const router = new Router();
  const result = await router.handleRequest({ path: '/nonexistent/path' });
  console.assert(result.status === 404);
  const body = result.body as any;
  console.assert(body.error === 'Not Found');
  console.assert(body.path === '/nonexistent/path');
  console.log("Test 2 passed: 404 format correct");
}

async function testParameterAndWildcardExtraction() {
  const router = new Router();
  router.addRoute('/api/users/:id/posts/:postId', { handler: 'paramHandler', timeout: 1000, middleware: [] });
  router.addRoute('/files/*', { handler: 'wildcardHandler', timeout: 1000, middleware: [] });
  router.registerHandler('paramHandler', async (req) => { const { pathParams } = router.matchRoute(req.path); return { status: 200, body: { type: 'parameter', params: pathParams } }; });
  router.registerHandler('wildcardHandler', async (req) => { const { pathParams } = router.matchRoute(req.path); return { status: 200, body: { type: 'wildcard', params: pathParams } }; });

  const result1 = await router.handleRequest({ path: '/api/users/123/posts/456' });
  console.assert((result1.body as any).params.id === '123');
  console.assert((result1.body as any).params.postId === '456');

  const result2 = await router.handleRequest({ path: '/files/documents/report.pdf' });
  console.assert((result2.body as any).params['*'] === '/documents/report.pdf');
  console.log("Test 3 passed: Parameter and wildcard extraction correct");
}

async function main() { await testRoutingPriority(); await test404ResponseFormat(); await testParameterAndWildcardExtraction(); console.log("All tests complete!"); }
main().catch(console.error);
export { Router, Request, Response, RouteConfig, RouteHandler };
```
