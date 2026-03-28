# Round 3 TASK3 — Spec Adherence (Router with contradictory specs) 原始答案

## glm-5
**耗时: 50727ms**

```typescript
/**
 * API Gateway Router Module
 * Resolves conflicts based on priority: A (ERRATA) > B (Design Spec) > C (Impl Guide).
 */

type Middleware = string;

interface RouteConfig {
  handler: string;
  timeout: number;
  middleware: string[];
}

interface RequestContext {
  path: string;
  method: string;
  params: Record<string, string>;
}

type RouteHandler = (req: RequestContext) => Promise<string>;

interface RouteMatch {
  config: RouteConfig;
  params: Record<string, string>;
  priority: number;
  specificity: number;
}

export class Router {
  private routes: Map<string, RouteConfig> = new Map();
  private handlers: Map<string, RouteHandler> = new Map();

  constructor(routes: Record<string, RouteConfig> = {}) {
    Object.entries(routes).forEach(([path, config]) => { this.addRoute(path, config); });
  }

  public addRoute(path: string, config: RouteConfig) { this.routes.set(path, config); }
  public registerHandler(name: string, handler: RouteHandler) { this.handlers.set(name, handler); }

  public async handleRequest(rawPath: string): Promise<string> {
    const match = this.findBestMatch(rawPath);
    if (!match) {
      return JSON.stringify({ error: "Not Found", path: rawPath });
    }
    const { config, params } = match;
    const handler = this.handlers.get(config.handler);
    if (!handler) throw new Error("Handler '" + config.handler + "' not registered.");
    const req: RequestContext = { path: rawPath, method: "GET", params };
    const timeoutMs = config.timeout;
    return this.executeWithTimeout(handler, req, timeoutMs);
  }

  private findBestMatch(path: string): RouteMatch | null {
    const candidates: RouteMatch[] = [];
    for (const [routePath, config] of this.routes.entries()) {
      const result = this.matchPath(routePath, path);
      if (result) candidates.push(result);
    }
    if (candidates.length === 0) return null;
    candidates.sort((a, b) => { if (a.priority !== b.priority) return a.priority - b.priority; return b.specificity - a.specificity; });
    return candidates[0];
  }

  private matchPath(pattern: string, path: string): RouteMatch | null {
    const normalizedPath = path.split('?')[0].replace(/\/$/, '');
    const normalizedPattern = pattern.replace(/\/$/, '');
    if (normalizedPattern === normalizedPath) {
      return { config: this.routes.get(pattern)!, params: {}, priority: 0, specificity: pattern.length };
    }
    const patternSegments = normalizedPattern.split('/');
    const pathSegments = normalizedPath.split('/');
    if (pattern.endsWith('/*')) {
      const basePath = normalizedPattern.slice(0, -2);
      if (normalizedPath.startsWith(basePath + '/') || normalizedPath === basePath) {
        return { config: this.routes.get(pattern)!, params: {}, priority: 2, specificity: pattern.length };
      }
      return null;
    }
    if (patternSegments.length === pathSegments.length && pattern.includes(':')) {
      const params: Record<string, string> = {};
      let isMatch = true;
      for (let i = 0; i < patternSegments.length; i++) {
        if (patternSegments[i].startsWith(':')) { params[patternSegments[i].slice(1)] = pathSegments[i]; }
        else if (patternSegments[i] !== pathSegments[i]) { isMatch = false; break; }
      }
      if (isMatch) return { config: this.routes.get(pattern)!, params, priority: 1, specificity: pattern.length };
    }
    return null;
  }

  private async executeWithTimeout(handler: RouteHandler, req: RequestContext, timeout: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("Request timed out after " + timeout + "ms")); }, timeout);
      handler(req).then(res => { clearTimeout(timer); resolve(res); }).catch(err => { clearTimeout(timer); reject(err); });
    });
  }
}

async function runTests() {
  const explicitHandler = async () => "Explicit Match";
  const paramHandler = async (req: RequestContext) => "Param Match: " + req.params.id;
  const wildcardHandler = async () => "Wildcard Match";
  const router = new Router({
    "/api/v1/users": { handler: "explicit", timeout: 1000, middleware: [] },
    "/api/v1/users/:id": { handler: "param", timeout: 1000, middleware: [] },
    "/api/*": { handler: "wildcard", timeout: 1000, middleware: [] }
  });
  router.registerHandler("explicit", explicitHandler);
  router.registerHandler("param", paramHandler);
  router.registerHandler("wildcard", wildcardHandler);

  // TEST 1: Exact Match
  const res1 = await router.handleRequest("/api/v1/users");
  console.assert(res1 === "Explicit Match", "Test 1 Failed");
  console.log("Test 1 Passed: Exact Match Priority");

  // TEST 2: Param > Wildcard
  const res2 = await router.handleRequest("/api/v1/users/123");
  console.assert(res2 === "Param Match: 123", "Test 2 Failed");
  console.log("Test 2 Passed: Param > Wildcard Priority");

  // TEST 3: Wildcard fallback
  const res3 = await router.handleRequest("/api/v1/products");
  console.assert(res3 === "Wildcard Match", "Test 3 Failed");
  console.log("Test 3 Passed: Wildcard Fallback");

  // TEST 4: 404 format
  const res4 = await router.handleRequest("/unknown");
  const json4 = JSON.parse(res4);
  console.assert(json4.error === "Not Found", "Test 4 Failed");
  console.assert(json4.path === "/unknown", "Test 4 Failed");
  console.log("Test 4 Passed: 404 Format Correct");

  console.log("--- All Tests Completed ---");
}

runTests();
```
