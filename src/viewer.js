import * as THREE from '../vendor/three/three.module.js';
import { OrbitControls } from '../vendor/three/addons/controls/OrbitControls.js';
import { TransformControls } from '../vendor/three/addons/controls/TransformControls.js';
import { Rendu } from './render.js';
import { Luminaires, construireLuminaire } from './lumieres.js';
import { buildStandardMaterial, materialKey } from './library.js';

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

    /* ---------- renderer ----------
       WebGL 2 explicitement, pas par defaut heureux : c'est lui qui donne
       l'antialiasing materiel sur les cibles de rendu, les textures en
       virgule flottante sans extension, et les tampons multiples. Le
       repli WebGL 1 rendrait la moitie de ce fichier inoperante — mieux
       vaut le dire tout de suite que rendre une image degradee sans
       expliquer pourquoi.  */
    /* preserveDrawingBuffer etait pose pour la capture d'image. Il oblige le
       navigateur a garder une copie du tampon a chaque image, qu'on la lise
       ou non — on payait toute l'annee un service utilise trois fois. La
       capture rend et relit dans le meme tour de boucle, ce qui fonctionne
       sans lui. */
    const contexte = canvas.getContext('webgl2', {
      antialias: true, alpha: false, preserveDrawingBuffer: false,
      powerPreference: 'high-performance', stencil: false, depth: true,
    });
    if (!contexte) {
      throw new Error('WebGL 2 est indisponible sur cet appareil : '
                    + 'le configurateur ne peut pas afficher la scene.');
    }

    this.renderer = new THREE.WebGLRenderer({
      canvas, context: contexte, antialias: true, alpha: false,
      preserveDrawingBuffer: false, powerPreference: 'high-performance',
    });
    this.webgl2 = true;
    // l'anisotropie redresse les textures vues de biais — le sol, surtout
    this.anisotropieMax = this.renderer.capabilities.getMaxAnisotropy();
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // La carte d'ombre se refaisait a chaque image alors que rien ne bouge la
    // plupart du temps : c'est une seconde traversee complete de la scene,
    // pour un resultat identique. On ne la recalcule que sur demande.
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;

    /* ---------- scène ---------- */
    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0b0e13);
    // L'environnement, le sol et le post-traitement sont posés par render.js,
    // en fin de constructeur : ils ont besoin de la scène déjà montée.

    // Le rapport proche/lointain conditionne la précision du tampon de
    // profondeur, donc la qualité de l'occlusion ambiante. Une salle de sport
    // tient dans quelques dizaines de mètres : inutile de porter à 2 000.
    this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 400);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(4.5, -6.5, 4.2);

    /* Le toucher de la navigation.

       La fluidite ne tient pas qu'au nombre d'images par seconde : elle tient
       d'abord a la reponse. Un amortissement trop mou donne l'impression de
       pousser un meuble, et un zoom qui vise le centre de l'ecran oblige a
       recadrer sans cesse. Les valeurs ci-dessous sont celles des
       configurateurs qui paraissent vifs.  */
    this.controls = new OrbitControls(this.camera, canvas);
    // Pas d'inertie : la camera s'arrete ou la main s'arrete. Le glissement
    // qui suit le relachement se lit comme de la mollesse, pas comme de la
    // fluidite — et il faisait tourner le rendu bien apres le geste.
    this.controls.enableDamping = false;
    this.controls.rotateSpeed = 0.85;
    this.controls.zoomSpeed = 1.15;
    this.controls.panSpeed = 0.9;
    this.controls.zoomToCursor = true;       // on zoome sur ce qu'on regarde
    this.controls.screenSpacePanning = true;
    this.controls.minDistance = 0.4;
    this.controls.maxDistance = 200;
    // pas de bridage angulaire : on doit pouvoir passer sous le sol pour
    // travailler en Z negatif
    this.controls.target.set(0, 0, 0.4);

    /* ---------- lumières ---------- */
    // L'environnement de studio porte maintenant l'essentiel de l'éclairage :
    // les sources directes ne servent plus qu'à sculpter et à porter l'ombre.
    // Les laisser à leur ancienne puissance délaverait tous les reflets.
    this.hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1a1f27, 0.20);
    this.scene.add(this.hemi);
    const contre = new THREE.DirectionalLight(0x9fc4ff, 0.30);
    contre.position.set(-7, 5, 3);
    this.scene.add(contre);
    this.contre = contre;

    const sun = new THREE.DirectionalLight(0xffffff, 1.7);
    sun.position.set(6, -8, 12);
    sun.castShadow = true;
    // Le cadrage de l'ombre est ajusté à l'emprise réelle par Rendu.majSol().
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.bias = -0.0006;
    sun.shadow.normalBias = 0.02;
    this.scene.add(sun);
    this.sun = sun;

    /* ---------- sol ---------- */
    // Le plan récepteur est posé par Rendu.majSol(), borné à l'emprise des
    // machines et couplé au cadre d'ombre du soleil. Un plan plus large que ce
    // cadre se peint intégralement en ombre douce et barre la vue : c'est ce
    // qui avait imposé de le retirer la première fois.

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
    axes.userData.axes = true;      // Rendu.majReperes() les masque pour présenter
    this.scene.add(axes);

    /* ---------- gizmo ---------- */
    this.gizmo = new TransformControls(this.camera, canvas);
    this.gizmo.setSpace('world');
    this.gizmo.setSize(0.85);
    this.gizmo.addEventListener('dragging-changed', e => {
      this.controls.enabled = !e.value;
      if (e.value) this._captureDepart();
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
    // les cotes sont des sprites : leur raycast exige la camera de reference
    this.ray.camera = this.camera;
    this.pointer = new THREE.Vector2();
    this._plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
    this._down = null;
    this._clic = { t: 0, x: 0, y: 0 };
    canvas.addEventListener('pointerdown', e => this._onDown(e));
    canvas.addEventListener('pointermove', e => this._onMove(e));
    canvas.addEventListener('pointerup', e => this._onUp(e));
    canvas.addEventListener('pointerleave', () => { if (this.ghost) this.ghost.visible = false; });

    /* ---------- luminaires ---------- */
    this.luminaires = new Luminaires(this);

    /* ---------- moteur de rendu ---------- */
    this.rendu = new Rendu(this);
    this.rendu.appliquerEnvironnement('global');
    // Le post-traitement arrive en différé : la scène doit rester utilisable
    // même si la carte graphique refuse les cibles de rendu flottantes.
    this.rendu.activerPostTraitement().catch(e => {
      console.warn('Post-traitement indisponible, rendu direct :', e);
    });

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
    this.rendu?.redimensionner(w, h);
    // Redimensionner reconstruit les cibles de rendu ; la carte d'ombre, elle,
    // n'est plus refaite d'office. On la redemande explicitement, sinon la
    // premiere image apres un changement de taille peut sortir sans ombres.
    this.marquerOmbres();
    this.demanderImage(3);
  }

  /* ══════════ rendu a la demande ══════════

     Une scene immobile redessinee soixante fois par seconde, c'est
     soixante fois le meme calcul. Sur une salle complete cela occupe la
     carte en permanence : le ventilateur tourne, la batterie descend, et
     surtout la machine n'a plus de reserve au moment ou l'on saisit la
     souris — d'ou l'a-coup au demarrage de chaque rotation.

     On ne dessine donc que lorsque quelque chose a change. Le risque de
     cette approche est connu : une source de changement oubliee, et la
     vue reste figee. D'ou le battement de securite — quatre images par
     seconde quoi qu'il arrive. Un oubli se rattrape en un quart de
     seconde au lieu de bloquer l'affichage. */

  /** Reclame le dessin des prochaines images. */
  demanderImage(n = 2) {
    this._enAttente = Math.max(this._enAttente || 0, n);
  }

  _doitDessiner() {
    if (this._enAttente > 0) { this._enAttente--; return true; }
    const t = performance.now();
    if (t - (this._tDessin || 0) > 250) return true;      // battement de securite
    return false;
  }

  _loop = () => {
    requestAnimationFrame(this._loop);
    this._animerCamera();
    /* OrbitControls sait dire s'il a bouge, mais son seuil est absolu et
       minuscule : il continue de signaler un fremissement bien apres que
       tout est immobile, ce qui reveillait le dessin trois fois par seconde
       pour rien. Notre detecteur, lui, mesure par rapport a la distance de
       recul — un dixieme de millimetre a trois metres n'est pas un
       mouvement. C'est lui qui decide. */
    this.controls.update();
    this._detecterMouvement();

    // La boite englobante d'une selection exige de parcourir tous les
    // maillages : elle ne se refait que si la selection a bouge.
    if (this.selected && this._selSale) {
      const b = this.boundsOf(this.selection);
      if (b) this.selBox.box.copy(b);
      this._selSale = false;
    }
    if (this.dimGroup) this._orientDimensions();
    this._suivreEmprise();
    this.luminaires.arbitrer();

    if (!this._doitDessiner()) return;
    this._tDessin = performance.now();
    this._mesurerRythme();
    if (!this.rendu?.rendre()) this.renderer.render(this.scene, this.camera);
  };

  /**
   * Mesure le rythme d'affichage et allege le rendu si la machine peine.
   *
   * Le jugement se porte sur une fenetre glissante et une seule fois : une
   * carte modeste passe en mode rapide au demarrage, et l'utilisateur garde
   * la main pour revenir en qualite haute s'il le souhaite.
   */
  _mesurerRythme() {
    const t = performance.now();
    const precedent = this._tImage || t;
    this._tImage = t;

    // Depuis que la scene ne se redessine qu'a la demande, les longs
    // intervalles sont des periodes d'immobilite, pas de la lenteur. Les
    // compter ferait afficher « 4 images/s » sur une station qui n'a rien
    // fait. On ne retient que les images enchainees, c'est-a-dire celles
    // rendues pendant une manipulation — le seul moment qui compte.
    const ecart = t - precedent;
    if (ecart <= 0 || ecart > 100) return;
    this._rythme = this._rythme ? this._rythme * 0.94 + ecart * 0.06 : ecart;
    this.imagesParSeconde = Math.round(1000 / this._rythme);
    this._mesureA = t;

    if (this._qualiteJugee) return;
    this._tDepart = this._tDepart || t;
    if (t - this._tDepart < 2500) return;                  // le temps de se chauffer
    this._qualiteJugee = true;

    if (this.imagesParSeconde < 24 && this.rendu?.reglages.qualite === 'haute') {
      this.rendu.regler({ qualite: 'rapide' });
      this.hooks.onQualite?.('rapide', this.imagesParSeconde);
    }
  }

  /**
   * Demande un nouveau calcul des ombres a la prochaine image.
   *
   * A appeler des qu'une geometrie apparait, disparait ou se deplace, et
   * quand le soleil change de place. Oublier un cas laisse une ombre
   * perimee a l'ecran : c'est le seul risque de ce reglage, et il se voit.
   */
  marquerOmbres() {
    this.renderer.shadowMap.needsUpdate = true;
    this._selSale = true;
    this.demanderImage(2);
  }

  /**
   * Le sol et le cadre d'ombre suivent l'emprise des machines.
   *
   * On ne recalcule pas l'emprise à chaque image — c'est un parcours de tous
   * les maillages — mais quatre fois par seconde, et on ne touche au sol que
   * si elle a réellement bougé.
   */
  _suivreEmprise() {
    const t = performance.now();
    if (t - (this._empriseT || 0) < 250) return;
    this._empriseT = t;

    const b = this.bounds();
    const clef = b ? [b.min.x, b.min.y, b.min.z, b.max.x, b.max.y, b.max.z]
      .map(v => v.toFixed(2)).join(',') : '';
    if (clef === this._empriseClef) return;
    this._empriseClef = clef;
    this.rendu?.majSol();
  }

  /**
   * La vue a-t-elle bougé depuis l'image précédente ?
   *
   * On compare une empreinte de la caméra plutôt que de s'abonner aux
   * événements : l'orbite, l'inertie, un vol programmé et un changement de
   * focale passent tous par là, sans qu'aucun ait à se déclarer.
   */
  _detecterMouvement() {
    const p = this.camera.position, t = this.controls.target;
    if (!this._camPrec) {
      this._camPrec = { p: p.clone(), t: t.clone(), fov: this.camera.fov };
      return;
    }

    // L'inertie de l'orbite décroît sans jamais atteindre zéro : comparer à
    // la virgule près déclarerait la vue en mouvement perpétuel et
    // l'occlusion ne reviendrait jamais. Le seuil suit la distance de recul.
    const seuil = Math.max(p.distanceTo(t), 1) * 2e-4;
    const bouge = p.distanceTo(this._camPrec.p) > seuil
               || t.distanceTo(this._camPrec.t) > seuil
               || Math.abs(this.camera.fov - this._camPrec.fov) > 1e-3;

    if (!bouge) {
      // A l'arret, l'occlusion revient : il faut une image pour la montrer.
      if (this._bougeait) { this._bougeait = false; this.demanderImage(4); }
      return;
    }
    this._bougeait = true;
    this.demanderImage(2);
    this.rendu?.signalerMouvement();
    this._camPrec.p.copy(p);
    this._camPrec.t.copy(t);
    this._camPrec.fov = this.camera.fov;
  }

  setLibrary(lib) {
    this.lib = lib;
    this.gridStep = lib.gridStep || 0.1;
    if (this.gizmo) this.gizmo.setTranslationSnap(this.snap ? this.gridStep : null);
  }

  /* ══════════ matériaux ══════════ */
  _material(part, finishColor) {
    const color = finishColor && part.paintable ? finishColor : part.color;
    const key = materialKey(part, color);
    let m = this._materials.get(key);
    if (!m) {
      m = buildStandardMaterial(part, color);
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
      // Les materiaux sont en double face pour tolerer les maillages ouverts
      // venus de Rhino. La carte d'ombre, elle, n'a que faire des faces
      // arriere d'un solide ferme : le lui dire divise son cout par deux.
      mesh.material.shadowSide = THREE.FrontSide;
      mesh.userData.paintable = p.paintable;
      g.add(mesh);
    }

    for (const spec of block.lumieres || []) {
      g.add(construireLuminaire(spec, this.lib?.scale ?? 1));
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
    this.luminaires.recenser(obj);
    this.marquerOmbres();
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
    this.luminaires.oublier(obj);
    this.scene.remove(obj);
    this.objects.delete(uid);
    this.marquerOmbres();
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
    const s = item.scale;
    if (Array.isArray(s)) obj.scale.set(s[0] || 1, s[1] || 1, s[2] || 1);
    else { const v = s || 1; obj.scale.set(v, v, v); }
    obj.userData.finish = item.finish;
    obj.userData.color = item.color;
    this.marquerOmbres();
  }

  _readTransform() {
    const obj = this.selected;
    if (!obj) return;
    this.rendu?.signalerMouvement();
    this.marquerOmbres();

    /* Un luminaire deplace au gizmo doit rendre compte de sa nouvelle
       position : sans cela le panneau afficherait encore l'ancienne, et la
       prochaine saisie au clavier le ferait bondir en arriere. */
    if (obj.userData.luminaire) {
      this.luminaires?.noterTransformation?.(obj);
      this.hooks.onLuminaire?.();
      return;
    }
    const block = this.lib.block(obj.userData.blockId);

    // Échelle : le gizmo tire un axe à la fois, mais le modèle reste
    // uniforme. On repère l'axe qui a bougé et on y ramène les deux autres —
    // ainsi la machine grandit ou rapetisse sans se déformer.
    if (this.tool === 'scale') {
      const x = obj.scale.x, y = obj.scale.y, z = obj.scale.z;
      const ref = this._scaleRef ?? x;
      const s = Math.abs(x - ref) > 1e-6 ? x : (Math.abs(y - ref) > 1e-6 ? y : z);
      obj.scale.set(s, s, s);
      this._scaleRef = s;
    }

    // Déplacement de groupe.
    //
    // Les positions de départ de TOUTE la sélection sont relevées à l'appui du
    // gizmo. À chaque image on repart de ces positions absolues et on y ajoute
    // l'écart parcouru par l'élément tenu. Reporter un écart image après image,
    // comme le faisait la première version, le cumulait et les machines
    // s'éloignaient les unes des autres.
    if (this._depart && this.tool === 'translate') {
      const ancre = this._depart.get(obj.userData.uid);
      if (ancre) {
        const ecart = obj.position.clone().sub(ancre);
        for (const [uid, origine] of this._depart) {
          if (uid === obj.userData.uid) continue;
          const autre = this.objects.get(uid);
          if (!autre) continue;

          autre.position.copy(origine).add(ecart);
          const bloc = this.lib.block(autre.userData.blockId);
          this.hooks.onTransform?.(uid, {
            pos: [r4(autre.position.x), r4(autre.position.y),
                  r4(autre.position.z - (bloc?.baseOffset || 0))],
            rot: r4(autre.rotation.z / DEG),
          });
        }
      }
    }

    const off = block?.baseOffset || 0;
    let z = obj.position.z - off;
    if (Math.abs(z) < 1e-4) z = 0;
    this.hooks.onTransform?.(obj.userData.uid, {
      pos: [r4(obj.position.x), r4(obj.position.y), r4(z)],
      rot: r4(obj.rotation.z / DEG),
      scale: r4(obj.scale.x),
    });
  }

  /* ══════════ sélection ══════════
     Plusieurs éléments peuvent être choisis. Le gizmo reste accroché au
     dernier désigné, mais tout déplacement s'applique à l'ensemble ; le
     cadre, lui, est unique et englobe le groupe.
     ============================== */
  /* ══════════ ce qui se selectionne ══════════

     Les machines vivent dans this.objects, que l'etat de la configuration
     pilote. Les luminaires poses librement n'y sont PAS, et il ne faut
     surtout pas les y mettre : la reconciliation d'etat les effacerait au
     premier rechargement, puisqu'ils ne figurent pas dans la nomenclature.

     On les joint donc au moment du clic, et nulle part ailleurs. */

  _cibles() {
    const l = this.luminaires?.objetsLibres?.() || [];
    return l.length ? [...this.objects.values(), ...l] : [...this.objects.values()];
  }

  /** L'objet designe par un identifiant, machine ou luminaire. */
  _objet(uid) {
    return this.objects.get(uid) || this.luminaires?.objet?.(uid) || null;
  }

  select(uid, additive = false) {
    if (!uid) this.selection = [];
    else if (!additive) this.selection = [uid];
    else if (this.selection.includes(uid)) this.selection = this.selection.filter(u => u !== uid);
    else this.selection = [...this.selection, uid];

    const dernier = this.selection[this.selection.length - 1];
    const obj = dernier ? this._objet(dernier) : null;
    this.selected = obj || null;

    if (obj) {
      if (this.editable !== false) { this.gizmo.attach(obj); this.gizmo.visible = true; }
      this._selSale = false;
      this.demanderImage(2);
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

  /** Positions de départ de la sélection, relevées à l'appui du gizmo. */
  _captureDepart() {
    this._depart = null;
    if (!this.selected || (this.selection || []).length < 2) return;

    this._depart = new Map();
    for (const uid of this.selection) {
      const obj = this.objects.get(uid);
      if (obj) this._depart.set(uid, obj.position.clone());
    }
  }

  setTool(tool) {
    this.tool = tool;
    this.gizmo.setMode(tool);
    if (tool === 'rotate') { this.gizmo.showX = false; this.gizmo.showY = false; this.gizmo.showZ = true; }
    else { this.gizmo.showX = this.gizmo.showY = this.gizmo.showZ = true; }
    // référence de l'échelle uniforme au moment où l'on passe en échelle
    if (tool === 'scale') this._scaleRef = this.selected?.scale.x ?? 1;
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

  /** Le rythme mesure, ou null s'il date de trop pour etre honnete. */
  get rythmeFrais() {
    if (!this._mesureA || performance.now() - this._mesureA > 2000) return null;
    return this.imagesParSeconde;
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

  /**
   * Un connecteur est occupé si un autre bloc en a un ACCEPTABLE au même
   * endroit. La règle d'occupation est celle de l'assemblage : un point
   * universel occupé par une ancre A l'est bel et bien. Comparer les
   * catégories à l'identique laissait libres tous les points universels,
   * qui sont pourtant le cas courant.
   */
  isOccupied(conn, all) {
    const tol = this.snapTol;
    return (all || this.allConnectors(conn.uid)).some(o =>
      o.uid !== conn.uid && Viewer.compatible(o.type, conn.type)
      && o.pos.distanceTo(conn.pos) <= tol);
  }

  freeConnectors(uid) {
    const obj = this.objects.get(uid);
    if (!obj) return [];
    const others = this.allConnectors(uid);
    return this.worldConnectors(obj).filter(c => !others.some(
      o => Viewer.compatible(o.type, c.type) && o.pos.distanceTo(c.pos) <= this.snapTol));
  }

  /** Position monde d'un connecteur d'un objet posé, ou null. */
  connectorWorld(uid, index) {
    const obj = this.objects.get(uid);
    const c = this.lib?.block(obj?.userData.blockId)?.connectors?.[index];
    if (!obj || !c) return null;
    obj.updateMatrixWorld();
    return c.pos.clone().applyMatrix4(obj.matrixWorld);
  }

  /**
   * Ce qui est raccordé à un objet : les blocs dont le point d'ancrage se
   * superpose à l'un de ses connecteurs, avec le connecteur porteur.
   * Un remplacement s'en sert pour savoir où reposer la suite.
   */
  connectionsOn(uid) {
    const obj = this.objects.get(uid);
    if (!obj) return [];
    const points = this.worldConnectors(obj);
    if (!points.length) return [];
    const tol = this.snapTol;
    const out = [];

    for (const [autre, o] of this.objects) {
      if (autre === uid) continue;
      const ancre = this._anchorOf(this.lib?.block(o.userData.blockId));
      o.updateMatrixWorld();
      const p = ancre.pos.clone().applyMatrix4(o.matrixWorld);
      for (const c of points) {
        if (!Viewer.compatible(c.type, ancre.type)) continue;
        if (p.distanceTo(c.pos) > tol) continue;
        out.push({ uid: autre, index: c.index, type: c.type, pos: c.pos.clone() });
        break;
      }
    }
    return out;
  }

  /**
   * Un objet et, de proche en proche, tout ce qui s'y raccorde. Déplacer un
   * bloc porteur doit emmener sa grappe, pas la laisser en l'air.
   */
  chainFrom(uid, vus = new Set()) {
    if (vus.has(uid)) return vus;
    vus.add(uid);
    for (const l of this.connectionsOn(uid)) this.chainFrom(l.uid, vus);
    return vus;
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
      if (o.isLight) { o.visible = false; o.userData.luminaire = false; }
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
    const hits = this.ray.intersectObjects(this._cibles(), true);
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

  _onDown(ev) {
    if (ev.button !== 0) return;            // clic droit : voir contextmenu (main.js)
    this._vol = null;                       // la main de l'utilisateur prime sur un vol de camera

    // Edition du faisceau : l'apercu est actif et une poignee est sous le
    // curseur. On saisit la poignee plutot que d'orbitter ou de selectionner.
    if (this.luminaires?.apercuActif) {
      this._setPointer(ev);
      const poignee = this.luminaires.poigneeSous(this.pointer, this.camera);
      if (poignee) {
        this._beam = poignee;
        this.controls.enabled = false;
        this.demanderImage(2);
        return;
      }
    }

    this._down = { x: ev.clientX, y: ev.clientY, t: performance.now() };
    // Poignee du gizmo sous le curseur, capturee AU pointerdown : le listener
    // pointerup de TransformControls (attache avant le notre) remet
    // `this.gizmo.axis` a null, donc c'est au down qu'il faut la lire.
    this._clicAxe = /^[XYZ]$/.test(this.gizmo.axis) ? this.gizmo.axis : null;
  }

  _onMove(ev) {
    if (this._beam) {
      this._setPointer(ev);
      this.luminaires?.editerFaisceau(this._beam.g, this._beam.type, this.pointer, this.camera);
      this.demanderImage(2);
      return;
    }
    if (!this.ghost) return;
    this.demanderImage(2);
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
    const hits = this.ray.intersectObjects(this._cibles(), true);
    return hits.length ? rootOf(hits[0].object, this.scene).userData.uid : null;
  }

  _onUp(ev) {
    if (this._beam) {
      this._beam = null;
      this.controls.enabled = true;
      this.luminaires?.finEdition?.();
      return;
    }
    if (ev.button !== 0) return;            // clic droit : voir contextmenu (main.js)
    const d = this._down; this._down = null;
    if (!d) return;
    if (Math.hypot(ev.clientX - d.x, ev.clientY - d.y) > 5) return;   // orbite, pas un clic

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

    // Clic franc sur une poignee du gizmo : ouvre la saisie de valeur precise.
    // L'axe a ete capture au pointerdown (`_clicAxe`), car TransformControls
    // remet `this.gizmo.axis` a null sur son propre pointerup, avant le notre.
    if (this._clicAxe) {
      const axe = this._clicAxe;
      this._clicAxe = null;
      this.hooks.onGizmoValue?.(this.tool, axe, ev.clientX, ev.clientY);
      return;
    }

    // Double-clic sur une cote : edition de la dimension. La cote est trouvee
    // en 2D (projection a l'ecran), plus fiable que le raycast des sprites.
    const maintenant = performance.now();
    const double = (maintenant - this._clic.t) < 350
      && Math.abs(ev.clientX - this._clic.x) < 6
      && Math.abs(ev.clientY - this._clic.y) < 6;
    this._clic = { t: maintenant, x: ev.clientX, y: ev.clientY };
    const cote = this.coteSous(ev);
    if (double && cote) {
      this.hooks.onDimension?.(cote.axis, cote.valeur, ev.clientX, ev.clientY);
      return;
    }

    // Un clic sur une cote ne doit pas changer la sélection.
    if (cote) return;
    const hits = this.ray.intersectObjects(this._cibles(), true);
    const additif = ev.ctrlKey || ev.shiftKey || ev.metaKey;
    if (hits.length) this.select(rootOf(hits[0].object, this.scene).userData.uid, additif);
    else if (!additif) this.select(null);
  }

  /**
   * Applique un déplacement relatif le long d'un axe du gizmo : la valeur
   * saisie est un écart depuis la position actuelle, pas une position absolue.
   */
  applyGizmoAxis(axe, valeur) {
    const obj = this.selected;
    if (!obj) return;
    if (this.tool === 'translate') {
      const i = 'XYZ'.indexOf(axe);
      if (i < 0) return;
      obj.position.setComponent(i, obj.position.getComponent(i) + valeur);
    } else if (this.tool === 'rotate') {
      obj.rotation.z += valeur * DEG;
    } else if (this.tool === 'scale') {
      obj.scale.set(valeur, valeur, valeur);
    }
    this._readTransform();
    this.hooks.onCommit?.();
  }

  /**
   * Redimensionne la sélection le long d'un axe, autour de l'origine de chaque
   * objet. `targetWorld` est la cote visée en mètres. Renvoie la taille réelle
   * obtenue, ou null si impossible.
   */
  resizeAxis(axis, targetWorld) {
    const b = this.boundsOf(this.selection);
    if (!b || !(targetWorld > 0)) return null;
    const courante = b.getSize(new THREE.Vector3()).getComponent(axis);
    if (courante < 1e-6) return null;
    const facteur = targetWorld / courante;
    if (Math.abs(facteur - 1) < 1e-6) return targetWorld;

    for (const uid of this.selection) {
      const obj = this.objects.get(uid);
      if (!obj) continue;
      const s = obj.scale.clone();
      s.setComponent(axis, Math.max(0.001, s.getComponent(axis) * facteur));
      obj.scale.copy(s);
      this.hooks.onTransform?.(uid, { scale: [r4(obj.scale.x), r4(obj.scale.y), r4(obj.scale.z)] });
    }
    this.marquerOmbres();
    return targetWorld;
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
      [`${n(size.x)} ${unite}`, new THREE.Vector3(min.x, min.y, min.z), new THREE.Vector3(max.x, min.y, min.z), 0],
      [`${n(size.y)} ${unite}`, new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x, max.y, min.z), 1],
      [`${n(size.z)} ${unite}`, new THREE.Vector3(max.x, min.y, min.z), new THREE.Vector3(max.x, min.y, max.z), 2],
    ];

    for (const [texte, a, b, axis] of cotes) {
      const sprite = this._label(texte, a, b);
      // Une cote se retient pour pouvoir être éditée : l'axe qu'elle mesure
      // et la valeur affichée, dans l'unité de la bibliothèque.
      sprite.userData.axis = axis;
      sprite.userData.valeur = n([size.x, size.y, size.z][axis]);
      this.dimGroup.add(sprite);
    }
    // Position monde de chaque cote, pour la détection au clic en 2D (plus
    // fiable que le raycast des sprites).
    this.dimGroup.userData.cotes = cotes.map(([, a, b, axis]) => ({
      axis,
      valeur: n([size.x, size.y, size.z][axis]),
      pos: a.clone().add(b).multiplyScalar(0.5),
    }));
    if (label) {
      const haut = new THREE.Vector3((min.x + max.x) / 2, (min.y + max.y) / 2, max.z);
      this.dimGroup.add(this._label(label, haut, null));
    }
    this.scene.add(this.dimGroup);
  }

  /**
   * La cote sous le curseur, trouvée en projetant sa position à l'écran :
   * un test de distance 2D, indépendant du raycast des sprites.
   */
  coteSous(ev, tol = 18) {
    const cotes = this.dimGroup?.userData?.cotes;
    if (!cotes?.length || !this.dimGroup?.visible) return null;
    const r = this.canvas.getBoundingClientRect();
    const x = ev.clientX - r.left, y = ev.clientY - r.top;
    let meilleure = null;
    for (const c of cotes) {
      const p = c.pos.clone().project(this.camera);
      const px = ((p.x + 1) / 2) * r.width;
      const py = ((1 - p.y) / 2) * r.height;
      const d = Math.hypot(px - x, py - y);
      if (d <= tol && (!meilleure || d < meilleure.d)) meilleure = { ...c, d };
    }
    return meilleure;
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
      const obj = this._objet(uid);
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

  fit(padding = 1.6, anime = true) {
    const b = this.bounds();
    if (!b) { this.setView('iso', anime); return; }
    const c = b.getCenter(new THREE.Vector3());
    const r = Math.max(b.getSize(new THREE.Vector3()).length() * 0.5, 0.5);
    const dist = (r * padding) / Math.sin(this.camera.fov * DEG * 0.5);
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this._cadrer(c, c.clone().addScaledVector(dir, dist), anime);
  }

  setView(kind, anime = true) {
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

    // Hauteur d'œil : ce que verra celui qui entre dans la salle. La caméra
    // se place à 1,55 m du sol et regarde droit devant — pas en plongée sur
    // un centre géométrique, sinon on retombe sur une vue de maquette.
    if (kind === 'oeil' && b) {
      const taille = b.getSize(new THREE.Vector3());
      const z = b.min.z + 1.55;
      const recul = Math.max(taille.y * 0.5 + r * 1.15, 3);
      this._cadrer(new THREE.Vector3(c.x, c.y, z),
                   new THREE.Vector3(c.x + recul * 0.30, c.y - recul, z), anime);
      return;
    }

    const d = (dirs[kind] || dirs.iso).clone().normalize();
    this._cadrer(c, c.clone().addScaledVector(d, dist), anime);
  }

  /* ══════════ caméra ══════════ */

  /**
   * Focale en équivalent 24×36. Une machine se photographie au 50 ou au 85 :
   * la perspective y est douce et les proportions justes. Le grand-angle
   * étire les capots et fait paraître le châssis tordu.
   */
  setFocale(mm) {
    const f = Math.min(200, Math.max(16, Number(mm) || 40));
    this.camera.fov = 2 * Math.atan(12 / f) / DEG;
    this.camera.updateProjectionMatrix();
    return f;
  }

  get focale() { return 12 / Math.tan(this.camera.fov * DEG * 0.5); }

  setRotationAuto(on, vitesse = 0.6) {
    this.controls.autoRotate = !!on;
    this.controls.autoRotateSpeed = vitesse;
  }

  get rotationAuto() { return !!this.controls.autoRotate; }

  /** Déplacement de caméra, éventuellement animé. */
  _cadrer(cible, position, anime = true) {
    if (!anime) {
      this._vol = null;
      this.controls.target.copy(cible);
      this.camera.position.copy(position);
      this.controls.update();
      return;
    }
    this._vol = {
      t0: performance.now(), duree: 620,
      c0: this.controls.target.clone(), c1: cible.clone(),
      p0: this.camera.position.clone(), p1: position.clone(),
    };
  }

  _animerCamera() {
    const v = this._vol;
    if (!v) return;
    const k = Math.min(1, (performance.now() - v.t0) / v.duree);
    // douceur aux deux bouts : on décolle et on se pose sans à-coup
    const e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
    this.controls.target.lerpVectors(v.c0, v.c1, e);
    this.camera.position.lerpVectors(v.p0, v.p1, e);
    if (k >= 1) this._vol = null;
  }

  snapshot(w = 1600) {
    const el = this.canvas.parentElement;
    const ratio = el.clientHeight / el.clientWidth;
    const prev = this.renderer.getPixelRatio();
    this.selBox.visible = false;
    const gz = this.gizmo.visible; this.gizmo.visible = false;
    const pr = Math.min(w / el.clientWidth, 3);
    this.renderer.setPixelRatio(pr);
    this.rendu?.setPixelRatio(pr);
    if (!this.rendu?.rendre(true)) this.renderer.render(this.scene, this.camera);
    const url = this.canvas.toDataURL('image/png');
    this.renderer.setPixelRatio(prev);
    this.rendu?.setPixelRatio(prev);
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
