# -*- coding: utf-8 -*-
"""
================================================================
 IMPORTER UNE COMPOSITION   (commande : ImporterComposition)
================================================================
Lit le fichier "...-composition.json" exporte par le configurateur
(bouton JSON) et repose les instances de blocs dans le document :
position, rotation Z, echelle, a l'identique.

Le document doit contenir les memes definitions de blocs que
celles ayant servi a publier la bibliotheque.
================================================================
"""

import codecs
import json
import math
import os
import sys

import Rhino
import rhinoscriptsyntax as rs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import configurateur_lib as lib

try:
    reload(lib)
except NameError:
    import importlib
    importlib.reload(lib)

TARGET_LAYER = u"Configuration importée"
UNIT_TO_M = {"mm": 0.001, "cm": 0.01, "m": 1.0, "in": 0.0254, "ft": 0.3048}
EMPTY_GUID = "00000000-0000-0000-0000-000000000000"


def ensure_layer(doc, name):
    idx = doc.Layers.FindByFullPath(name, -1)
    if idx >= 0:
        return idx
    layer = Rhino.DocObjects.Layer()
    layer.Name = name
    try:
        import System.Drawing
        layer.Color = System.Drawing.Color.FromArgb(61, 139, 255)
    except Exception:
        pass
    return doc.Layers.Add(layer)


def main():
    doc = lib.doc_of()
    path = rs.OpenFileName("Composition du configurateur", "JSON (*.json)|*.json||")
    if not path:
        return

    f = codecs.open(path, "r", "utf-8")
    data = json.load(f)
    f.close()

    items = data.get("items") or []
    if not items:
        print("Ce fichier ne contient aucun element."); return

    src_unit = (data.get("units") or "m").lower()
    scale = UNIT_TO_M.get(src_unit, 1.0) / UNIT_TO_M.get(lib.unit_name(doc), 1.0)

    by_name = {}
    for idef in doc.InstanceDefinitions:
        if idef.IsDeleted:
            continue
        by_name[(idef.Name or "").strip().lower()] = idef
        by_name[lib.slugify(idef.Name or "")] = idef

    layer_idx = ensure_layer(doc, TARGET_LAYER)
    placed, missing = 0, {}

    for it in items:
        key = (it.get("block") or "").strip().lower()
        idef = by_name.get(key) or by_name.get(lib.slugify(it.get("blockId") or ""))
        if not idef:
            label = it.get("block") or it.get("blockId") or "?"
            missing[label] = missing.get(label, 0) + 1
            continue

        p = it.get("position") or [0, 0, 0]
        rot = float(it.get("rotationZ") or 0.0)
        s = float(it.get("scale") or 1.0)

        xf = Rhino.Geometry.Transform.Translation(p[0] * scale, p[1] * scale, p[2] * scale)
        if abs(rot) > 1e-9:
            xf = xf * Rhino.Geometry.Transform.Rotation(
                math.radians(rot), Rhino.Geometry.Vector3d.ZAxis,
                Rhino.Geometry.Point3d.Origin)
        if abs(s - 1.0) > 1e-9:
            xf = xf * Rhino.Geometry.Transform.Scale(Rhino.Geometry.Point3d.Origin, s)

        attr = Rhino.DocObjects.ObjectAttributes()
        attr.LayerIndex = layer_idx
        if it.get("finish"):
            attr.SetUserString("finition", str(it["finish"]))
        gid = doc.Objects.AddInstanceObject(idef.Index, xf, attr)
        if str(gid) != EMPTY_GUID:
            placed += 1

    doc.Views.Redraw()
    print("=" * 60)
    print(u"%d instances posees sur le calque « %s »." % (placed, TARGET_LAYER))
    if missing:
        print("Definitions absentes du document :")
        for k, n in missing.items():
            print("   - %s (x%d)" % (k, n))
    if data.get("shareUrl"):
        print("Lien de la configuration : %s" % data["shareUrl"])
    print("=" * 60)


main()
