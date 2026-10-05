/**
 * 3D view of a FloorPlan (three.js). Rooms, walls, cubicles, furniture and the outdoors are built
 * once per plan structure; people, curtains, monitors and the ambulance's lights update every
 * frame. Reads the plan and the crowd only: no sim logic.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { acuityColor, css, inkOn, roleColor, roleLetter } from './draw';
import type { Area, Bay, BedMark, FloorPlan, Prop } from './floorPlan';
import type { Actor } from './motion';

/** Metres per plan unit: plans for the 3D view use 20 units per metre. */
export const PLAN_SCALE = 1 / 20;
const S = PLAN_SCALE;
const WALL_H = 1.05;
const WALL_T = 0.12;
const BED_TOP = 0.62;
const GURNEY_TOP = 0.82;
const BADGE_SIZE = 0.027;
const SKIN = ['#f1c7a5', '#e3b08c', '#c68a61', '#8d5a3b', '#5c3a24'];
const HAIR = ['#2b211c', '#5a3a22', '#a67c52', '#1b1b1b', '#8c8c8c', '#c9a15a'];
const CLOTHES = ['#56607a', '#8a4b4b', '#4f7a5a', '#7a6a4f', '#3f5f8a', '#6b4f7a', '#9a7b3c', '#40606a', '#b0563f', '#5a5a5a'];
const TROUSERS = ['#2f3a4f', '#4a4038', '#2e3a30', '#3d4661', '#555555'];

/** What the pointer is over, for a tooltip. */
export interface Picked {
  key: string;
  x: number;
  y: number;
}

/** Shared geometry for people, built on first use. */
let geo: ReturnType<typeof buildGeometry> | null = null;
function buildGeometry() {
  const leg = new THREE.BoxGeometry(0.13, 0.8, 0.15);
  leg.translate(0, -0.4, 0);
  const arm = new THREE.BoxGeometry(0.09, 0.58, 0.1);
  arm.translate(0, -0.29, 0);
  const ring = new THREE.RingGeometry(0.4, 0.5, 28);
  ring.rotateX(-Math.PI / 2);
  return {
    torso: new THREE.CapsuleGeometry(0.17, 0.34, 4, 10),
    head: new THREE.SphereGeometry(0.12, 14, 10),
    hair: new THREE.SphereGeometry(0.127, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2.2),
    longHair: new THREE.BoxGeometry(0.24, 0.3, 0.08),
    leg,
    arm,
    ring,
    coat: new THREE.CylinderGeometry(0.2, 0.25, 0.86, 12, 1, true),
    stetho: new THREE.TorusGeometry(0.12, 0.012, 6, 16, Math.PI * 1.3),
    blanket: new THREE.BoxGeometry(0.44, 0.95, 0.14),
    band: new THREE.CylinderGeometry(0.18, 0.18, 0.06, 12),
  };
}

class Figure {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly legs: THREE.Group[] = [];
  readonly arms: THREE.Group[] = [];
  readonly badge = new THREE.Sprite();
  readonly ring: THREE.Mesh;
  readonly torso: THREE.Mesh;
  readonly head: THREE.Mesh;
  readonly hair: THREE.Mesh;
  readonly longHair: THREE.Mesh;
  readonly coat: THREE.Mesh;
  readonly stetho: THREE.Mesh;
  readonly blanket: THREE.Mesh;
  readonly gurney: THREE.Group;
  /** Whoever pushes the trolley: a paramedic bringing a casualty in, or a porter taking an admission up. */
  readonly porter = new THREE.Group();
  private readonly porterLegs: THREE.Group[] = [];
  private readonly porterArms: THREE.Group[] = [];
  private porterKind = '';
  heading = 0;
  lying = 0;
  sitting = 0;
  styleKey = '';

  constructor(private readonly scene: Scene3D) {
    const g = (geo ??= buildGeometry());
    this.root.add(this.body);
    this.torso = new THREE.Mesh(g.torso);
    this.torso.position.y = 1.2;
    this.head = new THREE.Mesh(g.head);
    this.head.position.y = 1.68;
    this.hair = new THREE.Mesh(g.hair);
    this.hair.position.y = 1.7;
    this.longHair = new THREE.Mesh(g.longHair);
    this.longHair.position.set(0, 1.58, -0.09);
    this.coat = new THREE.Mesh(g.coat);
    this.coat.position.y = 1.07;
    this.stetho = new THREE.Mesh(g.stetho);
    this.stetho.position.set(0, 1.42, 0.1);
    this.stetho.rotation.set(0.35, 0, Math.PI * 1.15);
    this.blanket = new THREE.Mesh(g.blanket);
    this.blanket.position.set(0, 0.55, 0.12);
    this.body.add(this.torso, this.head, this.hair, this.longHair, this.coat, this.stetho, this.blanket);
    for (const side of [-1, 1]) {
      const legPivot = new THREE.Group();
      legPivot.position.set(side * 0.09, 0.85, 0);
      legPivot.add(new THREE.Mesh(g.leg));
      const armPivot = new THREE.Group();
      armPivot.position.set(side * 0.24, 1.46, 0);
      armPivot.rotation.z = side * 0.06;
      armPivot.add(new THREE.Mesh(g.arm));
      this.legs.push(legPivot);
      this.arms.push(armPivot);
      this.body.add(legPivot, armPivot);
    }
    this.body.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    this.badge.renderOrder = 10;
    this.badge.scale.set(BADGE_SIZE, BADGE_SIZE, 1);
    this.ring = new THREE.Mesh(g.ring);
    this.ring.position.y = 0.035;
    this.gurney = scene.gurney();
    this.gurney.visible = false;
    this.buildPorter(g);
    this.root.add(this.badge, this.ring, this.gurney, this.porter);
  }

  private buildPorter(g: NonNullable<typeof geo>) {
    const torso = new THREE.Mesh(g.torso);
    torso.position.y = 1.2;
    const head = new THREE.Mesh(g.head);
    head.position.y = 1.68;
    const hair = new THREE.Mesh(g.hair);
    hair.position.y = 1.7;
    const stripe = new THREE.Mesh(g.band);
    stripe.position.y = 1.12;
    this.porter.add(torso, head, hair, stripe);
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.09, 0.85, 0);
      leg.add(new THREE.Mesh(g.leg));
      const arm = new THREE.Group();
      arm.position.set(side * 0.24, 1.46, 0);
      arm.rotation.x = -1.15; // hands forward on the trolley rail
      arm.add(new THREE.Mesh(g.arm));
      this.porterLegs.push(leg);
      this.porterArms.push(arm);
      this.porter.add(leg, arm);
    }
    this.porter.traverse((o) => {
      if (o instanceof THREE.Mesh) o.castShadow = true;
    });
    // Behind the foot of the trolley, facing the way it goes.
    this.porter.position.z = 1.38;
    this.porter.rotation.y = Math.PI;
    this.porter.visible = false;
  }

  private stylePorter(kind: 'paramedic' | 'porter', id: number) {
    if (kind === this.porterKind) return;
    this.porterKind = kind;
    const m = (c: string) => this.scene.mat(c);
    const uniform = kind === 'paramedic' ? '#2f5d46' : '#26416b';
    const [torso, head, hair, stripe] = this.porter.children as THREE.Mesh[];
    torso!.material = m(uniform);
    head!.material = m(SKIN[(id * 11 + 2) % SKIN.length]!);
    hair!.material = m(HAIR[(id * 5 + 1) % HAIR.length]!);
    stripe!.material = m(kind === 'paramedic' ? '#d7ff3c' : '#c9d4e2'); // hi-vis band on paramedics
    for (const l of [...this.porterLegs, ...this.porterArms]) (l.children[0] as THREE.Mesh).material = m(uniform);
  }

  /** Clothes, hair and badge; rebuilt only when what they show changes. */
  style(a: Actor, gown: boolean) {
    const key =
      a.kind === 'patient'
        ? `p|${a.data.acuity ?? '-'}|${a.data.boarding}|${a.data.special}|${a.data.waited > 120}|${gown}|${a.data.agitated === true}|${(a.data.profile?.age ?? 30) < 13}`
        : `s|${a.data.role}|${a.data.busy}`;
    if (key === this.styleKey) return;
    this.styleKey = key;
    // Children are drawn smaller (under 13: about two-thirds of adult height).
    this.body.scale.setScalar(a.kind === 'patient' && (a.data.profile?.age ?? 30) < 13 ? 0.68 : 1);
    const id = a.data.id;
    const m = (c: string) => this.scene.mat(c);
    this.head.material = m(SKIN[(id * 7) % SKIN.length]!);
    const hairColor = m(HAIR[(id * 3) % HAIR.length]!);
    this.hair.material = hairColor;
    this.longHair.material = hairColor;
    this.hair.visible = id % 9 !== 0; // a few are bald
    this.longHair.visible = this.hair.visible && id % 3 === 1;
    let shirt: string;
    let trousers: string;
    let ring: string | null = null;
    this.coat.visible = false;
    this.stetho.visible = false;
    if (a.kind === 'patient') {
      // Street clothes until they are in a bed, then a hospital gown. The triage level is on the badge.
      shirt = gown ? this.scene.theme.gown : CLOTHES[(id * 13) % CLOTHES.length]!;
      trousers = gown ? this.scene.theme.gown : TROUSERS[(id * 5) % TROUSERS.length]!;
      this.blanket.material = m(this.scene.theme.blanket);
      this.badge.material = a.data.agitated
        ? this.scene.badge('!', css('--fail', '#b3261e'), 'square')
        : this.scene.badge(a.data.acuity === undefined ? '' : String(a.data.acuity), acuityColor(a.data.acuity), 'circle');
      if (a.data.agitated) ring = css('--fail', '#b3261e');
      else if (a.data.boarding) ring = css('--boarding', '#7b4bd6');
      else if (a.data.special === 'massCasualty') ring = css('--fail', '#b3261e');
      else if (a.data.waited > 120) ring = css('--ink', '#1d1c19');
    } else {
      // Scrubs in the role's colour; doctors add a white coat and a stethoscope.
      shirt = roleColor(a.data.role);
      trousers = shirt;
      if (a.data.role === 'doctor') {
        this.coat.visible = true;
        this.coat.material = this.scene.mat('#f4f4f1', false, true);
        this.stetho.visible = true;
        this.stetho.material = m('#2a2a2a');
      }
      this.badge.material = this.scene.badge(roleLetter(a.data.role), shirt, a.data.busy ? 'square' : 'hollow');
    }
    this.torso.material = m(shirt);
    for (const l of this.legs) (l.children[0] as THREE.Mesh).material = m(trousers);
    for (const l of this.arms) (l.children[0] as THREE.Mesh).material = m(shirt);
    this.ring.visible = ring !== null;
    if (ring) this.ring.material = this.scene.mat(ring, true);
  }

  pose(a: Actor, dt: number, t: number, faceTo: { x: number; y: number } | null) {
    this.root.position.set(a.x * S, 0, a.y * S);
    const settled = !a.moving && a.path.length === 0;
    const d = a.data;
    // Ambulance arrivals stay on their trolley until they are settled in a bed; admitted
    // patients go up to the ward on one.
    const inBed = a.kind === 'patient' && a.data.inBed && settled;
    const arriving = a.kind === 'patient' && (a.data.special === 'massCasualty' || a.data.byAmbulance === true) && !inBed && !a.leaving;
    const toWard = a.kind === 'patient' && a.leaving && a.data.boarding;
    const onGurney = arriving || toWard;
    this.porter.visible = onGurney;
    if (onGurney) {
      this.stylePorter(arriving ? 'paramedic' : 'porter', d.id);
      const step = a.moving ? Math.sin(((a.stride * S) / 0.7) * Math.PI) : 0;
      this.porterLegs[0]!.rotation.x = step * 0.55;
      this.porterLegs[1]!.rotation.x = -step * 0.55;
    }
    const lie = onGurney || (settled && d.pose === 'lie');
    const sit = !lie && settled && d.pose === 'sit';
    const k = 1 - Math.exp(-dt * 8);
    this.lying += ((lie ? 1 : 0) - this.lying) * k;
    this.sitting += ((sit ? 1 : 0) - this.sitting) * k;
    this.gurney.visible = onGurney;
    this.blanket.visible = a.kind === 'patient' && this.lying > 0.5;

    // Facing: along the walk; settled, as the plan says (or towards their patient when standing).
    // Lying, `face` is where the head points.
    let want = this.heading;
    if (a.moving) want = onGurney ? a.heading + Math.PI : a.heading;
    else if (lie && !onGurney) want = d.face ?? 0;
    else if (faceTo && !sit) want = Math.atan2(faceTo.x - a.x, faceTo.y - a.y);
    else if (!onGurney) want = d.face ?? 0;
    this.heading = lerpAngle(this.heading, want, 1 - Math.exp(-dt * 10));
    this.root.rotation.y = this.heading;

    // Gait: legs and arms swing with distance walked, and the body bobs.
    const walking = a.moving && !onGurney;
    const phase = ((a.stride * S) / 0.7) * Math.PI;
    const swing = walking ? Math.sin(phase) : 0;
    const breathe = Math.sin(t * 1.8 + d.id) * 0.015;
    this.legs[0]!.rotation.x = swing * 0.55 - this.sitting * 1.5;
    this.legs[1]!.rotation.x = -swing * 0.55 - this.sitting * 1.5;
    this.arms[0]!.rotation.x = -swing * 0.45 + breathe - this.sitting * 0.35;
    this.arms[1]!.rotation.x = swing * 0.45 - breathe - this.sitting * 0.35;
    const bob = walking ? Math.abs(Math.cos(phase)) * 0.04 : 0;

    // Lying: tip the body back so the head points along the root's -z, face up.
    const top = onGurney ? GURNEY_TOP : BED_TOP;
    this.body.rotation.x = (-this.lying * Math.PI) / 2;
    this.body.position.set(0, bob - this.sitting * 0.4 + this.lying * (top + 0.17), this.lying * 0.84);
    this.badge.position.set(0, 2.1 - this.sitting * 0.45 - this.lying * 1.05, 0);
  }
}

interface Theme {
  dark: boolean;
  wall: string;
  curtain: string;
  gown: string;
  blanket: string;
  metal: string;
  wood: string;
}

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  theme: Theme = themeNow();
  /** Display name for a patient id (tracking board). */
  namer: ((id: number, sex?: 'F' | 'M') => string) | null = null;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 0.1, 500);
  private readonly controls: OrbitControls;
  private readonly world = new THREE.Group();
  private readonly people = new THREE.Group();
  private readonly figures = new Map<string, Figure>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly badges = new Map<string, THREE.SpriteMaterial>();
  private readonly textures = new Map<string, THREE.Texture>();
  private readonly sun = new THREE.DirectionalLight('#ffffff', 1.6);
  private readonly hemi = new THREE.HemisphereLight('#ffffff', '#b9b4a6', 1.25);
  private readonly raycaster = new THREE.Raycaster();
  /** Per-frame parts of the world: privacy curtains, bedside monitors, the ambulance's lights. */
  private curtains = new Map<string, { mesh: THREE.Mesh; open: number; span: number; left: number }>();
  private monitors = new Map<string, THREE.Mesh>();
  private beacons: THREE.Mesh[] = [];
  private boards: { canvas: HTMLCanvasElement; tex: THREE.CanvasTexture }[] = [];
  private lastBoard = -1;
  private ecg: THREE.CanvasTexture | null = null;
  private structureKey = '';
  private themeKey = '';
  private centre = new THREE.Vector3();
  /** The middle of the building itself (no allowance for the entrance canopy). */
  private plainCentre = new THREE.Vector3();
  private span = 20;
  private framed = false;
  private ghost: THREE.Mesh | null = null;
  private readonly floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = 1.3;
    this.controls.minDistance = 3;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.world, this.people);
  }

  /** Cached material per colour: lit (default), flat and see-through, or double-sided. */
  mat(color: string, flat = false, doubleSide = false): THREE.Material {
    const key = `${color}|${flat}|${doubleSide}`;
    let m = this.materials.get(key);
    if (!m) {
      m = flat
        ? new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.9, depthWrite: false })
        : new THREE.MeshLambertMaterial({ color: new THREE.Color(color), side: doubleSide ? THREE.DoubleSide : THREE.FrontSide });
      this.materials.set(key, m);
    }
    return m;
  }

  /** Numbered (patients) or lettered (staff) badge above a head; the same size on screen at any zoom. */
  badge(text: string, color: string, shape: 'circle' | 'square' | 'hollow'): THREE.SpriteMaterial {
    const key = `${text}|${color}|${shape}`;
    let m = this.badges.get(key);
    if (m) return m;
    const c = document.createElement('canvas');
    c.width = c.height = 64;
    const g = c.getContext('2d')!;
    g.beginPath();
    if (shape === 'circle') g.arc(32, 32, 26, 0, Math.PI * 2);
    else g.roundRect(8, 8, 48, 48, 12);
    g.fillStyle = shape === 'hollow' ? css('--surface', '#ffffff') : color;
    g.fill();
    g.lineWidth = shape === 'hollow' ? 7 : 5;
    g.strokeStyle = shape === 'hollow' ? color : css('--dot-ring', '#ffffff');
    g.stroke();
    if (text) {
      g.fillStyle = shape === 'hollow' ? color : inkOn(color);
      g.font = '800 34px system-ui, sans-serif';
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.fillText(text, 32, 34);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    m = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false });
    this.badges.set(key, m);
    return m;
  }

  /** A trolley: frame, mattress, legs and wheels. */
  gurney(): THREE.Group {
    const g = new THREE.Group();
    const metal = this.mat(this.theme.metal);
    this.put(this.box(0.62, 0.08, 2.0), metal, 0, 0, GURNEY_TOP - 0.12, 0, true, g);
    this.put(this.box(0.58, 0.08, 1.95), this.mat('#ffffff'), 0, 0, GURNEY_TOP - 0.04, 0, true, g);
    for (const [x, z] of [
      [-0.26, -0.85],
      [0.26, -0.85],
      [-0.26, 0.85],
      [0.26, 0.85],
    ] as const) {
      this.put(this.box(0.04, GURNEY_TOP - 0.2, 0.04), metal, x / S, z / S, (GURNEY_TOP - 0.2) / 2 + 0.06, 0, false, g);
      this.put(this.cyl(0.06, 0.06, 0.04, 10), this.mat('#222222'), x / S, z / S, 0.06, 0, false, g).rotation.z = Math.PI / 2;
    }
    return g;
  }

  resize(width: number, height: number) {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /** Frame the whole floor from the front, looking down at an angle. */
  resetView() {
    const d = this.span * (this.camera.aspect < 1 ? 1.8 : 1.02);
    this.camera.position.set(this.centre.x, d * 0.86, this.centre.z + d * 0.55);
    this.controls.target.copy(this.centre);
    this.controls.maxDistance = this.span * 3;
    this.controls.update();
  }

  /** The person under a point in client coordinates, if any. */
  pick(clientX: number, clientY: number): Picked | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    let best: { key: string; d: number } | null = null;
    for (const [key, f] of this.figures) {
      const hit = this.raycaster.intersectObject(f.body, true)[0];
      if (hit && (!best || hit.distance < best.d)) best = { key, d: hit.distance };
    }
    return best ? { key: best.key, x: clientX - r.left, y: clientY - r.top } : null;
  }

  // ---------------------------------------------------------------- editing (the 3D builder)

  /**
   * Editing: the left button (one finger on touch) draws instead of turning the view; the right
   * button (two fingers) turns and pans, the wheel (pinch) zooms.
   */
  setEditing(on: boolean) {
    const c = this.controls as unknown as { mouseButtons: Record<string, number | null>; touches: Record<string, number | null> };
    c.mouseButtons.LEFT = on ? null : THREE.MOUSE.ROTATE;
    c.mouseButtons.RIGHT = on ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    c.touches.ONE = on ? null : THREE.TOUCH.ROTATE;
  }

  /** The point on the floor under the pointer, in plan units, or null when pointing at the sky. */
  floorPoint(clientX: number, clientY: number): { x: number; y: number } | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.floorPlane, new THREE.Vector3());
    return hit ? { x: hit.x / S, y: hit.z / S } : null;
  }

  /** A see-through block over the rectangle being drawn (plan units), or nothing. */
  setGhost(rect: { x: number; y: number; w: number; h: number } | null, color: string) {
    if (!rect) {
      if (this.ghost) this.ghost.visible = false;
      return;
    }
    if (!this.ghost) {
      this.ghost = new THREE.Mesh(this.box(1, 1, 1), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false }));
      this.ghost.renderOrder = 10;
      this.scene.add(this.ghost);
    }
    (this.ghost.material as THREE.MeshBasicMaterial).color.set(color);
    this.ghost.visible = true;
    this.ghost.scale.set(rect.w * S, WALL_H * 0.6, rect.h * S);
    this.ghost.position.set((rect.x + rect.w / 2) * S, (WALL_H * 0.6) / 2, (rect.y + rect.h / 2) * S);
  }

  /** Look straight down on the floor (easiest for drawing), or back to the usual angle. */
  topView(on: boolean) {
    if (!on) return this.resetView();
    const d = this.span * (this.camera.aspect < 1 ? 1.9 : 1.15);
    const c = this.plainCentre;
    this.camera.position.set(c.x, d * 1.25, c.z + 0.01);
    this.controls.target.copy(c);
    this.controls.update();
  }

  render(plan: FloorPlan, actors: readonly Actor[], dt: number, t: number) {
    const themeKey = ['--canvas-bg', '--esi-1', '--surface', '--staff', '--room-trauma'].map((v) => css(v, '')).join();
    if (themeKey !== this.themeKey) {
      this.themeKey = themeKey;
      this.theme = themeNow();
      this.clearCaches();
      this.structureKey = '';
    }
    const key = structureKey(plan);
    if (key !== this.structureKey) {
      this.structureKey = key;
      this.buildWorld(plan);
    }

    const byKey = new Map(actors.map((a) => [a.key, a]));
    for (const [k, f] of this.figures)
      if (!byKey.has(k)) {
        this.people.remove(f.root);
        this.figures.delete(k);
      }
    let ambulanceBusy = false;
    for (const a of actors) {
      let f = this.figures.get(a.key);
      if (!f) {
        f = new Figure(this);
        this.figures.set(a.key, f);
        this.people.add(f.root);
      }
      // Into a gown once they are settled in the bed (and still in it when wheeled up to the ward).
      f.style(a, a.kind === 'patient' && a.data.inBed && a.data.pose === 'lie' && ((!a.moving && a.path.length === 0) || a.leaving));
      const patient = a.kind === 'staff' && a.data.patientId !== undefined ? byKey.get(`p${a.data.patientId}`) : undefined;
      f.pose(a, dt, t, patient ? { x: patient.x, y: patient.y } : null);
      if (a.kind === 'patient' && a.data.special === 'massCasualty' && a.moving) ambulanceBusy = true;
    }

    // Privacy curtains close while someone is with the patient; monitors show a trace while a bed is taken.
    for (const b of plan.bays ?? []) {
      const c = this.curtains.get(`${b.lane}:${b.index}`);
      if (!c) continue;
      c.open += ((b.attended ? 1 : 0.16) - c.open) * (1 - Math.exp(-dt * 4));
      c.mesh.scale.x = c.open;
      c.mesh.position.x = c.left + (c.open * c.span) / 2;
    }
    for (const bed of plan.beds) {
      const m = this.monitors.get(`${bed.lane}:${bed.index}`);
      if (m) m.material = bed.occupied ? this.ecgMaterial() : this.mat('#101418');
    }
    if (this.ecg) this.ecg.offset.x = (t * 0.35) % 1;
    if (this.boards.length && t - this.lastBoard > 1) {
      this.lastBoard = t;
      this.drawBoards(plan);
    }
    const flash = Math.floor(t * 4) % 2 === 0;
    this.beacons.forEach((b, i) => {
      const on = ambulanceBusy && (i % 2 === 0 ? flash : !flash);
      b.material = this.mat(on ? (i % 2 === 0 ? '#ff3b30' : '#2f7cff') : '#5a5a5a');
    });

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.controls.dispose();
    if (this.ghost) (this.ghost.material as THREE.Material).dispose();
    this.clearCaches();
    this.disposeWorld();
    this.renderer.dispose();
  }

  // ---------------------------------------------------------------- building the world

  private box(w: number, h: number, d: number) {
    return new THREE.BoxGeometry(w, h, d);
  }

  private cyl(rt: number, rb: number, h: number, seg = 12) {
    return new THREE.CylinderGeometry(rt, rb, h, seg);
  }

  /** Add a mesh at plan (x, y), height `elev`, turned by `rot` (like Pose.face). */
  private put(geometry: THREE.BufferGeometry, material: THREE.Material, x: number, y: number, elev: number, rot = 0, shadow = true, parent: THREE.Object3D = this.world) {
    const m = new THREE.Mesh(geometry, material);
    m.position.set(x * S, elev, y * S);
    m.rotation.y = rot;
    m.castShadow = shadow;
    m.receiveShadow = true;
    parent.add(m);
    return m;
  }

  /** Translucent, double-sided material. */
  private see(color: string, opacity: number): THREE.Material {
    const key = `see|${color}|${opacity}`;
    let m = this.materials.get(key);
    if (!m) {
      m = new THREE.MeshLambertMaterial({ color: new THREE.Color(color), transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
      this.materials.set(key, m);
    }
    return m;
  }

  /** A group at plan (x, y) turned by `rot`, for furniture built in its own frame (front = +z). */
  private local(x: number, y: number, rot: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x * S, 0, y * S);
    g.rotation.y = rot;
    this.world.add(g);
    return g;
  }

  /** A computer screen showing a patient record. */
  private screenMaterial(): THREE.Material {
    let m = this.materials.get('screen');
    if (!m) {
      const c = document.createElement('canvas');
      c.width = 96;
      c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = '#eaf2fb';
      g.fillRect(0, 0, 96, 64);
      g.fillStyle = '#2f6db5';
      g.fillRect(0, 0, 96, 10);
      g.fillStyle = '#9fb3c8';
      for (let i = 0; i < 6; i++) g.fillRect(6, 16 + i * 8, 40 + ((i * 17) % 40), 3);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      m = new THREE.MeshBasicMaterial({ map: tex });
      this.materials.set('screen', m);
    }
    return m;
  }

  /** The tracking board's canvas; redrawn from the plan about once a second. */
  private boardTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas');
    c.width = 512;
    c.height = 296;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.boards.push({ canvas: c, tex });
    return tex;
  }

  private drawBoards(plan: FloorPlan) {
    const rows = plan.patients
      .filter((p) => p.inBed && p.bedLabel)
      .sort((a, b) => (a.acuity ?? 6) - (b.acuity ?? 6) || b.waited - a.waited)
      .slice(0, 9);
    const waiting = plan.patients.filter((p) => !p.inBed).length;
    for (const { canvas, tex } of this.boards) {
      const g = canvas.getContext('2d')!;
      g.fillStyle = '#0f1419';
      g.fillRect(0, 0, 512, 296);
      g.fillStyle = '#e8eef5';
      g.font = '700 22px system-ui, sans-serif';
      g.fillText('ED TRACKING BOARD', 14, 30);
      g.font = '500 16px system-ui, sans-serif';
      g.fillStyle = '#9fb3c8';
      g.fillText(`Waiting: ${waiting}`, 380, 30);
      g.fillStyle = '#2a3440';
      g.fillRect(10, 40, 492, 2);
      rows.forEach((p, i) => {
        const y = 66 + i * 25;
        g.fillStyle = i % 2 ? '#141b22' : '#18212a';
        g.fillRect(10, y - 18, 492, 24);
        g.fillStyle = p.acuity ? acuityColor(p.acuity) : '#777';
        g.fillRect(16, y - 14, 26, 18);
        g.fillStyle = p.acuity ? inkOn(acuityColor(p.acuity)) : '#fff';
        g.font = '700 14px system-ui, sans-serif';
        g.fillText(p.acuity ? String(p.acuity) : '–', 25, y);
        g.fillStyle = '#e8eef5';
        g.font = '600 16px system-ui, sans-serif';
        g.fillText(p.bedLabel!, 54, y);
        g.fillStyle = '#9fb3c8';
        g.fillText((this.namer?.(p.id, p.profile?.sex) ?? `#${p.id}`).slice(0, 14), 130, y);
        g.fillText(p.boarding ? 'Admitted – awaiting bed' : 'In treatment', 220, y);
        g.fillStyle = p.waited > 240 ? '#ff8a80' : '#e8eef5';
        g.fillText(`${Math.floor(p.waited / 60)}h ${String(Math.round(p.waited % 60)).padStart(2, '0')}m`, 430, y);
      });
      tex.needsUpdate = true;
    }
  }

  private ecgMaterial(): THREE.Material {
    if (!this.ecg) {
      const c = document.createElement('canvas');
      c.width = 128;
      c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = '#07130d';
      g.fillRect(0, 0, 128, 64);
      g.strokeStyle = '#3cff8f';
      g.lineWidth = 3;
      g.beginPath();
      const beat = [0, 0, 0, 0, -3, 0, 0, 6, -22, 14, 0, 0, 0, -5, -6, -3, 0, 0, 0, 0];
      for (let i = 0; i <= 128; i++) g.lineTo(i, 36 + beat[Math.floor(i / 3.2) % beat.length]!);
      g.stroke();
      this.ecg = new THREE.CanvasTexture(c);
      this.ecg.wrapS = THREE.RepeatWrapping;
      this.ecg.colorSpace = THREE.SRGBColorSpace;
    }
    let m = this.materials.get('ecg');
    if (!m) {
      m = new THREE.MeshBasicMaterial({ map: this.ecg });
      this.materials.set('ecg', m);
    }
    return m;
  }

  /** Floor tiles: a subtle 60 cm grid in the floor colour. */
  private floorMaterial(color: string, w: number, h: number): THREE.Material {
    let tex = this.textures.get(color);
    if (!tex) {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d')!;
      g.fillStyle = color;
      g.fillRect(0, 0, 64, 64);
      const line = new THREE.Color(color).offsetHSL(0, 0, this.theme.dark ? 0.035 : -0.03);
      g.strokeStyle = `#${line.getHexString()}`;
      g.lineWidth = 2;
      g.strokeRect(0, 0, 64, 64);
      tex = new THREE.CanvasTexture(c);
      tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
      tex.colorSpace = THREE.SRGBColorSpace;
      this.textures.set(color, tex);
    }
    const t = tex.clone();
    t.repeat.set((w * S) / 0.6, (h * S) / 0.6);
    t.needsUpdate = true;
    return new THREE.MeshLambertMaterial({ map: t });
  }

  private clearCaches() {
    for (const m of this.materials.values()) m.dispose();
    for (const m of this.badges.values()) {
      m.map?.dispose();
      m.dispose();
    }
    for (const t of this.textures.values()) t.dispose();
    this.ecg?.dispose();
    this.ecg = null;
    this.materials.clear();
    this.badges.clear();
    this.textures.clear();
    for (const f of this.figures.values()) this.people.remove(f.root);
    this.figures.clear();
  }

  private disposeWorld() {
    const cached = new Set<THREE.Material>(this.materials.values());
    this.world.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        const m = o.material as THREE.Material & { map?: THREE.Texture | null };
        if (!cached.has(m)) {
          m.map?.dispose();
          m.dispose();
        }
      }
    });
    this.world.clear();
    this.curtains.clear();
    this.monitors.clear();
    this.beacons = [];
    this.boards = [];
    this.lastBoard = -1;
  }

  private buildWorld(plan: FloorPlan) {
    this.disposeWorld();
    const th = this.theme;
    const bg = css('--canvas-bg', '#ecebe5');
    this.scene.background = new THREE.Color(bg);
    this.hemi.intensity = th.dark ? 1.15 : 1.25;
    this.hemi.groundColor = new THREE.Color(th.dark ? '#262320' : '#b9b4a6');
    this.sun.intensity = th.dark ? 1.0 : 1.6;

    // Frame the building, not the outdoors.
    const xs = [...plan.areas.flatMap((a) => [a.x, a.x + a.w]), ...(plan.grid?.cells.flatMap((c) => [c.x, c.x + c.w]) ?? [])];
    const ys = [...plan.areas.flatMap((a) => [a.y, a.y + a.h]), ...(plan.grid?.cells.flatMap((c) => [c.y, c.y + c.h]) ?? [])];
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    // A little below the middle, so the entrance canopy is in frame.
    this.centre.set(((x0 + x1) / 2) * S, 0, ((y0 + y1) / 2 + (plan.props ? 25 : 0)) * S);
    this.plainCentre.set(((x0 + x1) / 2) * S, 0, ((y0 + y1) / 2) * S);
    this.span = Math.max(x1 - x0, y1 - y0) * S;
    const sh = this.sun.shadow.camera;
    sh.left = sh.bottom = -this.span * 0.9;
    sh.right = sh.top = this.span * 0.9;
    sh.near = 1;
    sh.far = this.span * 4;
    sh.updateProjectionMatrix();
    this.sun.position.set(this.centre.x - this.span * 0.5, this.span * 1.2, this.centre.z + this.span * 0.35);
    this.sun.target.position.copy(this.centre);

    // Ground outside the building.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(this.span * 8, this.span * 8), new THREE.MeshLambertMaterial({ color: new THREE.Color(th.dark ? '#1b1f1a' : '#dfe3d4') }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(this.centre.x, -0.02, this.centre.z);
    ground.receiveShadow = true;
    this.world.add(ground);

    // Building floor: corridors, then each room with its walls and a label.
    const corridor = css('--corridor', '#e4e2da');
    if (plan.grid) {
      const cells = new THREE.InstancedMesh(this.box(1, 0.04, 1), new THREE.MeshLambertMaterial({ color: new THREE.Color(corridor) }), plan.grid.cells.length);
      const m = new THREE.Matrix4();
      plan.grid.cells.forEach((c, i) => {
        m.makeScale(c.w * S + 0.01, 1, c.h * S + 0.01).setPosition((c.x + c.w / 2) * S, 0.0, (c.y + c.h / 2) * S);
        cells.setMatrixAt(i, m);
      });
      cells.receiveShadow = true;
      this.world.add(cells);
    } else {
      this.world.add(this.slab(x0, y0, x1 - x0, y1 - y0, corridor, 0));
    }
    const wallMat = this.mat(th.wall);
    const capMat = this.mat(css('--line-strong', '#cfcbc0'));
    for (const a of plan.areas) {
      this.world.add(this.slab(a.x, a.y, a.w, a.h, css(`--room-${roomKind(a)}`, '#ffffff'), 0.03));
      this.walls(a, plan.nav.openings.filter((o) => o.area === a.id), wallMat, capMat);
      // Furnished bed rooms have cubicles along the walls: name them in the aisle.
      if (plan.grid) this.label(a.label, a.x + 6, plan.bays?.length && ['acute', 'trauma', 'fastTrack'].includes(a.kind ?? '') ? a.y + a.h / 2 - 7 : a.y + 4, Math.min(a.w - 12, 90));
      else if (a.id === 'waiting') this.label(a.label, a.x + 12, a.y + 8, Math.min(a.w - 24, 170));
      else if (plan.props) this.label(a.label, a.x + (a.id === 'main' ? 44 : 14), a.id === 'main' ? a.y + a.h / 2 - 11 : a.y + (a.id === 'fastTrack' ? 72 : a.h - 18), Math.min(a.w * 0.22, 120));
      else this.label(a.label, a.x + a.w - 12, a.y + 8, Math.min(a.w * 0.4, 170), undefined, 'right');
    }
    for (const e of plan.enclosures ?? []) {
      this.world.add(this.slab(e.x, e.y, e.w, e.h, css(`--room-${e.kind}`, '#fbe6e3'), 0.045));
      this.walls({ id: e.label, label: e.label, x: e.x, y: e.y, w: e.w, h: e.h }, e.openings, wallMat, capMat, 1.4);
    }

    // Cubicles, beds and recliners.
    const bedAt = new Map(plan.beds.map((b) => [`${b.lane}:${b.index}`, b]));
    for (const bay of plan.bays ?? []) this.bay(bay, bedAt.get(`${bay.lane}:${bay.index}`));
    for (const b of plan.beds) {
      if (b.recliner) this.recliner(b);
      else this.bed(b, !plan.bays);
    }

    // Waiting-room chairs, facing the camera side.
    if (plan.seats.length) {
      const seatMat = this.mat(th.dark ? '#4b5a6b' : '#8fa3b8');
      const seat = new THREE.InstancedMesh(this.box(0.46, 0.07, 0.44), seatMat, plan.seats.length);
      const back = new THREE.InstancedMesh(this.box(0.46, 0.46, 0.06), seatMat, plan.seats.length);
      const legs = new THREE.InstancedMesh(this.box(0.4, 0.4, 0.04), this.mat(th.metal), plan.seats.length);
      const m = new THREE.Matrix4();
      plan.seats.forEach((p, i) => {
        seat.setMatrixAt(i, m.makeTranslation(p.x * S, 0.44, p.y * S));
        back.setMatrixAt(i, m.makeTranslation(p.x * S, 0.7, p.y * S - 0.22));
        legs.setMatrixAt(i, m.makeTranslation(p.x * S, 0.2, p.y * S));
      });
      seat.castShadow = back.castShadow = seat.receiveShadow = true;
      this.world.add(seat, back, legs);
    }

    for (const p of plan.props ?? []) this.prop(p);

    // The 2D-derived floor has no furniture list: counters where free staff wait.
    if (!plan.grid && !plan.props) {
      for (const a of plan.areas.filter((x) => x.id !== 'waiting')) {
        const len = Math.min(a.w * 0.5, 220);
        this.put(this.box(len * S, 0.95, 0.45), this.mat(th.wood), a.x + 12 + len / 2, a.y + (a.id === 'triage' ? 24 : 27), 0.475);
      }
    }

    // Door mats and labels where people come and go.
    const doors = plan.nav.doors;
    const marks: [typeof doors.entrance, string, string][] = [[doors.entrance, 'Entrance', css('--accent', '#2553c9')]];
    if (doors.ambulance !== doors.entrance) marks.push([doors.ambulance, 'Ambulance · staff', css('--fail', '#b3261e')]);
    if (doors.ward !== doors.entrance && !plan.props) marks.push([doors.ward, 'To the wards', css('--boarding', '#7b4bd6')]);
    for (const [d, text, color] of marks) {
      const mid = { x: (d.inside.x + d.outside.x) / 2, y: (d.inside.y + d.outside.y) / 2 };
      this.put(this.box(1.6, 0.02, 1.6), this.mat(color), mid.x, mid.y, 0.02, 0, false);
      if (d.outside.x > d.inside.x) this.label(text, mid.x, d.outside.y - 30, 120, color, 'up');
      else this.label(text, d.outside.x + 24, d.outside.y - 10, 130, color);
    }

    if (!this.framed) {
      this.resetView();
      this.framed = true;
    }
  }

  private slab(x: number, y: number, w: number, h: number, color: string, lift: number) {
    const m = new THREE.Mesh(this.box(w * S, 0.04, h * S), this.floorMaterial(color, w, h));
    m.position.set((x + w / 2) * S, lift, (y + h / 2) * S);
    m.receiveShadow = true;
    return m;
  }

  /** Four walls around a rectangle, with a gap wherever there is an opening on that wall. */
  private walls(a: Area, open: { x: number; y: number; width: number }[], mat: THREE.Material, cap: THREE.Material, height = WALL_H) {
    const edges: { x0: number; y0: number; x1: number; y1: number }[] = [
      { x0: a.x, y0: a.y, x1: a.x + a.w, y1: a.y },
      { x0: a.x, y0: a.y + a.h, x1: a.x + a.w, y1: a.y + a.h },
      { x0: a.x, y0: a.y, x1: a.x, y1: a.y + a.h },
      { x0: a.x + a.w, y0: a.y, x1: a.x + a.w, y1: a.y + a.h },
    ];
    for (const e of edges) {
      const horizontal = e.y0 === e.y1;
      const lo = horizontal ? e.x0 : e.y0;
      const hi = horizontal ? e.x1 : e.y1;
      const gaps = open
        .filter((o) => (horizontal ? Math.abs(o.y - e.y0) < 3 : Math.abs(o.x - e.x0) < 3))
        .map((o) => [(horizontal ? o.x : o.y) - o.width / 2, (horizontal ? o.x : o.y) + o.width / 2] as const)
        .sort((p, q) => p[0] - q[0]);
      let start = lo;
      for (const [g0, g1] of [...gaps, [hi, hi] as const]) {
        const end = Math.min(hi, g0);
        if (end - start > 2) {
          const len = (end - start) * S;
          const mid = (start + end) / 2;
          const px = horizontal ? mid : e.x0;
          const pz = horizontal ? e.y0 : mid;
          this.put(this.box(horizontal ? len : WALL_T, height, horizontal ? WALL_T : len), mat, px, pz, height / 2);
          this.put(this.box(horizontal ? len : WALL_T + 0.02, 0.03, horizontal ? WALL_T + 0.02 : len), cap, px, pz, height + 0.015, 0, false);
        }
        start = Math.max(start, g1);
      }
    }
  }

  /** A hospital bed: frame on wheels, mattress, pillow, side rails, head and foot boards. */
  private bed(b: BedMark, legacy: boolean) {
    const th = this.theme;
    const along = b.head === 'up' || b.head === 'down' ? 'z' : 'x';
    let len = (along === 'x' ? b.w : b.h) * S;
    let wid = (along === 'x' ? b.h : b.w) * S;
    let cx = b.x + b.w / 2;
    const cz = b.y + b.h / 2;
    if (legacy) {
      // Plans laid out for 2D: beds sized to their slot, the patient lying at 58% along.
      len = Math.min(len * 0.94, 2.1);
      wid = Math.min(wid * 0.8, 1.0);
      if (len >= 2.1) cx = b.x + b.w * 0.58 - 1;
    }
    const g = new THREE.Group();
    g.position.set(cx * S, 0, cz * S);
    g.rotation.y = b.head === 'up' ? 0 : b.head === 'down' ? Math.PI : Math.PI / 2; // head towards local -z
    this.world.add(g);
    const frame = this.mat(b.trauma ? (th.dark ? '#8a4b47' : '#c2534b') : th.dark ? '#5d6470' : '#9aa3b0');
    const metal = this.mat(th.metal);
    const u = (m: number) => m / S; // metres to plan units, for positions inside the group
    this.put(this.box(wid, 0.12, len), frame, 0, 0, BED_TOP - 0.2, 0, true, g);
    this.put(this.box(wid * 0.96, 0.14, len * 0.97), this.mat(th.dark ? '#d8d6cf' : '#ffffff'), 0, 0, BED_TOP - 0.07, 0, true, g);
    this.put(this.box(wid * 0.6, 0.08, 0.34), this.mat(th.dark ? '#b7c4d9' : '#dfe8f5'), 0, u(-len / 2 + 0.24), BED_TOP + 0.04, 0, false, g);
    this.put(this.box(wid + 0.04, 0.55, 0.05), frame, 0, u(-len / 2), 0.66, 0, true, g);
    this.put(this.box(wid + 0.04, 0.3, 0.05), frame, 0, u(len / 2), 0.55, 0, true, g);
    for (const sx of [-1, 1]) this.put(this.box(0.03, 0.14, len * 0.45), metal, u(sx * (wid / 2 + 0.02)), u(-len * 0.15), BED_TOP + 0.08, 0, false, g);
    for (const sx of [-1, 1])
      for (const sz of [-1, 1]) {
        this.put(this.box(0.05, BED_TOP - 0.34, 0.05), metal, u(sx * wid * 0.4), u(sz * len * 0.42), (BED_TOP - 0.34) / 2 + 0.1, 0, false, g);
        this.put(this.cyl(0.05, 0.05, 0.04, 8), this.mat('#222222'), u(sx * wid * 0.4), u(sz * len * 0.42), 0.05, 0, false, g).rotation.z = Math.PI / 2;
      }
  }

  /** A fast-track recliner facing the aisle. */
  private recliner(b: BedMark) {
    const g = new THREE.Group();
    g.position.set((b.x + b.w / 2) * S, 0, (b.y + b.h / 2) * S);
    this.world.add(g);
    const vinyl = this.mat(this.theme.dark ? '#3f5873' : '#6f8fae');
    const u = (m: number) => m / S;
    this.put(this.box(0.7, 0.3, 0.7), vinyl, 0, 0, 0.3, 0, true, g);
    this.put(this.box(0.7, 0.8, 0.18), vinyl, 0, u(-0.38), 0.75, 0, true, g).rotation.x = -0.25;
    for (const sx of [-1, 1]) this.put(this.box(0.1, 0.24, 0.66), vinyl, u(sx * 0.38), 0, 0.55, 0, true, g);
    this.put(this.box(0.6, 0.14, 0.4), vinyl, 0, u(0.5), 0.25, 0, true, g);
  }

  /** Curtain rails and curtains round a cubicle, a monitor and a drip stand; trauma rooms get their kit. */
  private bay(b: Bay, bed: BedMark | undefined) {
    const th = this.theme;
    const wallSide = b.front === 'down' ? b.y : b.y + b.h;
    const frontSide = b.front === 'down' ? b.y + b.h : b.y;
    const dir = b.front === 'down' ? 1 : -1; // from the wall towards the aisle
    const cx = b.x + b.w / 2;
    if (b.kind === 'trauma') {
      this.traumaKit(b, bed);
      this.label(b.label ?? 'Trauma', b.x + 8, dir > 0 ? frontSide - 26 : frontSide + 6, b.w * 0.55, css('--trauma', '#b3261e'));
      return;
    }
    const curtain = this.mat(th.curtain, false, true);
    const rail = this.mat(th.metal);
    const railH = 2.05;
    const depth = b.h - 6;
    // Side curtains, drawn back a little from the aisle so people can step in.
    for (const x of [b.x + 2, b.x + b.w - 2]) {
      const len = depth * 0.8;
      this.put(curtainGeometry(len * S, 1.6), curtain, x, wallSide + dir * (len / 2 + 2), 1.15, Math.PI / 2, true).receiveShadow = false;
      this.put(this.box(0.03, 0.03, depth * S), rail, x, wallSide + (dir * depth) / 2, railH, 0, false);
    }
    this.put(this.box((b.w - 4) * S, 0.03, 0.03), rail, cx, frontSide - dir * 4, railH, 0, false);
    // Privacy curtain on the front rail: bunched at the left until someone is with the patient.
    if (b.kind === 'bay') {
      const span = (b.w - 8) * S;
      const m = this.put(curtainGeometry(span, 1.45), this.see(th.curtain, 0.62), b.x + 4, frontSide - dir * 4, 1.2, 0, false);
      this.curtains.set(`${b.lane}:${b.index}`, { mesh: m, open: 0.16, span, left: (b.x + 4) * S });
      m.scale.x = 0.16;
      m.position.x = (b.x + 4) * S + (0.16 * span) / 2;
    }
    if (bed && !bed.recliner) {
      // Monitor and drip stand at the head of the bed; oxygen and suction panel on the wall.
      const headY = wallSide + dir * 6;
      this.monitor(bed, bed.x - 8, headY + dir * 4, dir);
      this.put(this.cyl(0.015, 0.015, 1.9, 6), this.mat(th.metal), bed.x + bed.w + 6, headY + dir * 6, 0.95, 0, true);
      this.put(this.box(0.12, 0.18, 0.04), this.see('#cfe8ff', 0.7), bed.x + bed.w + 6, headY + dir * 6, 1.72, 0, false);
      this.put(this.cyl(0.18, 0.18, 0.03, 10), this.mat(th.metal), bed.x + bed.w + 6, headY + dir * 6, 0.03, 0, false);
      this.put(this.box(0.5, 0.25, 0.04), this.mat(th.dark ? '#6d7780' : '#dfe4ea'), cx, wallSide + dir * 1.2, 1.4, 0, false);
    }
  }

  /** A monitor on a stand; its screen shows a moving trace while the bed is taken. */
  private monitor(bed: BedMark, x: number, y: number, dir: number) {
    const th = this.theme;
    const face = dir > 0 ? 0 : Math.PI;
    this.put(this.cyl(0.02, 0.02, 1.3, 6), this.mat(th.metal), x, y, 0.65, 0, false);
    this.put(this.box(0.36, 0.26, 0.06), this.mat('#2a2d31'), x, y, 1.42, face, true);
    const screen = this.put(new THREE.PlaneGeometry(0.31, 0.2), this.mat('#101418'), x, y + dir * 0.65, 1.42, face, false);
    this.monitors.set(`${bed.lane}:${bed.index}`, screen);
  }

  /** Trauma room kit: surgical light on a boom, monitor, crash cart, ventilator, supply shelves. */
  private traumaKit(b: Bay, bed: BedMark | undefined) {
    if (!bed) return;
    const th = this.theme;
    const dir = b.front === 'down' ? 1 : -1;
    const wallSide = b.front === 'down' ? b.y : b.y + b.h;
    const bx = bed.x + bed.w / 2;
    const by = bed.y + bed.h / 2;
    const metal = this.mat(th.metal);
    // Surgical light: a column by the wall, a boom out over the bed, a lamp head.
    this.put(this.cyl(0.05, 0.05, 2.5, 8), metal, bx - 34, wallSide + dir * 4, 1.25, 0, true);
    this.put(this.box(0.06, 0.06, Math.abs(by - wallSide - dir * 4) * S), metal, bx - 34, (wallSide + dir * 4 + by) / 2, 2.45, 0, false);
    this.put(this.box(34 * S, 0.06, 0.06), metal, bx - 17, by, 2.45, 0, false);
    this.put(this.cyl(0.38, 0.28, 0.12, 20), this.mat('#e8e8e2'), bx, by, 2.3, 0, false);
    this.put(this.cyl(0.3, 0.3, 0.01, 20), this.mat('#fffbe6', true), bx, by, 2.235, 0, false);
    this.monitor(bed, bed.x - 12, wallSide + dir * 10, dir);
    // Crash cart with drawers, and a ventilator with its own trace.
    this.put(this.box(0.55, 0.95, 0.5), this.mat('#c62828'), bed.x + bed.w + 26, wallSide + dir * 14, 0.5, 0, true);
    for (let i = 0; i < 4; i++) this.put(this.box(0.5, 0.02, 0.02), this.mat('#f1f1f1'), bed.x + bed.w + 26, wallSide + dir * 19.3, 0.2 + i * 0.2, 0, false);
    this.put(this.box(0.4, 1.1, 0.4), this.mat(th.dark ? '#7d8791' : '#e6ebef'), bed.x - 32, wallSide + dir * 26, 0.55, 0, true);
    this.put(new THREE.PlaneGeometry(0.28, 0.2), this.ecgMaterial(), bed.x - 32, wallSide + dir * 30.2, 0.95, dir > 0 ? 0 : Math.PI, false);
    // Supply shelves on the back wall.
    this.put(this.box(1.4, 1.8, 0.35), this.mat(th.dark ? '#5a6068' : '#cfd6dc'), b.x + b.w - 22, wallSide + dir * 5, 0.9, 0, true);
    for (let i = 0; i < 4; i++) this.put(this.box(1.3, 0.2, 0.1), this.mat(['#6fa8dc', '#f6b26b', '#93c47d', '#e06666'][i]!), b.x + b.w - 22, wallSide + dir * 8.5, 0.35 + i * 0.4, 0, false);
  }

  private prop(p: Prop) {
    const th = this.theme;
    const pw = p.w ?? 20;
    const ph = p.h ?? 20;
    const rot = p.rot ?? 0;
    switch (p.type) {
      case 'chair': {
        const g = new THREE.Group();
        g.position.set(p.x * S, 0, p.y * S);
        g.rotation.y = rot;
        this.world.add(g);
        const c = this.mat(th.dark ? '#3c4550' : '#58636f');
        this.put(this.box(0.46, 0.07, 0.44), c, 0, 0, 0.45, 0, true, g);
        this.put(this.box(0.46, 0.5, 0.06), c, 0, -0.22 / S, 0.72, 0, true, g);
        this.put(this.cyl(0.03, 0.03, 0.42, 6), this.mat(th.metal), 0, 0, 0.22, 0, false, g);
        this.put(this.cyl(0.24, 0.24, 0.03, 10), this.mat(th.metal), 0, 0, 0.03, 0, false, g);
        break;
      }
      case 'desk': {
        this.put(this.box(pw * S, 0.06, ph * S), this.mat(th.wood), p.x, p.y, 0.76);
        this.put(this.box(pw * S, 0.72, 0.04), this.mat(th.wood), p.x, p.y + ph / 2 - 1, 0.38);
        this.put(this.box(0.44, 0.28, 0.03), this.mat('#1e2226'), p.x, p.y + 2, 1.0);
        this.put(this.box(0.3, 0.02, 0.12), this.mat('#2a2d31'), p.x, p.y - 3, 0.8);
        break;
      }
      case 'partition': {
        this.put(this.box(0.05, 1.5, ph * S), this.see(th.dark ? '#546170' : '#c9d6e3', 0.8), p.x, p.y, 0.75);
        break;
      }
      case 'counter': {
        // Desk-height worktop inside; on the outer edge a raised panel with a ledge, like a real station.
        const along = pw >= ph ? 'x' : 'z';
        const len = (along === 'x' ? pw : ph) * S;
        const depth = (along === 'x' ? ph : pw) * S;
        const g = this.local(p.x, p.y, along === 'x' ? 0 : Math.PI / 2);
        const out = along === 'x' ? Math.cos(rot) : Math.sin(rot); // +1: outer edge on the group's +z side
        const u = (m: number) => m / S;
        this.put(this.box(len, 0.74, depth), this.mat(th.dark ? '#4b4640' : '#e9e4da'), 0, 0, 0.37, 0, true, g);
        this.put(this.box(len + 0.04, 0.04, depth + 0.04), this.mat(th.wood), 0, 0, 0.76, 0, true, g);
        this.put(this.box(len, 0.42, 0.06), this.mat(th.dark ? '#5a544c' : '#f3efe6'), 0, u(out * (depth / 2 - 0.03)), 0.99, 0, true, g);
        this.put(this.box(len + 0.06, 0.04, 0.3), this.mat(th.wood), 0, u(out * (depth / 2 + 0.05)), 1.2, 0, true, g);
        this.put(this.box(len, 0.08, 0.005), this.mat(th.dark ? '#3f7f78' : '#5fa8a0'), 0, u(out * (depth / 2 + 0.003)), 0.55, 0, false, g);
        break;
      }
      case 'workstation': {
        const g = this.local(p.x, p.y, rot);
        const u = (m: number) => m / S;
        this.put(this.box(0.05, 0.25, 0.05), this.mat('#2a2d31'), 0, u(-0.06), 0.9, 0, false, g);
        this.put(this.box(0.52, 0.32, 0.03), this.mat('#1e2226'), 0, u(-0.08), 1.1, 0, true, g);
        this.put(new THREE.PlaneGeometry(0.48, 0.28), this.screenMaterial(), 0, u(-0.063), 1.1, 0, false, g);
        this.put(this.box(0.42, 0.02, 0.14), this.mat('#2a2d31'), 0, u(0.12), 0.79, 0, false, g);
        this.put(this.box(0.06, 0.02, 0.09), this.mat('#2a2d31'), u(0.3), u(0.12), 0.79, 0, false, g);
        break;
      }
      case 'officeChair': {
        const g = this.local(p.x, p.y, rot);
        const u = (m: number) => m / S;
        const fabric = this.mat(th.dark ? '#2f3b4a' : '#3d4e63');
        this.put(this.box(0.48, 0.08, 0.46), fabric, 0, 0, 0.48, 0, true, g);
        this.put(this.box(0.46, 0.5, 0.07), fabric, 0, u(-0.24), 0.8, 0, true, g);
        this.put(this.cyl(0.03, 0.03, 0.38, 6), this.mat(th.metal), 0, 0, 0.27, 0, false, g);
        for (let i = 0; i < 5; i++) {
          const a = (i / 5) * Math.PI * 2;
          const leg = this.put(this.box(0.05, 0.04, 0.3), this.mat('#2a2d31'), u(Math.sin(a) * 0.14), u(Math.cos(a) * 0.14), 0.07, a, false, g);
          leg.castShadow = false;
          this.put(new THREE.SphereGeometry(0.03, 6, 4), this.mat('#1d1d1d'), u(Math.sin(a) * 0.28), u(Math.cos(a) * 0.28), 0.03, 0, false, g);
        }
        break;
      }
      case 'printer': {
        this.put(this.box(0.46, 0.3, 0.4), this.mat(th.dark ? '#7a7f86' : '#d9dcdf'), p.x, p.y, 0.93);
        this.put(this.box(0.3, 0.02, 0.2), this.mat('#ffffff'), p.x, p.y + 2, 1.09, 0, false);
        break;
      }
      case 'phone': {
        this.put(this.box(0.2, 0.06, 0.18), this.mat('#2a2d31'), p.x, p.y, 0.81, 0, false);
        this.put(this.box(0.2, 0.04, 0.05), this.mat('#1d1d1d'), p.x, p.y - 3, 0.86, 0, false);
        break;
      }
      case 'pyxis': {
        // Automated medicine cabinet: drawers under a touch screen.
        const g = this.local(p.x, p.y, rot);
        const u = (m: number) => m / S;
        this.put(this.box(0.9, 1.6, 0.6), this.mat(th.dark ? '#9aa3ab' : '#e7eaed'), 0, 0, 0.8, 0, true, g);
        for (let i = 0; i < 5; i++) this.put(this.box(0.8, 0.14, 0.02), this.mat(i % 2 ? '#4f7fb5' : '#6b93c2'), 0, u(0.31), 0.25 + i * 0.2, 0, false, g);
        this.put(new THREE.PlaneGeometry(0.4, 0.28), this.screenMaterial(), 0, u(0.305), 1.35, 0, false, g);
        break;
      }
      case 'board': {
        // The patient tracking board: a big screen on a stand listing who is in which bed.
        const g = this.local(p.x, p.y, rot);
        const u = (m: number) => m / S;
        this.put(this.cyl(0.05, 0.05, 1.5, 8), this.mat(th.metal), 0, 0, 0.75, 0, true, g);
        this.put(this.box(0.6, 0.04, 0.4), this.mat(th.metal), 0, 0, 0.02, 0, false, g);
        this.put(this.box(2.0, 1.2, 0.08), this.mat('#16191d'), 0, 0, 2.05, 0, true, g);
        const tex = this.boardTexture();
        this.put(new THREE.PlaneGeometry(1.9, 1.1), new THREE.MeshBasicMaterial({ map: tex }), 0, u(0.045), 2.05, 0, false, g);
        break;
      }
      case 'hangingSign': {
        this.sign(p.label ?? 'Station', p.x, p.y, 2.75, 2.2, css('--accent', '#2553c9'));
        for (const dx of [-18, 18]) this.put(this.cyl(0.006, 0.006, 0.5, 4), this.mat('#888888'), p.x + dx, p.y, 3.15, 0, false);
        break;
      }
      case 'scanner': {
        // CT scanner: gantry ring and a sliding table.
        const g = this.local(p.x, p.y, rot);
        const u = (m: number) => m / S;
        const ring = this.put(new THREE.TorusGeometry(0.75, 0.32, 12, 28), this.mat('#eef0f2'), 0, 0, 1.1, 0, true, g);
        ring.rotation.y = Math.PI / 2;
        this.put(this.box(0.3, 1.3, 1.6), this.mat('#eef0f2'), 0, 0, 0.65, 0, true, g).rotation.y = Math.PI / 2;
        this.put(this.box(0.6, 0.12, 2.2), this.mat('#d6dde5'), 0, u(1.2), 0.85, 0, true, g);
        this.put(this.box(0.4, 0.7, 1.2), this.mat('#c9d2dc'), 0, u(1.3), 0.4, 0, true, g);
        break;
      }
      case 'bench': {
        // Lab bench: cabinets, a worktop, a microscope and an analyser.
        const g = this.local(p.x, p.y, rot);
        const u = (m: number) => m / S;
        const len = Math.max(pw, ph) * S;
        this.put(this.box(len, 0.86, 0.7), this.mat(th.dark ? '#5a6068' : '#dfe4e8'), 0, 0, 0.43, 0, true, g);
        this.put(this.box(len + 0.04, 0.04, 0.74), this.mat('#2d3238'), 0, 0, 0.88, 0, true, g);
        this.put(this.box(0.25, 0.4, 0.3), this.mat('#f1f1f1'), u(-len / 4), 0, 1.1, 0, true, g);
        this.put(this.cyl(0.03, 0.03, 0.3, 6), this.mat('#2a2a2a'), u(-len / 4), u(0.05), 1.35, 0, false, g);
        this.put(this.box(0.5, 0.45, 0.45), this.mat('#e8ecef'), u(len / 5), 0, 1.13, 0, true, g);
        this.put(new THREE.PlaneGeometry(0.2, 0.12), this.screenMaterial(), u(len / 5), u(0.23), 1.2, 0, false, g);
        break;
      }
      case 'reception': {
        this.put(this.box(pw * S, 1.1, ph * S), this.mat(th.wood), p.x, p.y, 0.55);
        this.put(this.box(pw * S + 0.1, 0.05, ph * S + 0.2), this.mat(th.dark ? '#d8d2c4' : '#f5f1e8'), p.x, p.y, 1.12);
        this.put(this.box(0.44, 0.28, 0.03), this.mat('#1e2226'), p.x - 10, p.y - 4, 1.35);
        this.sign(p.label ?? 'Reception', p.x, p.y - ph / 2 - 1, 1.75, 1.6, css('--accent', '#2553c9'));
        break;
      }
      case 'plant': {
        this.put(this.cyl(0.2, 0.15, 0.4, 10), this.mat('#9a6b4a'), p.x, p.y, 0.2);
        const leaf = this.mat(th.dark ? '#2f5a36' : '#4f8a57');
        this.put(new THREE.IcosahedronGeometry(0.35, 0), leaf, p.x, p.y, 0.75);
        this.put(new THREE.IcosahedronGeometry(0.25, 0), leaf, p.x + 4, p.y - 3, 1.05);
        break;
      }
      case 'vending': {
        this.put(this.box(0.9, 1.9, 0.75), this.mat('#b3261e'), p.x, p.y, 0.95, rot);
        this.put(new THREE.PlaneGeometry(0.6, 1.1), this.mat('#e8f1ff'), p.x + Math.sin(rot) * 7.7, p.y + Math.cos(rot) * 7.7, 1.15, rot, false);
        break;
      }
      case 'water': {
        this.put(this.box(0.35, 1.0, 0.35), this.mat('#e9ecef'), p.x, p.y, 0.5, rot);
        this.put(this.cyl(0.14, 0.14, 0.4, 12), this.see('#7fb8ff', 0.7), p.x, p.y, 1.2);
        break;
      }
      case 'shelves': {
        this.put(this.box(pw * S, 1.8, ph * S), this.mat(th.dark ? '#5a6068' : '#cfd6dc'), p.x, p.y, 0.9);
        break;
      }
      case 'elevator': {
        // Two lift doors at the top of the corridor, up to the wards.
        for (const dx of [-12, 12]) {
          this.put(this.box(1.0, 2.1, 0.15), this.mat('#aab2ba'), p.x + dx, p.y - 8, 1.05);
          this.put(this.box(0.02, 2.0, 0.16), this.mat('#6b737b'), p.x + dx, p.y - 8, 1.0, 0, false);
        }
        this.put(this.box(2.6, 0.3, 0.2), this.mat(th.dark ? '#4a4d52' : '#8a929a'), p.x, p.y - 8, 2.25);
        this.label(p.label ?? 'To the wards', p.x + 26, p.y - 16, 100, css('--boarding', '#7b4bd6'));
        break;
      }
      case 'road': {
        this.put(this.box(pw * S, 0.02, ph * S), this.mat(th.dark ? '#26282b' : '#8d9196'), p.x, p.y, 0.005, 0, false);
        for (let y = p.y - ph / 2 + 20; y < p.y + ph / 2; y += 60) this.put(this.box(0.15, 0.021, 1.5), this.mat('#f2f2f2'), p.x + pw * 0.25, y, 0.006, 0, false);
        break;
      }
      case 'parking': {
        this.put(this.box(pw * S, 0.02, ph * S), this.mat(th.dark ? '#26282b' : '#9a9ea3'), p.x, p.y, 0.005, 0, false);
        const stalls = Math.floor(pw / 50);
        const cars = ['#c0392b', '#2c3e50', '#bdc3c7', '#16a085', '#f5f5f5', '#34495e', '#8e44ad', '#d35400'];
        for (let i = 0; i <= stalls; i++) {
          const x = p.x - pw / 2 + 10 + i * 50;
          for (const row of [-1, 1]) {
            const y = p.y + row * (ph / 4);
            this.put(this.box(0.1, 0.021, 2.4), this.mat('#f2f2f2'), x, y, 0.006, 0, false);
            if (i < stalls && (i * 7 + (row + 1) * 3) % 5 !== 0) this.car(x + 25, y, cars[(i * 3 + row + 3) % cars.length]!, row > 0 ? Math.PI : 0);
          }
        }
        break;
      }
      case 'tree': {
        this.put(this.cyl(0.12, 0.16, 1.4, 8), this.mat('#6b4b35'), p.x, p.y, 0.7);
        const leaf = this.mat(th.dark ? '#24452a' : '#5d9a61');
        this.put(new THREE.IcosahedronGeometry(1.1, 0), leaf, p.x, p.y, 2.1);
        this.put(new THREE.IcosahedronGeometry(0.8, 0), leaf, p.x + 8, p.y + 6, 2.6);
        break;
      }
      case 'sign': {
        // A canopy over the entrance with the red EMERGENCY sign on its front edge.
        this.put(this.box(6, 0.2, 3), this.mat(th.dark ? '#3b3935' : '#f3f1ec'), p.x, p.y + 30, 2.6);
        for (const dx of [-55, 55]) this.put(this.cyl(0.08, 0.08, 2.6, 8), this.mat(th.metal), p.x + dx, p.y + 58, 1.3);
        this.sign(p.label ?? 'EMERGENCY', p.x, p.y + 60, 2.95, 4.2, '#c62828');
        break;
      }
      case 'ambulance': {
        const g = new THREE.Group();
        g.position.set(p.x * S, 0, p.y * S);
        g.rotation.y = rot;
        this.world.add(g);
        const u = (m: number) => m / S;
        const white = this.mat('#f7f7f5');
        const red = this.mat('#c62828');
        this.put(this.box(2.1, 2.2, 3.6), white, 0, u(0.6), 1.5, 0, true, g);
        this.put(this.box(2.0, 1.5, 1.6), white, 0, u(-2.0), 1.15, 0, true, g);
        this.put(this.box(1.9, 0.6, 0.05), this.mat('#8ab4d8'), 0, u(-2.81), 1.5, 0, false, g);
        for (const side of [-1, 1]) {
          this.put(this.box(0.02, 0.3, 3.6), red, u(side * 1.06), u(0.6), 1.2, 0, false, g);
          this.put(this.box(0.02, 0.45, 0.45), red, u(side * 1.06), u(1.2), 1.9, 0, false, g);
          for (const z of [-2.0, 1.4]) this.put(this.cyl(0.4, 0.4, 0.3, 14), this.mat('#1d1d1d'), u(side * 0.95), u(z), 0.4, 0, true, g).rotation.z = Math.PI / 2;
        }
        // Light bar: red and blue, flashing while casualties are coming in.
        for (const dx of [-0.5, -0.17, 0.17, 0.5]) this.beacons.push(this.put(this.box(0.3, 0.14, 0.24), this.mat('#5a5a5a'), u(dx), u(-1.3), 2.67, 0, false, g));
        break;
      }
    }
  }

  private car(x: number, y: number, color: string, rot: number) {
    const g = new THREE.Group();
    g.position.set(x * S, 0, y * S);
    g.rotation.y = rot;
    this.world.add(g);
    const u = (m: number) => m / S;
    this.put(this.box(1.8, 0.6, 4.2), this.mat(color), 0, 0, 0.55, 0, true, g);
    this.put(this.box(1.6, 0.5, 2.2), this.mat(color), 0, u(0.2), 1.05, 0, true, g);
    this.put(this.box(1.62, 0.4, 2.0), this.mat('#2a3440'), 0, u(0.2), 1.05, 0, false, g);
    for (const sx of [-1, 1])
      for (const sz of [-1.3, 1.3]) this.put(this.cyl(0.33, 0.33, 0.25, 12), this.mat('#1d1d1d'), u(sx * 0.85), u(sz), 0.33, 0, false, g).rotation.z = Math.PI / 2;
  }

  /** An upright sign facing the camera side. */
  private sign(text: string, x: number, y: number, elev: number, width: number, color: string) {
    const c = document.createElement('canvas');
    const g = c.getContext('2d')!;
    g.font = '800 64px system-ui, sans-serif';
    const tw = Math.ceil(g.measureText(text).width) + 48;
    c.width = tw;
    c.height = 96;
    g.fillStyle = color;
    g.beginPath();
    g.roundRect(0, 0, tw, 96, 14);
    g.fill();
    g.fillStyle = '#ffffff';
    g.font = '800 64px system-ui, sans-serif';
    g.textBaseline = 'middle';
    g.fillText(text, 24, 52);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const h = (width * 96) / tw;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(width, h), new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide }));
    m.position.set(x * S, elev, y * S);
    this.world.add(m);
  }

  /** Text painted on the floor (or on a surface at height `elev`). */
  private label(text: string, x: number, y: number, maxW: number, color = css('--ink-2', '#4a4843'), align: 'left' | 'right' | 'up' = 'left', elev = 0.06) {
    if (maxW < 12) return;
    const c = document.createElement('canvas');
    const px = 48;
    const g = c.getContext('2d')!;
    g.font = `700 ${px}px system-ui, sans-serif`;
    const tw = Math.ceil(g.measureText(text).width) + 8;
    c.width = tw;
    c.height = px + 16;
    g.font = `700 ${px}px system-ui, sans-serif`;
    g.fillStyle = color;
    g.textBaseline = 'top';
    g.fillText(text, 4, 6);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    const h = Math.min(align === 'up' ? 16 : 22, (maxW * c.height) / tw);
    const w = (h * tw) / c.height;
    if (align === 'right') x -= w;
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w * S, h * S), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
    if (align === 'up') {
      m.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
      m.position.set(x * S, elev, (y - w / 2) * S);
    } else {
      m.rotation.x = -Math.PI / 2;
      m.position.set((x + w / 2) * S, elev, (y + h / 2) * S);
    }
    this.world.add(m);
  }
}

/** A curtain: a plane with folds, width along local x. */
function curtainGeometry(width: number, height: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(width, height, Math.max(4, Math.round(width / 0.08)), 1);
  const pos = g.attributes.position!;
  for (let i = 0; i < pos.count; i++) pos.setZ(i, Math.sin((pos.getX(i) / 0.16) * Math.PI) * 0.035);
  g.computeVertexNormals();
  return g;
}

function themeNow(): Theme {
  const bg = new THREE.Color(css('--canvas-bg', '#ecebe5'));
  const dark = bg.getHSL({ h: 0, s: 0, l: 0 }).l < 0.3;
  return {
    dark,
    wall: dark ? '#3b3935' : '#fbfaf6',
    curtain: dark ? '#4f7f79' : '#9fcfc8',
    gown: dark ? '#7f9cc2' : '#a9c6e8',
    blanket: dark ? '#6a86b0' : '#c9daf0',
    metal: dark ? '#8a9096' : '#b8bec4',
    wood: dark ? '#6b5a48' : '#c9b79c',
  };
}

function roomKind(a: Area): string {
  if (a.kind) return ['waiting', 'triage', 'acute', 'fastTrack', 'trauma'].includes(a.kind) ? a.kind : 'station';
  return a.id === 'main' ? 'acute' : a.id;
}

/** Everything static the world is built from; people, occupancy and curtains are left out. */
function structureKey(plan: FloorPlan): string {
  const r = (n: number) => Math.round(n);
  return [
    plan.areas.map((a) => `${a.id}:${r(a.x)},${r(a.y)},${r(a.w)},${r(a.h)}`).join(';'),
    plan.beds.map((b) => `${r(b.x)},${r(b.y)},${r(b.w)},${b.trauma ? 't' : ''}`).join(';'),
    plan.seats.length,
    plan.grid?.cells.length ?? 0,
    plan.props?.length ?? 0,
    plan.bays?.length ?? 0,
  ].join('|');
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
