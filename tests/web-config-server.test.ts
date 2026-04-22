import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { AddressInfo } from 'net';
import type { Server } from 'http';
import { createConfigServer, loadMmsData } from '../web-config/server.js';

const TMP_ROOT = path.join(os.tmpdir(), 'hive-web-config-server-test');
const CONFIG_PATH = path.join(TMP_ROOT, '.hive', 'config.json');
const MMS_ROUTES_PATH = path.join(TMP_ROOT, '.config', 'mms', 'model-routes.json');

function resetDir(): void {
  fs.rmSync(TMP_ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(MMS_ROUTES_PATH), { recursive: true });
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf-8');
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

describe('web-config server', () => {
  let server: Server | null = null;
  let baseUrl = '';

  beforeEach(async () => {
    resetDir();
    writeJson(CONFIG_PATH, {
      tiers: {
        planner: { model: 'kimi-for-coding', fallback: 'glm-5-turbo' },
      },
      model_channel_map: {
        'kimi-for-coding': 'newapi-personal-tokyo',
      },
    });
    writeJson(MMS_ROUTES_PATH, {
      version: 1,
      generated_at: '2026-04-21T00:00:00.000Z',
      routes: {
        'kimi-for-coding': {
          primary: {
            provider_id: 'newapi-personal-tokyo',
            anthropic_base_url: 'http://127.0.0.1:9000/v1',
            api_key: 'sk-kimi',
          },
          fallbacks: [
            {
              provider_id: 'backup-kimi',
              anthropic_base_url: 'http://127.0.0.1:9001/v1',
              api_key: 'sk-kimi-2',
            },
          ],
        },
        'gpt-5.4': {
          primary: {
            provider_id: 'uscrsopenai',
            anthropic_base_url: 'http://127.0.0.1:9100/openai',
            openai_base_url: 'http://127.0.0.1:9100/openai',
            api_key: 'sk-gpt',
          },
          fallbacks: [],
        },
      },
    });

    server = createConfigServer({
      configPath: CONFIG_PATH,
      mmsRoutesPath: MMS_ROUTES_PATH,
      rootDir: process.cwd(),
      staticDir: path.join(process.cwd(), 'web-config'),
    });
    baseUrl = await listen(server);
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve, reject) => {
        server?.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    }
    server = null;
  });

  it('loadMmsData returns normalized models and providers', () => {
    const data = loadMmsData(MMS_ROUTES_PATH);
    expect(data.exists).toBe(true);
    expect(data.models.map((item) => item.id)).toEqual(['gpt-5.4', 'kimi-for-coding']);
    expect(data.providers.map((item) => item.id)).toEqual(['backup-kimi', 'newapi-personal-tokyo', 'uscrsopenai']);
  });

  it('serves static index without permissive cors header', async () => {
    const res = await fetch(`${baseUrl}/`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
    expect(html).toContain('Hive 配置中心');
  });

  it('reads and writes config through api', async () => {
    const before = await fetch(`${baseUrl}/api/config`).then((res) => res.json());
    expect(before.path).toBe(CONFIG_PATH);
    expect(before.config.tiers.planner.model).toBe('kimi-for-coding');

    const save = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        config: {
          tiers: { planner: { model: 'gpt-5.4', fallback: 'auto' } },
          model_channel_map: { 'gpt-5.4': 'uscrsopenai' },
        },
      }),
    });

    expect(save.status).toBe(200);
    const saved = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
    expect((saved.tiers as { planner: { model: string } }).planner.model).toBe('gpt-5.4');
  });

  it('returns 400 on malformed json body', async () => {
    const res = await fetch(`${baseUrl}/api/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{bad json',
    });

    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'Invalid JSON body' });
  });

  it('returns api data with mms metadata', async () => {
    const res = await fetch(`${baseUrl}/api/data`);
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data.mms.path).toBe(MMS_ROUTES_PATH);
    expect(data.mms.models).toHaveLength(2);
    expect(data.capabilities.models).toBeTypeOf('object');
  });
});
