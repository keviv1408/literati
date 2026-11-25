import { claimChunkReload } from '@/lib/chunkReload';

function _chunkError() {
  const error = new Error('Failed to load chunk /_next/static/chunks/a5d6beab97291f98.js from module 64918');
  error.name = 'ChunkLoadError';
  return error;
}

beforeEach(() => {
  jest.useFakeTimers();
  window.sessionStorage.clear();
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

it('claims a reload for a chunk load error', () => {
  expect(claimChunkReload(_chunkError())).toBe(true);
});

it('claims no second reload within 60 s, so a broken deploy cannot loop', () => {
  claimChunkReload(_chunkError());
  jest.advanceTimersByTime(59_999);
  expect(claimChunkReload(_chunkError())).toBe(false);
  jest.advanceTimersByTime(1);
  expect(claimChunkReload(_chunkError())).toBe(true);
});

it('ignores other errors', () => {
  expect(claimChunkReload(new Error('boom'))).toBe(false);
  expect(claimChunkReload(undefined)).toBe(false);
});

it('claims nothing when session storage is unavailable', () => {
  jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('denied');
  });
  expect(claimChunkReload(_chunkError())).toBe(false);
});
