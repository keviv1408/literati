import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import ReconnectBar from '@/components/ReconnectBar';

describe('ReconnectBar', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('shows "Reconnecting…" and no button at first', () => {
    render(<ReconnectBar onRetry={jest.fn()} />);

    const bar = screen.getByTestId('ws-reconnecting-banner');
    expect(bar).toHaveAttribute('role', 'status');
    expect(screen.getByText('Reconnecting…')).toBeTruthy();
    expect(screen.queryByTestId('ws-retry-now')).toBeNull();
  });

  it('adds the restart hint and "Try now" after 10 000 ms', () => {
    render(<ReconnectBar onRetry={jest.fn()} />);

    act(() => { jest.advanceTimersByTime(9_999); });
    expect(screen.queryByTestId('ws-retry-now')).toBeNull();

    act(() => { jest.advanceTimersByTime(1); });
    expect(screen.getByText('Reconnecting… the server may be restarting.')).toBeTruthy();
    expect(screen.getByTestId('ws-retry-now').textContent).toBe('Try now');
  });

  it('calls onRetry once per click on "Try now"', () => {
    const onRetry = jest.fn();
    render(<ReconnectBar onRetry={onRetry} />);
    act(() => { jest.advanceTimersByTime(10_000); });

    fireEvent.click(screen.getByTestId('ws-retry-now'));

    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});
