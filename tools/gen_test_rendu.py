# -*- coding: utf-8 -*-
"""
Banc d'essai du rendu.

Genere une bibliotheque dont le seul but est de mettre le moteur en
difficulte : matieres qui ne pardonnent rien (chrome poli, aluminium
brosse, laque, caoutchouc, verre teinte), pieces emissives, et les
quatre familles de luminaires.

Une bibliotheque de demonstration montre ce qui marche ; celle-ci
cherche ce qui casse. On y regarde en particulier :

  - le chrome doit refleter l'environnement, pas paraitre gris ;
  - la laque doit porter un reflet blanc qui glisse, distinct de sa
    couleur ;
  - le verre doit laisser voir a travers sans avaler l'ombre ;
  - un bandeau de LED doit eclairer le sol sous la machine, pas
    seulement briller ;
  - le projecteur IES doit dessiner un vrai faisceau, coeur marque et
    bord degrade, et non un disque uniforme.

    python tools/gen_test_rendu.py            -> data/library-rendu.json
"""
import json, math, os, sys

# ─────────────────────────── geometrie ───────────────────────────

def boite(cx, cy, cz, dx, dy, dz):
    """Un pave, en positions/normales/indices, centre sur (cx, cy, cz)."""
    hx, hy, hz = dx / 2.0, dy / 2.0, dz / 2.0
    faces = [
        ((0, 0, 1), [(-hx, -hy, hz), (hx, -hy, hz), (hx, hy, hz), (-hx, hy, hz)]),
        ((0, 0, -1), [(-hx, hy, -hz), (hx, hy, -hz), (hx, -hy, -hz), (-hx, -hy, -hz)]),
        ((1, 0, 0), [(hx, -hy, -hz), (hx, hy, -hz), (hx, hy, hz), (hx, -hy, hz)]),
        ((-1, 0, 0), [(-hx, hy, -hz), (-hx, -hy, -hz), (-hx, -hy, hz), (-hx, hy, hz)]),
        ((0, 1, 0), [(hx, hy, -hz), (-hx, hy, -hz), (-hx, hy, hz), (hx, hy, hz)]),
        ((0, -1, 0), [(-hx, -hy, -hz), (hx, -hy, -hz), (hx, -hy, hz), (-hx, -hy, hz)]),
    ]
    pos, nor, idx = [], [], []
    for normale, coins in faces:
        base = len(pos) // 3
        for x, y, z in coins:
            pos += [cx + x, cy + y, cz + z]
            nor += list(normale)
        idx += [base, base + 1, base + 2, base, base + 2, base + 3]
    return pos, nor, idx


def cylindre(cx, cy, cz, rayon, hauteur, segments=24, axe="z"):
    """Un cylindre ferme. L'axe se choisit : une barre couchee est frequente."""
    pos, nor, idx = [], [], []
    h = hauteur / 2.0

    def place(u, v, w):
        if axe == "z":
            return cx + u, cy + v, cz + w
        if axe == "x":
            return cx + w, cy + u, cz + v
        return cx + u, cy + w, cz + v          # axe y

    for i in range(segments):
        a0 = 2 * math.pi * i / segments
        a1 = 2 * math.pi * (i + 1) / segments
        for a in (a0, a1):
            x, y = math.cos(a) * rayon, math.sin(a) * rayon
            n = place(math.cos(a), math.sin(a), 0)
            nx, ny, nz = n[0] - cx, n[1] - cy, n[2] - cz
            for w in (-h, h):
                pos += list(place(x, y, w))
                nor += [nx, ny, nz]
        b = len(pos) // 3 - 4
        idx += [b, b + 1, b + 3, b, b + 3, b + 2]

    for w, nz in ((h, 1), (-h, -1)):
        centre = len(pos) // 3
        pos += list(place(0, 0, w)); nor += list(place(0, 0, nz)[0] - cx and (0, 0, nz) or (0, 0, nz))
        for i in range(segments + 1):
            a = 2 * math.pi * i / segments
            pos += list(place(math.cos(a) * rayon, math.sin(a) * rayon, w))
            nor += [0, 0, nz]
        for i in range(segments):
            if nz > 0:
                idx += [centre, centre + 1 + i, centre + 2 + i]
            else:
                idx += [centre, centre + 2 + i, centre + 1 + i]
    return pos, nor, idx


def fusion(*morceaux):
    pos, nor, idx = [], [], []
    for p, n, i in morceaux:
        base = len(pos) // 3
        pos += p; nor += n; idx += [k + base for k in i]
    return pos, nor, idx


def maillage(nom, geo, materiau, **extra):
    pos, nor, idx = geo
    m = {"name": nom, "positions": [round(v, 2) for v in pos],
         "normals": [round(v, 4) for v in nor], "indices": idx}
    m.update(materiau)
    m.update(extra)
    return m


# ─────────────────────────── matieres ───────────────────────────
# Les valeurs qui suivent ne sont pas decoratives : ce sont celles qui
# separent une matiere credible d'un aplat colore.

CHROME      = {"color": "#f2f5f8", "metalness": 1.00, "roughness": 0.045}
ACIER_BROSSE= {"color": "#b6bcc4", "metalness": 1.00, "roughness": 0.34}
ALU_ANODISE = {"color": "#8d949c", "metalness": 0.92, "roughness": 0.22}
LAQUE_NOIRE = {"color": "#14161a", "metalness": 0.05, "roughness": 0.16}
LAQUE_COUL  = {"color": "#0a84ff", "metalness": 0.04, "roughness": 0.14, "paintable": True}
CAOUTCHOUC  = {"color": "#1b1d21", "metalness": 0.00, "roughness": 0.94}
MOUSSE      = {"color": "#23262b", "metalness": 0.00, "roughness": 0.86}
PLASTIQUE   = {"color": "#2c3038", "metalness": 0.00, "roughness": 0.48}
VERRE       = {"color": "#cfe6f2", "metalness": 0.00, "roughness": 0.05, "opacity": 0.28}
ECRAN       = {"color": "#05070a", "metalness": 0.10, "roughness": 0.22,
               "emissive": "#1f6fff", "emissiveIntensite": 2.4}
NEON        = {"color": "#050505", "metalness": 0.00, "roughness": 0.40,
               "emissive": "#ff3b6b", "emissiveIntensite": 5.0}


# ─────────────────────── profil photometrique ───────────────────────

def ies_faisceau(demi_angle=22.0, nom="Projecteur d'essai"):
    """
    Un fichier IESNA:LM-63-2002 valide, decrivant un faisceau a coeur
    franc et bord degrade.

    On le fabrique plutot que d'en embarquer un : un .ies de fabricant
    est un document sous licence, et ce qu'on veut verifier ici c'est
    que la chaine de lecture fonctionne, pas la fidelite a une optique
    commerciale precise.
    """
    angles = list(range(0, 91, 5))
    pic = 12000.0
    valeurs = []
    for a in angles:
        if a <= demi_angle * 0.55:
            v = pic
        elif a <= demi_angle:
            t = (a - demi_angle * 0.55) / (demi_angle * 0.45)
            v = pic * (1.0 - t) ** 1.8
        else:
            v = pic * 0.004 * math.exp(-(a - demi_angle) / 9.0)
        valeurs.append(round(v, 1))

    lignes = [
        "IESNA:LM-63-2002",
        "[TEST] Banc d'essai du configurateur",
        "[MANUFAC] " + nom,
        "[LUMCAT] ESSAI-" + str(int(demi_angle)),
        "TILT=NONE",
        "1 -1 1 %d 1 1 2 -0.1 -0.1 0.1" % len(angles),
        "1.0 1.0 0.0",
        " ".join(str(a) for a in angles),
        "0",
        " ".join(str(v) for v in valeurs),
    ]
    return "\n".join(lignes) + "\n"


# ─────────────────────────── les blocs ───────────────────────────

def bloc_vitrine():
    """Une colonne d'essai : chaque matiere sur un volume simple, cote a cote."""
    matieres = [CHROME, ACIER_BROSSE, ALU_ANODISE, LAQUE_NOIRE,
                LAQUE_COUL, CAOUTCHOUC, PLASTIQUE, VERRE]
    noms = ["Chrome poli", "Acier brosse", "Alu anodise", "Laque noire",
            "Laque couleur", "Caoutchouc", "Plastique", "Verre teinte"]
    meshes = [maillage("Socle", boite(0, 0, 25, 1900, 320, 50), PLASTIQUE)]
    for i, (m, n) in enumerate(zip(matieres, noms)):
        x = -800 + i * 228
        meshes.append(maillage(n, cylindre(x, 0, 170, 88, 240), m))
        meshes.append(maillage(n + " cube", boite(x, 0, 380, 150, 150, 150), m))
    return {
        "id": "essai-matieres", "name": "Nuancier de matieres",
        "category": "Essais", "price": 0,
        "description": "Huit matieres sur deux volumes : cylindre et cube. "
                       "Le cylindre montre le degrade du reflet, le cube ses aretes.",
        "meshes": meshes,
        "connectors": [{"type": "*", "main": True, "pos": [0, 0, 0]}],
    }


def bloc_machine_led():
    """Une machine avec bandeau de LED sous le capot et console retro-eclairee."""
    meshes = [
        maillage("Chassis", boite(0, 0, 60, 1400, 700, 120), LAQUE_NOIRE),
        maillage("Capot", boite(0, -120, 420, 620, 380, 520), LAQUE_COUL),
        maillage("Colonne", cylindre(480, 0, 700, 55, 1200), ACIER_BROSSE),
        maillage("Barre", cylindre(0, 260, 980, 26, 900, axe="x"), CHROME),
        maillage("Assise", boite(-260, 0, 560, 480, 380, 90), MOUSSE),
        maillage("Console", boite(480, 0, 1330, 340, 40, 240), ECRAN),
        maillage("Pieds", boite(0, 0, 12, 1440, 740, 24), CAOUTCHOUC),
    ]
    return {
        "id": "machine-led", "name": "Poste a bandeau LED",
        "category": "Essais", "price": 4900,
        "description": "Bandeau de LED sous le capot et console retro-eclairee. "
                       "Le bandeau doit poser une trainee de lumiere au sol.",
        "meshes": meshes,
        "connectors": [{"type": "A", "main": True, "pos": [0, 0, 0]}],
        "lumieres": [
            {"type": "bande", "nom": "Bandeau sous capot",
             "pos": [0, -120, 145], "rot": [0, 0, 0],
             "taille": [560, 26], "couleur": "#35c6ff",
             "intensite": 6, "eclat": 5.5},
            {"type": "bande", "nom": "Liseret arriere",
             "pos": [0, 70, 145], "rot": [0, 0, 0],
             "taille": [900, 18], "couleur": "#ff3b6b",
             "intensite": 3, "eclat": 4.5},
        ],
    }


def bloc_dalle():
    """Une dalle lumineuse de plafond : la source surfacique par excellence."""
    return {
        "id": "dalle-plafond", "name": "Dalle lumineuse 600",
        "baseOffset": 0,
        "category": "Eclairage", "price": 180,
        "description": "Dalle 600 x 600 posee a 2,80 m. Source surfacique : "
                       "elle donne au metal des reflets allonges qu'aucun "
                       "point lumineux ne sait imiter.",
        "meshes": [
            maillage("Cadre", boite(0, 0, 2810, 620, 620, 40), ALU_ANODISE),
            maillage("Diffuseur", boite(0, 0, 2786, 580, 580, 8), NEON),
        ],
        "connectors": [{"type": "*", "main": True, "pos": [0, 0, 0]}],
        "lumieres": [
            {"type": "rectangle", "nom": "Dalle",
             "pos": [0, 0, 2782], "rot": [0, 0, 0],
             "taille": [580, 580], "couleur": "#f4f7ff",
             "intensite": 14, "eclat": 3.2},
        ],
    }


def bloc_downlight():
    return {
        "id": "downlight", "name": "Downlight encastre",
        "baseOffset": 0,
        "category": "Eclairage", "price": 65,
        "description": "Disque lumineux de 180 mm a 2,80 m, faisceau large "
                       "et penombre douce.",
        "meshes": [
            maillage("Collerette", cylindre(0, 0, 2795, 105, 30), ALU_ANODISE),
            maillage("Optique", cylindre(0, 0, 2778, 88, 6), NEON),
        ],
        "connectors": [{"type": "*", "main": True, "pos": [0, 0, 0]}],
        "lumieres": [
            {"type": "disque", "nom": "Downlight",
             "pos": [0, 0, 2774], "rayon": 88,
             "couleur": "#ffeacc", "intensite": 9, "eclat": 3.0,
             "angle": 58, "penombre": 0.65, "portee": 9000},
        ],
    }


def bloc_projecteur():
    return {
        "id": "projecteur-ies", "name": "Projecteur sur rail (IES)",
        "baseOffset": 0,
        "category": "Eclairage", "price": 145,
        "description": "Projecteur oriente, avec profil photometrique IES. "
                       "Le faisceau doit montrer un coeur marque et un bord "
                       "degrade, pas un disque uniforme.",
        "meshes": [
            maillage("Rail", boite(0, 0, 2900, 1200, 40, 40), LAQUE_NOIRE),
            maillage("Corps", cylindre(0, 0, 2720, 62, 190), LAQUE_NOIRE),
            maillage("Lentille", cylindre(0, 0, 2622, 52, 8), NEON),
        ],
        "connectors": [{"type": "*", "main": True, "pos": [0, 0, 0]}],
        "lumieres": [
            {"type": "spot", "nom": "Projecteur",
             "pos": [0, 0, 2618], "rot": [18, 0, 0], "rayon": 52,
             "couleur": "#fff2e2", "intensite": 16, "eclat": 4.0,
             "angle": 26, "penombre": 0.22, "portee": 12000,
             "ies": ies_faisceau(22.0)},
        ],
    }


def bloc_verre():
    """Une paroi de verre : le cas ou la transparence croise l'ombre."""
    return {
        "id": "paroi-verre", "name": "Paroi vitree",
        "category": "Essais", "price": 890,
        "description": "Verre teinte sur montants chrome. Verifie que la "
                       "transparence ne mange pas l'ombre portee.",
        "meshes": [
            maillage("Montant gauche", cylindre(-700, 0, 1000, 32, 2000), CHROME),
            maillage("Montant droit", cylindre(700, 0, 1000, 32, 2000), CHROME),
            maillage("Vitrage", boite(0, 0, 1050, 1400, 14, 1780), VERRE),
            maillage("Sabot", boite(0, 0, 20, 1500, 160, 40), ACIER_BROSSE),
        ],
        "connectors": [{"type": "*", "main": True, "pos": [0, 0, 0]}],
    }


# ─────────────────────────── assemblage ───────────────────────────

def construire():
    return {
        "name": "Banc d'essai du rendu",
        "units": "mm",
        "gridStep": 100,
        "currency": "EUR",
        "categories": ["Essais", "Eclairage"],
        "materials": [
            {"id": "chrome", "name": "Chrome poli", **CHROME},
            {"id": "acier", "name": "Acier brosse", **ACIER_BROSSE},
            {"id": "alu", "name": "Alu anodise", **ALU_ANODISE},
            {"id": "laque", "name": "Laque", **LAQUE_NOIRE},
            {"id": "caoutchouc", "name": "Caoutchouc", **CAOUTCHOUC},
            {"id": "verre", "name": "Verre teinte", **VERRE},
            {"id": "ecran", "name": "Ecran retro-eclaire", **ECRAN},
            {"id": "neon", "name": "Diffuseur lumineux", **NEON},
        ],
        "blocks": [
            bloc_vitrine(), bloc_machine_led(), bloc_verre(),
            bloc_dalle(), bloc_downlight(), bloc_projecteur(),
        ],
        "presets": [{
            "id": "banc", "name": "Banc complet",
            "description": "Toutes les matieres et tous les luminaires en place.",
            "items": [
                {"blockId": "essai-matieres", "pos": [0, 2200, 0], "rot": 0},
                {"blockId": "machine-led", "pos": [-1400, 0, 0], "rot": 0},
                {"blockId": "paroi-verre", "pos": [1400, 0, 0], "rot": 0},
                {"blockId": "dalle-plafond", "pos": [-1400, 0, 0], "rot": 0},
                {"blockId": "downlight", "pos": [1400, 0, 0], "rot": 0},
                {"blockId": "projecteur-ies", "pos": [0, -1600, 0], "rot": 0},
            ],
        }],
    }


if __name__ == "__main__":
    sortie = sys.argv[1] if len(sys.argv) > 1 else os.path.join("data", "library-rendu.json")
    donnees = construire()
    os.makedirs(os.path.dirname(sortie) or ".", exist_ok=True)
    with open(sortie, "w", encoding="utf-8") as f:
        json.dump(donnees, f, ensure_ascii=False, separators=(",", ":"))

    poids = os.path.getsize(sortie) / 1024.0
    lum = sum(len(b.get("lumieres", [])) for b in donnees["blocks"])
    print("%s  —  %d blocs, %d luminaires, %.0f Ko"
          % (sortie, len(donnees["blocks"]), lum, poids))
