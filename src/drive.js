/* ============================================================
   Source « dossier Google Drive » — accès volontairement borné
   ------------------------------------------------------------
   Garanties implémentées ici, vérifiables dans ce fichier :

   1. UNE SEULE origine réseau autorisée : https://www.googleapis.com
      (toute autre URL est refusée avant même l'appel réseau).
   2. UN SEUL dossier : chaque fichier retourné par Google est
      re-vérifié côté client — s'il n'a pas le dossier configuré
      dans ses `parents`, il est écarté.
   3. Téléchargement uniquement des identifiants issus de ce
      listing : un id inconnu est refusé (pas de fetch arbitraire).
   4. Aucune écriture, aucune connexion Google, aucun jeton OAuth :
      l'application n'a jamais accès au Drive du visiteur ni au
      reste du Drive du propriétaire. Clé API en lecture seule.

   La politique CSP de index.html (connect-src) applique la même
   limite au niveau du navigateur : c'est la ceinture en plus des
   bretelles.
   ============================================================ */

const API = 'https://www.googleapis.com/drive/v3';
const ID_RE = /^[A-Za-z0-9_-]{10,}$/;

export class DriveFolder {
  /**
   * @param {string} folderId  identifiant du dossier de bibliothèque
   * @param {string} apiKey    clé API restreinte (référent + API Drive)
   */
  constructor(folderId, apiKey) {
    if (!ID_RE.test(folderId || '')) throw new Error('Identifiant de dossier Drive invalide.');
    if (!apiKey) throw new Error('Clé API Google manquante.');
    this.folderId = folderId;
    this.apiKey = apiKey;
    this.allowed = new Map();     // id -> métadonnées, seule liste téléchargeable
    this.listedAt = null;
  }

  /* --- garde-fou : aucune URL hors périmètre ne sort d'ici --- */
  _url(path, params) {
    const u = new URL(API + path);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    u.searchParams.set('key', this.apiKey);
    if (u.origin !== 'https://www.googleapis.com' || !u.pathname.startsWith('/drive/v3/')) {
      throw new Error('Requête hors périmètre bloquée : ' + u.origin + u.pathname);
    }
    return u.toString();
  }

  async _json(url) {
    const res = await fetch(url, { cache: 'no-cache', referrerPolicy: 'origin' });
    const txt = await res.text();
    let data = null;
    try { data = JSON.parse(txt); } catch { /* réponse non JSON */ }
    if (!res.ok) throw new Error(driveError(res.status, data));
    return data;
  }

  /** Liste le dossier. Seuls les enfants directs sont retenus. */
  async list() {
    const files = [];
    let pageToken = '';
    do {
      const params = {
        q: `'${this.folderId}' in parents and trashed = false`,
        fields: 'nextPageToken, files(id, name, mimeType, size, modifiedTime, parents)',
        pageSize: '200',
        orderBy: 'name',
        supportsAllDrives: 'true',
        includeItemsFromAllDrives: 'true',
      };
      if (pageToken) params.pageToken = pageToken;
      const data = await this._json(this._url('/files', params));
      for (const f of data.files || []) {
        // vérification côté client : enfant direct du dossier configuré
        if (!Array.isArray(f.parents) || !f.parents.includes(this.folderId)) continue;
        if (f.mimeType === 'application/vnd.google-apps.folder') continue;   // pas de descente
        files.push(f);
      }
      pageToken = data.nextPageToken || '';
    } while (pageToken);

    this.allowed = new Map(files.map(f => [f.id, f]));
    this.listedAt = new Date();
    return files;
  }

  /** Bibliothèques JSON présentes dans le dossier. */
  libraries() {
    return [...this.allowed.values()]
      .filter(f => /\.json$/i.test(f.name) || f.mimeType === 'application/json')
      .sort((a, b) => (a.name === 'library.json' ? -1 : b.name === 'library.json' ? 1 : a.name.localeCompare(b.name)));
  }

  /** Contenu d'un fichier — uniquement s'il vient du listing. */
  async getJSON(fileId) {
    if (!this.allowed.has(fileId)) {
      throw new Error("Ce fichier n'appartient pas au dossier de bibliothèque : téléchargement refusé.");
    }
    return this._json(this._url(`/files/${encodeURIComponent(fileId)}`, {
      alt: 'media', supportsAllDrives: 'true',
    }));
  }

  /** Résumé affiché dans le panneau « Confidentialité ». */
  audit() {
    return {
      origine: 'https://www.googleapis.com/drive/v3 (lecture seule)',
      dossier: this.folderId,
      fichiersVisibles: this.allowed.size,
      fichiers: [...this.allowed.values()].map(f => f.name),
      connexionGoogle: 'aucune (pas d\'OAuth, pas de jeton)',
      ecriture: 'aucune méthode d\'écriture dans ce module',
      listeLe: this.listedAt ? this.listedAt.toLocaleString('fr-FR') : '—',
    };
  }
}

function driveError(status, data) {
  const reason = data?.error?.errors?.[0]?.reason || '';
  const msg = data?.error?.message || '';
  if (status === 403 && /keyInvalid|forbidden/i.test(reason + msg)) {
    return "Clé API refusée. Vérifiez que l'API Google Drive est activée et que "
      + "la restriction par référent HTTP autorise le domaine de l'application.";
  }
  if (status === 404) {
    return "Dossier introuvable. Vérifiez l'identifiant, et que le dossier est partagé "
      + "en « Tous les utilisateurs disposant du lien » (lecteur).";
  }
  if (status === 403) {
    return "Accès refusé par Google : " + (msg || 'partage insuffisant sur le dossier.');
  }
  return `Google Drive a répondu ${status}${msg ? ' — ' + msg : ''}`;
}

/** Extrait l'identifiant d'une URL de dossier Drive collée telle quelle. */
export function parseFolderId(input) {
  const s = String(input || '').trim();
  const m = s.match(/\/folders\/([A-Za-z0-9_-]{10,})/) || s.match(/[?&]id=([A-Za-z0-9_-]{10,})/);
  if (m) return m[1];
  return ID_RE.test(s) ? s : null;
}
