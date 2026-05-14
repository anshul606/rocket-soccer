import RAPIER from "@dimforge/rapier3d-compat";
import {
  ARENA,
  BALL_RADIUS,
  CAR_ACCEL,
  CAR_BOOST_DRAIN_PER_SEC,
  CAR_BOOST_FORCE,
  CAR_BOOST_MAX_SPEED,
  CAR_BOOST_RECHARGE_PER_SEC,
  CAR_HALF_EXTENTS,
  CAR_JUMP_IMPULSE,
  CAR_MAX_BOOST,
  CAR_MAX_SPEED,
  GOAL,
  MATCH_DURATION_SEC,
  PHYSICS_DT,
  BOOST_PAD_POSITIONS,
  BOOST_PAD_AMOUNT,
  BOOST_PAD_COOLDOWN_SEC,
  BOOST_PAD_RADIUS,
  type BallSnapshot,
  type CarSnapshot,
  type GameSnapshot,
  type PlayerInput,
  type TeamId,
} from "@rocket-soccer/shared";

type RigidBody = RAPIER.RigidBody;

let rapierReady = false;
export async function ensureRapier(): Promise<void> {
  if (!rapierReady) {
    await RAPIER.init();
    rapierReady = true;
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

const ZERO_INPUT: PlayerInput = {
  throttle: 0,
  steer: 0,
  brake: false,
  jumpPressed: false,
  boost: false,
  drift: false,
};

function quatFromYaw(yaw: number): RAPIER.Quaternion {
  const half = yaw * 0.5;
  return { w: Math.cos(half), x: 0, y: Math.sin(half), z: 0 };
}

function rotateVecByYaw(v: { x: number; y: number; z: number }, yaw: number) {
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  return { x: c * v.x + s * v.z, y: v.y, z: -s * v.x + c * v.z };
}

interface CarRuntime {
  body: RigidBody;
  team: TeamId;
  boost: number;
  yaw: number;
  /** Last frame jump was held (for edge detect) */
  jumpHeld: boolean;
  airJumpsUsed: number;
  isBoosting: boolean;
}

export class GameWorld {
  readonly world: RAPIER.World;
  private ball: RigidBody;
  private cars = new Map<string, CarRuntime>();
  private inputs = new Map<string, PlayerInput>();
  private accumulator = 0;
  private blueScore = 0;
  private orangeScore = 0;
  private matchTimeLeft: number;
  private phase: GameSnapshot["phase"] = "playing";
  private goalPauseT = 0;
  private lastGoal?: { team: TeamId; at: number };
  private serverTime = 0;
  private countdownT = 3;
  private padCooldowns = new Array(BOOST_PAD_POSITIONS.length).fill(0);

  constructor(matchDurationSec: number = MATCH_DURATION_SEC) {
    this.world = new RAPIER.World({ x: 0, y: -18, z: 0 });
    this.matchTimeLeft = matchDurationSec;
    this.buildArena();
    const ballBodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(0, BALL_RADIUS + 0.1, 0)
      .setCanSleep(false)
      .setLinearDamping(0.02)
      .setAngularDamping(0.1);
    this.ball = this.world.createRigidBody(ballBodyDesc);
    const ballCollider = RAPIER.ColliderDesc.ball(BALL_RADIUS)
      .setRestitution(0.65)
      .setFriction(0.1)
      .setDensity(0.3);
    this.world.createCollider(ballCollider, this.ball);
  }

  /** Reset positions after a goal (keeps scores). */
  resetKickoff() {
    this.teleportBall(0, 4, 0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
    for (const [pid, car] of this.cars) {
      const ids = [...this.cars.keys()].sort();
      const teamIds = ids.filter((id) => this.cars.get(id)!.team === car.team);
      const slot = Math.max(0, teamIds.indexOf(pid));
      const spawn = this.computeSpawn(car.team, slot);
      this.teleportCar(car, spawn.x, spawn.y, spawn.z, spawn.yaw);
      car.boost = Math.min(car.boost + 35, CAR_MAX_BOOST);
      car.airJumpsUsed = 0;
    }
    this.padCooldowns.fill(0);
  }

  addCar(playerId: string, team: TeamId) {
    const slot = [...this.cars.values()].filter((c) => c.team === team).length;
    const spawn = this.computeSpawn(team, slot);
    const bodyDesc = RAPIER.RigidBodyDesc.dynamic()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setRotation(quatFromYaw(spawn.yaw))
      .setCanSleep(false)
      .setLinearDamping(0.35)
      .setAngularDamping(2.2);
    const body = this.world.createRigidBody(bodyDesc);
    const collider = RAPIER.ColliderDesc.cuboid(CAR_HALF_EXTENTS.x, CAR_HALF_EXTENTS.y, CAR_HALF_EXTENTS.z)
      .setFriction(1.1)
      .setRestitution(0.05)
      .setDensity(2.4);
    this.world.createCollider(collider, body);
    this.cars.set(playerId, {
      body,
      team,
      boost: CAR_MAX_BOOST * 0.65,
      yaw: spawn.yaw,
      jumpHeld: false,
      airJumpsUsed: 0,
      isBoosting: false,
    });
    this.inputs.set(playerId, { ...ZERO_INPUT });
  }

  setInput(playerId: string, input: PlayerInput) {
    this.inputs.set(playerId, input);
  }

  removePlayer(playerId: string) {
    const car = this.cars.get(playerId);
    if (!car) return;
    this.world.removeRigidBody(car.body);
    this.cars.delete(playerId);
    this.inputs.delete(playerId);
  }

  step(dt: number): GameSnapshot {
    this.accumulator += dt;
    const maxSteps = 5;
    let steps = 0;
    while (this.accumulator >= PHYSICS_DT && steps < maxSteps) {
      this.simulateStep();
      this.accumulator -= PHYSICS_DT;
      steps++;
    }
    this.serverTime += dt;
    if (this.phase === "goal_pause") {
      this.goalPauseT -= dt;
      if (this.goalPauseT <= 0) {
        this.phase = "playing";
        this.resetKickoff();
        this.countdownT = 3;
      }
    } else if (this.countdownT > 0) {
      this.countdownT -= dt;
    } else if (this.phase === "playing") {
      this.matchTimeLeft -= dt;
      if (this.matchTimeLeft <= 0) {
        this.matchTimeLeft = 0;
        this.phase = "ended";
      }
    }
    return this.buildSnapshot();
  }

  private simulateStep() {
    if (this.phase === "goal_pause" || this.phase === "ended" || this.countdownT > 0) {
      this.freezeWorld();
      return;
    }
    for (const [pid, car] of this.cars) {
      const input = this.inputs.get(pid) ?? ZERO_INPUT;
      this.integrateCar(car, input);

      const pos = car.body.translation();
      for (let i = 0; i < BOOST_PAD_POSITIONS.length; i++) {
        if (this.padCooldowns[i] <= 0) {
          const padPos = BOOST_PAD_POSITIONS[i];
          const dx = pos.x - padPos.x;
          const dz = pos.z - padPos.z;
          const distSq = dx * dx + dz * dz;
          if (distSq < BOOST_PAD_RADIUS * BOOST_PAD_RADIUS && pos.y < 3) {
            car.boost = Math.min(CAR_MAX_BOOST, car.boost + BOOST_PAD_AMOUNT);
            this.padCooldowns[i] = BOOST_PAD_COOLDOWN_SEC;
          }
        }
      }
    }

    for (let i = 0; i < this.padCooldowns.length; i++) {
      if (this.padCooldowns[i] > 0) {
        this.padCooldowns[i] -= PHYSICS_DT;
      }
    }

    this.world.step();
    this.checkGoals();
  }

  private freezeWorld() {
    this.ball.setLinvel({ x: 0, y: 0, z: 0 }, true);
    this.ball.setAngvel({ x: 0, y: 0, z: 0 }, true);
    for (const car of this.cars.values()) {
      car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
      car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    }
  }

  private integrateCar(car: CarRuntime, input: PlayerInput) {
    const lv = car.body.linvel();
    const av = car.body.angvel();
    const forward = rotateVecByYaw({ x: 0, y: 0, z: 1 }, car.yaw);
    const right = rotateVecByYaw({ x: 1, y: 0, z: 0 }, car.yaw);

    const grounded = this.isGrounded(car.body);
    if (grounded) {
      car.airJumpsUsed = 0;
    }

    const jumpEdge = input.jumpPressed && !car.jumpHeld;
    car.jumpHeld = input.jumpPressed;
    let justJumped = false;
    if (jumpEdge && grounded) {
      car.body.applyImpulse({ x: 0, y: CAR_JUMP_IMPULSE, z: 0 }, true);
      justJumped = true;
    }

    const throttle = clamp(input.throttle, -1, 1);
    const steer = clamp(input.steer, -1, 1);
    const maxSp = input.boost && car.boost > 0 ? CAR_BOOST_MAX_SPEED : CAR_MAX_SPEED;

    if (grounded) {
      const speed = Math.hypot(lv.x, lv.z);
      const steerMul = input.drift ? 1.35 : 1;
      // Reduced steering: less yaw rate, speed-dependent like RL
      const baseSteer = 1.8;
      const yawRate = -steer * steerMul * (baseSteer + speed * 0.025);
      car.yaw += yawRate * PHYSICS_DT;
      car.body.setRotation(quatFromYaw(car.yaw), true);
      car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    } else {
      car.body.setAngvel({ x: av.x * 0.92 - steer * 2.6, y: av.y * 0.92, z: av.z * 0.92 }, true);
    }

    if (grounded) {
      const accel = throttle * CAR_ACCEL * PHYSICS_DT;
      let nvx = lv.x + forward.x * accel;
      let nvz = lv.z + forward.z * accel;
      if (input.brake) {
        nvx *= 0.9;
        nvz *= 0.9;
      }
      const fwdSpd = forward.x * nvx + forward.z * nvz;
      let side = right.x * nvx + right.z * nvz;
      const grip = input.drift ? 0.48 : 0.86;
      side *= Math.pow(grip, PHYSICS_DT * 60);
      nvx = forward.x * fwdSpd + right.x * side;
      nvz = forward.z * fwdSpd + right.z * side;
      let fspd = forward.x * nvx + forward.z * nvz;
      if (fspd > maxSp) {
        const s = maxSp / fspd;
        nvx *= s;
        nvz *= s;
        fspd = maxSp;
      }
      if (fspd < -maxSp * 0.45) {
        const s = (-maxSp * 0.45) / fspd;
        nvx *= s;
        nvz *= s;
      }
      // CRITICAL: re-read y-velocity AFTER possible jump impulse to not overwrite it
      const lyAfterJump = justJumped ? car.body.linvel().y : lv.y;
      car.body.setLinvel({ x: nvx, y: lyAfterJump, z: nvz }, true);
    } else {
      const aerial = throttle * CAR_ACCEL * 0.07 * PHYSICS_DT;
      car.body.applyImpulse({ x: forward.x * aerial, y: Math.abs(throttle) * 0.02, z: forward.z * aerial }, true);
    }

    if (input.boost && car.boost > 0) {
      const f = CAR_BOOST_FORCE * PHYSICS_DT;
      car.body.applyImpulse({ x: forward.x * f, y: 0, z: forward.z * f }, true);
      car.boost -= CAR_BOOST_DRAIN_PER_SEC * PHYSICS_DT;
      car.isBoosting = true;
    } else {
      car.isBoosting = false;
      if (grounded) {
        car.boost = Math.min(CAR_MAX_BOOST, car.boost + CAR_BOOST_RECHARGE_PER_SEC * PHYSICS_DT * 0.25);
      }
    }
    car.boost = clamp(car.boost, 0, CAR_MAX_BOOST);

    const p = car.body.translation();
    const clamped = this.clampCarPosition(p);
    if (clamped.x !== p.x || clamped.y !== p.y || clamped.z !== p.z) {
      car.body.setTranslation(clamped, true);
    }
  }

  private clampCarPosition(p: { x: number; y: number; z: number }) {
    const margin = 1.5;
    const maxX = ARENA.halfWidth - margin;
    const maxZ = ARENA.halfLength - margin;
    return {
      x: Math.max(-maxX, Math.min(maxX, p.x)),
      // Let Rapier handle floor collision naturally; only clamp ceiling
      y: Math.max(0, Math.min(ARENA.wallHeight + 6, p.y)),
      z: Math.max(-maxZ, Math.min(maxZ, p.z)),
    };
  }

  private isGrounded(body: RigidBody): boolean {
    const p = body.translation();
    // Simple height-based check
    if (p.y < CAR_HALF_EXTENTS.y + 0.25) return true;
    // Raycast: start slightly below the car's bounding box to avoid hitting itself
    const rayOrigin = { x: p.x, y: p.y - CAR_HALF_EXTENTS.y - 0.05, z: p.z };
    const rayDir = { x: 0, y: -1, z: 0 };
    const ray = new RAPIER.Ray(rayOrigin, rayDir);
    const hit = this.world.castRay(ray, 0.4, true);
    if (!hit) return false;
    const toi = (hit as { timeOfImpact?: number; toi?: number }).timeOfImpact ?? (hit as { toi?: number }).toi ?? 99;
    return toi < 0.3;
  }

  private checkGoals() {
    if (this.phase !== "playing") return;
    const p = this.ball.translation();
    const inBlueGoal =
      p.z < -ARENA.halfLength + GOAL.depth + BALL_RADIUS * 0.5 &&
      Math.abs(p.x) < GOAL.halfWidth - BALL_RADIUS * 0.25 &&
      p.y < GOAL.height;
    const inOrangeGoal =
      p.z > ARENA.halfLength - GOAL.depth - BALL_RADIUS * 0.5 &&
      Math.abs(p.x) < GOAL.halfWidth - BALL_RADIUS * 0.25 &&
      p.y < GOAL.height;
    if (inBlueGoal) {
      this.orangeScore += 1;
      this.beginGoalPause("orange");
    } else if (inOrangeGoal) {
      this.blueScore += 1;
      this.beginGoalPause("blue");
    }
  }

  private beginGoalPause(scoringTeam: TeamId) {
    this.phase = "goal_pause";
    this.goalPauseT = 2.1;
    this.lastGoal = { team: scoringTeam, at: this.serverTime };
  }

  private teleportBall(
    x: number,
    y: number,
    z: number,
    lv: { x: number; y: number; z: number },
    av: { x: number; y: number; z: number },
  ) {
    this.ball.setTranslation({ x, y, z }, true);
    this.ball.setLinvel(lv, true);
    this.ball.setAngvel(av, true);
    this.ball.setRotation({ w: 1, x: 0, y: 0, z: 0 }, true);
  }

  private teleportCar(car: CarRuntime, x: number, y: number, z: number, yaw: number) {
    car.yaw = yaw;
    car.body.setTranslation({ x, y, z }, true);
    car.body.setLinvel({ x: 0, y: 0, z: 0 }, true);
    car.body.setAngvel({ x: 0, y: 0, z: 0 }, true);
    car.body.setRotation(quatFromYaw(yaw), true);
  }

  resetCar(playerId: string) {
    const car = this.cars.get(playerId);
    if (!car) return;
    const ids = [...this.cars.keys()].sort();
    const teamIds = ids.filter((id) => this.cars.get(id)!.team === car.team);
    const slot = Math.max(0, teamIds.indexOf(playerId));
    const sp = this.computeSpawn(car.team, slot);
    this.teleportCar(car, sp.x, sp.y + 0.8, sp.z, sp.yaw);
  }

  private computeSpawn(team: TeamId, slot: number) {
    const side = team === "blue" ? -1 : 1;
    // Centered spawn like real Rocket League — slot 0 at center, 1&2 offset
    const xOffsets = [0, -3.5, 3.5, -7, 7];
    const x = xOffsets[Math.min(slot, xOffsets.length - 1)];
    const z = side * (ARENA.halfLength * 0.38);
    const yaw = side < 0 ? 0 : Math.PI;
    return { x, y: 1.4, z, yaw };
  }

  private buildArena() {
    const h = ARENA;
    const floor = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
    this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(h.halfWidth + h.wallThickness, 0.5, h.halfLength + h.wallThickness).setFriction(1.2),
      floor,
    );

    const wallT = h.wallThickness * 0.5;
    const makeWall = (x: number, y: number, z: number, hx: number, hy: number, hz: number) => {
      const b = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
      this.world.createCollider(
        RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.6).setRestitution(0.35),
        b,
      );
    };

    // --- SIDE WALLS (Straight) ---
    const wh = h.wallHeight * 0.5;
    makeWall(-h.halfWidth - wallT, wh, 0, wallT, wh, h.halfLength);
    makeWall(h.halfWidth + wallT, wh, 0, wallT, wh, h.halfLength);

    // --- END WALLS & GOALS ---
    const bwh = (h.halfWidth - GOAL.halfWidth) * 0.5;
    const zBlue = -h.halfLength;
    const zOrange = h.halfLength;

    // Back walls (the parts next to the goal)
    [-1, 1].forEach(side => {
      const px = side * (GOAL.halfWidth + bwh);
      makeWall(px, wh, zBlue - wallT, bwh, wh, wallT);
      makeWall(px, wh, zOrange + wallT, bwh, wh, wallT);
    });

    // Wall above the goals
    const topHeight = h.wallHeight - GOAL.height;
    if (topHeight > 0) {
      const ty = GOAL.height + topHeight * 0.5;
      makeWall(0, ty, zBlue - wallT, GOAL.halfWidth, topHeight * 0.5, wallT);
      makeWall(0, ty, zOrange + wallT, GOAL.halfWidth, topHeight * 0.5, wallT);
    }

    // Goal boxes (walls behind the goal and sides inside the goal)
    const gd = GOAL.depth;
    // Back of goals
    makeWall(0, GOAL.height * 0.5, zBlue - gd - wallT, GOAL.halfWidth, GOAL.height * 0.5, wallT);
    makeWall(0, GOAL.height * 0.5, zOrange + gd + wallT, GOAL.halfWidth, GOAL.height * 0.5, wallT);
    // Side inner walls of goals
    makeWall(-GOAL.halfWidth - wallT, GOAL.height * 0.5, zBlue - gd * 0.5, wallT, GOAL.height * 0.5, gd * 0.5);
    makeWall(GOAL.halfWidth + wallT, GOAL.height * 0.5, zBlue - gd * 0.5, wallT, GOAL.height * 0.5, gd * 0.5);
    makeWall(-GOAL.halfWidth - wallT, GOAL.height * 0.5, zOrange + gd * 0.5, wallT, GOAL.height * 0.5, gd * 0.5);
    makeWall(GOAL.halfWidth + wallT, GOAL.height * 0.5, zOrange + gd * 0.5, wallT, GOAL.height * 0.5, gd * 0.5);

    // Ceiling
    const ceilingY = h.wallHeight + 2;
    const ceil = this.world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, ceilingY, 0));
    this.world.createCollider(RAPIER.ColliderDesc.cuboid(h.halfWidth + 2, 0.6, h.halfLength + 2).setRestitution(0.3), ceil);
  }

  private buildSnapshot(): GameSnapshot {
    const ball: BallSnapshot = {
      position: this.vec(this.ball.translation()),
      rotation: this.quat(this.ball.rotation()),
      linVel: this.vec(this.ball.linvel()),
      angVel: this.vec(this.ball.angvel()),
    };
    const cars: Record<string, CarSnapshot> = {};
    for (const [pid, car] of this.cars) {
      cars[pid] = {
        position: this.vec(car.body.translation()),
        rotation: this.quat(car.body.rotation()),
        linVel: this.vec(car.body.linvel()),
        angVel: this.vec(car.body.angvel()),
        team: car.team,
        boost: car.boost,
        yaw: car.yaw,
        isBoosting: car.isBoosting,
      };
    }
    return {
      serverTime: this.serverTime,
      ball,
      cars,
      scores: { blue: this.blueScore, orange: this.orangeScore },
      matchSecondsRemaining: Math.max(0, this.matchTimeLeft),
      phase: this.phase,
      lastGoal: this.lastGoal,
      countdown: this.countdownT > 0 ? Math.ceil(this.countdownT) : undefined,
      boostPads: this.padCooldowns.map((c) => c <= 0),
    };
  }

  private vec(v: { x: number; y: number; z: number }) {
    return { x: v.x, y: v.y, z: v.z };
  }

  private quat(q: { x: number; y: number; z: number; w: number }) {
    return { x: q.x, y: q.y, z: q.z, w: q.w };
  }
}
