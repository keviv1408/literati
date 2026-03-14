"use client";

/**
 * BotBadge — displays a robot icon + Docker-style auto-generated name
 * for bot players in the Literati card game.
 *
 * Styled with Tailwind CSS to match the rest of the frontend.
 *
 * @example
 * // Full badge (icon + name) — use in lobby / scoreboard
 * <BotBadge displayName="Quirky Turing" />
 *
 * @example
 * // Icon-only — use on card table where space is tight
 * <BotBadge displayName="Quirky Turing" showName={false} size="sm" />
 *
 * @example
 * // Inline name tag — wraps any player name, shows bot indicator only when isBot
 * <BotNameTag name={player.displayName} isBot={player.isBot} />
 */

import React from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BadgeSize = "xs" | "sm" | "md" | "lg";

export interface BotBadgeProps {
  /** The human-readable display name, e.g. "Quirky Turing" */
  displayName: string;
  /**
   * Visual size variant.
   * @default "md"
   */
  size?: BadgeSize;
  /**
   * Whether to show the name text alongside the icon.
   * @default true
   */
  showName?: boolean;
  /** Extra Tailwind classes forwarded to the outer element */
  className?: string;
  /** Tooltip text. Defaults to "{displayName} (Bot)" */
  title?: string;
}

// ---------------------------------------------------------------------------
// Size configuration
// ---------------------------------------------------------------------------

const SIZE_CONFIG: Record<
  BadgeSize,
  { iconSize: number; text: string; gap: string; iconPad: string }
> = {
  xs: {
    iconSize: 10,
    text: "text-[0.6rem] leading-none",
    gap: "gap-0.5",
    iconPad: "p-px",
  },
  sm: {
    iconSize: 12,
    text: "text-xs leading-none",
    gap: "gap-1",
    iconPad: "p-px",
  },
  md: {
    iconSize: 14,
    text: "text-sm",
    gap: "gap-1",
    iconPad: "p-0.5",
  },
  lg: {
    iconSize: 18,
    text: "text-base",
    gap: "gap-1.5",
    iconPad: "p-0.5",
  },
};

// ---------------------------------------------------------------------------
// Robot SVG icon
// ---------------------------------------------------------------------------

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
    focusable="false"
    className={className}
  >
    {/* Head */}
    <rect x="5" y="7" width="14" height="10" rx="2" ry="2" />
    {/* Left eye */}
    <circle cx="9" cy="11" r="1.5" fill="white" />
    {/* Right eye */}
    <circle cx="15" cy="11" r="1.5" fill="white" />
    {/* Mouth */}
    <rect x="9" y="14" width="6" height="1.5" rx="0.75" fill="white" />
    {/* Antenna stem */}
    <line
      x1="12"
      y1="7"
      x2="12"
      y2="4"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    {/* Antenna tip */}
    <circle cx="12" cy="3.5" r="1" />
    {/* Left ear */}
    <rect x="3" y="9" width="2" height="4" rx="1" />
    {/* Right ear */}
    <rect x="19" y="9" width="2" height="4" rx="1" />
  </svg>
);

// ---------------------------------------------------------------------------
// BotBadge component
// ---------------------------------------------------------------------------

/**
 * BotBadge renders a robot icon alongside the bot's auto-generated name.
 * Uses an indigo/violet colour scheme so bots are visually distinct from humans.
 */
export const BotBadge: React.FC<BotBadgeProps> = ({
  displayName,
  size = "md",
  showName = true,
  className = "",
  title,
}) => {
  const cfg = SIZE_CONFIG[size];
  const tooltip = title ?? `${displayName} (Bot)`;

  return (
    <span
      className={[
        "inline-flex items-center font-medium",
        "text-indigo-300",
        cfg.gap,
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      title={tooltip}
      aria-label={tooltip}
    >
      {/* Icon pill */}
      <span
        className={[
          "inline-flex items-center justify-center rounded flex-shrink-0",
          "bg-indigo-500/20",
          cfg.iconPad,
        ].join(" ")}
      >
        <RobotIcon size={cfg.iconSize} />
      </span>

      {/* Name */}
      {showName && (
        <span className={["truncate max-w-[10rem]", cfg.text].join(" ")}>
          {displayName}
        </span>
      )}
    </span>
  );
};

// ---------------------------------------------------------------------------
// BotNameTag — convenience wrapper for mixed human/bot name display
// ---------------------------------------------------------------------------

export interface BotNameTagProps {
  /** Player's display name */
  name: string;
  /** Whether this player is a bot */
  isBot: boolean;
  size?: BadgeSize;
  className?: string;
}

/**
 * BotNameTag shows a plain name for humans and a BotBadge for bots.
 * Drop-in replacement wherever a player name is rendered.
 */
export const BotNameTag: React.FC<BotNameTagProps> = ({
  name,
  isBot,
  size = "sm",
  className = "",
}) => {
  if (!isBot) {
    return <span className={className}>{name}</span>;
  }
  return <BotBadge displayName={name} size={size} className={className} />;
};

export default BotBadge;
