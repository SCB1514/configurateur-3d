# -*- coding: utf-8 -*-
"""
Genere la bibliotheque « WILDLIFE FITNESS CLUB » : une zone CrossFit / force,
d'apres une description de rendu D5 (rig acier noir, panneaux cibles rouges,
enseigne neon, plateformes bois/caoutchouc, plaques colorees, kettlebells,
porte vitree vers un couloir clair).

    python tools/gen_crossfit.py

Resultat : data/library-crossfit.json (+ textures dans data/textures/).
Les apercus Architextures sont telecharges une fois puis servis en local.
"""

import base64
import io
import json
import math
import os
import urllib.request

from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEX_DIR = os.path.join(HERE, "data", "textures")
OUT = os.path.join(HERE, "data", "library-crossfit.json")

TEXTURES = [
    ("beton-basalte.jpg",
     "https://cdn.architextures.org/materials/9814/original/9814_Lucida-Nero-Basalto-Kellen---Swatch.JPG?s=1200&q=70"),
    ("bois-brule.jpg",
     "https://cdn.architextures.org/textures/25/6/thermal-redwood--shou-sugi-ban--char--brushed--black-staggered-tiny-temple-1no7ha.jpg"),
    ("chene.jpg",
     "https://cdn.architextures.org/textures/20/11/oak-5fc4d0c4081c1-1200.jpg"),
]


def telecharger(nom, url):
    dest = os.path.join(TEX_DIR, nom)
    if os.path.exists(dest) and os.path.getsize(dest) > 1000:
        return dest
    os.makedirs(TEX_DIR, exist_ok=True)
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=60) as r, open(dest, "wb") as f:
        f.write(r.read())
    return dest


# ---------------------------------------------------------------- geometrie

def box(cx, cy, z0, dx, dy, dz):
    """Boite pleine, base a z0, centree en (cx, cy)."""
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


def cylinder(cx, cy, z0, r, h, seg=20, axis="z"):
    """Cylindre plein. L'axe peut etre z, x ou y."""
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


def sphere(cx, cy, cz, r, seg=16, ring=12):
    pos, nor, idx = [], [], []
    for i in range(ring + 1):
        phi = math.pi * i / ring
        for j in range(seg):
            th = 2 * math.pi * j / seg
            x, y = math.sin(phi) * math.cos(th), math.sin(phi) * math.sin(th)
            z = math.cos(phi)
            pos.extend((cx + x * r, cy + y * r, cz + z * r))
            nor.extend((x, y, z))
    for i in range(ring):
        for j in range(seg):
            a = i * seg + j
            b = i * seg + (j + 1) % seg
            c = (i + 1) * seg + j
            d = (i + 1) * seg + (j + 1) % seg
            idx.extend([a, c, d, a, d, b])
    return pos, nor, idx


def quad(a, b, c, d, n):
    """Quadrilatere double face, avec coordonnees de texture pleine image."""
    pos = list(a) + list(b) + list(c) + list(d)
    nor = list(n) * 4
    idx = [0, 1, 2, 0, 2, 3]
    uv = [0, 0, 1, 0, 1, 1, 0, 1]
    return pos, nor, idx, uv


class Builder(object):
    def __init__(self):
        self.meshes = []

    def add(self, nom, prim, couleur, rough=0.7, metal=0.05, opacity=1.0,
            material=None, emissive=None, eint=0, uv=None):
        if len(prim) == 4:
            p, n, i, primuv = prim
            if uv is None:
                uv = primuv
        else:
            p, n, i = prim
        m = {"name": nom,
             "positions": [round(v, 1) for v in p],
             "normals": [round(v, 3) for v in n],
             "indices": i,
             "color": couleur, "roughness": rough, "metalness": metal,
             "opacity": opacity}
        if uv is not None:
            m["uv"] = [round(v, 4) for v in uv]
        if material:
            m["material"] = material
        if emissive:
            m["emissive"] = emissive
            m["emissiveIntensite"] = eint
        self.meshes.append(m)


# ---------------------------------------------------------------- images

def _font(size):
    for p in (r"C:/Windows/Fonts/arialbd.ttf", r"C:/Windows/Fonts/impact.ttf",
              r"C:/Windows/Fonts/segoeuib.ttf", r"C:/Windows/Fonts/arial.ttf"):
        try:
            return ImageFont.truetype(p, size)
        except OSError:
            continue
    return ImageFont.load_default()


def _data_uri(img):
    buf = io.BytesIO()
    img.save(buf, "PNG")
    return "data:image/png;base64," + base64.b64encode(buf.getvalue()).decode("ascii")


def png_neon():
    W, H = 1500, 480
    img = Image.new("RGB", (W, H), (0, 0, 0))
    d = ImageDraw.Draw(img)
    font = _font(118)
    for k, ligne in enumerate(("WILDLIFE", "FITNESS", "CLUB")):
        bb = d.textbbox((0, 0), ligne, font=font)
        w = bb[2] - bb[0]
        d.text(((W - w) / 2, 14 + k * 152), ligne, font=font, fill=(255, 255, 255))
    return _data_uri(img)


def png_cible():
    S = 512
    img = Image.new("RGB", (S, S), (211, 30, 37))
    d = ImageDraw.Draw(img)
    w = 255
    d.rectangle([S * 0.43, S * 0.06, S * 0.57, S * 0.94], fill=w)
    d.rectangle([S * 0.06, S * 0.43, S * 0.94, S * 0.57], fill=w)
    d.ellipse([S * 0.18, S * 0.18, S * 0.82, S * 0.82], outline=w, width=int(S * 0.045))
    return _data_uri(img)


def png_logo():
    W, H = 1000, 200
    img = Image.new("RGB", (W, H), (201, 160, 106))
    d = ImageDraw.Draw(img)
    font = _font(76)
    txt = "WILDLIFE FITNESS CLUB"
    bb = d.textbbox((0, 0), txt, font=font)
    d.text(((W - (bb[2] - bb[0])) / 2, (H - (bb[3] - bb[1])) / 2 - bb[1]),
           txt, font=font, fill=(88, 60, 36))
    return _data_uri(img)


# ---------------------------------------------------------------- palette

ACIER = "#181a1d"
RUBBER = "#16171a"
BLANC = "#ffffff"
PLAQUE = {"jaune": "#e9b10a", "bleu": "#2f6bff", "rouge": "#d31e25", "gris": "#6b7078"}
BALLE = {"noir": "#1b1d20", "gris": "#4a4f57"}
BOIS_POIGNEE = "#7a5a3a"

# ---------------------------------------------------------------- la piece

L, P, H = 12000.0, 8000.0, 4200.0
X0, X1 = -L / 2, L / 2
Y0, Y1 = -P / 2, P / 2


def bloc_sol():
    b = Builder()
    b.add("Sol", quad((X0, Y0, 0), (X1, Y0, 0), (X1, Y1, 0), (X0, Y1, 0), (0, 0, 1))[:3],
          "#ffffff", rough=0.55, material="sol-beton")
    return bloc("sol", "Sol — béton poli", b)


def bloc_mur_fond():
    b = Builder()
    b.add("Mur fond", quad((X0, Y0, 0), (X1, Y0, 0), (X1, Y0, H), (X0, Y0, H), (0, 1, 0))[:3],
          "#ffffff", rough=0.8, material="mur-brule")
    return bloc("mur-fond", "Mur du fond — panneaux noirs", b)


def bloc_mur_lateral(bid, nom, x, n):
    b = Builder()
    if n[0] == 1:   # gauche
        b.add(nom, quad((x, Y0, 0), (x, Y1, 0), (x, Y1, H), (x, Y0, H), (1, 0, 0))[:3],
              "#ffffff", rough=0.8, material="mur-brule")
    else:           # droite
        b.add(nom, quad((x, Y1, 0), (x, Y0, 0), (x, Y0, H), (x, Y1, H), (-1, 0, 0))[:3],
              "#ffffff", rough=0.8, material="mur-brule")
    return bloc(bid, nom, b)


def bloc_plafond():
    b = Builder()
    b.add("Plafond", quad((X0, Y0, H), (X0, Y1, H), (X1, Y1, H), (X1, Y0, H), (0, 0, -1))[:3],
          "#ffffff", rough=0.8, material="mur-brule")
    # bandes lumineuses lineaires encastrees (effet rail)
    for y in (-2200, -700, 800, 2300):
        b.add("Reglette", box(0, y, H - 30, 7800, 120, 12),
              "#ffffff", rough=0.3, emissive="#ffffff", eint=3.0)
    return bloc("plafond", "Plafond — panneaux + réglettes", b)


def bloc_neon():
    b = Builder()
    # panneau de fond sombre, pose juste devant le mur du fond
    b.add("Support", box(0, Y0 + 25, 2880, 4000, 30, 1060), "#0b0b0d", rough=0.45)
    # le texte emissif
    b.add("Texte", quad((-1900, Y0 + 55, 2900), (1900, Y0 + 55, 2900),
                        (1900, Y0 + 55, 3900), (-1900, Y0 + 55, 3900), (0, 1, 0)),
          "#050506", rough=0.3, material="neon", emissive="#ffffff", eint=3.4)
    return bloc("neon", "Enseigne néon WILDLIFE", b)


def bloc_rig():
    b = Builder()
    xp = [-5200, -3600, -2000, -400, 1200, 2800, 4400]
    yr, yf = -3650.0, -3350.0

    # montants arriere (pleine hauteur) et avant
    for x in xp:
        b.add("Montant", box(x, yr, 0, 90, 90, 2600), ACIER, rough=0.35, metal=0.65)
        b.add("Montant", box(x, yf, 0, 90, 90, 2350), ACIER, rough=0.35, metal=0.65)

    # poutres haute et basse (avant + arriere)
    for y in (yr, yf):
        b.add("Poutre haute", box(-400, y, 2520, 9700, 90, 90), ACIER, rough=0.35, metal=0.65)
        b.add("Poutre basse", box(-400, y, 1550, 9700, 60, 60), ACIER, rough=0.35, metal=0.65)

    # entretoises reliant avant et arriere
    for x in xp:
        b.add("Entretoise", box(x, -3500, 2450, 90, 300, 90), ACIER, rough=0.35, metal=0.65)

    # barres de traction (axe x, entre montants avant)
    for cx, ln in ((-2800, 1600), (600, 1600), (3600, 1600)):
        b.add("Barre", cylinder(2250, yf, cx - ln / 2, 26, ln, axis="x"), ACIER, rough=0.4, metal=0.7)

    # --- station de squat a gauche : barre sur verrous J ---
    b.add("J", box(-5200, yf, 1150, 120, 40, 30), ACIER, rough=0.35, metal=0.65)
    b.add("J", box(-3600, yf, 1150, 120, 40, 30), ACIER, rough=0.35, metal=0.65)
    b.add("Barre squat", cylinder(1200, yf, -5330, 24, 1860, axis="x"), ACIER, rough=0.4, metal=0.75)
    for x in (-5330, -3470):
        b.add("Disque", cylinder(1200, yf, x, 240, 60, axis="x"), PLAQUE["gris"], rough=0.6, metal=0.1)

    # --- rayonnage de medecine-balls (droite) ---
    for z in (1150, 1750):
        b.add("Etagere", box(3250, yf, z, 2300, 40, 40), ACIER, rough=0.35, metal=0.65)
    for i in range(5):
        x = 2200 + i * 520
        c = BALLE["gris"] if i % 2 else BALLE["noir"]
        b.add("Medball", sphere(x, yf, 1290, 150), c, rough=0.92, metal=0.0)
        b.add("Medball", sphere(x, yf, 1890, 150), c, rough=0.92, metal=0.0)

    # --- range-plaques verticaux ---
    for x in (1500, 2500):
        b.add("Axe", cylinder(x, yf, 120, 40, 950), ACIER, rough=0.4, metal=0.7)
    palette = ["jaune", "bleu", "rouge", "gris", "gris"]
    for x in (1500, 2500):
        for k, coul in enumerate(palette):
            r = 240 if coul == "gris" else 185
            b.add("Plaque", cylinder(x, yf, 250 + k * 150, r, 55), PLAQUE[coul], rough=0.55, metal=0.1)

    return bloc("rig", "Rig modulaire acier", b)


def bloc_cibles():
    b = Builder()
    # serie de panneaux cibles le long du haut + un grand a gauche
    y = -3240.0
    for x in (-3600, -2000, -400, 1200, 2800, 4400):
        b.add("Cible", quad((x - 300, y, 1750), (x + 300, y, 1750),
                            (x + 300, y, 2380), (x - 300, y, 2380), (0, 1, 0)),
              "#ffffff", rough=0.9, material="cible")
    b.add("Cible grande", quad((-5200 - 450, y, 1700), (-5200 + 450, y, 1700),
                               (-5200 + 450, y, 2600), (-5200 - 450, y, 2600), (0, 1, 0)),
          "#ffffff", rough=0.9, material="cible")
    return bloc("cibles", "Panneaux cibles rouges", b)


def bloc_plateforme():
    b = Builder()
    # caoutchouc noir exterieur + bois au centre
    b.add("Caoutchouc", box(0, 0, 0, 2500, 2500, 70), RUBBER, rough=0.95, metal=0.0)
    b.add("Bois", box(0, 0, 0, 1650, 1650, 78), "#ffffff", rough=0.5, metal=0.0,
          material="bois-chene")
    # logo grave
    b.add("Logo", quad((-500, -130, 80), (500, -130, 80), (500, 130, 80), (-500, 130, 80),
                       (0, 0, 1)), "#ffffff", rough=0.5, material="logo")
    return bloc("plateforme", "Plateforme bois + caoutchouc", b)


def bloc_kettlebell():
    b = Builder()
    b.add("Corps", sphere(0, 0, 170, 160), "#141518", rough=0.7, metal=0.15)
    b.add("Poignee", cylinder(0, 0, 320, 26, 60, axis="z"), "#141518", rough=0.5, metal=0.4)
    b.add("Barre", cylinder(360, 0, -65, 26, 130, axis="x"), "#141518", rough=0.5, metal=0.4)
    return bloc("kettlebell", "Kettlebell", b)


def bloc_porte():
    b = Builder()
    # couloir clair eclaire derriere la porte
    b.add("Couloir", quad((5800, 900, 0), (5800, 2100, 0), (5800, 2100, 2600), (5800, 900, 2600),
                          (-1, 0, 0)), "#ffffff", rough=0.4, emissive="#ffffff", eint=2.6)
    # vitrage
    b.add("Vitre", box(5950, 1500, 0, 30, 1100, 2400), "#d8e8f0", rough=0.06, metal=0.0, opacity=0.28)
    # cadre clair
    b.add("Cadre", box(5950, 1500, 0, 50, 1160, 100), "#c8ccd0", rough=0.4, metal=0.3)
    b.add("Cadre", box(5950, 1500, 2400, 50, 1160, 100), "#c8ccd0", rough=0.4, metal=0.3)
    b.add("Cadre", box(5950, 900, 1200, 50, 100, 2600), "#c8ccd0", rough=0.4, metal=0.3)
    b.add("Cadre", box(5950, 2100, 1200, 50, 100, 2600), "#c8ccd0", rough=0.4, metal=0.3)
    # poignee bois
    b.add("Poignee", box(5990, 2060, 1180, 30, 40, 300), BOIS_POIGNEE, rough=0.45, metal=0.0)
    return bloc("porte", "Porte vitrée — couloir", b)


def bloc(bid, nom, builder):
    return {
        "id": bid, "name": nom, "category": "Architecture",
        "price": 0, "baseOffset": 0, "ref": "", "description": nom,
        "meshes": builder.meshes, "connectors": [],
    }


# ---------------------------------------------------------------- assemblage

def construire():
    for nom, url in TEXTURES:
        telecharger(nom, url)

    materiaux = [
        {"id": "sol-beton", "name": "Béton poli", "color": "#3a3a3d",
         "metalness": 0.05, "roughness": 0.55, "opacity": 1,
         "maps": {"color": {"src": "textures/beton-basalte.jpg"}, "worldSize": 2000}},
        {"id": "mur-brule", "name": "Panneau noir texturé", "color": "#191512",
         "metalness": 0.0, "roughness": 0.8, "opacity": 1,
         "maps": {"color": {"src": "textures/bois-brule.jpg"}, "worldSize": 2200}},
        {"id": "bois-chene", "name": "Chêne", "color": "#c9a06a",
         "metalness": 0.0, "roughness": 0.5, "opacity": 1,
         "maps": {"color": {"src": "textures/chene.jpg"}, "worldSize": 1200}},
        {"id": "cible", "name": "Cible rouge", "color": "#d31e25",
         "metalness": 0.0, "roughness": 0.9, "opacity": 1,
         "maps": {"color": {"src": png_cible()}}},
        {"id": "neon", "name": "Néon", "color": "#0a0a0c",
         "metalness": 0.0, "roughness": 0.3, "opacity": 1,
         "maps": {"emissive": {"src": png_neon()}}},
        {"id": "logo", "name": "Logo", "color": "#c9a06a",
         "metalness": 0.0, "roughness": 0.5, "opacity": 1,
         "maps": {"color": {"src": png_logo()}}},
    ]

    blocs = [bloc_sol(), bloc_mur_fond(),
             bloc_mur_lateral("mur-gauche", "Mur gauche", X0, (1, 0, 0)),
             bloc_mur_lateral("mur-droite", "Mur droit", X1, (-1, 0, 0)),
             bloc_plafond(), bloc_rig(), bloc_cibles(), bloc_neon(),
             bloc_plateforme(), bloc_kettlebell(), bloc_porte()]

    def machine(bid, x, y, z=0, rot=0):
        return {"blockId": bid, "pos": [x, y, z], "rot": rot}

    items = [
        machine("sol", 0, 0),
        machine("mur-gauche", 0, 0), machine("mur-droite", 0, 0),
        machine("rig", 0, 0), machine("cibles", 0, 0), machine("neon", 0, 0),
        # trois plateformes en profondeur
        machine("plateforme", -3500, -400),
        machine("plateforme", -700, 1200),
        machine("plateforme", 2600, 2600),
        # deux kettlebells au premier plan a droite
        machine("kettlebell", 4300, 3200),
        machine("kettlebell", 5000, 3400),
        # porte vitree sur le mur droit
        machine("porte", 0, 0),
        # eclairage sur rail
        machine("bandeau-led-2000", 0, -1800),
        machine("bandeau-led-2000", 0, 1200),
        machine("spot-rail", -3000, -2000),
        machine("spot-rail", 0, -2000),
        machine("spot-rail", 3000, -2000),
        machine("spot-encastre", -1200, 800),
        machine("spot-encastre", 1500, 2000),
    ]

    return {
        "name": "WILDLIFE FITNESS CLUB — zone CrossFit",
        "units": "mm",
        "currency": "€",
        "priceEnabled": False,
        "gridStep": 100,
        "categories": [{"id": "Architecture", "name": "Architecture"}],
        "materials": materiaux,
        "connectorTypes": [],
        "presets": [{
            "id": "club", "name": "Zone CrossFit complète", "featured": True,
            "description": "Rig acier, panneaux cibles, néon WILDLIFE, plateformes, "
                           "kettlebells et porte vitrée — éclairage sur rail.",
            "items": items,
        }],
        "blocks": blocs,
    }


if __name__ == "__main__":
    donnees = construire()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(donnees, f, ensure_ascii=False, separators=(",", ":"))

    nv = sum(len(m["positions"]) for b in donnees["blocks"] for m in b["meshes"]) // 3
    print("%d blocs, %d sommets -> %s (%.0f Ko)"
          % (len(donnees["blocks"]), nv, OUT, os.path.getsize(OUT) / 1024.0))
