# -*- coding: utf-8 -*-
"""
Vérifie qu'un dossier Google Drive est correctement configuré comme
bibliothèque du configurateur — AVANT de mettre le site en ligne.

    python tools/check_drive_folder.py
    python tools/check_drive_folder.py --config config.json
    python tools/check_drive_folder.py --folder <ID|URL> --key <API_KEY>

Le script fait exactement ce que fera le navigateur du visiteur :
listing du dossier, contrôle des `parents`, téléchargement de la
bibliothèque, validation de son contenu. Aucun compte Google n'est
utilisé : uniquement la clé API, en lecture.
"""

import argparse
import io
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://www.googleapis.com/drive/v3"
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

OK, KO, WARN = "  [ok]  ", "  [KO]  ", "  [! ]  "


def parse_folder_id(value):
    v = (value or "").strip()
    m = re.search(r"/folders/([A-Za-z0-9_-]{10,})", v) or re.search(r"[?&]id=([A-Za-z0-9_-]{10,})", v)
    if m:
        return m.group(1)
    return v if re.match(r"^[A-Za-z0-9_-]{10,}$", v) else None


def call(path, params):
    url = API + path + "?" + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers={"Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return json.loads(r.read().decode("utf-8")), None
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            msg = json.loads(body)["error"]["message"]
        except Exception:
            msg = body[:300]
        return None, "HTTP %d — %s" % (e.code, msg)
    except Exception as e:
        return None, str(e)


def raw(path, params):
    url = API + path + "?" + urllib.parse.urlencode(params)
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            return r.read(), None
    except urllib.error.HTTPError as e:
        return None, "HTTP %d" % e.code
    except Exception as e:
        return None, str(e)


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")   # accents lisibles sous Windows
    except Exception:
        pass
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default=os.path.join(HERE, "config.json"))
    ap.add_argument("--folder")
    ap.add_argument("--key")
    args = ap.parse_args()

    folder, key = args.folder, args.key
    if not (folder and key):
        if not os.path.exists(args.config):
            print(KO + "config.json introuvable : %s" % args.config)
            return 1
        cfg = json.load(io.open(args.config, encoding="utf-8"))
        src = cfg.get("source") or {}
        if src.get("type") != "drive":
            print(WARN + "config.json n'est pas en mode Drive (source.type = %r)."
                  % src.get("type"))
            print("        Utilisez config.drive.exemple.json comme modèle.")
            return 1
        folder = folder or src.get("folderId")
        key = key or src.get("apiKey")

    folder_id = parse_folder_id(folder)
    print("=" * 64)
    print("Dossier : %s" % folder_id)
    print("Clé API : %s" % (("%s…%s" % (key[:8], key[-4:])) if key and len(key) > 14 else key))
    print("=" * 64)

    if not folder_id:
        print(KO + "Identifiant de dossier invalide.")
        return 1
    if not key or key.startswith("METTRE"):
        print(KO + "Clé API absente.")
        return 1

    # 1. le dossier est-il lisible publiquement ?
    meta, err = call("/files/" + folder_id, {
        "key": key, "fields": "id,name,mimeType", "supportsAllDrives": "true"})
    if err:
        print(KO + "Dossier illisible : %s" % err)
        print("""
        Points à vérifier :
          • le dossier est partagé en « Tous les utilisateurs disposant du lien »,
            rôle Lecteur (le partage nominatif ne suffit pas : les visiteurs ne
            sont pas connectés) ;
          • l'API Google Drive est activée sur le projet Cloud de la clé ;
          • la restriction par référent de la clé autorise le domaine du site
            (en local, autorisez aussi http://localhost:*).""")
        return 1
    if meta.get("mimeType") != "application/vnd.google-apps.folder":
        print(KO + "Cet identifiant n'est pas un dossier (%s)." % meta.get("mimeType"))
        return 1
    print(OK + "Dossier accessible sans connexion : « %s »" % meta.get("name"))

    # 2. listing
    data, err = call("/files", {
        "key": key,
        "q": "'%s' in parents and trashed = false" % folder_id,
        "fields": "files(id,name,mimeType,size,parents)",
        "pageSize": "200", "orderBy": "name",
        "supportsAllDrives": "true", "includeItemsFromAllDrives": "true",
    })
    if err:
        print(KO + "Listing refusé : %s" % err)
        return 1
    files = data.get("files") or []
    if not files:
        print(KO + "Le dossier est vide (ou son contenu n'est pas partagé).")
        return 1

    print(OK + "%d fichier(s) visible(s) :" % len(files))
    intrus = 0
    for f in files:
        parents = f.get("parents") or []
        mark = " "
        if folder_id not in parents:
            mark, intrus = "!", intrus + 1
        size = int(f.get("size") or 0)
        print("        %s %-40s %8.0f Ko" % (mark, f["name"][:40], size / 1024.0))
    if intrus:
        print(WARN + "%d fichier(s) hors dossier seraient écartés par l'application." % intrus)

    libs = [f for f in files if f["name"].lower().endswith(".json")
            and folder_id in (f.get("parents") or [])]
    if not libs:
        print(KO + "Aucune bibliothèque .json dans ce dossier.")
        return 1

    # 3. téléchargement + validation de chaque bibliothèque
    problemes = 0
    for f in libs:
        body, err = raw("/files/" + f["id"], {"key": key, "alt": "media",
                                              "supportsAllDrives": "true"})
        if err:
            print(KO + "%s : téléchargement impossible (%s)" % (f["name"], err))
            problemes += 1
            continue
        try:
            lib = json.loads(body.decode("utf-8"))
        except Exception as e:
            print(KO + "%s : JSON illisible (%s)" % (f["name"], e))
            problemes += 1
            continue
        blocks = lib.get("blocks") or []
        if not blocks:
            print(KO + "%s : aucun bloc." % f["name"])
            problemes += 1
            continue
        sans_maillage = [b.get("id") for b in blocks if not b.get("meshes")]
        print(OK + "%s : %d blocs, unité %s, %.0f Ko"
              % (f["name"], len(blocks), lib.get("units", "?"), len(body) / 1024.0))
        if sans_maillage:
            print(WARN + "   blocs sans géométrie : %s" % ", ".join(map(str, sans_maillage[:5])))
        if len(body) > 8 * 1024 * 1024:
            print(WARN + "   fichier volumineux : le premier chargement sera lent.")

    print("=" * 64)
    if problemes:
        print("Configuration incomplète : %d problème(s)." % problemes)
        return 1
    print("Configuration valide. L'application ne verra que ce dossier.")
    print("Rappel : « lien public » signifie non répertorié, pas confidentiel —")
    print("toute personne connaissant l'URL du fichier peut le lire.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
