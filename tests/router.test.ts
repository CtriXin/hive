/**
 * Router Tests
 * Tests for lightweight HTTP router with middleware pipeline
 */

import { describe, it, expect } from 'vitest';
import { Router, Context, Middleware } from '../src/router.js';

describe('Router', () => {
  describe('basic route matching + param extraction', () => {
    it('should match GET route and extract params', async () => {
      const router = new Router();
      router.get('/users/:id', (ctx) => {
        ctx.responseBody = { userId: ctx.params.id };
      });

      const result = await router.handle('GET', '/users/123');

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ userId: '123' });
    });

    it('should match POST route', async () => {
      const router = new Router();
      router.post('/users', (ctx) => {
        ctx.responseBody = { created: true, body: ctx.body };
      });

      const result = await router.handle('POST', '/users', {}, { name: 'John' });

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ created: true, body: { name: 'John' } });
    });

    it('should match DELETE route with params', async () => {
      const router = new Router();
      router.delete('/users/:id', (ctx) => {
        ctx.responseBody = { deleted: ctx.params.id };
      });

      const result = await router.handle('DELETE', '/users/456');

      expect(result.status).toBe(200);
      expect(result.body).toEqual({ deleted: '456' });
    });

    it('should extract multiple params', async () => {
      const router = new Router();
      router.get('/users/:userId/posts/:postId', (ctx) => {
        ctx.responseBody = {
          userId: ctx.params.userId,
          postId: ctx.params.postId,
        };
      });

      const result = await router.handle('GET', '/users/42/posts/99');

      expect(result.body).toEqual({ userId: '42', postId: '99' });
    });

    it('should parse query parameters', async () => {
      const router = new Router();
      router.get('/search', (ctx) => {
        ctx.responseBody = { query: ctx.query };
      });

      const result = await router.handle('GET', '/search?q=test&limit=10');

      expect(result.body).toEqual({ query: { q: 'test', limit: '10' } });
    });

    it('should return 404 for non-matching route', async () => {
      const router = new Router();
      router.get('/users', (ctx) => {
        ctx.responseBody = { users: [] };
      });

      const result = await router.handle('GET', '/posts');

      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: 'Not Found', path: '/posts' });
    });

    it('should return 404 for wrong HTTP method', async () => {
      const router = new Router();
      router.get('/users', (ctx) => {
        ctx.responseBody = { users: [] };
      });

      const result = await router.handle('POST', '/users');

      expect(result.status).toBe(404);
      expect(result.body).toEqual({ error: 'Not Found', path: '/users' });
    });
  });

  describe('global middleware execution order', () => {
    it('should execute global middleware before route handler', async () => {
      const router = new Router();
      const executionOrder: string[] = [];

      const globalMiddleware: Middleware = async (ctx, next) => {
        executionOrder.push('global-before');
        await next();
        executionOrder.push('global-after');
      };

      router.use(globalMiddleware);
      router.get('/test', (ctx) => {
        executionOrder.push('handler');
        ctx.responseBody = { done: true };
      });

      await router.handle('GET', '/test');

      expect(executionOrder).toEqual(['global-before', 'handler', 'global-after']);
    });

    it('should execute multiple global middleware in order', async () => {
      const router = new Router();
      const executionOrder: string[] = [];

      router.use(async (ctx, next) => {
        executionOrder.push('mw1-before');
        await next();
        executionOrder.push('mw1-after');
      });

      router.use(async (ctx, next) => {
        executionOrder.push('mw2-before');
        await next();
        executionOrder.push('mw2-after');
      });

      router.get('/test', (ctx) => {
        executionOrder.push('handler');
        ctx.responseBody = { done: true };
      });

      await router.handle('GET', '/test');

      expect(executionOrder).toEqual([
        'mw1-before',
        'mw2-before',
        'handler',
        'mw2-after',
        'mw1-after',
      ]);
    });

    it('should allow middleware to modify context state', async () => {
      const router = new Router();

      router.use(async (ctx, next) => {
        ctx.state.user = { id: '123', name: 'Test' };
        await next();
      });

      router.get('/profile', (ctx) => {
        ctx.responseBody = { user: ctx.state.user };
      });

      const result = await router.handle('GET', '/profile');

      expect(result.body).toEqual({ user: { id: '123', name: 'Test' } });
    });
  });

  describe('path-prefix middleware only matches corresponding paths', () => {
    it('should apply path-prefix middleware only to matching paths', async () => {
      const router = new Router();
      const executionLog: string[] = [];

      router.use('/api', async (ctx, next) => {
        executionLog.push(`api-mw:${ctx.path}`);
        await next();
      });

      router.get('/api/users', (ctx) => {
        executionLog.push('api-handler');
        ctx.responseBody = { api: true };
      });

      router.get('/public/info', (ctx) => {
        executionLog.push('public-handler');
        ctx.responseBody = { public: true };
      });

      const apiResult = await router.handle('GET', '/api/users');
      const publicResult = await router.handle('GET', '/public/info');

      expect(apiResult.body).toEqual({ api: true });
      expect(publicResult.body).toEqual({ public: true });
      expect(executionLog).toEqual(['api-mw:/api/users', 'api-handler', 'public-handler']);
    });

    it('should combine global and path-prefix middleware correctly', async () => {
      const router = new Router();
      const executionOrder: string[] = [];

      router.use(async (ctx, next) => {
        executionOrder.push('global-before');
        await next();
        executionOrder.push('global-after');
      });

      router.use('/api', async (ctx, next) => {
        executionOrder.push('api-before');
        await next();
        executionOrder.push('api-after');
      });

      router.get('/api/data', (ctx) => {
        executionOrder.push('handler');
        ctx.responseBody = { data: true };
      });

      await router.handle('GET', '/api/data');

      expect(executionOrder).toEqual([
        'global-before',
        'api-before',
        'handler',
        'api-after',
        'global-after',
      ]);
    });

    it('should not apply path-prefix middleware to non-matching paths', async () => {
      const router = new Router();
      const executionLog: string[] = [];

      router.use('/admin', async (ctx, next) => {
        executionLog.push('admin-mw');
        ctx.state.isAdmin = true;
        await next();
      });

      router.get('/admin/dashboard', (ctx) => {
        ctx.responseBody = { isAdmin: ctx.state.isAdmin };
      });

      router.get('/users', (ctx) => {
        ctx.responseBody = { isAdmin: ctx.state.isAdmin };
      });

      const adminResult = await router.handle('GET', '/admin/dashboard');
      const userResult = await router.handle('GET', '/users');

      expect(adminResult.body).toEqual({ isAdmin: true });
      expect(userResult.body).toEqual({ isAdmin: undefined });
      expect(executionLog).toEqual(['admin-mw']);
    });
  });

  describe('onion model: middleware can read handler-set responseBody after next()', () => {
    it('should allow middleware to read and modify response after handler', async () => {
      const router = new Router();

      router.use(async (ctx, next) => {
        await next();
        // After next(), we can see what the handler set
        if (ctx.responseBody && typeof ctx.responseBody === 'object') {
          ctx.responseBody = {
            ...ctx.responseBody,
            wrapped: true,
            timestamp: '2024-01-01',
          };
        }
      });

      router.get('/data', (ctx) => {
        ctx.responseBody = { message: 'Hello' };
      });

      const result = await router.handle('GET', '/data');

      expect(result.body).toEqual({
        message: 'Hello',
        wrapped: true,
        timestamp: '2024-01-01',
      });
    });

    it('should support request/response timing in middleware', async () => {
      const router = new Router();
      let startTime = 0;
      let endTime = 0;

      router.use(async (ctx, next) => {
        startTime = Date.now();
        await next();
        endTime = Date.now();
        ctx.responseBody = {
          ...ctx.responseBody as object,
          duration: endTime - startTime,
        };
      });

      router.get('/timed', (ctx) => {
        ctx.responseBody = { data: 'some data' };
      });

      const result = await router.handle('GET', '/timed');

      expect(result.body).toHaveProperty('data', 'some data');
      expect(result.body).toHaveProperty('duration');
      expect(typeof (result.body as { duration: number }).duration).toBe('number');
      expect((result.body as { duration: number }).duration).toBeGreaterThanOrEqual(0);
    });

    it('should support logging middleware that captures response', async () => {
      const router = new Router();
      const logs: string[] = [];

      router.use(async (ctx, next) => {
        await next();
        logs.push(`${ctx.method} ${ctx.path} -> ${ctx.status}`);
      });

      router.get('/users', (ctx) => {
        ctx.status = 200;
        ctx.responseBody = { count: 5 };
      });

      router.post('/users', (ctx) => {
        ctx.status = 201;
        ctx.responseBody = { id: 'new-id' };
      });

      await router.handle('GET', '/users');
      await router.handle('POST', '/users');

      expect(logs).toEqual(['GET /users -> 200', 'POST /users -> 201']);
    });
  });

  describe('error handling: middleware catch can receive errors when handler throws', () => {
    it('should return 500 when handler throws', async () => {
      const router = new Router();

      router.get('/error', (ctx) => {
        throw new Error('Something went wrong');
      });

      const result = await router.handle('GET', '/error');

      expect(result.status).toBe(500);
      expect(result.body).toEqual({ error: 'Something went wrong' });
    });

    it('should return 500 when middleware throws', async () => {
      const router = new Router();

      router.use(async (ctx, next) => {
        throw new Error('Middleware error');
      });

      router.get('/test', (ctx) => {
        ctx.responseBody = { success: true };
      });

      const result = await router.handle('GET', '/test');

      expect(result.status).toBe(500);
      expect(result.body).toEqual({ error: 'Middleware error' });
    });

    it('should catch errors in async handlers', async () => {
      const router = new Router();

      router.get('/async-error', async (ctx) => {
        await Promise.resolve();
        throw new Error('Async error');
      });

      const result = await router.handle('GET', '/async-error');

      expect(result.status).toBe(500);
      expect(result.body).toEqual({ error: 'Async error' });
    });

    it('should handle non-Error throws', async () => {
      const router = new Router();

      router.get('/string-error', (ctx) => {
        throw 'String error';
      });

      const result = await router.handle('GET', '/string-error');

      expect(result.status).toBe(500);
      expect(result.body).toEqual({ error: 'Internal Server Error' });
    });

    it('should allow middleware to catch and handle errors from handler', async () => {
      const router = new Router();
      let caughtError: Error | null = null;

      router.use(async (ctx, next) => {
        try {
          await next();
        } catch (error) {
          caughtError = error as Error;
          ctx.status = 400;
          ctx.responseBody = { handled: true, message: (error as Error).message };
        }
      });

      router.get('/test', (ctx) => {
        throw new Error('Handler failed');
      });

      const result = await router.handle('GET', '/test');

      expect(caughtError?.message).toBe('Handler failed');
      expect(result.status).toBe(400);
      expect(result.body).toEqual({ handled: true, message: 'Handler failed' });
    });

    it('should allow error recovery middleware to set custom response', async () => {
      const router = new Router();

      router.use(async (ctx, next) => {
        try {
          await next();
        } catch (error) {
          ctx.status = 418; // I'm a teapot
          ctx.responseBody = {
            error: 'Custom error handling',
            original: (error as Error).message,
          };
        }
      });

      router.get('/break', (ctx) => {
        throw new Error('Break things');
      });

      const result = await router.handle('GET', '/break');

      expect(result.status).toBe(418);
      expect(result.body).toEqual({
        error: 'Custom error handling',
        original: 'Break things',
      });
    });
  });

  describe('method chaining', () => {
    it('should support method chaining for route registration', async () => {
      const router = new Router();

      router
        .get('/users', (ctx) => {
          ctx.responseBody = { list: true };
        })
        .post('/users', (ctx) => {
          ctx.responseBody = { created: true };
        })
        .delete('/users/:id', (ctx) => {
          ctx.responseBody = { deleted: ctx.params.id };
        });

      const getResult = await router.handle('GET', '/users');
      const postResult = await router.handle('POST', '/users');
      const deleteResult = await router.handle('DELETE', '/users/123');

      expect(getResult.body).toEqual({ list: true });
      expect(postResult.body).toEqual({ created: true });
      expect(deleteResult.body).toEqual({ deleted: '123' });
    });

    it('should support method chaining for middleware', async () => {
      const router = new Router();
      const order: string[] = [];

      router
        .use(async (ctx, next) => {
          order.push('mw1');
          await next();
        })
        .use('/api', async (ctx, next) => {
          order.push('api-mw');
          await next();
        })
        .get('/api/test', (ctx) => {
          order.push('handler');
          ctx.responseBody = { done: true };
        });

      await router.handle('GET', '/api/test');

      expect(order).toEqual(['mw1', 'api-mw', 'handler']);
    });
  });

  describe('additional HTTP methods', () => {
    it('should support PUT method', async () => {
      const router = new Router();
      router.put('/users/:id', (ctx) => {
        ctx.responseBody = { updated: ctx.params.id, body: ctx.body };
      });

      const result = await router.handle('PUT', '/users/42', {}, { name: 'Updated' });

      expect(result.body).toEqual({ updated: '42', body: { name: 'Updated' } });
    });

    it('should support PATCH method', async () => {
      const router = new Router();
      router.patch('/users/:id', (ctx) => {
        ctx.responseBody = { patched: ctx.params.id };
      });

      const result = await router.handle('PATCH', '/users/99');

      expect(result.body).toEqual({ patched: '99' });
    });
  });

  describe('headers handling', () => {
    it('should pass headers to context', async () => {
      const router = new Router();
      let receivedHeaders: Record<string, string> = {};

      router.get('/test', (ctx) => {
        receivedHeaders = ctx.headers;
        ctx.responseBody = { received: true };
      });

      await router.handle('GET', '/test', { 'authorization': 'Bearer token123', 'content-type': 'application/json' });

      expect(receivedHeaders).toEqual({
        authorization: 'Bearer token123',
        'content-type': 'application/json',
      });
    });
  });
});
