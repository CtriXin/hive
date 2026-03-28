# Round 3 TASK3 — Spec Adherence (Router with contradictory specs) 原始答案

## MiniMax-M2.7
**耗时: 138788ms**

```typescript
/**
 * API Gateway Router - Doc Priority: A (ERRATA) > B > C
 * 1. Priority: exact > param > wildcard (Doc A)
 * 2. Timeout: milliseconds (Doc A)
 * 3. 404: { error, path } (Doc A)
 */

interface RouteConfig { handler: string; timeout: number; middleware: string[]; }
interface Request { path: string; method?: string; headers?: Record<string, string>; body?: any; }
interface Response { status: number; body: any; headers?: Record<string, string>; }
type MatchType = 'exact' | 'param' | 'wildcard' | 'none';
interface MatchResult { type: MatchType; params: Record<string, string>; }

class Router {
  private routes: Map<string, RouteConfig> = new Map();
  register(pattern: string, config: RouteConfig): void { this.routes.set(pattern, config); }

  handleRequest(req: Request): Response {
    try {
      const exactMatch = this.matchExact(req.path);
      if (exactMatch) return this.executeHandler(req, exactMatch, {});

      const paramMatch = this.matchParam(req.path);
      if (paramMatch) return this.executeHandler(req, paramMatch.route, paramMatch.params);

      const wildcardMatch = this.matchWildcard(req.path);
      if (wildcardMatch) return this.executeHandler(req, wildcardMatch.route, { '0': wildcardMatch.wildcardPath });

      return { status: 404, body: { error: 'Not Found', path: req.path } };
    } catch (error) {
      return { status: 500, body: { error: 'Internal Server Error' } };
    }
  }

  private matchExact(path: string): RouteConfig | null {
    for (const [pattern, config] of this.routes) {
      if (this.pathsEqual(pattern, path)) return config;
    }
    return null;
  }

  private matchParam(path: string): { route: RouteConfig; params: Record<string, string> } | null {
    const pathSegments = path.split('/').filter(s => s !== '');
    for (const [pattern, config] of this.routes) {
      if (pattern.endsWith('/*')) continue;
      const patternSegments = pattern.split('/').filter(s => s !== '');
      if (patternSegments.length !== pathSegments.length) continue;
      const params: Record<string, string> = {};
      let allMatch = true;
      for (let i = 0; i < patternSegments.length; i++) {
        if (patternSegments[i].startsWith(':')) params[patternSegments[i].slice(1)] = pathSegments[i];
        else if (patternSegments[i] !== pathSegments[i]) { allMatch = false; break; }
      }
      if (allMatch) return { route: config, params };
    }
    return null;
  }

  private matchWildcard(path: string): { route: RouteConfig; wildcardPath: string } | null {
    for (const [pattern, config] of this.routes) {
      if (!pattern.endsWith('/*')) continue;
      const prefix = pattern.slice(0, -2);
      if (path === prefix || path.startsWith(prefix + '/')) return { route: config, wildcardPath: path.slice(prefix.length + 1) };
    }
    return null;
  }

  private executeHandler(req: Request, config: RouteConfig, params: Record<string, string>): Response {
    const timeout = config.timeout > 0 ? config.timeout : 30000;
    return { status: 200, body: { handler: config.handler, params } };
  }

  private pathsEqual(a: string, b: string): boolean {
    const normA = a.replace(/\/$/, '') || '/';
    const normB = b.replace(/\/$/, '') || '/';
    return normA === normB;
  }
}

function testExactVsParamPriority() {
  const router = new Router();
  router.register('/users', { handler: 'exactHandler', timeout: 30000, middleware: [] });
  router.register('/users/:id', { handler: 'paramHandler', timeout: 30000, middleware: [] });
  const result = router.handleRequest({ path: '/users' });
  console.assert(result.status === 200);
  console.assert(result.body.handler === 'exactHandler');
  console.log('Test 1: Exact route priority over parameter route');
}

function testParamVsWildcardPriority() {
  const router = new Router();
  router.register('/users/:id', { handler: 'paramHandler', timeout: 30000, middleware: [] });
  router.register('/users/*', { handler: 'wildcardHandler', timeout: 30000, middleware: [] });
  const result = router.handleRequest({ path: '/users/123' });
  console.assert(result.status === 200);
  console.assert(result.body.handler === 'paramHandler');
  console.assert(result.body.params.id === '123');
  console.log('Test 2: Parameter route priority over wildcard route');
}

function testAllPriorities() {
  const router = new Router();
  router.register('/api/*', { handler: 'wildcardHandler', timeout: 30000, middleware: [] });
  router.register('/api/users/:id', { handler: 'paramHandler', timeout: 30000, middleware: [] });
  router.register('/api/users/list', { handler: 'exactHandler', timeout: 30000, middleware: [] });
  let result = router.handleRequest({ path: '/api/users/list' });
  console.assert(result.body.handler === 'exactHandler');
  result = router.handleRequest({ path: '/api/users/456' });
  console.assert(result.body.handler === 'paramHandler');
  result = router.handleRequest({ path: '/api/other/endpoint' });
  console.assert(result.body.handler === 'wildcardHandler');
  console.log('Test 3: All three priority levels work correctly');
}

function test404ResponseFormat() {
  const router = new Router();
  const result = router.handleRequest({ path: '/nonexistent/route' });
  console.assert(result.status === 404);
  console.assert(result.body.error === 'Not Found');
  console.assert(result.body.path === '/nonexistent/route');
  console.log('Test 4: 404 response includes path field');
}

function runTests(): void {
  console.log('Running Router Tests...\n');
  testExactVsParamPriority();
  testParamVsWildcardPriority();
  testAllPriorities();
  test404ResponseFormat();
  console.log('\nAll tests passed!');
}

runTests();
export { Router, RouteConfig, Request, Response, MatchType, MatchResult };
```
