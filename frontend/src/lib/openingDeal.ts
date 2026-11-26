// A full page load must discard the invitation to play the opening deal.
let pendingRoom: string | null = null;

export function queueOpeningDeal(roomCode: string) {
  pendingRoom = roomCode;
}

export function takeOpeningDeal(roomCode: string) {
  const shouldDeal = pendingRoom === roomCode;
  pendingRoom = null;
  return shouldDeal;
}
