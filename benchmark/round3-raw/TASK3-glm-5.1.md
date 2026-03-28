# Round 3 TASK3 — Spec Adherence (Router with contradictory specs) 原始答案

## glm-5.1
**耗时: 58384ms**

```typescript
type Request = { path: string; method?: string; params?: Record<string, string>; };
type Response = { status: number; body: any; };
type RouteConfig = { handler: string; timeout: number; middleware: string[]; };
type RouteEntry = { type: 'exact' | 'param' | 'wildcard'; originalPath: string; config: RouteConfig; paramNames?: string[]; };

export class APIGatewayRouter {
  private routes: RouteEntry[] = [];

  addRoute(path: string, config: RouteConfig) {
    let type: RouteEntry['type'] = 'exact';
    let paramNames: string[] | undefined = undefined;
    if (path.includes('*')) { type = 'wildcard'; }
    else if (path.includes(':')) { type = 'param'; paramNames = (path.match(/:([^/]+)/g) || []).map(p => p.substring(1)); }
    this.routes.push({ type, originalPath: path, config, paramNames });
  }

  async handleRequest(req: Request): Promise<Response> {
    const matchingRoutes = this.routes.filter(r => this.matchRoute(req.path, r));
    if (matchingRoutes.length === 0) {
      return { status: 404, body: { error: "Not Found", path: req.path } };
    }
    // Priority: exact > param > wildcard (Document A)
    const priorityMap = { 'exact': 1, 'param': 2, 'wildcard': 3 };
    matchingRoutes.sort((a, b) => priorityMap[a.type] - priorityMap[b.type]);
    const matchedRoute = matchingRoutes[0];
    if (matchedRoute.type === 'param' && matchedRoute.paramNames) { req.params = this.extractParams(req.path, matchedRoute); }

    // Timeout unit: milliseconds (Document A overrides Document C)
    const timeoutMs = matchedRoute.config.timeout;
    const handlerPromise = new Promise<Response>((resolve) => {
      resolve({ status: 200, body: { message: "Handled by " + matchedRoute.config.handler, path: req.path, matchedRouteType: matchedRoute.type } });
    });
    const timeoutPromise = new Promise<Response>((resolve) => {
      setTimeout(() => { resolve({ status: 504, body: { error: "Gateway Timeout" } }); }, timeoutMs);
    });
    return Promise.race([handlerPromise, timeoutPromise]);
  }

  private matchRoute(requestPath: string, route: RouteEntry): boolean {
    if (route.type === 'exact') return requestPath === route.originalPath;
    const routeParts = route.originalPath.split('/');
    const reqParts = requestPath.split('/');
    if (route.type === 'wildcard') {
      const basePath = route.originalPath.replace('/*', '');
      return requestPath === basePath || requestPath.startsWith(basePath + '/');
    }
    if (route.type === 'param') {
      if (routeParts.length !== reqParts.length) return false;
      for (let i = 0; i < routeParts.length; i++) {
        if (!routeParts[i].startsWith(':') && routeParts[i] !== reqParts[i]) return false;
      }
      return true;
    }
    return false;
  }

  private extractParams(requestPath: string, route: RouteEntry): Record<string, string> {
    const params: Record<string, string> = {};
    const routeParts = route.originalPath!.split('/');
    const reqParts = requestPath.split('/');
    route.paramNames!.forEach((name, index) => {
      const partIndex = routeParts.findIndex(p => p === ':' + name);
      if (partIndex !== -1) params[name] = reqParts[partIndex];
    });
    return params;
  }
}

async function runTests() {
  const router = new APIGatewayRouter();
  router.addRoute('/users/:id', { handler: 'userDetail', timeout: 30, middleware: [] });
  router.addRoute('/users/*', { handler: 'userWildcard', timeout: 30, middleware: [] });
  router.addRoute('/api/data', { handler: 'apiData', timeout: 100, middleware: [] });

  // Test 1: Exact > wildcard
  const res1 = await router.handleRequest({ path: '/api/data' });
  console.log('Test 1:', res1.status, res1.body.matchedRouteType);
  console.assert(res1.body.matchedRouteType === 'exact');

  // Test 2: Param > wildcard
  const res2 = await router.handleRequest({ path: '/users/123' });
  console.log('Test 2:', res2.status, res2.body.matchedRouteType);
  console.assert(res2.body.matchedRouteType === 'param');

  // Test 3: 404 with path field
  const res3 = await router.handleRequest({ path: '/not/found' });
  console.log('Test 3:', res3.status, JSON.stringify(res3.body));
  console.assert(res3.status === 404 && res3.body.error === "Not Found" && typeof res3.body.path === 'string');
}

runTests();
```
