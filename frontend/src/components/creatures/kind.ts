import type { CreatureKind } from './models';

export function creatureForEmoji(emoji: string): CreatureKind | undefined {
  if (emoji === '🐸') return 'frog';
  if (emoji === '🐙') return 'octopus';
  if (emoji === '🦋') return 'butterfly';
}
