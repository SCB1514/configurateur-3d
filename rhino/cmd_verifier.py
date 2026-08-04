# -*- coding: utf-8 -*-
"""
================================================================
 VERIFIER LES BLOCS   (commande Rhino : VerifierBibliotheque)
================================================================
Controle le document AVANT publication :

  * quels blocs partiront dans la bibliotheque ;
  * quels points d'insertion sont reconnus, et lesquels ne le
    sont pas (faute de frappe dans le nom) ;
  * quels blocs pourront s'aimanter entre eux ;
  * les blocs orphelins, sans aucun point d'insertion.

Ne modifie rien, n'envoie rien.
================================================================
"""

import os
import sys

import Rhino

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import configurateur_lib as lib

try:
    reload(lib)
except NameError:
    import importlib
    importlib.reload(lib)


def nested_names(idef, doc, acc, depth=0):
    """Noms de toutes les definitions imbriquees, en profondeur."""
    if depth > 6:
        return
    for ro in idef.GetObjects():
        geo = ro.Geometry
        if isinstance(geo, Rhino.Geometry.InstanceReferenceGeometry):
            nd = doc.InstanceDefinitions.FindId(geo.ParentIdefId)
            if nd:
                acc.append(nd.Name or "")
                nested_names(nd, doc, acc, depth + 1)


def main():
    doc = lib.doc_of()
    if doc is None:
        print("Aucun document actif."); return

    print("=" * 66)
    print("CONTROLE DE LA BIBLIOTHEQUE — %s"
          % (os.path.basename(doc.Path) if doc.Path else "document non enregistre"))
    print("Unite du document : %s" % lib.unit_name(doc))
    print("=" * 66)

    produits, douteux, par_type = [], [], {}

    for idef in doc.InstanceDefinitions:
        if idef.IsDeleted:
            continue
        name = idef.Name or ""
        if lib.connector_type(name):
            continue                       # c'est un point d'insertion, pas un produit
        if lib.SKIP_PREFIX and name.startswith(lib.SKIP_PREFIX):
            print("  (ignore, prefixe '%s')  %s" % (lib.SKIP_PREFIX, name))
            continue

        noms = []
        nested_names(idef, doc, noms)
        types = sorted(set(t for t in (lib.connector_type(n) for n in noms) if t))
        for n in noms:
            if lib.connector_type(n):
                continue
            low = n.lower()
            if "insert" in low or low.startswith("pi") or "point" in low:
                douteux.append((name, n))

        produits.append((name, types))
        for t in types:
            par_type.setdefault(t, []).append(name)

    if not produits:
        print("Aucune definition de bloc exploitable dans ce document.")
        return

    print("")
    print("BLOCS A PUBLIER (%d)" % len(produits))
    sans = 0
    for name, types in produits:
        if types:
            print("  %-38s points : %s" % (name[:38], ", ".join(types)))
        else:
            sans += 1
            print("  %-38s (aucun point d'insertion)" % name[:38])

    print("")
    print("AIMANTATION PAR TYPE DE POINT")
    if not par_type:
        print("  Aucun point d'insertion detecte.")
        print("  Placez dans vos blocs des instances d'un bloc nomme")
        print("  \"Point d'insertion A\" (ou B, C...) — l'axe Z pointe vers l'exterieur.")
    for t in sorted(par_type):
        noms = par_type[t]
        etat = "s'aimantent entre eux" if len(noms) > 1 else "SEUL — rien a connecter"
        print("  Point %-3s  %2d bloc(s)  %s" % (t, len(noms), etat))
        for n in noms:
            print("             - %s" % n)

    if douteux:
        print("")
        print("NOMS SUSPECTS — non reconnus comme points d'insertion :")
        for parent, n in douteux:
            print("  dans %-28s : \"%s\"" % (parent[:28], n))
        print("  Nommez ces blocs \"Point d'insertion A\" (A, B, C...) pour qu'ils")
        print("  soient pris en compte. Formes acceptees : Point d'insertion A,")
        print("  Point insertion A, PI_A, PT INS A.")

    print("")
    print("=" * 66)
    print("%d blocs, dont %d sans point d'insertion, %d type(s) de connexion."
          % (len(produits), sans, len(par_type)))
    print("Tout est pret pour  PublierBibliotheque." if not douteux
          else "Corrigez les noms suspects, puis  PublierBibliotheque.")
    print("=" * 66)


main()
