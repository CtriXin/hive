import { describe, expect, it } from 'vitest';
import { resolveProxyTargetUrl } from '../orchestrator/model-proxy.js';

describe('model-proxy target URL normalization', () => {
  it('avoids duplicating /v1 for bridge routes that already end with /v1', () => {
    expect(
      resolveProxyTargetUrl('https://chat.adsconflux.xyz/openapi/v1', '/v1/messages'),
    ).toBe('https://chat.adsconflux.xyz/openapi/v1/messages');
  });

  it('preserves provider prefixes such as /openai', () => {
    expect(
      resolveProxyTargetUrl('https://crs.adsconflux.xyz/openai', '/v1/messages'),
    ).toBe('https://crs.adsconflux.xyz/openai/v1/messages');
  });

  it('appends the request path for plain host routes', () => {
    expect(
      resolveProxyTargetUrl('http://127.0.0.1:4001', '/v1/messages'),
    ).toBe('http://127.0.0.1:4001/v1/messages');
  });
});
