# -*- coding: utf-8 -*-
"""
Genere une bibliotheque « salle de sport club » pour tester le rendu du
configurateur : une piece (sol, murs) texturee avec des apercus publiques
d'Architextures, remplie avec les machines de la demo et eclairee par les
luminaires integres.

    python tools/gen_salle.py

Resultat : data/library-salle.json (+ textures telechargees dans data/textures/).
"""

import json
import os
import sys
import urllib.request

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TEX_DIR = os.path.join(HERE, "data", "textures")
DEMO = os.path.join(HERE, "data", "library.json")
OUT = os.path.join(HERE, "data", "library-salle.json")

# Apercus publics d'Architextures (filigranes, ~1200 px). On les telecharge
# une fois, puis on les sert en local : la CSP du site interdit toute image
# exterieure au domaine.
TEXTURES = [
    ("parquet-wenge.jpg",
     "https://cdn.architextures.org/textures/25/4/wenge-chevron-peot73.jpg"),
    ("bois-brule.jpg",
     "https://cdn.architextures.org/textures/25/6/thermal-redwood--shou-sugi-ban--char--brushed--black-staggered-tiny-temple-1no7ha.jpg"),
    ("beton-basalte.jpg",
     "https://cdn.architextures.org/materials/9814/original/9814_Lucida-Nero-Basalto-Kellen---Swatch.JPG?s=1200&q=70"),
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

def quad(a, b, c, d, n):
    """Un panneau rectangulaire, double face (donc visible des deux cotes)."""
    pos = list(a) + list(b) + list(c) + list(d)
    nor = list(n) * 4
    idx = [0, 1, 2, 0, 2, 3]
    return pos, nor, idx


def mesh(nom, prim, couleur, material, rough, metal=0.0):
    p, n, i = prim
    return {
        "name": nom,
        "positions": [round(v, 1) for v in p],
        "normals": [round(v, 3) for v in n],
        "indices": i,
        "color": couleur,
        "material": material,
        "roughness": rough,
        "metalness": metal,
    }


# --- dimensions de la piece (mm) ---
L = 12000.0   # largeur (x)
P = 8000.0    # profondeur (y)
H = 3000.0    # hauteur (z)

X0, X1 = -L / 2, L / 2
Y0, Y1 = -P / 2, P / 2


def bloc_sol():
    return {
        "id": "sol", "name": "Sol — parquet wengé", "category": "Architecture",
        "price": 0, "baseOffset": 0, "ref": "", "description":
            "Dalle de sol 12 × 8 m, parquet wengé (texture Architextures).",
        "meshes": [mesh("Sol", quad((X0, Y0, 0), (X1, Y0, 0), (X1, Y1, 0), (X0, Y1, 0),
                                     (0, 0, 1)), "#ffffff", "parquet-wenge", 0.62)],
        "connectors": [],
    }


def bloc_mur(bid, nom, prim, material, description):
    return {
        "id": bid, "name": nom, "category": "Architecture",
        "price": 0, "baseOffset": 0, "ref": "", "description": description,
        "meshes": [mesh(nom, prim, "#ffffff", material, 0.78)],
        "connectors": [],
    }


def bloc_mur_fond():
    # mur du fond, en y = Y0, normale +Y (vers l'interieur)
    return bloc_mur("mur-fond", "Mur du fond — bois brûlé",
                    quad((X0, Y0, 0), (X1, Y0, 0), (X1, Y0, H), (X0, Y0, H), (0, 1, 0)),
                    "bois-brule", "Mur du fond, bardage bois brûlé (Shou Sugi Ban).")


def bloc_mur_gauche():
    # mur gauche, en x = X0, normale +X (vers l'interieur)
    return bloc_mur("mur-gauche", "Mur gauche — béton",
                    quad((X0, Y0, 0), (X0, Y1, 0), (X0, Y1, H), (X0, Y0, H), (1, 0, 0)),
                    "beton-basalte", "Mur latéral, béton basalte sombre.")


def bloc_mur_droite():
    # mur droit, en x = X1, normale -X (vers l'interieur)
    return bloc_mur("mur-droite", "Mur droit — béton",
                    quad((X1, Y1, 0), (X1, Y0, 0), (X1, Y0, H), (X1, Y1, H), (-1, 0, 0)),
                    "beton-basalte", "Mur latéral, béton basalte sombre.")


def construire():
    os.makedirs(TEX_DIR, exist_ok=True)
    for nom, url in TEXTURES:
        telecharger(nom, url)

    with open(DEMO, encoding="utf-8") as f:
        demo = json.load(f)

    materiaux = list(demo.get("materials", []))
    materiaux += [
        {"id": "parquet-wenge", "name": "Parquet wengé", "color": "#6f5a45",
         "metalness": 0.0, "roughness": 0.62, "opacity": 1,
         "maps": {"color": {"src": "textures/parquet-wenge.jpg"}, "worldSize": 2200}},
        {"id": "bois-brule", "name": "Bois brûlé (Shou Sugi Ban)", "color": "#1a1714",
         "metalness": 0.0, "roughness": 0.78, "opacity": 1,
         "maps": {"color": {"src": "textures/bois-brule.jpg"}, "worldSize": 2000}},
        {"id": "beton-basalte", "name": "Béton basalte", "color": "#2a2a2c",
         "metalness": 0.05, "roughness": 0.72, "opacity": 1,
         "maps": {"color": {"src": "textures/beton-basalte.jpg"}, "worldSize": 1800}},
    ]

    categories = list(demo.get("categories", []))
    if not any(c.get("id") == "Architecture" for c in categories):
        categories.append({"id": "Architecture", "name": "Architecture"})

    blocs = list(demo.get("blocks", []))
    blocs += [bloc_sol(), bloc_mur_fond(), bloc_mur_gauche(), bloc_mur_droite()]

    # --- disposition « salle club » ---
    def machine(bid, x, y, rot=0):
        return {"blockId": bid, "pos": [x, y, 0], "rot": rot}

    items = [
        machine("sol", 0, 0),
        machine("mur-fond", 0, 0),
        machine("mur-gauche", 0, 0),
        machine("mur-droite", 0, 0),
        # ligne de cardio adossee au mur du fond
        machine("tapis-course", -2000, -3200),
        machine("tapis-course", 0, -3200),
        machine("tapis-course", 2000, -3200),
        machine("velo-assis", -1500, -1400),
        machine("velo-assis", 0, -1400),
        # zone poids libres au centre
        machine("rack-squat", 0, 600),
        machine("banc-reglable", -2600, 800),
        machine("banc-reglable", -2600, 2200),
        machine("rack-halteres", 3000, 1500, 180),
        # services le long du mur droit
        machine("casiers", 5200, 2600, 270),
        machine("fontaine", 5200, 400, 270),
        # eclairage integre
        machine("plan-rect-600", -2000, -1500),
        machine("plan-rect-600", 2000, -1500),
        machine("plan-rect-600", -2000, 2000),
        machine("plan-rect-600", 2000, 2000),
        machine("spot-encastre", -3000, -3600),
        machine("spot-encastre", 0, -3600),
        machine("spot-encastre", 3000, -3600),
    ]

    presets = list(demo.get("presets", []))
    presets.insert(0, {
        "id": "club",
        "name": "Salle club (test rendu)",
        "description": "Pièce 12 × 8 m : parquet wengé, mur du fond en bois brûlé, "
                       "murs latéraux béton. Cardio, poids libres, casiers et "
                       "éclairage intégré.",
        "featured": True,
        "items": items,
    })

    return {
        "name": "Salle de sport — club (test rendu)",
        "units": demo.get("units", "mm"),
        "currency": demo.get("currency", "€"),
        "priceEnabled": demo.get("priceEnabled", True),
        "gridStep": demo.get("gridStep", 100),
        "categories": categories,
        "materials": materiaux,
        "connectorTypes": demo.get("connectorTypes", []),
        "presets": presets,
        "blocks": blocs,
    }


if __name__ == "__main__":
    donnees = construire()
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(donnees, f, ensure_ascii=False, separators=(",", ":"))

    nv = sum(len(m["positions"]) for b in donnees["blocks"] for m in b["meshes"]) // 3
    lum = sum(len(b.get("lumieres", [])) for b in donnees["blocks"])
    print("%d blocs, %d luminaires, %d sommets -> %s (%.0f Ko)"
          % (len(donnees["blocks"]), lum, nv, OUT, os.path.getsize(OUT) / 1024.0))
