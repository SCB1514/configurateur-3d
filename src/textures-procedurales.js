import * as THREE from '../vendor/three/three.module.js';

/* ============================================================
   Textures fabriquées sur place
   ------------------------------------------------------------
   Une bibliothèque de textures d'architecture aurait été plus
   rapide. Celle qui sert de référence dans le métier interdit
   expressément deux choses que ce projet ferait : télécharger
   par script, et republier les images sur un autre site. Or le
   configurateur est publié, et tout ce qu'il embarque part avec
   lui.

   On fabrique donc les matières ici. Le procédé a d'ailleurs
   trois avantages qui ne sont pas des consolations :

     — rien à télécharger : une texture de 1024 pixels pèse zéro
       octet sur le réseau, elle naît dans le navigateur ;
     — la teinte suit le matériau. Un même bois se décline en
       chêne clair ou en noyer sans refaire d'image ;
     — pas de raccord visible : le bruit est cyclique par
       construction, la texture se répète sans couture.

   Chaque matière rend trois cartes — couleur, rugosité, relief —
   car c'est leur désaccord qui fait la matière : un bois dont le
   veinage assombrit SANS changer le brillant reste une
   photographie collée sur un plan.
   ============================================================ */

/* ══════════════════ bruit cyclique ══════════════════ */

/**
 * Bruit de valeur périodique.
 *
 * La périodicité n'est pas un détail : une texture dont le bruit ne boucle
 * pas montre une couture à chaque répétition, et sur un sol de douze mètres
 * la couture se voit avant la matière. On échantillonne donc une grille
 * refermée sur elle-même.
 */
function grille(periode, graine) {
  const g = new Float32Array(periode * periode);
  let e = graine >>> 0;
  for (let i = 0; i < g.length; i++) {
    // générateur congruentiel : reproductible d'une session à l'autre,
    // ce qui évite qu'un même bloc change d'aspect à chaque rechargement
    e = (e * 1664525 + 1013904223) >>> 0;
    g[i] = e / 4294967296;
  }
  return { g, n: periode };
}

function lire(champ, x, y) {
  const { g, n } = champ;
  const xi = ((x % n) + n) % n, yi = ((y % n) + n) % n;
  const x0 = Math.floor(xi), y0 = Math.floor(yi);
  const x1 = (x0 + 1) % n, y1 = (y0 + 1) % n;
  const fx = xi - x0, fy = yi - y0;
  // interpolation adoucie : le lissage cubique évite les losanges visibles
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = g[y0 * n + x0] * (1 - sx) + g[y0 * n + x1] * sx;
  const b = g[y1 * n + x0] * (1 - sx) + g[y1 * n + x1] * sx;
  return a * (1 - sy) + b * sy;
}

/** Somme d'octaves : le grain fin par-dessus la structure large. */
function fractal(champs, x, y, octaves = 4) {
  let v = 0, amplitude = 1, total = 0, f = 1;
  for (let o = 0; o < octaves && o < champs.length; o++) {
    v += lire(champs[o], x * f, y * f) * amplitude;
    total += amplitude;
    amplitude *= 0.5;
    f *= 2;
  }
  return v / total;
}

function champs(periode, graine, n = 4) {
  return Array.from({ length: n }, (_, i) => grille(periode, graine + i * 7919));
}

/* ══════════════════ fabriques ══════════════════ */

const FABRIQUES = {
  /**
   * Béton ciré. Le grain est fin et la rugosité varie peu : c'est
   * justement cette faible variation qui distingue un sol poli d'un sol brut.
   */
  beton(px, teinte) {
    return dessiner(px, teinte, (u, v, f) => {
      const grain = fractal(f, u * 9, v * 9, 4);
      const tache = fractal(f, u * 2.2, v * 2.2, 2);
      const clair = 0.86 + grain * 0.20 + tache * 0.10;
      return { clair, rugosite: 0.76 + grain * 0.16, relief: grain * 0.35 + tache * 0.2 };
    });
  },

  /**
   * Bois en lames. Le veinage suit la longueur, les lames se décalent, et
   * chaque lame a sa propre teinte — sans quoi le sol paraît imprimé.
   */
  bois(px, teinte) {
    const LAMES = 6;
    return dessiner(px, teinte, (u, v, f) => {
      const lame = Math.floor(v * LAMES);
      const decalage = ((lame * 0.37) % 1);
      const uu = (u + decalage) % 1;
      const dansLame = v * LAMES - lame;

      // le veinage : des anneaux etires dans le sens de la lame
      const trame = fractal(f, uu * 3.5, (lame * 13.7 + dansLame * 1.2), 4);
      const veine = Math.abs(Math.sin((uu * 14 + trame * 5) * Math.PI));
      const nuance = 0.88 + ((lame * 0.29) % 1) * 0.22;

      // le joint entre lames, sombre et net
      const joint = dansLame < 0.02 || dansLame > 0.98 ? 0.45 : 1;

      const clair = (0.72 + veine * 0.34) * nuance * joint;
      return { clair, rugosite: 0.34 + veine * 0.22, relief: veine * 0.55 + (1 - joint) * 0.6 };
    });
  },

  /**
   * Caoutchouc moucheté, celui des sols de salle de sport : une base sombre
   * et des éclats clairs répartis sans ordre.
   */
  caoutchouc(px, teinte) {
    return dessiner(px, teinte, (u, v, f) => {
      const grain = fractal(f, u * 26, v * 26, 3);
      const eclat = grain > 0.72 ? (grain - 0.72) * 3.4 : 0;
      const clair = 0.88 + eclat * 0.9;
      return { clair, rugosite: 0.94 - eclat * 0.1, relief: grain * 0.5 };
    });
  },

  /**
   * Métal brossé. Le brossage est directionnel : le bruit est étiré cent
   * fois dans un axe, et c'est cette anisotropie qui fait tout l'effet.
   */
  metal(px, teinte) {
    return dessiner(px, teinte, (u, v, f) => {
      const stries = fractal(f, u * 220, v * 1.6, 3);
      const ondulation = fractal(f, u * 3, v * 3, 2);
      const clair = 0.9 + stries * 0.18 + ondulation * 0.06;
      return { clair, rugosite: 0.26 + stries * 0.2, relief: stries * 0.8 };
    });
  },

  /** Tissu tramé, pour les assises et les tapis. */
  tissu(px, teinte) {
    return dessiner(px, teinte, (u, v, f) => {
      const trame = (Math.sin(u * px * 0.45) * Math.sin(v * px * 0.45) + 1) * 0.5;
      const fibre = fractal(f, u * 40, v * 40, 3);
      const clair = 0.82 + trame * 0.2 + fibre * 0.14;
      return { clair, rugosite: 0.86 + fibre * 0.1, relief: trame * 0.7 };
    });
  },
};

/**
 * Peint les trois cartes d'une matière en un seul parcours.
 *
 * Un parcours par carte coûterait trois fois plus cher pour un résultat
 * identique : le motif est le même, seule la lecture change.
 */
function dessiner(px, teinte, motif) {
  const f = champs(64, 20240607, 4);
  const base = new THREE.Color(teinte || '#ffffff');

  const toiles = {}, ctx = {}, img = {};
  for (const nom of ['couleur', 'rugosite', 'relief']) {
    toiles[nom] = document.createElement('canvas');
    toiles[nom].width = toiles[nom].height = px;
    ctx[nom] = toiles[nom].getContext('2d');
    img[nom] = ctx[nom].createImageData(px, px);
  }

  for (let y = 0; y < px; y++) {
    for (let x = 0; x < px; x++) {
      const r = motif(x / px, y / px, f);
      const i = (y * px + x) * 4;

      const c = Math.max(0, Math.min(1, r.clair));
      img.couleur.data[i] = Math.round(base.r * c * 255);
      img.couleur.data[i + 1] = Math.round(base.g * c * 255);
      img.couleur.data[i + 2] = Math.round(base.b * c * 255);
      img.couleur.data[i + 3] = 255;

      const rg = Math.round(Math.max(0, Math.min(1, r.rugosite)) * 255);
      img.rugosite.data[i] = img.rugosite.data[i + 1] = img.rugosite.data[i + 2] = rg;
      img.rugosite.data[i + 3] = 255;

      const re = Math.round(Math.max(0, Math.min(1, r.relief)) * 255);
      img.relief.data[i] = img.relief.data[i + 1] = img.relief.data[i + 2] = re;
      img.relief.data[i + 3] = 255;
    }
  }

  const sortie = {};
  for (const nom of ['couleur', 'rugosite', 'relief']) {
    ctx[nom].putImageData(img[nom], 0, 0);
    const t = new THREE.CanvasTexture(toiles[nom]);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    // seule la carte de couleur porte une correction gamma : les deux autres
    // sont des grandeurs physiques, les encoder en sRGB les fausserait
    if (nom === 'couleur') t.colorSpace = THREE.SRGBColorSpace;
    sortie[nom] = t;
  }
  return sortie;
}

/* ══════════════════ accès ══════════════════ */

const cache = new Map();

/**
 * Les trois cartes d'une matière, fabriquées une fois puis partagées.
 *
 * Le cache porte sur le nom ET la teinte : deux bois de couleurs
 * différentes sont deux textures, mais deux pièces du même bois n'en font
 * qu'une — c'est ce qui permet d'en poser cent sans y penser.
 */
export function texturesProcedurales(nom, teinte = '#ffffff', px = 512) {
  const fabrique = FABRIQUES[nom];
  if (!fabrique) return null;

  const clef = `${nom}|${teinte}|${px}`;
  if (!cache.has(clef)) cache.set(clef, fabrique(px, teinte));
  return cache.get(clef);
}

export const MATIERES_PROCEDURALES = Object.keys(FABRIQUES);
