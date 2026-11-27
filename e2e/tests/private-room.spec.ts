import { expect, test } from '@playwright/test';

test('a host can replace a waiting 3v3 lobby with a new 4v4 lobby', async ({ page: host, browser }) => {
  const guestContext = await browser.newContext();
  try {
    const guest = await guestContext.newPage();
    await host.goto('/');
    await host.getByRole('button', { name: /Private Room/ }).click();
    await host.getByPlaceholder('e.g. CardShark99').fill('Lobby Host');
    await host.getByRole('button', { name: 'Continue as Guest' }).click();
    await host.getByRole('button', { name: 'Create Room', exact: true }).click();
    await expect(host.getByTestId('lobby-player-count')).toHaveText(/^1\/6/, { timeout: 30_000 });

    const originalUrl = new URL(host.url());
    const code = originalUrl.pathname.split('/').at(-1)!;
    await guest.goto(originalUrl.origin);
    await guest.getByRole('textbox', { name: 'Join by code' }).fill(code.toLowerCase());
    await guest.getByRole('button', { name: 'Join room' }).click();
    await guest.getByTestId('join-name-input').fill('Lobby Guest');
    await guest.getByTestId('join-room-btn').click();
    await expect(guest.getByTestId('lobby-player-count')).toHaveText(/^2\/6/);
    await expect(guest.getByRole('button', { name: 'Abandon lobby' })).toHaveCount(0);

    for (const player of [guest, host]) {
      await player.getByRole('button', { name: /Back to Home/ }).click();
      await expect(player).toHaveURL(originalUrl.origin + '/');
      await player.reload();
      await player.getByRole('button', { name: /Return to lobby/ }).click();
      await expect(player).toHaveURL(originalUrl.href);
      await expect(player.getByTestId('lobby-player-count')).toHaveText(/^2\/6/);
    }

    await host.getByRole('button', { name: 'Abandon lobby', exact: true }).click();
    const confirmation = host.getByRole('alertdialog');
    await confirmation.getByRole('button', { name: 'Cancel' }).click();
    await expect(host.getByTestId('lobby-player-count')).toHaveText(/^2\/6/);
    await host.getByRole('button', { name: 'Abandon lobby', exact: true }).click();
    await confirmation.getByRole('button', { name: 'Confirm abandon' }).click();
    await expect(guest.getByRole('heading', { name: 'Lobby closed' })).toBeVisible();

    await expect(host.getByRole('heading', { name: 'Lobby closed' })).toBeVisible();
    await host.getByRole('button', { name: 'Back to Home' }).click();
    await host.getByRole('button', { name: /Private Room/ }).click();
    await host.getByText('4v4', { exact: true }).click();
    await host.getByRole('button', { name: 'Create Room', exact: true }).click();
    await expect(host.getByTestId('lobby-player-count')).toHaveText(/^1\/8/);
    await expect(host).not.toHaveURL(originalUrl.href);

    const newcomer = await browser.newPage();
    try {
      await newcomer.goto(originalUrl.href);
      await expect(newcomer.getByRole('heading', { name: 'Lobby closed' })).toBeVisible();
      await expect(newcomer.getByTestId('join-room-btn')).toHaveCount(0);
    } finally {
      await newcomer.close();
    }
  } finally {
    await guestContext.close();
  }
});
