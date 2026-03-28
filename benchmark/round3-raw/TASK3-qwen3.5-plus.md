# Round 3 TASK3 — Spec Adherence (Router with contradictory specs) 原始答案

## qwen3.5-plus
**耗时: 145620ms**

```typescript
/**
 * API Gateway Routing Module
 * CONFLICT RESOLUTION LOG:
 * 1. Priority: Doc B (wildcard > param > exact) vs Doc A (exact > param > wildcard) -> Doc A
 * 2. Timeout: Doc C (seconds, 30) vs Doc A (milliseconds) -> Doc A, default 30000ms
 * 3. 404: Doc C ({ error }) vs Doc A ({ error, path }) -> Doc A
 * 4. Handler type: Doc B (string) vs Doc C (function) -> Doc B for config
 */

type Request = { path: string; method?: string; [key: string]: any; };
type Response = { status: number; body: any; };
type HandlerFunction = (req: Request) => Promise<Response>;

interface RouteConfig { handler: string; timeout: number; middleware: string[]; }
type RouteRegistry = Record<string, HandlerFunction>;

class Router {
  private routes: Map<string, RouteConfig>;
  private handlerRegistry: RouteRegistry;
  private defaultTimeout: number;

  constructor(registry: RouteRegistry, defaultTimeoutMs: number = 30000) {
    this.routes = new Map<string, RouteConfig>();
    this.handlerRegistry = registry;
    this.defaultTimeout = defaultTimeoutMs;
  }

  public addRoute(path: string, config: RouteConfig): void { this.routes.set(path, config); }

  private matchRoute(path: string): { path: string; config: RouteConfig; params?: Record<string, string> } | null {
    const exactMatches: string[] = [];
    const paramMatches: { path: string; params: Record<string, string> }[] = [];
    const wildcardMatches: string[] = [];

    for (const [routePath, config] of this.routes.entries()) {
      if (routePath === path) { exactMatches.push(routePath); continue; }
      const paramMatch = this.matchParameterRoute(routePath, path);
      if (paramMatch) { paramMatches.push({ path: routePath, params: paramMatch }); continue; }
      if (this.matchWildcardRoute(routePath, path)) { wildcardMatches.push(routePath); }
    }

    if (exactMatches.length > 0) return { path: exactMatches[0], config: this.routes.get(exactMatches[0])! };
    if (paramMatches.length > 0) return { path: paramMatches[0].path, config: this.routes.get(paramMatches[0].path)!, params: paramMatches[0].params };
    if (wildcardMatches.length > 0) { wildcardMatches.sort((a, b) => b.length - a.length); return { path: wildcardMatches[0], config: this.routes.get(wildcardMatches[0])! }; }
    return null;
  }

  private matchParameterRoute(routePath: string, requestPath: string): Record<string, string> | null {
    const routeSegments = routePath.split('/');
    const requestSegments = requestPath.split('/');
    if (routeSegments.length !== requestSegments.length) return null;
    const params: Record<string, string> = {};
    for (let i = 0; i < routeSegments.length; i++) {
      if (routeSegments[i].startsWith(':')) params[routeSegments[i].substring(1)] = requestSegments[i];
      else if (routeSegments[i] !== requestSegments[i]) return null;
    }
    return params;
  }

  private matchWildcardRoute(routePath: string, requestPath: string): boolean {
    if (!routePath.endsWith('/*')) return false;
    const prefix = routePath.slice(0, -2);
    if (requestPath === prefix) return true;
    return requestPath.startsWith(prefix + '/');
  }

  private createTimeoutPromise(timeoutMs: number): Promise<never> {
    return new Promise((_, reject) => { setTimeout(() => { reject(new Error('Gateway Timeout')); }, timeoutMs); });
  }

  public async handleRequest(req: Request): Promise<Response> {
    const match = this.matchRoute(req.path);
    if (!match) return { status: 404, body: { error: "Not Found", path: req.path } };
    const handlerId = match.config.handler;
    const handler = this.handlerRegistry[handlerId];
    if (!handler) return { status: 500, body: { error: "Handler not found", id: handlerId } };
    const timeoutMs = match.config.timeout !== undefined ? match.config.timeout : this.defaultTimeout;
    try {
      const result = await Promise.race([handler({ ...req, params: match.params }), this.createTimeoutPromise(timeoutMs)]);
      return result;
    } catch (e) {
      if (e instanceof Error && e.message === 'Gateway Timeout') return { status: 504, body: { error: "Gateway Timeout" } };
      throw e;
    }
  }
}

async function runTests() {
  console.log("Running Routing Module Tests...\n");
  let passed = 0; let failed = 0;
  const handlers = {
    exactHandler: async () => ({ status: 200, body: { type: "exact" } }),
    paramHandler: async () => ({ status: 200, body: { type: "param" } }),
    wildcardHandler: async () => ({ status: 200, body: { type: "wildcard" } }),
  };

  // Test 1: Exact > Param > Wildcard
  try {
    const router = new Router(handlers);
    router.addRoute("/users/*", { handler: "wildcardHandler", timeout: 1000, middleware: [] });
    router.addRoute("/users/:id", { handler: "paramHandler", timeout: 1000, middleware: [] });
    router.addRoute("/users/123", { handler: "exactHandler", timeout: 1000, middleware: [] });
    const res = await router.handleRequest({ path: "/users/123" });
    if (res.status === 200 && res.body.type === "exact") { console.log("Test 1 PASSED: Exact > Param > Wildcard"); passed++; }
    else { console.log("Test 1 FAILED"); failed++; }
  } catch (e) { console.log("Test 1 FAILED:", e); failed++; }

  // Test 2: Param > Wildcard
  try {
    const router = new Router(handlers);
    router.addRoute("/api/*", { handler: "wildcardHandler", timeout: 1000, middleware: [] });
    router.addRoute("/api/:resource", { handler: "paramHandler", timeout: 1000, middleware: [] });
    const res = await router.handleRequest({ path: "/api/users" });
    if (res.status === 200 && res.body.type === "param") { console.log("Test 2 PASSED: Param > Wildcard"); passed++; }
    else { console.log("Test 2 FAILED"); failed++; }
  } catch (e) { console.log("Test 2 FAILED:", e); failed++; }

  // Test 3: 404 with path field
  try {
    const router = new Router(handlers);
    const res = await router.handleRequest({ path: "/nonexistent" });
    if (res.status === 404 && res.body.error && res.body.path === "/nonexistent") { console.log("Test 3 PASSED: 404 includes path"); passed++; }
    else { console.log("Test 3 FAILED"); failed++; }
  } catch (e) { console.log("Test 3 FAILED:", e); failed++; }

  console.log("\nTests: " + passed + " Passed, " + failed + " Failed");
}

runTests().catch(console.error);
```
