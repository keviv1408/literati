'use strict';

process.env.FRONTEND_URL = 'https://literati-ochre.vercel.app';

const request = require('supertest');
const app = require('../index');

function _preflight(origin) {
  return request(app)
    .options('/api/rooms')
    .set('Origin', origin)
    .set('Access-Control-Request-Method', 'POST');
}

describe('CORS origins', () => {
  it.each([
    'https://localhost',
    'https://literati-ochre.vercel.app',
    'http://localhost:3011',
  ])('allows %s', async (origin) => {
    const res = await _preflight(origin);
    expect(res.headers['access-control-allow-origin']).toBe(origin);
  });

  it('does not allow an unknown origin', async () => {
    const res = await _preflight('https://example.com');
    expect(res.headers['access-control-allow-origin']).toBeUndefined();
  });
});
