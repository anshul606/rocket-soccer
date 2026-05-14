export type TeamId = "blue" | "orange";

export interface PlayerInput {
  /** Forward throttle [-1, 1] */
  throttle: number;
  /** Steering [-1, 1] */
  steer: number;
  /** Hold to brake harder */
  brake: boolean;
  /** Jump / second tap handled server-side with coyote time */
  jumpPressed: boolean;
  /** Hold boost */
  boost: boolean;
  /** Powerslide: more yaw, less lateral grip (simplified) */
  drift: boolean;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Quat {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface CarSnapshot {
  position: Vec3;
  rotation: Quat;
  linVel: Vec3;
  angVel: Vec3;
  team: TeamId;
  boost: number;
  yaw: number;
  isBoosting: boolean;
}

export interface BallSnapshot {
  position: Vec3;
  rotation: Quat;
  linVel: Vec3;
  angVel: Vec3;
}

export interface GameSnapshot {
  serverTime: number;
  ball: BallSnapshot;
  cars: Record<string, CarSnapshot>;
  scores: { blue: number; orange: number };
  matchSecondsRemaining: number;
  phase: "playing" | "goal_pause" | "ended";
  countdown?: number;
  /** Last scorer for simple FX */
  lastGoal?: { team: TeamId; at: number };
  boostPads: boolean[];
}

export interface LobbyPlayer {
  id: string;
  name: string;
  team: TeamId;
  ready: boolean;
  isHost: boolean;
  /** False when the tab disconnected but the slot is reserved for reconnect. */
  online: boolean;
}

export interface ClientToServerEvents {
  createRoom: (name: string, cb: (res: { ok: boolean; roomCode?: string; error?: string }) => void) => void;
  joinRoom: (payload: { code: string; name: string }, cb: (res: { ok: boolean; error?: string }) => void) => void;
  setTeam: (team: TeamId) => void;
  setReady: (ready: boolean) => void;
  startMatch: () => void;
  input: (payload: PlayerInput) => void;
  reconnect: (payload: { code: string; playerId: string }, cb: (res: { ok: boolean; error?: string }) => void) => void;
  resetCar: () => void;
}

export interface ServerToClientEvents {
  /** Sent after join/create/reconnect so the client can persist `playerId` for reconnect. */
  assignedPlayer: (payload: { playerId: string; roomCode: string }) => void;
  lobbyUpdate: (payload: {
    roomCode: string;
    players: LobbyPlayer[];
    you: string;
    /** True while the authoritative match simulation is running (reconnect mid-game). */
    matchLive: boolean;
  }) => void;
  snapshot: (snap: GameSnapshot) => void;
  kicked: (reason: string) => void;
}
