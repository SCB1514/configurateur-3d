/* ============================================================
   Core — graphe topologique 2D (mètres)
   ------------------------------------------------------------
   Le modèle de données déconnecté du rendu. Tout est en mètres,
   en 2D (x, y), dans le plan horizontal. Z est l'apanage du 3D.

   Un mur n'est jamais décrit par ses coins : ses coins sont des
   FONCTIONS de (nœud début, nœud fin, épaisseur, voisins). C'est
   ce qui permet de déplacer un nœud et de recalculer tous les
   murs connectés sans incohérence.

   Ce module est PUR : aucune dépendance à Three.js.
   ============================================================ */

const EPS = 1e-9;

/* ---------- algèbre 2D ---------- */
export const add = (a, b) => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y });
export const scale = (v, k) => ({ x: v.x * k, y: v.y * k });
export const dot = (a, b) => a.x * b.x + a.y * b.y;
export const cross = (a, b) => a.x * b.y - a.y * b.x;
export const norm = (v) => Math.hypot(v.x, v.y);
export const normalize = (v) => {
  const n = norm(v) || 1;
  return { x: v.x / n, y: v.y / n };
};
export const perp = (v) => ({ x: -v.y, y: v.x });   // normale gauche
export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* ---------- intersections ---------- */

/** Intersection de deux SEGMENTS bornés : (p→q) ∩ (r→s).
 *  Renvoie { t, u, pt } avec t∈[0,1] le long de (p→q), ou null. */
export function segmentIntersect(p, q, r, s) {
  const d1 = sub(q, p), d2 = sub(s, r);
  const denom = cross(d1, d2);
  if (Math.abs(denom) < EPS) return null;            // parallèles
  const t = cross(sub(r, p), d2) / denom;
  const u = cross(sub(r, p), d1) / denom;
  if (t < EPS || t > 1 - EPS || u < EPS || u > 1 - EPS) return null;
  return { t, u, pt: add(p, scale(d1, t)) };
}

/** Intersection de deux DROITES infinies : (p + t·r) ∩ (q + u·s). */
export function lineIntersect(p, r, q, s) {
  const denom = cross(r, s);
  if (Math.abs(denom) < EPS) return null;
  const t = cross(sub(q, p), s) / denom;
  return add(p, scale(r, t));
}

/**
 * Décalage LATÉRAL du corps d'un mur selon sa justification, relatif à la
 * ligne d'axe tracée (le « nu » est la face qui coïncide avec l'axe) :
 *   • centre    : décalage nul (le corps reste centré sur l'axe) ;
 *   • interieur : l'axe EST la face intérieure (corps repoussé vers l'extérieur) ;
 *   • exterieur : l'axe EST la face extérieure (corps repoussé vers l'intérieur).
 * `f` est la frame du mur { A, d, n (normale gauche), len }.
 */
export function decalageCorps(w, f) {
  const k = { centre: 0, interieur: 1, exterieur: -1 }[w.justification] || 0;
  return scale(f.n, -k * (w.thickness || 0) / 2);
}

/**
 * Décalages des DEUX faces d'un mur le long de sa normale gauche CANONIQUE
 * (celle de `wallFrame`, fixe pour A→B, indépendante de l'extrémité consultée) :
 *   { g } face gauche (+n), { r } face droite (−n).
 *   • centre    : g = +h,  r = −h  (comportement historique, inchangé) ;
 *   • interieur : g = 0,   r = −épaisseur  (l'axe tracé EST la face intérieure) ;
 *   • exterieur : g = +ép., r = 0  (l'axe tracé EST la face extérieure).
 * Porté depuis la branche « Open code » : ces formules sont correctes en
 * elles-mêmes — ce qui ne l'était pas, c'est la façon dont `cornerPoints`
 * les consommait (voir plus bas, `localeG`/`localeR`).
 */
export function facesMur(w) {
  const t = w.thickness || 0, h = t / 2;
  if (w.justification === 'interieur') return { g: 0, r: -t };
  if (w.justification === 'exterieur') return { g: t, r: 0 };
  return { g: h, r: -h };
}

/* ---------- accroche (snapping) ---------- */

/**
 * Aimante un point, par priorité décroissante :
 *   1. nœud existant (tolérance `rayonNoeud`, en m) ;
 *   2. alignement orthogonal strict par rapport à `ancre` (seuil angulaire) ;
 *   3. grille (arrondi au pas).
 */
export function snapPoint(pt, { nodes = [], ancre = null, gridStep = 0.1,
  rayonNoeud = 0.25, angleSeuil = (5 * Math.PI) / 180 } = {}) {
  // 1. nœud
  let meilleur = null, meilleureD = rayonNoeud;
  for (const n of nodes) {
    const d = dist(pt, n);
    if (d < meilleureD) { meilleureD = d; meilleur = n; }
  }
  if (meilleur) return { ...meilleur, type: 'noeud' };

  let out = { ...pt, type: 'libre' };

  // 2. orthogonal strict
  if (ancre) {
    const angle = Math.atan2(out.y - ancre.y, out.x - ancre.x);
    const k = Math.round(angle / (Math.PI / 2));
    const cible = k * (Math.PI / 2);
    if (Math.abs(angle - cible) <= angleSeuil) {
      const r = dist(out, ancre);
      out = { x: ancre.x + r * Math.cos(cible), y: ancre.y + r * Math.sin(cible), type: 'ortho' };
    }
  }

  // 3. grille
  return { x: Math.round(out.x / gridStep) * gridStep,
           y: Math.round(out.y / gridStep) * gridStep, type: out.type };
}

/* ---------- graphe topologique ---------- */

export class PlanGraph {
  constructor() {
    this.nodes = new Map();   // id -> { id, x, y, wallIds:Set }
    this.walls = new Map();   // id -> { id, a, b, thickness, height, openings:[] }
    this._n = 0;
  }

  _uid(p) { return (p || 'n') + (++this._n); }

  addNode(x, y) {
    const id = this._uid('n');
    this.nodes.set(id, { id, x, y, wallIds: new Set() });
    return id;
  }

  /** Crée un mur entre deux nœuds. Fusionne deux murs colinéaires superposés ? Non : un mur par segment. */
  addWall(a, b, { thickness = 0.15, height = 2.7, elevation = 0, justification = 'centre' } = {}) {
    if (a === b) return null;
    const id = this._uid('w');
    const wall = { id, a, b, thickness, height, elevation, justification, openings: [] };
    this.walls.set(id, wall);
    this.nodes.get(a).wallIds.add(id);
    this.nodes.get(b).wallIds.add(id);
    return id;
  }

  removeWall(id) {
    const w = this.walls.get(id);
    if (!w) return;
    this.nodes.get(w.a)?.wallIds.delete(id);
    this.nodes.get(w.b)?.wallIds.delete(id);
    this.walls.delete(id);
  }

  /** Murs incident à un nœud. */
  incident(nodeId) {
    return [...(this.nodes.get(nodeId)?.wallIds || [])];
  }

  /* ---------- géométrie dérivée ---------- */

  /** Vecteurs d'un mur : { A, B, d (unitaire), n (normale gauche), len }. */
  wallFrame(w) {
    const A = this.node(w.a), B = this.node(w.b);
    const dx = B.x - A.x, dy = B.y - A.y;
    const len = Math.hypot(dx, dy) || 1;
    const d = { x: dx / len, y: dy / len };
    return { A, B, d, n: perp(d), len };
  }

  node(id) {
    const n = this.nodes.get(id);
    return { x: n.x, y: n.y };
  }

  /**
   * Les deux coins d'un mur à l'une de ses extrémités, avec jonction.
   * Renvoie { left, right } relatif à la direction A→B du mur
   * (left = côté +n, right = côté -n).
   *
   * Jonctions gérées :
   *   • degré 1            → coupe droite (extrémité libre) ;
   *   • degré 2 en L       → miter (intersection des faces de même côté) ;
   *   • degré 2 colinéaire → faces continues, coupe droite partagée ;
   *   • degré 3 en T       → le « poteau » étend ses faces jusqu'à la face
   *                          de la ligne traversante ; les murs traversants
   *                          continuent droit (coupe droite) ;
   *   • degré 4 (croix)    → chaque mur continue droit (coupe droite).
   */
  /**
   * Décalages locaux d'un mur, exprimés le long de SA PROPRE direction
   * d'approche à l'extrémité `atEnd` (celle que `cornerPoints` appelle
   * `left = perp(dInto)`) — PAS le long de la normale canonique A→B.
   *
   * C'est la pièce qui manquait à la justification (centre/intérieur/
   * extérieur) : `facesMur` donne des décalages canoniques, fixes quelle
   * que soit l'extrémité consultée, mais la géométrie de coin raisonne en
   * « quel côté ai-je à ma gauche en approchant CE nœud », qui s'inverse
   * entre l'extrémité a et l'extrémité b d'un même mur. Pour un mur centré
   * (g = h, r = -h), le retournement est invisible (g = -r) ; c'est pour ça
   * que l'ancien code s'en tirait avec une seule paire (h, -h) — la
   * justification asymétrique (g ≠ -r) le révèle immédiatement.
   */
  _decalagesLocaux(wall, atEnd) {
    const { g, r } = facesMur(wall);
    return atEnd === 'b' ? { g, r } : { g: -r, r: -g };
  }

  cornerPoints(wallId, end) {
    const w = this.walls.get(wallId);
    const nodeId = end === 'a' ? w.a : w.b;
    const otherId = end === 'a' ? w.b : w.a;
    const P = this.node(nodeId), O = this.node(otherId);
    const dInto = normalize(sub(P, O));      // direction vers le nœud
    const left = perp(dInto);
    const { g, r } = this._decalagesLocaux(w, end);

    let L = add(P, scale(left, g));          // côté +perp(dInto)
    let R = add(P, scale(left, r));

    const others = this.incident(nodeId).filter(id => id !== wallId);

    // — L-cornet : unique voisin non colinéaire.
    //   Les faces de même côté ne se font PAS face : à un angle, la face
    //   « gauche » d'un mur rencontre la face « droite » du voisin (côtés
    //   opposés). Inverser produit un chanfrein sur l'angle extérieur —
    //   exactement le défaut observé quand ce pairage est fait avec des
    //   décalages CANONIQUES (A→B fixes) au lieu de décalages LOCAUX : deux
    //   murs consécutifs d'une polyligne se rejoignent presque toujours par
    //   l'extrémité b de l'un et l'extrémité a de l'autre, la seule
    //   situation où canonique et local divergent.
    if (others.length === 1) {
      const o = this.walls.get(others[0]);
      const oOther = o.a === nodeId ? o.b : o.a;
      const oEnd = o.a === nodeId ? 'a' : 'b';
      const dO = normalize(sub(P, this.node(oOther)));
      if (Math.abs(cross(dInto, dO)) > 1e-6) {
        const oLeft = perp(dO);
        const fo = this._decalagesLocaux(o, oEnd);
        L = lineIntersect(add(P, scale(left, g)), dInto, add(P, scale(oLeft, fo.r)), dO) ?? L;
        R = lineIntersect(add(P, scale(left, r)), dInto, add(P, scale(oLeft, fo.g)), dO) ?? R;
      }
    }
    // — T : deux voisins colinéaires entre eux → ce mur est le poteau
    else if (others.length === 2) {
      const a = this.walls.get(others[0]), b = this.walls.get(others[1]);
      const aEnd = a.a === nodeId ? 'a' : 'b';
      const dA = normalize(sub(P, this.node(a.a === nodeId ? a.b : a.a)));
      const dB = normalize(sub(P, this.node(b.a === nodeId ? b.b : b.a)));
      if (Math.abs(cross(dA, dB)) < 1e-6) {
        const nT = perp(dA);                       // normale de la ligne traversante
        const fa = this._decalagesLocaux(a, aEnd);  // décalages LOCAUX du mur traversant
        const signe = dot(left, nT) >= 0 ? 1 : -1;  // face traversante du côté du poteau
        const face = add(P, scale(nT, signe > 0 ? fa.g : fa.r));
        L = lineIntersect(add(P, scale(left, g)), dInto, face, dA) ?? L;
        R = lineIntersect(add(P, scale(left, r)), dInto, face, dA) ?? R;
      }
    }

    // Repasser en repère du mur (direction A→B) :
    //   à l'extrémité b, dInto = +d  → L est le côté gauche ;
    //   à l'extrémité a, dInto = -d  → L est le côté droit.
    return end === 'b' ? { left: L, right: R } : { left: R, right: L };
  }

  /**
   * Contour 2D du mur en CCW (vu du +Z), sans percements :
   *   [ right@a, right@b, left@b, left@a ]
   */
  wallOutline(wallId) {
    const ca = this.cornerPoints(wallId, 'a');
    const cb = this.cornerPoints(wallId, 'b');
    return [ca.right, cb.right, cb.left, ca.left];
  }

  /** Percement rectangulaire (trou) en coordonnées monde 2D, CW. */
  openingOutline(w, opening) {
    const { A, d, n, len } = this.wallFrame(w);
    const { g, r } = facesMur(w);   // décalages canoniques : suivent la justification du mur
    const s0 = opening.s0 * len, s1 = opening.s1 * len;
    // Le trou traverse l'épaisseur : de r à g le long de n (pas de corner-pairing
    // ici, un seul mur, donc les décalages canoniques suffisent).
    const a = add(add(A, scale(d, s0)), scale(n, r));
    const b = add(add(A, scale(d, s0)), scale(n, g));
    const c = add(add(A, scale(d, s1)), scale(n, g));
    const d2 = add(add(A, scale(d, s1)), scale(n, r));
    return [a, b, c, d2];   // sens inverse du contour CCW
  }

  /**
   * Caisse (volume d'encombrement) d'un percement, pour le perçage booléen
   * (CSG) : une boîte alignée sur le mur, à soustraire du maillage du mur.
   * z0/z1 sont LOCALES au mur (de 0 à height), pas dans le repère monde :
   * l'élévation du niveau est appliquée au mur, pas au trou.
   * Renvoie { cx, cy, largeur, epaisseur, angle, z0, z1 } en mètres.
   */
  caisseOuverture(w, opening) {
    const f = this.wallFrame(w);
    const largeur = (opening.s1 - opening.s0) * f.len;
    const sMid = (opening.s0 + opening.s1) / 2;
    const c = add(f.A, scale(f.d, sMid * f.len));
    return {
      cx: c.x, cy: c.y,
      largeur,
      epaisseur: w.thickness,
      angle: Math.atan2(f.d.y, f.d.x),
      z0: opening.z0 || 0,
      z1: opening.z1 ?? w.height,
    };
  }

  /** Point sur la ligne d'axe d'un mur à la position normalisée s ∈ [0,1]. */
  pointSurMur(w, s) {
    const f = this.wallFrame(w);
    return add(f.A, scale(f.d, s * f.len));
  }

  /**
   * Le mur dont la ligne d'axe passe à moins de `tol` (mètres) du point,
   * et la position normalisée s du point projeté. Renvoie null sinon.
   */
  murSous(point, tol = 0.25) {
    let best = null, bestD = tol;
    for (const w of this.walls.values()) {
      const f = this.wallFrame(w);
      const t = dot(sub(point, f.A), f.d);
      const s = Math.max(0, Math.min(1, t / f.len));
      const proj = add(f.A, scale(f.d, s * f.len));
      const d = dist(point, proj);
      if (d < bestD) { bestD = d; best = { wallId: w.id, s, pt: proj, wall: w }; }
    }
    return best;
  }

  /** Le nœud le plus proche à moins de `tol` (mètres), ou null. */
  nodeSous(point, tol = 0.25) {
    let best = null, bestD = tol;
    for (const n of this.nodes.values()) {
      const d = dist(point, n);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  /** Déplace un nœud : les murs connectés suivent (recalcul automatique). */
  setNodePos(id, x, y) {
    const n = this.nodes.get(id);
    if (!n) return false;
    n.x = x; n.y = y;
    return true;
  }

  /** Supprime un mur et ses nœuds devenus orphelins (sans mur). */
  supprimerMur(wallId) {
    const w = this.walls.get(wallId);
    if (!w) return;
    this.nodes.get(w.a)?.wallIds.delete(wallId);
    this.nodes.get(w.b)?.wallIds.delete(wallId);
    this.walls.delete(wallId);
    for (const id of [w.a, w.b]) {
      const n = this.nodes.get(id);
      if (n && n.wallIds.size === 0) this.nodes.delete(id);
    }
  }

  /* ---------- scission ---------- */

  /**
   * Scinde un mur au paramètre t (0..1) le long du segment.
   * La première partie GARDE l'id d'origine ; la seconde reçoit un id neuf.
   * `nodeId` (optionnel) : nœud à réutiliser comme point de coupe (croisement).
   * Les ouvertures sont réparties entre les deux morceaux, renormalisées.
   */
  splitWall(wallId, t, nodeId = null) {
    const w = this.walls.get(wallId);
    if (!w || t <= 1e-6 || t >= 1 - 1e-6) return null;

    const f = this.wallFrame(w);
    const P = { x: f.A.x + f.d.x * t * f.len, y: f.A.y + f.d.y * t * f.len };
    const mid = nodeId || this.addNode(P.x, P.y);

    const gauche = [], droite = [];
    for (const o of w.openings) {
      if (o.s1 <= t) gauche.push({ ...o, s0: o.s0 / t, s1: o.s1 / t });
      else if (o.s0 >= t) droite.push({ ...o, s0: (o.s0 - t) / (1 - t), s1: (o.s1 - t) / (1 - t) });
      // sinon : le percement chevauche la coupe → ignoré (cas dégénéré)
    }

    const ancienB = w.b;
    const id2 = this._uid('w');
    const w2 = { id: id2, a: mid, b: ancienB, thickness: w.thickness, height: w.height,
                 elevation: w.elevation, justification: w.justification, openings: droite };

    w.b = mid;                       // première partie : a → mid (garde l'id)
    w.openings = gauche;
    this.walls.set(id2, w2);

    this.nodes.get(mid).wallIds.add(wallId);
    this.nodes.get(mid).wallIds.add(id2);
    this.nodes.get(ancienB).wallIds.delete(wallId);
    this.nodes.get(ancienB).wallIds.add(id2);
    return mid;
  }

  /**
   * Croise un mur neuf avec tous les murs existants : crée UN nœud partagé à
   * chaque intersection et scinde les deux murs. Rend le graphe planaire.
   */
  intersectAndSplit(newWallId) {
    const w = this.walls.get(newWallId);
    if (!w) return [];
    const f = this.wallFrame(w);

    const hits = [];
    for (const otherId of [...this.walls.keys()]) {
      if (otherId === newWallId) continue;
      const o = this.walls.get(otherId);
      const r = segmentIntersect(f.A, f.B, this.wallFrame(o).A, this.wallFrame(o).B);
      if (r) hits.push({ t: r.t, u: r.u, otherId });
    }

    // Du plus proche au plus lointain le long du mur neuf ; à chaque coupe le
    // « reste » (seconde partie) devient le segment à découper ensuite.
    hits.sort((a, b) => a.t - b.t);
    const crees = [];
    let mur = newWallId;
    let acc = 0;                      // t-original déjà consommé

    for (const h of hits) {
      const tLocal = (h.t - acc) / (1 - acc);
      const nid = this.splitWall(mur, tLocal);
      if (!nid) continue;
      crees.push(nid);
      const morceau = [...this.walls.values()].find(x => x.a === nid);
      mur = morceau ? morceau.id : mur;
      acc = h.t;
      // le mur existant est scindé au MÊME nœud : les deux se raccordent
      this.splitWall(h.otherId, h.u, nid);
    }
    return crees;
  }

  /* ---------- pièces (détection des cycles minimaux) ---------- */

  _halfEdges() {
    const hes = [];
    for (const w of this.walls.values()) {
      const A = this.node(w.a), B = this.node(w.b);
      const id1 = w.id + ':f', id2 = w.id + ':r';
      hes.push({
        id: id1, twin: id2, origin: w.a, target: w.b, wallId: w.id,
        angle: Math.atan2(B.y - A.y, B.x - A.x),
      });
      hes.push({
        id: id2, twin: id1, origin: w.b, target: w.a, wallId: w.id,
        angle: Math.atan2(A.y - B.y, A.x - B.x),
      });
    }
    return hes;
  }

  /**
   * Parcours des faces d'un graphe planaire (tour-à-gauche).
   * Renvoie les polygones fermés des pièces, en CCW, en mètres.
   */
  detectRooms() {
    const hes = this._halfEdges();
    const parId = new Map(hes.map(h => [h.id, h]));
    const parNoeud = new Map();   // nodeId -> demi-arêtes sortantes triées par angle
    for (const he of hes) {
      if (!parNoeud.has(he.origin)) parNoeud.set(he.origin, []);
      parNoeud.get(he.origin).push(he);
    }
    for (const liste of parNoeud.values()) liste.sort((a, b) => a.angle - b.angle);
    const index = new Map();      // demi-arête -> { liste, position }
    for (const [nid, liste] of parNoeud) liste.forEach((he, i) => index.set(he.id, { liste, i }));

    const visitees = new Set();
    const rooms = [];

    for (const he of hes) {
      if (visitees.has(he.id)) continue;
      const boucle = [];
      let cur = he;
      do {
        visitees.add(cur.id);
        boucle.push(cur);
        // au nœud d'arrivée, on prend la demi-arête sortante immédiatement
        // AVANT la jumelle (tour à gauche) pour garder la face à gauche.
        const twin = parId.get(cur.twin);
        const pos = index.get(twin.id);
        cur = pos.liste[(pos.i - 1 + pos.liste.length) % pos.liste.length];
      } while (cur.id !== he.id);

      const pts = boucle.map(h => this.node(h.origin));
      if (signedArea(pts) > 1e-6) rooms.push(pts);
    }
    return rooms;
  }
}

/* ---------- aire signée ---------- */
export function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;   // m²
}
