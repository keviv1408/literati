'use strict';

const request = require('supertest');

const { _setSupabaseClient } = require('../db/supabase');
const app = require('../index');

function _buildSupabaseMock() {
  const chain = {};
  chain.select = jest.fn().mockReturnValue(chain);
  chain.limit = jest.fn();
  return { client: { from: jest.fn().mockReturnValue(chain) }, chain };
}

describe('GET /health/db', () => {
  let mock;
  let consoleErrorSpy;

  beforeEach(() => {
    mock = _buildSupabaseMock();
    _setSupabaseClient(mock.client);
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    jest.useRealTimers();
    consoleErrorSpy.mockRestore();
    _setSupabaseClient(null);
  });

  it('returns 200 ok when the query succeeds', async () => {
    mock.chain.limit.mockResolvedValue({ data: [], error: null });

    const res = await request(app).get('/health/db');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
    expect(mock.client.from).toHaveBeenCalledWith('rooms');
    expect(mock.chain.select).toHaveBeenCalledWith('id');
    expect(mock.chain.limit).toHaveBeenCalledWith(1);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });

  it('returns 503 without error text when the query returns an error', async () => {
    mock.chain.limit.mockResolvedValue({ data: null, error: { message: 'boom' } });

    const res = await request(app).get('/health/db');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(Number.isNaN(Date.parse(res.body.timestamp))).toBe(false);
    expect(JSON.stringify(res.body)).not.toContain('boom');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('returns 503 when the query throws', async () => {
    mock.chain.limit.mockRejectedValue(new Error('fetch failed'));

    const res = await request(app).get('/health/db');

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(JSON.stringify(res.body)).not.toContain('fetch failed');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('returns 503 when the query takes longer than 5 seconds', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    let markQueried;
    const queried = new Promise((resolve) => { markQueried = resolve; });
    mock.chain.limit.mockImplementation(() => {
      markQueried();
      return new Promise(() => {});
    });

    let settled = false;
    const pending = request(app).get('/health/db').then((res) => {
      settled = true;
      return res;
    });
    await Promise.race([queried, pending]);
    await jest.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    expect(consoleErrorSpy).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    const res = await pending;

    expect(res.status).toBe(503);
    expect(res.body.status).toBe('error');
    expect(consoleErrorSpy).toHaveBeenCalled();
  });

  it('clears the timeout once the query settles', async () => {
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    mock.chain.limit.mockResolvedValue({ data: [], error: null });

    const res = await request(app).get('/health/db');

    expect(res.status).toBe(200);
    expect(jest.getTimerCount()).toBe(0);
  });
});

describe('GET /health', () => {
  it('returns 200 without touching Supabase', async () => {
    const mock = _buildSupabaseMock();
    _setSupabaseClient(mock.client);

    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(mock.client.from).not.toHaveBeenCalled();
    _setSupabaseClient(null);
  });
});
