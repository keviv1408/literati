export const CREATURE_NAMES = {
  raccoon: 'Raccoon',
  penguin: 'Penguin',
  frog: 'Frog',
  octopus: 'Octopus',
  toucan: 'Toucan',
  elephant: 'Baby elephant',
  kangaroo: 'Kangaroo and joey',
  crab: 'Fiddler crab',
  spider: 'Jumping spider',
  gecko: 'Gecko',
  beetle: 'Rhino beetle',
  butterfly: 'Butterfly',
} as const;

export type CreatureKind = keyof typeof CREATURE_NAMES;

export function isCreatureKind(value?: string): value is CreatureKind {
  return value !== undefined && Object.hasOwn(CREATURE_NAMES, value);
}
