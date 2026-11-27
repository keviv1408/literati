import { useEffect, useState } from 'react';
import PlayingCard from '@/components/PlayingCard';
import {
  buildDeclarationSeatRevealMap,
  buildSuccessfulDeclarationSeatRevealMap,
  FAILED_DECLARATION_SEAT_REVEAL_MS,
} from '@/lib/declarationSeatReveal';
import type { DeclarationFailedPayload, DeclarationResultPayload, GamePlayer } from '@/types/game';
import type { CardRemovalVariant } from '@/types/room';

interface DeclarationCardRevealProps {
  result?: DeclarationResultPayload | null;
  failure?: DeclarationFailedPayload | null;
  players: GamePlayer[];
  variant: CardRemovalVariant;
}

export default function DeclarationCardReveal({ result, failure, players, variant }: DeclarationCardRevealProps) {
  const reveal = failure ?? (result?.correct ? result : null);
  const [dismissed, setDismissed] = useState<typeof reveal>(null);

  useEffect(() => {
    if (!reveal) return;
    const timer = setTimeout(() => setDismissed(reveal), FAILED_DECLARATION_SEAT_REVEAL_MS);
    return () => clearTimeout(timer);
  }, [reveal]);

  if (!reveal || reveal === dismissed) return null;
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
