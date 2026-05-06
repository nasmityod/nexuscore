'use strict';

/**
 * Capa de almacenamiento Redis con dos modos:
 *
 * 1) REST (Upstash / @vercel/kv) — preferido en serverless “puro”
 *    KV_REST_API_URL + KV_REST_API_TOKEN
 *    (o UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
 *
 * 2) TCP (redis://…) — Redis Cloud, Redis Labs, muchas integraciones Vercel
 *    KV_REDIS_URL o REDIS_URL
 *    Usa el paquete `redis` (node-redis). El cliente se reutiliza en globalThis
 *    entre invocaciones calientes de la misma lambda.
 *
 * No mezcles en el mismo deploy credenciales de dos bases distintas.
 */

const { createClient: createRestClient } = require('@vercel/kv');

function pickRestCredentials() {
  if (process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
    return { url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN };
  }
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    return {
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    };
  }
  return null;
}

function pickTcpUrl() {
  return process.env.KV_REDIS_URL || process.env.REDIS_URL || '';
}

/**
 * Adaptador con la misma forma de uso que @vercel/kv en este proyecto.
 */
class TcpKvAdapter {
  async _client() {
    const g = globalThis;
    if (!g.__nexusLicenseRedis) {
      const { createClient } = require('redis');
      const url = pickTcpUrl();
      const client = createClient({
        url,
        socket: {
          connectTimeout: 10_000,
          reconnectStrategy: () => false,
        },
      });
      client.on('error', (e) => console.error('[redis-tcp]', e && e.message));
      await client.connect();
      g.__nexusLicenseRedis = client;
    }
    return g.__nexusLicenseRedis;
  }

  async get(key) {
    const c = await this._client();
    const raw = await c.get(key);
    if (raw == null) return null;
    try {
      return JSON.parse(raw);
    } catch {
      const n = Number(raw);
      return Number.isFinite(n) ? n : raw;
    }
  }

  async set(key, value, opts = {}) {
    const c = await this._client();
    const payload = typeof value === 'string' ? value : JSON.stringify(value);
    if (opts.ex) {
      await c.set(key, payload, { EX: opts.ex });
    } else {
      await c.set(key, payload);
    }
  }

  async incr(key) {
    const c = await this._client();
    return Number(await c.incr(key));
  }

  async expire(key, seconds) {
    const c = await this._client();
    await c.expire(key, seconds);
  }

  async ttl(key) {
    const c = await this._client();
    return await c.ttl(key);
  }

  async del(key) {
    const c = await this._client();
    await c.del(key);
  }

  /**
   * Compatible con @vercel/kv: [nextCursor, keys]
   */
  async scan(cursorIn, options = {}) {
    const c = await this._client();
    const cursor = cursorIn === 0 || cursorIn === undefined || cursorIn === ''
      ? '0'
      : String(cursorIn);
    const reply = await c.scan(cursor, {
      MATCH: options.match,
      COUNT: options.count || 10,
    });
    return [reply.cursor, reply.keys];
  }

  async mget(...keys) {
    if (!keys.length) return [];
    const c = await this._client();
    const raw = await c.mGet(keys);
    return raw.map((v) => {
      if (v == null) return null;
      try {
        return JSON.parse(v);
      } catch {
        return {};
      }
    });
  }

  async lpush(key, ...elements) {
    const c = await this._client();
    await c.lPush(key, elements);
  }

  async ltrim(key, start, stop) {
    const c = await this._client();
    await c.lTrim(key, start, stop);
  }

  async ping() {
    const c = await this._client();
    await c.ping();
  }
}

const restCreds = pickRestCredentials();
const tcpUrl    = pickTcpUrl();

let kv;
if (restCreds) {
  kv = createRestClient({
    url: restCreds.url,
    token: restCreds.token,
  });
} else if (tcpUrl) {
  kv = new TcpKvAdapter();
} else {
  const errMsg =
    'Redis no configurado: o bien KV_REST_API_URL + KV_REST_API_TOKEN (REST), ' +
    'o bien KV_REDIS_URL / REDIS_URL (redis://… para cliente TCP).';
  kv = new Proxy(
    {},
    {
      get() {
        throw new Error(errMsg);
      },
    }
  );
}

module.exports = { kv };
