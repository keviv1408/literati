import { gamePath, isAndroidBuild, roomPath, tutorialPath } from '@/lib/appPaths';

describe.each([
  [undefined, false, '/room/ABC123', '/game/ABC123', '/tutorial'],
  ['android', true, '/?room=ABC123', '/?game=ABC123', '/tutorial.html'],
])('build target %s', (target, android, room, game, tutorial) => {
  beforeEach(() => {
    if (target) process.env.NEXT_PUBLIC_BUILD_TARGET = target;
    else delete process.env.NEXT_PUBLIC_BUILD_TARGET;
  });
  afterAll(() => { delete process.env.NEXT_PUBLIC_BUILD_TARGET; });

  it('builds the paths', () => {
    expect(isAndroidBuild()).toBe(android);
    expect(roomPath('ABC123')).toBe(room);
    expect(gamePath('ABC123')).toBe(game);
    expect(tutorialPath()).toBe(tutorial);
  });
});
