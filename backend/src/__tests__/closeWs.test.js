'use strict';

const { closeWithNotice } = require('../ws/closeWs');

describe('closeWithNotice', () => {
  it('announces the close code as a message before closing an open socket', () => {
    const ws = { readyState: 1, send: jest.fn(), close: jest.fn() };
    closeWithNotice(ws, 4005, 'Room not accepting connections');
    expect(JSON.parse(ws.send.mock.calls[0][0])).toEqual({
      type: 'closing', code: 4005, reason: 'Room not accepting connections',
    });
    expect(ws.close).toHaveBeenCalledWith(4005, 'Room not accepting connections');
  });

  it('skips the notice when the socket is not open', () => {
    const ws = { readyState: 3, send: jest.fn(), close: jest.fn() };
    closeWithNotice(ws, 4001, 'Unauthorized');
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.close).toHaveBeenCalledWith(4001, 'Unauthorized');
  });
});
