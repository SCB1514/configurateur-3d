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
