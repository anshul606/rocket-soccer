import { randomUUID } from "crypto";
import type { Server, Socket } from "socket.io";
import {
  MAX_PLAYERS,
  SNAPSHOT_HZ,
  type ClientToServerEvents,
  type LobbyPlayer,
  type PlayerInput,
  type ServerToClientEvents,
  type TeamId,
} from "@rocket-soccer/shared";
import { ensureRapier, GameWorld } from "./sim/gameWorld.js";

const SNAPSHOT_MS = 1000 / SNAPSHOT_HZ;
const ZERO_INPUT: PlayerInput = {
  throttle: 0,
  steer: 0,
  brake: false,
  jumpPressed: false,
  boost: false,
  drift: false,
};

interface Slot {
  playerId: string;
  socketId: string | null;
  name: string;
  team: TeamId;
  ready: boolean;
  isHost: boolean;
}

/**
 * One private room: lobby state, Socket.IO fan-out, and an authoritative Rapier sim while in-match.
 */
export class Room {
  private slots = new Map<string, Slot>();
  private socketToPlayer = new Map<string, string>();
  private game: GameWorld | null = null;
  private loop: ReturnType<typeof setInterval> | null = null;
  private snapshotAcc = 0;
  private lastTick = Date.now();

  constructor(
    private io: Server<ClientToServerEvents, ServerToClientEvents>,
    readonly code: string,
  ) {}

  get playerCount() {
    return this.slots.size;
  }

  isEmpty() {
    return this.slots.size === 0;
  }

  hasSocket(socketId: string) {
    return this.socketToPlayer.has(socketId);
  }

  addPlayer(socket: Socket<ClientToServerEvents, ServerToClientEvents>, name: string, isHost: boolean) {
    if (this.slots.size >= MAX_PLAYERS) return;
    const playerId = randomUUID();
    const team: TeamId = this.slots.size === 0 ? "blue" : "orange";
    this.slots.set(playerId, {
      playerId,
      socketId: socket.id,
      name,
      team,
      ready: false,
      isHost,
    });
    this.socketToPlayer.set(socket.id, playerId);
    socket.join(this.code);
    socket.emit("assignedPlayer", { playerId, roomCode: this.code });
    this.broadcastLobby();
  }

  reconnectPlayer(socket: Socket<ClientToServerEvents, ServerToClientEvents>, playerId: string): boolean {
    const slot = this.slots.get(playerId);
    if (!slot) return false;
    if (slot.socketId && slot.socketId !== socket.id) {
      const old = this.io.sockets.sockets.get(slot.socketId);
      old?.disconnect(true);
    }
    slot.socketId = socket.id;
    this.socketToPlayer.set(socket.id, playerId);
    socket.join(this.code);
    socket.emit("assignedPlayer", { playerId, roomCode: this.code });
    this.broadcastLobby();
    return true;
  }

  setTeam(socketId: string, team: TeamId) {
    if (this.game) return;
    const pid = this.socketToPlayer.get(socketId);
    if (!pid) return;
    const slot = this.slots.get(pid);
    if (!slot) return;
    slot.team = team;
    this.broadcastLobby();
  }

  setReady(socketId: string, ready: boolean) {
    const pid = this.socketToPlayer.get(socketId);
    if (!pid) return;
    const slot = this.slots.get(pid);
    if (!slot) return;
    slot.ready = ready;
    this.broadcastLobby();
  }

  requestStart(socketId: string) {
    const pid = this.socketToPlayer.get(socketId);
    if (!pid) return;
    const slot = this.slots.get(pid);
    if (!slot?.isHost) return;
    if (this.game) return;
    // Allow starting with 1 player for solo testing (set to MAX_PLAYERS for production)
    if (this.slots.size < 1) return;
    if (![...this.slots.values()].every((s) => s.ready)) return;
    void this.startMatch();
  }

  private async startMatch() {
    await ensureRapier();
    this.game = new GameWorld();
    for (const s of this.slots.values()) {
      this.game.addCar(s.playerId, s.team);
    }
    this.lastTick = Date.now();
    this.snapshotAcc = 0;
    this.loop = setInterval(() => this.tick(), 1000 / 60);
  }

  private tick() {
    if (!this.game) return;
    const now = Date.now();
    const dt = Math.min(0.05, (now - this.lastTick) / 1000 || 1 / 60);
    this.lastTick = now;
    const snap = this.game.step(dt);
    this.snapshotAcc += dt * 1000;
    const shouldSnap = this.snapshotAcc >= SNAPSHOT_MS || snap.phase === "ended" || snap.phase === "goal_pause";
    if (shouldSnap) {
      this.snapshotAcc = 0;
      this.io.to(this.code).emit("snapshot", snap);
    }
    if (snap.phase === "ended") {
      this.stopMatch();
    }
  }

  private stopMatch() {
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.game = null;
    for (const s of this.slots.values()) {
      s.ready = false;
    }
    this.broadcastLobby();
  }

  setInput(socketId: string, input: PlayerInput) {
    if (!this.game) return;
    const pid = this.socketToPlayer.get(socketId);
    if (!pid) return;
    this.game.setInput(pid, input);
  }

  onDisconnect(socketId: string) {
    const pid = this.socketToPlayer.get(socketId);
    if (!pid) return;
    this.socketToPlayer.delete(socketId);
    const slot = this.slots.get(pid);
    if (!slot) return;
    if (!this.game) {
      this.slots.delete(pid);
    } else {
      slot.socketId = null;
      this.game.setInput(pid, { ...ZERO_INPUT });
    }
    this.broadcastLobby();
    this.abandonIfNobodyOnline();
  }

  /** If every slot is offline, tear down the room so the manager can prune it. */
  private abandonIfNobodyOnline() {
    if (this.slots.size === 0) return;
    if ([...this.slots.values()].some((s) => s.socketId !== null)) return;
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
    this.game = null;
    this.slots.clear();
  }

  resetCar(socketId: string) {
    if (!this.game) return;
    const pid = this.socketToPlayer.get(socketId);
    if (!pid) return;
    this.game.resetCar(pid);
  }

  private broadcastLobby() {
    const players: LobbyPlayer[] = [...this.slots.values()].map((s) => ({
      id: s.playerId,
      name: s.name,
      team: s.team,
      ready: s.ready,
      isHost: s.isHost,
      online: s.socketId !== null,
    }));
    for (const socketId of this.socketToPlayer.keys()) {
      const pid = this.socketToPlayer.get(socketId);
      const sock = this.io.sockets.sockets.get(socketId);
      if (!pid || !sock) continue;
      sock.emit("lobbyUpdate", {
        roomCode: this.code,
        players,
        you: pid,
        matchLive: this.game !== null,
      });
    }
  }
}
