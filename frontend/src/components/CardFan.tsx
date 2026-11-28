import styles from './CardFan.module.css';

export default function CardFan({ compact = false }: { compact?: boolean }) {
  return (
    <span aria-hidden="true" className={compact ? `${styles.fan} ${styles.compact}` : styles.fan}>
      <span />
      <span />
      <span />
    </span>
  );
}
