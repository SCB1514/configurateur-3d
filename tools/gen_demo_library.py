# -*- coding: utf-8 -*-
"""
Genere une bibliotheque de demonstration (data/library.json) au meme
format que l'export Rhino, pour tester le configurateur sans Rhino.

    python tools/gen_demo_library.py

Remplacez ensuite data/library.json par votre propre export
(rhino/export_blocks_to_library.py).
"""

import json
import math
import os

# ---------------------------------------------------------------- geometrie

def box(cx, cy, z0, dx, dy, dz):
    """Boite alignee sur les axes, centree en (cx, cy), base a z0."""
    x0, x1 = cx - dx / 2.0, cx + dx / 2.0
    y0, y1 = cy - dy / 2.0, cy + dy / 2.0
    z1 = z0 + dz
    faces = [
        # (4 sommets, normale)
        ([(x0, y0, z1), (x1, y0, z1), (x1, y1, z1), (x0, y1, z1)], (0, 0, 1)),
        ([(x0, y1, z0), (x1, y1, z0), (x1, y0, z0), (x0, y0, z0)], (0, 0, -1)),
        ([(x0, y0, z0), (x1, y0, z0), (x1, y0, z1), (x0, y0, z1)], (0, -1, 0)),
        ([(x1, y1, z0), (x0, y1, z0), (x0, y1, z1), (x1, y1, z1)], (0, 1, 0)),
        ([(x0, y1, z0), (x0, y0, z0), (x0, y0, z1), (x0, y1, z1)], (-1, 0, 0)),
        ([(x1, y0, z0), (x1, y1, z0), (x1, y1, z1), (x1, y0, z1)], (1, 0, 0)),
    ]
    pos, nor, idx = [], [], []
    for quad, n in faces:
        b = len(pos) // 3
        for v in quad:
            pos.extend(v)
            nor.extend(n)
        idx.extend([b, b + 1, b + 2, b, b + 2, b + 3])
    return pos, nor, idx


def cylinder(cx, cy, z0, r, h, seg=20):
    pos, nor, idx = [], [], []
    ring_b, ring_t = [], []
    for i in range(seg):
        a = 2 * math.pi * i / seg
        x, y = cx + r * math.cos(a), cy + r * math.sin(a)
        nx, ny = math.cos(a), math.sin(a)
        ring_b.append(len(pos) // 3); pos.extend((x, y, z0)); nor.extend((nx, ny, 0))
        ring_t.append(len(pos) // 3); pos.extend((x, y, z0 + h)); nor.extend((nx, ny, 0))
    for i in range(seg):
        j = (i + 1) % seg
        idx.extend([ring_b[i], ring_b[j], ring_t[j], ring_b[i], ring_t[j], ring_t[i]])
    for z, n, flip in ((z0, (0, 0, -1), True), (z0 + h, (0, 0, 1), False)):
        c = len(pos) // 3
        pos.extend((cx, cy, z)); nor.extend(n)
        first = len(pos) // 3
        for i in range(seg):
            a = 2 * math.pi * i / seg
            pos.extend((cx + r * math.cos(a), cy + r * math.sin(a), z)); nor.extend(n)
        for i in range(seg):
            j = (i + 1) % seg
            tri = [c, first + i, first + j]
            if flip:
                tri = [c, first + j, first + i]
            idx.extend(tri)
    return pos, nor, idx


class Part(object):
    """Accumule des primitives partageant la meme couleur."""

    def __init__(self, color, paintable=False, roughness=0.7, metalness=0.05):
        self.color, self.paintable = color, paintable
        self.roughness, self.metalness = roughness, metalness
        self.pos, self.nor, self.idx = [], [], []

    def add(self, prim):
        p, n, i = prim
        b = len(self.pos) // 3
        self.pos.extend(p); self.nor.extend(n)
        self.idx.extend([k + b for k in i])
        return self

    def json(self):
        d = {"color": self.color, "positions": [round(v, 2) for v in self.pos],
             "normals": [round(v, 3) for v in self.nor], "indices": self.idx,
             "roughness": self.roughness, "metalness": self.metalness}
        if self.paintable:
            d["paintable"] = True
        return d


# ---------------------------------------------------------------- palette
CORPS = "#8d9199"
FACADE = "#e8e6e1"
PLAN = "#3b3f46"
INOX = "#c9ced6"
BOIS = "#b98b52"
POIGNEE = "#2b2f36"
VERRE = "#9fc4d8"

FINITIONS = [
    {"id": "blanc", "name": "Blanc mat", "color": "#eeece7"},
    {"id": "gris", "name": "Gris anthracite", "color": "#4a4f57"},
    {"id": "chene", "name": "Chêne clair", "color": "#c69b63"},
    {"id": "vert", "name": "Vert olive", "color": "#5c6b4a"},
    {"id": "bleu", "name": "Bleu nuit", "color": "#2f3d55"},
]

blocks = []


def pi(kind, pos, direction):
    """Point d'insertion : ce que le script Rhino releve sur les blocs
    nommes « Point d'insertion A / B / C ». L'axe Z pointe vers l'exterieur."""
    return {"type": kind, "name": "Point d'insertion %s" % kind,
            "pos": [round(v, 2) for v in pos], "dir": list(direction)}


def add_block(bid, name, category, price, ref, desc, parts,
              finishes=None, tags=None, connectors=None):
    b = {
        "id": bid, "name": name, "category": category, "price": price,
        "ref": ref, "description": desc, "tags": tags or [],
        "finishes": finishes or [],
        "meshes": [p.json() for p in parts],
    }
    if connectors:
        b["connectors"] = connectors
    blocks.append(b)


def caisson(largeur, hauteur=820, prof=580, plinthe=100, portes=2, poignees=True):
    """Corps + facade(s) + plinthe. Retourne la liste des parties."""
    corps = Part(CORPS)
    facade = Part(FACADE, paintable=True, roughness=0.45)
    detail = Part(POIGNEE, roughness=0.35, metalness=0.6)

    h_corps = hauteur - plinthe
    e = 18
    corps.add(box(0, 0, plinthe, largeur, prof, e))                      # fond bas
    corps.add(box(0, 0, plinthe + h_corps - e, largeur, prof, e))        # dessus
    corps.add(box(-largeur / 2 + e / 2, 0, plinthe, e, prof, h_corps))   # joue gauche
    corps.add(box(largeur / 2 - e / 2, 0, plinthe, e, prof, h_corps))    # joue droite
    corps.add(box(0, prof / 2 - e / 2, plinthe, largeur, e, h_corps))    # dos
    corps.add(box(0, 0, 0, largeur - 60, prof - 80, plinthe))            # plinthe

    l_porte = (largeur - 6 * portes) / float(portes)
    for i in range(portes):
        cx = -largeur / 2 + (i + 0.5) * (largeur / float(portes))
        facade.add(box(cx, -prof / 2 - 9, plinthe + 3, l_porte, 18, h_corps - 6))
        if poignees:
            detail.add(box(cx, -prof / 2 - 24, plinthe + h_corps - 90, l_porte * 0.5, 14, 22))
    return [corps, facade, detail]


# ---------------------------------------------------------------- catalogue
for l in (450, 600, 900):
    add_block("caisson-bas-%d" % l, "Caisson bas %d" % l, "Caissons bas",
              189 + (l - 450) * 0.22, "CB-%d" % l,
              "Caisson bas %dx580x820 mm, 2 portes" % l,
              caisson(l, portes=2 if l >= 600 else 1),
              FINITIONS, ["bas", "rangement"],
              connectors=[
                  pi("A", (-l / 2.0, 0, 410), (-1, 0, 0)),
                  pi("A", (l / 2.0, 0, 410), (1, 0, 0)),
                  pi("B", (0, 0, 820), (0, 0, 1)),
              ])

for l in (600, 900):
    parts = caisson(l, hauteur=700, prof=350, plinthe=0, portes=2)
    add_block("caisson-haut-%d" % l, "Caisson haut %d" % l, "Caissons hauts",
              149 + (l - 600) * 0.2, "CH-%d" % l,
              "Caisson haut %dx350x700 mm" % l, parts, FINITIONS, ["haut", "suspendu"],
              connectors=[
                  pi("C", (-l / 2.0, 0, 350), (-1, 0, 0)),
                  pi("C", (l / 2.0, 0, 350), (1, 0, 0)),
              ])

# colonne four
corps = Part(CORPS)
facade = Part(FACADE, paintable=True, roughness=0.45)
four = Part(INOX, roughness=0.25, metalness=0.85)
verre = Part("#1b1e24", roughness=0.1, metalness=0.3)
corps.add(box(0, 0, 100, 600, 580, 2000 - 100))
facade.add(box(0, -299, 100, 580, 20, 700))
facade.add(box(0, -299, 1500, 580, 20, 400))
four.add(box(0, -300, 850, 596, 24, 600))
verre.add(box(0, -314, 900, 500, 6, 480))
add_block("colonne-four-600", "Colonne four 600", "Colonnes", 899, "CF-600",
          "Colonne 600x580x2000 mm, niche four encastrable",
          [corps, facade, four, verre], FINITIONS, ["four", "colonne"],
          connectors=[pi("A", (-300, 0, 410), (-1, 0, 0)),
                      pi("A", (300, 0, 410), (1, 0, 0))])

# refrigerateur
corps = Part(CORPS)
inox = Part(INOX, roughness=0.28, metalness=0.8)
detail = Part(POIGNEE, roughness=0.3, metalness=0.6)
corps.add(box(0, 0, 0, 600, 600, 1800))
inox.add(box(0, -305, 0, 596, 14, 1200))
inox.add(box(0, -305, 1210, 596, 14, 590))
detail.add(box(250, -318, 900, 30, 22, 260))
detail.add(box(250, -318, 1260, 30, 22, 260))
add_block("refrigerateur-600", "Réfrigérateur 600", "Électroménager", 749, "EL-FR60",
          "Réfrigérateur combiné intégrable 600x600x1800 mm",
          [corps, inox, detail], None, ["froid"],
          connectors=[pi("A", (-300, 0, 410), (-1, 0, 0)),
                      pi("A", (300, 0, 410), (1, 0, 0))])

# plans de travail
for l in (600, 1200, 1800):
    p = Part(PLAN, roughness=0.35)
    p.add(box(0, 0, 0, l, 620, 40))
    add_block("plan-travail-%d" % l, "Plan de travail %d" % l, "Plans de travail",
              79 + l * 0.09, "PT-%d" % l,
              "Plan stratifié %dx620x40 mm" % l, [p],
              [{"id": "noir", "name": "Noir", "color": "#2c3036"},
               {"id": "beton", "name": "Béton", "color": "#9aa0a6"},
               {"id": "marbre", "name": "Marbre", "color": "#efeee9"},
               {"id": "noyer", "name": "Noyer", "color": "#6b4a2f"}],
              ["plan"],
              connectors=[
                  pi("B", (0, 0, 0), (0, 0, -1)),
                  pi("D", (-l / 2.0, 0, 20), (-1, 0, 0)),
                  pi("D", (l / 2.0, 0, 20), (1, 0, 0)),
              ])
    blocks[-1]["meshes"][0]["paintable"] = True

# evier
corps = Part(PLAN, roughness=0.35)
cuve = Part(INOX, roughness=0.2, metalness=0.9)
corps.add(box(0, 0, 0, 900, 620, 40))
cuve.add(box(-160, -30, -160, 420, 400, 160))
cuve.add(cylinder(260, -60, 40, 22, 260))
cuve.add(cylinder(260, -60, 290, 18, 140))
add_block("evier-900", "Module évier 900", "Plans de travail", 329, "EV-900",
          "Plan 900 mm avec cuve inox et mitigeur", [corps, cuve], None, ["eau"],
          connectors=[pi("B", (0, 0, 0), (0, 0, -1)),
                      pi("D", (-450, 0, 20), (-1, 0, 0)),
                      pi("D", (450, 0, 20), (1, 0, 0))])

# etagere murale
for l in (900, 1200):
    p = Part(BOIS, roughness=0.6)
    eq = Part(POIGNEE, roughness=0.4, metalness=0.5)
    p.add(box(0, 0, 0, l, 260, 40))
    eq.add(box(-l / 2 + 120, 60, -180, 24, 24, 180))
    eq.add(box(l / 2 - 120, 60, -180, 24, 24, 180))
    add_block("etagere-%d" % l, "Étagère murale %d" % l, "Étagères", 69 + l * 0.03,
              "ET-%d" % l, "Étagère chêne %dx260x40 mm" % l, [p, eq],
              [{"id": "chene", "name": "Chêne", "color": "#b98b52"},
               {"id": "noyer", "name": "Noyer", "color": "#6b4a2f"},
               {"id": "noir", "name": "Noir", "color": "#33373d"}], ["mural"],
              connectors=[pi("C", (-l / 2.0, 0, 20), (-1, 0, 0)),
                          pi("C", (l / 2.0, 0, 20), (1, 0, 0))])
    blocks[-1]["meshes"][0]["paintable"] = True

# ilot
corps = Part(CORPS)
facade = Part(FACADE, paintable=True, roughness=0.45)
plan = Part(PLAN, roughness=0.3)
corps.add(box(0, 0, 100, 1600, 900, 720))
for i in range(4):
    facade.add(box(-600 + i * 400, -452, 110, 380, 20, 700))
plan.add(box(0, 0, 820, 1700, 1000, 45))
add_block("ilot-1600", "Îlot central 1600", "Îlots", 1490, "IL-1600",
          "Îlot 1600x900 mm, plan débordant", [corps, facade, plan], FINITIONS, ["ilot"],
          connectors=[pi("A", (-800, 0, 410), (-1, 0, 0)),
                      pi("A", (800, 0, 410), (1, 0, 0))])

# tabouret
assise = Part(BOIS, roughness=0.55)
pied = Part(POIGNEE, roughness=0.3, metalness=0.7)
assise.add(cylinder(0, 0, 640, 170, 45))
for a in (45, 135, 225, 315):
    x = 130 * math.cos(math.radians(a))
    y = 130 * math.sin(math.radians(a))
    pied.add(cylinder(x, y, 0, 14, 640))
pied.add(cylinder(0, 0, 200, 150, 14))
add_block("tabouret", "Tabouret de bar", "Assises", 129, "TB-01",
          "Tabouret H 685 mm, assise chêne", [assise, pied],
          [{"id": "chene", "name": "Chêne", "color": "#b98b52"},
           {"id": "noir", "name": "Noir", "color": "#2b2f36"},
           {"id": "creme", "name": "Crème", "color": "#e6dfd2"}], ["assise"])
blocks[-1]["meshes"][0]["paintable"] = True

# hotte
h = Part(INOX, roughness=0.25, metalness=0.85)
h.add(box(0, 0, 0, 900, 500, 120))
h.add(box(0, 100, 120, 260, 260, 700))
add_block("hotte-900", "Hotte 900", "Électroménager", 459, "EL-HT90",
          "Hotte décorative 900 mm", [h], None, ["aspiration"],
          connectors=[pi("C", (-450, 0, 60), (-1, 0, 0)),
                      pi("C", (450, 0, 60), (1, 0, 0))])

# cloison vitree
v = Part(VERRE, roughness=0.08, metalness=0.1)
cadre = Part(POIGNEE, roughness=0.35, metalness=0.6)
v.add(box(0, 0, 60, 1180, 20, 1940))
for x in (-600, -200, 200, 600):
    cadre.add(box(x, 0, 0, 40, 40, 2060))
cadre.add(box(0, 0, 0, 1240, 40, 60))
cadre.add(box(0, 0, 2000, 1240, 40, 60))
blocks_glass = [cadre, v]
add_block("verriere-1200", "Verrière 1200", "Cloisons", 690, "VR-1200",
          "Verrière atelier 1200x2060 mm", blocks_glass, None, ["separation"],
          connectors=[pi("E", (-620, 0, 1030), (-1, 0, 0)),
                      pi("E", (620, 0, 1030), (1, 0, 0))])
blocks[-1]["meshes"][1]["opacity"] = 0.35

# ---------------------------------------------------------------- ecriture
categories, seen = [], set()
for b in blocks:
    if b["category"] not in seen:
        seen.add(b["category"])
        categories.append({"id": b["category"], "name": b["category"]})

library = {
    "name": u"Cuisine modulaire — démo",
    "units": "mm",
    "currency": u"€",
    "priceEnabled": True,
    "gridStep": 50,
    "categories": categories,
    "connectorTypes": [
        {"id": "A", "name": "A — liaison latérale (meubles bas)"},
        {"id": "B", "name": "B — plan de travail sur caisson"},
        {"id": "C", "name": "C — liaison latérale (éléments hauts)"},
        {"id": "D", "name": "D — plans de travail bout à bout"},
        {"id": "E", "name": "E — verrières"},
    ],
    "blocks": blocks,
}

here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = os.path.join(here, "data", "library.json")
if not os.path.isdir(os.path.dirname(out)):
    os.makedirs(os.path.dirname(out))
with open(out, "w", encoding="utf-8") as f:
    json.dump(library, f, ensure_ascii=False, separators=(",", ":"))

nv = sum(len(m["positions"]) for b in blocks for m in b["meshes"]) // 3
print("%d blocs, %d sommets -> %s (%.0f Ko)"
      % (len(blocks), nv, out, os.path.getsize(out) / 1024.0))
