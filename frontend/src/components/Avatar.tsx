"use client";

import React from "react";
import Image from "next/image";
import { getAvatarColor, getAvatarCreature } from "@/utils/avatar";

type AvatarSize = "xs" | "sm" | "md" | "lg" | "xl";

const SIZE_STYLES: Record<AvatarSize, string> = {
  xs: "w-6 h-6",
  sm: "w-8 h-8",
  md: "w-10 h-10",
  lg: "w-14 h-14",
  xl: "w-20 h-20",
};

export interface AvatarProps {
  /** The player's display name — drives the background colour and the fallback portrait. */
  displayName: string;
  /** One of the backend's `avatar-1..12` ids. Falls back to a name-derived portrait. */
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
  const creature = getAvatarCreature(avatarId, displayName);

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
      data-creature={creature}
      aria-label={label}
      title={showTooltip ? displayName : undefined}
      style={{
        backgroundColor: color.bg,
        // Subtle inset ring for depth on dark backgrounds
        boxShadow: "inset 0 0 0 1.5px rgba(255,255,255,0.15)",
      }}
    >
      <Image unoptimized width={192} height={192} src={`/creatures/${creature}.webp`}
        alt="" className="h-full w-full" draggable={false} />
    </div>
  );
};

export default Avatar;
