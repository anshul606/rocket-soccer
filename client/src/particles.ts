import * as THREE from 'three';

const MAX_PARTICLES = 5000;

export class ParticleSystem {
  public mesh: THREE.Points;
  private positions: Float32Array;
  private colors: Float32Array;
  private sizes: Float32Array;
  private velocities: THREE.Vector3[];
  private lifespans: Float32Array;
  private maxLifespans: Float32Array;
  private activeCount = 0;

  constructor(scene: THREE.Scene) {
    const geo = new THREE.BufferGeometry();
    this.positions = new Float32Array(MAX_PARTICLES * 3);
    this.colors = new Float32Array(MAX_PARTICLES * 3);
    this.sizes = new Float32Array(MAX_PARTICLES);
    this.velocities = Array.from({ length: MAX_PARTICLES }, () => new THREE.Vector3());
    this.lifespans = new Float32Array(MAX_PARTICLES);
    this.maxLifespans = new Float32Array(MAX_PARTICLES);

    geo.setAttribute('position', new THREE.BufferAttribute(this.positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(this.colors, 3));
    geo.setAttribute('size', new THREE.BufferAttribute(this.sizes, 1));

    const mat = new THREE.ShaderMaterial({
      uniforms: {
        time: { value: 0 }
      },
      vertexShader: `
        attribute float size;
        attribute vec3 color;
        varying vec3 vColor;
        void main() {
          vColor = color;
          vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = size * (300.0 / -mvPosition.z);
          gl_Position = projectionMatrix * mvPosition;
        }
      `,
      fragmentShader: `
        varying vec3 vColor;
        void main() {
          float d = distance(gl_PointCoord, vec2(0.5));
          if (d > 0.5) discard;
          gl_FragColor = vec4(vColor, 1.0 - (d * 2.0));
        }
      `,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false
    });

    this.mesh = new THREE.Points(geo, mat);
    scene.add(this.mesh);
  }

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, size: number, life: number) {
    if (this.activeCount >= MAX_PARTICLES) return;
    const i = this.activeCount;
    this.positions[i * 3] = x;
    this.positions[i * 3 + 1] = y;
    this.positions[i * 3 + 2] = z;
    this.velocities[i].set(vx, vy, vz);
    this.colors[i * 3] = r;
    this.colors[i * 3 + 1] = g;
    this.colors[i * 3 + 2] = b;
    this.sizes[i] = size;
    this.lifespans[i] = life;
    this.maxLifespans[i] = life;
    this.activeCount++;
  }

  explosion(pos: { x: number, y: number, z: number }, colorHex: number) {
    const r = ((colorHex >> 16) & 255) / 255;
    const g = ((colorHex >> 8) & 255) / 255;
    const b = (colorHex & 255) / 255;
    
    for (let i = 0; i < 200; i++) {
      const vx = (Math.random() - 0.5) * 40;
      const vy = (Math.random() - 0.5) * 40 + 10;
      const vz = (Math.random() - 0.5) * 40;
      this.spawn(pos.x, pos.y, pos.z, vx, vy, vz, r, g, b, 4.0 + Math.random() * 4.0, 0.5 + Math.random() * 0.5);
    }
  }

  spark(pos: { x: number, y: number, z: number }, vel: { x: number, y: number, z: number }) {
    for (let i = 0; i < 15; i++) {
      const vx = vel.x * 0.3 + (Math.random() - 0.5) * 10;
      const vy = vel.y * 0.3 + (Math.random() - 0.5) * 10 + 5;
      const vz = vel.z * 0.3 + (Math.random() - 0.5) * 10;
      this.spawn(pos.x, pos.y, pos.z, vx, vy, vz, 1, 1, 0.8, 2.0, 0.2 + Math.random() * 0.3);
    }
  }

  boostTrail(pos: { x: number, y: number, z: number }, dir: { x: number, y: number, z: number }, isBlue: boolean) {
    const r = isBlue ? 0.2 : 1.0;
    const g = isBlue ? 0.6 : 0.4;
    const b = isBlue ? 1.0 : 0.1;
    
    for (let i = 0; i < 3; i++) {
      const vx = dir.x * -10 + (Math.random() - 0.5) * 2;
      const vy = dir.y * -10 + (Math.random() - 0.5) * 2;
      const vz = dir.z * -10 + (Math.random() - 0.5) * 2;
      this.spawn(pos.x, pos.y, pos.z, vx, vy, vz, r, g, b, 3.0, 0.3);
    }
  }

  update(dt: number) {
    let i = 0;
    while (i < this.activeCount) {
      this.lifespans[i] -= dt;
      if (this.lifespans[i] <= 0) {
        const last = this.activeCount - 1;
        this.positions[i * 3] = this.positions[last * 3];
        this.positions[i * 3 + 1] = this.positions[last * 3 + 1];
        this.positions[i * 3 + 2] = this.positions[last * 3 + 2];
        this.velocities[i].copy(this.velocities[last]);
        this.colors[i * 3] = this.colors[last * 3];
        this.colors[i * 3 + 1] = this.colors[last * 3 + 1];
        this.colors[i * 3 + 2] = this.colors[last * 3 + 2];
        this.sizes[i] = this.sizes[last];
        this.lifespans[i] = this.lifespans[last];
        this.maxLifespans[i] = this.maxLifespans[last];
        this.activeCount--;
      } else {
        this.positions[i * 3] += this.velocities[i].x * dt;
        this.positions[i * 3 + 1] += this.velocities[i].y * dt;
        this.positions[i * 3 + 2] += this.velocities[i].z * dt;
        this.velocities[i].y -= 25 * dt;
        
        const lifeRatio = this.lifespans[i] / this.maxLifespans[i];
        this.sizes[i] *= lifeRatio;

        i++;
      }
    }
    
    // Only update the range of active particles
    const posAttr = this.mesh.geometry.attributes.position as THREE.BufferAttribute;
    const colAttr = this.mesh.geometry.attributes.color as THREE.BufferAttribute;
    const sizeAttr = this.mesh.geometry.attributes.size as THREE.BufferAttribute;
    
    posAttr.needsUpdate = true;
    colAttr.needsUpdate = true;
    sizeAttr.needsUpdate = true;
  }
}
