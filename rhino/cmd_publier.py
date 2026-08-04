# -*- coding: utf-8 -*-
"""
================================================================
 PUBLIER LA BIBLIOTHEQUE   (commande Rhino : PublierBibliotheque)
================================================================
Exporte les definitions de blocs du document courant et envoie
directement le library.json sur GitHub. GitHub Pages republie le
configurateur dans la foulee : le lien partage a vos clients est
a jour sans autre manipulation.

Premiere utilisation : la commande demande le depot et un jeton
d'acces personnel GitHub, puis les memorise dans
   %APPDATA%\\Configurateur3D\\publication.json
(hors du depot : le jeton n'est jamais versionne).

Jeton a creer sur  github.com/settings/tokens  ->  "Fine-grained"
   depot concerne, permission  Contents : Read and write.
================================================================
"""

import os
import sys
import datetime

import Rhino
import rhinoscriptsyntax as rs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import configurateur_lib as lib

try:
    reload(lib)                      # Rhino garde les modules en cache
except NameError:
    import importlib
    importlib.reload(lib)


def ask_config(cfg):
    """Complete la configuration manquante par des boites de dialogue."""
    changed = False

    if not cfg.get("owner"):
        v = rs.StringBox("Compte ou organisation GitHub (ex : scott-benetto)",
                         cfg.get("owner", ""), "Publication — depot")
        if not v:
            return None
        cfg["owner"] = v.strip(); changed = True

    if not cfg.get("repo"):
        v = rs.StringBox("Nom du depot (ex : configurateur-3d)",
                         cfg.get("repo", ""), "Publication — depot")
        if not v:
            return None
        cfg["repo"] = v.strip(); changed = True

    if not cfg.get("branch"):
        cfg["branch"] = "main"; changed = True

    if not cfg.get("path"):
        v = rs.StringBox("Chemin du fichier dans le depot",
                         "data/library.json", "Publication — chemin")
        if not v:
            return None
        cfg["path"] = v.strip(); changed = True

    if not (cfg.get("token") or os.environ.get("GITHUB_TOKEN")):
        v = rs.StringBox("Jeton GitHub (Contents: Read and write)", "",
                         "Publication — jeton")
        if not v:
            return None
        cfg["token"] = v.strip(); changed = True

    if changed:
        print("Configuration enregistree : %s" % lib.save_config(cfg))
    return cfg


def main():
    doc = lib.doc_of()
    if doc is None:
        print("Aucun document actif."); return

    print("=" * 60)
    print("Export des definitions de blocs")
    print("=" * 60)
    library = lib.build_library(doc)
    if not library["blocks"]:
        print("Rien a publier : ce document ne contient aucun bloc exploitable.")
        return

    data = lib.library_bytes(library)
    n_conn = sum(len(b.get("connectors", [])) for b in library["blocks"])
    print("")
    print("%d blocs, %d points d'insertion, %.0f Ko"
          % (len(library["blocks"]), n_conn, len(data) / 1024.0))

    cfg = ask_config(lib.load_config())
    if not cfg:
        print("Publication annulee."); return

    if not rs.MessageBox(
            "Publier %d blocs vers\n\n  %s/%s  (%s)\n  %s\n\nContinuer ?"
            % (len(library["blocks"]), cfg["owner"], cfg["repo"], cfg["branch"], cfg["path"]),
            1 | 32, "Publier la bibliotheque") == 1:
        print("Publication annulee."); return

    stamp = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    msg = "Bibliotheque : %d blocs (%s)" % (len(library["blocks"]), stamp)

    print("Envoi vers GitHub...")
    commit, err = lib.publish_to_github(data, cfg, msg)
    if err:
        print("ECHEC : %s" % err)
        print("")
        print("Verifications :")
        print("  - le jeton a bien la permission Contents: Read and write sur ce depot ;")
        print("  - le depot et la branche existent ;")
        print("  - le chemin ne commence pas par '/'.")
        print("Pour changer les reglages, supprimez %s" % lib.CONFIG_PATH)
        return

    url = lib.pages_url(cfg)
    print("")
    print("=" * 60)
    print("Publie.  %s" % (commit or ""))
    if url:
        print("Configurateur : %s" % url)
        print("(GitHub Pages met environ 30 a 60 secondes a se rafraichir)")
    print("=" * 60)

    if url and rs.MessageBox("Bibliotheque publiee.\n\nOuvrir le configurateur ?",
                             4 | 64, "Publication reussie") == 6:
        try:
            import System.Diagnostics
            System.Diagnostics.Process.Start(url)
        except Exception:
            print(url)


main()
