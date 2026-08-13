import { add, sub, scale, dot, norm, normalize, perp, dist } from './topologie.js';

/* ============================================================
   Osnaps — accrochages de précision (End / Mid / Intersection /
   Perpendiculaire / Sur-mur), indexés spatialement.

   La tolérance est exprimée en MÈTRES : elle vient de la taille
   d'un pixel écran (15 px) convertie à la distance de la caméra.
   ============================================================ */

/** Mètres par pixel à la distance de la cible, pour une caméra perspective. */
export function metresParPixel(camera, hauteurEcranPx, distance) {
  const fovY = camera.fov * Math.PI / 180;
  return (2 * distance * Math.tan(fovY / 2)) / Math.max(1, hauteurEcranPx);
}

/** Index spatial simple : grille uniforme sur les candidats ponctuels. */
class Grille {
  constructor(taille = 1) {
    this.taille = taille;
    this.cellules = new Map();
  }
  _cle(x, y) { return Math.floor(x / this.taille) + ',' + Math.floor(y / this.taille); }
  ajouter(p) {
    const k = this._cle(p.x, p.y);
    if (!this.cellules.has(k)) this.cellules.set(k, []);
    this.cellules.get(k).push(p);
  }
  proches(x, y, r) {
    const out = [];
    const pas = Math.max(1, Math.ceil(r / this.taille));
    const cx = Math.floor(x / this.taille), cy = Math.floor(y / this.taille);
    for (let ix = cx - pas; ix <= cx + pas; ix++)
      for (let iy = cy - pas; iy <= cy + pas; iy++) {
        const c = this.cellules.get(ix + ',' + iy);
        if (c) for (const p of c) out.push(p);
      }
    return out;
  }
}

/**
 * Construit les candidats d'accrochage depuis le graphe :
 *   • End   : extrémités de mur (nœuds) ;
 *   • Mid   : milieu des murs ;
 *   • Intersection : nœuds de degré ≥ 3 (croisements déjà scindés).
 * Renvoie { grille, index: Map }
 */
export function construireIndex(graph) {
  const grille = new Grille(1);
  const ends = [], mids = [], intersections = [];
  for (const n of graph.nodes.values()) {
    const p = { x: n.x, y: n.y, type: n.wallIds.size >= 3 ? 'intersection' : 'end', id: n.id };
    (n.wallIds.size >= 3 ? intersections : ends).push(p);
    grille.ajouter(p);
  }
  for (const w of graph.walls.values()) {
    const f = graph.wallFrame(w);
    const m = add(f.A, scale(f.d, f.len / 2));
    const p = { x: m.x, y: m.y, type: 'mid', wallId: w.id };
    mids.push(p);
    grille.ajouter(p);
  }
  return { grille, ends, mids, intersections };
}

/**
 * Meilleur accrochage dans un rayon de tolérance (mètres), par priorité :
 *   End > Intersection > Mid > Perpendiculaire > Sur-mur.
 * Renvoie null si rien n'est à portée.
 */
export function snapOsnap(pt, graph, tolM) {
  const idx = construireIndex(graph);
  const rayon = tolM;

  // 1) points (End / Intersection / Mid)
  let best = null, bestD = rayon;
  for (const c of idx.grille.proches(pt.x, pt.y, rayon)) {
    const d = dist(pt, c);
    if (d < bestD) { bestD = d; best = c; }
  }
  // priorité : End > Intersection > Mid (à distance égale)
  const poids = { end: 0, intersection: 1, mid: 2 };
  const tente = [];
  for (const c of idx.grille.proches(pt.x, pt.y, rayon)) {
    if (dist(pt, c) <= rayon * 1.05) tente.push(c);
  }
  best = null;
  for (const c of tente) {
    if (!best) best = c;
    else if (poids[c.type] < poids[best.type]) best = c;
    else if (poids[c.type] === poids[best.type] && dist(pt, c) < dist(pt, best)) best = c;
  }

  // 2) sur-mur / prolongation : projection sur la ligne d'axe d'un mur,
  //    bornée (surMur) ou étendue au-delà des extrémités (prolongation).
  let meilleurMur = null, meilleureProj = null, meilleureDm = rayon;
  for (const w of graph.walls.values()) {
    const f = graph.wallFrame(w);
    const t = dot(sub(pt, f.A), f.d);
    const s = t / f.len;                       // pas de borne
    const proj = add(f.A, scale(f.d, s * f.len));
    const d = dist(pt, proj);
    if (d < meilleureDm) { meilleureDm = d; meilleurMur = w; meilleureProj = proj; }
  }

  if (best) {
    return { x: best.x, y: best.y, type: best.type, id: best.id, wallId: best.wallId };
  }
  if (meilleurMur) {
    const f = graph.wallFrame(meilleurMur);
    const t = dot(sub(meilleureProj, f.A), f.d);
    const s = t / f.len;
    const dansSegment = s >= -1e-6 && s <= 1 + 1e-6;
    if (dansSegment) {
      return { x: meilleureProj.x, y: meilleureProj.y, type: 'surMur', wallId: meilleurMur.id, s };
    }
    // Prolongation : ancrée à l'extrémité la plus proche, on suit la ligne
    // d'axe du mur au-delà de ce point (tracking d'extension type Rhino/AutoCAD).
    const ancre = s < 0 ? { x: f.A.x, y: f.A.y } : { x: f.B.x, y: f.B.y };
    const distance = Math.abs(s < 0 ? s : s - 1) * f.len;
    return {
      x: meilleureProj.x, y: meilleureProj.y, type: 'prolongation',
      wallId: meilleurMur.id, s, ancre, distance,
    };
  }
  return null;
}

/** Distance la plus courte d'un point à la ligne d'axe d'un mur (mètres). */
export function distanceAuMur(graph, wallId, pt) {
  const w = graph.walls.get(wallId);
  const f = graph.wallFrame(w);
  const t = dot(sub(pt, f.A), f.d);
  const s = Math.max(0, Math.min(1, t / f.len));
  const proj = add(f.A, scale(f.d, s * f.len));
  return dist(pt, proj);
}
