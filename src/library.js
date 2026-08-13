import * as THREE from '../vendor/three/three.module.js';
import { BLOCS_LUMIERE, MATIERES_LUMIERE } from './catalogue-lumieres.js';

/* ============================================================
   Chargement de la bibliothèque de blocs (export Rhino)
   ------------------------------------------------------------
   Format attendu : voir rhino/export_blocks_to_library.py
   { name, units, currency, categories[], blocks[] }
   ============================================================ */

const UNIT_TO_M = {
  mm: 0.001, millimeters: 0.001, millimeter: 0.001,
  cm: 0.01, centimeters: 0.01, centimeter: 0.01,
  m: 1, meters: 1, meter: 1,
  in: 0.0254, inches: 0.0254, inch: 0.0254,
  ft: 0.3048, feet: 0.3048, foot: 0.3048,
};

/* Textures d'un matériau Rhino → canaux Three.js. Une clé par canal, pas
   d'ambiguïté : un relief en niveaux de gris est un « bump », une carte de
   normales est une « normal ». Rhino sait produire les deux. */
const MAP_SLOTS = {
  color:     { prop: 'map', srgb: true },
  emissive:  { prop: 'emissiveMap', srgb: true },
  normal:    { prop: 'normalMap' },
  bump:      { prop: 'bumpMap' },
  roughness: { prop: 'roughnessMap' },
  metalness: { prop: 'metalnessMap' },
  ao:        { prop: 'aoMap' },
  opacity:   { prop: 'alphaMap' },
};

export class Library {
  constructor(raw, url) {
    this.url = url;
    this.name = raw.name || 'Bibliothèque';
    this.units = (raw.units || 'm').toLowerCase();
    this.scale = UNIT_TO_M[this.units] ?? 1;
    this.currency = raw.currency || '€';
    // pas d'aimantation, exprimé dans l'unité de la bibliothèque -> mètres
    this.gridStep = Number(raw.gridStep) > 0 ? Number(raw.gridStep) * this.scale : 0.1;
    this.priceEnabled = raw.priceEnabled !== false;
    this.categories = raw.categories || [];
    // libellés des points d'insertion : [{id:'A', name:"Point d'insertion A"}]
    this.connectorTypes = raw.connectorTypes || [];
    /* --- textures : une image chargée une fois, partagée par les blocs --- */
    this.loader = new THREE.TextureLoader();
    this.textures = new Map();
    this._pendingTextures = 0;
    this._readyCbs = [];

    // matériaux relevés dans Rhino, repris tels quels par le panneau Matériaux
    this.materials = (raw.materials || []).map(m => ({
      id: String(m.id || m.name || ''),
      name: m.name || m.id || 'Matériau',
      color: m.color || '#b9c2cd',
      metalness: m.metalness ?? 0.05,
      roughness: m.roughness ?? 0.72,
      opacity: m.opacity ?? 1,
      // une matiere peut s'eclairer elle-meme : ecran, anneau de LED, logo
      emissive: m.emissive || '',
      emissiveIntensite: m.emissiveIntensite ?? m.emissiveIntensity ?? 1.6,
      maps: this._maps(m.maps || m.textures),
    })).filter(m => m.id);
    for (const m of MATIERES_LUMIERE) {
      if (!this.materials.some(x => x.id === m.id)) {
        this.materials.push({ ...m, emissive: '', emissiveIntensite: 1.6, maps: null });
      }
    }
    this.materialsById = new Map(this.materials.map(m => [m.id.toLowerCase(), m]));
    // aoMap lit un second jeu de coordonnées : on ne le prépare que s'il sert
    this._needsUV1 = this.materials.some(m => m.maps?.aoMap);

    this.blocks = new Map();
    this.order = [];

    /* Les luminaires sont fournis avec l'application, pas avec la
       bibliotheque. Une implantation de salle a besoin d'eclairage quelle que
       soit la bibliotheque de machines chargee, et personne n'a envie de
       modeliser un spot dans Rhino pour le poser au plafond. Une
       bibliotheque qui definirait un bloc de meme identifiant garde la main :
       le catalogue integre ne s'impose jamais. */
    const fournis = (raw.blocks || []).map(b => String(b.id));
    const blocs = [...(raw.blocks || []),
                   ...BLOCS_LUMIERE.filter(b => !fournis.includes(b.id))];

    for (const b of blocs) {
      const block = this._prepare(b);
      if (block) { this.blocks.set(block.id, block); this.order.push(block.id); }
    }

    // dispositions types préparées dans Rhino : positions ramenées en mètres
    this.presets = (raw.presets || []).map(p => ({
      id: String(p.id || ''),
      name: p.name || 'Disposition',
      description: p.description || '',
      featured: !!p.featured,
      items: (p.items || []).map(i => {
        const pos = i.pos || [0, 0, 0];
        return {
          blockId: String(i.blockId || ''),
          pos: [pos[0] * this.scale, pos[1] * this.scale, pos[2] * this.scale],
          rot: Number(i.rot) || 0,
          finish: i.finish || null,
        };
      }).filter(i => i.blockId),
    })).filter(p => p.items.length);

    // catégories déduites si absentes du fichier
    if (!this.categories.length) {
      const seen = new Map();
      for (const id of this.order) {
        const c = this.blocks.get(id).category;
        if (c && !seen.has(c)) seen.set(c, { id: c, name: c });
      }
      this.categories = [...seen.values()];
    }

    // La categorie des luminaires integres doit exister meme quand la
    // bibliotheque declare explicitement ses propres categories : sinon les
    // appareils sont poses dans le catalogue mais aucun onglet ne les montre.
    const cats = this.categories.map(c => c.id || c);
    for (const b of BLOCS_LUMIERE) {
      if (this.blocks.has(b.id) && b.category && !cats.includes(b.category)) {
        this.categories.push({ id: b.category, name: b.category });
        cats.push(b.category);
      }
    }
  }

  get list() { return this.order.map(id => this.blocks.get(id)); }
  block(id) { return this.blocks.get(id); }

  /* ══════════ textures ══════════
     Une image de texture voyage soit en `data:` dans le fichier lui-même
     (publication autonome), soit en chemin relatif au library.json. Aucune
     source extérieure au site n'est acceptée : la politique CSP la refuserait
     de toute façon, autant le dire ici plutôt que de laisser une image vide.
     ============================== */
  _resolve(src) {
    const s = String(src || '').trim();
    if (!s) return null;
    if (/^data:image\//i.test(s)) return s;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      console.warn('Texture externe refusée :', s);
      return null;
    }
    const base = String(this.url || '').replace(/[?#].*$/, '').replace(/[^/]*$/, '');
    return base + s.replace(/^\.?\//, '');
  }

  /** Une texture prête à l'emploi, image partagée entre matériaux. */
  _texture(spec, srgb) {
    const url = this._resolve(typeof spec === 'string' ? spec : spec?.src);
    if (!url) return null;

    const cle = (srgb ? 's:' : 'l:') + url;
    let base = this.textures.get(cle);
    if (!base) {
      this._pendingTextures++;
      base = this.loader.load(url, () => this._textureDone(), undefined, () => {
        console.warn('Texture illisible :', url.slice(0, 80));
        this._textureDone();
      });
      base.wrapS = base.wrapT = THREE.RepeatWrapping;
      if (srgb) base.colorSpace = THREE.SRGBColorSpace;
      base.anisotropy = 8;
      this.textures.set(cle, base);
    }

    // Le cadrage appartient au matériau, pas à l'image : on clone, ce qui
    // partage la source décodée sans imposer son échelle aux autres.
    const t = base.clone();
    const rep = spec?.repeat, off = spec?.offset;
    if (Array.isArray(rep) && rep.length === 2) t.repeat.set(rep[0] || 1, rep[1] || 1);
    if (Array.isArray(off) && off.length === 2) t.offset.set(off[0] || 0, off[1] || 0);
    if (Number(spec?.rotation)) t.rotation = Number(spec.rotation) * Math.PI / 180;
    t.center.set(0.5, 0.5);
    t.needsUpdate = true;
    return t;
  }

  /** Y a-t-il seulement des textures dans cette bibliothèque ? */
  get hasTextures() { return this.textures.size > 0; }

  _textureDone() {
    if (--this._pendingTextures > 0) return;
    const cbs = this._readyCbs;
    this._readyCbs = [];
    for (const cb of cbs) { try { cb(); } catch (e) { console.warn(e); } }
  }

  /**
   * Prévient quand toutes les images sont décodées. Les vignettes sont des
   * captures : rendues trop tôt, elles figeraient des blocs sans texture.
   */
  whenTexturesReady(cb) {
    if (this._pendingTextures <= 0) cb();
    else this._readyCbs.push(cb);
  }

  /** Les textures d'un matériau, canal par canal. */
  _maps(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const out = {};
    for (const [cle, slot] of Object.entries(MAP_SLOTS)) {
      const spec = raw[cle];
      if (!spec) continue;
      const t = this._texture(spec, !!slot.srgb);
      if (t) out[slot.prop] = t;
    }
    if (!Object.keys(out).length) return null;

    // profondeur du relief : réglable à la source, sinon les valeurs de Rhino
    out.bumpScale = Number(raw.bump?.scale ?? raw.bumpScale ?? 0.02);
    out.normalScale = Number(raw.normal?.scale ?? raw.normalScale ?? 1);
    // échelle réelle d'une tuile, en unités de la bibliothèque, quand le
    // maillage n'a pas de coordonnées de texture et qu'il faut les projeter
    out.worldSize = Number(raw.worldSize) > 0 ? Number(raw.worldSize) : 0;
    return out;
  }

  /* --- construction des BufferGeometry, une seule fois par bloc --- */
  _prepare(raw) {
    if (!raw || !raw.id) return null;
    const s = this.scale;
    const parts = [];
    const bounds = new THREE.Box3();

    for (const m of raw.meshes || []) {
      if (!m.positions || m.positions.length < 9) continue;
      const pos = new Float32Array(m.positions.length);
      for (let i = 0; i < m.positions.length; i++) pos[i] = m.positions[i] * s;

      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      if (m.indices && m.indices.length) {
        const Arr = pos.length / 3 > 65535 ? Uint32Array : Uint16Array;
        g.setIndex(new THREE.BufferAttribute(Arr.from(m.indices), 1));
      }
      if (m.normals && m.normals.length === m.positions.length) {
        g.setAttribute('normal', new THREE.BufferAttribute(Float32Array.from(m.normals), 3));
      } else {
        g.computeVertexNormals();
      }
      g.computeBoundingBox();
      bounds.union(g.boundingBox);

      /* --- textures : coordonnées relevées dans Rhino, sinon projetées --- */
      const mat = this.materialsById.get(String(m.material || '').toLowerCase()) || null;
      const maps = mat?.maps || null;
      const nv = pos.length / 3;
      if (m.uv && m.uv.length === nv * 2) {
        g.setAttribute('uv', new THREE.BufferAttribute(Float32Array.from(m.uv), 2));
      } else if (maps) {
        projectUV(g, maps.worldSize > 0 ? maps.worldSize * s : 1);
      }
      if (maps && this._needsUV1 && g.getAttribute('uv')) {
        g.setAttribute('uv1', g.getAttribute('uv'));
      }

      parts.push({
        geometry: g,
        color: m.color || '#b9c2cd',
        opacity: m.opacity ?? 1,
        metalness: m.metalness ?? 0.05,
        roughness: m.roughness ?? 0.72,
        paintable: !!m.paintable,
        ferme: maillageFerme(g),
        material: m.material || '',
        emissive: m.emissive || '',
        emissiveIntensite: m.emissiveIntensite ?? m.emissiveIntensity ?? 1.6,
        maps,
        name: m.name || '',
      });
    }
    if (!parts.length) return null;

    /* --- points d'accroche ---------------------------------------------
       Le point PRINCIPAL est l'origine du bloc ; sa catégorie vient du
       texte utilisateur « Point d'Insertion » de la définition Rhino.
       Les points natifs placés ailleurs dans le bloc sont UNIVERSELS :
       ils acceptent n'importe quelle catégorie.
       ------------------------------------------------------------------ */
    const connectors = (raw.connectors || []).map((c, i) => {
      const p = c.pos || [0, 0, 0];
      return {
        index: i,
        type: String(c.type || 'A').toUpperCase(),
        main: !!c.main,
        name: c.name || (c.type === '*' ? 'Connecteur universel' : `Point d'insertion ${c.type || 'A'}`),
        pos: new THREE.Vector3(p[0], p[1], p[2]).multiplyScalar(s),
      };
    });

    /* --- sous-blocs : un bloc peut en contenir d'autres, comme dans Rhino.
       Ils ne sont pas fondus dans le maillage du parent : ils gardent leur
       identite, leur materiau et leurs propres sous-blocs. --------------- */
    const children = (raw.children || []).map(c => {
      const p = c.pos || [0, 0, 0];
      return {
        blockId: String(c.blockId || ''),
        name: c.name || '',
        pos: new THREE.Vector3(p[0], p[1], p[2]).multiplyScalar(s),
        rot: Number(c.rot) || 0,
        scale: Number(c.scale) > 0 ? Number(c.scale) : 1,
      };
    }).filter(c => c.blockId);

    /* --- luminaires : bandeaux de LED, dalles, downlights, projecteurs.
       Les cotes restent en unites de bibliotheque ; c'est le constructeur
       du luminaire qui convertit, car lui seul sait ce qu'il fabrique. --- */
    const lumieres = (raw.lumieres || []).map(l => ({
      type: ['bande', 'rectangle', 'disque', 'spot'].includes(l.type) ? l.type : 'rectangle',
      pos: l.pos || [0, 0, 0],
      rot: l.rot || [0, 0, 0],
      taille: l.taille,
      longueur: l.longueur,
      largeur: l.largeur,
      rayon: l.rayon,
      couleur: l.couleur || '#ffffff',
      intensite: Number(l.intensite) || 4,
      eclat: l.eclat === undefined ? undefined : Number(l.eclat),
      portee: Number(l.portee) || 0,
      angle: l.angle === undefined ? undefined : Number(l.angle),
      penombre: l.penombre === undefined ? undefined : Number(l.penombre),
      ies: typeof l.ies === 'string' ? l.ies : null,
      nom: l.nom || '',
      actif: l.actif !== false,
    }));

    const size = bounds.getSize(new THREE.Vector3());
    return {
      id: String(raw.id),
      lumieres,
      name: raw.name || raw.id,
      category: raw.category || '',
      tags: raw.tags || [],
      price: Number(raw.price) || 0,
      unitLabel: raw.unitLabel || '',
      ref: raw.ref || '',
      description: raw.description || '',
      finishes: raw.finishes || [],
      meta: raw.meta || {},
      connectors,
      children,
      connectorTypes: [...new Set(connectors.map(c => c.type))].sort(),
      parts,
      bbox: bounds,
      size,
      /* Z de pose. Par defaut le bas de la boite est ramene au sol — c'est
         ce qu'on veut d'une machine. Un appareil de plafond, lui, est
         modelise a sa hauteur d'installation : le ramener au sol le rendrait
         absurde. Une valeur explicite dans la bibliotheque prime donc, et
         `baseOffset: 0` signifie « garde le Z tel qu'il a ete modelise ». */
      baseOffset: Number.isFinite(raw.baseOffset) ? raw.baseOffset * s : -bounds.min.z,
      stackable: raw.stackable !== false,
    };
  }
}

/**
 * Coordonnées de texture projetées en boîte, pour un maillage qui n'en porte
 * pas. Chaque sommet prend le plan dont sa normale est la plus proche, à
 * l'échelle réelle : une tuile fait `taille` mètres. C'est le repli — un
 * placage réglé dans Rhino restera toujours plus juste.
 */
function projectUV(geometry, taille) {
  const pos = geometry.getAttribute('position');
  const nor = geometry.getAttribute('normal');
  if (!pos || !nor) return;
  const k = 1 / Math.max(taille, 1e-6);
  const uv = new Float32Array(pos.count * 2);

  for (let i = 0; i < pos.count; i++) {
    const nx = Math.abs(nor.getX(i)), ny = Math.abs(nor.getY(i)), nz = Math.abs(nor.getZ(i));
    let u, v;
    if (nz >= nx && nz >= ny) { u = pos.getX(i); v = pos.getY(i); }        // dessus/dessous
    else if (nx >= ny) { u = pos.getY(i); v = pos.getZ(i); }               // flancs
    else { u = pos.getX(i); v = pos.getZ(i); }                             // face/arrière
    uv[i * 2] = u * k;
    uv[i * 2 + 1] = v * k;
  }
  geometry.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
}

/**
 * Le matériau Three.js d'une partie de bloc — une seule définition du rendu
 * PBR, partagée par la scène et par les vignettes. Deux implémentations
 * divergeraient au premier réglage.
 */
/**
 * Le maillage est-il ferme ?
 *
 * On dessine tout en double face pour tolerer les surfaces ouvertes venues de
 * Rhino — un capot modelise comme une simple nappe disparaitrait vu de dos.
 * Mais la double face desactive l'elimination des faces arriere : sur un
 * solide ferme, la carte graphique calcule alors l'interieur de la piece, que
 * personne ne verra jamais. C'est la moitie du travail de rasterisation jetee.
 *
 * Un maillage ferme se reconnait a ceci : chaque arete y est partagee par
 * exactement deux triangles. Le test est lineaire, fait une fois au
 * chargement, et son resultat vaut pour toutes les copies du bloc.
 */
export function maillageFerme(geometrie) {
  const idx = geometrie.getIndex();
  const pos = geometrie.getAttribute('position');
  if (!idx || !pos) return false;
  const a = idx.array, n = a.length;
  if (n < 12 || n % 3) return false;
  // au-dela d'un certain volume le test coute plus qu'il ne rapporte
  if (n > 300000) return false;

  /* Comparer les indices ne suffit pas — et c'est le piege.

     Un cube exporte depuis Rhino, ou fabrique par un script, porte le plus
     souvent vingt-quatre sommets et non huit : chaque face a les siens, pour
     que sa normale soit franche. Deux faces adjacentes ne partagent alors
     aucun indice, et un test par indices declare le solide ouvert alors
     qu'il est parfaitement ferme.

     On compare donc les POSITIONS, arrondies au dixieme de millimetre pour
     absorber les ecarts de calcul. */
  const p = pos.array;
  const clefSommet = (i) => (Math.round(p[i * 3] * 1e4) + ',' +
                             Math.round(p[i * 3 + 1] * 1e4) + ',' +
                             Math.round(p[i * 3 + 2] * 1e4));
  const cache = new Array(pos.count);
  const sommet = (i) => (cache[i] !== undefined ? cache[i] : (cache[i] = clefSommet(i)));

  const aretes = new Map();
  for (let i = 0; i < n; i += 3) {
    for (let k = 0; k < 3; k++) {
      const u = sommet(a[i + k]), v = sommet(a[i + (k + 1) % 3]);
      const clef = u < v ? u + '|' + v : v + '|' + u;
      aretes.set(clef, (aretes.get(clef) || 0) + 1);
    }
  }
  for (const compte of aretes.values()) if (compte !== 2) return false;
  return true;
}

export function buildStandardMaterial(part, couleur) {
  const maps = part.maps || {};
  const options = {
    color: new THREE.Color(couleur || part.color),
    metalness: part.metalness,
    roughness: part.roughness,
    transparent: part.opacity < 1 || !!maps.alphaMap,
    opacity: part.opacity,
    // face avant seule quand la piece est un solide ferme : moitie moins de
    // fragments a calculer, et rigoureusement la meme image
    side: part.ferme ? THREE.FrontSide : THREE.DoubleSide,
    // L'environnement fait tout le rendu des reflets : sans lui, un métal
    // rugueux paraît mat et un chrome paraît gris.
    envMapIntensity: 1.15,
  };
  for (const slot of Object.values(MAP_SLOTS)) {
    if (maps[slot.prop]) options[slot.prop] = maps[slot.prop];
  }

  // Une pièce peinte et lisse est laquée : elle porte une couche de vernis
  // qui réfléchit indépendamment de la couleur. C'est ce reflet blanc glissant
  // sur le capot qui distingue une machine neuve d'un aplat de plastique.
  // Le matériau physique coûte plus cher à compiler : on ne le prend que là
  // où il change quelque chose.
  const laque = part.metalness < 0.5 && part.roughness < 0.55;
  if (laque) {
    Object.assign(options, {
      clearcoat: part.paintable ? 0.85 : 0.55,
      clearcoatRoughness: 0.08 + part.roughness * 0.18,
      // le vernis ne masque pas le grain de la peinture en dessous
      clearcoatNormalMap: maps.normalMap || null,
    });
  }

  // Une piece emissive s'eclaire elle-meme : ecran de console, anneau de
  // LED, logo retro-eclaire. L'intensite depasse volontiers 1 — c'est ce
  // depassement que le halo ramasse.
  if (part.emissive && part.emissive !== '#000000') {
    options.emissive = new THREE.Color(part.emissive);
    options.emissiveIntensity = part.emissiveIntensite ?? 1.6;
    if (maps.emissiveMap) options.emissiveMap = maps.emissiveMap;
  }

  const m = laque ? new THREE.MeshPhysicalMaterial(options)
                  : new THREE.MeshStandardMaterial(options);
  // Vector2 et scalaire : à poser après coup, le constructeur ne les convertit pas.
  if (maps.normalMap) m.normalScale.set(maps.normalScale, maps.normalScale);
  if (maps.bumpMap) m.bumpScale = maps.bumpScale;
  return m;
}

/** Signature d'un matériau, pour n'en construire qu'un par combinaison. */
export function materialKey(part, couleur) {
  return [couleur || part.color, part.opacity, part.metalness, part.roughness,
    part.material || '', part.emissive || '', part.emissiveIntensite ?? '',
    part.ferme ? 'F' : 'D'].join('|');
}

/** Construit une bibliothèque à partir d'un JSON déjà téléchargé. */
export function buildLibrary(raw, source) {
  if (!raw || !raw.blocks || !raw.blocks.length) {
    throw new Error('Ce fichier ne contient aucun bloc exploitable.');
  }
  return new Library(raw, source);
}

/** Charge une bibliothèque depuis une URL relative au site (mode statique). */
export async function loadLibrary(url) {
  if (/^[a-z]+:/i.test(url) && !url.startsWith(location.origin)) {
    // le mode statique ne sort pas du site : une source externe passe par un
    // fournisseur explicite (voir drive.js), jamais par une URL libre.
    throw new Error('Source externe refusée en mode statique : ' + url);
  }
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`Bibliothèque introuvable (${res.status}) : ${url}`);
  return buildLibrary(await res.json(), url);
}
