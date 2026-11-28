import { backUrl, cardBackground } from '@/lib/cardDeck';
import type { CardRank, CardSuit } from '@/types/game';
import styles from './Guide.module.css';

export default function GuideCard({ rank, suit = 'd' }: { rank: CardRank; suit?: CardSuit }) {
  return (
    <span className={styles.card} aria-hidden="true">
      <span className={styles.front} style={cardBackground(rank, suit)} />
      <span className={styles.back} style={{ backgroundImage: `url("${backUrl}")` }} />
    </span>
  );
}
