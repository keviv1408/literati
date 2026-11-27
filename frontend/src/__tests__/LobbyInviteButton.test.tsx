import { Capacitor } from '@capacitor/core';
import { Share } from '@capacitor/share';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import LobbyInviteButton from '@/components/LobbyInviteButton';

jest.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: jest.fn() } }));
jest.mock('@capacitor/share', () => ({ Share: { canShare: jest.fn(), share: jest.fn() } }));

const LINK = 'https://literati-ochre.vercel.app/room/ABC123';
const UNAVAILABLE = 'Invite link unavailable. Reopen this room and try again.';
const mockIsNative = jest.mocked(Capacitor.isNativePlatform);
const mockCanShare = jest.mocked(Share.canShare);
const mockShare = jest.mocked(Share.share);
const mockWriteText = jest.fn();

function _renderInvite(inviteLink?: string) {
  const props = { roomCode: 'ABC123', inviteLink };
  const user = userEvent.setup();
  jest.spyOn(navigator.clipboard, 'writeText').mockImplementation(mockWriteText);
  render(<LobbyInviteButton {...props} />);
  return () => user.click(screen.getByRole('button', { name: 'Invite friends' }));
}

beforeEach(() => {
  jest.resetAllMocks();
  process.env.NEXT_PUBLIC_BUILD_TARGET = 'android';
  mockIsNative.mockReturnValue(true);
  mockCanShare.mockResolvedValue({ value: true });
  mockShare.mockResolvedValue({});
  mockWriteText.mockResolvedValue(undefined);
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_BUILD_TARGET;
  jest.restoreAllMocks();
});

it('opens the Android share sheet with the public invite link', async () => {
  await _renderInvite(LINK)();

  await waitFor(() => expect(mockShare).toHaveBeenCalledTimes(1));
  expect(mockShare).toHaveBeenCalledWith({ title: 'Play Literati', url: LINK });
  expect(mockWriteText).not.toHaveBeenCalled();
});

it('shows the unavailable message without sharing when Android has no public invite link', async () => {
  await _renderInvite()();

  expect(await screen.findByText(UNAVAILABLE)).toBeVisible();
  expect(mockShare).not.toHaveBeenCalled();
  expect(mockWriteText).not.toHaveBeenCalled();
});

it('leaves Android sharing available without copying after the share sheet is dismissed', async () => {
  mockShare.mockRejectedValue(new Error('Share canceled'));
  const tap = _renderInvite(LINK);

  await tap();
  await waitFor(() => expect(mockShare).toHaveBeenCalledTimes(1));
  await tap();

  await waitFor(() => expect(mockShare).toHaveBeenCalledTimes(2));
  expect(mockWriteText).not.toHaveBeenCalled();
  expect(screen.queryByText(UNAVAILABLE)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Invite friends' })).toBeEnabled();
});

it('copies the public invite link when the Android share sheet fails', async () => {
  mockShare.mockRejectedValue(new Error('Unsupported url'));
  await _renderInvite(LINK)();

  await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(LINK));
});

it('copies the public invite link when native sharing is unavailable', async () => {
  mockCanShare.mockResolvedValue({ value: false });
  await _renderInvite(LINK)();

  await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(LINK));
  expect(mockShare).not.toHaveBeenCalled();
});

it('copies the public invite link when the Android build runs in a browser', async () => {
  mockIsNative.mockReturnValue(false);
  await _renderInvite(LINK)();

  await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith(LINK));
  expect(mockShare).not.toHaveBeenCalled();
});

it('copies a link from the current browser origin in the web build', async () => {
  delete process.env.NEXT_PUBLIC_BUILD_TARGET;
  await _renderInvite(LINK)();

  await waitFor(() => expect(mockWriteText).toHaveBeenCalledWith('http://localhost/room/ABC123'));
  expect(mockIsNative).not.toHaveBeenCalled();
});
