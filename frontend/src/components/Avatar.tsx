"use client";

import React from "react";
import { getAvatarColor, getAvatarEmoji } from "@/utils/avatar";

type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const SIZE_STYLES: Record<AvatarSize, string> = {
  xs: "w-6 h-6",
  sm: "w-8 h-8",
  md: "w-10 h-10",
  lg: "w-14 h-14",
  xl: "w-20 h-20",
};

export interface AvatarProps {
  /** The player's display name — drives the background colour and the fallback glyph. */
  displayName: string;
  /** One of the backend's `avatar-1..12` ids. Falls back to a name-derived glyph. */
  avatarId?: string | null;
  /** Visual size of the avatar.  Defaults to "md". */
  size?: AvatarSize;
  /** Extra CSS class names forwarded to the outer `<div>`. */
  className?: string;
  /** Accessible label.  Defaults to `"Avatar for {displayName}"`. */
  "aria-label"?: string;
  /** Whether to show a tooltip with the full display name on hover. */
  showTooltip?: boolean;
}

/**
 * `Avatar` — an emoji glyph on a name-coloured circle.
 *
 * @example
 * <Avatar displayName="Alice" avatarId="avatar-3" size="lg" />
 * <Avatar displayName="Mochi" avatarId={null} size="sm" />
 */
const Avatar: React.FC<AvatarProps> = ({
  displayName,
  avatarId,
  size = "md",
  className = "",
  "aria-label": ariaLabel,
  showTooltip = false,
}) => {
  const color = getAvatarColor(displayName);
  const label = ariaLabel ?? `Avatar for ${displayName}`;

  return (
    <div
      className={[
        "inline-flex items-center justify-center select-none flex-shrink-0 rounded-full overflow-hidden",
        SIZE_STYLES[size],
        className,
      ]
        .filter(Boolean)
        .join(" ")}
      role="img"
      aria-label={label}
      title={showTooltip ? displayName : undefined}
      style={{
        backgroundColor: color.bg,
        // Subtle inset ring for depth on dark backgrounds
        boxShadow: "inset 0 0 0 1.5px rgba(255,255,255,0.15)",
      }}
    >
      {/* SVG text scales with the circle, so callers can resize via className */}
      <svg viewBox="0 0 100 100" className="w-full h-full" aria-hidden="true">
        <text x="50" y="54" fontSize="80" textAnchor="middle" dominantBaseline="central">
          {getAvatarEmoji(avatarId, displayName)}
        </text>
      </svg>
    </div>
  );
};

export default Avatar;
