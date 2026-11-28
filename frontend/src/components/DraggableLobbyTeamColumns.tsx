"use client";

import React, { useState } from "react";
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type CollisionDetection,
  pointerWithin,
  PointerSensor,
  useSensor,
  useSensors,
  useDroppable,
  useDraggable,
} from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";

import Avatar from "@/components/Avatar";
import { BotBadge } from "@/components/BotBadge";
import { getTeamForSeat, splitSeatsByTeam } from "@/types/lobby";
import type { LobbyPlayer } from "@/types/lobby";
import type { Team } from "@/types/room";
import { TEAM_STYLES } from "@/lib/teamTheme";

const _dropTargets: CollisionDetection = args => {
  const hits = pointerWithin(args);
  const opponent = hits.find(hit => String(hit.id).startsWith("swap-"));
  return opponent ? [opponent] : hits;
};

export interface DraggableLobbyTeamColumnsProps {
  playerCount: 6 | 8;
  seats: Array<LobbyPlayer | null>;
  isHost: boolean;
  readOnly?: boolean;
  onReassign?: (playerId: string, toTeam: Team, swapWithId?: string) => void;
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
  swapTarget?: boolean;
  picked?: boolean;
  onActivate?: () => void;
  /** Used in DragOverlay (no dragging, just visual). */
  isOverlay?: boolean;
}

const DraggablePlayerCard: React.FC<DraggablePlayerCardProps> = ({
  seatIndex,
  player,
  isDragEnabled,
  team,
  isOverlay = false,
  swapTarget = false,
  picked = false,
  onActivate,
}) => {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({
      id: isOverlay ? "drag-preview" : player?.playerId ?? `seat-${seatIndex}`,
      data: { team },
      disabled: !player || !isDragEnabled || isOverlay,
    });

  const drop = useDroppable({
    id: `swap-${isOverlay ? "preview" : seatIndex}`,
    data: { team, swapWithId: player?.playerId },
    disabled: !swapTarget,
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
      ? "touch-none cursor-grab active:cursor-grabbing focus-visible:outline-2 focus-visible:outline-sage"
      : "cursor-default",
    isDragging ? "opacity-40" : "",
    drop.isOver || picked ? "ring-2 ring-sage" : "",
    isOverlay ? "shadow-2xl rotate-2 opacity-95 scale-105" : "",
    // Occupied vs empty — current user gets team-coloured highlight
    isOccupied
      ? player?.isCurrentUser
        ? `border ${teamStyle.playerBorder} ${teamStyle.playerBg}`
        : "border border-sage/30 bg-felt-inset"
      : "border border-dashed border-sage/25 bg-felt-inset/60 animate-seat-shimmer",
    "select-none transition-opacity duration-150",
  ]
    .filter(Boolean)
    .join(" ");

  const ariaLabel = isOccupied
    ? `${player.displayName}${player.isHost ? ", host" : ""}${player.isCurrentUser ? ", you" : ""}${player.isBot ? " (bot)" : ""}`
    : `Seat ${seatIndex + 1} — waiting for player`;

  return (
    <div
      ref={node => { setNodeRef(node); drop.setNodeRef(node); }}
      style={style}
      aria-label={ariaLabel}
      className={cardClasses}
      {...(isDragEnabled && isOccupied && !isOverlay
        ? { ...listeners, ...attributes }
        : {})}
      onKeyDown={event => {
        if (onActivate && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          if (!event.repeat) onActivate();
        }
      }}
      onClick={event => { if (event.detail === 0) onActivate?.(); }}
      aria-describedby={isDragEnabled ? "team-move-help" : undefined}
      aria-pressed={isDragEnabled && picked ? true : undefined}
      role={isDragEnabled && isOccupied && !isOverlay ? "button" : "listitem"}
    >
      {isOccupied ? (
        <>
          {/* Avatar with optional host crown */}
          <div className="relative">
            <Avatar
              variant="platform"
              displayName={player.displayName}
              avatarId={player.avatarId}
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
                player.isCurrentUser ? teamStyle.playerText : "text-paper",
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

          {isDragEnabled && (
            <span
              className="text-[0.55rem] text-paper-muted mt-0.5"
              aria-hidden="true"
            >
              ⠿ drag to reassign
            </span>
          )}
        </>
      ) : (
        <>
          <span
            className="text-xl text-paper-muted animate-seat-breathe"
            aria-hidden="true"
            style={{ animationDelay: `${seatIndex * 300}ms` }}
          >
            ⌛
          </span>
          <span className="text-xs text-paper-muted font-medium">Waiting…</span>
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
  isHost: boolean;
  readOnly: boolean;
  full: boolean;
  keyboardSource: string | null;
  onActivate: (player: LobbyPlayer) => void;
}

const DroppableTeamColumn: React.FC<DroppableTeamColumnProps> = ({
  team,
  entries,
  seatsPerTeam,
  isHost,
  readOnly,
  full,
  keyboardSource,
  onActivate,
}) => {
  const { setNodeRef, isOver, active } = useDroppable({
    id: `team-${team}`,
    data: { team },
  });

  const style = TEAM_STYLES[team];
  const occupied = entries.filter((e) => e.player !== null).length;

  const isTarget = isOver && active?.data.current?.team !== team;

  return (
    <section
      ref={setNodeRef}
      aria-label={style.aria}
      className={[
        "flex flex-col gap-3 flex-1 min-w-0",
        "rounded-xl p-2 transition-colors duration-150",
        isTarget
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
          <li key={player?.playerId ?? seatIndex} className={player ? "list-none animate-player-join" : "list-none"}>
            <DraggablePlayerCard
              seatIndex={seatIndex}
              player={player}
              isDragEnabled={!readOnly && !!player && (isHost || (!full && player.isCurrentUser))}
              swapTarget={full && isHost && !readOnly && !!player && !!active && active.data.current?.team !== team}
              picked={!!player && keyboardSource === player.playerId}
              onActivate={!readOnly && player && (isHost || (!full && player.isCurrentUser)) ? () => onActivate(player) : undefined}
              team={team}
            />
          </li>
        ))}
      </ol>

      {/* Drop cue when dragging over */}
      {isTarget && (
        <div
          className={[
            "text-xs text-center py-1.5 rounded-lg border border-dashed",
            style.headerBorder,
            style.headerText,
            "opacity-70",
          ].join(" ")}
          aria-hidden="true"
        >
          {occupied === seatsPerTeam ? `${style.label} is full` : `Drop here to join ${style.label}`}
        </div>
      )}
    </section>
  );
};

// ── Main component ────────────────────────────────────────────────────────────

const DraggableLobbyTeamColumns: React.FC<DraggableLobbyTeamColumnsProps> = ({
  playerCount,
  seats,
  isHost,
  readOnly = false,
  onReassign,
  className = "",
}) => {
  const [keyboardSource, setKeyboardSource] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
  );
  const normalizedSeats = Array.from({ length: playerCount }, (_, i) => seats[i] ?? null);
  const { team1, team2 } = splitSeatsByTeam(normalizedSeats);
  const activeSeatPlayer = seats.find(player => player?.playerId === activeId);
  const seatsPerTeam = playerCount / 2;

  const full = normalizedSeats.every(Boolean);
  const picked = seats.find(seat => keyboardSource && seat?.playerId === keyboardSource);
  function _move(player: LobbyPlayer | null | undefined, team: Team, swapWithId?: string) {
    if (readOnly || !player?.playerId || (!isHost && !player.isCurrentUser)) return;
    if ((team !== 1 && team !== 2) || team === getTeamForSeat(player.seatIndex)) return;
    const destination = team === 1 ? team1 : team2;
    if (full && isHost && swapWithId && destination.some(seat => seat.player?.playerId === swapWithId)) {
      onReassign?.(player.playerId, team, swapWithId);
    } else if (!swapWithId && destination.some(seat => !seat.player)) {
      onReassign?.(player.playerId, team);
    }
  }

  function _drop({ active, over }: DragEndEvent) {
    setActiveId(null);
    const target = over?.data.current;
    if (target) _move(seats.find(seat => seat?.playerId === active.id), target.team, target.swapWithId);
  }

  function _activate(player: LobbyPlayer) {
    const team = getTeamForSeat(player.seatIndex);
    if (!full) {
      _move(player, team === 1 ? 2 : 1);
    } else if (picked && getTeamForSeat(picked.seatIndex) !== team) {
      _move(picked, team, player.playerId);
      setKeyboardSource(null);
    } else {
      setKeyboardSource(picked === player ? null : player.playerId ?? null);
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={_dropTargets}
      onDragStart={({ active }) => { setKeyboardSource(null); setActiveId(String(active.id)); }}
      onDragCancel={() => setActiveId(null)}
      onDragEnd={_drop}
    >
      <div
        className={["flex flex-row gap-3", className].filter(Boolean).join(" ")}
        aria-label="Lobby teams"
        onKeyDown={event => { if (event.key === "Escape") setKeyboardSource(null); }}
      >
        <DroppableTeamColumn
          team={1}
          entries={team1}
          seatsPerTeam={seatsPerTeam}
          isHost={isHost}
          readOnly={readOnly}
          full={full}
          keyboardSource={full && isHost ? keyboardSource : null}
          onActivate={_activate}
        />
        <DroppableTeamColumn
          team={2}
          entries={team2}
          seatsPerTeam={seatsPerTeam}
          isHost={isHost}
          readOnly={readOnly}
          full={full}
          keyboardSource={full && isHost ? keyboardSource : null}
          onActivate={_activate}
        />
      </div>

      {/* Drag overlay — floating copy rendered above everything while dragging */}
      <DragOverlay dropAnimation={null}>
        {activeSeatPlayer ? (
          <DraggablePlayerCard
            seatIndex={activeSeatPlayer.seatIndex}
            player={activeSeatPlayer}
            isDragEnabled={false}
            isOverlay
          />
        ) : null}
      </DragOverlay>

      {!readOnly && (isHost || seats.some(player => player?.isCurrentUser)) && (
        <p id="team-move-help" aria-live="polite" className="mt-2 text-center text-[0.65rem] text-paper-muted">
          {full ? isHost
            ? picked ? `Choose an opponent for ${picked.displayName}, or press Escape to cancel.`
              : "Drag one player onto an opponent to swap teams."
            : "Both teams are full. The host can swap players."
            : isHost ? "Drag player cards between columns to change teams." : "Drag your card to the other team to switch."}
          <span className="sr-only">{full && isHost ? " Use Tab and Enter to choose each player." : " Press Enter on a movable player to change teams."}</span>
        </p>
      )}
    </DndContext>
  );
};

export default DraggableLobbyTeamColumns;
