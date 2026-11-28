import { expect, test, type Page } from '@playwright/test';

function _team(page: Page, team: number) {
  return page.getByRole('region', { name: `Team ${team} column` });
}

async function _drag(page: Page, player: RegExp, team: number, opponent?: string) {
  await page.bringToFront();
  const card = page.getByRole('button', { name: player });
  const target = opponent ? _team(page, team).getByRole('button', { name: opponent, exact: true }) : _team(page, team).getByRole('heading');
  await card.scrollIntoViewIfNeeded();
  const start = (await card.boundingBox())!;
  const end = (await target.boundingBox())!;
  const x = start.x + start.width / 2;
  const y = start.y + start.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 12, y);
  await page.mouse.move(end.x + end.width / 2, end.y + end.height / 2, { steps: 8 });

  await page.mouse.up();
}

async function _createRoom(host: Page) {
  await host.goto('/');
  await host.getByRole('button', { name: /Play now!/ }).click();
  await host.getByPlaceholder('e.g. CardShark99').fill('Robin');
  await host.getByRole('button', { name: 'Continue as Guest' }).click();
  await host.getByRole('button', { name: 'Create Room', exact: true }).click();
  await expect(host.getByTestId('lobby-player-count')).toHaveText('1/6 seated');
}

test('hosts and guests move teams using their player cards', async ({ page: host, browser }) => {
  await _createRoom(host);
  const start = host.getByTestId('start-game-btn');
  await expect(start).toHaveText('Start with 5 bots');
  for (const button of [start, host.getByRole('button', { name: /Invite friends/i }),
    host.getByRole('button', { name: /Start a short tutorial/i })]) {
    await expect(button).toHaveCSS('cursor', 'pointer');
  }
  await expect(host.getByRole('button', { name: /switch to team/i })).toHaveCount(0);
  const guest = await browser.newPage();
  try {
    await guest.goto(host.url());
    await guest.getByTestId('join-name-input').fill('Finch');
    await guest.getByTestId('join-room-btn').click();
    await expect(_team(host, 2).getByText('Finch', { exact: true })).toBeVisible();

    await _drag(host, /^Robin, host, you$/, 2);
    await expect(_team(guest, 2).getByText('Robin', { exact: true })).toBeVisible();
    await expect(guest.getByRole('button', { name: /^Robin, host/ })).toHaveCount(0);

    const ownCard = _team(guest, 2).getByRole('button', { name: 'Finch, you' });
    await guest.bringToFront();
    await ownCard.press('Enter');
    await expect(_team(host, 1).getByText('Finch', { exact: true })).toBeVisible();

    await _drag(host, /^Finch$/, 2);
    await expect(_team(guest, 2).getByRole('button', { name: 'Finch, you' })).toBeVisible();
  } finally {
    await guest.close();
  }
});

test('only the host can swap two chosen players in a full lobby', async ({ page: host, browser }) => {
  await _createRoom(host);
  const guests: Page[] = [];
  try {
    for (const name of ['Finch', 'Owl', 'Fox', 'Jay', 'Lark']) {
      const guest = await browser.newPage();
      guests.push(guest);
      await guest.goto(host.url());
      await guest.getByTestId('join-name-input').fill(name);
      await guest.getByTestId('join-room-btn').click();
      await expect(host.getByTestId('lobby-player-count')).toHaveText(`${guests.length + 1}/6 seated`, { ignoreCase: true });
    }
    const firstTeam = _team(host, 1).getByRole('button');
    const secondTeam = _team(host, 2).getByRole('button');
    await expect(firstTeam).toHaveCount(3);
    await expect(secondTeam).toHaveCount(3);
    const firstRoster = await firstTeam.allTextContents();
    const secondRoster = await secondTeam.allTextContents();
    await _drag(host, /^Robin, host, you$/, 2);
    await expect(firstTeam).toHaveText(firstRoster);
    await expect(secondTeam).toHaveText(secondRoster);
    await _drag(host, /^Robin, host, you$/, 2, 'Finch');
    for (const page of [host, ...guests]) {
      await expect(_team(page, 1).getByText('Finch', { exact: true })).toBeVisible();
      await expect(_team(page, 2).getByText('Robin', { exact: true })).toBeVisible();
      await expect(page.getByLabel('3 of 3 seats filled')).toHaveCount(2);
    }
    await expect(_team(guests[0], 1).getByRole('button')).toHaveCount(0);
  } finally {
    await Promise.all(guests.map(guest => guest.close()));
  }
});
