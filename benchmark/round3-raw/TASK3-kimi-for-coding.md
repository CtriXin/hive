# Round 3 TASK3 — Spec Adherence (Router with contradictory specs) 原始答案

## kimi-for-coding
**耗时: 75684ms**

```typescript
// API Gateway Router Module
// Priority: A (ERRATA) > B (Design Spec) > C (Implementation Guide)

// ============================================================================
// Types
// ============================================================================

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
  timeout: number; // milliseconds (Document A overrides C)
  middleware: string[];
}

interface RouteMatch {
  config: RouteConfig;
  params: Record<string, string>;
}

// ============================================================================
// Router Implementation
// ============================================================================

class Router {
  // Using Map as specified in Document B
  private routes: Map<string, RouteConfig> = new Map();

  // Separated storage for different route types to implement correct priority
  private exactRoutes: Map<string, RouteConfig> = new Map();
  private paramRoutes: Array<{ pattern: RegExp; paramNames: string[]; original: string; config: RouteConfig }> = [];
  private wildcardRoutes: Array<{ prefix: string; config: RouteConfig }> = [];

  register(path: string, config: RouteConfig): void {
    // CONFLICT: Document C says timeout default is 30 seconds
    // Document A says unit is milliseconds (not seconds)
    // RESOLUTION: Use Document A - unit is milliseconds, default becomes 30000
    const normalizedConfig: RouteConfig = {
      ...config,
      timeout: config.timeout ?? 30000 // 30 seconds in milliseconds per Document A
    };

    this.routes.set(path, normalizedConfig);

    if (path.includes('*')) {
      const prefix = path.replace('/*', '');
      this.wildcardRoutes.push({ prefix, config: normalizedConfig });
    } else if (path.includes(':')) {
      const { pattern, paramNames } = this.buildParamPattern(path);
      this.paramRoutes.push({ pattern, paramNames, original: path, config: normalizedConfig });
    } else {
      this.exactRoutes.set(path, normalizedConfig);
    }

    // CONFLICT: Document B says priority is wildcard > param > exact
    // Document A (ERRATA) says priority is exact > param > wildcard
    // RESOLUTION: Document A has highest priority, so we use exact > param > wildcard
  }

  private buildParamPattern(path: string): { pattern: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    let regexStr = path.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    regexStr = regexStr.replace(/:([^/]+)/g, (match, paramName) => {
      paramNames.push(paramName);
      return '([^/]+)';
    });
    regexStr = '^' + regexStr + '$';
    return { pattern: new RegExp(regexStr), paramNames };
  }

  match(request: Request): RouteMatch | null {
    const { path } = request;

    // Priority 1: Exact match (Document A priority)
    const exactConfig = this.exactRoutes.get(path);
    if (exactConfig) {
      return { config: exactConfig, params: {} };
    }

    // Priority 2: Parameter routes (Document A priority)
    for (const route of this.paramRoutes) {
      const match = path.match(route.pattern);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, index) => {
          params[name] = match[index + 1];
        });
        return { config: route.config, params };
      }
    }

    // Priority 3: Wildcard routes (Document A priority)
    for (const route of this.wildcardRoutes) {
      if (path.startsWith(route.prefix + '/') || path === route.prefix) {
        return { config: route.config, params: {} };
      }
    }

    return null;
  }

  async handle(request: Request): Promise<Response> {
    const match = this.match(request);

    if (!match) {
      // CONFLICT: Document C says 404 body is { error: "Not Found" }
      // Document A (ERRATA) says must include path field: { error: string, path: string }
      // RESOLUTION: Document A - include path field
      return {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
        body: {
          error: 'Not Found',
          path: request.path
        }
      };
    }

    const { config, params } = match;
    const enhancedRequest = { ...request, params };
    return this.executeWithTimeout(enhancedRequest, config);
  }

  private async executeWithTimeout(
    request: Request & { params: Record<string, string> },
    config: RouteConfig
  ): Promise<Response> {
    return new Promise((resolve, reject) => {
      const timeoutMs = config.timeout;
      const timeoutId = setTimeout(() => {
        resolve({ status: 504, headers: { 'Content-Type': 'application/json' }, body: { error: 'Gateway Timeout' } });
      }, timeoutMs);

      this.simulateHandler(config.handler, request)
        .then((response) => { clearTimeout(timeoutId); resolve(response); })
        .catch((error) => { clearTimeout(timeoutId); resolve({ status: 500, headers: { 'Content-Type': 'application/json' }, body: { error: 'Internal Server Error', message: String(error) } }); });
    });
  }

  private async simulateHandler(handlerName: string, request: Request & { params: Record<string, string> }): Promise<Response> {
    return { status: 200, headers: { 'Content-Type': 'application/json' }, body: { handler: handlerName, path: request.path, params: request.params } };
  }

  public _testMatch(path: string): RouteMatch | null {
    return this.match({ path, method: 'GET', headers: {} });
  }
}

// Tests
function runTests(): void {
  console.log('Running Router Tests...\n');
  const router = new Router();
  router.register('/users/123', { handler: 'exact-user-handler', timeout: 5000, middleware: ['auth'] });
  router.register('/users/:id', { handler: 'param-user-handler', timeout: 10000, middleware: ['auth', 'validate'] });
  router.register('/users/*', { handler: 'wildcard-users-handler', timeout: 15000, middleware: [] });
  router.register('/api/health', { handler: 'health-check', timeout: 1000, middleware: [] });
  router.register('/api/:service/status', { handler: 'service-status', timeout: 2000, middleware: [] });
  router.register('/api/*', { handler: 'api-fallback', timeout: 5000, middleware: [] });

  let passed = 0;
  let failed = 0;
  function test(name: string, condition: boolean, details?: string): void {
    if (condition) { console.log('PASS: ' + name); passed++; }
    else { console.log('FAIL: ' + name); if (details) console.log('   Details: ' + details); failed++; }
  }

  // TEST 1: Exact match priority
  const exactMatch = router._testMatch('/users/123');
  test('Exact match returns exact-user-handler', exactMatch?.config.handler === 'exact-user-handler', 'Got: ' + exactMatch?.config.handler);
  test('Exact match has empty params', Object.keys(exactMatch?.params || {}).length === 0);

  // TEST 2: Parameter match priority
  const paramMatch = router._testMatch('/users/456');
  test('Param match returns param-user-handler', paramMatch?.config.handler === 'param-user-handler', 'Got: ' + paramMatch?.config.handler);
  test('Param match extracts id parameter', paramMatch?.params.id === '456');

  // TEST 3: Complex multi-level priority
  const apiExact = router._testMatch('/api/health');
  test('Exact /api/health matches health-check', apiExact?.config.handler === 'health-check');
  const apiParam = router._testMatch('/api/users/status');
  test('Param /api/:service/status matches service-status', apiParam?.config.handler === 'service-status');
  const apiWildcard = router._testMatch('/api/anything/else');
  test('Wildcard /api/* matches api-fallback', apiWildcard?.config.handler === 'api-fallback');

  // 404 and timeout verification
  const handleResult = router.handle({ path: '/nonexistent', method: 'GET', headers: {} });
  handleResult.then(response => {
    const body = response.body as any;
    test('404 response includes error field', body.error === 'Not Found');
    test('404 response includes path field', body.path === '/nonexistent');
  });

  const newRouter = new Router();
  newRouter.register('/test', { handler: 'test', timeout: undefined as any, middleware: [] });
  const testRoute = newRouter._testMatch('/test');
  test('Timeout defaults to 30000 milliseconds', testRoute?.config.timeout === 30000);

  setTimeout(() => {
    console.log('Results: ' + passed + ' passed, ' + failed + ' failed');
    if (failed > 0) process.exit(1);
  }, 100);
}

runTests();
export { Router, Request, Response, RouteConfig, RouteMatch };
```
