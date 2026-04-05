// HTTP Router with Middleware Pipeline
// No external dependencies

export interface Context {
  method: string;
  path: string;
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
  headers: Record<string, string>;
  status: number;
  responseBody: unknown;
  state: Record<string, unknown>;
}

export type Handler = (ctx: Context) => Promise<void> | void;
export type Middleware = (ctx: Context, next: () => Promise<void>) => Promise<void>;

interface Route {
  method: string;
  pattern: string;
  regex: RegExp;
  paramNames: string[];
  handler: Handler;
}

interface MiddlewareEntry {
  prefix: string | null;
  middleware: Middleware;
}

export class Router {
  private routes: Route[] = [];
  private middlewares: MiddlewareEntry[] = [];

  get(pattern: string, handler: Handler): void {
    this.addRoute('GET', pattern, handler);
  }

  post(pattern: string, handler: Handler): void {
    this.addRoute('POST', pattern, handler);
  }

  delete(pattern: string, handler: Handler): void {
    this.addRoute('DELETE', pattern, handler);
  }

  put(pattern: string, handler: Handler): void {
    this.addRoute('PUT', pattern, handler);
  }

  patch(pattern: string, handler: Handler): void {
    this.addRoute('PATCH', pattern, handler);
  }

  use(prefixOrMiddleware: string | Middleware, middleware?: Middleware): void {
    if (typeof prefixOrMiddleware === 'string' && middleware) {
      this.middlewares.push({ prefix: prefixOrMiddleware, middleware });
    } else if (typeof prefixOrMiddleware === 'function') {
      this.middlewares.push({ prefix: null, middleware: prefixOrMiddleware });
    }
  }

  private addRoute(method: string, pattern: string, handler: Handler): void {
    const { regex, paramNames } = this.patternToRegex(pattern);
    this.routes.push({ method, pattern, regex, paramNames, handler });
  }

  private patternToRegex(pattern: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    const regexPattern = pattern.replace(/:([^/]+)/g, (_, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    return {
      regex: new RegExp(`^${regexPattern}$`),
      paramNames
    };
  }

  private parseQuery(queryString: string): Record<string, string> {
    const query: Record<string, string> = {};
    if (!queryString) return query;

    const params = new URLSearchParams(queryString);
    params.forEach((value, key) => {
      query[key] = value;
    });
    return query;
  }

  private matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;

      const match = path.match(route.regex);
      if (match) {
        const params: Record<string, string> = {};
        route.paramNames.forEach((name, index) => {
          params[name] = match[index + 1];
        });
        return { route, params };
      }
    }
    return null;
  }

  async handle(request: {
    method: string;
    path: string;
    body?: unknown;
    headers?: Record<string, string>;
  }): Promise<{ status: number; body: unknown }> {
    const [pathWithoutQuery, queryString] = request.path.split('?');

    const ctx: Context = {
      method: request.method,
      path: pathWithoutQuery,
      params: {},
      query: this.parseQuery(queryString || ''),
      body: request.body ?? null,
      headers: request.headers ?? {},
      status: 200,
      responseBody: null,
      state: {}
    };

    const routeMatch = this.matchRoute(request.method, pathWithoutQuery);

    if (!routeMatch) {
      return {
        status: 404,
        body: { error: 'Not Found', path: ctx.path }
      };
    }

    ctx.params = routeMatch.params;
    const matchedRoute = routeMatch.route;

    const applicableMiddlewares = this.middlewares.filter(mw => {
      if (mw.prefix === null) return true;
      return ctx.path.startsWith(mw.prefix);
    });

    try {
      await this.executeMiddlewares(ctx, applicableMiddlewares, matchedRoute.handler);
      return {
        status: ctx.status,
        body: ctx.responseBody
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      return {
        status: 500,
        body: { error: message }
      };
    }
  }

  private async executeMiddlewares(
    ctx: Context,
    middlewares: MiddlewareEntry[],
    finalHandler: Handler
  ): Promise<void> {
    let index = 0;

    const next = async (): Promise<void> => {
      if (index < middlewares.length) {
        const { middleware } = middlewares[index++];
        await middleware(ctx, next);
      } else {
        await finalHandler(ctx);
      }
    };

    await next();
  }
}

export function createRouter(): Router {
  return new Router();
}
