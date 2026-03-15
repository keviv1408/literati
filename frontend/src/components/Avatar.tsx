"use client";

import React from "react";
import { getAvatarProps } from "@/utils/avatar";

// ---------------------------------------------------------------------------
// Size map — keeps sizing consistent across the app
// ---------------------------------------------------------------------------

type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const SIZE_STYLES: Record<
  AvatarSize,
  { container: string; text: string; borderRadius: string }
> = {
  xs: {
    container: "w-6 h-6",
    text: "text-[0.55rem] font-bold",
    borderRadius: "rounded-full",
  },
  sm: {
    container: "w-8 h-8",
    text: "text-xs font-bold",
    borderRadius: "rounded-full",
  },
  md: {
    container: "w-10 h-10",
    text: "text-sm font-bold",
    borderRadius: "rounded-full",
  },
  lg: {
    container: "w-14 h-14",
    text: "text-lg font-bold",
    borderRadius: "rounded-full",
  },
  xl: {
    container: "w-20 h-20",
    text: "text-2xl font-bold",
    borderRadius: "rounded-full",
  },
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export interface AvatarProps {
  /** The player's display name — used to derive initials and colour. */
  displayName: string;

  /**
   * Pre-computed image URL (e.g. from OAuth provider).
   * When supplied the image is shown instead of the initials circle.
   */
  imageUrl?: string | null;

  /** Visual size of the avatar.  Defaults to "md". */
  size?: AvatarSize;

  /**
   * Extra CSS class names forwarded to the outer `<div>`.
   * Use this to override margins / positioning at the call-site.
   */
  className?: string;

  /** Accessible label.  Defaults to `"Avatar for {displayName}"`. */
  "aria-label"?: string;

  /** Whether to show a tooltip with the full display name on hover. */
  showTooltip?: boolean;
}

/**
 * `Avatar` — renders an initials-based coloured circle for any player.
 *
 * - Derives 1–2 uppercase initials from `displayName`
 * - Picks a deterministic background colour via a djb2 hash → palette lookup
 * - Falls back to the image URL when provided
 * - Fully accessible (role="img", aria-label)
 *
 * @example
 * <Avatar displayName="Alice Johnson" size="lg" />
 * <Avatar displayName="Bot #3" size="sm" />
 */
const Avatar: React.FC<AvatarProps> = ({
  displayName,
  imageUrl,
  size = "md",
  className = "",
  "aria-label": ariaLabel,
  showTooltip = false,
}) => {
  const { initials, color } = getAvatarProps(displayName);
  const sizeStyle = SIZE_STYLES[size];
  const label = ariaLabel ?? `Avatar for ${displayName}`;

  const sharedClasses = [
    "inline-flex items-center justify-center select-none flex-shrink-0",
    sizeStyle.container,
    sizeStyle.borderRadius,
    "overflow-hidden",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  // ---- image variant ----
  if (imageUrl) {
    return (
      <div
        className={sharedClasses}
        role="img"
        aria-label={label}
        title={showTooltip ? displayName : undefined}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={imageUrl}
          alt={label}
          className="w-full h-full object-cover"
          onError={(e) => {
            // Hide broken image so the initials fallback becomes visible
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      </div>
    );
  }

  // ---- initials variant ----
  return (
    <div
      className={[sharedClasses, sizeStyle.text].join(" ")}
      role="img"
      aria-label={label}
      title={showTooltip ? displayName : undefined}
      style={{
        backgroundColor: color.bg,
        color: color.fg,
        // Subtle inset ring for depth on dark backgrounds
        boxShadow: "inset 0 0 0 1.5px rgba(255,255,255,0.15)",
      }}
    >
      {initials}
    </div>
  );
};

export default Avatar;
