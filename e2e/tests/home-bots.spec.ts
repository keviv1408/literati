import { expect, test } from '@playwright/test';

test('a newcomer can start a hand with five bots from the table guide', async ({ page }) => {
  const rosters: { isBot: boolean }[][] = [];
  page.on('websocket', socket => {
    if (!socket.url().includes('/ws/game/')) return;
    socket.on('framereceived', ({ payload }) => {
      const message = JSON.parse(String(payload));
      if (message.type === 'game_init') rosters.push(message.players);
    });
  });

  await page.goto('/#full-tutorial');
  await page.getByRole('button', { name: 'Play with bots' }).click();
  await expect(page).toHaveURL(/\/game\/[A-Z0-9]{6}$/, { timeout: 30_000 });
  await expect(page.getByTestId('player-hand-area')).toBeVisible();
  expect(rosters.at(-1)).toHaveLength(6);
  expect(rosters.at(-1)?.filter(player => player.isBot)).toHaveLength(5);
});
