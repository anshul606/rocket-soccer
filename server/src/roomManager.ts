import type { Socket } from "socket.io";
import type { Server } from "socket.io";
import { randomBytes } from "crypto";
import {
  MAX_PLAYERS,
  ROOM_CODE_LENGTH,
  type ClientToServerEvents,
  type PlayerInput,
  type ServerToClientEvents,
} from "@rocket-soccer/shared";
import { Room } from "./room.js";

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function makeRoomCode(): string {
  const bytes = randomBytes(ROOM_CODE_LENGTH);
  let s = "";
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    s += CODE_CHARS[bytes[i]! % CODE_CHARS.length];
  }
  return s;
}

export class RoomManager {
  private rooms = new Map<string, Room>();

  constructor(private io: Server<ClientToServerEvents, ServerToClientEvents>) {}

  onConnection(socket: Socket<ClientToServerEvents, ServerToClientEvents>) {
    socket.on("createRoom", (name, cb) => {
      const trimmed = name.trim().slice(0, 16) || "Player";
      let code = makeRoomCode();
      while (this.rooms.has(code)) code = makeRoomCode();
      const room = new Room(this.io, code);
      this.rooms.set(code, room);
      room.addPlayer(socket, trimmed, true);
      cb({ ok: true, roomCode: code });
    });

    socket.on("joinRoom", ({ code, name }, cb) => {
      const c = code.trim().toUpperCase();
      const room = this.rooms.get(c);
      const trimmed = name.trim().slice(0, 16) || "Player";
      if (!room) {
        cb({ ok: false, error: "Room not found" });
        return;
      }
      if (room.playerCount >= MAX_PLAYERS) {
        cb({ ok: false, error: "Room is full" });
        return;
      }
      room.addPlayer(socket, trimmed, false);
      cb({ ok: true });
    });

    socket.on("reconnect", ({ code, playerId }, cb) => {
      const c = code.trim().toUpperCase();
      const room = this.rooms.get(c);
      if (!room) {
        cb({ ok: false, error: "Room not found" });
        return;
      }
      const ok = room.reconnectPlayer(socket, playerId);
      cb({ ok, error: ok ? undefined : "Session expired" });
    });

    socket.on("setTeam", (team) => {
      const room = this.findRoomBySocket(socket.id);
      room?.setTeam(socket.id, team);
    });

    socket.on("setReady", (ready) => {
      const room = this.findRoomBySocket(socket.id);
      room?.setReady(socket.id, ready);
    });

    socket.on("startMatch", () => {
      const room = this.findRoomBySocket(socket.id);
      room?.requestStart(socket.id);
    });

    socket.on("resetCar", () => {
      const room = this.findRoomBySocket(socket.id);
      room?.resetCar(socket.id);
    });

    socket.on("input", (payload: PlayerInput) => {
      const room = this.findRoomBySocket(socket.id);
      room?.setInput(socket.id, payload);
    });

    socket.on("disconnect", () => {
      const room = this.findRoomBySocket(socket.id);
      room?.onDisconnect(socket.id);
      this.pruneEmptyRooms();
    });
  }

  private findRoomBySocket(socketId: string): Room | undefined {
    for (const r of this.rooms.values()) {
      if (r.hasSocket(socketId)) return r;
    }
    return undefined;
  }

  private pruneEmptyRooms() {
    for (const [code, room] of this.rooms) {
      if (room.isEmpty()) this.rooms.delete(code);
    }
  }
}
