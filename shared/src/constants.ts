/** Fixed simulation timestep (seconds). Server runs physics at this rate. */
export const PHYSICS_DT = 1 / 60;

/** Network snapshot rate (Hz). Can be lower than physics for bandwidth. */
export const SNAPSHOT_HZ = 30;

/** Match length in seconds (MVP). */
export const MATCH_DURATION_SEC = 300;

/** Room codes: uppercase alphanumeric, easy to read. */
export const ROOM_CODE_LENGTH = 6;

/** Max players per room for MVP (1v1). */
export const MAX_PLAYERS = 2;

/** Arena half-extents (meters): X = half width, Z = half length. */
export const ARENA = {
  halfWidth: 18,
  halfLength: 28,
  wallHeight: 14,
  wallThickness: 1.2,
} as const;

export const BALL_RADIUS = 1.15;

/** Goal opening: half width along X, max height Y. */
export const GOAL = {
  halfWidth: 6,
  height: 4,
  depth: 2,
} as const;

/** Car collider half-extents (box). */
export const CAR_HALF_EXTENTS = { x: 0.75, y: 0.35, z: 1.15 } as const;

export const CAR_MAX_SPEED = 28;
export const CAR_BOOST_MAX_SPEED = 42;
export const CAR_ACCEL = 55;
export const CAR_BRAKE = 70;
export const CAR_STEER_TORQUE = 28;
export const CAR_JUMP_IMPULSE = 80;
export const CAR_BOOST_FORCE = 85;
export const CAR_MAX_BOOST = 100;
export const CAR_BOOST_DRAIN_PER_SEC = 33;
export const CAR_BOOST_RECHARGE_PER_SEC = 8;

export const BOOST_PAD_POSITIONS = [
  { x: -ARENA.halfWidth * 0.6, z: 0 },
  { x: ARENA.halfWidth * 0.6, z: 0 },
  { x: -ARENA.halfWidth * 0.6, z: -ARENA.halfLength * 0.6 },
  { x: ARENA.halfWidth * 0.6, z: -ARENA.halfLength * 0.6 },
  { x: -ARENA.halfWidth * 0.6, z: ARENA.halfLength * 0.6 },
  { x: ARENA.halfWidth * 0.6, z: ARENA.halfLength * 0.6 },
  { x: 0, z: -ARENA.halfLength * 0.8 },
  { x: 0, z: ARENA.halfLength * 0.8 }
] as const;

export const BOOST_PAD_AMOUNT = 25;
export const BOOST_PAD_COOLDOWN_SEC = 4;
export const BOOST_PAD_RADIUS = 2.5;
