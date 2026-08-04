# -*- coding: utf-8 -*-
"""
================================================================
 POSER UN POINT D'INSERTION   (commande : PointInsertion)
================================================================
Place dans le document une instance du bloc "Point d'insertion X"
(X = A, B, C...). La definition est creee automatiquement si elle
n'existe pas encore.

Marche a suivre habituelle :
  1. PointInsertion  -> lettre, point, direction (vers l'exterieur)
  2. selectionnez la geometrie du produit + le ou les points poses
  3. _Block  -> vous obtenez un bloc equipe de ses connexions
  4. VerifierBibliotheque, puis PublierBibliotheque

Deux blocs qui portent la meme lettre s'aimantent dans le
configurateur : le point de l'un vient sur le point de l'autre,
les axes Z en vis-a-vis.
================================================================
"""

import os
import sys

import Rhino
import scriptcontext as sc
import rhinoscriptsyntax as rs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import configurateur_lib as lib

try:
    reload(lib)
except NameError:
    import importlib
    importlib.reload(lib)

LAYER = u"Points d'insertion"


def marker_size(doc):
    """Longueur de la fleche, adaptee a l'unite du document."""
    return {"mm": 120.0, "cm": 12.0, "m": 0.12, "in": 5.0, "ft": 0.4}.get(
        lib.unit_name(doc), 0.12)


def ensure_layer(doc):
    idx = doc.Layers.FindByFullPath(LAYER, -1)
    if idx >= 0:
        return idx
    layer = Rhino.DocObjects.Layer()
    layer.Name = LAYER
    try:
        import System.Drawing
        layer.Color = System.Drawing.Color.FromArgb(255, 140, 0)
    except Exception:
        pass
    return doc.Layers.Add(layer)


def ensure_definition(doc, letter):
    """Definition "Point d'insertion X" : un point + une fleche selon +Z."""
    name = u"Point d'insertion %s" % letter
    existing = doc.InstanceDefinitions.Find(name, True)
    if existing:
        return existing.Index, name

    G = Rhino.Geometry
    L = marker_size(doc)
    geo, att = [], []
    layer_idx = ensure_layer(doc)

    def attr():
        a = Rhino.DocObjects.ObjectAttributes()
        a.LayerIndex = layer_idx
        return a

    geo.append(G.Point(G.Point3d.Origin)); att.append(attr())
    geo.append(G.LineCurve(G.Point3d.Origin, G.Point3d(0, 0, L))); att.append(attr())
    # petite fleche : deux segments obliques
    for sx, sy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
        geo.append(G.LineCurve(G.Point3d(0, 0, L),
                               G.Point3d(sx * L * 0.18, sy * L * 0.18, L * 0.75)))
        att.append(attr())
    geo.append(G.ArcCurve(G.Circle(G.Plane.WorldXY, L * 0.12))); att.append(attr())

    idx = doc.InstanceDefinitions.Add(
        name, u"Point d'insertion du configurateur — l'axe Z pointe vers l'exterieur",
        G.Point3d.Origin, geo, att)
    if idx < 0:
        raise Exception(u"Impossible de creer la definition « %s »." % name)
    print(u"Definition creee : %s" % name)
    return idx, name


def main():
    doc = lib.doc_of()
    if doc is None:
        print("Aucun document actif."); return

    # lettres deja utilisees dans le document
    used = sorted(set(t for t in (lib.connector_type(d.Name or "")
                                  for d in doc.InstanceDefinitions if not d.IsDeleted) if t))
    if used:
        print(u"Points d'insertion existants : %s" % ", ".join(used))

    letter = rs.GetString("Lettre du point d'insertion", used[0] if used else "A",
                          used + ["A", "B", "C", "D"] if used else ["A", "B", "C", "D"])
    if not letter:
        return
    letter = str(letter).strip().upper()[:4]
    if not letter.isalnum():
        print("Lettre invalide."); return

    idx, name = ensure_definition(doc, letter)
    L = marker_size(doc)
    posed = 0

    while True:
        pt = rs.GetPoint(u"Point d'insertion %s — position (Entree pour terminer)" % letter)
        if not pt:
            break
        target = rs.GetPoint(u"Direction : vers l'exterieur du bloc (Entree = +Z)", pt)

        G = Rhino.Geometry
        origin = G.Point3d(pt.X, pt.Y, pt.Z)
        if target:
            v = G.Point3d(target.X, target.Y, target.Z) - origin
            if not v.Unitize():
                v = G.Vector3d.ZAxis
        else:
            v = G.Vector3d.ZAxis

        plane = G.Plane(origin, v)          # Z du plan = direction choisie
        xf = G.Transform.PlaneToPlane(G.Plane.WorldXY, plane)

        attr = Rhino.DocObjects.ObjectAttributes()
        attr.LayerIndex = ensure_layer(doc)
        gid = doc.Objects.AddInstanceObject(idx, xf, attr)
        if str(gid) != "00000000-0000-0000-0000-000000000000":
            posed += 1
            print(u"  %s pose en (%.1f, %.1f, %.1f) direction (%.2f, %.2f, %.2f)"
                  % (name, origin.X, origin.Y, origin.Z, v.X, v.Y, v.Z))
        doc.Views.Redraw()

    print("")
    print("=" * 60)
    print(u"%d point(s) « %s » pose(s)." % (posed, name))
    print(u"Selectionnez la geometrie du produit ET ces points, puis _Block.")
    print(u"Controle : VerifierBibliotheque")
    print("=" * 60)


main()
