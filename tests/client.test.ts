import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { DynamicParam, Endpoint } from 'fetchdts';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { createRouteFetch } from '../src/client.ts';

interface TestRoutes {
  '/users': {
    [Endpoint]: {
      GET: { query: { name: string }; response: { name: string } };
      POST: { body: { name: string }; response: { id: number } };
    };
    [DynamicParam]: { [Endpoint]: { GET: { response: { id: string } } } };
  };
  '/failure': { [Endpoint]: { GET: { response: never } } };
}

const server = createServer((request, response) => {
  const url = new URL(request.url!, 'http://localhost');
  response.setHeader('content-type', 'application/json');
  if (url.pathname === '/failure') {
    response.writeHead(422);
    response.end(JSON.stringify({ message: 'Invalid request' }));
    return;
  }
  if (request.method === 'POST') {
    let body = '';
    request.on('data', chunk => {
      body += chunk;
    });
    request.on('end', () => {
      const parsed = JSON.parse(body) as { name: string };
      response.end(JSON.stringify({ id: parsed.name.length }));
    });
    return;
  }
  response.end(
    JSON.stringify(
      url.pathname === '/users'
        ? { name: url.searchParams.get('name') }
        : { id: url.pathname.split('/').at(-1) },
    ),
  );
});
let baseURL: string;
beforeAll(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close(error => (error ? reject(error) : resolve())),
  );
});

describe('ofetch client', () => {
  test('uses typed query, JSON body and dynamic paths', async () => {
    const fetch = createRouteFetch<TestRoutes>({ baseURL });
    expect(await fetch('/users', { query: { name: 'Codex' } })).toEqual({ name: 'Codex' });
    expect(await fetch('/users', { method: 'POST', body: { name: 'Codex' } })).toEqual({ id: 5 });
    expect(await fetch('/users/42')).toEqual({ id: '42' });
  });
  test('preserves ofetch error responses', async () => {
    const fetch = createRouteFetch<TestRoutes>({ baseURL });
    await expect(fetch('/failure')).rejects.toMatchObject({
      status: 422,
      data: { message: 'Invalid request' },
    });
  });
});

// 只由类型检查执行约束验证。
export async function checkClientTypes() {
  const fetch = createRouteFetch<TestRoutes>();
  const user = await fetch('/users', { query: { name: 'Codex' } });
  const name: string = user.name;
  const created = await fetch('/users', { method: 'POST', body: { name } });
  const id: number = created.id;
  // @ts-expect-error 路由不存在
  await fetch('/missing');
  // @ts-expect-error 缺少 query
  await fetch('/users');
  // @ts-expect-error 错误 query 类型
  await fetch('/users', { query: { name: 123 } });
  // @ts-expect-error 缺少 body
  await fetch('/users', { method: 'POST' });
  // @ts-expect-error HTTP method 不存在
  await fetch('/users', { method: 'DELETE' });
  // @ts-expect-error 动态参数不能匹配多段路径
  await fetch('/users/42/extra');
  // @ts-expect-error JSON 响应不能指定非 JSON responseType
  await fetch('/users/42', { responseType: 'text' });
  return id;
}
