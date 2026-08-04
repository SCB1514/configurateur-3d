import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/addons/controls/OrbitControls.js';
import { TransformControls } from '../vendor/three/addons/controls/TransformControls.js';
import { RoomEnvironment } from '../vendor/three/addons/environments/RoomEnvironment.js';

/* ============================================================
   Viewer — scène 3D, pose des blocs, sélection, manipulation.
   Repère Z-up, identique à Rhino. Unité interne : le mètre.
   ============================================================ */

const DEG = Math.PI / 180;
const UP = new THREE.Vector3(0, 0, 1);

export class Viewer {
  constructor(canvas, hooks = {}) {
    this.canvas = canvas;
    this.hooks = hooks;              // {onPlace, onSelect, onTransform, onCommit}
    this.lib = null;
    this.objects = new Map();        // uid -> THREE.Group
    this.gridStep = 0.1;
    this.snap = true;
    this.ghost = null;
    this.selected = null;
    this._materials = new Map();

    /* ---------- renderer ---------- */
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: false, preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    /* ---------- scène ---------- */
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e13);
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 2000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(4.5, -6.5, 4.2);

    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 0, 0.4);

    /* ---------- lumières ---------- */
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1a1f27, 1.1);
    this.scene.add(hemi);
    const sun = new THREE.DirectionalLight(0xffffff, 2.1);
    sun.position.set(6, -8, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.near = 1;
    sun.shadow.camera.far = 60;
    const d = 14;
    Object.assign(sun.shadow.camera, { left: -d, right: d, top: d, bottom: -d });
    sun.shadow.camera.updateProjectionMatrix();
    sun.shadow.bias = -0.0008;
    this.scene.add(sun);
    this.sun = sun;

    /* ---------- sol ---------- */
    const pad = new THREE.Mesh(
      new THREE.CircleGeometry(60, 64),
      new THREE.MeshBasicMaterial({ color: 0x121821 })
    );
    pad.position.z = -0.004;
    this.scene.add(pad);

    this.ground = new THREE.Mesh(
      new THREE.PlaneGeometry(400, 400),
      new THREE.ShadowMaterial({ opacity: 0.4 })
    );
    this.ground.receiveShadow = true;
    this.ground.name = '__ground';
    this.scene.add(this.ground);

    this.grid = new THREE.GridHelper(80, 80, 0x5d6b7d, 0x2e3946);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.material.transparent = true;
    this.grid.material.opacity = 0.85;
    this.grid.material.depthWrite = false;
    this.scene.add(this.grid);

    const axes = new THREE.Group();
    for (const [dir, col] of [[new THREE.Vector3(1, 0, 0), 0xff5f6a], [new THREE.Vector3(0, 1, 0), 0x5fd68a]]) {
      const g = new THREE.BufferGeometry().setFromPoints([
        dir.clone().multiplyScalar(-40), dir.clone().multiplyScalar(40),
      ]);
      axes.add(new THREE.Line(g, new THREE.LineBasicMaterial({
        color: col, transparent: true, opacity: 0.32, depthWrite: false,
      })));
    }
    axes.position.z = 0.002;
    this.scene.add(axes);

    /* ---------- gizmo ---------- */
    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSpace('world');
    this.gizmo.setSize(0.85);
    this.gizmo.addEventListener('dragging-changed', e => {
      this.controls.enabled = !e.value;
      if (!e.value) { this.clearSnapHints(); this.hooks.onCommit?.(); }
    });
    this.gizmo.addEventListener('objectChange', () => this._readTransform());
    this.gizmo.visible = false;
    this.scene.add(this.gizmo);
    this.editable = true;
    this.setTool('translate');
    this.setSnap(true);

    /* ---------- repères de connexion ---------- */
    this.magnet = true;
    this.snapMarker = new THREE.Mesh(
      new THREE.TorusGeometry(0.055, 0.011, 8, 24),
      new THREE.MeshBasicMaterial({ color: 0x3ecf8e, depthTest: false, transparent: true })
    );
    this.snapMarker.renderOrder = 998;
    this.snapMarker.visible = false;
    this.scene.add(this.snapMarker);

    this.hintDots = new THREE.Points(
      new THREE.BufferGeometry(),
      new THREE.PointsMaterial({
        color: 0x3ecf8e, size: 0.07, sizeAttenuation: true,
        transparent: true, opacity: 0.85, depthTest: false,
      })
    );
    this.hintDots.renderOrder = 997;
    this.hintDots.visible = false;
    this.scene.add(this.hintDots);

    /* ---------- contour de sélection ---------- */
    this.selBox = new THREE.Box3Helper(new THREE.Box3(), 0x3d8bff);
    this.selBox.visible = false;
    if (this.selBox.material) { this.selBox.material.depthTest = false; this.selBox.material.transparent = true; }
    this.selBox.renderOrder = 999;
    this.scene.add(this.selBox);

    /* ---------- interaction ---------- */
    this.ray = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this._down = null;
    canvas.addEventListener('pointerdown', e => this._onDown(e));
    canvas.addEventListener('pointermove', e => this._onMove(e));
    canvas.addEventListener('pointerup', e => this._onUp(e));
    canvas.addEventListener('pointerleave', () => { if (this.ghost) this.ghost.visible = false; });

    const ro = new ResizeObserver(() => this.resize());
    ro.observe(canvas.parentElement);
    this.resize();
    this._loop();
  }

  /* ══════════ cycle ══════════ */
  resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  _loop = () => {
    requestAnimationFrame(this._loop);
    this.controls.update();
    if (this.selected) this.selBox.box.setFromObject(this.selected);
    this.renderer.render(this.scene, this.camera);
  };

  setLibrary(lib) {
    this.lib = lib;
    this.gridStep = lib.gridStep || 0.1;
    if (this.gizmo) this.gizmo.setTranslationSnap(this.snap ? this.gridStep : null);
  }

  /* ══════════ matériaux ══════════ */
  _material(part, finishColor) {
    const color = finishColor && part.paintable ? finishColor : part.color;
    const key = `${color}|${part.opacity}|${part.metalness}|${part.roughness}`;
    let m = this._materials.get(key);
    if (!m) {
      m = new THREE.MeshStandardMaterial({
        color: new THREE.Color(color),
        metalness: part.metalness,
        roughness: part.roughness,
        transparent: part.opacity < 1,
        opacity: part.opacity,
        side: THREE.DoubleSide,
      });
      this._materials.set(key, m);
    }
    return m;
  }

  _build(block, finishColor) {
    const g = new THREE.Group();
    for (const p of block.parts) {
      const mesh = new THREE.Mesh(p.geometry, this._material(p, finishColor));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.paintable = p.paintable;
      g.add(mesh);
    }
    return g;
  }

  /* ══════════ instances ══════════ */
  addItem(item) {
    const block = this.lib.block(item.blockId);
    if (!block) return null;
    const finish = block.finishes.find(f => f.id === item.finish);
    const obj = this._build(block, finish?.color);
    obj.userData.uid = item.uid;
    obj.userData.blockId = item.blockId;
    this._applyTransform(obj, item, block);
    this.scene.add(obj);
    this.objects.set(item.uid, obj);
    return obj;
  }

  updateItem(item) {
    const old = this.objects.get(item.uid);
    if (!old) return this.addItem(item);
    const wasSelected = this.selected === old;
    this.removeItem(item.uid);
    const obj = this.addItem(item);
    if (wasSelected) this.select(item.uid);
    return obj;
  }

  removeItem(uid) {
    const obj = this.objects.get(uid);
    if (!obj) return;
    if (this.selected === obj) this.select(null);
    this.scene.remove(obj);
    this.objects.delete(uid);
  }

  clear() {
    this.select(null);
    for (const uid of [...this.objects.keys()]) this.removeItem(uid);
  }

  syncAll(items) {
    const keep = new Set(items.map(i => i.uid));
    for (const uid of [...this.objects.keys()]) if (!keep.has(uid)) this.removeItem(uid);
    for (const it of items) {
      if (this.objects.has(it.uid)) {
        const obj = this.objects.get(it.uid);
        if (obj.userData.finish !== it.finish) this.updateItem(it);
        else this._applyTransform(obj, it, this.lib.block(it.blockId));
      } else this.addItem(it);
    }
  }

  _applyTransform(obj, item, block) {
    obj.position.set(item.pos[0], item.pos[1], item.pos[2] + (block?.baseOffset || 0));
    obj.rotation.set(0, 0, (item.rot || 0) * DEG);
    const s = item.scale || 1;
    obj.scale.set(s, s, s);
    obj.userData.finish = item.finish;
  }

  _readTransform() {
    const obj = this.selected;
    if (!obj) return;
    const block = this.lib.block(obj.userData.blockId);

    // pendant un déplacement, le magnétisme reprend la main sur la grille
    if (this.tool === 'translate' && this.magnet && block?.connectors.length) {
      const snap = this.computeSnap(block, obj.position, obj.rotation.z / DEG, obj.userData.uid);
      if (snap) { obj.position.copy(snap.origin); obj.rotation.z = snap.yaw * DEG; }
      this.showSnapHints(block, snap, obj.userData.uid);
    }

    const off = block?.baseOffset || 0;
    let z = obj.position.z - off;
    if (Math.abs(z) < 1e-4) z = 0;
    this.hooks.onTransform?.(obj.userData.uid, {
      pos: [r4(obj.position.x), r4(obj.position.y), r4(z)],
      rot: r4(obj.rotation.z / DEG),
    });
  }

  /* ══════════ sélection ══════════ */
  select(uid) {
    const obj = uid ? this.objects.get(uid) : null;
    this.selected = obj || null;
    if (obj) {
      if (this.editable !== false) { this.gizmo.attach(obj); this.gizmo.visible = true; }
      this.selBox.box.setFromObject(obj);
      this.selBox.visible = true;
    } else {
      this.gizmo.detach();
      this.gizmo.visible = false;
      this.selBox.visible = false;
    }
    this.hooks.onSelect?.(obj ? obj.userData.uid : null);
  }

  setTool(tool) {
    this.tool = tool;
    this.gizmo.setMode(tool);
    if (tool === 'rotate') { this.gizmo.showX = false; this.gizmo.showY = false; this.gizmo.showZ = true; }
    else { this.gizmo.showX = this.gizmo.showY = this.gizmo.showZ = true; }
  }

  setSnap(on) {
    this.snap = on;
    this.gizmo.setTranslationSnap(on ? this.gridStep : null);
    this.gizmo.setRotationSnap(on ? 15 * DEG : null);
  }

  setEditable(on) {
    this.editable = on;
    if (!on) { this.gizmo.detach(); this.gizmo.visible = false; }
  }

  /* ══════════ magnétisme par points d'insertion ══════════
     Deux blocs porteurs du même point (A avec A, B avec B) se
     rejoignent : les points se superposent et les axes Z se font
     face. La rotation n'est corrigée qu'autour de Z — un point
     vertical (dessus / dessous) laisse donc l'orientation libre.
     ======================================================== */
  setMagnet(on) {
    this.magnet = on;
    if (!on) { this.snapMarker.visible = false; this.hintDots.visible = false; }
  }

  get snapTol() { return Math.max(this.gridStep * 0.5, 0.004); }
  get snapRadius() { return Math.max(this.gridStep * 8, 0.3); }

  /** Connecteurs d'un objet posé, en coordonnées monde. */
  worldConnectors(obj) {
    const block = this.lib?.block(obj.userData.blockId);
    if (!block || !block.connectors.length) return [];
    obj.updateMatrixWorld();
    return block.connectors.map(c => ({
      uid: obj.userData.uid,
      index: c.index,
      type: c.type,
      pos: c.pos.clone().applyMatrix4(obj.matrixWorld),
      dir: c.dir.clone().transformDirection(obj.matrixWorld).normalize(),
    }));
  }

  /** Tous les connecteurs posés, sauf ceux d'un objet donné. */
  allConnectors(excludeUid) {
    const out = [];
    for (const [uid, obj] of this.objects) {
      if (uid === excludeUid) continue;
      out.push(...this.worldConnectors(obj));
    }
    return out;
  }

  /** Un connecteur est occupé si un autre bloc en a un au même endroit. */
  isOccupied(conn, all) {
    const tol = this.snapTol;
    return (all || this.allConnectors(conn.uid))
      .some(o => o.uid !== conn.uid && o.type === conn.type && o.pos.distanceTo(conn.pos) <= tol);
  }

  freeConnectors(uid) {
    const obj = this.objects.get(uid);
    if (!obj) return [];
    const others = this.allConnectors(uid);
    return this.worldConnectors(obj).filter(c => !others.some(
      o => o.type === c.type && o.pos.distanceTo(c.pos) <= this.snapTol));
  }

  /** Lacet à appliquer pour mettre deux directions face à face. */
  _alignYaw(dirSrc, dirTgt, currentYawDeg) {
    const hs = Math.hypot(dirSrc.x, dirSrc.y);
    const ht = Math.hypot(dirTgt.x, dirTgt.y);
    if (hs < 0.25 || ht < 0.25) return currentYawDeg;      // connexion verticale
    const aSrc = Math.atan2(dirSrc.y, dirSrc.x);
    const aTgt = Math.atan2(-dirTgt.y, -dirTgt.x);          // en vis-à-vis
    let deg = (aTgt - aSrc) / DEG;
    deg = Math.round(deg * 1e3) / 1e3;
    return ((deg % 360) + 360) % 360;
  }

  /**
   * Cherche la meilleure connexion pour un bloc.
   * @param origin  position visée de l'objet (repère monde, avec baseOffset)
   * @returns {origin, yaw, target, source, d} ou null
   */
  computeSnap(block, origin, currentYawDeg, excludeUid, maxDist) {
    if (!this.magnet || !block?.connectors.length) return null;
    const all = this.allConnectors(excludeUid);
    const targets = all.filter(t => !this.isOccupied(t, all));
    if (!targets.length) return null;

    const radius = maxDist ?? this.snapRadius;
    let best = null;
    for (const t of targets) {
      for (const c of block.connectors) {
        if (c.type !== t.type) continue;
        const yaw = this._alignYaw(c.dir, t.dir, currentYawDeg);
        const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw * DEG);
        const o = t.pos.clone().sub(c.pos.clone().applyQuaternion(q));
        const d = o.distanceTo(origin);
        if (d <= radius && (!best || d < best.d)) best = { origin: o, yaw, target: t, source: c, d };
      }
    }
    return best;
  }

  /** Repères visuels : point de connexion trouvé + points libres compatibles. */
  showSnapHints(block, snap, excludeUid) {
    this.snapMarker.visible = !!snap;
    if (snap) {
      this.snapMarker.position.copy(snap.target.pos);
      this.snapMarker.quaternion.setFromUnitVectors(
        new THREE.Vector3(0, 0, 1), snap.target.dir.clone().normalize());
    }
    const types = new Set(block?.connectorTypes || []);
    if (!this.magnet || !types.size) { this.hintDots.visible = false; return; }
    const all = this.allConnectors(excludeUid);
    const pts = all.filter(c => types.has(c.type) && !this.isOccupied(c, all));
    if (!pts.length) { this.hintDots.visible = false; return; }
    const arr = new Float32Array(pts.length * 3);
    pts.forEach((c, i) => { arr[i * 3] = c.pos.x; arr[i * 3 + 1] = c.pos.y; arr[i * 3 + 2] = c.pos.z; });
    this.hintDots.geometry.dispose();
    this.hintDots.geometry = new THREE.BufferGeometry();
    this.hintDots.geometry.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    this.hintDots.visible = true;
  }

  clearSnapHints() {
    this.snapMarker.visible = false;
    this.hintDots.visible = false;
  }

  /**
   * Position d'un bloc accroché à un objet déjà posé (clic depuis le
   * panneau « compatibles » : aucune visée à la souris).
   * @returns {pos:[x,y,z], rot:deg, type} ou null
   */
  autoAttach(block, targetUid, wantedType) {
    const obj = this.objects.get(targetUid);
    if (!obj || !block.connectors.length) return null;
    const free = this.freeConnectors(targetUid)
      .filter(c => !wantedType || c.type === wantedType);

    const candidats = [];
    for (const t of free) {
      for (const c of block.connectors) {
        if (c.type !== t.type) continue;
        const yaw = this._alignYaw(c.dir, t.dir, 0);
        const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw * DEG);
        const o = t.pos.clone().sub(c.pos.clone().applyQuaternion(q));
        // coût de rotation : on préfère poser le bloc dans son orientation
        // d'origine (deux meubles côte à côte gardent leur façade devant)
        const tour = Math.min(Math.abs(yaw), 360 - Math.abs(yaw));
        candidats.push({ o, yaw, type: t.type, tour, vue: t.pos.distanceTo(this.camera.position) });
      }
    }
    candidats.sort((a, b) => (a.tour - b.tour) || (a.vue - b.vue));

    for (const k of candidats) {
      if (this._overlaps(block, k.o, k.yaw)) continue;
      return {
        pos: [r4(k.o.x), r4(k.o.y), r4(k.o.z - block.baseOffset)],
        rot: r4(k.yaw),
        type: k.type,
      };
    }
    return null;
  }

  /**
   * Chevauchement franc avec un bloc déjà posé.
   * On mesure le volume d'intersection : deux blocs qui se touchent
   * par une face (cas normal d'une connexion) ne comptent pas.
   */
  _overlaps(block, origin, yawDeg) {
    const eps = Math.max(this.gridStep * 0.3, 0.003);
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yawDeg * DEG);
    const center = block.bbox.getCenter(new THREE.Vector3()).applyQuaternion(q).add(origin);

    // emprise alignée sur les axes : X et Y s'échangent pour un quart de tour
    const quarter = Math.abs(Math.round(yawDeg / 90) % 2) === 1;
    const size = new THREE.Vector3(
      quarter ? block.size.y : block.size.x,
      quarter ? block.size.x : block.size.y,
      block.size.z);
    const box = new THREE.Box3().setFromCenterAndSize(center, size);

    const inter = new THREE.Box3();
    const s = new THREE.Vector3();
    for (const obj of this.objects.values()) {
      inter.setFromObject(obj).intersect(box).getSize(s);
      if (s.x > eps && s.y > eps && s.z > eps) return true;
    }
    return false;
  }

  /* ══════════ pose d'un bloc ══════════ */
  startPlacing(blockId, finish) {
    this.cancelPlacing();
    const block = this.lib.block(blockId);
    if (!block) return;
    const f = block.finishes.find(x => x.id === finish);
    const g = this._build(block, f?.color);
    g.traverse(o => {
      if (!o.isMesh) return;
      o.castShadow = false;
      o.material = o.material.clone();
      o.material.transparent = true;
      o.material.opacity = 0.55;
      o.material.depthWrite = false;
    });
    g.visible = false;
    this.scene.add(g);
    this.ghost = g;
    this.ghostBlock = block;
    this.ghostRot = 0;
    this.ghostFinish = finish;
    this.select(null);
  }

  cancelPlacing() {
    if (this.ghost) { this.scene.remove(this.ghost); this.ghost = null; this.ghostBlock = null; }
    this.clearSnapHints();
  }

  rotateGhost(deg) {
    if (!this.ghost) return;
    this.ghostRot = (this.ghostRot + deg) % 360;
    this.ghost.rotation.z = this.ghostRot * DEG;
  }

  /* point de pose sous le curseur : sur le sol, ou empilé sur un bloc existant */
  _dropPoint(ev) {
    this._setPointer(ev);
    this.ray.setFromCamera(this.pointer, this.camera);
    const hits = this.ray.intersectObjects([...this.objects.values()], true);
    let x, y, z = 0, stacked = false;
    if (hits.length) {
      const h = hits[0];
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
      x = h.point.x; y = h.point.y;
      if (n && n.z > 0.5) {
        const top = new THREE.Box3().setFromObject(rootOf(h.object, this.scene));
        z = top.max.z;                     // on empile sur la face supérieure
        stacked = true;                    // hauteur exacte : pas d'aimantation en Z
      }
    } else {
      const p = new THREE.Vector3();
      if (!this.ray.ray.intersectPlane(this._plane, p)) return null;
      x = p.x; y = p.y;
    }
    if (this.snap) {
      x = Math.round(x / this.gridStep) * this.gridStep;
      y = Math.round(y / this.gridStep) * this.gridStep;
      if (!stacked) z = Math.round(z / this.gridStep) * this.gridStep;
    }
    return { x: r4(x), y: r4(y), z: r4(z) };
  }

  /* ══════════ pointeur ══════════ */
  _setPointer(ev) {
    const r = this.canvas.getBoundingClientRect();
    this.pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    this.pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
  }

  _onDown(ev) { this._down = { x: ev.clientX, y: ev.clientY, t: performance.now() }; }

  _onMove(ev) {
    if (!this.ghost) return;
    const p = this._dropPoint(ev);
    if (!p) { this.ghost.visible = false; this.clearSnapHints(); return; }
    this.ghost.visible = true;
    const t = this._ghostTransform(p);
    this.ghost.position.copy(t.origin);
    this.ghost.rotation.z = t.yaw * DEG;
    this.showSnapHints(this.ghostBlock, t.snap, null);
  }

  /** Position/rotation du fantôme : magnétisme prioritaire sur la grille. */
  _ghostTransform(p) {
    const base = new THREE.Vector3(p.x, p.y, p.z + this.ghostBlock.baseOffset);
    const snap = this.computeSnap(this.ghostBlock, base, this.ghostRot, null);
    return snap
      ? { origin: snap.origin, yaw: snap.yaw, snap }
      : { origin: base, yaw: this.ghostRot, snap: null };
  }

  /** Objet sous le curseur, ou null. */
  pickAt(ev) {
    this._setPointer(ev);
    this.ray.setFromCamera(this.pointer, this.camera);
    const hits = this.ray.intersectObjects([...this.objects.values()], true);
    return hits.length ? rootOf(hits[0].object, this.scene).userData.uid : null;
  }

  _onUp(ev) {
    const d = this._down; this._down = null;
    if (!d) return;
    if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 5) return;   // orbite, pas un clic
    if (this.gizmo.dragging) return;

    if (this.ghost) {
      const p = this._dropPoint(ev);
      if (p) {
        const t = this._ghostTransform(p);
        this.hooks.onPlace?.({
          blockId: this.ghostBlock.id,
          pos: [r4(t.origin.x), r4(t.origin.y), r4(t.origin.z - this.ghostBlock.baseOffset)],
          rot: r4(t.yaw),
          finish: this.ghostFinish,
          connected: !!t.snap,
        });
      }
      if (!ev.shiftKey) this.cancelPlacing();   // Maj = pose en série
      return;
    }

    if (this.editable === false) return;
    this._setPointer(ev);
    this.ray.setFromCamera(this.pointer, this.camera);
    const hits = this.ray.intersectObjects([...this.objects.values()], true);
    if (hits.length) this.select(rootOf(hits[0].object, this.scene).userData.uid);
    else this.select(null);
  }

  /* ══════════ vues ══════════ */
  bounds() {
    const b = new THREE.Box3();
    for (const o of this.objects.values()) b.union(new THREE.Box3().setFromObject(o));
    return b.isEmpty() ? null : b;
  }

  fit(padding = 1.6) {
    const b = this.bounds();
    if (!b) { this.setView('iso'); return; }
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(b.getSize(new THREE.Vector3()).length() * 0.5, 0.5);
    const dist = (r * padding) / Math.sin(this.camera.fov * DEG * 0.5);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.controls.update();
  }

  setView(kind) {
    const b = this.bounds();
    const c = b ? b.getCenter(new THREE.Vector3()) : new THREE.Vector3(0, 0, 0.4);
    const r = b ? Math.max(b.getSize(new THREE.Vector3()).length() * 0.5, 0.8) : 2.5;
    const dist = (r * 1.7) / Math.sin(this.camera.fov * DEG * 0.5);
    const dirs = {
      iso: new THREE.Vector3(0.62, -0.72, 0.55),
      top: new THREE.Vector3(0, -0.0001, 1),
      front: new THREE.Vector3(0, -1, 0.02),
      right: new THREE.Vector3(1, 0, 0.02),
    };
    const d = (dirs[kind] || dirs.iso).clone().normalize();
    this.controls.target.copy(c);
    this.camera.position.copy(c).addScaledVector(d, dist);
    this.controls.update();
  }

  snapshot(w = 1600) {
    const el = this.canvas.parentElement;
    const ratio = el.clientHeight / el.clientWidth;
    const prev = this.renderer.getPixelRatio();
    this.selBox.visible = false;
    const gz = this.gizmo.visible; this.gizmo.visible = false;
    this.renderer.setPixelRatio(Math.min(w / el.clientWidth, 3));
    this.renderer.render(this.scene, this.camera);
    const url = this.canvas.toDataURL('image/png');
    this.renderer.setPixelRatio(prev);
    this.gizmo.visible = gz;
    this.selBox.visible = !!this.selected;
    this.resize();
    return { url, ratio };
  }
}

/* ══════════ utilitaires ══════════ */
function rootOf(obj, scene) {
  let o = obj;
  while (o.parent && o.parent !== scene) o = o.parent;
  return o;
}
const r4 = v => Math.round(v * 1e4) / 1e4;
