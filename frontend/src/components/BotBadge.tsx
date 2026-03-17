"use client";

import React from "react";

export type BadgeSize = "xs" | "sm" | "md" | "lg";

export interface BotBadgeProps {
  displayName: string;
  size?: BadgeSize;
  showName?: boolean;
  className?: string;
  title?: string;
}

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
    <rect x="5" y="7" width="14" height="10" rx="2" ry="2" />
    <circle cx="9" cy="11" r="1.5" fill="white" />
    <circle cx="15" cy="11" r="1.5" fill="white" />
    <rect x="9" y="14" width="6" height="1.5" rx="0.75" fill="white" />
    <line
      x1="12"
      y1="7"
      x2="12"
      y2="4"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    />
    <circle cx="12" cy="3.5" r="1" />
    <rect x="3" y="9" width="2" height="4" rx="1" />
    <rect x="19" y="9" width="2" height="4" rx="1" />
  </svg>
);

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
      <span
        className={[
          "inline-flex items-center justify-center rounded flex-shrink-0",
          "bg-indigo-500/20",
          cfg.iconPad,
        ].join(" ")}
      >
        <RobotIcon size={cfg.iconSize} />
      </span>

      {showName && (
        <span className={["truncate max-w-[10rem]", cfg.text].join(" ")}>
          {displayName}
        </span>
      )}
    </span>
  );
};

export interface BotNameTagProps {
  name: string;
  isBot: boolean;
  size?: BadgeSize;
  className?: string;
}

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
