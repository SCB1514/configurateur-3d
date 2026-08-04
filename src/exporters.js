import * as THREE from '../vendor/three/three.module.js';
import { OBJExporter } from '../vendor/three/addons/exporters/OBJExporter.js';

/* ============================================================
   Exports : image, composition JSON (ré-importable dans Rhino),
   maillage OBJ, récapitulatif de devis.
   ============================================================ */

export function download(filename, content, mime = 'application/octet-stream') {
  const blob = content instanceof Blob ? content : new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadDataUrl(filename, dataUrl) {
  const a = document.createElement('a');
  a.href = dataUrl; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
}

/* --- composition : format lu par rhino/import_composition.py --- */
export function compositionJSON(app) {
  const lib = app.lib;
  const inv = app.inventory();
  return JSON.stringify({
    format: 'configurateur-3d/composition',
    version: 1,
    library: lib.name,
    librarySource: app.drive ? 'Google Drive (dossier ' + app.drive.folderId + ')' : app.libKey,
    units: lib.units,                    // les positions ci-dessous sont dans CETTE unité
    currency: lib.currency,
    createdAt: new Date().toISOString(),
    shareUrl: app.lastShareUrl || null,
    summary: {
      count: app.state.items.length,
      total: inv.total,
      bbox: app.boundsInUnits(),
    },
    bom: inv.lines.map(l => ({
      blockId: l.block.id, name: l.block.name, ref: l.block.ref,
      qty: l.qty, unitPrice: l.block.price, price: l.price,
    })),
    items: app.state.items.map(it => ({
      block: app.lib.block(it.blockId)?.name ?? it.blockId,
      blockId: it.blockId,
      position: it.pos.map(v => round(v / lib.scale, 3)),   // reconverti dans l'unité de la biblio
      rotationZ: it.rot || 0,
      scale: it.scale || 1,
      finish: it.finish || null,
    })),
  }, null, 2);
}

export function exportOBJ(viewer) {
  const g = new THREE.Group();
  for (const o of viewer.objects.values()) g.add(o.clone());
  const txt = new OBJExporter().parse(g);
  return txt;
}

export function quoteText(app, contact = {}) {
  const inv = app.inventory();
  const L = [];
  L.push('DEMANDE DE DEVIS — ' + app.lib.name);
  L.push('Date : ' + new Date().toLocaleString('fr-FR'));
  L.push('');
  if (contact.name || contact.company || contact.email || contact.phone) {
    L.push('CONTACT');
    if (contact.name) L.push('  Nom      : ' + contact.name);
    if (contact.company) L.push('  Société  : ' + contact.company);
    if (contact.email) L.push('  E-mail   : ' + contact.email);
    if (contact.phone) L.push('  Tél.     : ' + contact.phone);
    L.push('');
  }
  L.push('NOMENCLATURE');
  for (const l of inv.lines) {
    const ref = l.block.ref ? ` [${l.block.ref}]` : '';
    const px = app.lib.priceEnabled && l.block.price
      ? `  ${fmt(l.price)} ${app.lib.currency}` : '';
    L.push(`  ${String(l.qty).padStart(3, ' ')} ×  ${l.block.name}${ref}${px}`);
  }
  L.push('');
  L.push(`  Éléments : ${inv.count}`);
  const b = app.boundsInUnits();
  if (b) L.push(`  Encombrement : ${b.size.map(v => fmt(v)).join(' × ')} ${app.lib.units}`);
  if (app.lib.priceEnabled) L.push(`  TOTAL ESTIMÉ : ${fmt(inv.total)} ${app.lib.currency}`);
  if (contact.msg) { L.push(''); L.push('MESSAGE'); L.push('  ' + contact.msg); }
  if (app.lastShareUrl) { L.push(''); L.push('CONFIGURATION 3D'); L.push('  ' + app.lastShareUrl); }
  return L.join('\n');
}

const round = (v, n) => Math.round(v * 10 ** n) / 10 ** n;
export const fmt = v => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(v);
