// HTTP Router with Middleware Pipeline - Tests (Vitest)
import { describe, it, expect } from 'vitest';
import { Router, Context, createRouter, Middleware } from './router';

describe('HTTP Router', () => {
  it('basic route matching with params', async () => {
    const router = createRouter();
    let capturedId: string | null = null;

    router.get('/users/:id', async (ctx: Context) => {
      capturedId = ctx.params.id;
      ctx.status = 200;
      ctx.responseBody = { userId: ctx.params.id };
    });

    const response = await router.handle({
      method: 'GET',
      path: '/users/123'
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: '123' });
    expect(capturedId).toBe('123');
  });

  it('query parameter parsing', async () => {
    const router = createRouter();

    router.get('/search', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = { query: ctx.query };
    });

    const response = await router.handle({
      method: 'GET',
      path: '/search?q=test&page=1'
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ query: { q: 'test', page: '1' } });
  });

  it('global middleware execution order', async () => {
    const router = createRouter();
    const order: string[] = [];

    router.use(async (ctx: Context, next: () => Promise<void>) => {
      order.push('global-before');
      await next();
      order.push('global-after');
    });

    router.get('/test', async (ctx: Context) => {
      order.push('handler');
      ctx.status = 200;
      ctx.responseBody = { ok: true };
    });

    await router.handle({ method: 'GET', path: '/test' });

    expect(order).toEqual(['global-before', 'handler', 'global-after']);
  });

  it('path prefix middleware only matches corresponding paths', async () => {
    const router = createRouter();
    const logs: string[] = [];

    router.use('/api', async (ctx: Context, next: () => Promise<void>) => {
      logs.push('api-middleware');
      await next();
    });

    router.get('/api/users', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = { api: true };
    });

    router.get('/public/users', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = { public: true };
    });

    const apiResponse = await router.handle({ method: 'GET', path: '/api/users' });
    const publicResponse = await router.handle({ method: 'GET', path: '/public/users' });

    expect(logs).toEqual(['api-middleware']);
    expect(apiResponse.body).toEqual({ api: true });
    expect(publicResponse.body).toEqual({ public: true });
  });

  it('onion model: middleware can read responseBody after next()', async () => {
    const router = createRouter();
    let capturedResponse: unknown = null;

    router.use(async (ctx: Context, next: () => Promise<void>) => {
      await next();
      capturedResponse = ctx.responseBody;
      ctx.responseBody = { ...ctx.responseBody as object, modified: true };
    });

    router.get('/data', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = { original: true };
    });

    const response = await router.handle({ method: 'GET', path: '/data' });

    expect(capturedResponse).toEqual({ original: true });
    expect(response.body).toEqual({ original: true, modified: true });
  });

  it('error handling: handler throws exception', async () => {
    const router = createRouter();

    router.get('/error', async (ctx: Context) => {
      throw new Error('Something went wrong');
    });

    const response = await router.handle({ method: 'GET', path: '/error' });

    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: 'Something went wrong' });
  });

  it('error handling: middleware catches error', async () => {
    const router = createRouter();
    let capturedError: Error | null = null;

    router.use(async (ctx: Context, next: () => Promise<void>) => {
      try {
        await next();
      } catch (err) {
        capturedError = err as Error;
        ctx.status = 500;
        ctx.responseBody = { caught: true, message: (err as Error).message };
      }
    });

    router.get('/error', async (ctx: Context) => {
      throw new Error('Handler error');
    });

    const response = await router.handle({ method: 'GET', path: '/error' });

    expect(capturedError).not.toBeNull();
    expect(capturedError?.message).toBe('Handler error');
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ caught: true, message: 'Handler error' });
  });

  it('404 for unmatched route', async () => {
    const router = createRouter();

    router.get('/exists', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = { ok: true };
    });

    const response = await router.handle({ method: 'GET', path: '/not-exists' });

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'Not Found', path: '/not-exists' });
  });

  it('state sharing between middlewares', async () => {
    const router = createRouter();

    router.use(async (ctx: Context, next: () => Promise<void>) => {
      ctx.state.user = { id: '123', name: 'Test' };
      await next();
    });

    router.use(async (ctx: Context, next: () => Promise<void>) => {
      ctx.state.requestTime = Date.now();
      await next();
    });

    router.get('/profile', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = {
        user: ctx.state.user,
        requestTime: ctx.state.requestTime
      };
    });

    const response = await router.handle({ method: 'GET', path: '/profile' });

    expect(response.status).toBe(200);
    expect((response.body as any).user).toEqual({ id: '123', name: 'Test' });
    expect((response.body as any).requestTime).toBeDefined();
  });

  it('POST and DELETE methods', async () => {
    const router = createRouter();
    const calls: string[] = [];

    router.post('/users', async (ctx: Context) => {
      calls.push('post');
      ctx.status = 201;
      ctx.responseBody = { created: true };
    });

    router.delete('/users/:id', async (ctx: Context) => {
      calls.push('delete');
      ctx.status = 204;
      ctx.responseBody = { deleted: ctx.params.id };
    });

    const postResponse = await router.handle({
      method: 'POST',
      path: '/users',
      body: { name: 'Test' }
    });

    const deleteResponse = await router.handle({
      method: 'DELETE',
      path: '/users/456'
    });

    expect(calls).toEqual(['post', 'delete']);
    expect(postResponse.status).toBe(201);
    expect(deleteResponse.status).toBe(204);
    expect(deleteResponse.body).toEqual({ deleted: '456' });
  });

  it('multiple path params', async () => {
    const router = createRouter();

    router.get('/users/:userId/posts/:postId', async (ctx: Context) => {
      ctx.status = 200;
      ctx.responseBody = {
        userId: ctx.params.userId,
        postId: ctx.params.postId
      };
    });

    const response = await router.handle({
      method: 'GET',
      path: '/users/42/posts/100'
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ userId: '42', postId: '100' });
  });

  it('middleware execution order: global then prefix then handler', async () => {
    const router = createRouter();
    const order: string[] = [];

    router.use(async (ctx: Context, next: () => Promise<void>) => {
      order.push('global-before');
      await next();
      order.push('global-after');
    });

    router.use('/api', async (ctx: Context, next: () => Promise<void>) => {
      order.push('api-before');
      await next();
      order.push('api-after');
    });

    router.get('/api/users', async (ctx: Context) => {
      order.push('handler');
      ctx.status = 200;
      ctx.responseBody = { ok: true };
    });

    await router.handle({ method: 'GET', path: '/api/users' });

    expect(order).toEqual([
      'global-before',
      'api-before',
      'handler',
      'api-after',
      'global-after'
    ]);
  });
});
