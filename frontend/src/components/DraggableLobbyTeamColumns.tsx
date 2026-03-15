"use client";

/**
 * DraggableLobbyTeamColumns — DnD-enabled team column layout for the lobby.
 *
 * Wraps the static lobby team layout with @dnd-kit drag-and-drop support so
 * that the host can reassign players to different teams by dragging their
 * player card between the Team 1 and Team 2 columns.
 *
 * Architecture
 * ────────────
 * • Each occupied (or empty) player card is a `Draggable` item identified as
 *   `"seat-{seatIndex}"`.
 * • Each team column is a `Droppable` zone identified as `"team-1"` or
 *   `"team-2"`.
 * • On a successful drop the component:
 *   1. Updates its local `teamOverrides` state so the card visually moves.
 *   2. Calls `onReassign(seatIndex, toTeam)` so the parent can emit a
 *      `reassign_seat` WebSocket event to the server.
 * • The `teamOverrides` map stores host-driven overrides; the default team
 *   for a seat is `getTeamForSeat(seatIndex)` from `@/types/lobby`.
 *
 * Only the host sees drag handles — other connected clients (and spectators)
 * receive the `isHost={false}` prop which disables dragging.
 *
 * @example
 * <DraggableLobbyTeamColumns
 *   playerCount={6}
 *   seats={lobbySeats}
 *   isHost={true}
 *   onReassign={(seatIndex, toTeam) =>
 *     emit("reassign_seat", { seatIndex, toTeam })
 *   }
 * />
 */

import React, { useState, useCallback, useRef } from "react";
import {
  DndContext,
  DragEndEvent,
  DragOverlay,
  DragStartEvent,
  PointerSensor,
  TouchSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
  closestCenter,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";

import Avatar from "@/components/Avatar";
import { BotBadge } from "@/components/BotBadge";
import { getTeamForSeat } from "@/types/lobby";
import type { LobbyPlayer } from "@/types/lobby";
import type { Team } from "@/types/room";
import { TEAM_STYLES } from "@/lib/teamTheme";

// ── Prop types ────────────────────────────────────────────────────────────────

export interface DraggableLobbyTeamColumnsProps {
  /** Total number of players this room supports (6 or 8). */
  playerCount: 6 | 8;

  /**
   * Ordered array of `playerCount` entries. Index = seat index.
   * `null` means the seat is unoccupied (shows "Waiting…" card).
   */
  seats: Array<LobbyPlayer | null>;

  /**
   * Whether the current user is the room host.
   * Only the host can drag cards; other clients render static columns.
   */
  isHost: boolean;

  /**
   * Called when the host successfully drops a seat card onto the opposite
   * team column.  The parent is responsible for emitting the socket event.
   *
   * @param seatIndex  0-based index of the moved seat.
   * @param toTeam     The team the seat was dropped onto (1 or 2).
   */
  onReassign?: (seatIndex: number, toTeam: Team) => void;

  /** Extra Tailwind classes forwarded to the outer wrapper. */
  className?: string;
}

// ── Draggable player card ──────────────────────────────────────────────────────

interface DraggablePlayerCardProps {
  seatIndex: number;
  player: LobbyPlayer | null;
  isDragEnabled: boolean;
  /**
   * The effective team for this seat (1 or 2).
   * Used to colour-code the current-user card with team-specific tokens.
   * Defaults to the seat's natural team (derived from seatIndex) when omitted.
   */
  team?: Team;
  /** Used in DragOverlay (no dragging, just visual). */
  isOverlay?: boolean;
}

const DraggablePlayerCard: React.FC<DraggablePlayerCardProps> = ({
  seatIndex,
  player,
  isDragEnabled,
  team,
  isOverlay = false,
}) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: `seat-${seatIndex}`,
      data: { seatIndex, player },
      disabled: !isDragEnabled || isOverlay,
    });

  const style =
    transform && !isOverlay
      ? { transform: CSS.Translate.toString(transform) }
      : undefined;

  const isOccupied = player !== null;
  // Resolve effective team for colour tokens: use prop, fall back to natural seat assignment.
  const effectiveTeam: Team = team ?? getTeamForSeat(seatIndex);
  const teamStyle = TEAM_STYLES[effectiveTeam];

  const cardClasses = [
    // Layout
    "flex flex-col items-center justify-center gap-1.5",
    "min-h-[4.5rem] px-3 py-3 rounded-xl",
    // Drag affordance
    isDragEnabled && isOccupied
      ? "cursor-grab active:cursor-grabbing"
      : "cursor-default",
    isDragging ? "opacity-40" : "",
    isOverlay ? "shadow-2xl rotate-2 opacity-95 scale-105" : "",
    // Occupied vs empty — current user gets team-coloured highlight
    isOccupied
      ? player?.isCurrentUser
        ? `border ${teamStyle.playerBorder} ${teamStyle.playerBg}`
        : "border border-slate-700/60 bg-slate-800/40"
      : "border border-dashed border-slate-700 bg-slate-800/30",
    "select-none transition-opacity duration-150",
  ]
    .filter(Boolean)
    .join(" ");

  const ariaLabel = isOccupied
    ? `${player.displayName}${player.isHost ? ", host" : ""}${player.isCurrentUser ? ", you" : ""}${player.isBot ? " (bot)" : ""}`
    : `Seat ${seatIndex + 1} — waiting for player`;

  return (
    <div
      ref={setNodeRef}
      style={style}
      aria-label={ariaLabel}
      className={cardClasses}
      {...(isDragEnabled && isOccupied && !isOverlay
        ? { ...listeners, ...attributes }
        : {})}
      role="listitem"
    >
      {isOccupied ? (
        <>
          {/* Avatar with optional host crown */}
          <div className="relative">
            <Avatar
              displayName={player.displayName}
              imageUrl={player.avatarUrl ?? undefined}
              size="sm"
            />
            {player.isHost && (
              <span
                className="absolute -top-1 -right-1 text-[0.7rem] leading-none"
                aria-hidden="true"
                title="Room host"
              >
                👑
              </span>
            )}
          </div>

          {/* Name or BotBadge */}
          {player.isBot ? (
            <BotBadge
              displayName={player.displayName}
              size="xs"
              showName={true}
              className="max-w-full"
            />
          ) : (
            <span
              className={[
                "text-xs font-medium truncate max-w-[6rem] text-center",
                player.isCurrentUser ? teamStyle.playerText : "text-slate-300",
              ].join(" ")}
              title={player.displayName}
            >
              {player.displayName}
            </span>
          )}

          {/* "You" pill — coloured with team palette */}
          {player.isCurrentUser && (
            <span
              className={[
                "text-[0.6rem] font-semibold uppercase tracking-wider",
                teamStyle.youPillBg,
                teamStyle.youPillText,
                "px-1.5 py-0.5 rounded-full leading-none",
              ].join(" ")}
              aria-hidden="true"
            >
              You
            </span>
          )}

          {/* Drag handle hint for host */}
          {isDragEnabled && (
            <span
              className="text-[0.55rem] text-slate-600 mt-0.5"
              aria-hidden="true"
            >
              ⠿ drag to reassign
            </span>
          )}
        </>
      ) : (
        <>
          <span
            className="text-xl text-slate-600 animate-pulse"
            aria-hidden="true"
          >
            ⌛
          </span>
          <span className="text-xs text-slate-600 font-medium">Waiting…</span>
        </>
      )}
    </div>
  );
};

// ── Droppable team column ──────────────────────────────────────────────────────

interface DroppableTeamColumnProps {
  team: 1 | 2;
  entries: Array<{ seatIndex: number; player: LobbyPlayer | null }>;
  seatsPerTeam: number;
  isDragEnabled: boolean;
}

const DroppableTeamColumn: React.FC<DroppableTeamColumnProps> = ({
  team,
  entries,
  seatsPerTeam,
  isDragEnabled,
}) => {
  const { setNodeRef, isOver } = useDroppable({
    id: `team-${team}`,
    data: { team },
  });

  const style = TEAM_STYLES[team];
  const occupied = entries.filter((e) => e.player !== null).length;

  return (
    <section
      ref={setNodeRef}
      aria-label={style.aria}
      className={[
        "flex flex-col gap-3 flex-1 min-w-0",
        "rounded-xl p-2 transition-colors duration-150",
        isDragEnabled && isOver
          ? `${style.dropActiveBg} ring-2 ring-inset ring-offset-0 ${style.dropActiveBorder}`
          : "ring-0",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {/* Column header */}
      <div
        className={[
          "flex items-center justify-between",
          "px-3 py-2 rounded-xl",
          "border",
          style.headerBorder,
          style.headerBg,
        ].join(" ")}
      >
        <div className="flex items-center gap-2">
          <span
            className={["w-2 h-2 rounded-full flex-shrink-0", style.dot].join(
              " ",
            )}
            aria-hidden="true"
          />
          <h3
            className={[
              "text-sm font-semibold uppercase tracking-widest",
              style.headerText,
            ].join(" ")}
          >
            {style.label}
          </h3>
        </div>
        <span
          className={["text-xs tabular-nums font-mono", style.countText].join(
            " ",
          )}
          aria-label={`${occupied} of ${seatsPerTeam} seats filled`}
        >
          {occupied}/{seatsPerTeam}
        </span>
      </div>

      {/* Player cards */}
      <ol
        className="flex flex-col gap-2 list-none m-0 p-0"
        aria-label={`${style.label} player seats`}
      >
        {entries.map(({ seatIndex, player }) => (
          <li key={seatIndex} className="list-none">
            <DraggablePlayerCard
              seatIndex={seatIndex}
              player={player}
              isDragEnabled={isDragEnabled}
              team={team}
            />
          </li>
        ))}
      </ol>

      {/* Drop cue when dragging over */}
      {isDragEnabled && isOver && (
        <div
          className={[
            "text-xs text-center py-1.5 rounded-lg border border-dashed",
            style.headerBorder,
            style.headerText,
            "opacity-70",
          ].join(" ")}
          aria-hidden="true"
        >
          Drop here to assign to {style.label}
        </div>
      )}
    </section>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

/**
 * DraggableLobbyTeamColumns — DnD-enabled two-column team layout.
 *
 * The host can drag player cards between team columns; every successful drop
 * calls `onReassign(seatIndex, toTeam)` so the parent can emit the
 * `reassign_seat` WebSocket event.
 */
const DraggableLobbyTeamColumns: React.FC<DraggableLobbyTeamColumnsProps> = ({
  playerCount,
  seats,
  isHost,
  onReassign,
  className = "",
}) => {
  // ── Team override state ──────────────────────────────────────────────────
  // Key = seatIndex, value = override team (1 or 2).
  // Default team is derived from seatIndex % 2 (getTeamForSeat).
  const [teamOverrides, setTeamOverrides] = useState<Map<number, Team>>(
    new Map(),
  );

  // The currently dragged seat (for DragOverlay rendering).
  const [activeSeatIndex, setActiveSeatIndex] = useState<number | null>(null);

  // Stable ref so useCallback below always sees the latest seats without
  // rebuilding the drag handler on every render.
  const seatsRef = useRef(seats);
  seatsRef.current = seats;

  // ── Sensors (pointer + touch for mobile) ─────────────────────────────────
  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    }),
    useSensor(TouchSensor, {
      activationConstraint: { delay: 200, tolerance: 8 },
    }),
  );

  // ── Drag handlers ─────────────────────────────────────────────────────────
  const handleDragStart = useCallback((event: DragStartEvent) => {
    const idStr = String(event.active.id);
    const idx = parseInt(idStr.replace("seat-", ""), 10);
    setActiveSeatIndex(isNaN(idx) ? null : idx);
  }, []);

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveSeatIndex(null);

      const { active, over } = event;
      if (!over) return;

      const idStr = String(active.id);
      const seatIndex = parseInt(idStr.replace("seat-", ""), 10);
      if (isNaN(seatIndex)) return;

      const dropId = String(over.id);
      const toTeamNum = parseInt(dropId.replace("team-", ""), 10);
      if (toTeamNum !== 1 && toTeamNum !== 2) return;
      const toTeam = toTeamNum as Team;

      // Skip if dropped on the same team.
      const currentTeam =
        teamOverrides.get(seatIndex) ?? getTeamForSeat(seatIndex);
      if (currentTeam === toTeam) return;

      // Update local override state.
      setTeamOverrides((prev) => {
        const next = new Map(prev);
        next.set(seatIndex, toTeam);
        return next;
      });

      // Notify parent to emit the socket event.
      onReassign?.(seatIndex, toTeam);
    },
    [teamOverrides, onReassign],
  );

  // ── Build team entry arrays ────────────────────────────────────────────────
  const normalizedSeats: Array<LobbyPlayer | null> = Array.from(
    { length: playerCount },
    (_, i) => seats[i] ?? null,
  );

  const team1Entries: Array<{ seatIndex: number; player: LobbyPlayer | null }> =
    [];
  const team2Entries: Array<{ seatIndex: number; player: LobbyPlayer | null }> =
    [];

  normalizedSeats.forEach((player, idx) => {
    const effectiveTeam: Team =
      teamOverrides.get(idx) ?? getTeamForSeat(idx);
    const entry = { seatIndex: idx, player };
    if (effectiveTeam === 1) {
      team1Entries.push(entry);
    } else {
      team2Entries.push(entry);
    }
  });

  const seatsPerTeam = playerCount / 2;
  const activeSeatPlayer =
    activeSeatIndex !== null ? (normalizedSeats[activeSeatIndex] ?? null) : null;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div
        className={["flex flex-row gap-3", className].filter(Boolean).join(" ")}
        aria-label="Lobby teams"
      >
        <DroppableTeamColumn
          team={1}
          entries={team1Entries}
          seatsPerTeam={seatsPerTeam}
          isDragEnabled={isHost}
        />
        <DroppableTeamColumn
          team={2}
          entries={team2Entries}
          seatsPerTeam={seatsPerTeam}
          isDragEnabled={isHost}
        />
      </div>

      {/* Drag overlay — floating copy rendered above everything while dragging */}
      <DragOverlay dropAnimation={null}>
        {activeSeatIndex !== null ? (
          <div className="w-[calc(50%-0.75rem)] max-w-[200px]">
            <DraggablePlayerCard
              seatIndex={activeSeatIndex}
              player={activeSeatPlayer}
              isDragEnabled={false}
              isOverlay
            />
          </div>
        ) : null}
      </DragOverlay>

      {isHost && (
        <p className="mt-2 text-center text-[0.65rem] text-slate-600">
          Drag player cards between columns to reassign teams
        </p>
      )}
    </DndContext>
  );
};

export default DraggableLobbyTeamColumns;
