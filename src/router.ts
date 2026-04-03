/**
 * Lightweight HTTP Router with Middleware Pipeline
 * No external dependencies - self-contained implementation
 */

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

export type Middleware = (
  ctx: Context,
  next: () => Promise<void>
) => Promise<void>;

export type Handler = (ctx: Context) => Promise<void> | void;

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

  private parsePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    let regexPattern = pattern
      .replace(/\*/g, '([^]*)')
      .replace(/:([^/]+)/g, (_, name) => {
        paramNames.push(name);
        return '([^/]+)';
      });

    regexPattern = '^' + regexPattern + '$';
    return { regex: new RegExp(regexPattern), paramNames };
  }

  private addRoute(method: string, pattern: string, handler: Handler): void {
    const { regex, paramNames } = this.parsePattern(pattern);
    this.routes.push({ method, pattern, regex, paramNames, handler });
  }

  get(pattern: string, handler: Handler): Router {
    this.addRoute('GET', pattern, handler);
    return this;
  }

  post(pattern: string, handler: Handler): Router {
    this.addRoute('POST', pattern, handler);
    return this;
  }

  put(pattern: string, handler: Handler): Router {
    this.addRoute('PUT', pattern, handler);
    return this;
  }

  delete(pattern: string, handler: Handler): Router {
    this.addRoute('DELETE', pattern, handler);
    return this;
  }

  patch(pattern: string, handler: Handler): Router {
    this.addRoute('PATCH', pattern, handler);
    return this;
  }

  use(prefixOrMiddleware: string | Middleware, middleware?: Middleware): Router {
    if (typeof prefixOrMiddleware === 'string') {
      if (!middleware) {
        throw new Error('Middleware function required when prefix is provided');
      }
      this.middlewares.push({ prefix: prefixOrMiddleware, middleware });
    } else {
      this.middlewares.push({ prefix: null, middleware: prefixOrMiddleware });
    }
    return this;
  }

  private parseQuery(queryString: string): Record<string, string> {
    const query: Record<string, string> = {};
    if (!queryString) return query;

    for (const pair of queryString.split('&')) {
      const [key, value] = pair.split('=');
      if (key) {
        query[decodeURIComponent(key)] = value ? decodeURIComponent(value) : '';
      }
    }
    return query;
  }

  private matchRoute(method: string, path: string): { route: Route; params: Record<string, string> } | null {
    for (const route of this.routes) {
      if (route.method !== method) continue;

      const match = route.regex.exec(path);
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

  private createContext(
    method: string,
    path: string,
    headers: Record<string, string>,
    body: unknown
  ): Context {
    const [pathname, queryString] = path.split('?');
    return {
      method,
      path: pathname,
      params: {},
      query: this.parseQuery(queryString || ''),
      body,
      headers,
      status: 200,
      responseBody: undefined,
      state: {},
    };
  }

  private async executeMiddlewareChain(
    ctx: Context,
    middlewares: Middleware[],
    finalHandler: () => Promise<void>
  ): Promise<void> {
    let index = 0;

    const next = async (): Promise<void> => {
      if (index < middlewares.length) {
        const middleware = middlewares[index++];
        await middleware(ctx, next);
      } else {
        await finalHandler();
      }
    };

    await next();
  }

  async handle(
    method: string,
    path: string,
    headers: Record<string, string> = {},
    body: unknown = undefined
  ): Promise<{ status: number; body: unknown }> {
    const ctx = this.createContext(method, path, headers, body);

    try {
      const routeMatch = this.matchRoute(method, ctx.path);

      if (!routeMatch) {
        return {
          status: 404,
          body: { error: 'Not Found', path: ctx.path },
        };
      }

      ctx.params = routeMatch.params;

      const applicableMiddlewares = this.middlewares.filter((entry) => {
        if (entry.prefix === null) return true;
        return ctx.path.startsWith(entry.prefix);
      }).map((entry) => entry.middleware);

      await this.executeMiddlewareChain(ctx, applicableMiddlewares, async () => {
        await routeMatch.route.handler(ctx);
      });

      return {
        status: ctx.status,
        body: ctx.responseBody,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Internal Server Error';
      return {
        status: 500,
        body: { error: message },
      };
    }
  }
}
