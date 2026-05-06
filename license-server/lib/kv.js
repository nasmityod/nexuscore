'use strict';

/**
 * Cliente único para Redis vía API REST (Upstash), que es lo que usa @vercel/kv.
 *
 * Vercel suele inyectar KV_REDIS_URL (redis://…) para clientes TCP; ese valor
 * NO sirve para @vercel/kv en serverless. Hacen falta credenciales REST:
 *   KV_REST_API_URL + KV_REST_API_TOKEN
 * o las equivalentes:
 *   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
 */

const { createClient } = require('@vercel/kv');

function pickCredentials() {
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

const creds = pickCredentials();

if (!creds) {
  const errMsg =
    'Redis REST no configurado: añade KV_REST_API_URL y KV_REST_API_TOKEN en Vercel ' +
    '(o UPSTASH_REDIS_REST_URL y UPSTASH_REDIS_REST_TOKEN). ' +
    'KV_REDIS_URL (redis://) no es suficiente para @vercel/kv. ' +
    'En Vercel → Storage → tu Redis: abre los detalles o el enlace a Upstash y copia el Endpoint REST y el Token.';

  module.exports.kv = new Proxy(
    {},
    {
      get() {
        throw new Error(errMsg);
      },
    }
  );
} else {
  module.exports.kv = createClient({
    url: creds.url,
    token: creds.token,
  });
}
