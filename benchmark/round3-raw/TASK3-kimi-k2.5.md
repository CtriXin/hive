# Round 3 TASK3 — Spec Adherence (Router with contradictory specs) 原始答案

## kimi-k2.5
**耗时: 65598ms**

```typescript
/**
 * API Gateway Router Module
 * Priority resolution: Document A (ERRATA) > Document B (Design Spec) > Document C (Implementation Guide)
 */

interface Request {
  path: string;
  method: string;
  headers: Record<string, string>;
  body?: unknown;
}

interface Response {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}

interface RouteConfig {
  handler: string;
  timeout: number; // milliseconds - Document A overrides Document C's "seconds"
  middleware: string[];
}

interface RouteMatch {
  config: RouteConfig;
  params: Record<string, string>;
}

class Router {
  private routes: Map<string, RouteConfig> = new Map();
  private exactRoutes: Map<string, RouteConfig> = new Map();
  private paramRoutes: Map<string, RouteConfig> = new Map();
  private wildcardRoutes: Map<string, RouteConfig> = new Map();

  register(path: string, config: RouteConfig): void {
    const finalConfig: RouteConfig = {
      timeout: config.timeout ?? 30000,
      middleware: config.middleware ?? [],
      handler: config.handler
    };
    this.routes.set(path, finalConfig);
    if (path.includes('*')) {
      this.wildcardRoutes.set(path, finalConfig);
    } else if (path.includes(':')) {
      this.paramRoutes.set(path, finalConfig);
    } else {
      this.exactRoutes.set(path, finalConfig);
    }
  }

  match(requestPath: string): RouteMatch | null {
    const exact = this.exactRoutes.get(requestPath);
    if (exact) return { config: exact, params: {} };

    const paramMatch = this.matchParamRoute(requestPath);
    if (paramMatch) return paramMatch;

    const wildcardMatch = this.matchWildcardRoute(requestPath);
    if (wildcardMatch) return wildcardMatch;
    return null;
  }

  private matchParamRoute(requestPath: string): RouteMatch | null {
    const requestParts = requestPath.split('/').filter(p => p);
    for (const [pattern, config] of this.paramRoutes) {
      const patternParts = pattern.split('/').filter(p => p);
      if (patternParts.length !== requestParts.length) continue;
      const params: Record<string, string> = {};
      let matched = true;
      for (let i = 0; i < patternParts.length; i++) {
        if (patternParts[i].startsWith(':')) {
          params[patternParts[i].slice(1)] = requestParts[i];
        } else if (patternParts[i] !== requestParts[i]) {
          matched = false; break;
        }
      }
      if (matched) return { config, params };
    }
    return null;
  }

  private matchWildcardRoute(requestPath: string): RouteMatch | null {
    const sortedWildcards = Array.from(this.wildcardRoutes.entries()).sort((a, b) => b[0].length - a[0].length);
    for (const [pattern, config] of sortedWildcards) {
      const prefix = pattern.replace(/\*$/, '');
      if (requestPath.startsWith(prefix) || requestPath === prefix.slice(0, -1)) {
        const wildcardValue = requestPath.slice(prefix.length);
        return { config, params: wildcardValue ? { '*': wildcardValue } : {} };
      }
    }
    return null;
  }

  async handle(req: Request): Promise<Response> {
    const match = this.match(req.path);
    if (!match) {
      return { status: 404, headers: { 'Content-Type': 'application/json' }, body: { error: "Not Found", path: req.path } };
    }
    const { config, params } = match;
    return new Promise((resolve) => {
      const timeoutId = setTimeout(() => {
        resolve({ status: 504, headers: { 'Content-Type': 'application/json' }, body: { error: "Gateway Timeout" } });
      }, config.timeout);
      this.executeHandler(config, req, params).then((response) => { clearTimeout(timeoutId); resolve(response); })
        .catch(() => { clearTimeout(timeoutId); resolve({ status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: "Internal Server Error" } }); });
    });
  }

  private async executeHandler(config: RouteConfig, req: Request, params: Record<string, string>): Promise<Response> {
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { handler: config.handler, params, middleware: config.middleware } };
  }
}

// Tests
function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('FAIL: ' + message + '\nExpected: ' + JSON.stringify(expected) + '\nActual: ' + JSON.stringify(actual));
  console.log('PASS: ' + message);
}

function testExactPriority(): void {
  const router = new Router();
  router.register('/users/*', { handler: 'wildcard-users', timeout: 5000, middleware: [] });
  router.register('/users/:id', { handler: 'param-users', timeout: 5000, middleware: [] });
  router.register('/users/admin', { handler: 'exact-admin', timeout: 5000, middleware: [] });
  const match = router.match('/users/admin');
  assertEqual(match?.config.handler, 'exact-admin', 'Test 1: Exact match should win over param and wildcard');
}

function testParamPriority(): void {
  const router = new Router();
  router.register('/api/*', { handler: 'wildcard-api', timeout: 5000, middleware: [] });
  router.register('/api/:version/users', { handler: 'param-version-users', timeout: 5000, middleware: [] });
  const match = router.match('/api/v2/users');
  assertEqual(match?.config.handler, 'param-version-users', 'Test 2: Param match should win over wildcard');
  assertEqual(match?.params, { version: 'v2' }, 'Test 2: Params should be extracted correctly');
}

function testWildcardFallbackAnd404Format(): void {
  const router = new Router();
  router.register('/static/*', { handler: 'static-files', timeout: 5000, middleware: [] });
  const wildcardMatch = router.match('/static/css/main.css');
  assertEqual(wildcardMatch?.config.handler, 'static-files', 'Test 3a: Wildcard should match');
  assertEqual(wildcardMatch?.params['*'], 'css/main.css', 'Test 3a: Wildcard value captured');
  const noMatch = router.match('/nonexistent/path');
  assertEqual(noMatch, null, 'Test 3b: Unmatched path returns null');
}

function testTimeoutUnit(): void {
  const router = new Router();
  router.register('/fast', { handler: 'fast-handler', timeout: 100, middleware: [] });
  router.register('/default', { handler: 'default-handler', timeout: undefined as any, middleware: [] });
  const fastRoute = router.match('/fast');
  assertEqual(fastRoute?.config.timeout, 100, 'Test 4: Explicit timeout preserved');
  const routes = router['routes'];
  const defaultConfig = routes.get('/default');
  assertEqual(defaultConfig?.timeout, 30000, 'Test 4: Default timeout 30000ms');
}

console.log('=== Running Router Tests ===\n');
try {
  testExactPriority(); console.log('');
  testParamPriority(); console.log('');
  testWildcardFallbackAnd404Format(); console.log('');
  testTimeoutUnit(); console.log('\n=== All Tests Passed ===');
} catch (e) { console.error(e); process.exit(1); }

export { Router, type Request, type Response, type RouteConfig, type RouteMatch };
```
