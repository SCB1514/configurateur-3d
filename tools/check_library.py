# -*- coding: utf-8 -*-
"""
Controle un library.json avant mise en ligne.

    python tools/check_library.py [data/library.json]

Utilise par le workflow GitHub : une bibliotheque incoherente
arrete le deploiement plutot que de casser le site en ligne.
Verifie la structure, la geometrie, et la coherence des points
d'insertion (un point orphelin ne s'aimantera jamais).
"""

import io
import json
import os
import sys

OK, KO, WARN = "  [ok] ", "  [KO] ", "  [!]  "
UNITS = ("mm", "cm", "m", "in", "ft")


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass

    path = sys.argv[1] if len(sys.argv) > 1 else os.path.join("data", "library.json")
    if not os.path.exists(path):
        print(KO + "Fichier introuvable : %s" % path)
        return 1

    try:
        lib = json.load(io.open(path, encoding="utf-8"))
    except Exception as e:
        print(KO + "JSON illisible : %s" % e)
        return 1

    erreurs, alertes = [], []
    blocks = lib.get("blocks") or []

    print("=" * 64)
    print("%s — %.0f Ko" % (path, os.path.getsize(path) / 1024.0))
    print("=" * 64)

    if not blocks:
        erreurs.append("aucun bloc")
    if lib.get("units") not in UNITS:
        erreurs.append("unite inconnue : %r (attendu %s)" % (lib.get("units"), "/".join(UNITS)))

    ids, points = set(), {}
    for b in blocks:
        bid = b.get("id") or "?"
        if bid in ids:
            erreurs.append("identifiant en double : %s" % bid)
        ids.add(bid)
        if not b.get("name"):
            alertes.append("%s : sans nom" % bid)

        meshes = b.get("meshes") or []
        if not meshes:
            erreurs.append("%s : aucune geometrie" % bid)
        for i, m in enumerate(meshes):
            pos = m.get("positions") or []
            idx = m.get("indices") or []
            if len(pos) < 9 or len(pos) % 3:
                erreurs.append("%s/maillage %d : positions invalides (%d)" % (bid, i, len(pos)))
                continue
            nv = len(pos) // 3
            if idx and max(idx) >= nv:
                erreurs.append("%s/maillage %d : indice hors limites" % (bid, i))
            nor = m.get("normals")
            if nor and len(nor) != len(pos):
                erreurs.append("%s/maillage %d : normales incoherentes" % (bid, i))

        for c in b.get("connectors") or []:
            t = str(c.get("type") or "").upper()
            if not t:
                erreurs.append("%s : point d'insertion sans lettre" % bid)
                continue
            p = c.get("pos")
            if not (isinstance(p, list) and len(p) == 3):
                erreurs.append("%s : point %s sans position" % (bid, t))
            # Le modele en vigueur n'a plus de direction : le point principal est
            # l'origine du bloc, les points natifs sont universels. Un « dir »
            # residuel d'un ancien export est simplement ignore.
            points.setdefault(t, []).append(bid)

    n_conn = sum(len(b.get("connectors") or []) for b in blocks)
    print(OK + "%d blocs, %d maillages, %d points d'insertion"
          % (len(blocks), sum(len(b.get("meshes") or []) for b in blocks), n_conn))
    print(OK + "unite %s, grille %s, %d categories"
          % (lib.get("units"), lib.get("gridStep"), len(lib.get("categories") or [])))

    if points:
        print("")
        print("  Points d'insertion :")
        for t in sorted(points):
            noms = sorted(set(points[t]))
            if len(noms) < 2 and t != "*":
                alertes.append("point %s : un seul bloc (%s) — rien a connecter" % (t, noms[0]))
            print("    %-3s %2d bloc(s) : %s" % (t, len(noms), ", ".join(noms[:6])
                                                 + (" ..." if len(noms) > 6 else "")))
    elif blocks:
        alertes.append("aucun point d'insertion : le magnetisme sera inactif")

    taille = os.path.getsize(path)
    if taille > 8 * 1024 * 1024:
        alertes.append("fichier > 8 Mo : premier chargement lent (baissez MESH_QUALITY)")

    print("")
    for a in alertes:
        print(WARN + a)
    for e in erreurs:
        print(KO + e)

    print("=" * 64)
    if erreurs:
        print("%d erreur(s) — publication a corriger." % len(erreurs))
        return 1
    print("Bibliotheque valide." + (" %d alerte(s)." % len(alertes) if alertes else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
