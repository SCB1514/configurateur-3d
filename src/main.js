import { loadLibrary, buildLibrary } from './library.js';
import { DriveFolder, parseFolderId } from './drive.js';
import { Viewer } from './viewer.js';
import { ThumbnailFactory } from './thumbnails.js';
import { encodeState, decodeState, readHash, buildUrl } from './share.js';
import { download, downloadDataUrl, compositionJSON, exportOBJ, quoteText, fmt } from './exporters.js';

/* ============================================================
   Configurateur 3D — application
   ============================================================ */

const $ = s => document.querySelector(s);
const $$ = s => [...document.querySelectorAll(s)];
const params = new URLSearchParams(location.search);

const app = {
  lib: null,
  libKey: null,          // identifiant de la bibliothèque active (chemin ou id Drive)
  catalogue: [],         // bibliothèques disponibles dans la source
  drive: null,           // DriveFolder si la source est un dossier Drive
  viewer: null,
  thumbs: null,
  state: { items: [] },
  history: [],
  future: [],
  selected: null,
  filter: { text: '', category: null },
  compat: null,          // {uid, blockName, types:[…]} — panneau « compatibles »
  showDims: false,       // cotes de la sélection
  viewonly: params.get('view') === '1',
  embed: params.get('embed') === '1',
  config: {},
  lastShareUrl: null,
};
window.configurateur = app;   // accès console / intégration

/* ══════════════════ démarrage ══════════════════ */
boot();

async function boot() {
  try {
    app.config = await fetch('config.json', { cache: 'no-cache' })
      .then(r => (r.ok ? r.json() : {})).catch(() => ({}));
  } catch { app.config = {}; }

  if (app.embed) document.body.classList.add('embed');
  if (app.viewonly) document.body.classList.add('viewonly');

  app.viewer = new Viewer($('#canvas'), {
    onPlace: item => placeItem(item),
    onSelect: uid => onSelect(uid),
    onTransform: (uid, patch) => {
      const it = find(uid);
      if (it) { Object.assign(it, patch); refreshSelectionPanel(); refreshDimensions(); scheduleSave(); }
    },
    onCommit: () => pushHistory(),
  });
  app.viewer.setEditable(!app.viewonly);
  app.thumbs = new ThumbnailFactory(256);
  wireUI();

  // la configuration partagée peut désigner la bibliothèque à ouvrir
  const code = readHash();
  const restoredFromLink = code ? await decodeState(code) : null;

  try {
    await resolveSource(restoredFromLink?.libUrl || null);
  } catch (e) {
    return fatal(e);
  }

  const restored = restoredFromLink || loadLocal();
  if (restored?.items?.length) {
    app.state.items = restored.items.filter(it => app.lib.block(it.blockId));
    app.viewer.syncAll(app.state.items);
    app.viewer.fit();
  }
  pushHistory(true);
  refreshAll();
  $('#loader').classList.add('hidden');
}

function fatal(e) {
  const drive = (app.config.source || {}).type === 'drive';
  $('#loader').innerHTML = `<div style="max-width:420px;text-align:center;line-height:1.7">
    <b style="color:#ff5f56">Bibliothèque non chargée</b><br>${escapeHtml(e.message)}<br>
    <small>${drive
      ? 'Vérifiez <code>config.json</code> : identifiant du dossier, clé API, '
        + 'et partage du dossier en « Tous les utilisateurs disposant du lien » (lecteur). '
        + 'Le script <code>tools/check_drive_folder.py</code> diagnostique la configuration.'
      : 'Exportez vos blocs Rhino avec <code>rhino/export_blocks_to_library.py</code>, '
        + 'puis placez le fichier dans <code>data/library.json</code>.'}</small></div>`;
  console.error(e);
}

/* ══════════════════ source des bibliothèques ══════════════════
   Deux modes seulement :
     • statique : un fichier servi par le site lui-même
     • drive    : UN dossier Google Drive, jamais davantage
   ============================================================== */
async function resolveSource(preferredKey) {
  const src = app.config.source || {};

  if (src.type === 'drive') {
    const folderId = parseFolderId(src.folderId);
    if (!folderId) throw new Error('config.json : « source.folderId » absent ou invalide.');
    app.drive = new DriveFolder(folderId, src.apiKey);
    $('#loader').querySelector('span').textContent = 'Lecture du dossier de bibliothèque…';
    await app.drive.list();
    const libs = app.drive.libraries();
    if (!libs.length) {
      throw new Error('Aucun fichier .json dans ce dossier Drive. '
        + 'Déposez-y le library.json produit par le script d\'export Rhino.');
    }
    app.catalogue = libs.map(f => ({ key: f.id, name: prettyName(f.name), file: f.name }));
  } else {
    const path = src.library || app.config.library || 'data/library.json';
    app.catalogue = [{ key: path, name: prettyName(path.split('/').pop()), file: path }];
  }

  // choix : lien partagé > paramètre ?lib= > config > première entrée
  const asked = preferredKey || params.get('lib') || src.libraryFile || null;
  const found = asked && app.catalogue.find(c => c.key === asked || c.file === asked);
  await activateLibrary((found || app.catalogue[0]).key);
}

async function activateLibrary(key) {
  const entry = app.catalogue.find(c => c.key === key);
  if (!entry) throw new Error('Bibliothèque inconnue dans cette source : ' + key);

  const lib = app.drive
    ? buildLibrary(await app.drive.getJSON(entry.key), 'drive:' + entry.key)
    : await loadLibrary(entry.key);

  app.lib = lib;
  app.libKey = entry.key;
  app.viewer.setLibrary(lib);

  document.title = app.config.title || lib.name;
  $('#lib-name').textContent = app.config.brand || lib.name;
  $('#lib-sub').textContent = `${lib.list.length} blocs · unité ${lib.units}`
    + (app.drive ? ' · dossier Drive' : '');
  $('#price-row').classList.toggle('hidden', !lib.priceEnabled);
  if (app.config.priceNote) $('#price-note').textContent = app.config.priceNote;

  // bibliothèque sans point d'insertion : magnétisme et astuce sans objet
  const hasConnectors = lib.list.some(b => b.connectorTypes.length);
  $('#btn-magnet').classList.toggle('hidden', !hasConnectors);

  renderLibrarySwitch();
  renderPresets();
  app.compat = null;
  $('#compat-bar').classList.add('hidden');
  app.filter = { text: '', category: null };
  $('#search').value = '';
  renderCategories();
  renderCatalog();
  renderMaterials();
}

function renderLibrarySwitch() {
  const row = $('#lib-switch-row'), sel = $('#lib-switch');
  if (app.catalogue.length < 2) { row.hidden = true; return; }
  row.hidden = false;
  sel.innerHTML = '';
  for (const c of app.catalogue) {
    const o = document.createElement('option');
    o.value = c.key; o.textContent = c.name;
    o.selected = c.key === app.libKey;
    sel.appendChild(o);
  }
}

const prettyName = f => f.replace(/\.json$/i, '').replace(/[-_]+/g, ' ').trim();

/* ══════════════════ dispositions types ══════════════════
   Préparées dans Rhino, elles donnent au client un point de départ crédible
   plutôt qu'une salle vide. Il les modifie ensuite librement.
   ======================================================== */
function renderPresets() {
  const row = $('#preset-row'), select = $('#preset-select');
  const list = app.lib.presets || [];
  if (!list.length) { row.hidden = true; return; }

  row.hidden = false;
  select.innerHTML = '';
  const blank = document.createElement('option');
  blank.value = '';
  blank.textContent = 'Salle vide';
  select.appendChild(blank);

  for (const preset of [...list].sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0))) {
    const option = document.createElement('option');
    option.value = preset.id;
    option.textContent = (preset.featured ? '★ ' : '') + preset.name
      + ` — ${preset.items.length} machines`;
    select.appendChild(option);
  }
  describePreset();
}

function describePreset() {
  const preset = (app.lib.presets || []).find(p => p.id === $('#preset-select').value);
  $('#preset-note').textContent = preset?.description || '';
}

function loadPreset(id) {
  const preset = (app.lib.presets || []).find(p => p.id === id);
  if (!preset) return;

  if (app.state.items.length &&
      !confirm(`Remplacer la configuration en cours par « ${preset.name} » ?`)) return;

  app.state.items = preset.items
    .filter(i => app.lib.block(i.blockId))
    .map(i => ({
      uid: newUid(),
      blockId: i.blockId,
      pos: [...i.pos],
      rot: i.rot,
      scale: 1,
      finish: i.finish || app.lib.block(i.blockId).finishes[0]?.id || null,
    }));

  clearCompatible();
  app.viewer.syncAll(app.state.items);
  app.viewer.select(null);
  app.viewer.fit();
  pushHistory();
  refreshAll();
  toast(`« ${preset.name} » chargée — ${app.state.items.length} machines`);
}

/* ══════════════════ catalogue ══════════════════ */
function renderCategories() {
  const box = $('#categories');
  const cats = app.lib.categories;
  box.innerHTML = '';
  const mk = (id, label) => {
    const b = document.createElement('button');
    b.className = 'chip' + (app.filter.category === id ? ' on' : '');
    b.textContent = label;
    b.onclick = () => { app.filter.category = id; renderCategories(); renderCatalog(); };
    box.appendChild(b);
  };
  mk(null, 'Tout');
  for (const c of cats) mk(c.id, c.name || c.id);
}

function renderCatalog() {
  const grid = $('#block-grid');
  grid.innerHTML = '';
  const q = app.filter.text.trim().toLowerCase();
  const compat = app.compat;
  const list = app.lib.list.filter(b => {
    // mode « compatibles » : uniquement les blocs partageant un point d'insertion
    if (compat && !b.connectorTypes.some(t => compat.types.includes(t))) return false;
    if (app.filter.category && b.category !== app.filter.category) return false;
    if (!q) return true;
    return (b.name + ' ' + b.ref + ' ' + b.category + ' ' + b.tags.join(' ') + ' ' + b.description)
      .toLowerCase().includes(q);
  });

  for (const b of list) {
    const card = document.createElement('button');
    card.className = 'card';
    card.dataset.id = b.id;
    card.title = [b.name, b.description, dims(b)].filter(Boolean).join('\n');
    const img = document.createElement('img');
    img.className = 'thumb';
    img.alt = '';                     // pas d'icone cassee si le rendu echoue
    card.appendChild(img);
    const nm = document.createElement('div');
    nm.className = 'nm'; nm.textContent = b.name;
    card.appendChild(nm);
    const px = document.createElement('div');
    px.className = 'px';
    px.textContent = app.lib.priceEnabled && b.price
      ? `${fmt(b.price)} ${app.lib.currency}` : dims(b);
    card.appendChild(px);

    if (b.connectorTypes.length) {
      const pts = document.createElement('div');
      pts.className = 'pts';
      for (const t of b.connectorTypes) {
        const s = document.createElement('span');
        s.className = 'pt-badge';
        s.textContent = t;
        s.title = `Point d'insertion ${t}`;
        pts.appendChild(s);
      }
      card.appendChild(pts);
    }

    card.onclick = () => (compat ? attachCompatible(b.id) : startPlacing(b.id));
    grid.appendChild(card);
    queueThumb(b, img);
  }
  $('#catalog-count').textContent = `${list.length} bloc${list.length > 1 ? 's' : ''} affiché${list.length > 1 ? 's' : ''}`;
  if (!list.length) {
    grid.innerHTML = `<div style="grid-column:1/-1;color:#95a0ae;font-size:12px;padding:8px">${
      compat ? 'Aucun bloc ne partage ce point d\'insertion.' : 'Aucun bloc ne correspond.'}</div>`;
  }
}

/* ══════════════════ blocs compatibles (clic droit) ══════════════════ */
function showCompatible(uid) {
  const it = find(uid);
  if (!it) return clearCompatible();
  const block = app.lib.block(it.blockId);
  const free = app.viewer.freeConnectors(uid);
  const types = [...new Set(free.map(c => c.type))].sort();

  if (!block.connectorTypes.length) {
    toast('Ce bloc n\'a pas de point d\'insertion');
    return clearCompatible();
  }
  if (!types.length) {
    toast('Tous les points d\'insertion de ce bloc sont déjà occupés');
    return clearCompatible();
  }

  app.compat = { uid, blockName: block.name, types };
  app.filter = { text: '', category: null };
  $('#search').value = '';
  $('#compat-bar').classList.remove('hidden');
  $('#compat-name').textContent = block.name;
  $('#compat-types').textContent = types.length > 1
    ? `points libres ${types.join(', ')} — cliquez un bloc, il se connecte`
    : `point libre ${types[0]} — cliquez un bloc, il se connecte`;
  renderCategories();
  renderCatalog();
  if (window.innerWidth <= 880) $('#catalog').classList.add('open');
}

function clearCompatible() {
  if (!app.compat) return;
  app.compat = null;
  $('#compat-bar').classList.add('hidden');
  renderCategories();
  renderCatalog();
}

function attachCompatible(blockId) {
  const target = app.compat?.uid;
  const block = app.lib.block(blockId);
  if (!target || !block) return;

  const fit = app.viewer.autoAttach(block, target);
  if (!fit) {
    toast('Aucune position libre pour ce bloc — posez-le à la souris', true);
    startPlacing(blockId);
    return;
  }
  const item = {
    uid: newUid(), blockId, scale: 1,
    pos: fit.pos, rot: fit.rot, finish: block.finishes[0]?.id || null,
  };
  app.state.items.push(item);
  app.viewer.addItem(item);
  app.viewer.select(item.uid);
  pushHistory();
  refreshAll();
  toast(`Connecté sur le point ${fit.type}`);
  showCompatible(item.uid);          // on enchaîne depuis le nouveau bloc
}

const thumbQueue = [];
let thumbRunning = false;
function queueThumb(block, img) {
  thumbQueue.push([block, img]);
  if (thumbRunning) return;
  thumbRunning = true;
  const step = () => {
    const t0 = performance.now();
    while (thumbQueue.length && performance.now() - t0 < 10) {
      const [b, el] = thumbQueue.shift();
      try {
        const url = app.thumbs.render(b);
        if (url) el.src = url;
      } catch (err) { console.warn('vignette', b.id, err); }
    }
    if (thumbQueue.length) setTimeout(step, 0);
    else thumbRunning = false;
  };
  // setTimeout plutot que requestAnimationFrame : les vignettes se generent
  // meme quand l'onglet ne peint pas (arriere-plan, iframe masquee).
  setTimeout(step, 0);
}

function dims(b) {
  const s = b.size, u = app.lib.units, k = app.lib.scale;
  return `${r(s.x / k)} × ${r(s.y / k)} × ${r(s.z / k)} ${u}`;
}

/* ══════════════════ état / items ══════════════════ */
let uidSeq = 0;
const newUid = () => 'i' + (Date.now().toString(36)) + (uidSeq++).toString(36);

function startPlacing(blockId) {
  if (app.viewonly) return;
  const b = app.lib.block(blockId);
  app.viewer.startPlacing(blockId, b.finishes[0]?.id);
  $('#placing-hint').classList.remove('hidden');
  $$('.card').forEach(c => c.classList.toggle('on', c.dataset.id === blockId));
  if (window.innerWidth <= 880) $('#catalog').classList.remove('open');
}

function stopPlacing() {
  app.viewer.cancelPlacing();
  $('#placing-hint').classList.add('hidden');
  $$('.card').forEach(c => c.classList.remove('on'));
}

function placeItem(partial) {
  const { connected, ...rest } = partial;
  const item = { uid: newUid(), scale: 1, ...rest };
  if (connected) toast('Connecté au point d\'insertion');
  app.state.items.push(item);
  app.viewer.addItem(item);
  app.viewer.select(item.uid);
  pushHistory();
  refreshAll();
  if (!app.viewer.ghost) stopPlacing();   // pose unique : on quitte le mode
}

const find = uid => app.state.items.find(i => i.uid === uid);

function deleteSelected() {
  if (!app.selected) return;
  if (app.compat?.uid === app.selected) clearCompatible();
  app.state.items = app.state.items.filter(i => i.uid !== app.selected);
  app.viewer.removeItem(app.selected);
  app.viewer.select(null);
  pushHistory();
  refreshAll();
}

function duplicateSelected() {
  const it = find(app.selected);
  if (!it) return;
  const step = app.viewer.gridStep * 2;
  const copy = { ...it, uid: newUid(), pos: [it.pos[0] + step, it.pos[1] + step, it.pos[2]] };
  app.state.items.push(copy);
  app.viewer.addItem(copy);
  app.viewer.select(copy.uid);
  pushHistory();
  refreshAll();
}

function clearAll() {
  if (!app.state.items.length) return;
  if (!confirm('Supprimer tous les éléments de la configuration ?')) return;
  app.state.items = [];
  app.viewer.clear();
  pushHistory();
  refreshAll();
}

/* ══════════════════ historique ══════════════════ */
function pushHistory(initial = false) {
  const snap = JSON.stringify(app.state.items);
  if (app.history.length && app.history[app.history.length - 1] === snap) return;
  app.history.push(snap);
  if (app.history.length > 80) app.history.shift();
  app.future.length = 0;
  if (!initial) scheduleSave();
  updateHistoryButtons();
}

function undo() {
  if (app.history.length < 2) return;
  app.future.push(app.history.pop());
  applySnapshot(app.history[app.history.length - 1]);
}

function redo() {
  if (!app.future.length) return;
  const snap = app.future.pop();
  app.history.push(snap);
  applySnapshot(snap);
}

function applySnapshot(snap) {
  app.state.items = JSON.parse(snap);
  app.viewer.syncAll(app.state.items);
  if (app.selected && !find(app.selected)) app.viewer.select(null);
  updateHistoryButtons();
  refreshAll();
  scheduleSave();
}

function updateHistoryButtons() {
  $('#btn-undo').disabled = app.history.length < 2;
  $('#btn-redo').disabled = !app.future.length;
}

/* ══════════════════ nomenclature ══════════════════ */
app.inventory = function () {
  const map = new Map();
  for (const it of app.state.items) {
    const b = app.lib.block(it.blockId);
    if (!b) continue;
    const e = map.get(b.id) || { block: b, qty: 0, price: 0 };
    e.qty++; e.price = e.qty * b.price;
    map.set(b.id, e);
  }
  const lines = [...map.values()].sort((a, b) => b.qty - a.qty);
  return {
    lines,
    count: app.state.items.length,
    total: lines.reduce((s, l) => s + l.price, 0),
  };
};

app.boundsInUnits = function () {
  const b = app.viewer.bounds();
  if (!b) return null;
  const k = app.lib.scale;
  return {
    min: [r(b.min.x / k), r(b.min.y / k), r(b.min.z / k)],
    max: [r(b.max.x / k), r(b.max.y / k), r(b.max.z / k)],
    size: [r((b.max.x - b.min.x) / k), r((b.max.y - b.min.y) / k), r((b.max.z - b.min.z) / k)],
  };
};

function refreshAll() {
  const inv = app.inventory();
  const ul = $('#bom');
  ul.innerHTML = '';
  if (!inv.lines.length) {
    ul.innerHTML = '<li class="empty">Aucun élément. Choisissez un bloc dans le catalogue.</li>';
  } else {
    for (const l of inv.lines) {
      const li = document.createElement('li');
      li.innerHTML = `<span class="q">${l.qty}</span><span class="n"></span><span class="p"></span>`;
      li.querySelector('.n').textContent = l.block.name;
      li.querySelector('.p').textContent = app.lib.priceEnabled && l.block.price
        ? `${fmt(l.price)} ${app.lib.currency}` : '';
      li.onclick = () => {
        const first = app.state.items.find(i => i.blockId === l.block.id);
        if (first) app.viewer.select(first.uid);
      };
      ul.appendChild(li);
    }
  }
  $('#total-count').textContent = inv.count;
  const b = app.boundsInUnits();
  $('#total-size').textContent = b ? `${b.size.join(' × ')} ${app.lib.units}` : '—';
  $('#total-price').textContent = inv.total ? `${fmt(inv.total)} ${app.lib.currency}` : '—';
  $('#fab-count').textContent = inv.count;
  refreshSelectionPanel();
}

/* ══════════════════ matériaux ══════════════════
   La palette vient de Rhino : on ne la réinvente pas, on l'applique.
   ============================================== */
function renderMaterials() {
  const box = $('#materials-box'), list = $('#materials-list');
  const mats = app.lib?.materials || [];
  box.classList.toggle('hidden', !mats.length);
  if (!mats.length) return;

  list.innerHTML = '';
  for (const m of mats) {
    const li = document.createElement('li');
    li.title = `${m.name} — métal ${m.metalness}, rugosité ${m.roughness}`
             + (m.opacity < 1 ? `, opacité ${m.opacity}` : '');
    const dot = document.createElement('span');
    dot.className = 'mat-dot';
    dot.style.background = m.color;
    const nom = document.createElement('span');
    nom.className = 'mat-name';
    nom.textContent = m.name;
    const props = document.createElement('span');
    props.className = 'mat-props';
    props.textContent = m.metalness > 0.5 ? 'métal' : (m.roughness < 0.3 ? 'brillant' : 'mat');
    li.append(dot, nom, props);
    li.onclick = () => {
      const it = find(app.selected);
      if (!it) return toast('Sélectionnez d’abord un élément', true);
      it.color = m.color;
      app.viewer.updateItem(it);
      pushHistory(); refreshSelectionPanel();
      toast(`Matériau « ${m.name} » appliqué`);
    };
    list.appendChild(li);
  }
}

/* ══════════════════ sélection ══════════════════ */
function onSelect(uid) {
  app.selected = uid;
  refreshSelectionPanel();
  refreshDimensions();
}

/** Encadré coté autour de la sélection — un seul cadre, même à plusieurs. */
function refreshDimensions() {
  if (!app.showDims || !app.selected) { app.viewer.clearDimensions(); return; }
  const uids = [app.selected];
  const box = app.viewer.boundsOf(uids);
  const nom = uids.length > 1
    ? `${uids.length} éléments`
    : app.lib.block(find(app.selected)?.blockId)?.name || '';
  app.viewer.showDimensions(box, nom);
}

function refreshSelectionPanel() {
  const box = $('#selection-box');
  const it = find(app.selected);
  if (!it) { box.classList.add('hidden'); return; }
  const b = app.lib.block(it.blockId);
  box.classList.remove('hidden');
  $('#sel-name').textContent = b.name;
  $('#sel-rot').value = r(it.rot || 0);
  $('#sel-z').value = r(it.pos[2] / app.lib.scale);
  let pts = '';
  if (b.connectorTypes.length) {
    const free = app.viewer.freeConnectors(it.uid);
    const libres = free.length
      ? `${free.length} libre${free.length > 1 ? 's' : ''} : ${[...new Set(free.map(c => c.type))].join(', ')}`
      : 'tous occupés';
    pts = `Points d'insertion ${b.connectorTypes.join(', ')} — ${libres}`;
  }
  $('#sel-meta').innerHTML = [
    b.ref ? `Réf. ${escapeHtml(b.ref)}` : '',
    dims(b),
    `X ${r(it.pos[0] / app.lib.scale)} · Y ${r(it.pos[1] / app.lib.scale)} ${app.lib.units}`,
    pts,
    b.description ? escapeHtml(b.description) : '',
  ].filter(Boolean).join('<br>');

  const couleur = it.color || b.finishes.find(f => f.id === it.finish)?.color || '#b9c2cd';
  $('#sel-color').value = /^#[0-9a-f]{6}$/i.test(couleur) ? couleur : '#b9c2cd';

  const fr = $('#finish-row'), fx = $('#sel-finishes');
  fx.innerHTML = '';
  if (b.finishes.length) {
    fr.classList.remove('hidden');
    for (const f of b.finishes) {
      const s = document.createElement('button');
      s.className = 'swatch' + (it.finish === f.id ? ' on' : '');
      s.style.background = f.color;
      s.title = f.name || f.id;
      s.onclick = () => {
        it.finish = f.id;
        app.viewer.updateItem(it);
        pushHistory(); refreshSelectionPanel();
      };
      fx.appendChild(s);
    }
  } else fr.classList.add('hidden');
}

/* ══════════════════ sauvegarde locale ══════════════════ */
let saveTimer = null;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem('cfg3d:' + app.libKey,
        JSON.stringify({ items: app.state.items, at: Date.now() }));
    } catch { /* quota */ }
  }, 400);
}
function loadLocal() {
  try { return JSON.parse(localStorage.getItem('cfg3d:' + app.libKey) || 'null'); }
  catch { return null; }
}

/* ══════════════════ interface ══════════════════ */
function wireUI() {
  $('#search').oninput = e => { app.filter.text = e.target.value; renderCatalog(); };

  $$('[data-tool]').forEach(btn => {
    btn.onclick = () => {
      $$('[data-tool]').forEach(b => b.classList.remove('on'));
      btn.classList.add('on');
      app.viewer.setTool(btn.dataset.tool);
    };
  });
  $('[data-tool="translate"]').classList.add('on');

  $('#lib-switch').onchange = async e => {
    const key = e.target.value;
    if (key === app.libKey) return;
    if (app.state.items.length &&
        !confirm('Changer de bibliothèque videra la configuration en cours. Continuer ?')) {
      e.target.value = app.libKey;
      return;
    }
    try {
      app.state.items = [];
      app.viewer.clear();
      await activateLibrary(key);
      app.history.length = 0; app.future.length = 0;
      pushHistory(true);
      refreshAll();
      toast('Bibliothèque « ' + app.lib.name +' » chargée');
    } catch (err) { toast(err.message, true); }
  };

  $('#btn-privacy').onclick = showPrivacy;

  if (app.viewonly) $('#grp-edit-mode').classList.remove('hidden');
  $('#btn-edit-mode').onclick = () => {
    app.viewonly = false;
    document.body.classList.remove('viewonly');
    $('#grp-edit-mode').classList.add('hidden');
    app.viewer.setEditable(true);
    app.viewer.resize();
    toast('Mode édition activé — composez votre version');
  };

  $('#btn-delete').onclick = deleteSelected;
  $('#btn-duplicate').onclick = duplicateSelected;
  $('#btn-undo').onclick = undo;
  $('#btn-redo').onclick = redo;
  $('#btn-clear').onclick = clearAll;
  $('#btn-fit').onclick = () => app.viewer.fit();
  $('#btn-view').onclick = () => {
    app._topView = !app._topView;
    app.viewer.setView(app._topView ? 'top' : 'iso');
  };
  $('#sel-color').oninput = e => {
    const it = find(app.selected);
    if (!it) return;
    it.color = e.target.value;
    app.viewer.updateItem(it);            // mise a jour immediate du rendu
    scheduleSave();
  };
  $('#sel-color').onchange = () => pushHistory();
  $('#btn-color-reset').onclick = () => {
    const it = find(app.selected);
    if (!it) return;
    delete it.color;
    app.viewer.updateItem(it);
    pushHistory(); refreshSelectionPanel();
  };

  $('#preset-select').onchange = describePreset;
  $('#btn-preset-load').onclick = () => {
    const id = $('#preset-select').value;
    if (!id) {
      if (app.state.items.length && !confirm('Vider la configuration en cours ?')) return;
      app.state.items = [];
      clearCompatible();
      app.viewer.clear();
      pushHistory();
      refreshAll();
      return;
    }
    loadPreset(id);
  };

  $('#compat-close').onclick = clearCompatible;
  $('#canvas').addEventListener('contextmenu', e => {
    e.preventDefault();
    if (app.viewonly) return;
    const uid = app.viewer.pickAt(e);
    if (!uid) return clearCompatible();
    app.viewer.select(uid);
    showCompatible(uid);
  });

  $('#btn-points').onclick = e => {
    const on = !app.viewer.pointsVisible;
    app.viewer.setPointsVisible(on);
    e.currentTarget.classList.toggle('on', on);
    toast(on ? "Points d'accroche affichés" : "Points masqués");
  };

  $('#btn-cotes').onclick = e => {
    app.showDims = !app.showDims;
    e.currentTarget.classList.toggle('on', app.showDims);
    refreshDimensions();
    if (app.showDims && !app.selected) toast('Sélectionnez un ou plusieurs éléments');
  };

  $('#btn-magnet').classList.add('on');
  $('#btn-magnet').onclick = e => {
    const on = !app.viewer.magnet;
    app.viewer.setMagnet(on);
    e.currentTarget.classList.toggle('on', on);
    toast(on ? 'Magnétisme des points d\'insertion activé' : 'Magnétisme désactivé');
  };

  $('#btn-snap').classList.add('on');
  $('#btn-snap').onclick = e => {
    const on = !app.viewer.snap;
    app.viewer.setSnap(on);
    e.currentTarget.classList.toggle('on', on);
    toast(on ? 'Aimantation activée' : 'Aimantation désactivée');
  };
  $$('#viewcube button').forEach(b => b.onclick = () => app.viewer.setView(b.dataset.view));

  $('#sel-rot').onchange = e => {
    const it = find(app.selected); if (!it) return;
    it.rot = Number(e.target.value) || 0;
    app.viewer.syncAll(app.state.items); pushHistory();
  };
  $$('[data-rot]').forEach(b => b.onclick = () => {
    const it = find(app.selected); if (!it) return;
    it.rot = ((it.rot || 0) + Number(b.dataset.rot)) % 360;
    app.viewer.syncAll(app.state.items); pushHistory(); refreshSelectionPanel();
  });
  $('#sel-z').onchange = e => {
    const it = find(app.selected); if (!it) return;
    it.pos[2] = (Number(e.target.value) || 0) * app.lib.scale;
    app.viewer.syncAll(app.state.items); pushHistory();
  };

  /* --- exports --- */
  $('#btn-png').onclick = () => {
    const { url } = app.viewer.snapshot(1800);
    downloadDataUrl(slug(app.lib.name) + '-configuration.png', url);
  };
  $('#btn-json').onclick = () => {
    download(slug(app.lib.name) + '-composition.json', compositionJSON(app), 'application/json');
    toast('JSON exporté — réimportable dans Rhino');
  };
  $('#btn-obj').onclick = () => {
    if (!app.state.items.length) return toast('Configuration vide', true);
    download(slug(app.lib.name) + '-composition.obj', exportOBJ(app.viewer), 'text/plain');
  };

  /* --- partage --- */
  $('#btn-share').onclick = () => openShare();
  $('#share-viewonly').onchange = () => openShare();
  $('#btn-copy').onclick = () => copy($('#share-url').value);
  $('#btn-copy-embed').onclick = () => copy($('#embed-code').value);

  /* --- devis --- */
  $('#btn-quote').onclick = async () => {
    await openShare(true);
    $('#modal-quote').classList.remove('hidden');
  };
  $('#btn-quote-copy').onclick = () => copy(quoteText(app, contact()));
  $('#btn-quote-send').onclick = () => {
    const c = contact();
    const to = app.config.quoteEmail || '';
    const subject = `Demande de devis — ${app.lib.name}${c.company ? ' — ' + c.company : ''}`;
    const body = quoteText(app, c);
    const href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    if (href.length > 1900) {
      copy(body);
      toast('Récapitulatif copié — collez-le dans votre e-mail');
    } else {
      location.href = href;
    }
    $('#modal-quote').classList.add('hidden');
  };

  $$('[data-close]').forEach(b => b.onclick = e => e.target.closest('.modal').classList.add('hidden'));
  $$('.modal').forEach(m => m.onclick = e => { if (e.target === m) m.classList.add('hidden'); });

  /* --- panneaux mobiles --- */
  $('#btn-open-catalog').onclick = () => $('#catalog').classList.add('open');
  $('#btn-close-catalog').onclick = () => $('#catalog').classList.remove('open');
  $('#fab-inspector').onclick = () => $('#inspector').classList.toggle('open');
  $('#btn-close-inspector').onclick = () => $('#inspector').classList.remove('open');

  /* --- clavier --- */
  addEventListener('keydown', e => {
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    const k = e.key.toLowerCase();
    if (e.ctrlKey || e.metaKey) {
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if (k === 'y' || (k === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
      return;
    }
    if (e.key === 'Escape') { stopPlacing(); clearCompatible(); app.viewer.select(null); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); }
    else if (k === 'd') duplicateSelected();
    else if (k === 'f') app.viewer.fit();
    else if (k === 'g') $('[data-tool="translate"]').click();
    else if (k === 'r') {
      if (app.viewer.ghost) app.viewer.rotateGhost(e.shiftKey ? -90 : 90);
      else {
        const it = find(app.selected);
        if (it) {
          it.rot = ((it.rot || 0) + (e.shiftKey ? -90 : 90)) % 360;
          app.viewer.syncAll(app.state.items); pushHistory(); refreshSelectionPanel();
        } else $('[data-tool="rotate"]').click();
      }
    }
  });

  addEventListener('hashchange', async () => {
    const s = await decodeState(readHash());
    if (!s) return;
    if (s.libUrl && s.libUrl !== app.libKey && app.catalogue.some(c => c.key === s.libUrl)) {
      try { await activateLibrary(s.libUrl); } catch (e) { toast(e.message, true); return; }
    }
    app.state.items = s.items.filter(i => app.lib.block(i.blockId));
    app.viewer.syncAll(app.state.items);
    pushHistory(); refreshAll(); app.viewer.fit();
  });
}

/* ══════════════════ partage ══════════════════ */
async function openShare(silent = false) {
  const code = await encodeState({ items: app.state.items, libUrl: app.libKey });
  const viewonly = $('#share-viewonly').checked;
  const url = buildUrl(code, { viewonly });
  app.lastShareUrl = url;
  history.replaceState(null, '', '#c=' + code);
  $('#share-url').value = url;
  $('#embed-code').value =
    `<iframe src="${buildUrl(code, { embed: true, viewonly: true })}" width="100%" height="620" style="border:0" allowfullscreen></iframe>`;
  if (!silent) $('#modal-share').classList.remove('hidden');
  return url;
}

/* ══════════════════ confidentialité ══════════════════ */
function showPrivacy() {
  const rows = [];
  const add = (k, v, ok = false) => rows.push(
    `<tr><td>${escapeHtml(k)}</td><td${ok ? ' class="ok"' : ''}>${escapeHtml(v)}</td></tr>`);

  if (app.drive) {
    const a = app.drive.audit();
    add('Source des blocs', 'Google Drive — un seul dossier');
    add('Dossier autorisé', a.dossier);
    add('Fichiers visibles', `${a.fichiersVisibles} — ${a.fichiers.join(', ')}`);
    add('Reste du Drive', 'inaccessible : hors du dossier configuré', true);
    add('Connexion Google', a.connexionGoogle, true);
    add('Écriture sur le Drive', a.ecriture, true);
    add('Dernière lecture', a.listeLe);
  } else {
    add('Source des blocs', 'fichier servi par ce site : ' + (app.libKey || '—'));
    add('Appel externe', 'aucun', true);
  }
  add('Votre configuration', 'reste dans ce navigateur (et dans le lien que vous partagez)', true);
  add('Envoi automatique', 'aucun — exports et devis partent de votre poste', true);
  add('Traceurs / analytics', 'aucun script tiers ne peut être chargé', true);

  $('#audit-table').innerHTML = rows.join('');
  const csp = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
  $('#audit-csp').textContent = (csp?.getAttribute('content') || '')
    .split(';').map(s => s.trim()).filter(Boolean).join(';\n') + ';';
  $('#audit-note').textContent = app.drive
    ? 'Le dossier doit être partagé « toute personne disposant du lien » pour que les '
      + 'visiteurs voient les blocs : son contenu est donc non répertorié, pas secret. '
      + 'Aucun autre fichier de votre Drive n\'est atteignable depuis cette page.'
    : 'Aucune donnée ne quitte le navigateur du visiteur.';
  $('#modal-privacy').classList.remove('hidden');
}

/* ══════════════════ utilitaires ══════════════════ */
function contact() {
  return {
    name: $('#q-name').value.trim(),
    company: $('#q-company').value.trim(),
    email: $('#q-email').value.trim(),
    phone: $('#q-phone').value.trim(),
    msg: $('#q-msg').value.trim(),
  };
}

async function copy(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copié dans le presse-papiers');
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text; document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); ta.remove();
    toast('Copié');
  }
}

let toastTimer = null;
function toast(msg, err = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.toggle('err', err);
  t.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

const r = v => Math.round(v * 1000) / 1000;
const slug = s => (s || 'configuration').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
