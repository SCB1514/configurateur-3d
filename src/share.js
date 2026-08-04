/* ============================================================
   Partage — la configuration entière tient dans l'URL.
   Aucun serveur, aucune base de données : le lien EST la donnée.
   #c=<z|u><base64url>   z = compressé (deflate-raw)
   ============================================================ */

const b64url = {
  encode(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  },
  decode(str) {
    const s = atob(str.replace(/-/g, '+').replace(/_/g, '/'));
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  },
};

async function deflate(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const cs = new CompressionStream('deflate-raw');
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
  return new Uint8Array(buf);
}

async function inflate(bytes) {
  const ds = new DecompressionStream('deflate-raw');
  const buf = await new Response(new Blob([bytes]).stream().pipeThrough(ds)).arrayBuffer();
  return new Uint8Array(buf);
}

/* --- forme compacte : palette d'ids + tableau de nombres --- */
function pack(state) {
  const palette = [];
  const idx = id => {
    let i = palette.indexOf(id);
    if (i < 0) { palette.push(id); i = palette.length - 1; }
    return i;
  };
  const items = state.items.map(it => {
    const row = [idx(it.blockId), it.pos[0], it.pos[1], it.pos[2], it.rot || 0];
    if (it.finish) row.push(it.finish);
    return row;
  });
  const out = { v: 1, p: palette, i: items };
  if (state.libUrl) out.l = state.libUrl;
  if (state.name) out.n = state.name;
  return out;
}

function unpack(o) {
  if (!o || !Array.isArray(o.i)) return null;
  const p = o.p || [];
  return {
    libUrl: o.l || null,
    name: o.n || null,
    items: o.i.map((row, k) => ({
      uid: 'u' + k + '_' + Math.random().toString(36).slice(2, 7),
      blockId: p[row[0]],
      pos: [row[1] || 0, row[2] || 0, row[3] || 0],
      rot: row[4] || 0,
      finish: row[5] || null,
    })).filter(it => it.blockId),
  };
}

export async function encodeState(state) {
  const json = JSON.stringify(pack(state));
  const bytes = new TextEncoder().encode(json);
  const z = await deflate(bytes);
  return z && z.length < bytes.length ? 'z' + b64url.encode(z) : 'u' + b64url.encode(bytes);
}

export async function decodeState(str) {
  if (!str || str.length < 2) return null;
  try {
    const mode = str[0];
    let bytes = b64url.decode(str.slice(1));
    if (mode === 'z') bytes = await inflate(bytes);
    return unpack(JSON.parse(new TextDecoder().decode(bytes)));
  } catch (e) {
    console.warn('Lien de configuration illisible :', e);
    return null;
  }
}

export function readHash() {
  const h = new URLSearchParams(location.hash.replace(/^#/, ''));
  return h.get('c');
}

export function buildUrl(code, opts = {}) {
  const u = new URL(location.href);
  u.hash = '';
  const q = u.searchParams;
  q.delete('view'); q.delete('embed');
  if (opts.viewonly) q.set('view', '1');
  if (opts.embed) q.set('embed', '1');
  return `${u.origin}${u.pathname}${q.toString() ? '?' + q : ''}#c=${code}`;
}
