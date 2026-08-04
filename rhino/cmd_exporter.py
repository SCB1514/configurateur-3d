# -*- coding: utf-8 -*-
"""
================================================================
 EXPORTER LA BIBLIOTHEQUE   (commande Rhino : ExporterBibliotheque)
================================================================
Ecrit un library.json sur le disque, sans rien publier.
A utiliser pour un test local, ou pour deposer le fichier
manuellement (dossier Google Drive, serveur interne...).

Pour publier en un clic vers GitHub : PublierBibliotheque.
================================================================
"""

import os
import sys

import rhinoscriptsyntax as rs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import configurateur_lib as lib

try:
    reload(lib)
except NameError:
    import importlib
    importlib.reload(lib)


def main():
    doc = lib.doc_of()
    if doc is None:
        print("Aucun document actif."); return

    only = None
    sel = doc.Objects.GetSelectedObjects(False, False)
    idefs = set()
    for obj in sel:
        try:
            idefs.add(obj.InstanceDefinition.Index)
        except AttributeError:
            pass
    if idefs:
        if rs.MessageBox("%d definition(s) de blocs selectionnee(s).\n\n"
                         "Oui  : exporter uniquement celles-ci\n"
                         "Non  : exporter tout le document"
                         % len(idefs), 4 | 32, "Portee de l'export") == 6:
            only = idefs

    print("=" * 60)
    library = lib.build_library(doc, only_defs=only)
    if not library["blocks"]:
        print("Rien a exporter."); return

    folder = os.path.dirname(doc.Path) if doc.Path else None
    out = rs.SaveFileName("Enregistrer la bibliotheque du configurateur",
                          "JSON (*.json)|*.json||", folder, "library", "json")
    if not out:
        print("Export annule."); return

    size = lib.write_library(library, out)
    n_conn = sum(len(b.get("connectors", [])) for b in library["blocks"])
    print("")
    print("=" * 60)
    print("%d blocs, %d points d'insertion  ->  %s"
          % (len(library["blocks"]), n_conn, out))
    print("Taille %.0f Ko   Unite %s   Grille %s"
          % (size / 1024.0, library["units"], library["gridStep"]))
    print("Copiez ce fichier dans  configurateur-3d/data/library.json")
    print("=" * 60)


main()
