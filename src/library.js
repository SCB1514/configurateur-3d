import * as THREE from '../vendor/three/three.module.js';

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
    // matériaux relevés dans Rhino, repris tels quels par le panneau Matériaux
    this.materials = (raw.materials || []).map(m => ({
      id: String(m.id || m.name || ''),
      name: m.name || m.id || 'Matériau',
      color: m.color || '#b9c2cd',
      metalness: m.metalness ?? 0.05,
      roughness: m.roughness ?? 0.72,
      opacity: m.opacity ?? 1,
    })).filter(m => m.id);
    this.blocks = new Map();
    this.order = [];

    for (const b of raw.blocks || []) {
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
  }

  get list() { return this.order.map(id => this.blocks.get(id)); }
  block(id) { return this.blocks.get(id); }

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

      parts.push({
        geometry: g,
        color: m.color || '#b9c2cd',
        opacity: m.opacity ?? 1,
        metalness: m.metalness ?? 0.05,
        roughness: m.roughness ?? 0.72,
        paintable: !!m.paintable,
        material: m.material || '',
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

    const size = bounds.getSize(new THREE.Vector3());
    return {
      id: String(raw.id),
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
      connectorTypes: [...new Set(connectors.map(c => c.type))].sort(),
      parts,
      bbox: bounds,
      size,
      // Z de pose : par défaut le bas de la boîte est ramené au sol
      baseOffset: -bounds.min.z,
      stackable: raw.stackable !== false,
    };
  }
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
