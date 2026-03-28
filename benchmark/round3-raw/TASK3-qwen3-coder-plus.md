# Round 3 TASK3 — Spec Adherence (Router with contradictory specs) 原始答案

## qwen3-coder-plus
**耗时: 26187ms**

```typescript
interface RouteConfig { handler: string; timeout: number; middleware: string[]; }

class ApiGatewayRouter {
  private exactRoutes: Map<string, RouteConfig>;
  private paramRoutes: Array<{ pattern: RegExp, routeConfig: RouteConfig, originalPath: string }>;
  private wildcardRoutes: Array<{ prefix: string, routeConfig: RouteConfig }>;

  constructor() {
    this.exactRoutes = new Map();
    this.paramRoutes = [];
    this.wildcardRoutes = [];
  }

  addRoute(path: string, config: RouteConfig): void {
    if (path.endsWith('/*')) {
      const prefix = path.slice(0, -2);
      this.wildcardRoutes.push({ prefix, routeConfig: config });
    } else if (path.includes(':')) {
      const regexPattern = '^' + path.replace(/:[^\/]+/g, '([^/]+?)') + '/?$';
      this.paramRoutes.push({ pattern: new RegExp(regexPattern), routeConfig: config, originalPath: path });
    } else {
      this.exactRoutes.set(path, config);
    }
  }

  route(path: string): { config: RouteConfig, params?: Record<string, string> } | null {
    if (this.exactRoutes.has(path)) return { config: this.exactRoutes.get(path)! };
    for (const { pattern, routeConfig, originalPath } of this.paramRoutes) {
      const match = path.match(pattern);
      if (match) {
        const paramNames = originalPath.match(/:[^\/]+/g) || [];
        const params: Record<string, string> = {};
        for (let i = 0; i < paramNames.length; i++) { params[paramNames[i].substring(1)] = match[i + 1]; }
        return { config: routeConfig, params };
      }
    }
    for (const { prefix, routeConfig } of this.wildcardRoutes) {
      if (path.startsWith(prefix)) return { config: routeConfig };
    }
    return null;
  }

  async handleRequest(path: string, request: any): Promise<any> {
    const match = this.route(path);
    if (!match) return { status: 404, body: { error: "Not Found", path: path } };
    const { config, params = {} } = match;
    return new Promise((resolve, reject) => {
      const timeout = config.timeout || 30000;
      const timeoutId = setTimeout(() => { reject(new Error("Handler timeout after " + timeout + "ms")); }, timeout);
      resolve({ status: 200, body: { message: "Handled by " + config.handler, params } }).then(result => { clearTimeout(timeoutId); resolve(result); })
        .catch(err => { clearTimeout(timeoutId); reject(err); });
    });
  }
}

function runTests() {
  const router = new ApiGatewayRouter();
  router.addRoute('/api/*', { handler: 'wildcard', timeout: 5000, middleware: [] });
  router.addRoute('/api/:id', { handler: 'param', timeout: 5000, middleware: [] });
  router.addRoute('/api/123', { handler: 'exact', timeout: 5000, middleware: [] });

  let result = router.route('/api/123');
  console.assert(result?.config.handler === 'exact', 'Test 1 Failed');
  console.log('Test 1 Passed: Exact match takes priority');

  result = router.route('/api/456');
  console.assert(result?.config.handler === 'param', 'Test 2 Failed');
  console.log('Test 2 Passed: Parameter match takes priority over wildcard');

  result = router.route('/api/users/profile');
  console.assert(result?.config.handler === 'wildcard', 'Test 3 Failed');
  console.log('Test 3 Passed: Wildcard match used as fallback');

  console.log("All tests passed!");
}

runTests();
```
