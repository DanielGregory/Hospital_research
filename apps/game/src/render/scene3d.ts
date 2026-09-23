/**
 * 3D view of a FloorPlan (three.js). Rooms, low cut-away walls, beds and chairs are built once
 * per plan structure; people are posed every frame from the crowd's walking animation.
 * Reads plan and actors only: no sim logic.
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { acuityColor, css, inkOn, roleColor, roleLetter } from './draw';
import type { Area, FloorPlan } from './floorPlan';
import type { Actor } from './motion';

/** Metres per plan unit. The 3D view lays plans out at 20 units per metre. */
export const PLAN_SCALE = 1 / 20;
const S = PLAN_SCALE;
const WALL_H = 1.05;
const WALL_T = 0.12;
const BED_TOP = 0.5;
const SKIN = ['#f1c7a5', '#e3b08c', '#c68a61', '#8d5a3b', '#5c3a24'];

/** Shared geometry for people, built on first use. */
let geo: ReturnType<typeof buildGeometry> | null = null;
function buildGeometry() {
  const leg = new THREE.BoxGeometry(0.13, 0.8, 0.15);
  leg.translate(0, -0.4, 0);
  const arm = new THREE.BoxGeometry(0.09, 0.58, 0.1);
  arm.translate(0, -0.29, 0);
  const ring = new THREE.RingGeometry(0.38, 0.47, 28);
  ring.rotateX(-Math.PI / 2);
  return {
    torso: new THREE.CapsuleGeometry(0.17, 0.34, 4, 10),
    head: new THREE.SphereGeometry(0.12, 14, 10),
    hair: new THREE.SphereGeometry(0.125, 14, 8, 0, Math.PI * 2, 0, Math.PI / 2),
    leg,
    arm,
    ring,
  };
}

class Figure {
  readonly root = new THREE.Group();
  readonly body = new THREE.Group();
  readonly legs: THREE.Group[] = [];
  readonly arms: THREE.Group[] = [];
  readonly badge: THREE.Sprite;
  readonly ring: THREE.Mesh;
  heading = 0;
  lying = 0;
  sitting = 0;
  styleKey = '';

  constructor(
    private readonly scene: Scene3D,
    readonly key: string,
  ) {
    const g = (geo ??= buildGeometry());
    this.root.add(this.body);
    const torso = new THREE.Mesh(g.torso);
    torso.position.y = 1.2;
    const head = new THREE.Mesh(g.head);
    head.position.y = 1.68;
    const hair = new THREE.Mesh(g.hair);
    hair.position.y = 1.7;
    this.body.add(torso, head, hair);
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
    this.badge = new THREE.Sprite();
    this.badge.scale.set(0.46, 0.46, 1);
    this.badge.renderOrder = 10;
    this.ring = new THREE.Mesh(g.ring);
    this.ring.position.y = 0.03;
    this.root.add(this.badge, this.ring);
  }

  /** Colours and badge; rebuilt only when what they show changes. */
  style(a: Actor) {
    const key =
      a.kind === 'patient'
        ? `p|${a.data.acuity ?? '-'}|${a.data.boarding}|${a.data.special}|${a.data.waited > 120}`
        : `s|${a.data.role}|${a.data.busy}|${a.data.leaving}`;
    if (key === this.styleKey) return;
    this.styleKey = key;
    const id = a.data.id;
    const skin = this.scene.mat(SKIN[(id * 7) % SKIN.length]!);
    const hair = this.scene.mat(['#2b211c', '#5a3a22', '#a67c52', '#1b1b1b', '#8c8c8c'][(id * 3) % 5]!);
    let shirt: string;
    let trousers: string;
    let badge: THREE.SpriteMaterial;
    let ring: string | null = null;
    if (a.kind === 'patient') {
      shirt = acuityColor(a.data.acuity);
      trousers = ['#4a5468', '#5b5147', '#3d4a3f', '#56607a'][(id * 5) % 4]!;
      badge = this.scene.badge(a.data.acuity === undefined ? '' : String(a.data.acuity), shirt, 'circle');
      if (a.data.boarding) ring = css('--boarding', '#7b4bd6');
      else if (a.data.special === 'massCasualty') ring = css('--fail', '#b3261e');
      else if (a.data.waited > 120) ring = css('--ink', '#1d1c19');
    } else {
      shirt = roleColor(a.data.role);
      trousers = shirt;
      badge = this.scene.badge(roleLetter(a.data.role), shirt, a.data.busy ? 'square' : 'hollow');
    }
    const [torso, head, hairMesh] = this.body.children as THREE.Mesh[];
    torso!.material = this.scene.mat(shirt);
    head!.material = skin;
    hairMesh!.material = hair;
    for (const l of this.legs) (l.children[0] as THREE.Mesh).material = this.scene.mat(trousers);
    for (const l of this.arms) (l.children[0] as THREE.Mesh).material = this.scene.mat(shirt);
    this.badge.material = badge;
    this.ring.visible = ring !== null;
    if (ring) this.ring.material = this.scene.mat(ring, true);
  }

  pose(a: Actor, dt: number, t: number, faceTo: { x: number; y: number } | null, seated: boolean) {
    this.root.position.set(a.x * S, 0, a.y * S);
    const settled = !a.moving && a.path.length === 0;
    const lying = a.kind === 'patient' && a.data.inBed && settled;
    const sitting = !lying && seated && settled;
    const k = 1 - Math.exp(-dt * 8);
    this.lying += ((lying ? 1 : 0) - this.lying) * k;
    this.sitting += ((sitting ? 1 : 0) - this.sitting) * k;

    // Facing: where they walk; at rest, towards their patient, else towards the camera side (+z).
    let want = this.heading;
    if (a.moving) want = a.heading;
    else if (faceTo) want = Math.atan2(faceTo.x - a.x, faceTo.y - a.y);
    else if (!lying) want = 0;
    if (lying) want = 0;
    this.heading = lerpAngle(this.heading, want, 1 - Math.exp(-dt * 10));
    this.root.rotation.y = this.heading;

    // Gait: legs and arms swing with distance walked, and the body bobs.
    const phase = ((a.stride * S) / 0.7) * Math.PI;
    const swing = a.moving ? Math.sin(phase) : 0;
    const breathe = Math.sin(t * 1.8 + a.data.id) * 0.015;
    this.legs[0]!.rotation.x = swing * 0.55 - this.sitting * 1.5;
    this.legs[1]!.rotation.x = -swing * 0.55 - this.sitting * 1.5;
    this.arms[0]!.rotation.x = -swing * 0.45 + breathe - this.sitting * 0.35;
    this.arms[1]!.rotation.x = swing * 0.45 - breathe - this.sitting * 0.35;
    const bob = a.moving ? Math.abs(Math.cos(phase)) * 0.04 : 0;

    // Lying on the bed: rotate the body flat, head towards the pillow (-x).
    this.body.rotation.z = (this.lying * Math.PI) / 2;
    this.body.position.set(this.lying * 0.84, bob - this.sitting * 0.4 + this.lying * (BED_TOP + 0.16), 0);
    this.badge.position.set(this.lying * -0.3, 2.08 - this.sitting * 0.4 - this.lying * 1.1, 0);
  }
}

export class Scene3D {
  readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(36, 1, 0.1, 400);
  private readonly controls: OrbitControls;
  private readonly world = new THREE.Group();
  private readonly people = new THREE.Group();
  private readonly figures = new Map<string, Figure>();
  private readonly materials = new Map<string, THREE.Material>();
  private readonly badges = new Map<string, THREE.SpriteMaterial>();
  private readonly sun = new THREE.DirectionalLight('#ffffff', 1.6);
  private readonly hemi = new THREE.HemisphereLight('#ffffff', '#b9b4a6', 1.25);
  private structureKey = '';
  private themeKey = '';
  private centre = new THREE.Vector3();
  private span = 20;
  private framed = false;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = 1.3;
    this.controls.minDistance = 4;
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(2048, 2048);
    this.sun.shadow.bias = -0.0004;
    this.sun.shadow.normalBias = 0.02;
    this.scene.add(this.hemi, this.sun, this.sun.target, this.world, this.people);
  }

  /** Cached flat-shaded material per colour. */
  mat(color: string, flat = false): THREE.Material {
    const key = `${color}|${flat}`;
    let m = this.materials.get(key);
    if (!m) {
      m = flat
        ? new THREE.MeshBasicMaterial({ color: new THREE.Color(color), transparent: true, opacity: 0.9, depthWrite: false })
        : new THREE.MeshLambertMaterial({ color: new THREE.Color(color) });
      this.materials.set(key, m);
    }
    return m;
  }

  /** Numbered (patients) or lettered (staff) badge floating above a head. */
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
    m = new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true });
    this.badges.set(key, m);
    return m;
  }

  resize(width: number, height: number) {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / Math.max(1, height);
    this.camera.updateProjectionMatrix();
  }

  /** Frame the whole floor from the front, looking down at an angle. */
  resetView() {
    const d = this.span * (this.camera.aspect < 1 ? 1.8 : 1.08);
    this.camera.position.set(this.centre.x, d * 0.86, this.centre.z + d * 0.55);
    this.controls.target.copy(this.centre);
    this.controls.maxDistance = this.span * 3;
    this.controls.update();
  }

  render(plan: FloorPlan, actors: readonly Actor[], dt: number, t: number) {
    const themeKey = ['--canvas-bg', '--esi-1', '--surface', '--staff'].map((v) => css(v, '')).join();
    if (themeKey !== this.themeKey) {
      this.themeKey = themeKey;
      this.clearCaches();
      this.structureKey = '';
    }
    const key = structureKey(plan);
    if (key !== this.structureKey) {
      this.structureKey = key;
      this.buildWorld(plan);
    }

    const seated = plan.seats.length > 0;
    const byKey = new Map(actors.map((a) => [a.key, a]));
    for (const [k, f] of this.figures)
      if (!byKey.has(k)) {
        this.people.remove(f.root);
        this.figures.delete(k);
      }
    for (const a of actors) {
      let f = this.figures.get(a.key);
      if (!f) {
        f = new Figure(this, a.key);
        this.figures.set(a.key, f);
        this.people.add(f.root);
      }
      f.style(a);
      const patient = a.kind === 'staff' && a.data.patientId !== undefined ? byKey.get(`p${a.data.patientId}`) : undefined;
      f.pose(a, dt, t, patient ? { x: patient.x, y: patient.y } : null, seated && a.kind === 'patient' && a.data.area === 'waiting');
    }
    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.controls.dispose();
    this.clearCaches();
    this.disposeWorld();
    this.renderer.dispose();
  }

  private clearCaches() {
    for (const m of this.materials.values()) m.dispose();
    for (const m of this.badges.values()) {
      m.map?.dispose();
      m.dispose();
    }
    this.materials.clear();
    this.badges.clear();
    for (const f of this.figures.values()) this.people.remove(f.root);
    this.figures.clear();
  }

  private disposeWorld() {
    this.world.traverse((o) => {
      if (o instanceof THREE.Mesh || o instanceof THREE.InstancedMesh) {
        o.geometry.dispose();
        const m = o.material as THREE.Material & { map?: THREE.Texture };
        if (!this.materialIsCached(m)) {
          m.map?.dispose();
          m.dispose();
        }
      }
    });
    this.world.clear();
  }

  private materialIsCached(m: THREE.Material): boolean {
    for (const c of this.materials.values()) if (c === m) return true;
    return false;
  }

  private buildWorld(plan: FloorPlan) {
    this.disposeWorld();
    const bg = css('--canvas-bg', '#ecebe5');
    this.scene.background = new THREE.Color(bg);
    const dark = new THREE.Color(bg).getHSL({ h: 0, s: 0, l: 0 }).l < 0.3;
    this.hemi.intensity = dark ? 1.1 : 1.25;
    this.hemi.groundColor = new THREE.Color(dark ? '#262320' : '#b9b4a6');
    this.sun.intensity = dark ? 1.0 : 1.6;

    // Extent of the building in plan units.
    const doorPts = Object.values(plan.nav.doors).map((d) => d.outside);
    const xs = [...plan.areas.flatMap((a) => [a.x, a.x + a.w]), ...(plan.grid?.cells.flatMap((c) => [c.x, c.x + c.w]) ?? []), ...doorPts.map((p) => p.x)];
    const ys = [...plan.areas.flatMap((a) => [a.y, a.y + a.h]), ...(plan.grid?.cells.flatMap((c) => [c.y, c.y + c.h]) ?? []), ...doorPts.map((p) => p.y)];
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    this.centre.set(((x0 + x1) / 2) * S, 0, ((y0 + y1) / 2) * S);
    this.span = Math.max(x1 - x0, y1 - y0) * S;
    const sh = this.sun.shadow.camera;
    sh.left = sh.bottom = -this.span * 0.8;
    sh.right = sh.top = this.span * 0.8;
    sh.near = 1;
    sh.far = this.span * 4;
    sh.updateProjectionMatrix();
    this.sun.position.set(this.centre.x - this.span * 0.5, this.span * 1.2, this.centre.z + this.span * 0.35);
    this.sun.target.position.copy(this.centre);

    // Ground and corridor floor.
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(this.span * 8, this.span * 8), new THREE.MeshLambertMaterial({ color: new THREE.Color(bg) }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set(this.centre.x, -0.01, this.centre.z);
    ground.receiveShadow = true;
    this.world.add(ground);
    const corridor = css('--corridor', '#e4e2da');
    if (plan.grid) {
      const tile = new THREE.BoxGeometry(1, 0.04, 1);
      const cells = new THREE.InstancedMesh(tile, new THREE.MeshLambertMaterial({ color: new THREE.Color(corridor) }), plan.grid.cells.length);
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

    // Rooms: a tinted floor, low walls with gaps at the doors, and a label on the floor.
    const wallMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(dark ? '#3b3935' : '#fbfaf6') });
    const capMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(css('--line-strong', '#cfcbc0')) });
    for (const a of plan.areas) {
      this.world.add(this.slab(a.x, a.y, a.w, a.h, css(`--room-${roomKind(a)}`, '#ffffff'), 0.03));
      this.walls(a, plan, wallMat, capMat);
      if (plan.grid) this.label(a.label, a.x + 4, a.y + 4, Math.min(a.w - 8, 90));
      // Default view: top right of each room, clear of the counters on the left.
      else if (a.id === 'waiting') this.label(a.label, a.x + 12, a.y + 8, Math.min(a.w - 24, 170));
      else this.label(a.label, a.x + a.w - 12, a.y + 8, Math.min(a.w * 0.4, 170), undefined, 'right');
    }

    // Beds: frame, mattress and pillow (pillow on the left, like the 2D view).
    const frame = new THREE.MeshLambertMaterial({ color: new THREE.Color(dark ? '#5d6470' : '#9aa3b0') });
    const sheet = new THREE.MeshLambertMaterial({ color: new THREE.Color(dark ? '#d8d6cf' : '#ffffff') });
    const pillow = new THREE.MeshLambertMaterial({ color: new THREE.Color(dark ? '#b7c4d9' : '#dfe8f5') });
    for (const b of plan.beds) {
      // Beds are about 2 m long; on a roomy plan, centre them under where the patient lies.
      const w = Math.min(b.w * S * 0.94, 2.1);
      const d = Math.min(b.h * S * 0.8, 1.1);
      const cx = w < 2.1 ? (b.x + b.w / 2) * S : (b.x + b.w * 0.58) * S - 0.05;
      const cz = (b.y + b.h / 2) * S;
      const base = new THREE.Mesh(new THREE.BoxGeometry(w, BED_TOP - 0.14, d), frame);
      base.position.set(cx, (BED_TOP - 0.14) / 2, cz);
      const mattress = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, 0.14, d * 0.96), sheet);
      mattress.position.set(cx, BED_TOP - 0.07, cz);
      const pil = new THREE.Mesh(new THREE.BoxGeometry(Math.min(0.4, w * 0.2), 0.08, d * 0.7), pillow);
      pil.position.set(cx - w / 2 + Math.min(0.24, w * 0.12), BED_TOP + 0.03, cz);
      const head = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, d), frame);
      head.position.set(cx - w / 2, 0.55, cz);
      for (const m of [base, mattress, pil, head]) {
        m.castShadow = m.receiveShadow = true;
        this.world.add(m);
      }
    }

    // Waiting-room chairs, facing the camera side.
    if (plan.seats.length) {
      const seatMat = new THREE.MeshLambertMaterial({ color: new THREE.Color(dark ? '#4b5a6b' : '#8fa3b8') });
      const seat = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.07, 0.44), seatMat, plan.seats.length);
      const back = new THREE.InstancedMesh(new THREE.BoxGeometry(0.46, 0.46, 0.06), seatMat, plan.seats.length);
      const m = new THREE.Matrix4();
      plan.seats.forEach((p, i) => {
        seat.setMatrixAt(i, m.makeTranslation(p.x * S, 0.44, p.y * S));
        back.setMatrixAt(i, m.makeTranslation(p.x * S, 0.7, p.y * S - 0.22));
      });
      seat.castShadow = back.castShadow = seat.receiveShadow = true;
      this.world.add(seat, back);
    }

    // Counters where free staff wait (default view): the triage desk and the staff station.
    if (!plan.grid) {
      const desk = new THREE.MeshLambertMaterial({ color: new THREE.Color(dark ? '#6b5a48' : '#c9b79c') });
      for (const a of plan.areas.filter((x) => x.id !== 'waiting')) {
        const len = Math.min(a.w * 0.5, 220);
        const m = new THREE.Mesh(new THREE.BoxGeometry(len * S, 0.95, 0.45), desk);
        m.position.set((a.x + 12 + len / 2) * S, 0.475, (a.y + (a.id === 'triage' ? 24 : 27)) * S);
        m.castShadow = m.receiveShadow = true;
        this.world.add(m);
      }
    }

    // Doors people use to come and go.
    const doors = plan.nav.doors;
    const marks: [typeof doors.entrance, string, string][] = [[doors.entrance, 'Entrance', css('--accent', '#2553c9')]];
    if (doors.ambulance !== doors.entrance) marks.push([doors.ambulance, 'Ambulance · staff', css('--fail', '#b3261e')]);
    if (doors.ward !== doors.entrance) marks.push([doors.ward, 'To the wards', css('--boarding', '#7b4bd6')]);
    for (const [d, text, color] of marks) {
      const mid = { x: (d.inside.x + d.outside.x) / 2, y: (d.inside.y + d.outside.y) / 2 };
      const mat = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.02, 1.6), new THREE.MeshLambertMaterial({ color: new THREE.Color(color) }));
      mat.position.set(mid.x * S, 0.02, mid.y * S);
      this.world.add(mat);
      // Side doors: label running up along the outside wall, from the mat; the entrance: beside the mat.
      if (d.outside.x > d.inside.x) this.label(text, mid.x, d.outside.y - 20, 120, color, 'up');
      else this.label(text, d.outside.x + 24, d.outside.y - 10, 130, color);
    }

    if (!this.framed) {
      this.resetView();
      this.framed = true;
    }
  }

  private slab(x: number, y: number, w: number, h: number, color: string, lift: number) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w * S, 0.04, h * S), new THREE.MeshLambertMaterial({ color: new THREE.Color(color) }));
    m.position.set((x + w / 2) * S, lift, (y + h / 2) * S);
    m.receiveShadow = true;
    return m;
  }

  /** Four walls around an area, with a gap wherever the plan has an opening on that wall. */
  private walls(a: Area, plan: FloorPlan, mat: THREE.Material, cap: THREE.Material) {
    const open = plan.nav.openings.filter((o) => o.area === a.id);
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
          const w = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? len : WALL_T, WALL_H, horizontal ? WALL_T : len), mat);
          const top = new THREE.Mesh(new THREE.BoxGeometry(horizontal ? len : WALL_T + 0.02, 0.03, horizontal ? WALL_T + 0.02 : len), cap);
          const px = horizontal ? mid * S : e.x0 * S;
          const pz = horizontal ? e.y0 * S : mid * S;
          w.position.set(px, WALL_H / 2, pz);
          top.position.set(px, WALL_H + 0.015, pz);
          w.castShadow = w.receiveShadow = true;
          this.world.add(w, top);
        }
        start = Math.max(start, g1);
      }
    }
  }

  /** Text painted on the floor. */
  private label(text: string, x: number, y: number, maxW: number, color = css('--ink-2', '#4a4843'), align: 'left' | 'right' | 'up' = 'left') {
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
      // Reads away from the camera, ending at (x, y).
      m.rotation.set(-Math.PI / 2, 0, Math.PI / 2);
      m.position.set(x * S, 0.06, (y - w / 2) * S);
    } else {
      m.rotation.x = -Math.PI / 2;
      m.position.set((x + w / 2) * S, 0.06, (y + h / 2) * S);
    }
    this.world.add(m);
  }
}

function roomKind(a: Area): string {
  if (a.kind) return ['waiting', 'triage', 'acute', 'fastTrack'].includes(a.kind) ? a.kind : 'station';
  return a.id === 'main' ? 'acute' : a.id;
}

/** Everything static the world is built from; people and bed occupancy are left out. */
function structureKey(plan: FloorPlan): string {
  const r = (n: number) => Math.round(n);
  return [
    plan.areas.map((a) => `${a.id}:${r(a.x)},${r(a.y)},${r(a.w)},${r(a.h)}`).join(';'),
    plan.beds.map((b) => `${r(b.x)},${r(b.y)},${r(b.w)}`).join(';'),
    plan.seats.length,
    plan.grid?.cells.length ?? 0,
  ].join('|');
}

function lerpAngle(a: number, b: number, t: number): number {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}
