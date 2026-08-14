/* ============================================================
   Repérage intelligent — les points de référence et leurs lignes
   ------------------------------------------------------------
   Le module d'accrochage existant répond à la question « sur quoi
   suis-je ? » : une extrémité, un milieu, une intersection. C'est
   nécessaire, et ce n'est que la moitié du travail.

   L'autre moitié est celle que Rhino appelle SmartTrack et AutoCAD
   le repérage d'objet : « à quoi suis-je ALIGNÉ ? ». On ne vise pas
   le coin de la pièce, on vise le point qui est à l'aplomb de ce
   coin et à la hauteur de cet autre mur. Ce point n'existe nulle
   part dans le modèle — aucun accrochage ne peut le trouver — et
   c'est pourtant celui qu'on veut neuf fois sur dix.

   Le mécanisme tient en trois temps :

     1. ACQUISITION — survoler un point d'accrochage sans cliquer,
        le temps d'un battement, le retient comme référence ;
     2. LIGNES — chaque référence émet des rayons dans les
        directions prévisibles : les deux axes, et la direction des
        murs qui y aboutissent ;
     3. CROISEMENTS — l'intersection de deux rayons issus de deux
        références différentes est un point candidat.

   Le délai d'acquisition n'est pas un ornement. Sans lui, le
   moindre passage de souris sème des références partout et l'écran
   se couvre de lignes : le repérage devient un bruit dont on
   cherche à se débarrasser plutôt qu'une aide.
   ============================================================ */

const EPS = 1e-9;

/** Intersection de deux droites données par un point et une direction. */
function croiser(p1, d1, p2, d2) {
  const den = d1.x * d2.y - d1.y * d2.x;
  if (Math.abs(den) < 1e-7) return null;          // parallèles
  const t = ((p2.x - p1.x) * d2.y - (p2.y - p1.y) * d2.x) / den;
  return { x: p1.x + d1.x * t, y: p1.y + d1.y * t };
}

/** Distance d'un point à la droite (origine, direction unitaire). */
function distDroite(p, o, d) {
  return Math.abs((p.x - o.x) * d.y - (p.y - o.y) * d.x);
}

export class Reperage {
  constructor(options = {}) {
    /* Les réglages portent les mêmes noms que dans Rhino, et les mêmes
       valeurs par défaut : qui connaît l'un retrouve l'autre. */
    this.delai = options.delai ?? 250;        // ms de survol avant acquisition
    this.maxPoints = options.maxPoints ?? 4;  // au-delà, l'écran devient illisible
    this.actif = options.actif !== false;
    this.ortho = true;                        // rayons selon les deux axes
    this.paralleles = true;                   // rayons selon les murs aboutissant
    this.croisements = true;                  // intersections entre rayons

    this.points = [];        // [{ x, y, dirs:[{x,y}], t }]
    this._candidat = null;   // point survolé en attente d'acquisition
    this._depuis = 0;
  }

  vider() { this.points = []; this._candidat = null; }

  /**
   * Signale un survol. `ancre` est le point d'accrochage sous le curseur,
   * ou null. `dirs` sont les directions remarquables en ce point.
   *
   * L'acquisition se fait au temps passé, pas au mouvement : c'est ce qui
   * distingue une intention d'un passage.
   */
  survol(ancre, dirs, maintenant = performance.now()) {
    if (!this.actif) return;
    if (!ancre) { this._candidat = null; return; }

    const meme = this._candidat
      && Math.hypot(this._candidat.x - ancre.x, this._candidat.y - ancre.y) < 1e-6;

    if (!meme) { this._candidat = { ...ancre }; this._depuis = maintenant; return; }
    if (maintenant - this._depuis < this.delai) return;

    this.acquerir(ancre, dirs);
    this._candidat = null;
  }

  /** Retient un point comme référence. Le plus ancien sort quand c'est plein. */
  acquerir(p, dirs = []) {
    if (this.points.some(q => Math.hypot(q.x - p.x, q.y - p.y) < 1e-6)) return;

    const axes = this.ortho ? [{ x: 1, y: 0 }, { x: 0, y: 1 }] : [];
    const murs = this.paralleles ? dirs.filter(Boolean) : [];
    this.points.push({ x: p.x, y: p.y, dirs: [...axes, ...murs] });
    while (this.points.length > this.maxPoints) this.points.shift();
  }

  /** Retire la référence la plus proche, ou toutes si aucune n'est proche. */
  oublier(p, tol) {
    const i = this.points.findIndex(q => Math.hypot(q.x - p.x, q.y - p.y) < tol);
    if (i >= 0) this.points.splice(i, 1); else this.vider();
  }

  /**
   * Le meilleur candidat de repérage sous le curseur, ou null.
   *
   * L'ordre importe : un CROISEMENT de deux lignes est un point unique,
   * bien plus informatif qu'un simple alignement où l'on reste libre de
   * glisser. Il passe donc devant, et avec une tolérance plus large — on
   * pardonne davantage à qui vise un point qu'à qui vise une droite.
   */
  candidat(p, tol) {
    if (!this.actif || !this.points.length) return null;

    // ── croisements de deux rayons issus de références différentes
    if (this.croisements) {
      let meilleur = null, meilleureD = tol * 1.6;
      for (let i = 0; i < this.points.length; i++) {
        for (let j = i + 1; j < this.points.length; j++) {
          for (const d1 of this.points[i].dirs) {
            for (const d2 of this.points[j].dirs) {
              const x = croiser(this.points[i], d1, this.points[j], d2);
              if (!x) continue;
              const d = Math.hypot(x.x - p.x, x.y - p.y);
              if (d < meilleureD) {
                meilleureD = d;
                meilleur = { x: x.x, y: x.y, type: 'croisement',
                             lignes: [{ o: this.points[i], d: d1 }, { o: this.points[j], d: d2 }] };
              }
            }
          }
        }
      }
      if (meilleur) return meilleur;
    }

    // ── simple alignement sur un rayon
    let meilleur = null, meilleureD = tol;
    for (const q of this.points) {
      for (const d of q.dirs) {
        const dd = distDroite(p, q, d);
        if (dd >= meilleureD) continue;
        // projection orthogonale du curseur sur le rayon
        const t = (p.x - q.x) * d.x + (p.y - q.y) * d.y;
        if (t < EPS) continue;                     // derrière la référence
        meilleureD = dd;
        meilleur = { x: q.x + d.x * t, y: q.y + d.y * t, type: 'alignement',
                     lignes: [{ o: q, d }] };
      }
    }
    return meilleur;
  }

  /** Les segments à dessiner pour un candidat, bornés à une longueur visible. */
  static segments(candidat, longueur = 60) {
    if (!candidat?.lignes) return [];
    return candidat.lignes.map(({ o, d }) => ({
      a: { x: o.x - d.x * longueur, y: o.y - d.y * longueur },
      b: { x: o.x + d.x * longueur, y: o.y + d.y * longueur },
    }));
  }
}
