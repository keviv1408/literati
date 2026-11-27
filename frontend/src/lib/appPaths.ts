export function isAndroidBuild(): boolean {
  return process.env.NEXT_PUBLIC_BUILD_TARGET === 'android';
}

export function roomPath(code: string): string {
  return isAndroidBuild() ? `/?room=${code}` : `/room/${code}`;
}

export function gamePath(code: string): string {
  return isAndroidBuild() ? `/?game=${code}` : `/game/${code}`;
}

export function tutorialPath(): string {
  return isAndroidBuild() ? '/tutorial.html' : '/tutorial';
}
