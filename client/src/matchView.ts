import * as THREE from "three";
import {
  ARENA,
  BALL_RADIUS,
  CAR_HALF_EXTENTS,
  GOAL,
  type BallSnapshot,
  type CarSnapshot,
  type GameSnapshot,
} from "@rocket-soccer/shared";
import { ParticleSystem } from "./particles.js";

const interpDelay = 0.11;

function lerp(a: number, b: number, t: number) {
  return a + (b - a) * t;
}

/**
 * Three.js presentation layer: arena visuals, interpolated rigid-body poses, and chase / ball cameras.
 */
export class MatchView {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private ballMesh: THREE.Mesh;
  private carMeshes = new Map<string, THREE.Group>();
  private boostPadMeshes: THREE.Mesh[] = [];
  private ballTrail: THREE.Line;
  private trailPos: THREE.Vector3[] = [];
  private maxTrail = 40;
  private snaps: GameSnapshot[] = [];
  private clockOffset = 0;
  private raf = 0;
  ballCam = false;
  private tmpQa = new THREE.Quaternion();
  private tmpQb = new THREE.Quaternion();
  private tmpQ = new THREE.Quaternion();

  private particles: ParticleSystem;
  private lastGoalAt = 0;
  private prevBallVel = new THREE.Vector3();
  private lastTime = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.camera = new THREE.PerspectiveCamera(58, window.innerWidth / window.innerHeight, 0.1, 500);
    this.camera.position.set(0, 18, 32);

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;

    this.scene.background = new THREE.Color(0x05070f);
    this.scene.fog = new THREE.FogExp2(0x05070f, 0.012);

    // Rich stadium lighting
    const hemi = new THREE.HemisphereLight(0x88bbff, 0x001122, 0.6);
    this.scene.add(hemi);

    const addSpotLight = (x: number, y: number, z: number, color: number, intensity: number) => {
      const spot = new THREE.SpotLight(color, intensity, 120, Math.PI / 4, 0.5);
      spot.position.set(x, y, z);
      spot.castShadow = false;
      this.scene.add(spot);
    };
    // Four corner stadium lights
    addSpotLight(-ARENA.halfWidth, 18, -ARENA.halfLength, 0xffffff, 1.8);
    addSpotLight( ARENA.halfWidth, 18, -ARENA.halfLength, 0xffffff, 1.8);
    addSpotLight(-ARENA.halfWidth, 18,  ARENA.halfLength, 0xffffff, 1.8);
    addSpotLight( ARENA.halfWidth, 18,  ARENA.halfLength, 0xffffff, 1.8);
    // Blue goal light
    const blueLight = new THREE.PointLight(0x0066ff, 2.5, 30);
    blueLight.position.set(0, 4, -ARENA.halfLength + 2);
    this.scene.add(blueLight);
    // Orange goal light
    const orangeLight = new THREE.PointLight(0xff6600, 2.5, 30);
    orangeLight.position.set(0, 4, ARENA.halfLength - 2);
    this.scene.add(orangeLight);

    this.buildArena();

    const ballGeo = new THREE.SphereGeometry(BALL_RADIUS, 32, 32);
    const ballMat = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      roughness: 0.2,
      metalness: 0.1,
      emissive: 0x334466,
      emissiveIntensity: 0.3,
    });
    this.ballMesh = new THREE.Mesh(ballGeo, ballMat);
    this.ballMesh.castShadow = true;
    this.ballMesh.receiveShadow = false;
    this.scene.add(this.ballMesh);

    const trailGeo = new THREE.BufferGeometry();
    const trailMat = new THREE.LineBasicMaterial({ color: 0x88ccff, transparent: true, opacity: 0.45 });
    this.ballTrail = new THREE.Line(trailGeo, trailMat);
    this.scene.add(this.ballTrail);

    this.particles = new ParticleSystem(this.scene);
    this.lastTime = performance.now() / 1000;

    window.addEventListener("resize", () => this.onResize());
  }

  private buildArena() {
    const w = ARENA.halfWidth;
    const l = ARENA.halfLength;
    const h = ARENA.wallHeight;

    // --- FLOOR ---
    const floorMat = new THREE.MeshStandardMaterial({ color: 0x0a1a12, roughness: 0.9, metalness: 0.05 });
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(w * 2 + 4, l * 2 + 4), floorMat);
    floor.rotation.x = -Math.PI / 2;
    floor.receiveShadow = true;
    this.scene.add(floor);

    // Field lines (white)
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, side: THREE.DoubleSide });
    // Center line
    const centerLine = new THREE.Mesh(new THREE.PlaneGeometry(w * 2, 0.18), lineMat);
    centerLine.rotation.x = -Math.PI / 2; centerLine.position.y = 0.02;
    this.scene.add(centerLine);
    // Center circle
    const circMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.45, side: THREE.DoubleSide });
    const circOuter = new THREE.Mesh(new THREE.RingGeometry(4.8, 5.0, 48), circMat);
    circOuter.rotation.x = -Math.PI / 2; circOuter.position.y = 0.02;
    this.scene.add(circOuter);
    // Goal boxes (blue side)
    const goalBoxMat = new THREE.MeshBasicMaterial({ color: 0x3388ff, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
    const goalBoxGeo = new THREE.PlaneGeometry(GOAL.halfWidth * 2 + 1, 6);
    const blueBox = new THREE.Mesh(goalBoxGeo, goalBoxMat);
    blueBox.rotation.x = -Math.PI / 2; blueBox.position.set(0, 0.02, -l + 3);
    this.scene.add(blueBox);
    const orangeBoxMat = new THREE.MeshBasicMaterial({ color: 0xff7700, transparent: true, opacity: 0.18, side: THREE.DoubleSide });
    const orangeBox = new THREE.Mesh(goalBoxGeo, orangeBoxMat);
    orangeBox.rotation.x = -Math.PI / 2; orangeBox.position.set(0, 0.02, l - 3);
    this.scene.add(orangeBox);

    // --- FLAT SIDE WALLS ---
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x152030, roughness: 0.8, metalness: 0.2, side: THREE.DoubleSide });
    const sideWallGeo = new THREE.PlaneGeometry(l * 2, h);
    
    const leftWall = new THREE.Mesh(sideWallGeo, wallMat);
    leftWall.rotation.y = Math.PI / 2;
    leftWall.position.set(-w, h / 2, 0);
    this.scene.add(leftWall);

    const rightWall = new THREE.Mesh(sideWallGeo, wallMat);
    rightWall.rotation.y = -Math.PI / 2;
    rightWall.position.set(w, h / 2, 0);
    this.scene.add(rightWall);

    // Flat back walls (end walls with goal openings)
    const endWallMat = new THREE.MeshStandardMaterial({ color: 0x101825, roughness: 0.8, metalness: 0.15, side: THREE.DoubleSide });
    // Blue back wall (2 panels flanking goal)
    const bwh = (w - GOAL.halfWidth); // side panel width
    const bwGeo = new THREE.PlaneGeometry(bwh, h);
    [-1, 1].forEach(side => {
      const bw = new THREE.Mesh(bwGeo, endWallMat);
      bw.position.set(side * (GOAL.halfWidth + bwh / 2), h / 2, -l);
      this.scene.add(bw);
      const ow = new THREE.Mesh(bwGeo, endWallMat);
      ow.position.set(side * (GOAL.halfWidth + bwh / 2), h / 2, l);
      ow.rotation.y = Math.PI;
      this.scene.add(ow);
    });
    // Goal top panels (above goal)
    const gtGeo = new THREE.PlaneGeometry(GOAL.halfWidth * 2, h - GOAL.height);
    const gtBlue = new THREE.Mesh(gtGeo, endWallMat);
    gtBlue.position.set(0, GOAL.height + (h - GOAL.height) / 2, -l);
    this.scene.add(gtBlue);
    const gtOrange = new THREE.Mesh(gtGeo, endWallMat);
    gtOrange.position.set(0, GOAL.height + (h - GOAL.height) / 2, l);
    gtOrange.rotation.y = Math.PI;
    this.scene.add(gtOrange);

    // --- CEILING ---
    const ceilMat = new THREE.MeshBasicMaterial({ color: 0x080e16, side: THREE.DoubleSide });
    const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w * 2, l * 2), ceilMat);
    ceil.rotation.x = -Math.PI / 2; ceil.position.y = h;
    this.scene.add(ceil);

    // --- NEON EDGE TRIMS ---
    const neonMat = new THREE.LineBasicMaterial({ color: 0x00eeff });
    const makeLine = (pts: [number, number, number][]) => {
      const g = new THREE.BufferGeometry().setFromPoints(pts.map(([x, y, z]) => new THREE.Vector3(x, y, z)));
      this.scene.add(new THREE.Line(g, neonMat));
    };
    // Floor border
    makeLine([[-w,0.05,-l],[w,0.05,-l],[w,0.05,l],[-w,0.05,l],[-w,0.05,-l]]);
    // Top border at wall height
    makeLine([[-w,h,-l],[w,h,-l],[w,h,l],[-w,h,l],[-w,h,-l]]);
    // Vertical corner edges
    [[-w,-l],[w,-l],[w,l],[-w,l]].forEach(([cx,cz]) => makeLine([[cx,0.05,cz],[cx,h,cz]]));

    // --- GOALS ---
    const createGoal = (isBlue: boolean) => {
      const color = isBlue ? 0x0088ff : 0xff6600;
      const zOffset = isBlue ? -l : l;
      const rotY = isBlue ? 0 : Math.PI;
      const g = new THREE.Group();
      g.position.set(0, 0, zOffset); g.rotation.y = rotY;

      const postMat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 1.2, roughness: 0.3 });
      const postGeo = new THREE.CylinderGeometry(0.18, 0.18, GOAL.height, 12);
      [-GOAL.halfWidth, GOAL.halfWidth].forEach(px => {
        const p = new THREE.Mesh(postGeo, postMat); p.position.set(px, GOAL.height / 2, 0); g.add(p);
      });
      const crossbar = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, GOAL.halfWidth * 2 + 0.36, 12), postMat);
      crossbar.rotation.z = Math.PI / 2; crossbar.position.set(0, GOAL.height, 0); g.add(crossbar);

      // Net with grid lines (back, left, right, top)
      const netMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.25, side: THREE.DoubleSide, wireframe: false });
      const wireMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.15, wireframe: true });

      const addPanel = (geo: THREE.BufferGeometry, pos: [number, number, number], rot: [number, number, number]) => {
        const m = new THREE.Mesh(geo, netMat);
        const w = new THREE.Mesh(geo, wireMat);
        m.add(w);
        m.position.set(...pos);
        m.rotation.set(...rot);
        g.add(m);
      };

      const gw = GOAL.halfWidth * 2;
      const gh = GOAL.height;
      const gd = GOAL.depth;

      // Back net
      addPanel(new THREE.PlaneGeometry(gw, gh, 6, 4), [0, gh / 2, -gd], [0, 0, 0]);
      // Left net
      addPanel(new THREE.PlaneGeometry(gd, gh, 3, 4), [-GOAL.halfWidth, gh / 2, -gd / 2], [0, Math.PI / 2, 0]);
      // Right net
      addPanel(new THREE.PlaneGeometry(gd, gh, 3, 4), [GOAL.halfWidth, gh / 2, -gd / 2], [0, -Math.PI / 2, 0]);
      // Top net
      addPanel(new THREE.PlaneGeometry(gw, gd, 6, 3), [0, gh, -gd / 2], [Math.PI / 2, 0, 0]);

      // Glowing goal floor
      const gfMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.3 });
      const gf = new THREE.Mesh(new THREE.PlaneGeometry(GOAL.halfWidth * 2, GOAL.depth), gfMat);
      gf.rotation.x = -Math.PI / 2; gf.position.set(0, 0.04, -GOAL.depth / 2); g.add(gf);

      // Point light inside goal
      const gl = new THREE.PointLight(color, 3, 12);
      gl.position.set(0, GOAL.height / 2, -GOAL.depth / 2); g.add(gl);

      this.scene.add(g);
    };
    createGoal(true); createGoal(false);

    // --- BOOST PADS ---
    const padPositions = [
      { x: -w * 0.6, z: 0 }, { x: w * 0.6, z: 0 },
      { x: -w * 0.6, z: -l * 0.6 }, { x: w * 0.6, z: -l * 0.6 },
      { x: -w * 0.6, z:  l * 0.6 }, { x: w * 0.6, z:  l * 0.6 },
      { x: 0, z: -l * 0.8 }, { x: 0, z: l * 0.8 },
    ];
    for (const p of padPositions) {
      const padMat = new THREE.MeshBasicMaterial({ color: 0xffdd00, transparent: true, opacity: 0.85, side: THREE.DoubleSide });
      const pad = new THREE.Mesh(new THREE.RingGeometry(0.7, 1.3, 16), padMat);
      pad.rotation.x = -Math.PI / 2; pad.position.set(p.x, 0.04, p.z);
      this.scene.add(pad);
      this.boostPadMeshes.push(pad);
      // Inner glow disc
      const disc = new THREE.Mesh(new THREE.CircleGeometry(0.7, 16),
        new THREE.MeshBasicMaterial({ color: 0xffaa00, transparent: true, opacity: 0.3 }));
      disc.rotation.x = -Math.PI / 2; disc.position.set(p.x, 0.03, p.z);
      this.scene.add(disc);
    }
  }




  ensureCarMesh(id: string, team: CarSnapshot["team"]) {
    if (this.carMeshes.has(id)) return;
    const group = new THREE.Group();
    const col = team === "blue" ? 0x0077ff : 0xff5500;
    const bodyMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.3, metalness: 0.6, emissive: col, emissiveIntensity: 0.2 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.2, metalness: 0.9 });
    const wheelMat = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.8, metalness: 0.4 });
    const rimMat = new THREE.MeshStandardMaterial({ color: 0x888888, roughness: 0.3, metalness: 0.95 });

    // Physics center is at y = CAR_HALF_EXTENTS.y = 0.35 above floor
    // So local y=0 in group = world y=0.35 (mid-car)
    // local y=-0.35 = floor level

    // Main body (wedge shape - front lower, back higher)
    const bodyW = CAR_HALF_EXTENTS.x * 2;     // 1.5
    const bodyH = CAR_HALF_EXTENTS.y * 2;     // 0.7
    const bodyD = CAR_HALF_EXTENTS.z * 2;     // 2.3

    // Lower chassis (full width)
    const lowerGeo = new THREE.BoxGeometry(bodyW, bodyH * 0.55, bodyD);
    const lower = new THREE.Mesh(lowerGeo, bodyMat);
    lower.position.set(0, -bodyH * 0.225, 0);
    lower.castShadow = true;
    group.add(lower);

    // Upper body (wedge: tapers from back to front)
    // Simulate wedge with a box tilted slightly
    const upperGeo = new THREE.BoxGeometry(bodyW * 0.9, bodyH * 0.55, bodyD * 0.75);
    const upper = new THREE.Mesh(upperGeo, bodyMat);
    upper.position.set(0, bodyH * 0.15, bodyD * 0.05);
    upper.rotation.x = 0.12; // slight forward tilt (wedge look)
    upper.castShadow = true;
    group.add(upper);

    // Windshield (dark glass)
    const wGeo = new THREE.BoxGeometry(bodyW * 0.78, bodyH * 0.38, bodyD * 0.18);
    const wScreen = new THREE.Mesh(wGeo, new THREE.MeshStandardMaterial({ color: 0x223344, roughness: 0.05, metalness: 0.8, transparent: true, opacity: 0.7 }));
    wScreen.position.set(0, bodyH * 0.32, bodyD * 0.22);
    wScreen.rotation.x = -0.45;
    group.add(wScreen);

    // Spoiler
    const spoilerPost = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.32, 0.06), darkMat);
    [-bodyW * 0.32, bodyW * 0.32].forEach(sx => {
      const sp = spoilerPost.clone();
      sp.position.set(sx, bodyH * 0.1, -bodyD * 0.42);
      group.add(sp);
    });
    const spoilerWing = new THREE.Mesh(new THREE.BoxGeometry(bodyW * 0.9, 0.06, 0.38), bodyMat);
    spoilerWing.position.set(0, bodyH * 0.27, -bodyD * 0.42);
    group.add(spoilerWing);

    // Wheels
    const wheelR = 0.30;
    const wheelW = 0.22;
    const wheelGeo = new THREE.CylinderGeometry(wheelR, wheelR, wheelW, 18);
    wheelGeo.rotateZ(Math.PI / 2);
    const rimGeo = new THREE.CylinderGeometry(wheelR * 0.62, wheelR * 0.62, wheelW + 0.02, 10);
    rimGeo.rotateZ(Math.PI / 2);
    const wheels: THREE.Mesh[] = [];

    const wOx = bodyW / 2 + wheelW / 2 + 0.04;
    // local y so bottom of wheel = floor level (-0.35 world = -0.35 local)
    // wheelCenter_world = 0.35 + wy_local, bottom = wheelCenter_world - wheelR = 0
    // wy_local = wheelR - 0.35 = 0.30 - 0.35 = -0.05
    const wOy = wheelR - CAR_HALF_EXTENTS.y;  // -0.05
    const wOz = bodyD * 0.28;
    const wPos = [[-wOx, wOy, wOz], [wOx, wOy, wOz], [-wOx, wOy, -wOz], [wOx, wOy, -wOz]];
    for (const [px, py, pz] of wPos) {
      const w = new THREE.Mesh(wheelGeo, wheelMat);
      w.position.set(px, py, pz); w.castShadow = true; group.add(w);
      const rim = new THREE.Mesh(rimGeo, rimMat);
      rim.position.set(px, py, pz); group.add(rim);
      wheels.push(w);
    }

    // Boost flame
    const flameGeo = new THREE.ConeGeometry(0.2, 1.0, 8);
    flameGeo.rotateX(Math.PI / 2);
    flameGeo.translate(0, 0, -0.5);
    const flameMat = new THREE.MeshBasicMaterial({ color: team === "blue" ? 0x44aaff : 0xff8800, transparent: true, opacity: 0.9 });
    const flame = new THREE.Mesh(flameGeo, flameMat);
    flame.position.set(0, 0, -CAR_HALF_EXTENTS.z - 0.1);
    flame.visible = false;
    group.add(flame);

    group.userData = { wheels, flame };
    this.scene.add(group);
    this.carMeshes.set(id, group);
  }

  pushSnapshot(snap: GameSnapshot) {
    const target = snap.serverTime - performance.now() / 1000;
    this.clockOffset = this.clockOffset * 0.9 + target * 0.1;
    this.snaps.push(snap);
    if (this.snaps.length > 20) this.snaps.shift();
  }

  clearCars() {
    for (const group of this.carMeshes.values()) {
      this.scene.remove(group);
      group.traverse((child) => {
        if (child instanceof THREE.Mesh) {
          child.geometry.dispose();
          if (Array.isArray(child.material)) child.material.forEach((m) => m.dispose());
          else child.material.dispose();
        }
      });
    }
    this.carMeshes.clear();
  }

  private pickInterpolated(): GameSnapshot | null {
    if (this.snaps.length === 0) return null;
    const renderT = performance.now() / 1000 + this.clockOffset - interpDelay;
    let a = this.snaps[0]!;
    if (this.snaps.length === 1 || renderT <= a.serverTime) return a;
    for (let i = 0; i < this.snaps.length - 1; i++) {
      const s0 = this.snaps[i]!;
      const s1 = this.snaps[i + 1]!;
      if (renderT >= s0.serverTime && renderT <= s1.serverTime) {
        const span = Math.max(0.0001, s1.serverTime - s0.serverTime);
        const u = Math.max(0, Math.min(1, (renderT - s0.serverTime) / span));
        return this.blendSnapshots(s0, s1, u);
      }
      a = s1;
    }
    return a;
  }

  private blendSnapshots(s0: GameSnapshot, s1: GameSnapshot, u: number): GameSnapshot {
    this.tmpQa.set(s0.ball.rotation.x, s0.ball.rotation.y, s0.ball.rotation.z, s0.ball.rotation.w);
    this.tmpQb.set(s1.ball.rotation.x, s1.ball.rotation.y, s1.ball.rotation.z, s1.ball.rotation.w);
    this.tmpQ.copy(this.tmpQa).slerp(this.tmpQb, u);
    const ball: BallSnapshot = {
      position: {
        x: lerp(s0.ball.position.x, s1.ball.position.x, u),
        y: lerp(s0.ball.position.y, s1.ball.position.y, u),
        z: lerp(s0.ball.position.z, s1.ball.position.z, u),
      },
      rotation: { x: this.tmpQ.x, y: this.tmpQ.y, z: this.tmpQ.z, w: this.tmpQ.w },
      linVel: s1.ball.linVel,
      angVel: s1.ball.angVel,
    };

    const cars: Record<string, CarSnapshot> = { ...s1.cars };
    for (const id of new Set([...Object.keys(s0.cars), ...Object.keys(s1.cars)])) {
      const c0 = s0.cars[id];
      const c1 = s1.cars[id];
      if (!c1) continue;
      if (!c0) {
        cars[id] = c1;
        continue;
      }
      this.tmpQa.set(c0.rotation.x, c0.rotation.y, c0.rotation.z, c0.rotation.w);
      this.tmpQb.set(c1.rotation.x, c1.rotation.y, c1.rotation.z, c1.rotation.w);
      this.tmpQ.copy(this.tmpQa).slerp(this.tmpQb, u);
      cars[id] = {
        ...c1,
        position: {
          x: lerp(c0.position.x, c1.position.x, u),
          y: lerp(c0.position.y, c1.position.y, u),
          z: lerp(c0.position.z, c1.position.z, u),
        },
        rotation: { x: this.tmpQ.x, y: this.tmpQ.y, z: this.tmpQ.z, w: this.tmpQ.w },
        linVel: c1.linVel,
        angVel: c1.angVel,
        yaw: lerp(c0.yaw, c1.yaw, u),
        boost: lerp(c0.boost, c1.boost, u),
        team: c1.team,
        isBoosting: c1.isBoosting,
      };
    }
    return {
      ...s1,
      ball,
      cars,
      serverTime: lerp(s0.serverTime, s1.serverTime, u),
    };
  }

  renderFrame(localPlayerId: string | null, boost01: number) {
    const now = performance.now() / 1000;
    const dt = Math.max(0.001, Math.min(0.1, now - this.lastTime));
    this.lastTime = now;
    
    this.particles.update(dt);

    const snap = this.pickInterpolated();
    if (!snap) return;

    if (snap.phase === "goal_pause" && snap.lastGoal && snap.lastGoal.at !== this.lastGoalAt) {
      this.lastGoalAt = snap.lastGoal.at;
      const color = snap.lastGoal.team === "blue" ? 0x3399ff : 0xff8833;
      this.particles.explosion(snap.ball.position, color);
    }

    const bp = snap.ball.position;
    this.ballMesh.position.set(bp.x, bp.y, bp.z);
    this.ballMesh.quaternion.set(snap.ball.rotation.x, snap.ball.rotation.y, snap.ball.rotation.z, snap.ball.rotation.w);

    if (snap.boostPads) {
      for (let i = 0; i < this.boostPadMeshes.length; i++) {
        if (this.boostPadMeshes[i]) {
          const mat = this.boostPadMeshes[i].material as THREE.MeshBasicMaterial;
          mat.opacity = snap.boostPads[i] ? 0.8 : 0.1;
          if (snap.boostPads[i]) {
            this.boostPadMeshes[i].rotation.z += 0.02; // slowly spin when active
          }
        }
      }
    }

    const currentBallVel = new THREE.Vector3(snap.ball.linVel.x, snap.ball.linVel.y, snap.ball.linVel.z);
    if (currentBallVel.distanceTo(this.prevBallVel) > 12) {
      this.particles.spark(snap.ball.position, snap.ball.linVel);
    }
    this.prevBallVel.copy(currentBallVel);

    const spd = Math.hypot(snap.ball.linVel.x, snap.ball.linVel.z);
    if (spd > 12) {
      this.trailPos.push(new THREE.Vector3(bp.x, bp.y, bp.z));
      if (this.trailPos.length > this.maxTrail) this.trailPos.shift();
    } else if (this.trailPos.length > 0) {
      this.trailPos.shift();
    }
    if (this.trailPos.length > 1) {
      this.ballTrail.geometry.setFromPoints(this.trailPos);
      this.ballTrail.visible = true;
    } else {
      this.ballTrail.visible = false;
    }

    for (const [id, car] of Object.entries(snap.cars)) {
      this.ensureCarMesh(id, car.team);
      const group = this.carMeshes.get(id)!;
      group.position.set(car.position.x, car.position.y, car.position.z);
      group.quaternion.set(car.rotation.x, car.rotation.y, car.rotation.z, car.rotation.w);

      const { wheels, flame } = group.userData;
      const speed = Math.hypot(car.linVel.x, car.linVel.z);
      
      // Simple wheel spin based on speed
      const wheelSpin = speed * 0.05;
      // Because forward is +Z, rotating around X by positive amount rolls wheels forward
      for (const w of wheels) {
        w.rotation.x += wheelSpin;
      }

      flame.visible = car.isBoosting;
      if (car.isBoosting) {
        // dynamic flicker
        flame.scale.set(1 + Math.random() * 0.3, 1 + Math.random() * 0.5, 1 + Math.random() * 0.3);
        
        const backDir = new THREE.Vector3(-Math.sin(car.yaw), 0, -Math.cos(car.yaw));
        const emitPos = new THREE.Vector3(car.position.x, car.position.y, car.position.z).add(backDir.clone().multiplyScalar(CAR_HALF_EXTENTS.z * 1.2));
        this.particles.boostTrail(emitPos, backDir, car.team === "blue");
      }
    }



    const me = localPlayerId ? snap.cars[localPlayerId] : null;
    const ballP = new THREE.Vector3(bp.x, bp.y, bp.z);

    // RL-style camera wall constraint: pull camera in along its ray if it would clip outside arena
    const constrainCamera = (desired: THREE.Vector3, pivot: THREE.Vector3, baseFov: number): number => {
      const margin = 1.5;
      const maxX = ARENA.halfWidth  - margin;
      const maxZ = ARENA.halfLength - margin;
      const maxY = ARENA.wallHeight + 1;

      const isInside = (p: THREE.Vector3) =>
        Math.abs(p.x) <= maxX && Math.abs(p.z) <= maxZ && p.y <= maxY && p.y >= 0.5;

      if (isInside(desired)) return baseFov;

      // Binary-search to find furthest valid point on pivot→desired ray
      const dir = desired.clone().sub(pivot);
      const fullDist = dir.length();
      dir.normalize();
      let lo = 0, hi = fullDist;
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        isInside(pivot.clone().addScaledVector(dir, mid)) ? (lo = mid) : (hi = mid);
      }
      desired.copy(pivot.clone().addScaledVector(dir, lo));
      // Narrower FOV the more pulled-in we are (RL squeeze feel)
      return THREE.MathUtils.lerp(baseFov * 0.68, baseFov, lo / fullDist);
    };

    if (this.ballCam && me) {
      // RL ball cam: behind car, looking at ball
      const carPos = new THREE.Vector3(me.position.x, me.position.y, me.position.z);
      const towardCar = new THREE.Vector3().subVectors(carPos, ballP);
      const dist = towardCar.length();
      const dirNorm = dist > 0.1 ? towardCar.clone().normalize() : new THREE.Vector3(0, 0, 1);
      const desired = carPos.clone()
        .addScaledVector(dirNorm, Math.min(dist * 0.5 + 4, 14))
        .add(new THREE.Vector3(0, 6.5, 0));
      const fov = constrainCamera(desired, carPos, 68);
      this.camera.position.lerp(desired, 0.1);
      this.camera.lookAt(ballP);
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, fov, 0.1);
      this.camera.updateProjectionMatrix();
    } else if (this.ballCam) {
      const desired = ballP.clone().add(new THREE.Vector3(0, 10, 18));
      constrainCamera(desired, ballP, 68);
      this.camera.position.lerp(desired, 0.1);
      this.camera.lookAt(ballP);
    } else if (me) {
      const p = new THREE.Vector3(me.position.x, me.position.y, me.position.z);
      const yaw = me.yaw;
      const baseDist = 14 + boost01 * 4;
      const baseHeight = 6 + boost01 * 2;
      const desired = new THREE.Vector3(
        p.x - Math.sin(yaw) * baseDist,
        p.y + baseHeight,
        p.z - Math.cos(yaw) * baseDist,
      );
      const baseFov = 58 + boost01 * 10;
      const fov = constrainCamera(desired, p, baseFov);
      this.camera.position.lerp(desired, 0.12);
      this.camera.lookAt(new THREE.Vector3(p.x, p.y + 1.2, p.z));
      this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, fov, 0.1);
      this.camera.updateProjectionMatrix();
    } else {
      this.camera.position.lerp(new THREE.Vector3(0, 28, 42), 0.04);
      this.camera.lookAt(0, 0, 0);
    }

    this.renderer.render(this.scene, this.camera);
  }

  startLoop(localPlayerId: () => string | null, boost: () => number) {
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.renderFrame(localPlayerId(), boost());
    };
    this.raf = requestAnimationFrame(loop);
  }

  stopLoop() {
    cancelAnimationFrame(this.raf);
  }

  private onResize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }
}
