import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  DIMS,
  TOOL_LENGTH,
  forwardKinematics,
  solveIK,
  solveReachable,
  wrapAngle,
  type Config,
  type Nullspace,
} from './kinematics';
import { buildPalette, type MaterialSpec } from './themes';

export type ToolName = keyof typeof TOOL_LENGTH;

export interface RobotState {
  joints: [number, number, number, number]; // radians: yaw, shoulder, elbow, wrist
  phi: number;
  elbowUp: boolean;
}

const HOME_TARGET = new THREE.Vector3(1.9, 1.3, 0.9);
const HOME_NS: Nullspace = { phi: (-20 * Math.PI) / 180, elbowUp: true };
const TWEEN_MS = 380;
const MIN_TIP_HEIGHT = 0.06;

const HANDLE_IDLE = new THREE.Color('#8a93a3');
const HANDLE_HOVER = new THREE.Color('#ffb020');
const HANDLE_BLOCKED = new THREE.Color('#d9480f');
const RING_RADIUS = 0.24;
const PITCH_SNAP = (15 * Math.PI) / 180;

type Grab = 'move' | 'rotate';

export class RobotScene {
  onChange?: (s: RobotState) => void;
  /** Called when a ring rotation is refused because that pitch would move the tip. */
  onBlocked?: () => void;

  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(35, 1, 0.1, 100);
  private controls: OrbitControls;
  private width = 1;
  private height = 1;

  private mats = {
    link: new THREE.MeshStandardMaterial(),
    joint: new THREE.MeshStandardMaterial(),
    accent: new THREE.MeshStandardMaterial(),
  };

  // Kinematic chain
  private yawG = new THREE.Group();
  private shoulderG = new THREE.Group();
  private elbowG = new THREE.Group();
  private wristG = new THREE.Group();
  private tip = new THREE.Object3D();
  private tools: Record<ToolName, THREE.Group> = { gripper: new THREE.Group(), finger: new THREE.Group() };
  private ground: THREE.Mesh;

  // Drag handle
  private handle: THREE.Mesh<THREE.TorusGeometry, THREE.MeshBasicMaterial>;
  private hitTargets: THREE.Object3D[] = [];
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private dragPlane = new THREE.Plane();
  private grabOffset = new THREE.Vector3();
  private dragging: Grab | null = null;
  // Ring rotation: pitch at grab time, accumulated screen angle, and its sign.
  private rot = { phi0: 0, lastAngle: 0, total: 0, sign: 1, steps: 0 };

  // Kinematic state
  private target = HOME_TARGET.clone();
  private ns: Nullspace = { ...HOME_NS };
  private baseYaw = 0;
  private config: Config;
  private shown: Config;
  private tween: { from: Config; t0: number } | null = null;

  private raf = 0;
  private resizeObserver: ResizeObserver;
  private pmrem: THREE.PMREMGenerator;
  private keyLight!: THREE.DirectionalLight;

  constructor(private container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);

    this.pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = this.pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.camera.position.set(4.6, 3.3, 5.8);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.target.set(0.7, 1.15, 0.2);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;
    this.controls.minDistance = 2.5;
    this.controls.maxDistance = 20;
    this.controls.update();

    this.addLights();
    this.ground = this.addGround();
    this.buildRobot();
    this.handle = this.buildHandle();

    this.config = solveIK(this.target, this.ns)!;
    this.baseYaw = this.config.yaw;
    this.shown = { ...this.config };
    this.applyPose(this.shown);

    container.addEventListener('pointerdown', this.onPointerDown, { capture: true });
    container.addEventListener('pointermove', this.onHover);
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();

    this.loop();
    queueMicrotask(() => this.emit());
  }

  // ---------------------------------------------------------------- public API

  setTheme(hex: string) {
    const p = buildPalette(hex);
    const apply = (m: THREE.MeshStandardMaterial, s: MaterialSpec) => {
      m.color.copy(s.color);
      m.roughness = s.roughness;
      m.metalness = s.metalness;
    };
    apply(this.mats.link, p.link);
    apply(this.mats.joint, p.joint);
    apply(this.mats.accent, p.accent);
  }

  /** Swap the tool. Joints stay put; the IK target follows the new tip. */
  setTool(name: ToolName) {
    for (const [k, g] of Object.entries(this.tools)) g.visible = k === name;
    DIMS.L3 = TOOL_LENGTH[name];
    this.tip.position.x = DIMS.L3;
    forwardKinematics(this.config, this.target);
  }

  setShadow(on: boolean) {
    this.ground.visible = on;
  }

  /** Move along the continuous nullspace. Returns false if that pitch can't hold the tip here. */
  setPhi(phi: number) {
    const ns = { ...this.ns, phi: wrapAngle(phi) };
    const c = solveIK(this.target, ns, this.baseYaw);
    if (!c) return false;
    this.ns = ns;
    this.setConfig(c, false);
    return true;
  }

  nudgePhi(delta: number) {
    return this.setPhi(this.ns.phi + delta);
  }

  setElbowUp(up: boolean) {
    if (up === this.ns.elbowUp) return;
    this.switchBranch({ ...this.ns, elbowUp: up });
  }

  reset() {
    this.target.copy(HOME_TARGET);
    this.ns = { ...HOME_NS };
    this.setConfig(solveIK(this.target, this.ns)!, true);
  }

  /** Tip position and nullspace choice: enough to reproduce the pose exactly. */
  getPose() {
    return { target: this.target.clone(), ns: { ...this.ns } };
  }

  /**
   * Pose the arm from a tip position and nullspace choice (e.g. from a share link).
   * Like a drag, an unreachable target or pitch is pulled to the nearest valid one.
   */
  setPose(target: THREE.Vector3, ns: Nullspace) {
    const p = target.clone();
    p.y = Math.max(p.y, MIN_TIP_HEIGHT);
    const res = solveReachable(p, ns, this.baseYaw);
    if (!res) return false;
    this.ns = { elbowUp: ns.elbowUp, phi: res.phi };
    forwardKinematics(res.config, this.target);
    this.setConfig(res.config, false);
    return true;
  }

  getView() {
    return { camPos: this.camera.position.clone(), camTarget: this.controls.target.clone() };
  }

  setView(camPos: THREE.Vector3, camTarget: THREE.Vector3) {
    this.camera.position.copy(camPos);
    this.controls.target.copy(camTarget);
    this.controls.update();
  }

  /**
   * Export a transparent PNG.
   * - trim off: the full view at `scale`× the viewport size (same framing as on screen).
   * - trim on: the robot's own region, rendered at the resolution it would have if it
   *   filled the viewport, times `scale`. Camera angle and perspective are unchanged,
   *   so zooming out to position against a reference image doesn't cost sharpness.
   */
  async exportPNG(scale: number, trim: boolean): Promise<Blob> {
    const r = this.renderer;
    const prevRatio = r.getPixelRatio();
    const max = Math.min(r.capabilities.maxTextureSize, 8192);
    const W = this.width;
    const H = this.height;

    this.handle.visible = false;
    this.setShadowMapSize(4096);
    let out: HTMLCanvasElement;
    try {
      if (!trim) {
        const ratio = Math.min(scale, max / W, max / H);
        out = this.renderRegion(W * ratio, H * ratio);
      } else {
        // Pass 1: find the robot + shadow footprint at screen resolution.
        const probe = this.renderRegion(W, H);
        const box = alphaBounds(probe);
        if (!box) {
          out = probe;
        } else {
          // Generous margin, so the final tight trim below has room for its padding.
          // The region may extend past the viewport edges; the frustum handles that.
          const m = Math.max(box.w, box.h) * 0.08 + 4;
          const view = { x: box.x - m, y: box.y - m, w: box.w + 2 * m, h: box.h + 2 * m };
          // Pass 2: render just that region as if it filled the viewport, times scale.
          const k = Math.min(Math.min(W / view.w, H / view.h) * scale, max / view.w, max / view.h);
          out = trimTransparent(this.renderRegion(view.w * k, view.h * k, view));
        }
      }
    } finally {
      this.handle.visible = true;
      this.setShadowMapSize(2048);
      this.camera.clearViewOffset();
      r.setPixelRatio(prevRatio);
      r.setSize(W, H, false);
    }

    return new Promise((resolve, reject) =>
      out.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG encoding failed'))), 'image/png'),
    );
  }

  /** Render `view` (a rectangle in viewport CSS px; default: all of it) into a new w×h canvas. */
  private renderRegion(w: number, h: number, view?: { x: number; y: number; w: number; h: number }) {
    const r = this.renderer;
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    r.setPixelRatio(1);
    r.setSize(w, h, false);
    if (view) this.camera.setViewOffset(this.width, this.height, view.x, view.y, view.w, view.h);
    else this.camera.clearViewOffset();
    r.render(this.scene, this.camera);

    // Copy synchronously, before the WebGL drawing buffer is cleared.
    const out = document.createElement('canvas');
    out.width = w;
    out.height = h;
    out.getContext('2d')!.drawImage(r.domElement, 0, 0);
    return out;
  }

  private setShadowMapSize(size: number) {
    const shadow = this.keyLight.shadow;
    if (shadow.mapSize.x === size) return;
    shadow.mapSize.set(size, size);
    shadow.map?.dispose();
    shadow.map = null; // reallocated at the new size on the next render
  }

  exportSize(scale: number) {
    const ratio = Math.min(scale, 8192 / this.width, 8192 / this.height);
    return { w: Math.round(this.width * ratio), h: Math.round(this.height * ratio) };
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.resizeObserver.disconnect();
    this.container.removeEventListener('pointerdown', this.onPointerDown, { capture: true });
    this.container.removeEventListener('pointermove', this.onHover);
    this.endDrag();
    this.controls.dispose();
    this.scene.traverse((o) => {
      if (o instanceof THREE.Mesh) o.geometry.dispose();
    });
    Object.values(this.mats).forEach((m) => m.dispose());
    this.handle.material.dispose();
    this.scene.environment?.dispose();
    this.pmrem.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // ---------------------------------------------------------------- scene build

  private addLights() {
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9098a4, 0.9));

    const key = (this.keyLight = new THREE.DirectionalLight(0xffffff, 2.4));
    key.position.set(4, 8, 5);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const sc = key.shadow.camera;
    sc.left = sc.bottom = -4.5;
    sc.right = sc.top = 4.5;
    sc.near = 1;
    sc.far = 25;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    key.shadow.radius = 4;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.7);
    fill.position.set(-6, 3, -2);
    this.scene.add(fill);
  }

  private addGround() {
    const ground = new THREE.Mesh(
      new THREE.PlaneGeometry(30, 30),
      new THREE.ShadowMaterial({ opacity: 0.16 }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    this.scene.add(ground);
    return ground;
  }

  private buildRobot() {
    const { link, joint, accent } = this.mats;
    const { H0, L1, L2 } = DIMS;

    const mesh = (geo: THREE.BufferGeometry, mat: THREE.Material, parent: THREE.Object3D) => {
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      parent.add(m);
      return m;
    };
    // Cylinders with their axis along Z (pitch joints) or X (wrist link).
    const cylZ = (r: number, len: number) => new THREE.CylinderGeometry(r, r, len, 48).rotateX(Math.PI / 2);
    const cylX = (r: number, len: number) => new THREE.CylinderGeometry(r, r, len, 40).rotateZ(Math.PI / 2);
    const actuator = (parent: THREE.Object3D, r: number, len: number) => {
      mesh(cylZ(r, len), joint, parent);
      for (const s of [-1, 1]) {
        mesh(cylZ(r * 0.68, 0.025), accent, parent).position.z = s * (len / 2 + 0.01);
        mesh(cylZ(r * 1.02, 0.02), accent, parent).position.z = s * (len / 2 - 0.05);
      }
    };

    // Static base
    mesh(new THREE.CylinderGeometry(0.64, 0.68, 0.1, 64), accent, this.scene).position.y = 0.05;

    // Yaw stage
    this.scene.add(this.yawG);
    mesh(new THREE.CylinderGeometry(0.42, 0.42, 0.1, 64), joint, this.yawG).position.y = 0.15;
    mesh(new THREE.CylinderGeometry(0.43, 0.43, 0.018, 64), accent, this.yawG).position.y = 0.205;
    // Column stops just below the shoulder actuator; a narrower neck carries it,
    // so the joint sits on top of the column instead of sinking into it.
    const colTop = H0 - 0.24;
    mesh(new THREE.CylinderGeometry(0.3, 0.36, colTop - 0.2, 48), link, this.yawG).position.y = 0.2 + (colTop - 0.2) / 2;
    mesh(new THREE.CylinderGeometry(0.31, 0.31, 0.02, 48), accent, this.yawG).position.y = colTop;
    mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.2, 32), joint, this.yawG).position.y = colTop + 0.1;

    // Shoulder + upper arm
    this.shoulderG.position.y = H0;
    this.yawG.add(this.shoulderG);
    actuator(this.shoulderG, 0.25, 0.5);
    mesh(new RoundedBoxGeometry(L1, 0.28, 0.3, 4, 0.1), link, this.shoulderG).position.x = L1 / 2;

    // Elbow + forearm
    this.elbowG.position.x = L1;
    this.shoulderG.add(this.elbowG);
    actuator(this.elbowG, 0.2, 0.42);
    mesh(new RoundedBoxGeometry(L2, 0.22, 0.24, 4, 0.08), link, this.elbowG).position.x = L2 / 2;

    // Wrist + gripper
    this.wristG.position.x = L2;
    this.elbowG.add(this.wristG);
    actuator(this.wristG, 0.15, 0.32);
    mesh(cylX(0.1, 0.22), link, this.wristG).position.x = 0.11;
    mesh(cylX(0.13, 0.04), joint, this.wristG).position.x = 0.24;

    // Tools: each ends exactly at its TOOL_LENGTH, which setTool copies into L3.
    const { gripper, finger } = this.tools;
    this.wristG.add(gripper, finger);
    finger.visible = false;

    this.hitTargets.push(mesh(new RoundedBoxGeometry(0.08, 0.28, 0.15, 2, 0.02), accent, gripper));
    gripper.children[0].position.x = 0.3;
    for (const s of [-1, 1]) {
      const f = mesh(new RoundedBoxGeometry(0.18, 0.04, 0.1, 2, 0.015), accent, gripper);
      f.position.set(0.43, s * 0.1, 0);
      this.hitTargets.push(f);
    }

    // Tapered mount, collar, shaft, then a rounded pad ending at x = 0.72.
    mesh(new THREE.CylinderGeometry(0.09, 0.065, 0.08, 40).rotateZ(Math.PI / 2), accent, finger).position.x = 0.3;
    mesh(cylX(0.07, 0.02), joint, finger).position.x = 0.35;
    const shaft = mesh(new THREE.CylinderGeometry(0.055, 0.042, 0.32, 32).rotateZ(Math.PI / 2), accent, finger);
    shaft.position.x = 0.52;
    mesh(new THREE.SphereGeometry(0.042, 32, 16), joint, finger).position.x = 0.678;
    this.hitTargets.push(shaft);
    this.tip.position.x = DIMS.L3;
    this.wristG.add(this.tip);
  }

  private buildHandle() {
    const handle = new THREE.Mesh(
      new THREE.TorusGeometry(RING_RADIUS, 0.014, 12, 72),
      new THREE.MeshBasicMaterial({
        color: HANDLE_IDLE,
        transparent: true,
        opacity: 0.9,
        depthTest: false,
        toneMapped: false,
      }),
    );
    handle.renderOrder = 999;
    this.scene.add(handle);
    return handle;
  }

  // ---------------------------------------------------------------- kinematics

  private applyPose(c: Config) {
    this.yawG.rotation.y = c.yaw;
    this.shoulderG.rotation.z = c.q1;
    this.elbowG.rotation.z = c.q2;
    this.wristG.rotation.z = c.q3;
  }

  private setConfig(c: Config, animate: boolean) {
    this.tween = animate ? { from: { ...this.shown }, t0: performance.now() } : null;
    this.config = c;
    this.baseYaw = c.yaw;
    if (!animate) {
      this.shown = { ...c };
      this.applyPose(c);
    }
    this.emit();
  }

  private switchBranch(ns: Nullspace) {
    const c = solveIK(this.target, ns, this.baseYaw);
    if (!c) return;
    this.ns = ns;
    this.setConfig(c, true);
  }

  private dragTo(p: THREE.Vector3) {
    p.y = Math.max(p.y, MIN_TIP_HEIGHT);
    const res = solveReachable(p, this.ns, this.baseYaw);
    if (!res) return;
    this.ns.phi = res.phi;
    forwardKinematics(res.config, this.target);
    this.setConfig(res.config, false);
  }

  private stepTween(now: number) {
    if (!this.tween) return;
    const t = Math.min(1, (now - this.tween.t0) / TWEEN_MS);
    const e = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const { from } = this.tween;
    const lerpA = (a: number, b: number) => a + wrapAngle(b - a) * e;
    this.shown = {
      yaw: lerpA(from.yaw, this.config.yaw),
      q1: lerpA(from.q1, this.config.q1),
      q2: lerpA(from.q2, this.config.q2),
      q3: lerpA(from.q3, this.config.q3),
    };
    this.applyPose(this.shown);
    if (t >= 1) this.tween = null;
  }

  private emit() {
    const c = this.config;
    this.onChange?.({
      joints: [c.yaw, c.q1, c.q2, c.q3],
      phi: this.ns.phi,
      elbowUp: this.ns.elbowUp,
    });
  }

  // ---------------------------------------------------------------- interaction

  private setRay(e: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
  }

  /** The ring's centre and radius in canvas CSS px (y down). */
  private ringOnScreen() {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const toPx = (v: THREE.Vector3) => {
      v.project(this.camera);
      return { x: ((v.x + 1) / 2) * rect.width, y: ((1 - v.y) / 2) * rect.height };
    };
    const tip = this.tip.getWorldPosition(new THREE.Vector3());
    const right = new THREE.Vector3().setFromMatrixColumn(this.camera.matrixWorld, 0);
    const c = toPx(tip.clone());
    const edge = toPx(tip.addScaledVector(right, RING_RADIUS));
    return { rect, x: c.x, y: c.y, r: Math.hypot(edge.x - c.x, edge.y - c.y) };
  }

  /** What a press at this point would grab: the ring's edge rotates, inside it (or the tool) moves. */
  private grabAt(e: PointerEvent): Grab | null {
    const ring = this.ringOnScreen();
    const d = Math.hypot(e.clientX - ring.rect.left - ring.x, e.clientY - ring.rect.top - ring.y);
    const band = Math.max(7, ring.r * 0.22);
    if (Math.abs(d - ring.r) <= band) return 'rotate';
    if (d < ring.r) return 'move';
    this.setRay(e);
    return this.raycaster.intersectObjects(this.hitTargets, false).length > 0 ? 'move' : null;
  }

  /** Pointer angle around the ring centre, counter-clockwise on screen. */
  private ringAngle(e: PointerEvent) {
    const ring = this.ringOnScreen();
    return Math.atan2(-(e.clientY - ring.rect.top - ring.y), e.clientX - ring.rect.left - ring.x);
  }

  // Registered in the capture phase on the container, so it runs before
  // OrbitControls sees the event on the canvas and can swallow it.
  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    const grab = this.grabAt(e);
    if (!grab) return;
    e.stopPropagation();
    e.preventDefault();
    this.dragging = grab;
    this.tween = null;

    if (grab === 'rotate') {
      // Pitch turns about the arm plane's normal. Seen from that normal's side, a
      // counter-clockwise screen drag is a positive pitch change; from behind, negative.
      const tipWorld = this.tip.getWorldPosition(new THREE.Vector3());
      const normal = new THREE.Vector3(0, 0, 1).applyQuaternion(this.yawG.getWorldQuaternion(new THREE.Quaternion()));
      const toCam = this.camera.position.clone().sub(tipWorld);
      const a = this.ringAngle(e);
      this.rot = { phi0: this.ns.phi, lastAngle: a, total: 0, sign: normal.dot(toCam) >= 0 ? 1 : -1, steps: 0 };
      this.container.style.cursor = 'grabbing';
    } else {
      this.setRay(e);
      const tipWorld = this.tip.getWorldPosition(new THREE.Vector3());
      const normal = this.camera.getWorldDirection(new THREE.Vector3());
      this.dragPlane.setFromNormalAndCoplanarPoint(normal, tipWorld);
      const hit = new THREE.Vector3();
      if (this.raycaster.ray.intersectPlane(this.dragPlane, hit)) this.grabOffset.subVectors(tipWorld, hit);
      else this.grabOffset.set(0, 0, 0);
      this.container.style.cursor = 'move';
    }

    this.handle.material.color.copy(grab === 'rotate' ? HANDLE_HOVER : HANDLE_IDLE);
    window.addEventListener('pointermove', this.onDragMove);
    window.addEventListener('pointerup', this.endDrag);
    window.addEventListener('pointercancel', this.endDrag);
  };

  private onDragMove = (e: PointerEvent) => {
    if (this.dragging === 'rotate') {
      const a = this.ringAngle(e);
      this.rot.total += wrapAngle(a - this.rot.lastAngle); // accumulate, so full turns work
      this.rot.lastAngle = a;
      const steps = Math.round((this.rot.total * this.rot.sign) / PITCH_SNAP);
      if (steps === this.rot.steps) return;
      if (this.setPhi(this.rot.phi0 + steps * PITCH_SNAP)) {
        this.rot.steps = steps;
        this.handle.material.color.copy(HANDLE_HOVER);
      } else {
        this.handle.material.color.copy(HANDLE_BLOCKED);
        this.onBlocked?.();
      }
      return;
    }
    this.setRay(e);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(this.dragPlane, p)) return;
    this.dragTo(p.add(this.grabOffset));
  };

  private endDrag = () => {
    if (!this.dragging) return;
    this.dragging = null;
    this.container.style.cursor = '';
    this.handle.material.color.copy(HANDLE_IDLE);
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.endDrag);
    window.removeEventListener('pointercancel', this.endDrag);
  };

  private onHover = (e: PointerEvent) => {
    if (this.dragging || e.buttons !== 0) return;
    const grab = this.grabAt(e);
    this.container.style.cursor = grab === 'rotate' ? 'grab' : grab === 'move' ? 'move' : '';
    this.handle.material.color.copy(grab === 'rotate' ? HANDLE_HOVER : HANDLE_IDLE);
  };

  // ---------------------------------------------------------------- loop

  private resize() {
    this.width = Math.max(1, this.container.clientWidth);
    this.height = Math.max(1, this.container.clientHeight);
    this.renderer.setSize(this.width, this.height);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();
  }

  private loop = () => {
    this.raf = requestAnimationFrame(this.loop);
    this.stepTween(performance.now());
    this.controls.update();
    this.tip.updateWorldMatrix(true, false);
    this.tip.getWorldPosition(this.handle.position);
    this.handle.quaternion.copy(this.camera.quaternion);
    this.renderer.render(this.scene, this.camera);
  };
}

/** Bounding box of pixels with visible alpha, or null if the canvas is empty. */
function alphaBounds(src: HTMLCanvasElement) {
  const { width: w, height: h } = src;
  const data = src.getContext('2d')!.getImageData(0, 0, w, h).data;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (data[row + x * 4 + 3] > 4) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** Crop a canvas to its non-transparent pixels, with a little padding. */
function trimTransparent(src: HTMLCanvasElement): HTMLCanvasElement {
  const box = alphaBounds(src);
  if (!box) return src;
  const pad = Math.round(Math.max(box.w, box.h) * 0.04);
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  const out = document.createElement('canvas');
  out.width = Math.min(src.width, box.x + box.w + pad) - x;
  out.height = Math.min(src.height, box.y + box.h + pad) - y;
  out.getContext('2d')!.drawImage(src, x, y, out.width, out.height, 0, 0, out.width, out.height);
  return out;
}
