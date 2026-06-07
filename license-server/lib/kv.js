'use strict';

/**
 * Capa de almacenamiento Redis con dos modos:
 *
 * 1) REST (Upstash) — preferido en serverless
 *    KV_REST_API_URL + KV_REST_API_TOKEN
 *    (o UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
 *    Cliente: @upstash/redis (reemplazo oficial de @vercel/kv, deprecado).
 *
 * 2) TCP (redis://…) — Redis Cloud / integraciones TCP
 *    KV_REDIS_URL o REDIS_URL — paquete `redis` (node-redis).
 *
 * No mezcles en el mismo deploy credenciales de dos bases distintas.
 */

const { Redis } = require('@upstash/redis');

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
 * Adaptador REST con la misma forma de uso que tenía @vercel/kv en este proyecto.
 */
class RestKvAdapter {
  constructor(creds) {
    this._redis = new Redis({ url: creds.url, token: creds.token });
  }

  async get(key) {
    return this._redis.get(key);
  }

  async set(key, value, opts = {}) {
    if (opts.ex) {
      return this._redis.set(key, value, { ex: opts.ex });
    }
    return this._redis.set(key, value);
  }

  async incr(key) {
    return this._redis.incr(key);
  }

  async expire(key, seconds) {
    return this._redis.expire(key, seconds);
  }

  async ttl(key) {
    return this._redis.ttl(key);
  }

  async del(key) {
    return this._redis.del(key);
  }

  /** Compatible con el contrato previo: [nextCursor, keys] */
  async scan(cursorIn, options = {}) {
    const cursor = cursorIn === 0 || cursorIn === undefined || cursorIn === ''
      ? 0
      : Number(cursorIn);
    const result = await this._redis.scan(cursor, {
      match: options.match,
      count: options.count || 10,
    });
    if (Array.isArray(result)) return result;
    return [result.cursor ?? 0, result.keys ?? []];
  }

  async mget(...keys) {
    if (!keys.length) return [];
    return this._redis.mget(...keys);
  }

  async lpush(key, ...elements) {
    return this._redis.lpush(key, ...elements);
  }

  async ltrim(key, start, stop) {
    return this._redis.ltrim(key, start, stop);
  }

  async ping() {
    return this._redis.ping();
  }
}

/**
 * Adaptador TCP (node-redis) — misma interfaz que RestKvAdapter.
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
const tcpUrl = pickTcpUrl();

let kv;
if (restCreds) {
  kv = new RestKvAdapter(restCreds);
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
