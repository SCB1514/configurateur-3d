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
        directions prévisibles : la tangente et la perpendiculaire des
        murs qui y aboutissent. Pas les axes du monde : Rhino ne les
        émet pas par défaut, et l'avoir vérifié dans ses réglages a
        évité de reproduire un bruit qu'il a lui-même écarté ;
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

/**
 * Intersections apparentes : le point où deux segments SE COUPERAIENT s'ils
 * étaient prolongés.
 *
 * Rhino l'active par défaut (ExtendToApparentIntersection), et en dessin de
 * plan c'est capital : deux murs qui ne se touchent pas encore ont pourtant
 * un coin, et c'est ce coin qu'on vise pour les raccorder. Sans lui, il faut
 * tracer trop long puis ajuster.
 *
 * On ne retient que les intersections HORS des segments — celles qui sont
 * dessus sont déjà trouvées par l'accrochage d'intersection ordinaire.
 */
export function intersectionsApparentes(segments, p, tol) {
  let meilleur = null, meilleureD = tol * 1.4;
  for (let i = 0; i < segments.length; i++) {
    for (let j = i + 1; j < segments.length; j++) {
      const a = segments[i], b = segments[j];
      const x = croiser(a.o, a.d, b.o, b.d);
      if (!x) continue;

      const surA = projection(x, a), surB = projection(x, b);
      if (surA && surB) continue;                 // vraie intersection, pas apparente
      // trop loin des deux segments : le coin serait invente de toutes pieces
      if (portee(x, a) > a.len * 2.5 && portee(x, b) > b.len * 2.5) continue;

      const d = Math.hypot(x.x - p.x, x.y - p.y);
      if (d < meilleureD) {
        meilleureD = d;
        meilleur = { x: x.x, y: x.y, type: 'apparente',
                     lignes: [{ o: a.o, d: a.d }, { o: b.o, d: b.d }] };
      }
    }
  }
  return meilleur;
}

/** Le point tombe-t-il dans le segment ? */
function projection(x, seg) {
  const t = (x.x - seg.o.x) * seg.d.x + (x.y - seg.o.y) * seg.d.y;
  return t >= -1e-6 && t <= seg.len + 1e-6;
}

/** De combien le point deborde-t-il du segment ? */
function portee(x, seg) {
  const t = (x.x - seg.o.x) * seg.d.x + (x.y - seg.o.y) * seg.d.y;
  return t < 0 ? -t : (t > seg.len ? t - seg.len : 0);
}

/**
 * Tangentes menées d'un point à un cercle.
 *
 * C'est le seul cas, en dessin de plan, où la tangence demande autre chose
 * qu'une direction recopiée : depuis un point extérieur, un cercle admet
 * DEUX tangentes, et leurs points de contact ne se devinent pas à l'œil.
 * Les tracer à la main suppose une construction — le cercle de Thalès sur
 * le segment centre-point — que personne n'a envie de refaire à chaque
 * raccordement.
 *
 * Nos cercles sont polygonisés en segments : la tangence porte donc sur le
 * cercle IDÉAL, celui que l'utilisateur a dessiné et qu'il a toujours en
 * tête, pas sur le polygone qui l'approche. C'est le bon choix — s'accrocher
 * au sommet le plus proche du polygone donnerait un point juste à côté de
 * celui qu'on vise, et le décalage se verrait au raccord.
 *
 * Renvoie les points de contact, du plus proche du curseur au plus loin.
 */
export function tangentesVersCercle(depuis, cercle, p, tol) {
  const vx = cercle.cx - depuis.x, vy = cercle.cy - depuis.y;
  const d = Math.hypot(vx, vy);
  if (d <= cercle.r + 1e-9) return null;        // le point est dedans : pas de tangente

  /* Construction classique : le point de contact voit le segment
     centre-point sous un angle droit. L'angle entre (depuis→centre) et
     (depuis→contact) vaut donc arccos(r / d)... exprimé ici depuis le
     centre, ce qui évite un changement de repère. */
  const base = Math.atan2(-vy, -vx);            // du centre vers le point
  const ecart = Math.acos(cercle.r / d);

  const contacts = [1, -1].map(signe => {
    const a = base + signe * ecart;
    return { x: cercle.cx + cercle.r * Math.cos(a), y: cercle.cy + cercle.r * Math.sin(a) };
  });

  contacts.sort((u, w) => Math.hypot(u.x - p.x, u.y - p.y) - Math.hypot(w.x - p.x, w.y - p.y));
  const proche = contacts[0];
  if (Math.hypot(proche.x - p.x, proche.y - p.y) > tol) return null;

  const dir = { x: proche.x - depuis.x, y: proche.y - depuis.y };
  const n = Math.hypot(dir.x, dir.y) || 1;
  return { x: proche.x, y: proche.y, type: 'tangente',
           lignes: [{ o: { ...depuis }, d: { x: dir.x / n, y: dir.y / n } }] };
}

/** Distance d'un point à la droite (origine, direction unitaire). */
function distDroite(p, o, d) {
  return Math.abs((p.x - o.x) * d.y - (p.y - o.y) * d.x);
}

export class Reperage {
  constructor(options = {}) {
    /* Les valeurs par défaut sont celles relevées dans Rhino lui-même, lues
       dans SmartTrackSettings plutôt que devinées. Qui connaît l'un retrouve
       l'autre, et les chiffres ont été éprouvés par des années d'usage. */
    this.delai = options.delai ?? 300;         // ActivationDelayMilliseconds
    this.maxPoints = options.maxPoints ?? 8;   // MaxSmartPoints
    this.actif = options.actif !== false;      // UseSmartTrack

    /* SmartOrtho est FAUX par défaut dans Rhino, et c'est le réglage qui
       surprend le plus. On croit d'instinct qu'un point de référence doit
       émettre les deux axes du monde ; Rhino ne le fait pas, parce que ces
       deux rayons-là partent de PARTOUT dès qu'on a trois références, et que
       l'écran se remplit de lignes qui ne veulent rien dire.

       Ce qui parle, c'est la géométrie de l'objet survolé : la direction du
       mur qui aboutit à ce point, et sa perpendiculaire. Un alignement sur
       le prolongement d'un mur existant est une intention ; un alignement
       sur l'axe X du monde n'en est une que si le mur est déjà dans cet axe,
       auquel cas la direction du mur le dit déjà. */
    this.ortho = options.ortho === true;       // SmartOrtho
    this.tangentes = options.tangentes !== false;  // SmartTangents
    this.croisements = true;                   // intersections entre rayons

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

    /* Tangente ET perpendiculaire, comme SmartTangents.
       En 2D la tangente d'un mur est sa direction ; sa perpendiculaire est
       ce qui permet de tomber d'aplomb sur lui depuis ailleurs. Sans elle,
       la moitié des alignements utiles manque. */
    const murs = [];
    for (const d of (this.tangentes ? dirs.filter(Boolean) : [])) {
      murs.push(d);
      murs.push({ x: -d.y, y: d.x });
    }

    // deux rayons colinéaires ne servent qu'à doubler le travail
    const garde = [];
    for (const d of [...axes, ...murs]) {
      if (!garde.some(g => Math.abs(g.x * d.y - g.y * d.x) < 1e-6)) garde.push(d);
    }
    this.points.push({ x: p.x, y: p.y, dirs: garde });
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
   * L'ordre importe : un CROISEMENT de deux lignes ou le MILIEU de deux
   * références est un point unique, bien plus informatif qu'un simple
   * alignement où l'on reste libre de glisser. Ils passent donc devant,
   * et avec une tolérance plus large — on pardonne davantage à qui vise
   * un point qu'à qui vise une droite.
   */
  candidat(p, tol) {
    if (!this.actif || !this.points.length) return null;

    // ── points uniques : croisements de rayons ET milieu de deux références
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
          // milieu de la paire (i, j) : le point à mi-chemin de deux repères,
          // le pendant du osnap « Between » des logiciels de CAO — utile même
          // quand les deux références n'ont aucune direction en commun.
          const mx = (this.points[i].x + this.points[j].x) / 2;
          const my = (this.points[i].y + this.points[j].y) / 2;
          const dm = Math.hypot(mx - p.x, my - p.y);
          if (dm < meilleureD) {
            meilleureD = dm;
            const vx = this.points[j].x - this.points[i].x;
            const vy = this.points[j].y - this.points[i].y;
            const n = Math.hypot(vx, vy) || 1;
            meilleur = { x: mx, y: my, type: 'milieu',
                         lignes: [{ o: this.points[i], d: { x: vx / n, y: vy / n } }] };
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
        /* Projection orthogonale du curseur sur le rayon.

           Le signe de t ne compte pas : un guide est une DROITE, pas une
           demi-droite. On rejetait autrefois ce qui tombait « derriere » la
           reference, alors que `segments()` tracait la ligne de part et
           d'autre et que `croiser()` calculait deja les croisements sans
           cette contrainte. Le guide se voyait donc sous un milieu sans
           qu'on puisse s'y accrocher, et le module se contredisait
           lui-meme. Rhino accroche des deux cotes. */
        const t = (p.x - q.x) * d.x + (p.y - q.y) * d.y;
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
