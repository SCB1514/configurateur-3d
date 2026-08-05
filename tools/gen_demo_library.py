# -*- coding: utf-8 -*-
"""
Genere la bibliotheque de demonstration (data/library.json) : un plateau
d'equipements de musculation, au meme format que l'export du plug-in Rhino.

    python tools/gen_demo_library.py

Elle sert a montrer le configurateur avant d'y publier le vrai catalogue.
Depuis Rhino : commande PFPublication -> Publier en ligne.
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


def slab(cx, cy, z0, dx, dy, dz, tilt=0.0):
    """Plaque inclinee autour de l'axe X : assises et dossiers."""
    pos, nor, idx = box(cx, cy, z0, dx, dy, dz)
    if abs(tilt) < 1e-9:
        return pos, nor, idx
    a = math.radians(tilt)
    ca, sa = math.cos(a), math.sin(a)
    out_p, out_n = [], []
    for i in range(0, len(pos), 3):
        x, y, z = pos[i], pos[i + 1], pos[i + 2]
        y0, z0r = y - cy, z - z0
        out_p.extend((x, cy + y0 * ca - z0r * sa, z0 + y0 * sa + z0r * ca))
        nx, ny, nz = nor[i], nor[i + 1], nor[i + 2]
        out_n.extend((nx, ny * ca - nz * sa, ny * sa + nz * ca))
    return out_p, out_n, idx


def cylinder(cx, cy, z0, r, h, seg=16, axis="z"):
    pos, nor, idx = [], [], []
    ring_b, ring_t = [], []

    def put(x, y, z, nx, ny, nz):
        if axis == "z":
            pos.extend((x, y, z)); nor.extend((nx, ny, nz))
        elif axis == "x":
            pos.extend((z, y, x)); nor.extend((nz, ny, nx))
        else:
            pos.extend((x, z, y)); nor.extend((nx, nz, ny))
        return len(pos) // 3 - 1

    for i in range(seg):
        a = 2 * math.pi * i / seg
        x, y = cx + r * math.cos(a), cy + r * math.sin(a)
        nx, ny = math.cos(a), math.sin(a)
        ring_b.append(put(x, y, z0, nx, ny, 0))
        ring_t.append(put(x, y, z0 + h, nx, ny, 0))
    for i in range(seg):
        j = (i + 1) % seg
        idx.extend([ring_b[i], ring_b[j], ring_t[j], ring_b[i], ring_t[j], ring_t[i]])

    for z, n, flip in ((z0, (0, 0, -1), True), (z0 + h, (0, 0, 1), False)):
        c = put(cx, cy, z, n[0], n[1], n[2])
        first = len(pos) // 3
        for i in range(seg):
            a = 2 * math.pi * i / seg
            put(cx + r * math.cos(a), cy + r * math.sin(a), z, n[0], n[1], n[2])
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
        d = {"color": self.color, "positions": [round(v, 1) for v in self.pos],
             "normals": [round(v, 3) for v in self.nor], "indices": self.idx,
             "roughness": self.roughness, "metalness": self.metalness}
        if self.paintable:
            d["paintable"] = True
        return d


# ---------------------------------------------------------------- palette
CHASSIS = "#2C3038"        # chassis noir : ne change jamais
CAPOT = "#5B2D8E"          # capotage : c'est lui qui suit la variante
GARNISSAGE = "#1E2126"     # mousses
ACIER = "#C9CED6"
FONTE = "#3A3F47"
ECRAN = "#101319"
CAOUTCHOUC = "#22252B"
JAUNE = "#F2C500"

COLORIS = [
    {"id": "violet", "name": "Violet", "color": "#5B2D8E"},
    {"id": "jaune", "name": "Jaune", "color": "#F2C500"},
    {"id": "noir", "name": "Noir mat", "color": "#2A2D33"},
    {"id": "gris", "name": "Gris acier", "color": "#8A9099"},
    {"id": "rouge", "name": "Rouge", "color": "#C4302B"},
]

blocks = []


def pi(kind, pos, direction):
    """Point d'insertion : ce que le plug-in releve sur les blocs nommes
    « Point d'insertion A / B / C »."""
    return {"type": kind, "name": "Point d'insertion %s" % kind,
            "pos": [round(v, 1) for v in pos], "dir": list(direction)}


def add(bid, name, category, price, ref, desc, parts, connectors=None,
        coloris=True, tags=None):
    b = {
        "id": bid, "name": name, "category": category, "price": price,
        "ref": ref, "description": desc, "tags": tags or [],
        "finishes": COLORIS if coloris else [],
        "meshes": [p.json() for p in parts],
    }
    if connectors:
        b["connectors"] = connectors
    blocks.append(b)


# ---------------------------------------------------------------- fabriques

def socle(l, p, h=120):
    """Chassis bas d'une machine."""
    part = Part(CHASSIS)
    part.add(box(0, 0, 0, l, p, h))
    part.add(box(0, 0, h, l - 120, p - 120, 40))
    return part


def colonne_poids(x, hauteur=1200):
    """Colonne de charges guidees."""
    montant = Part(CHASSIS)
    fonte = Part(FONTE, roughness=0.55)
    montant.add(box(x, 0, 120, 40, 320, hauteur))
    montant.add(box(x - 130, 0, 120, 40, 320, hauteur))
    for i in range(10):
        fonte.add(box(x - 65, 0, 180 + i * 55, 220, 280, 45))
    return montant, fonte


# ---------------------------------------------------------------- catalogue

# ---- CARDIO -----------------------------------------------------------
chassis = socle(1900, 900, 180)
capot = Part(CAPOT, paintable=True, roughness=0.45)
tapis = Part(CAOUTCHOUC, roughness=0.85)
ecran = Part(ECRAN, roughness=0.2, metalness=0.4)
acier = Part(ACIER, roughness=0.3, metalness=0.7)
tapis.add(box(0, 0, 220, 1500, 520, 30))
capot.add(box(-820, 0, 180, 260, 880, 260))
acier.add(box(-620, -420, 220, 60, 60, 1200))
acier.add(box(-620, 420, 220, 60, 60, 1200))
acier.add(box(-620, 0, 1380, 60, 900, 60))
ecran.add(box(-660, 0, 1120, 40, 620, 400))
add("tapis-course", "Tapis de course", "Cardio", 4290, "PF-TC-01",
    "Tapis 1900 × 900 mm, écran tactile, inclinaison motorisée",
    [chassis, capot, tapis, ecran, acier],
    [pi("A", (-950, 0, 400), (-1, 0, 0)), pi("A", (950, 0, 400), (1, 0, 0))],
    tags=["cardio", "course"])

chassis = socle(1300, 700, 140)
capot = Part(CAPOT, paintable=True, roughness=0.45)
selle = Part(GARNISSAGE, roughness=0.85)
acier = Part(ACIER, roughness=0.3, metalness=0.7)
ecran = Part(ECRAN, roughness=0.2, metalness=0.4)
capot.add(box(-380, 0, 140, 420, 620, 700))
acier.add(cylinder(-380, 0, 840, 26, 380))
ecran.add(box(-380, 0, 1180, 40, 460, 320))
acier.add(box(300, 0, 140, 60, 60, 620))
selle.add(box(300, 0, 760, 320, 260, 90))
selle.add(slab(430, 0, 700, 90, 300, 420, 18))
acier.add(cylinder(-330, -230, 420, 22, 140, axis="y"))
acier.add(cylinder(-330, 230, 420, 22, 140, axis="y"))
add("velo-assis", "Vélo assis", "Cardio", 2390, "PF-VA-02",
    "Vélo semi-allongé, dossier réglable, écran 10 pouces",
    [chassis, capot, selle, acier, ecran],
    [pi("A", (-700, 0, 400), (-1, 0, 0)), pi("A", (700, 0, 400), (1, 0, 0))],
    tags=["cardio", "velo"])

chassis = socle(2200, 600, 120)
capot = Part(CAPOT, paintable=True, roughness=0.45)
acier = Part(ACIER, roughness=0.3, metalness=0.7)
selle = Part(GARNISSAGE, roughness=0.85)
acier.add(box(0, 0, 200, 1900, 90, 90))
selle.add(box(-300, 0, 300, 380, 300, 80))
capot.add(box(880, 0, 120, 320, 520, 480))
acier.add(box(-980, 0, 160, 120, 620, 200))
add("rameur", "Rameur", "Cardio", 1890, "PF-RA-03",
    "Rameur à résistance air, rail 2200 mm",
    [chassis, capot, acier, selle],
    [pi("A", (-1150, 0, 300), (-1, 0, 0)), pi("A", (1150, 0, 300), (1, 0, 0))],
    tags=["cardio", "rameur"])

# ---- MUSCULATION GUIDEE ----------------------------------------------
chassis = socle(1500, 1200, 140)
capot = Part(CAPOT, paintable=True, roughness=0.45)
mousse = Part(GARNISSAGE, roughness=0.85)
montant, fonte = colonne_poids(560)
capot.add(box(-420, 0, 180, 480, 700, 420))
mousse.add(slab(-380, 0, 600, 460, 520, 90, 8))
mousse.add(slab(-120, 0, 600, 120, 520, 620, -75))
mousse.add(box(-620, -260, 700, 260, 120, 120))
mousse.add(box(-620, 260, 700, 260, 120, 120))
add("presse-cuisses", "Presse à cuisses", "Musculation guidée", 3450, "PF-PC-10",
    "Presse assise, charge guidée 100 kg, dossier réglable",
    [chassis, capot, mousse, montant, fonte],
    [pi("A", (-780, 0, 500), (-1, 0, 0)), pi("A", (780, 0, 500), (1, 0, 0)),
     pi("B", (0, 620, 500), (0, 1, 0))],
    tags=["jambes", "guide"])

chassis = socle(1200, 1100, 140)
capot = Part(CAPOT, paintable=True, roughness=0.45)
mousse = Part(GARNISSAGE, roughness=0.85)
acier = Part(ACIER, roughness=0.3, metalness=0.7)
montant, fonte = colonne_poids(420)
capot.add(box(-300, 0, 180, 380, 640, 380))
mousse.add(box(-300, 0, 560, 420, 460, 90))
mousse.add(box(-120, 0, 700, 140, 420, 180))
acier.add(box(-260, 0, 160, 70, 70, 1900))
acier.add(box(-260, 0, 2060, 900, 70, 70))
acier.add(cylinder(150, 0, 1900, 24, 620, axis="y"))
add("tirage-vertical", "Tirage vertical", "Musculation guidée", 3190, "PF-TV-11",
    "Poulie haute, barre 1200 mm, charge guidée 90 kg",
    [chassis, capot, mousse, acier, montant, fonte],
    [pi("A", (-620, 0, 500), (-1, 0, 0)), pi("A", (620, 0, 500), (1, 0, 0)),
     pi("B", (0, 580, 500), (0, 1, 0))],
    tags=["dos", "guide"])

chassis = socle(1400, 1300, 140)
capot = Part(CAPOT, paintable=True, roughness=0.45)
mousse = Part(GARNISSAGE, roughness=0.85)
montant, fonte = colonne_poids(520)
capot.add(box(-380, 0, 180, 420, 760, 400))
mousse.add(slab(-340, 0, 580, 440, 540, 90, 6))
mousse.add(slab(-100, 0, 580, 120, 540, 560, -70))
capot.add(box(-560, -420, 900, 160, 200, 420))
capot.add(box(-560, 420, 900, 160, 200, 420))
add("butterfly", "Pectoraux butterfly", "Musculation guidée", 2980, "PF-BF-12",
    "Poste pectoraux, bras convergents, charge guidée 80 kg",
    [chassis, capot, mousse, montant, fonte],
    [pi("A", (-720, 0, 500), (-1, 0, 0)), pi("A", (720, 0, 500), (1, 0, 0)),
     pi("B", (0, 680, 500), (0, 1, 0))],
    tags=["pectoraux", "guide"])

# ---- POIDS LIBRES ----------------------------------------------------
chassis = Part(CHASSIS)
capot = Part(CAPOT, paintable=True, roughness=0.45)
mousse = Part(GARNISSAGE, roughness=0.85)
acier = Part(ACIER, roughness=0.28, metalness=0.75)
fonte = Part(FONTE, roughness=0.55)
for x in (-700, 700):
    for y in (-600, 600):
        chassis.add(box(x, y, 0, 110, 110, 2400))
chassis.add(box(0, -600, 2400, 1500, 110, 110))
chassis.add(box(0, 600, 2400, 1500, 110, 110))
chassis.add(box(0, 0, 0, 1620, 1320, 90))
capot.add(box(-700, -600, 1500, 130, 130, 240))
capot.add(box(700, -600, 1500, 130, 130, 240))
acier.add(cylinder(0, -600, 1560, 25, 2200, axis="x"))
fonte.add(cylinder(-950, -600, 1560, 225, 60, axis="x"))
fonte.add(cylinder(950, -600, 1560, 225, 60, axis="x"))
mousse.add(box(0, 200, 90, 1300, 340, 480))
add("rack-squat", "Rack à squat", "Poids libres", 2650, "PF-RS-20",
    "Cage 1600 × 1300 mm, barre olympique, plateforme intégrée",
    [chassis, capot, mousse, acier, fonte],
    [pi("A", (-810, 0, 1200), (-1, 0, 0)), pi("A", (810, 0, 1200), (1, 0, 0))],
    tags=["squat", "libre"])

chassis = socle(1300, 700, 120)
mousse = Part(GARNISSAGE, roughness=0.85)
capot = Part(CAPOT, paintable=True, roughness=0.45)
mousse.add(box(-150, 0, 260, 900, 300, 110))
mousse.add(slab(500, 0, 260, 400, 300, 420, 55))
capot.add(box(-560, 0, 120, 180, 420, 200))
add("banc-reglable", "Banc réglable", "Poids libres", 690, "PF-BR-21",
    "Banc inclinable 0 à 80°, assise 300 mm",
    [chassis, mousse, capot],
    [pi("A", (-700, 0, 300), (-1, 0, 0)), pi("A", (700, 0, 300), (1, 0, 0))],
    tags=["banc", "libre"])

chassis = Part(CHASSIS)
capot = Part(CAPOT, paintable=True, roughness=0.45)
fonte = Part(FONTE, roughness=0.55)
chassis.add(box(0, 0, 0, 2000, 600, 120))
chassis.add(box(0, 220, 120, 2000, 160, 700))
capot.add(box(0, 0, 820, 2000, 600, 70))
for i in range(8):
    x = -820 + i * 235
    fonte.add(cylinder(x, -120, 250, 105, 130, axis="z"))
    fonte.add(cylinder(x, -120, 900, 85, 110, axis="z"))
add("rack-halteres", "Support d'haltères", "Poids libres", 980, "PF-RH-22",
    "Râtelier deux niveaux, 2000 mm, 8 paires",
    [chassis, capot, fonte],
    [pi("A", (-1010, 0, 400), (-1, 0, 0)), pi("A", (1010, 0, 400), (1, 0, 0))],
    tags=["halteres", "rangement"])

# ---- FONCTIONNEL -----------------------------------------------------
chassis = Part(CHASSIS)
capot = Part(CAPOT, paintable=True, roughness=0.45)
acier = Part(ACIER, roughness=0.3, metalness=0.7)
for x in (-1200, 1200):
    chassis.add(box(x, 0, 0, 130, 900, 2500))
chassis.add(box(0, -380, 2500, 2530, 130, 130))
chassis.add(box(0, 380, 2500, 2530, 130, 130))
acier.add(cylinder(0, 0, 2400, 28, 2400, axis="x"))
capot.add(box(-1200, -380, 1400, 150, 150, 700))
capot.add(box(1200, -380, 1400, 150, 150, 700))
for i in range(5):
    acier.add(cylinder(-800 + i * 400, -380, 1900, 18, 260, axis="y"))
add("cage-fonctionnelle", "Cage fonctionnelle", "Fonctionnel", 5490, "PF-CF-30",
    "Structure 2500 × 900 mm, poulies réglables, barre de traction",
    [chassis, capot, acier],
    [pi("A", (-1330, 0, 1250), (-1, 0, 0)), pi("A", (1330, 0, 1250), (1, 0, 0))],
    tags=["fonctionnel", "poulies"])

tapis = Part(CAOUTCHOUC, roughness=0.9)
bande = Part(CAPOT, paintable=True, roughness=0.7)
tapis.add(box(0, 0, 0, 2000, 1000, 30))
bande.add(box(0, -470, 30, 2000, 60, 4))
bande.add(box(0, 470, 30, 2000, 60, 4))
add("tapis-sol", "Tapis de sol 2 × 1 m", "Fonctionnel", 240, "PF-TS-31",
    "Dalle amortissante 2000 × 1000 × 30 mm",
    [tapis, bande],
    [pi("A", (-1000, 0, 15), (-1, 0, 0)), pi("A", (1000, 0, 15), (1, 0, 0)),
     pi("B", (0, -500, 15), (0, -1, 0)), pi("B", (0, 500, 15), (0, 1, 0))],
    tags=["sol"])

# ---- SERVICES --------------------------------------------------------
corps = Part(CHASSIS)
portes = Part(CAPOT, paintable=True, roughness=0.45)
detail = Part(ACIER, roughness=0.35, metalness=0.6)
corps.add(box(0, 0, 0, 900, 500, 1800))
for i in range(3):
    for j in range(2):
        portes.add(box(-220 + j * 440, -255, 60 + i * 580, 420, 20, 540))
        detail.add(box(-40 + j * 440, -270, 300 + i * 580, 40, 16, 60))
add("casiers", "Colonne de casiers", "Services", 780, "PF-CA-40",
    "Six casiers, 900 × 500 × 1800 mm",
    [corps, portes, detail],
    [pi("A", (-450, 0, 900), (-1, 0, 0)), pi("A", (450, 0, 900), (1, 0, 0))],
    tags=["vestiaire"])

corps = Part(CHASSIS)
capot = Part(CAPOT, paintable=True, roughness=0.45)
detail = Part(ACIER, roughness=0.3, metalness=0.7)
corps.add(box(0, 0, 0, 600, 500, 1100))
capot.add(box(0, -255, 700, 560, 20, 360))
detail.add(box(0, -270, 400, 200, 30, 120))
detail.add(box(0, 0, 1100, 640, 540, 60))
add("fontaine", "Fontaine à eau", "Services", 1290, "PF-FE-41",
    "Distributeur réfrigéré, remplissage gourde",
    [corps, capot, detail],
    [pi("A", (-300, 0, 550), (-1, 0, 0)), pi("A", (300, 0, 550), (1, 0, 0))],
    tags=["eau"])

# ---------------------------------------------------------------- dispositions

def rangee(bloc, x0, y, n, pas, rot=0):
    return [{"blockId": bloc, "pos": [x0 + i * pas, y, 0], "rot": rot} for i in range(n)]


presets = [
    {
        "id": "cardio",
        "name": "Plateau cardio",
        "description": "Ligne de cardio adossée, 9 postes",
        "featured": True,
        "items": rangee("tapis-course", -2000, -1500, 3, 2000)
              + rangee("velo-assis", -1500, 500, 3, 1500)
              + rangee("rameur", -2400, 2400, 3, 2400),
    },
    {
        "id": "guidee",
        "name": "Circuit guidé",
        "description": "Six machines à charge guidée en vis-à-vis",
        "items": rangee("presse-cuisses", -1600, -1200, 2, 1600)
              + rangee("tirage-vertical", -1400, 400, 2, 1400)
              + rangee("butterfly", -1500, 2000, 2, 1500),
    },
    {
        "id": "libre",
        "name": "Zone poids libres",
        "description": "Racks, bancs et haltères",
        "items": rangee("rack-squat", -2000, -1200, 2, 2200)
              + rangee("banc-reglable", -1500, 600, 3, 1500)
              + rangee("rack-halteres", 0, 2200, 1, 0),
    },
    {
        "id": "club-complet",
        "name": "Club complet 300 m²",
        "description": "Implantation type : cardio, guidé, libre et services",
        "featured": True,
        "items": rangee("tapis-course", -4000, -3000, 3, 2000)
              + rangee("velo-assis", 2000, -3000, 2, 1500)
              + rangee("presse-cuisses", -4000, -800, 2, 1600)
              + rangee("tirage-vertical", -400, -800, 2, 1400)
              + rangee("butterfly", 2600, -800, 1, 0)
              + rangee("rack-squat", -3800, 1400, 2, 2200)
              + rangee("banc-reglable", 400, 1400, 2, 1500)
              + rangee("rack-halteres", 3000, 1400, 1, 0)
              + rangee("cage-fonctionnelle", -2000, 3600, 1, 0)
              + rangee("tapis-sol", 1500, 3600, 2, 2100)
              + rangee("casiers", -4200, 5200, 2, 950)
              + rangee("fontaine", 0, 5200, 1, 0),
    },
]

# ---------------------------------------------------------------- ecriture
categories, seen = [], set()
for b in blocks:
    if b["category"] not in seen:
        seen.add(b["category"])
        categories.append({"id": b["category"], "name": b["category"]})

library = {
    "name": u"Configurateur Planet Fitness Pro — démo",
    "units": "mm",
    "currency": u"€",
    "priceEnabled": True,
    "gridStep": 100,
    "categories": categories,
    "connectorTypes": [
        {"id": "A", "name": "A — alignement latéral"},
        {"id": "B", "name": "B — adossement"},
    ],
    "presets": presets,
    "blocks": blocks,
}

here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out = os.path.join(here, "data", "library.json")
if not os.path.isdir(os.path.dirname(out)):
    os.makedirs(os.path.dirname(out))
with open(out, "w", encoding="utf-8") as f:
    json.dump(library, f, ensure_ascii=False, separators=(",", ":"))

nv = sum(len(m["positions"]) for b in blocks for m in b["meshes"]) // 3
print("%d equipements, %d dispositions, %d sommets -> %s (%.0f Ko)"
      % (len(blocks), len(presets), nv, out, os.path.getsize(out) / 1024.0))
