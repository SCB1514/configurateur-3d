import math
import json
import os

# --- Materiaux ---
BETON_SOL = {"color": "#3c3d40", "metalness": 0.0, "roughness": 0.82}
MUR_SOMBRE = {"color": "#1b1c1f", "metalness": 0.0, "roughness": 0.66}
PLAFOND = {"color": "#17181a", "metalness": 0.0, "roughness": 0.78}
ACIER_NOIR = {"color": "#232529", "metalness": 0.75, "roughness": 0.38}
ROUGE_LAQUE = {"color": "#d8232a", "metalness": 0.25, "roughness": 0.30, "clearcoat": 0.8, "clearcoatRoughness": 0.12}
CHROME = {"color": "#eef2f6", "metalness": 1.0, "roughness": 0.06}
BOIS = {"color": "#b4854a", "metalness": 0.0, "roughness": 0.42, "clearcoat": 0.35, "clearcoatRoughness": 0.25}
TAPIS_NOIR = {"color": "#202225", "metalness": 0.0, "roughness": 0.95}
FONTE = {"color": "#17181b", "metalness": 0.55, "roughness": 0.62}
NEON = {"color": "#050505", "metalness": 0.0, "roughness": 0.4, "emissive": "#ffffff", "emissiveIntensite": 6.0}
LED_BLANC = {"color": "#060606", "metalness": 0.0, "roughness": 0.4, "emissive": "#fff2dc", "emissiveIntensite": 5.0}
CUIR_BALLON = {"color": "#6b2118", "metalness": 0.0, "roughness": 0.72}

ROUGE_DISQUE = {"color": "#cc2222", "metalness": 0.1, "roughness": 0.55}
BLEU_DISQUE = {"color": "#1b45b8", "metalness": 0.1, "roughness": 0.55}
JAUNE_DISQUE = {"color": "#e8b21a", "metalness": 0.1, "roughness": 0.55}
VERT_DISQUE = {"color": "#17913f", "metalness": 0.1, "roughness": 0.55}

VITRE = {"color": "#dfe9f2", "metalness": 0.0, "roughness": 0.05, "opacity": 0.22,
         "transmission": 0.9, "thickness": 12.0, "ior": 1.5}

# --- Primitives ---

def boite(cx, cy, cz, dx, dy, dz):
    """Un pave centre sur (cx,cy,cz). Retourne (positions, normales, indices)."""
    hx, hy, hz = dx/2.0, dy/2.0, dz/2.0
    faces = [
        ((0,0,1),  [(-hx,-hy,hz),(hx,-hy,hz),(hx,hy,hz),(-hx,hy,hz)]),
        ((0,0,-1), [(-hx,hy,-hz),(hx,hy,-hz),(hx,-hy,-hz),(-hx,-hy,-hz)]),
        ((1,0,0),  [(hx,-hy,-hz),(hx,hy,-hz),(hx,hy,hz),(hx,-hy,hz)]),
        ((-1,0,0), [(-hx,hy,-hz),(-hx,-hy,-hz),(-hx,-hy,hz),(-hx,hy,hz)]),
        ((0,1,0),  [(hx,hy,-hz),(-hx,hy,-hz),(-hx,hy,hz),(hx,hy,hz)]),
        ((0,-1,0), [(-hx,-hy,-hz),(hx,-hy,-hz),(hx,-hy,hz),(-hx,-hy,hz)]),
    ]
    pos, nor, idx = [], [], []
    for normale, coins in faces:
        base = len(pos)//3
        for x,y,z in coins:
            pos += [cx+x, cy+y, cz+z]
            nor += list(normale)
        idx += [base,base+1,base+2, base,base+2,base+3]
    return pos, nor, idx


def fusion(*morceaux):
    """Concatene plusieurs geometries en decalant les indices."""
    pos, nor, idx = [], [], []
    offset = 0
    for p, n, i in morceaux:
        pos += p
        nor += n
        idx += [v + offset for v in i]
        offset += len(p)//3
    return pos, nor, idx


def maillage(nom, geo, matiere, **extra):
    """Enveloppe une geometrie dans un dict pret pour le JSON."""
    p, n, i = geo
    d = {"name": nom}
    d["positions"] = [round(v, 2) for v in p]
    d["normals"] = [round(v, 4) for v in n]
    d["indices"] = i
    d.update(matiere)
    d.update(extra)
    return d


def cylindre(cx, cy, cz, rayon, hauteur, segments=20, axe="z"):
    """Cylindre. L'axe est local z, puis transforme selon 'axe'."""
    h = hauteur / 2.0
    # Base orthonormee locale selon l'axe demande.
    if axe == "z":
        ex1, ey1, ez1 = 1, 0, 0
        ex2, ey2, ez2 = 0, 1, 0
        ex3, ey3, ez3 = 0, 0, 1
    elif axe == "x":
        ex1, ey1, ez1 = 0, 1, 0
        ex2, ey2, ez2 = 0, 0, 1
        ex3, ey3, ez3 = 1, 0, 0
    elif axe == "y":
        ex1, ey1, ez1 = 0, 0, 1
        ex2, ey2, ez2 = 1, 0, 0
        ex3, ey3, ez3 = 0, 1, 0
    else:
        raise ValueError("axe inconnu")

    def world(u, v, w):
        x = cx + u*ex1 + v*ex2 + w*ex3
        y = cy + u*ey1 + v*ey2 + w*ey3
        z = cz + u*ez1 + v*ez2 + w*ez3
        return x, y, z

    def normal(u, v, w):
        return (u*ex1 + v*ex2 + w*ex3,
                u*ey1 + v*ey2 + w*ey3,
                u*ez1 + v*ez2 + w*ez3)

    pos, nor = [], []
    # Sommets de la paroi laterale avec normales radiales.
    for i in range(segments+1):
        theta = 2*math.pi * i / segments
        u = rayon * math.cos(theta)
        v = rayon * math.sin(theta)
        x, y, z = world(u, v, -h)
        pos += [x, y, z]
        nx, ny, nz = normal(math.cos(theta), math.sin(theta), 0)
        nor += [nx, ny, nz]
    for i in range(segments+1):
        theta = 2*math.pi * i / segments
        u = rayon * math.cos(theta)
        v = rayon * math.sin(theta)
        x, y, z = world(u, v, h)
        pos += [x, y, z]
        nx, ny, nz = normal(math.cos(theta), math.sin(theta), 0)
        nor += [nx, ny, nz]

    n_ring = segments + 1
    idx = []
    for i in range(segments):
        j = i + 1
        bottom_i = i
        bottom_j = j
        top_i = n_ring + i
        top_j = n_ring + j
        idx += [bottom_i, bottom_j, top_j, bottom_i, top_j, top_i]

    # Bouchon haut, normale +axe local z.
    center_top = len(pos)//3
    x, y, z = world(0, 0, h)
    pos += [x, y, z]
    nx, ny, nz = normal(0, 0, 1)
    nor += [nx, ny, nz]
    ring_start = len(pos)//3
    for i in range(segments+1):
        theta = 2*math.pi * i / segments
        u = rayon * math.cos(theta)
        v = rayon * math.sin(theta)
        x, y, z = world(u, v, h)
        pos += [x, y, z]
        nx, ny, nz = normal(0, 0, 1)
        nor += [nx, ny, nz]
    for i in range(segments):
        a = center_top
        b = ring_start + i
        c = ring_start + i + 1
        idx += [a, b, c]

    # Bouchon bas, normale -axe local z.
    center_bottom = len(pos)//3
    x, y, z = world(0, 0, -h)
    pos += [x, y, z]
    nx, ny, nz = normal(0, 0, -1)
    nor += [nx, ny, nz]
    ring_bottom_start = len(pos)//3
    for i in range(segments+1):
        theta = 2*math.pi * i / segments
        u = rayon * math.cos(theta)
        v = rayon * math.sin(theta)
        x, y, z = world(u, v, -h)
        pos += [x, y, z]
        nx, ny, nz = normal(0, 0, -1)
        nor += [nx, ny, nz]
    for i in range(segments):
        a = center_bottom
        b = ring_bottom_start + i
        c = ring_bottom_start + i + 1
        idx += [a, c, b]

    return pos, nor, idx


def sphere(cx, cy, cz, rayon, meridiens=18, paralleles=12):
    """Sphere UV centree sur (cx,cy,cz)."""
    pos, nor = [], []
    for i in range(paralleles + 1):
        theta = math.pi * i / paralleles
        sin_t = math.sin(theta)
        cos_t = math.cos(theta)
        for j in range(meridiens + 1):
            phi = 2*math.pi * j / meridiens
            x = rayon * sin_t * math.cos(phi)
            y = rayon * sin_t * math.sin(phi)
            z = rayon * cos_t
            pos += [cx + x, cy + y, cz + z]
            nor += [sin_t*math.cos(phi), sin_t*math.sin(phi), cos_t]
    idx = []
    for i in range(paralleles):
        for j in range(meridiens):
            a = i*(meridiens+1) + j
            b = (i+1)*(meridiens+1) + j
            c = (i+1)*(meridiens+1) + j + 1
            d = i*(meridiens+1) + j + 1
            idx += [a, b, c, a, c, d]
    return pos, nor, idx


def tore(cx, cy, cz, rayon, tube, segments=20, cotes=10, axe="z"):
    """Tore. Axe par defaut z (plan XY). Utiliser axe='y' pour plan XZ."""
    if axe == "z":
        e1 = (1, 0, 0)
        e2 = (0, 1, 0)
        ax = (0, 0, 1)
    elif axe == "x":
        e1 = (0, 1, 0)
        e2 = (0, 0, 1)
        ax = (1, 0, 0)
    elif axe == "y":
        e1 = (0, 0, 1)
        e2 = (1, 0, 0)
        ax = (0, 1, 0)
    else:
        raise ValueError("axe inconnu")

    pos, nor = [], []
    for i in range(segments + 1):
        theta = 2*math.pi * i / segments
        cost = math.cos(theta)
        sint = math.sin(theta)
        rx = cost*e1[0] + sint*e2[0]
        ry = cost*e1[1] + sint*e2[1]
        rz = cost*e1[2] + sint*e2[2]
        px = cx + rayon*rx
        py = cy + rayon*ry
        pz = cz + rayon*rz
        for j in range(cotes + 1):
            phi = 2*math.pi * j / cotes
            cosp = math.cos(phi)
            sinp = math.sin(phi)
            ox = tube*(cosp*rx + sinp*ax[0])
            oy = tube*(cosp*ry + sinp*ax[1])
            oz = tube*(cosp*rz + sinp*ax[2])
            pos += [px + ox, py + oy, pz + oz]
            nor += [cosp*rx + sinp*ax[0],
                    cosp*ry + sinp*ax[1],
                    cosp*rz + sinp*ax[2]]
    idx = []
    for i in range(segments):
        for j in range(cotes):
            a = i*(cotes+1) + j
            b = (i+1)*(cotes+1) + j
            c = (i+1)*(cotes+1) + j + 1
            d = i*(cotes+1) + j + 1
            idx += [a, b, c, a, c, d]
    return pos, nor, idx


# --- Fabrique de bloc ---

def bloc(id_bloc, name, category, price, description, baseOffset, meshes, lumieres=None):
    return {
        "id": id_bloc,
        "name": name,
        "category": category,
        "price": price,
        "description": description,
        "baseOffset": baseOffset,
        "meshes": meshes,
        "connectors": [{"type": "*", "main": True, "pos": [0, 0, 0]}],
        "lumieres": lumieres if lumieres is not None else []
    }


blocks = []

# --- 1. Salle coque ---
geo_sol = boite(0, 0, -50, 12000, 8000, 100)
geo_plafond = boite(0, 0, 3250, 12000, 8000, 100)
geo_murs = fusion(
    boite(0, 4050, 1600, 12000, 100, 3200),
    boite(-6050, 0, 1600, 100, 8000, 3200),
    boite(6050, 0, 1600, 100, 8000, 3200)
)
geo_plinthe = boite(0, 3960, 40, 12000, 60, 80)

blocks.append(bloc(
    "salle-coque",
    "Salle : coque",
    "Salle",
    0,
    "Coque de la salle : sol, plafond, murs et plinthe rouge.",
    0,
    [
        maillage("Sol", geo_sol, BETON_SOL),
        maillage("Plafond", geo_plafond, PLAFOND),
        maillage("Murs", geo_murs, MUR_SOMBRE),
        maillage("Plinthe", geo_plinthe, ROUGE_LAQUE)
    ]
))

# --- 2. Lignes de plafond LED ---
ys_led = [-2400, -800, 800, 2400]
profils_led = []
diffuseurs_led = []
lumieres_led = []
for y in ys_led:
    profils_led.append(boite(0, y, 3170, 11000, 90, 60))
    diffuseurs_led.append(boite(0, y, 3132, 10800, 60, 16))
    lumieres_led.append({
        "type": "bande",
        "pos": [0, y, 3124],
        "taille": [10800, 60],
        "couleur": "#fff2dc",
        "intensite": 9,
        "eclat": 5,
        "portee": 0,
        "parTemperature": False
    })

blocks.append(bloc(
    "salle-plafond-led",
    "Salle : lignes de plafond",
    "Eclairage",
    0,
    "Quatre lignes lumineuses continues en acier noir et diffuseur LED.",
    0,
    [
        maillage("Profils", fusion(*profils_led), ACIER_NOIR),
        maillage("Diffuseurs", fusion(*diffuseurs_led), LED_BLANC)
    ],
    lumieres_led
))

# --- 3. Plafond a lames ---
lames = []
for i in range(24):
    x = -2530 + i * 220
    lames.append(boite(x, 0, 3080, 60, 7600, 140))

blocks.append(bloc(
    "salle-plafond-lames",
    "Salle : plafond a lames",
    "Salle",
    0,
    "Vingt-quatre lames acier noir paralleles a l'axe Y.",
    0,
    [maillage("Lames", fusion(*lames), ACIER_NOIR)]
))

# --- 4. Enseigne neon ---
segments_neon = [
    (-1900, 2350, 600, "h"),
    (-2200, 2150, 400, "v"),
    (-1600, 2150, 400, "v"),
    (-1900, 2150, 600, "h"),
    (-1900, 1950, 600, "h"),
    (100, 2350, 800, "h"),
    (500, 2150, 400, "v"),
    (100, 1950, 800, "h"),
    (-1000, 2000, 500, "h"),
    (-1250, 1850, 300, "v"),
    (-750, 1850, 300, "v"),
    (-1000, 1850, 500, "h"),
    (-1000, 1700, 500, "h"),
    (1200, 2000, 600, "h"),
    (1500, 1850, 300, "v"),
]

caisson_neon = boite(0, 3980, 2050, 5200, 40, 900)
neon_parts = []
for cx, cz, longueur, forme in segments_neon:
    if forme == "h":
        neon_parts.append(boite(cx, 3950, cz, longueur, 40, 40))
    else:
        neon_parts.append(boite(cx, 3950, cz, 40, 40, longueur))

blocks.append(bloc(
    "enseigne-neon",
    "Enseigne neon",
    "Eclairage",
    1200,
    "Caisson sombre avec trace neon stylisee sur le mur du fond.",
    0,
    [
        maillage("Caisson", caisson_neon, MUR_SOMBRE),
        maillage("Neon", fusion(*neon_parts), NEON)
    ],
    [{
        "type": "rectangle",
        "pos": [0, 3930, 2050],
        "rot": [-90, 0, 0],
        "taille": [5000, 800],
        "couleur": "#eaf2ff",
        "intensite": 5,
        "eclat": 4,
        "portee": 0,
        "parTemperature": False
    }]
))

# --- 5. Rack mural ---
acier_rack_mural = [
    boite(-560, 0, 1350, 100, 100, 2700),
    boite(560, 0, 1350, 100, 100, 2700),
    boite(0, 0, 2650, 1220, 90, 90),
]
for z_etagere in [900, 1250, 1600, 1950]:
    acier_rack_mural.append(boite(0, -170, z_etagere, 1100, 340, 40))

rouge_rack_mural = [
    boite(-500, -180, 2480, 120, 300, 120),
    boite(500, -180, 2480, 120, 300, 120),
    boite(0, -120, 3000, 700, 40, 700)
]

ballons_rack_mural = []
for z_etagere in [900, 1250, 1600, 1950]:
    centre_z = z_etagere + 170
    for x_ballon in [-440, -220, 0, 220, 440]:
        ballons_rack_mural.append(sphere(x_ballon, -170, centre_z, 130))

blocks.append(bloc(
    "rack-mural",
    "Rack mural",
    "Equipement",
    3400,
    "Rack mural complet avec etageres, ballons, barre de traction et panneau cible.",
    0,
    [
        maillage("Acier", fusion(*acier_rack_mural), ACIER_NOIR),
        maillage("Rouge", fusion(*rouge_rack_mural), ROUGE_LAQUE),
        maillage("Chrome", cylindre(0, -260, 2600, 22, 1200, axe="x"), CHROME),
        maillage("Ballons", fusion(*ballons_rack_mural), CUIR_BALLON)
    ],
    [{
        "type": "bande",
        "pos": [0, -80, 2620],
        "taille": [1150, 30],
        "couleur": "#ff3322",
        "intensite": 3,
        "eclat": 4,
        "portee": 3000,
        "parTemperature": False
    }]
))

# --- 6. Rack a disques ---
x_disques = [-560, -440, -320, -200, -80, 80, 200, 320, 440, 560]
couleurs_disques = [
    ("ROUGE_DISQUE", ROUGE_DISQUE),
    ("BLEU_DISQUE", BLEU_DISQUE),
    ("JAUNE_DISQUE", JAUNE_DISQUE),
    ("VERT_DISQUE", VERT_DISQUE),
]
pieces_disques = {nom: [] for nom, _ in couleurs_disques}
for i, x in enumerate(x_disques):
    nom, _ = couleurs_disques[i % 4]
    pieces_disques[nom].append(tore(x, 0, 320, 220, 45, segments=20, cotes=10, axe="y"))

meshes_disques = [
    maillage("Acier", fusion(
        boite(0, 0, 60, 1400, 500, 120),
        boite(0, 0, 320, 1300, 80, 80)
    ), ACIER_NOIR)
]
for nom, matiere_disque in couleurs_disques:
    if pieces_disques[nom]:
        meshes_disques.append(maillage("Disques " + nom.lower(), fusion(*pieces_disques[nom]), matiere_disque))

blocks.append(bloc(
    "rack-disques",
    "Rack a disques",
    "Equipement",
    890,
    "Socle et barre acier, avec dix disques olympiques colores.",
    0,
    meshes_disques
))

# --- 7. Plateforme de force ---
blocks.append(bloc(
    "plateforme",
    "Plateforme de force",
    "Equipement",
    2100,
    "Plateforme noire avec bande centrale en bois et liseret rouge.",
    0,
    [
        maillage("Tapis noir", boite(0, 0, 30, 2400, 2000, 60), TAPIS_NOIR),
        maillage("Bois", boite(0, 0, 62, 1200, 2000, 8), BOIS),
        maillage("Liseret rouge", boite(0, -990, 66, 2400, 20, 6), ROUGE_LAQUE)
    ]
))

# --- 8. Kettlebell ---
blocks.append(bloc(
    "kettlebell",
    "Kettlebell",
    "Equipement",
    120,
    "Kettlebell en fonte avec anse verticale.",
    0,
    [
        maillage("Fonte", fusion(
            sphere(0, 0, 130, 130),
            tore(0, 0, 290, 95, 26, segments=20, cotes=10, axe="y")
        ), FONTE)
    ]
))

# --- 9. Cloison vitree ---
geo_cadre_cloison = fusion(
    boite(0, 0, 30, 1400, 60, 60),
    boite(0, 0, 2370, 1400, 60, 60),
    boite(-670, 0, 1200, 60, 60, 2400),
    boite(670, 0, 1200, 60, 60, 2400)
)
blocks.append(bloc(
    "cloison-vitree",
    "Cloison vitree",
    "Salle",
    0,
    "Cadre acier noir et panneau vitre translucide.",
    0,
    [
        maillage("Cadre", geo_cadre_cloison, ACIER_NOIR),
        maillage("Vitrage", boite(0, 0, 1200, 1300, 12, 2300), VITRE)
    ]
))

# --- Preset ---
preset = {
    "id": "salle",
    "name": "Salle complete",
    "description": "Salle complete avec coque, eclairage, equipements et cloison.",
    "items": [
        {"blockId": "salle-coque", "pos": [0, 0, 0], "rot": 0},
        {"blockId": "salle-plafond-led", "pos": [0, 0, 0], "rot": 0},
        {"blockId": "salle-plafond-lames", "pos": [0, 0, 0], "rot": 0},
        {"blockId": "enseigne-neon", "pos": [0, 0, 0], "rot": 0},
        {"blockId": "rack-mural", "pos": [-4200, 3700, 0], "rot": 0},
        {"blockId": "rack-mural", "pos": [-1400, 3700, 0], "rot": 0},
        {"blockId": "rack-mural", "pos": [1400, 3700, 0], "rot": 0},
        {"blockId": "rack-mural", "pos": [4200, 3700, 0], "rot": 0},
        {"blockId": "rack-disques", "pos": [-4200, 2900, 0], "rot": 0},
        {"blockId": "rack-disques", "pos": [-1400, 2900, 0], "rot": 0},
        {"blockId": "rack-disques", "pos": [1400, 2900, 0], "rot": 0},
        {"blockId": "rack-disques", "pos": [4200, 2900, 0], "rot": 0},
        {"blockId": "plateforme", "pos": [-3000, 900, 0], "rot": 0},
        {"blockId": "plateforme", "pos": [0, 900, 0], "rot": 0},
        {"blockId": "plateforme", "pos": [3000, 900, 0], "rot": 0},
        {"blockId": "kettlebell", "pos": [-4500, -1500, 0], "rot": 0},
        {"blockId": "kettlebell", "pos": [-2000, -2500, 0], "rot": 0},
        {"blockId": "kettlebell", "pos": [0, -3000, 0], "rot": 0},
        {"blockId": "kettlebell", "pos": [2000, -1800, 0], "rot": 0},
        {"blockId": "kettlebell", "pos": [3500, -2600, 0], "rot": 0},
        {"blockId": "kettlebell", "pos": [4500, -2000, 0], "rot": 0},
        {"blockId": "cloison-vitree", "pos": [5400, 0, 0], "rot": 90},
    ]
}

# --- Materiaux nommes pour l'interface ---
materiaux = [
    {"name": "BETON_SOL", **BETON_SOL},
    {"name": "MUR_SOMBRE", **MUR_SOMBRE},
    {"name": "PLAFOND", **PLAFOND},
    {"name": "ACIER_NOIR", **ACIER_NOIR},
    {"name": "ROUGE_LAQUE", **ROUGE_LAQUE},
    {"name": "CHROME", **CHROME},
    {"name": "BOIS", **BOIS},
    {"name": "TAPIS_NOIR", **TAPIS_NOIR},
    {"name": "FONTE", **FONTE},
    {"name": "NEON", **NEON},
    {"name": "LED_BLANC", **LED_BLANC},
    {"name": "CUIR_BALLON", **CUIR_BALLON},
    {"name": "ROUGE_DISQUE", **ROUGE_DISQUE},
    {"name": "BLEU_DISQUE", **BLEU_DISQUE},
    {"name": "JAUNE_DISQUE", **JAUNE_DISQUE},
    {"name": "VERT_DISQUE", **VERT_DISQUE},
    {"name": "VITRE", **VITRE},
]

# --- JSON final ---
data = {
    "name": "Salle de sport - essai de rendu",
    "units": "mm",
    "gridStep": 100,
    "currency": "EUR",
    "categories": ["Salle", "Equipement", "Eclairage"],
    "materials": materiaux,
    "blocks": blocks,
    "presets": [preset]
}

out_dir = "data"
os.makedirs(out_dir, exist_ok=True)
path = os.path.join(out_dir, "library-salle.json")

with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, ensure_ascii=False, separators=(",", ":"))

total_maillages = sum(len(b["meshes"]) for b in blocks)
poids_ko = os.path.getsize(path) / 1024.0

print(f"Ecrit dans {path}")
print(f"Blocs: {len(blocks)}")
print(f"Maillages: {total_maillages}")
print(f"Poids: {poids_ko:.2f} Ko")