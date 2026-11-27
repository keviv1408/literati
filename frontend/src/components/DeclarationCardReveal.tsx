import PlayingCard from '@/components/PlayingCard';
import {
  buildDeclarationSeatRevealMap,
  buildSuccessfulDeclarationSeatRevealMap,
} from '@/lib/declarationSeatReveal';
import type { DeclarationReveal, GamePlayer } from '@/types/game';
import type { CardRemovalVariant } from '@/types/room';

interface DeclarationCardRevealProps {
  reveal: DeclarationReveal | null;
  players: GamePlayer[];
  variant: CardRemovalVariant;
}

export default function DeclarationCardReveal({ reveal, players, variant }: DeclarationCardRevealProps) {
  if (!reveal) return null;
  const cardsByHolder = 'actualHolders' in reveal
    ? buildDeclarationSeatRevealMap(reveal, players, variant)
    : buildSuccessfulDeclarationSeatRevealMap(reveal, variant);
  if (!cardsByHolder.size) return null;

  return (
    <section className="declaration-reveal" aria-label="Declared cards by actual holder">
      <div className="reveal-holders">
        {Array.from(cardsByHolder, ([holderId, cards]) => {
          const name = players.find(player => player.playerId === holderId)?.displayName ?? holderId;
          return cards.map(({ cardId, isWrong, claimedByName }) => (
            <figure className="reveal-card" key={cardId}>
              <PlayingCard cardId={cardId} size="sm" />
              <figcaption>
                <span className="reveal-holder">
                  <span aria-hidden="true">✓ </span>
                  <span className="sr-only">Held by </span>{name}
                </span>
                {isWrong && (
                  <span className="reveal-guess">
                    <span className="sr-only">Guessed for </span>
                    <s>{claimedByName ?? 'Unknown'}</s>
                  </span>
                )}
              </figcaption>
            </figure>
          ));
        })}
      </div>
    </section>
  );
}
