export interface PublicRoomSlot {
  slot: number;
  code: string;
}

export const PUBLIC_ROOM_SLOTS: PublicRoomSlot[] = [
  { slot: 1, code: "PXB875" },
  { slot: 2, code: "KMR642" },
  { slot: 3, code: "VTA329" },
  { slot: 4, code: "HLD584" },
  { slot: 5, code: "NQF267" },
  { slot: 6, code: "ZCP943" },
  { slot: 7, code: "WGS728" },
  { slot: 8, code: "RYB356" },
  { slot: 9, code: "FLC489" },
  { slot: 10, code: "BDX713" },
  { slot: 11, code: "JRP526" },
  { slot: 12, code: "TKN934" },
];

export function publicRoomSlotForCode(roomCode: string): PublicRoomSlot | undefined {
  const normalizedCode = roomCode.toUpperCase();
  return PUBLIC_ROOM_SLOTS.find((slot) => slot.code === normalizedCode);
}

export function publicRoomSlotLabel(slot: number): string {
  return slot > 0 ? `Server ${slot}` : "Public Server";
}

export function firstAvailablePublicRoomSlot(
  rooms: Iterable<{ roomCode: string; publicSlot?: number | null }>,
): PublicRoomSlot | undefined {
  const occupiedSlots = new Set<number>();

  for (const room of rooms) {
    const slot = Number.isInteger(room.publicSlot)
      ? room.publicSlot ?? 0
      : publicRoomSlotForCode(room.roomCode)?.slot ?? 0;
    if (slot > 0) {
      occupiedSlots.add(slot);
    }
  }

  return PUBLIC_ROOM_SLOTS.find((slot) => !occupiedSlots.has(slot.slot));
}
