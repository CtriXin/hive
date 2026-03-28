# Round 3 TASK3 — Spec Adherence (Router with contradictory specs) 原始答案

## glm-4.7
**耗时: 80849ms**

```typescript
/**
 * Router module with conflict resolution: A (ERRATA) > B (Design Spec) > C (Impl Guide)
 * 1. Priority: exact > param > wildcard (Document A overrides B)
 * 2. Timeout unit: milliseconds (Document A overrides C)
 * 3. 404 format: { error, path } (Document A overrides C)
 */

type Middleware = (req: Request) => Promise<Response> | Response;
type Handler = (req: Request) => Promise<Response>;

interface RouteConfig { handler: string; timeout: number; middleware: string[]; }

const handlers: Record<string, Handler> = {};
const middlewares: Record<string, Middleware> = {};

class Router {
  private routes: Map<string, RouteConfig>;
  constructor() { this.routes = new Map(); }

  addRoute(path: string, config: RouteConfig) { this.routes.set(path, config); }
  static registerHandler(name: string, fn: Handler) { handlers[name] = fn; }
  static registerMiddleware(name: string, fn: Middleware) { middlewares[name] = fn; }

  private matchRoute(path: string): { config: RouteConfig; params: Record<string, string> } | null {
    if (this.routes.has(path)) return { config: this.routes.get(path)!, params: {} };

    let bestParamMatch: { path: string; config: RouteConfig; params: Record<string, string> } | null = null;
    let bestWildcardMatch: { path: string; config: RouteConfig } | null = null;

    for (const [routePath, config] of this.routes.entries()) {
      if (routePath.includes(':')) {
        const regexStr = routePath.replace(/:([^/]+)/g, '([^/]+)');
        const regex = new RegExp('^' + regexStr + '$');
        const match = path.match(regex);
        if (match) {
          const paramNames = (routePath.match(/:([^/]+)/g) || []).map(s => s.substring(1));
          const params: Record<string, string> = {};
          paramNames.forEach((name, index) => { params[name] = match[index + 1]; });
          if (!bestParamMatch) bestParamMatch = { path: routePath, config, params };
        }
      }
      if (routePath.includes('*')) {
        const regexStr = routePath.replace('*', '.*');
        const regex = new RegExp('^' + regexStr);
        if (regex.test(path)) { if (!bestWildcardMatch) bestWildcardMatch = { path: routePath, config }; }
      }
    }
    if (bestParamMatch) return bestParamMatch;
    return bestWildcardMatch;
  }

  async handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;
    const match = this.matchRoute(path);
    if (!match) {
      return new Response(JSON.stringify({ error: "Not Found", path }), { status: 404, headers: { "Content-Type": "application/json" } });
    }
    const { config, params } = match;
    const handlerFn = handlers[config.handler];
    if (!handlerFn) return new Response(JSON.stringify({ error: "Handler not implemented", path }), { status: 500, headers: { "Content-Type": "application/json" } });
    let processedReq = req;
    (processedReq as any).params = params;
    for (const mwName of config.middleware) {
      const mw = middlewares[mwName];
      if (mw) { const res = await mw(processedReq); if (res) return res; }
    }
    return Promise.race([
      handlerFn(processedReq),
      new Promise<Response>((_, reject) => setTimeout(() => reject(new Error("Timeout")), config.timeout))
    ]).catch((err) => {
      if (err.message === "Timeout") return new Response(JSON.stringify({ error: "Gateway Timeout" }), { status: 504, headers: { "Content-Type": "application/json" } });
      throw err;
    });
  }
}

// Tests
async function runTests() {
  const router = new Router();
  Router.registerHandler('exactHandler', async (req) => new Response(JSON.stringify({ type: 'exact', data: 'data' })));
  Router.registerHandler('paramHandler', async (req) => { const id = (req as any).params.id; return new Response(JSON.stringify({ type: 'param', id })); });
  Router.registerHandler('wildcardHandler', async (req) => new Response(JSON.stringify({ type: 'wildcard' })));

  router.addRoute('/api/*', { handler: 'wildcardHandler', timeout: 5000, middleware: [] });
  router.addRoute('/users/:id', { handler: 'paramHandler', timeout: 5000, middleware: [] });
  router.addRoute('/users/123', { handler: 'exactHandler', timeout: 5000, middleware: [] });

  // Test 1: Exact > Param
  const req1 = new Request('http://example.com/users/123');
  const res1 = await router.handle(req1);
  const body1 = await res1.json();
  console.log('Test 1 (Exact > Param):', body1.type === 'exact' ? 'PASS' : 'FAIL');

  router.addRoute('/*', { handler: 'wildcardHandler', timeout: 5000, middleware: [] });
  // Test 2: Param > Wildcard
  const req2 = new Request('http://example.com/users/456');
  const res2 = await router.handle(req2);
  const body2 = await res2.json();
  console.log('Test 2 (Param > Wildcard):', body2.type === 'param' ? 'PASS' : 'FAIL');

  // Test 3: Wildcard fallback
  const req3 = new Request('http://example.com/products/list');
  const res3 = await router.handle(req3);
  const body3 = await res3.json();
  console.log('Test 3 (Wildcard Fallback):', body3.type === 'wildcard' ? 'PASS' : 'FAIL');

  // Test 4: 404 format
  const strictRouter = new Router();
  strictRouter.addRoute('/only_this', { handler: 'exactHandler', timeout: 5000, middleware: [] });
  const req4 = new Request('http://example.com/not_found');
  const res4 = await strictRouter.handle(req4);
  const body4 = await res4.json();
  console.log('Test 4 (404 Format):', res4.status === 404 && body4.path === '/not_found' ? 'PASS' : 'FAIL');
}

runTests();
```
