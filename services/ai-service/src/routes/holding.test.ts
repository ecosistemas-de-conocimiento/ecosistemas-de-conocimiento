// The holding page at `/`: served without a token, and nothing else moved.

import { describe, expect, it } from 'vitest';

async function makeApp() {
  const { buildServer } = await import('../server.js');
  return buildServer();
}

describe('holding page', () => {
  it('serves index.html, the CSS and the logo without a bearer token', async () => {
    const app = await makeApp();

    const page = await app.inject({ method: 'GET', url: '/' });
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toMatch(/^text\/html/);
    expect(page.body).toContain('class="holding"');

    const css = await app.inject({ method: 'GET', url: '/holding.css' });
    expect(css.statusCode).toBe(200);
    expect(css.headers['content-type']).toMatch(/^text\/css/);

    const logo = await app.inject({
      method: 'GET',
      url: '/assets/brand-logo-color.svg',
    });
    expect(logo.statusCode).toBe(200);
    expect(logo.headers['content-type']).toBe('image/svg+xml');

    await app.close();
  });

  it('leaves an unknown path on Fastify’s default 404', async () => {
    const app = await makeApp();
    for (const url of ['/nope', '/assets/other.svg', '/index.html']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(404);
      expect(res.json(), url).toEqual({
        message: `Route GET:${url} not found`,
        error: 'Not Found',
        statusCode: 404,
      });
    }
    await app.close();
  });
});
