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
const UNIVERSAL = '*';

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
    this.selection = [];
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
    // pas de bridage : on doit pouvoir passer sous le sol pour travailler en Z negatif
    this.controls.target.set(0, 0, 0.4);

    /* ---------- lumières ---------- */
    const hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1a1f27, 0.85);
    this.scene.add(hemi);
    // Une seconde source, plus froide et rasante, détache les arêtes des capots.
    const contre = new THREE.DirectionalLight(0x9fc4ff, 0.55);
    contre.position.set(-7, 5, 3);
    this.scene.add(contre);
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
    // Pas de plan récepteur d'ombre : hors du cadre d'ombre du soleil, un tel plan
    // se peint intégralement en ombre douce et laisse une grande tache claire en
    // surimpression. Les machines continuent de porter ombre les unes sur les autres.

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
      if (e.value) this._depart = this.selected ? this.selected.position.clone() : null;
      else { this._depart = null; this.clearSnapHints(); this.hooks.onCommit?.(); }
    });
    this.gizmo.addEventListener('objectChange', () => this._readTransform());
    this.gizmo.visible = false;

    // Le plan de saisie du gizmo est un carré de 100 000 unités qu'Eto/Three
    // laisse peindre à 10 % d'opacité : il barre la vue d'une grande forme
    // claire. On le garde pour la saisie — le lancer de rayon ignore la
    // visibilité du matériau — mais on cesse de le dessiner.
    this.gizmo.traverse(o => {
      if (!o.material) return;

      // Le plan de saisie : un carré de 100 000 unités peint à 10 % d'opacité.
      if (o.type === 'TransformControlsPlane') {
        o.material.visible = false;
        o.material.opacity = 0;
        return;
      }

      // Les guides d'axe : des lignes d'un million d'unités que Three.js laisse
      // peintes en permanence. Elles traversent toute la vue en perspective.
      const g = o.geometry?.attributes?.position;
      if (!o.isLine || !g) return;
      let etendue = 0;
      for (let i = 0; i < g.count * 3; i++) etendue = Math.max(etendue, Math.abs(g.array[i]));
      if (etendue > 1e4) o.material.visible = false;
    });

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
    if (this.selected) {
      const b = this.boundsOf(this.selection);
      if (b) this.selBox.box.copy(b);
    }
    if (this.dimGroup) this._orientDimensions();
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
        // L'environnement fait tout le rendu des reflets : sans lui, un métal
        // rugueux paraît mat et un chrome paraît gris.
        envMapIntensity: 1.15,
      });
      this._materials.set(key, m);
    }
    return m;
  }

  /**
   * Construit la geometrie d'un bloc, sous-blocs compris.
   *
   * Un bloc peut en contenir d'autres, comme dans Rhino : chacun garde son
   * identite et son materiau, et peut lui-meme en contenir. La profondeur est
   * bornee pour qu'un bloc se referencant en boucle ne fige pas la page.
   */
  _build(block, finishColor, depth = 0) {
    const g = new THREE.Group();

    for (const p of block.parts) {
      const mesh = new THREE.Mesh(p.geometry, this._material(p, finishColor));
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.paintable = p.paintable;
      g.add(mesh);
    }

    if (depth < 6) {
      for (const child of block.children || []) {
        const sous = this.lib?.block(child.blockId);
        if (!sous) continue;
        const noeud = this._build(sous, finishColor, depth + 1);
        noeud.position.copy(child.pos);
        noeud.rotation.z = child.rot * DEG;
        noeud.scale.setScalar(child.scale);
        noeud.userData.childOf = block.id;
        noeud.userData.blockId = sous.id;
        g.add(noeud);
      }
    }

    return g;
  }

  /* ══════════ instances ══════════ */
  addItem(item) {
    const block = this.lib.block(item.blockId);
    if (!block) return null;
    // La couleur choisie librement par le client prime sur la variante catalogue.
    const finish = block.finishes.find(f => f.id === item.finish);
    const obj = this._build(block, item.color || finish?.color);
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
    this._pointsDirty = true;
    const keep = new Set(items.map(i => i.uid));
    for (const uid of [...this.objects.keys()]) if (!keep.has(uid)) this.removeItem(uid);
    for (const it of items) {
      if (this.objects.has(it.uid)) {
        const obj = this.objects.get(it.uid);
        if (obj.userData.finish !== it.finish || obj.userData.color !== it.color) this.updateItem(it);
        else this._applyTransform(obj, it, this.lib.block(it.blockId));
      } else this.addItem(it);
    }
    if (this._pointsDirty) { this.refreshPoints(); this._pointsDirty = false; }
  }

  _applyTransform(obj, item, block) {
    obj.position.set(item.pos[0], item.pos[1], item.pos[2] + (block?.baseOffset || 0));
    obj.rotation.set(0, 0, (item.rot || 0) * DEG);
    const s = item.scale || 1;
    obj.scale.set(s, s, s);
    obj.userData.finish = item.finish;
    obj.userData.color = item.color;
  }

  _readTransform() {
    const obj = this.selected;
    if (!obj) return;
    const block = this.lib.block(obj.userData.blockId);

    // Déplacement de groupe : pas encore fiable, le report de l'écart sur les
    // voisins se cumulait d'une image à l'autre. Le gizmo ne déplace donc que
    // l'élément tenu ; la sélection multiple sert au cadre coté, à la
    // duplication et à la suppression.

    const off = block?.baseOffset || 0;
    let z = obj.position.z - off;
    if (Math.abs(z) < 1e-4) z = 0;
    this.hooks.onTransform?.(obj.userData.uid, {
      pos: [r4(obj.position.x), r4(obj.position.y), r4(z)],
      rot: r4(obj.rotation.z / DEG),
    });
  }

  /* ══════════ sélection ══════════
     Plusieurs éléments peuvent être choisis. Le gizmo reste accroché au
     dernier désigné, mais tout déplacement s'applique à l'ensemble ; le
     cadre, lui, est unique et englobe le groupe.
     ============================== */
  select(uid, additive = false) {
    if (!uid) this.selection = [];
    else if (!additive) this.selection = [uid];
    else if (this.selection.includes(uid)) this.selection = this.selection.filter(u => u !== uid);
    else this.selection = [...this.selection, uid];

    const dernier = this.selection[this.selection.length - 1];
    const obj = dernier ? this.objects.get(dernier) : null;
    this.selected = obj || null;

    if (obj) {
      if (this.editable !== false) { this.gizmo.attach(obj); this.gizmo.visible = true; }
      this.selBox.box.copy(this.boundsOf(this.selection) ?? new THREE.Box3());
      this.selBox.visible = true;
    } else {
      this.gizmo.detach();
      this.gizmo.visible = false;
      this.selBox.visible = false;
    }

    this.hooks.onSelect?.(obj ? obj.userData.uid : null, this.selection);
  }

  /** Les objets actuellement choisis. */
  get selectedUids() { return this.selection || []; }

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
      main: c.main,
      name: c.name,
      pos: c.pos.clone().applyMatrix4(obj.matrixWorld),
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

  /** Deux points s'acceptent-ils ? Même catégorie, ou l'un des deux universel. */
  static compatible(a, b) {
    return a === b || a === UNIVERSAL || b === UNIVERSAL;
  }

  /**
   * Le point par lequel un bloc s'accroche : son point d'insertion principal,
   * c'est-à-dire l'origine du bloc Rhino. À défaut, l'origine tout court.
   */
  _anchorOf(block) {
    const main = block?.connectors?.find(c => c.main);
    return main || { type: UNIVERSAL, pos: new THREE.Vector3(), main: true };
  }

  /**
   * Cherche la meilleure connexion pour un bloc.
   * @param origin  position visée de l'objet (repère monde, avec baseOffset)
   * @returns {origin, yaw, target, source, d} ou null
   */
  computeSnap(block, origin, currentYawDeg, excludeUid, maxDist) {
    if (!this.magnet || !block) return null;
    const anchor = this._anchorOf(block);
    const targets = this.allConnectors(excludeUid)
      .filter(t => Viewer.compatible(anchor.type, t.type));
    if (!targets.length) return null;

    // La rotation n'est pas touchée : l'accroche se fait par superposition de
    // points, l'orientation reste celle que l'utilisateur a choisie.
    const yaw = currentYawDeg;
    const q = new THREE.Quaternion().setFromAxisAngle(UP, yaw * DEG);
    const local = anchor.pos.clone().applyQuaternion(q);

    const radius = maxDist ?? this.snapRadius;
    let best = null;
    for (const t of targets) {
      const o = t.pos.clone().sub(local);
      const d = o.distanceTo(origin);
      if (d <= radius && (!best || d < best.d)) best = { origin: o, yaw, target: t, source: anchor, d };
    }
    return best;
  }

  /** Repères visuels : point de connexion trouvé + points libres compatibles. */
  showSnapHints(block, snap, excludeUid) {
    this.snapMarker.visible = !!snap;
    if (snap) this.snapMarker.position.copy(snap.target.pos);
    const anchor = this._anchorOf(block);
    if (!this.magnet) { this.hintDots.visible = false; return; }
    const pts = this.allConnectors(excludeUid).filter(c => Viewer.compatible(anchor.type, c.type));
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
    const free = this.worldConnectors(this.objects.get(targetUid))
      .filter(c => !wantedType || Viewer.compatible(c.type, wantedType));

    const anchor = this._anchorOf(block);
    const candidats = [];
    for (const t of free) {
      if (!Viewer.compatible(anchor.type, t.type)) continue;
      const o = t.pos.clone().sub(anchor.pos);
      candidats.push({ o, yaw: 0, type: t.type, vue: t.pos.distanceTo(this.camera.position) });
    }
    candidats.sort((a, b) => a.vue - b.vue);

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
    let x, y, z = 0, stacked = false, below = false;
    if (hits.length) {
      const h = hits[0];
      const n = h.face ? h.face.normal.clone().transformDirection(h.object.matrixWorld) : null;
      x = h.point.x; y = h.point.y;
      const box = new THREE.Box3().setFromObject(rootOf(h.object, this.scene));
      if (n && n.z > 0.5) {
        z = box.max.z;                     // on empile sur la face supérieure
        stacked = true;                    // hauteur exacte : pas d'aimantation en Z
      } else if (n && n.z < -0.5) {
        // face inférieure visée : on pose EN DESSOUS, donc en Z négatif
        z = box.min.z;
        stacked = true;
        below = true;
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
    return { x: r4(x), y: r4(y), z: r4(z), below };
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
    const drop = p.below ? p.z - this.ghostBlock.size.z : p.z;
    const base = new THREE.Vector3(p.x, p.y, drop + this.ghostBlock.baseOffset);
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
      let pose = null;
      if (p) {
        const t = this._ghostTransform(p);
        pose = {
          blockId: this.ghostBlock.id,
          pos: [r4(t.origin.x), r4(t.origin.y), r4(t.origin.z - this.ghostBlock.baseOffset)],
          rot: r4(t.yaw),
          finish: this.ghostFinish,
          connected: !!t.snap,
        };
      }
      // on quitte le mode pose AVANT de prévenir l'application, pour qu'elle
      // voie l'état réel (fantôme absent) et range l'indication à l'écran
      if (!ev.shiftKey) this.cancelPlacing();   // Maj = pose en série
      if (pose) this.hooks.onPlace?.(pose);
      return;
    }

    if (this.editable === false) return;
    this._setPointer(ev);
    this.ray.setFromCamera(this.pointer, this.camera);
    const hits = this.ray.intersectObjects([...this.objects.values()], true);
    const additif = ev.ctrlKey || ev.shiftKey || ev.metaKey;
    if (hits.length) this.select(rootOf(hits[0].object, this.scene).userData.uid, additif);
    else if (!additif) this.select(null);
  }

  /* ══════════ points d'accroche visibles ══════════
     Agrandis pour être vus de loin, cliquables, et masquables.
     ================================================ */
  setPointsVisible(on) {
    this.pointsVisible = on;
    this.refreshPoints();
  }

  refreshPoints() {
    if (!this.pointGroup) {
      this.pointGroup = new THREE.Group();
      this.pointGroup.renderOrder = 996;
      this.scene.add(this.pointGroup);
      this._pointGeom = new THREE.SphereGeometry(1, 16, 12);
    }

    for (const m of this.pointGroup.children) m.material.dispose();
    this.pointGroup.clear();
    this.pointGroup.visible = !!this.pointsVisible;
    if (!this.pointsVisible) return;

    const rayon = Math.max(this.gridStep * 0.9, 0.07);
    const all = this.allConnectors(null);
    for (const c of all) {
      const occupe = this.isOccupied(c, all);
      const mesh = new THREE.Mesh(this._pointGeom, new THREE.MeshBasicMaterial({
        color: c.type === UNIVERSAL ? 0x3ecf8e : (occupe ? 0xff9f43 : 0x3d8bff),
        depthTest: false, transparent: true, opacity: occupe ? 0.55 : 0.9,
      }));
      mesh.position.copy(c.pos);
      mesh.scale.setScalar(rayon);
      mesh.userData.connector = c;
      this.pointGroup.add(mesh);
    }
  }

  /** Point d'accroche sous le curseur, ou null. */
  pickPointAt(ev) {
    if (!this.pointsVisible || !this.pointGroup) return null;
    this._setPointer(ev);
    this.ray.setFromCamera(this.pointer, this.camera);
    const hits = this.ray.intersectObjects(this.pointGroup.children, false);
    return hits.length ? hits[0].object.userData.connector : null;
  }

  /* ══════════ cotes et sélection multiple ══════════ */

  /** Encadré coté autour d'une boîte : arêtes + trois cotes. */
  showDimensions(box, label) {
    this.clearDimensions();
    if (!box || box.isEmpty()) return;

    this.dimGroup = new THREE.Group();
    this.dimGroup.renderOrder = 995;

    const helper = new THREE.Box3Helper(box.clone(), 0x3ecf8e);
    if (helper.material) { helper.material.depthTest = false; helper.material.transparent = true; }
    this.dimGroup.add(helper);

    const size = box.getSize(new THREE.Vector3());
    const min = box.min, max = box.max;
    const k = this.lib?.scale || 1;
    const unite = this.lib?.units || 'm';
    const n = v => Math.round(v / k);

    // Chaque cote connaît le segment qu'elle mesure : l'étiquette s'orientera
    // dessus à l'écran, comme une cote de plan, au lieu de rester horizontale.
    const cotes = [
      [`${n(size.x)} ${unite}`, new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(max.x, min.y, min.z)],
      [`${n(size.y)} ${unite}`, new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x, max.y, min.z)],
      [`${n(size.z)} ${unite}`, new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x, min.y, max.z)],
    ];

    for (const [texte, a, b] of cotes) this.dimGroup.add(this._label(texte, a, b));
    if (label) {
      const haut = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, max.z);
      this.dimGroup.add(this._label(label, haut, null));
    }
    this.scene.add(this.dimGroup);
  }

  clearDimensions() {
    if (!this.dimGroup) return;
    this.scene.remove(this.dimGroup);
    this.dimGroup.traverse(o => {
      if (o.material) { o.material.map?.dispose(); o.material.dispose(); }
    });
    this.dimGroup = null;
  }

  /**
   * Étiquette de cote.
   *
   * Placée au milieu du segment mesuré et tournée, à l'écran, dans son axe :
   * une cote se lit le long de ce qu'elle mesure. Sans second point, elle
   * reste horizontale — c'est le cas du nom de la sélection.
   */
  _label(texte, a, b = null) {
    const POLICE = 26;                          // typographie discrète
    const HAUT = 40;

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    ctx.font = `600 ${POLICE}px Inter, Segoe UI, sans-serif`;
    const largeur = Math.ceil(ctx.measureText(texte).width) + 20;
    canvas.width = largeur; canvas.height = HAUT;

    const c2 = canvas.getContext('2d');
    c2.font = `600 ${POLICE}px Inter, Segoe UI, sans-serif`;
    c2.fillStyle = 'rgba(12,16,22,0.82)';
    c2.roundRect(0, 0, largeur, HAUT, 8); c2.fill();
    c2.fillStyle = '#3ecf8e';
    c2.textBaseline = 'middle';
    c2.fillText(texte, 10, HAUT / 2 + 1);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture, depthTest: false, transparent: true,
    }));

    sprite.position.copy(b ? a.clone().add(b).multiplyScalar(0.5) : a);
    const echelle = Math.max(this.gridStep * 2.2, 0.17);
    sprite.scale.set(echelle * largeur / HAUT, echelle, 1);

    // extrémités retenues : la boucle de rendu s'en sert pour l'orientation
    if (b) sprite.userData.segment = [a.clone(), b.clone()];
    return sprite;
  }

  /** Oriente chaque cote dans l'axe de ce qu'elle mesure, tel que vu à l'écran. */
  _orientDimensions() {
    if (!this.dimGroup) return;
    const a = new THREE.Vector3(), b = new THREE.Vector3();

    for (const sprite of this.dimGroup.children) {
      const segment = sprite.userData?.segment;
      if (!segment || !sprite.material) continue;

      a.copy(segment[0]).project(this.camera);
      b.copy(segment[1]).project(this.camera);
      let angle = Math.atan2(b.y - a.y, (b.x - a.x) * this.camera.aspect);

      // jamais à l'envers : une cote se lit de gauche à droite
      if (angle > Math.PI / 2) angle -= Math.PI;
      if (angle < -Math.PI / 2) angle += Math.PI;
      sprite.material.rotation = angle;
    }
  }

  /** Boîte englobante d'un ensemble d'objets. */
  boundsOf(uids) {
    const box = new THREE.Box3();
    for (const uid of uids) {
      const obj = this.objects.get(uid);
      if (obj) box.union(new THREE.Box3().setFromObject(obj));
    }
    return box.isEmpty() ? null : box;
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
