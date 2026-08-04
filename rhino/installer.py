# -*- coding: utf-8 -*-
"""
================================================================
 INSTALLATION DES COMMANDES   (a lancer une seule fois)
================================================================
_RunPythonScript  ->  ce fichier.

Cree dans Rhino les alias suivants, utilisables comme des
commandes normales (tapez-les dans la ligne de commande) :

   PointInsertion            poser un point d'insertion A/B/C...
   VerifierBibliotheque      controler les blocs avant publication
   ExporterBibliotheque      ecrire un library.json sur le disque
   PublierBibliotheque       publier directement sur GitHub
   ImporterComposition       relire une composition client

Relancez ce script si vous deplacez le dossier.
================================================================
"""

import os

import Rhino

HERE = os.path.dirname(os.path.abspath(__file__))

ALIASES = [
    ("PointInsertion",       "cmd_point_insertion.py"),
    ("VerifierBibliotheque", "cmd_verifier.py"),
    ("ExporterBibliotheque", "cmd_exporter.py"),
    ("PublierBibliotheque",  "cmd_publier.py"),
    ("ImporterComposition",  "cmd_importer.py"),
]


def main():
    lst = Rhino.ApplicationSettings.CommandAliasList
    faits, manquants = [], []

    for name, script in ALIASES:
        path = os.path.join(HERE, script)
        if not os.path.exists(path):
            manquants.append(script)
            continue
        macro = '! _-RunPythonScript "%s"' % path
        if lst.IsAlias(name):
            lst.SetMacro(name, macro)
            faits.append((name, "mis a jour"))
        else:
            lst.Add(name, macro)
            faits.append((name, "cree"))

    print("=" * 62)
    print("CONFIGURATEUR 3D — commandes Rhino")
    print("=" * 62)
    for name, etat in faits:
        print("  %-24s %s" % (name, etat))
    for m in manquants:
        print("  !! fichier introuvable : %s" % m)
    print("")
    print("Tapez le nom d'une commande dans la ligne de commande de Rhino.")
    print("Dossier des scripts : %s" % HERE)
    print("")
    print("Workflow :")
    print("  1. PointInsertion        poser les points A / B / C sur la geometrie")
    print("  2. _Block                creer le bloc produit (geometrie + points)")
    print("  3. VerifierBibliotheque  controler noms et connexions")
    print("  4. PublierBibliotheque   envoyer vers GitHub -> le site se met a jour")
    print("=" * 62)


main()
