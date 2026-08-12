import * as THREE from '../vendor/three/three.module.js';

/* ============================================================
   Fond de plan
   ------------------------------------------------------------
   Le plan de la salle, posé au sol, sur lequel on implante les
   machines. Deux sources, une même plomberie :

     • une IMAGE (PNG, JPG, WEBP) — plaquée sur un rectangle ;
     • un DXF — redessiné en traits, sans dépendance extérieure.

   Le DXF est un format texte : une suite de paires (code, valeur).
   On n'en lit que la section ENTITIES, et seulement les entités
   qui portent un dessin de plan — lignes, polylignes, arcs,
   cercles. Le reste est ignoré sans bruit : un plan d'architecte
   contient quantité de choses dont un fond de plan n'a que faire.
   ============================================================ */

const ENTITES_LUES = ['LINE', 'LWPOLYLINE', 'POLYLINE', 'VERTEX', 'CIRCLE', 'ARC', 'SEQEND'];

/** Découpe un DXF en paires (code, valeur). */
function paires(texte) {
  const lignes = texte.split(/\r\n|\r|\n/);
  const out = [];
  for (let i = 0; i + 1 < lignes.length; i += 2) {
    const code = parseInt(lignes[i].trim(), 10);
    if (Number.isNaN(code)) continue;
    out.push([code, lignes[i + 1].trim()]);
  }
  return out;
}

/**
 * Lit un DXF et renvoie des segments : [[x1,y1,x2,y2], …]
 *
 * Les arcs et les cercles sont facettés — un fond de plan n'a pas
 * besoin de courbes exactes, et des segments se dessinent d'un trait.
 */
export function lireDXF(texte) {
  const p = paires(texte);
  const segments = [];

  // on ne travaille que dans la section ENTITIES
  let debut = p.findIndex(([c, v]) => c === 2 && v === 'ENTITIES');
  if (debut < 0) debut = 0;

  let i = debut;
  let entite = null;
  let champs = null;

  const clore = () => {
    if (entite) ajouter(entite, champs, segments);
    entite = null;
    champs = null;
  };

  for (; i < p.length; i++) {
    const [code, valeur] = p[i];

    if (code === 0) {
      clore();
      if (valeur === 'ENDSEC' || valeur === 'EOF') break;
      if (ENTITES_LUES.includes(valeur)) { entite = valeur; champs = { sommets: [] }; }
      continue;
    }
    if (!entite) continue;

    // Une polyligne répète les codes 10/20 : on accumule au lieu d'écraser.
    if (code === 10) {
      champs.sommets.push({ x: parseFloat(valeur), y: 0 });
      champs.x = parseFloat(valeur);
    } else if (code === 20) {
      if (champs.sommets.length) champs.sommets[champs.sommets.length - 1].y = parseFloat(valeur);
      champs.y = parseFloat(valeur);
    } else if (code === 11) champs.x2 = parseFloat(valeur);
    else if (code === 21) champs.y2 = parseFloat(valeur);
    else if (code === 40) champs.rayon = parseFloat(valeur);
    else if (code === 50) champs.depart = parseFloat(valeur);
    else if (code === 51) champs.fin = parseFloat(valeur);
    else if (code === 70) champs.drapeau = parseInt(valeur, 10) || 0;
  }
  clore();

  return segments;
}

function ajouter(entite, c, segments) {
  if (!c) return;

  if (entite === 'LINE' && c.sommets.length && c.x2 !== undefined) {
    const a = c.sommets[0];
    segments.push([a.x, a.y, c.x2, c.y2]);
    return;
  }

  if (entite === 'LWPOLYLINE' || entite === 'POLYLINE') {
    const s = c.sommets.filter(v => Number.isFinite(v.x) && Number.isFinite(v.y));
    for (let i = 0; i + 1 < s.length; i++) segments.push([s[i].x, s[i].y, s[i + 1].x, s[i + 1].y]);
    // bit 1 du drapeau : polyligne fermée
    if ((c.drapeau & 1) && s.length > 2) {
      const a = s[s.length - 1], b = s[0];
      segments.push([a.x, a.y, b.x, b.y]);
    }
    return;
  }

  if (entite === 'VERTEX' && c.sommets.length) {
    // les sommets d'une POLYLINE arrivent en entités séparées
    ajouter._suite = ajouter._suite || [];
    ajouter._suite.push(c.sommets[0]);
    return;
  }

  if (entite === 'SEQEND') {
    const s = ajouter._suite || [];
    for (let i = 0; i + 1 < s.length; i++) segments.push([s[i].x, s[i].y, s[i + 1].x, s[i + 1].y]);
    ajouter._suite = null;
    return;
  }

  if (entite === 'CIRCLE' && c.rayon > 0 && c.sommets.length) {
    facetter(segments, c.sommets[0].x, c.sommets[0].y, c.rayon, 0, 360);
    return;
  }

  if (entite === 'ARC' && c.rayon > 0 && c.sommets.length) {
    facetter(segments, c.sommets[0].x, c.sommets[0].y, c.rayon,
             c.depart ?? 0, c.fin ?? 360);
  }
}

function facetter(segments, cx, cy, r, depart, fin) {
  let etendue = fin - depart;
  while (etendue <= 0) etendue += 360;
  const pas = Math.max(6, Math.min(72, Math.ceil(etendue / 6)));

  let precedent = null;
  for (let i = 0; i <= pas; i++) {
    const a = (depart + (etendue * i) / pas) * Math.PI / 180;
    const point = [cx + r * Math.cos(a), cy + r * Math.sin(a)];
    if (precedent) segments.push([precedent[0], precedent[1], point[0], point[1]]);
    precedent = point;
  }
}

/* ══════════════════ objet de scène ══════════════════ */

/**
 * Le fond de plan dans la scène.
 *
 * Il vit au ras du sol, sous les machines, et ne reçoit jamais les
 * clics : on doit pouvoir sélectionner une machine posée dessus.
 */
export class Plan {
  constructor(viewer) {
    this.viewer = viewer;
    this.group = new THREE.Group();
    this.group.renderOrder = -1;
    viewer.scene.add(this.group);

    this.etat = {
      type: null,        // 'image' | 'dxf'
      nom: '',
      largeur: 10,       // largeur réelle, en unités de la bibliothèque
      rotation: 0,
      z: 0.002,
      opacite: 0.75,
      offset: [0, 0],
      visible: true,
    };
    this.source = null;  // dataURL ou segments
    this._ratio = 1;     // hauteur / largeur du document importé
  }

  get charge() { return !!this.etat.type; }

  /** Plaque une image au sol. */
  async chargerImage(dataUrl, nom) {
    const image = await new Promise((ok, ko) => {
      const img = new Image();
      img.onload = () => ok(img);
      img.onerror = () => ko(new Error('Image illisible'));
      img.src = dataUrl;
    });

    this._ratio = image.height / image.width || 1;
    this.source = dataUrl;
    this.etat.type = 'image';
    this.etat.nom = nom;
    this._reconstruire();
    return { largeurPixels: image.width, hauteurPixels: image.height };
  }

  /**
   * Rend une page de PDF et la pose comme fond de plan.
   *
   * pdf.js est embarqué dans vendor/ et chargé seulement au premier PDF
   * ouvert : un mégaoctet et demi n'a rien à faire dans le démarrage de
   * ceux qui n'importeront jamais de plan.
   */
  async chargerPDF(donnees, nom, page = 1) {
    // on garde les octets : changer de page ne doit pas redemander le fichier
    this._pdfDonnees = donnees.slice ? donnees.slice() : donnees;

    const pdfjs = await Plan._pdfjs();
    const document = await pdfjs.getDocument({ data: donnees }).promise;

    const numero = Math.min(Math.max(1, page), document.numPages);
    const feuille = await document.getPage(numero);

    // On vise environ 2400 px de large : au-delà, le gain de finesse ne se
    // voit plus au sol et l'image devient trop lourde pour être mémorisée.
    const brut = feuille.getViewport({ scale: 1 });
    const vue = feuille.getViewport({ scale: Math.min(4, 2400 / brut.width) });

    const toile = window.document.createElement('canvas');
    toile.width = Math.round(vue.width);
    toile.height = Math.round(vue.height);
    const contexte = toile.getContext('2d');
    contexte.fillStyle = '#ffffff';                 // un PDF est transparent par défaut
    contexte.fillRect(0, 0, toile.width, toile.height);
    await feuille.render({ canvasContext: contexte, viewport: vue }).promise;

    const info = await this.chargerImage(toile.toDataURL('image/png'), nom);
    this.etat.page = numero;
    this.etat.pages = document.numPages;
    return { ...info, page: numero, pages: document.numPages };
  }

  /** pdf.js, chargé une seule fois, à la demande. */
  static async _pdfjs() {
    if (Plan.__pdfjs) return Plan.__pdfjs;
    const module = await import('../vendor/pdfjs/pdf.min.mjs');
    module.GlobalWorkerOptions.workerSrc = new URL(
      '../vendor/pdfjs/pdf.worker.min.mjs', import.meta.url).href;
    Plan.__pdfjs = module;
    return module;
  }

  /** Redessine un DXF au sol. */
  chargerDXF(texte, nom) {
    const segments = lireDXF(texte);
    if (!segments.length) throw new Error('Aucun tracé exploitable dans ce DXF.');

    // emprise du dessin, pour le ramener à l'origine et le mettre à l'échelle
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [x1, y1, x2, y2] of segments) {
      minX = Math.min(minX, x1, x2); maxX = Math.max(maxX, x1, x2);
      minY = Math.min(minY, y1, y2); maxY = Math.max(maxY, y1, y2);
    }

    const largeur = maxX - minX || 1;
    const hauteur = maxY - minY || 1;
    this._ratio = hauteur / largeur;
    this._empriseDXF = { minX, minY, largeur, hauteur };
    this.source = segments;
    this.etat.type = 'dxf';
    this.etat.nom = nom;
    this._reconstruire();
    return { segments: segments.length, largeurDessin: largeur, hauteurDessin: hauteur };
  }

  regler(patch) {
    Object.assign(this.etat, patch);
    this._reconstruire();
  }

  vider() {
    this._nettoyer();
    this.source = null;
    this.etat.type = null;
    this.etat.nom = '';
  }

  _nettoyer() {
    for (const enfant of [...this.group.children]) {
      this.group.remove(enfant);
      enfant.geometry?.dispose();
      if (enfant.material) {
        enfant.material.map?.dispose();
        enfant.material.dispose();
      }
    }
  }

  _reconstruire() {
    this._nettoyer();
    if (!this.etat.type || !this.source) return;

    const echelle = this.viewer.lib?.scale ?? 1;
    const largeur = this.etat.largeur * echelle;      // en mètres, comme la scène
    const hauteur = largeur * this._ratio;

    if (this.etat.type === 'image') {
      const texture = new THREE.TextureLoader().load(this.source);
      texture.colorSpace = THREE.SRGBColorSpace;
      const maille = new THREE.Mesh(
        new THREE.PlaneGeometry(largeur, hauteur),
        new THREE.MeshBasicMaterial({
          map: texture, transparent: true, opacity: this.etat.opacite,
          depthWrite: false, toneMapped: false,
        }));
      this.group.add(maille);
    } else {
      const e = this._empriseDXF;
      const k = largeur / e.largeur;
      const points = [];
      for (const [x1, y1, x2, y2] of this.source) {
        points.push(
          (x1 - e.minX) * k - largeur / 2, (y1 - e.minY) * k - hauteur / 2, 0,
          (x2 - e.minX) * k - largeur / 2, (y2 - e.minY) * k - hauteur / 2, 0);
      }
      const geometrie = new THREE.BufferGeometry();
      geometrie.setAttribute('position', new THREE.BufferAttribute(new Float32Array(points), 3));
      this.group.add(new THREE.LineSegments(geometrie, new THREE.LineBasicMaterial({
        color: 0x8fb4ff, transparent: true, opacity: this.etat.opacite, depthWrite: false,
      })));
    }

    this.group.position.set(this.etat.offset[0], this.etat.offset[1], this.etat.z);
    this.group.rotation.z = this.etat.rotation * Math.PI / 180;
    this.group.visible = this.etat.visible;

    // jamais cliquable : on sélectionne les machines, pas le calque du dessous
    this.group.traverse(o => { o.raycast = () => {}; });
  }

  /* ══════════ calibration ══════════
     Deux points cliqués sur le plan, la distance réelle entre eux, et
     l'échelle s'ajuste. C'est la façon dont on cale un fond de plan :
     on mesure ce qu'on connaît — une porte, une trame, un mur — plutôt
     que de deviner la largeur totale du document.
     ================================ */

  /**
   * Entre en calibration. Renvoie une promesse qui livre la distance
   * mesurée entre les deux points, en mètres, ou null si l'utilisateur
   * abandonne.
   */
  calibrer() {
    if (!this.charge) return Promise.resolve(null);
    const v = this.viewer;
    const canvas = v.canvas;

    this._arreterCalibration();
    this._reperes = new THREE.Group();
    this._reperes.renderOrder = 997;
    v.scene.add(this._reperes);

    const points = [];
    const plan = new THREE.Plane(new THREE.Vector3(0, 0, 1), -this.etat.z);

    return new Promise(resolve => {
      let depart = null;

      const surPlan = ev => {
        const r = canvas.getBoundingClientRect();
        v.pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
        v.pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
        v.ray.setFromCamera(v.pointer, v.camera);
        const p = new THREE.Vector3();
        return v.ray.ray.intersectPlane(plan, p) ? p : null;
      };

      const bas = ev => { depart = { x: ev.clientX, y: ev.clientY }; };

      const haut = ev => {
        if (!depart) return;
        const bouge = Math.hypot(ev.clientX - depart.x, ev.clientY - depart.y);
        depart = null;
        if (bouge > 5) return;                 // c'était une orbite, pas un clic

        const p = surPlan(ev);
        if (!p) return;
        ev.stopPropagation();
        ev.preventDefault();

        points.push(p);
        this._marquer(p);

        if (points.length === 2) {
          this._tracer(points[0], points[1]);
          const distance = points[0].distanceTo(points[1]);
          fin();
          resolve(distance > 1e-6 ? distance : null);
        }
      };

      const echap = e => { if (e.key === 'Escape') { fin(); resolve(null); } };

      const fin = () => {
        canvas.removeEventListener('pointerdown', bas, true);
        canvas.removeEventListener('pointerup', haut, true);
        removeEventListener('keydown', echap);
        this._enCalibration = false;
      };

      this._enCalibration = true;
      this._finCalibration = () => { fin(); resolve(null); };
      canvas.addEventListener('pointerdown', bas, true);
      canvas.addEventListener('pointerup', haut, true);
      addEventListener('keydown', echap);
    });
  }

  get enCalibration() { return !!this._enCalibration; }

  annulerCalibration() {
    if (this._finCalibration) this._finCalibration();
    this._arreterCalibration();
  }

  _arreterCalibration() {
    if (!this._reperes) return;
    this.viewer.scene.remove(this._reperes);
    this._reperes.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    this._reperes = null;
  }

  _marquer(p) {
    const taille = Math.max(this.viewer.gridStep * 0.8, 0.06);
    const repere = new THREE.Mesh(
      new THREE.SphereGeometry(taille, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xffb020, depthTest: false }));
    repere.position.copy(p);
    this._reperes.add(repere);
  }

  _tracer(a, b) {
    const g = new THREE.BufferGeometry().setFromPoints([a, b]);
    this._reperes.add(new THREE.Line(g, new THREE.LineBasicMaterial({
      color: 0xffb020, depthTest: false, transparent: true,
    })));
  }

  /**
   * Applique le résultat : la distance mesurée devient la distance réelle.
   * Tout se scalant depuis l'origine du groupe, un simple rapport suffit.
   */
  appliquerCalibration(distanceMesuree, distanceReelle) {
    const echelle = this.viewer.lib?.scale ?? 1;
    const voulue = distanceReelle * echelle;          // en mètres
    if (!(distanceMesuree > 1e-6) || !(voulue > 1e-9)) return false;

    this.regler({ largeur: this.etat.largeur * (voulue / distanceMesuree) });
    this._arreterCalibration();
    return true;
  }

  /** Ce qu'il faut retenir pour restituer le plan à la prochaine ouverture. */
  serialiser() {
    if (!this.charge) return null;
    return {
      ...this.etat,
      ratio: this._ratio,
      emprise: this._empriseDXF || null,
      source: this.etat.type === 'image' ? this.source : JSON.stringify(this.source),
    };
  }

  restaurer(donnees) {
    if (!donnees?.type) return;
    this.etat = { ...this.etat, ...donnees };
    this._ratio = donnees.ratio || 1;
    this._empriseDXF = donnees.emprise || null;
    this.source = donnees.type === 'image' ? donnees.source : JSON.parse(donnees.source);
    this._reconstruire();
  }
}
