export class SoakFailure extends Error {
  name = 'SoakFailure';
}

export function failure(
  detail: string,
  where: { seat?: { index: number; name: string }; kill?: { id: number; kind: string }; move?: number } = {},
): SoakFailure {
  const seat = where.seat ? `seat ${where.seat.index} (${where.seat.name}) ` : '';
  const kill = where.kill ? ` after ${where.kill.kind} #${where.kill.id}` : '';
  const move = where.move === undefined ? '' : ` (move ${where.move})`;
  return new SoakFailure(`${seat}${detail}${kill}${move}`);
}
