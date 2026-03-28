# Round 3 TASK3 — Spec Adherence (Router with contradictory specs) 原始答案

## glm-5-turbo
**耗时: 31191ms**

```typescript
/**
 * API Gateway Request Routing Module
 * Priority: A (ERRATA) > B (Design Spec) > C (Implementation Guide)
 */

type Handler = (req: Request) => Promise<Response>;

interface RouteConfig {
  handler: Handler;
  timeout: number;
  middleware: string[];
}

interface ParsedRoute {
  type: 'exact' | 'param' | 'wildcard';
  pattern: string;
  config: RouteConfig;
  paramNames: string[];
}

class Router {
  private exactRoutes: Map<string, RouteConfig> = new Map();
  private paramRoutes: ParsedRoute[] = [];
  private wildcardRoutes: ParsedRoute[] = [];
  private defaultTimeout: number;

  constructor() {
    // CONFLICT: Document C says 30 seconds, Document A says milliseconds
    // Resolution: Use Document A - 30000ms
    this.defaultTimeout = 30000;
  }

  addRoute(pattern: string, config: RouteConfig): void {
    if (pattern.includes('*')) {
      this.wildcardRoutes.push({ type: 'wildcard', pattern, config, paramNames: [] });
    } else if (pattern.includes(':')) {
      const paramNames: string[] = [];
      const regexStr = '^' + pattern.replace(/:([^/]+)/g, (_, paramName) => { paramNames.push(paramName); return '([^/]+)'; }) + '$';
      this.paramRoutes.push({ type: 'param', pattern, config, paramNames });
      (this.paramRoutes[this.paramRoutes.length - 1] as any)._regex = new RegExp(regexStr);
    } else {
      this.exactRoutes.set(pattern, config);
    }
  }

  async route(reqPath: string, req: Request): Promise<Response> {
    // CONFLICT: Document B says wildcard > param > exact
    // Document A says exact > param > wildcard
    // Resolution: Document A (highest priority)
    let matchedConfig: RouteConfig | null = null;
    let extractedParams: Record<string, string> = {};

    if (this.exactRoutes.has(reqPath)) {
      matchedConfig = this.exactRoutes.get(reqPath)!;
    }
    if (!matchedConfig) {
      for (const route of this.paramRoutes) {
        const regex = (route as any)._regex as RegExp;
        const match = reqPath.match(regex);
        if (match) {
          matchedConfig = route.config;
          route.paramNames.forEach((name, index) => { extractedParams[name] = match[index + 1]; });
          break;
        }
      }
    }
    if (!matchedConfig) {
      for (const route of this.wildcardRoutes) {
        const prefix = route.pattern.replace('/*', '');
        if (reqPath.startsWith(prefix + '/') || reqPath === prefix) {
          matchedConfig = route.config; break;
        }
      }
    }

    if (!matchedConfig) {
      // CONFLICT: Document C omits path field, Document A requires it
      // Resolution: Document A
      return new Response(JSON.stringify({ error: "Not Found", path: reqPath }), {
        status: 404, headers: { 'Content-Type': 'application/json' }
      });
    }

    const timeout = matchedConfig.timeout || this.defaultTimeout;
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        resolve(new Response(JSON.stringify({ error: "Gateway Timeout" }), { status: 504, headers: { 'Content-Type': 'application/json' } }));
      }, timeout);
      matchedConfig!.handler(req).then(response => { clearTimeout(timer); resolve(response); })
        .catch(error => { clearTimeout(timer); resolve(new Response(JSON.stringify({ error: "Internal Server Error", details: String(error) }), { status: 500, headers: { 'Content-Type': 'application/json' } })); });
    });
  }
}

// Tests
async function mockRouteTest(router: Router, path: string, req?: Request): Promise<{ status: number; body: any }> {
  const request = req || new Request('http://localhost' + path);
  const res = await router.route(path, request);
  const body = await res.json();
  return { status: res.status, body };
}

async function runTests() {
  const router = new Router();
  let passed = 0;
  const exactHandler = async () => new Response(JSON.stringify({ type: 'exact' }), { headers: { 'Content-Type': 'application/json' } });
  const paramHandler = async () => new Response(JSON.stringify({ type: 'param' }), { headers: { 'Content-Type': 'application/json' } });
  const wildcardHandler = async () => new Response(JSON.stringify({ type: 'wildcard' }), { headers: { 'Content-Type': 'application/json' } });

  router.addRoute('/api/*', { handler: wildcardHandler, timeout: 5000, middleware: ['auth'] });
  router.addRoute('/api/users/:id', { handler: paramHandler, timeout: 5000, middleware: ['auth'] });
  router.addRoute('/api/users/me', { handler: exactHandler, timeout: 5000, middleware: ['auth'] });

  // Test 1: Exact > Param
  const test1 = await mockRouteTest(router, '/api/users/me');
  if (test1.status === 200 && test1.body.type === 'exact') { console.log('Test 1 Passed'); passed++; }
  else console.log('Test 1 Failed', test1);

  // Test 2: Param > Wildcard
  const test2 = await mockRouteTest(router, '/api/users/123');
  if (test2.status === 200 && test2.body.type === 'param') { console.log('Test 2 Passed'); passed++; }
  else console.log('Test 2 Failed', test2);

  // Test 3: Wildcard fallback + 404 with path field
  const test3a = await mockRouteTest(router, '/api/posts');
  const test3b = await mockRouteTest(router, '/unknown/path');
  const test3aPass = test3a.status === 200 && test3a.body.type === 'wildcard';
  const test3bPass = test3b.status === 404 && test3b.body.error === "Not Found" && test3b.body.path === '/unknown/path';
  if (test3aPass && test3bPass) { console.log('Test 3 Passed'); passed++; }
  else console.log('Test 3 Failed');

  console.log('Result: ' + passed + '/3 passed');
}

runTests().catch(console.error);
export { Router, RouteConfig, Handler };
```
