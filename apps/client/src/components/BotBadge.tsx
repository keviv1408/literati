/**
 * BotBadge component — displays a bot icon/badge for bot players.
 *
 * Shows a robot icon alongside the bot's Docker-style auto-generated name.
 * Used anywhere a player name is rendered (game table, lobby, scoreboard, etc.)
 */

import React from "react";
import styles from "./BotBadge.module.css";

export interface BotBadgeProps {
  /** The formatted display name (e.g. "Quirky Turing") */
  displayName: string;
  /**
   * Size variant — controls icon and text scale.
   * @default "md"
   */
  size?: "xs" | "sm" | "md" | "lg";
  /**
   * Show the full name alongside the icon, or icon-only.
   * @default true
   */
  showName?: boolean;
  /** Additional CSS class names */
  className?: string;
  /** Optional tooltip override; defaults to "{displayName} (Bot)" */
  title?: string;
}

/**
 * SVG robot icon — inline so it renders without extra network requests.
 * Intentionally simple & friendly-looking (not threatening robot).
 */
const RobotIcon: React.FC<{ size: number; className?: string }> = ({
  size,
  className,
}) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    className={className}
  >
    {/* Head */}
    <rect x="5" y="7" width="14" height="10" rx="2" ry="2" />
    {/* Eyes */}
    <circle cx="9" cy="11" r="1.5" fill="var(--bot-eye-color, #fff)" />
    <circle cx="15" cy="11" r="1.5" fill="var(--bot-eye-color, #fff)" />
    {/* Mouth / antenna */}
    <rect x="9" y="14" width="6" height="1.5" rx="0.75" fill="var(--bot-eye-color, #fff)" />
    {/* Antenna */}
    <line x1="12" y1="7" x2="12" y2="4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    <circle cx="12" cy="3.5" r="1" />
    {/* Ears / sides */}
    <rect x="3" y="9" width="2" height="4" rx="1" />
    <rect x="19" y="9" width="2" height="4" rx="1" />
  </svg>
);

const SIZE_MAP: Record<NonNullable<BotBadgeProps["size"]>, number> = {
  xs: 12,
  sm: 14,
  md: 16,
  lg: 20,
};

/**
 * BotBadge renders a robot icon + the bot's display name.
 *
 * @example
 * // Full badge (icon + name)
 * <BotBadge displayName="Quirky Turing" />
 *
 * @example
 * // Icon-only (useful in tight spaces like the card table)
 * <BotBadge displayName="Quirky Turing" showName={false} size="sm" />
 */
export const BotBadge: React.FC<BotBadgeProps> = ({
  displayName,
  size = "md",
  showName = true,
  className,
  title,
}) => {
  const iconSize = SIZE_MAP[size];
  const tooltip = title ?? `${displayName} (Bot)`;

  return (
    <span
      className={[styles.botBadge, styles[`size_${size}`], className]
        .filter(Boolean)
        .join(" ")}
      title={tooltip}
      aria-label={tooltip}
    >
      <span className={styles.iconWrapper}>
        <RobotIcon size={iconSize} className={styles.robotIcon} />
      </span>
      {showName && (
        <span className={styles.name}>{displayName}</span>
      )}
    </span>
  );
};

/**
 * BotNameTag — a compact inline tag that wraps any player name element
 * and appends a small bot indicator badge if the player is a bot.
 *
 * @example
 * <BotNameTag name="Quirky Turing" isBot={player.isBot} />
 */
export interface BotNameTagProps {
  name: string;
  isBot: boolean;
  size?: BotBadgeProps["size"];
  className?: string;
}

export const BotNameTag: React.FC<BotNameTagProps> = ({
  name,
  isBot,
  size = "sm",
  className,
}) => {
  if (!isBot) {
    return <span className={className}>{name}</span>;
  }
  return (
    <span className={[styles.botNameTag, className].filter(Boolean).join(" ")}>
      <BotBadge displayName={name} size={size} />
    </span>
  );
};

export default BotBadge;
