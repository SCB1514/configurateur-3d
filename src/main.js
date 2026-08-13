import { loadLibrary, buildLibrary } from './library.js';
import { DriveFolder, parseFolderId } from './drive.js';
import { Viewer } from './viewer.js';
import { ENVIRONNEMENTS } from './render.js';
import { ThumbnailFactory } from './thumbnails.js';
import { encodeState, decodeState, readHash, buildUrl } from './share.js';
import { Plan } from './plan.js';
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
  selection: [],         // uid des éléments choisis
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
    onSelect: (uid, selection) => onSelect(uid, selection),
    onTransform: (uid, patch) => {
      const it = find(uid);
      if (it) { Object.assign(it, patch); refreshSelectionPanel(); refreshDimensions(); scheduleSave(); }
    },
    onCommit: () => pushHistory(),
    onQualite: (niveau, fps) => {
      // la machine ne suivait pas : on allege, et on le dit plutot que de
      // laisser croire a un rendu degrade sans raison
      refreshRendu();
      toast(`Rendu allégé — ${fps} images/s en qualité haute`);
    },
  });
  app.viewer.setEditable(!app.viewonly);
  app.thumbs = new ThumbnailFactory(256);
  app.plan = new Plan(app.viewer);
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

    /* Une autre bibliothèque du même site, demandée par l'adresse.
       Le chemin est bridé à une ressource locale : ni protocole, ni hôte, ni
       remontée de dossier. Le mode statique ne sort pas du site, c'est la
       règle du périmètre réseau — une source extérieure passe par un
       fournisseur déclaré, jamais par un paramètre d'URL. */
    const demande = params.get('lib');
    if (demande && /^[\w./-]+\.json$/.test(demande) && !demande.includes('..')
        && demande !== path) {
      app.catalogue.push({ key: demande, name: prettyName(demande.split('/').pop()),
                           file: demande });
    }
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
  renderSaves();
  if (app.plan) chargerPlanEnregistre();

  // Les vignettes sont des captures : rendues avant que les images de texture
  // soient décodées, elles figeraient des blocs sans matière. On les reprend
  // une fois toutes les textures arrivées.
  if (lib.hasTextures) {
    lib.whenTexturesReady(() => {
      if (app.lib !== lib) return;              // l'utilisateur a changé de bibliothèque
      app.thumbs.cache.clear();
      app.thumbs.matCache.clear();
      renderCatalog();
      renderMaterials();
    });
  }
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

    card.onclick = () => {
      if (!compat) return startPlacing(b.id);
      return compat.replacing ? replaceSelected(b.id) : attachCompatible(b.id);
    };
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
function showCompatible(uid, typeImpose) {
  const it = find(uid);
  if (!it) return clearCompatible();
  const block = app.lib.block(it.blockId);

  // Un point occupé ouvre le menu comme les autres : on peut vouloir y
  // remplacer ce qui s'y trouve.
  const libres = [...new Set(app.viewer.freeConnectors(uid).map(c => c.type))].sort();
  const types = typeImpose ? [typeImpose] : [...new Set(block.connectorTypes)].sort();

  if (!block.connectorTypes.length) {
    toast('Ce bloc n\'a pas de point d\'insertion');
    return clearCompatible();
  }

  app.compat = { uid, blockName: block.name, types, libres, replacing: false };
  $('#btn-replace').classList.remove('on');
  app.filter = { text: '', category: null };
  $('#search').value = '';
  $('#compat-bar').classList.remove('hidden');
  $('#compat-name').textContent = block.name;
  const occupes = types.filter(t => !libres.includes(t));
  $('#compat-types').textContent = libres.length
    ? `point${libres.length > 1 ? 's' : ''} libre${libres.length > 1 ? 's' : ''} `
      + `${libres.join(', ')} — cliquez un bloc, il se connecte`
    : `point${occupes.length > 1 ? 's' : ''} ${occupes.join(', ')} `
      + `occupé${occupes.length > 1 ? 's' : ''} — utilisez « Remplacer »`;
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

/**
 * Remplace l'élément sélectionné par un autre bloc, en conservant sa position,
 * sa rotation et son coloris — et en rattrapant ce qui était raccordé à lui.
 *
 * Les machines posées sur ses points d'insertion suivent le point homologue du
 * nouveau bloc, avec leur propre grappe. Sans homologue, elles restent où elles
 * sont et le message le dit : mieux vaut un décompte franc qu'un « connexions
 * conservées » démenti par la vue.
 */
function replaceSelected(blockId) {
  const uid = app.compat?.uid;
  const ancien = find(uid);
  const nouveau = app.lib.block(blockId);
  if (!ancien || !nouveau) return;

  const avant = app.lib.block(ancien.blockId);
  // Relevé AVANT l'échange : après, les points de l'ancien bloc n'existent plus.
  const liens = app.viewer.connectionsOn(uid);

  const remplacant = {
    ...ancien,
    blockId,
    finish: nouveau.finishes.some(f => f.id === ancien.finish)
      ? ancien.finish : (nouveau.finishes[0]?.id || null),
  };
  if (ancien.color && !nouveau.parts.some(p => p.paintable)) delete remplacant.color;

  app.state.items[app.state.items.findIndex(i => i.uid === uid)] = remplacant;
  app.viewer.updateItem(remplacant);

  const { repris, orphelins } = reconnecter(uid, avant, nouveau, liens);
  app.viewer.select(uid);
  pushHistory();
  refreshAll();

  toast(`Remplacé par « ${nouveau.name} »` + bilanRaccordements(repris, orphelins));
  showCompatible(uid);
}

function bilanRaccordements(repris, orphelins) {
  if (!repris && !orphelins) return '';
  if (!repris) {
    return ` — ${orphelins} raccordement${pluriel(orphelins)} sans équivalent, `
      + `laissé${pluriel(orphelins)} en place`;
  }
  return ` — ${repris} raccordement${pluriel(repris)} repris`
    + (orphelins ? `, ${orphelins} sans équivalent` : '');
}

const pluriel = n => (n > 1 ? 's' : '');

/**
 * Repose sur le nouveau bloc ce qui pendait à l'ancien.
 *
 * Les points sont appariés par catégorie et par rang : le deuxième point
 * universel de l'ancien bloc devient le deuxième du nouveau. C'est l'ordre
 * dans lequel Rhino les livre, donc celui que l'utilisateur a sous les yeux.
 */
function reconnecter(uid, avant, nouveau, liens) {
  let repris = 0, orphelins = 0;
  const deja = new Set([uid]);

  for (const lien of liens) {
    const cible = connecteurHomologue(avant, nouveau, lien.index);
    const versMonde = cible ? app.viewer.connectorWorld(uid, cible.index) : null;
    if (!versMonde) { orphelins++; continue; }

    const ecart = versMonde.clone().sub(lien.pos);
    // la grappe suit le porteur : déplacer la seule machine la détacherait
    // de tout ce qu'elle porte à son tour
    const grappe = [...app.viewer.chainFrom(lien.uid, new Set(deja))].filter(u => u !== uid);
    for (const u of grappe) {
      if (deja.has(u)) continue;
      deja.add(u);
      const it = find(u);
      if (!it) continue;
      it.pos = [r4(it.pos[0] + ecart.x), r4(it.pos[1] + ecart.y), r4(it.pos[2] + ecart.z)];
    }
    repris++;
  }

  if (repris) app.viewer.syncAll(app.state.items);
  return { repris, orphelins };
}

/** Le point du nouveau bloc qui joue le rôle du point n° index de l'ancien. */
function connecteurHomologue(avant, nouveau, index) {
  const c = avant.connectors[index];
  if (!c) return null;
  const rang = avant.connectors.filter(x => x.type === c.type).indexOf(c);
  return nouveau.connectors.filter(x => x.type === c.type)[rang] || null;
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
  const uids = app.selection?.length ? app.selection : (app.selected ? [app.selected] : []);
  if (!uids.length) return;
  if (app.compat && uids.includes(app.compat.uid)) clearCompatible();

  app.state.items = app.state.items.filter(i => !uids.includes(i.uid));
  for (const uid of uids) app.viewer.removeItem(uid);
  app.viewer.select(null);
  pushHistory();
  refreshAll();
}

function duplicateSelected() {
  const uids = app.selection?.length ? app.selection : (app.selected ? [app.selected] : []);
  if (!uids.length) return;

  const step = app.viewer.gridStep * 2;
  const copies = [];
  for (const uid of uids) {
    const it = find(uid);
    if (!it) continue;
    const copy = { ...it, uid: newUid(), pos: [it.pos[0] + step, it.pos[1] + step, it.pos[2]] };
    app.state.items.push(copy);
    app.viewer.addItem(copy);
    copies.push(copy.uid);
  }
  if (!copies.length) return;

  app.viewer.select(copies[0]);
  for (const uid of copies.slice(1)) app.viewer.select(uid, true);
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

/* ══════════════════ bibliothèque de configurations ══════════════════
   Les configurations du client vivent dans son navigateur, une entrée par
   bibliothèque. L'export produit un fichier qu'il peut nous transmettre ou
   reprendre sur un autre poste.
   ==================================================================== */
const SAVES_KEY = () => 'cfg3d:saves:' + app.libKey;

function loadSaves() {
  try { return JSON.parse(localStorage.getItem(SAVES_KEY()) || '[]'); }
  catch { return []; }
}

function writeSaves(list) {
  try { localStorage.setItem(SAVES_KEY(), JSON.stringify(list)); }
  catch { toast('Mémoire du navigateur pleine', true); }
  renderSaves();
}

function renderSaves() {
  const list = $('#saves-list');
  const saves = loadSaves();
  list.innerHTML = '';

  if (!saves.length) {
    list.innerHTML = '<li class="empty">Aucune configuration enregistrée.</li>';
    return;
  }

  for (const save of saves) {
    const li = document.createElement('li');

    const nom = document.createElement('span');
    nom.className = 'nom';
    nom.textContent = `${save.name} · ${save.items.length}`;
    nom.title = 'Charger cette configuration';
    nom.onclick = () => applySave(save);

    const quand = document.createElement('span');
    quand.className = 'quand';
    quand.textContent = save.date || '';

    const renommer = document.createElement('button');
    renommer.className = 'act'; renommer.textContent = '✎';
    renommer.title = 'Renommer';
    renommer.onclick = () => {
      const nouveau = prompt('Nom de la configuration', save.name);
      if (!nouveau?.trim()) return;
      const all = loadSaves();
      const cible = all.find(s => s.id === save.id);
      if (cible) { cible.name = nouveau.trim(); writeSaves(all); }
    };

    const supprimer = document.createElement('button');
    supprimer.className = 'act sup'; supprimer.textContent = '✕';
    supprimer.title = 'Supprimer';
    supprimer.onclick = () => {
      if (!confirm(`Supprimer « ${save.name} » ?`)) return;
      writeSaves(loadSaves().filter(s => s.id !== save.id));
    };

    li.append(nom, quand, renommer, supprimer);
    list.appendChild(li);
  }
}

function applySave(save) {
  if (app.state.items.length &&
      !confirm(`Remplacer la configuration en cours par « ${save.name} » ?`)) return;

  app.state.items = save.items
    .filter(i => app.lib.block(i.blockId))
    .map(i => ({ ...i, uid: newUid() }));

  clearCompatible();
  app.viewer.syncAll(app.state.items);
  app.viewer.select(null);
  app.viewer.fit();
  pushHistory();
  refreshAll();
  toast(`« ${save.name} » chargée — ${app.state.items.length} éléments`);
}

function saveCurrent() {
  if (!app.state.items.length) return toast('La configuration est vide', true);

  const defaut = 'Configuration ' + (loadSaves().length + 1);
  const nom = prompt('Nom de la configuration', defaut);
  if (!nom?.trim()) return;

  const saves = loadSaves();
  saves.unshift({
    id: 's' + Date.now().toString(36),
    name: nom.trim(),
    date: new Date().toLocaleDateString('fr-FR'),
    items: app.state.items.map(({ uid, ...reste }) => reste),
  });
  writeSaves(saves.slice(0, 50));
  toast(`« ${nom.trim()} » enregistrée`);
}

function exportSaves() {
  const saves = loadSaves();
  if (!saves.length) return toast('Aucune configuration à exporter', true);
  download(slug(app.lib.name) + '-configurations.json', JSON.stringify({
    format: 'configurateur-planet-fitness-pro/configurations',
    library: app.lib.name,
    exportedAt: new Date().toISOString(),
    saves,
  }, null, 2), 'application/json');
}

async function importSaves(file) {
  try {
    const data = JSON.parse(await file.text());
    const entrantes = Array.isArray(data) ? data : (data.saves || []);
    const valides = entrantes.filter(s => s && Array.isArray(s.items));
    if (!valides.length) return toast('Fichier sans configuration', true);

    const saves = loadSaves();
    const connus = new Set(saves.map(s => s.id));
    let ajoutees = 0;
    for (const s of valides) {
      if (connus.has(s.id)) continue;
      saves.push({ ...s, id: s.id || 's' + Date.now().toString(36) + ajoutees });
      ajoutees++;
    }
    writeSaves(saves.slice(0, 50));
    toast(`${ajoutees} configuration(s) importée(s)`);
  } catch (e) {
    toast('Fichier illisible', true);
  }
}

/* ══════════════════ rendu et caméra ══════════════════
   Le réglage se fait à l'œil, sur la scène : le panneau flotte au-dessus
   d'elle et chaque curseur agit sans validation. Les choix sont mémorisés
   par navigateur — ils tiennent à l'usage de la personne, pas au projet,
   et n'ont donc rien à faire dans le lien de partage.
   ==================================================== */

const CLE_RENDU = 'cfg3d:rendu';

function wireRendu() {
  const panneau = $('#render-panel');
  const rendu = app.viewer.rendu;

  $('#btn-render').onclick = () => {
    panneau.classList.toggle('hidden');
    $('#btn-render').classList.toggle('on', !panneau.classList.contains('hidden'));
  };
  $('#btn-render-close').onclick = () => {
    panneau.classList.add('hidden');
    $('#btn-render').classList.remove('on');
  };

  // les ambiances viennent de render.js : une seule source de vérité
  const chips = $('#env-chips');
  chips.innerHTML = '';
  for (const [cle, reglage] of Object.entries(ENVIRONNEMENTS)) {
    const chip = document.createElement('button');
    chip.className = 'chip';
    chip.dataset.env = cle;
    chip.textContent = reglage.nom;
    chip.onclick = () => {
      rendu.regler({ environnement: cle });
      refreshRendu();          // l'ambiance impose sa propre exposition
      sauverRendu();
    };
    chips.appendChild(chip);
  }

  const curseur = (id, champ, format) => {
    const input = $(id);
    input.oninput = () => {
      const v = Number(input.value);
      rendu.regler({ [champ]: v });
      $(id + '-val').textContent = format(v);
    };
    input.onchange = sauverRendu;
  };
  curseur('#rp-expo', 'exposition', v => v.toFixed(2));
  curseur('#rp-ombres', 'ombres', v => Math.round(v * 100) + '%');
  curseur('#rp-ao', 'occlusion', v => Math.round(v * 100) + '%');
  curseur('#rp-bloom', 'bloom', v => Math.round(v * 125) + '%');

  $('#rp-focale').oninput = e => {
    const mm = app.viewer.setFocale(Number(e.target.value));
    $('#rp-focale-val').textContent = Math.round(mm) + ' mm';
  };
  $('#rp-focale').onchange = sauverRendu;

  $('#rp-rotation').onchange = e => { app.viewer.setRotationAuto(e.target.checked); sauverRendu(); };
  $('#rp-sol').onchange = e => { rendu.regler({ sol: e.target.checked }); sauverRendu(); };
  $('#rp-reflets').onchange = e => { rendu.regler({ reflets: e.target.checked }); sauverRendu(); };
  $('#rp-reperes').onchange = e => { rendu.regler({ reperes: e.target.checked }); sauverRendu(); };
  $('#rp-qualite').onchange = e => {
    rendu.regler({ qualite: e.target.checked ? 'haute' : 'rapide' });
    sauverRendu();
  };

  $('#rp-reset').onclick = () => {
    rendu.regler({ ombres: 0.7, occlusion: 0.7, bloom: 0.2, sol: true,
                   reflets: true, reperes: true, qualite: 'haute' });
    rendu.appliquerEnvironnement('studio');
    app.viewer.setFocale(40);
    app.viewer.setRotationAuto(false);
    refreshRendu();
    sauverRendu();
  };

  $('#rp-image').onclick = () => {
    const { url } = app.viewer.snapshot(2400);
    const a = document.createElement('a');
    a.href = url;
    a.download = (app.lib?.name || 'configuration').replace(/[^\w-]+/g, '-') + '.png';
    a.click();
    toast('Image enregistrée');
  };

  chargerRendu();
  refreshRendu();
  suivreRythme();
}

/**
 * Affiche le rythme reel et la carte graphique.
 *
 * Sans ce chiffre, tout reglage de qualite se fait a l'aveugle : le meme
 * projet tourne a cent images par seconde sur une station et a quinze sur un
 * portable a puce integree, et rien a l'ecran ne le dit.
 */
function suivreRythme() {
  const champ = $('#rp-fps');
  const carte = $('#rp-gpu');

  try {
    const gl = app.viewer.renderer.getContext();
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    const nom = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : '';
    // on ne garde que la puce, pas la ribambelle de pilotes entre parentheses
    carte.textContent = String(nom).replace(/^ANGLE \(|\)$/g, '').split(',')[1]?.trim() || nom;
    carte.title = nom;
  } catch { /* extension refusee */ }

  /* La scene ne se redessine qu'a la demande : au repos, il n'y a
     litteralement plus rien a mesurer. On n'affiche donc le rythme que
     lorsqu'il vient d'etre releve — pendant une manipulation, le seul
     moment ou il renseigne sur quoi que ce soit. */
  setInterval(() => {
    const n = app.viewer?.rythmeFrais;
    champ.textContent = n ? n : 'au repos';
  }, 400);
}

/** Remet les commandes au diapason de l'état réel du moteur. */
function refreshRendu() {
  const r = app.viewer.rendu.reglages;

  $$('#env-chips .chip').forEach(c => c.classList.toggle('on', c.dataset.env === r.environnement));

  const poser = (id, valeur, texte) => { $(id).value = valeur; $(id + '-val').textContent = texte; };
  poser('#rp-expo', r.exposition, r.exposition.toFixed(2));
  poser('#rp-ombres', r.ombres, Math.round(r.ombres * 100) + '%');
  poser('#rp-ao', r.occlusion, Math.round(r.occlusion * 100) + '%');
  poser('#rp-bloom', r.bloom, Math.round(r.bloom * 125) + '%');

  const mm = Math.round(app.viewer.focale);
  poser('#rp-focale', mm, mm + ' mm');

  $('#rp-rotation').checked = app.viewer.rotationAuto;
  $('#rp-sol').checked = r.sol;
  $('#rp-reflets').checked = r.reflets;
  $('#rp-reperes').checked = r.reperes;
  $('#rp-qualite').checked = r.qualite === 'haute';
}

function sauverRendu() {
  try {
    localStorage.setItem(CLE_RENDU, JSON.stringify({
      ...app.viewer.rendu.reglages,
      focale: Math.round(app.viewer.focale),
      rotation: app.viewer.rotationAuto,
    }));
  } catch { /* quota */ }
}

function chargerRendu() {
  let memo;
  try { memo = JSON.parse(localStorage.getItem(CLE_RENDU) || 'null'); } catch { return; }
  if (!memo) return;

  // On ne reprend que des clés connues : un stockage ancien ou trafiqué ne
  // doit pas pouvoir injecter n'importe quoi dans le moteur.
  const patch = {};
  for (const cle of ['environnement', 'exposition', 'ombres', 'occlusion', 'bloom',
                     'sol', 'reflets', 'reperes', 'qualite']) {
    if (memo[cle] !== undefined) patch[cle] = memo[cle];
  }
  if (patch.environnement && !ENVIRONNEMENTS[patch.environnement]) delete patch.environnement;

  // l'ambiance d'abord : elle repose exposition, soleil et sol
  if (patch.environnement) app.viewer.rendu.appliquerEnvironnement(patch.environnement);
  app.viewer.rendu.regler(patch);

  if (memo.focale) app.viewer.setFocale(memo.focale);
  if (memo.rotation) app.viewer.setRotationAuto(true);
}

/* ══════════════════ fond de plan ══════════════════
   Le plan de la salle, posé au sol : on implante les machines dessus.
   Image ou DXF — le DXF est un format texte, lu sans dépendance extérieure.
   ================================================== */
function wirePlan() {
  $('#btn-plan-open').onclick = () => $('#plan-file').click();
  $('#plan-file').onchange = e => {
    const fichier = e.target.files?.[0];
    if (fichier) importerPlan(fichier);
    e.target.value = '';
  };

  $('#plan-width').onchange = e => {
    const largeur = Number(e.target.value);
    if (largeur > 0) { app.plan.regler({ largeur }); sauverPlan(); }
  };
  $('#plan-rot').onchange = e => {
    app.plan.regler({ rotation: Number(e.target.value) || 0 });
    sauverPlan();
  };
  $('#plan-opacity').oninput = e => app.plan.regler({ opacite: Number(e.target.value) / 100 });
  $('#plan-opacity').onchange = sauverPlan;

  $('#btn-plan-toggle').onclick = () => {
    app.plan.regler({ visible: !app.plan.etat.visible });
    refreshPlan();
    sauverPlan();
  };
  $('#plan-page').onchange = async e => {
    const page = Number(e.target.value);
    if (!app.plan.charge || !(page > 0) || !app.plan._pdfDonnees) return;
    try {
      const reglages = { ...app.plan.etat };
      const info = await app.plan.chargerPDF(app.plan._pdfDonnees, reglages.nom, page);
      app.plan.regler({ largeur: reglages.largeur, rotation: reglages.rotation,
                        opacite: reglages.opacite, visible: reglages.visible });
      refreshPlan();
      sauverPlan();
      toast(`Page ${info.page} sur ${info.pages}`);
    } catch (err) { toast(err.message, true); }
  };

  $('#btn-plan-calibrate').onclick = calibrerPlan;

  $('#btn-plan-clear').onclick = () => {
    if (!app.plan.charge) return;
    if (!confirm('Retirer le fond de plan ?')) return;
    app.plan.vider();
    refreshPlan();
    sauverPlan();
  };
}

async function importerPlan(fichier) {
  const nom = fichier.name;
  const extension = nom.split('.').pop().toLowerCase();

  try {
    if (extension === 'dxf') {
      const info = app.plan.chargerDXF(await fichier.text(), nom);
      toast(`${nom} — ${info.segments} traits`);
    } else if (extension === 'pdf') {
      toast('Lecture du PDF…');
      const donnees = new Uint8Array(await fichier.arrayBuffer());
      const info = await app.plan.chargerPDF(donnees, nom, 1);
      toast(info.pages > 1
        ? `${nom} — page 1 sur ${info.pages}`
        : `${nom} — ${info.largeurPixels} x ${info.hauteurPixels} px`);
    } else {
      const dataUrl = await new Promise((ok, ko) => {
        const lecteur = new FileReader();
        lecteur.onload = () => ok(lecteur.result);
        lecteur.onerror = () => ko(new Error('Fichier illisible'));
        lecteur.readAsDataURL(fichier);
      });
      const info = await app.plan.chargerImage(dataUrl, nom);
      toast(`${nom} — ${info.largeurPixels} x ${info.hauteurPixels} px`);
    }

    // largeur de départ : l'emprise des machines posées, sinon dix mètres
    const b = app.viewer.bounds();
    const defaut = b ? Math.round((b.max.x - b.min.x) / app.lib.scale) || 10000 : 10000;
    app.plan.regler({ largeur: defaut });
    refreshPlan();
    sauverPlan();
  } catch (e) {
    toast(e.message, true);
  }
}

/**
 * Cale le plan sur une distance connue.
 *
 * On mesure ce dont on est sûr — une porte, une trame, un mur — plutôt que
 * de deviner la largeur totale du document, qui inclut souvent un cartouche
 * et des marges.
 */
async function calibrerPlan() {
  if (!app.plan?.charge) return;

  const bouton = $('#btn-plan-calibrate');
  bouton.classList.add('on');
  bouton.textContent = 'Cliquez le 1er point…';
  toast('Cliquez deux points de distance connue — Échap pour annuler');

  const suivi = setInterval(() => {
    if (app.plan.enCalibration) bouton.textContent = 'Cliquez le 2e point…';
  }, 400);

  const mesure = await app.plan.calibrer();
  clearInterval(suivi);
  bouton.classList.remove('on');
  bouton.textContent = 'Calibrer sur 2 points';

  if (!mesure) return toast('Calibration annulée');

  const actuelle = Math.round(mesure / app.lib.scale);
  const saisie = prompt(
    `Distance réelle entre ces deux points, en ${app.lib.units} ?`, String(actuelle));
  if (!saisie) { app.plan.annulerCalibration(); return toast('Calibration annulée'); }

  const reelle = Number(String(saisie).replace(',', '.'));
  if (!(reelle > 0)) { app.plan.annulerCalibration(); return toast('Distance invalide', true); }

  if (app.plan.appliquerCalibration(mesure, reelle)) {
    refreshPlan();
    sauverPlan();
    toast(`Plan calé : ${actuelle} → ${Math.round(reelle)} ${app.lib.units}`);
  } else {
    app.plan.annulerCalibration();
    toast('Calibration impossible', true);
  }
}

function refreshPlan() {
  const controles = $('#plan-controls');
  controles.classList.toggle('hidden', !app.plan?.charge);
  if (!app.plan?.charge) return;

  const etat = app.plan.etat;
  $('#plan-name').textContent = etat.nom;
  $('#plan-unit').textContent = app.lib.units;
  $('#plan-width').value = Math.round(etat.largeur);
  $('#plan-rot').value = etat.rotation;
  majPages();
  $('#plan-opacity').value = Math.round(etat.opacite * 100);
  $('#btn-plan-toggle').textContent = etat.visible ? 'Masquer' : 'Afficher';
}

/** Sélecteur de page, montré seulement quand le PDF en compte plusieurs. */
function majPages() {
  const ligne = $('#plan-page-row');
  const etat = app.plan.etat;
  const multiple = etat.pages > 1;
  ligne.classList.toggle('hidden', !multiple);
  if (!multiple) return;

  const champ = $('#plan-page');
  champ.max = etat.pages;
  champ.value = etat.page || 1;
  $('#plan-pages').textContent = '/ ' + etat.pages;
}

const CLE_PLAN = () => 'cfg3d:plan:' + app.libKey;

function sauverPlan() {
  try {
    const donnees = app.plan.serialiser();
    if (!donnees) return localStorage.removeItem(CLE_PLAN());

    const texte = JSON.stringify(donnees);
    // Au-delà de deux mégaoctets le stockage du navigateur refuse : le plan
    // reste valable pour la séance, mais ne sera pas retrouvé ensuite.
    if (texte.length > 2000000) {
      localStorage.removeItem(CLE_PLAN());
      toast('Plan trop lourd pour être mémorisé — valable cette séance', true);
      return;
    }
    localStorage.setItem(CLE_PLAN(), texte);
  } catch { /* quota */ }
}

function chargerPlanEnregistre() {
  try {
    const texte = localStorage.getItem(CLE_PLAN());
    if (texte) app.plan.restaurer(JSON.parse(texte));
  } catch { /* illisible */ }
  refreshPlan();
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
    li.dataset.color = m.color;

    // Aperçu rendu : une sphère de la matière, pas un aplat de couleur.
    const vignette = document.createElement('img');
    vignette.className = 'mat-thumb';
    vignette.alt = '';
    vignette.style.background = m.color;      // le temps que le rendu arrive
    try {
      const url = app.thumbs.renderMaterial(m);
      if (url) vignette.src = url;
    } catch (err) { console.warn('aperçu matériau', m.id, err); }

    const nom = document.createElement('span');
    nom.className = 'mat-name';
    nom.textContent = m.name;
    const props = document.createElement('span');
    props.className = 'mat-props';
    props.textContent = m.metalness > 0.5 ? 'métal' : (m.roughness < 0.3 ? 'brillant' : 'mat');
    li.append(vignette, nom, props);
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
  markAppliedMaterial();
}

/** Souligne, dans la liste, le matériau porté par l'élément sélectionné. */
function markAppliedMaterial() {
  const applique = (find(app.selected) || {}).color;
  for (const li of $$('#materials-list li')) {
    li.classList.toggle('on', !!applique && sameColor(applique, li.dataset.color || ''));
  }
}

/** Deux écritures de couleur désignent-elles la même teinte ? */
function sameColor(a, b) {
  return String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
}

/* ══════════════════ sélection ══════════════════ */
function onSelect(uid, selection) {
  app.selected = uid;
  app.selection = selection || (uid ? [uid] : []);
  refreshSelectionPanel();
  refreshDimensions();
}

/** Encadré coté autour de la sélection — un seul cadre, même à plusieurs. */
function refreshDimensions() {
  const uids = app.selection || [];
  if (!app.showDims || !uids.length) { app.viewer.clearDimensions(); return; }
  const box = app.viewer.boundsOf(uids);
  const nom = uids.length > 1
    ? `${uids.length} éléments`
    : app.lib.block(find(app.selected)?.blockId)?.name || '';
  app.viewer.showDimensions(box, nom);
}

function refreshSelectionPanel() {
  const box = $('#selection-box');
  const it = find(app.selected);
  markAppliedMaterial();
  if (!it) { box.classList.add('hidden'); return; }

  // À plusieurs, on annonce l'ensemble et son encombrement global.
  const multiple = (app.selection || []).length > 1;
  const entete = $('#sel-name');
  if (multiple) {
    const b = app.viewer.boundsOf(app.selection);
    const k = app.lib.scale;
    const d = b ? [b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z]
        .map(v => Math.round(v / k)).join(' × ') + ' ' + app.lib.units : '';
    box.classList.remove('hidden');
    entete.textContent = `${app.selection.length} éléments — ${d}`;
  }
  const b = app.lib.block(it.blockId);
  box.classList.remove('hidden');
  if (!multiple) entete.textContent = b.name;
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
  $('#btn-save').onclick = saveCurrent;
  $('#btn-save-export').onclick = exportSaves;
  $('#btn-save-import').onclick = () => $('#saves-file').click();
  $('#saves-file').onchange = e => {
    const file = e.target.files?.[0];
    if (file) importSaves(file);
    e.target.value = '';
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

  wirePlan();
  wireRendu();

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

    // Un point d'accroche visé prime : la liste se filtre alors sur SA catégorie,
    // qu'il soit déjà occupé ou non.
    const point = app.viewer.pickPointAt(e);
    if (point) {
      app.viewer.select(point.uid);
      return showCompatible(point.uid, point.type);
    }

    const uid = app.viewer.pickAt(e);
    if (!uid) return clearCompatible();
    app.viewer.select(uid);
    showCompatible(uid);
  });

  $('#btn-replace').onclick = () => {
    if (!app.compat) return;
    app.compat.replacing = !app.compat.replacing;
    $('#btn-replace').classList.toggle('on', app.compat.replacing);
    toast(app.compat.replacing
      ? "Cliquez un bloc : il remplacera l'élément sélectionné"
      : "Retour à l'ajout");
  };

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
const r4 = v => Math.round(v * 1e4) / 1e4;
const slug = s => (s || 'configuration').toLowerCase().normalize('NFD')
  .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
