# Configurateur Planet Fitness Pro

Visualisateur 3D en ligne d'équipements de musculation. Le client compose son plateau
dans son navigateur, à partir d'un catalogue préparé dans Rhino, puis partage un lien
ou demande un devis.

**Tout se pilote depuis Rhino.** Le plug-in
[`ConfigurateurPlanetFitnessPro`](../../ConfigurateurPlanetFitnessPro/README.md)
(dossier `C:\Users\Shadow\Downloads\ConfigurateurPlanetFitnessPro`) gère la bibliothèque,
les coloris, les dispositions types et la mise en ligne. Ce dossier-ci n'est que le site
publié : vous n'avez normalement jamais à y toucher.

```
Rhino 8  ─  plug-in Configurateur Planet Fitness Pro
   │         panneaux : Bibliothèque · Variantes · Dispositions · Publication
   │
   │  bouton « Publier en ligne »
   ▼
hébergement  ──►  site public  ──►  lien envoyé au client
                                          │
                                          ├─► composition partagée par lien
                                          ├─► iframe sur votre site
                                          ├─► image, OBJ, devis
                                          └─► composition JSON ──► réimport dans Rhino
```

## Ce que voit le client

- Un **catalogue** d'équipements rangés par famille, avec aperçu, référence et prix.
- Des **dispositions types** préparées dans Rhino — plateau cardio, circuit guidé,
  club complet — qu'il charge d'un clic comme point de départ.
- Le **magnétisme** : deux machines porteuses du même point d'insertion se rejoignent
  exactement, alignées et orientées.
- Le **clic droit** sur une machine posée : le catalogue ne montre plus que ce qui peut
  s'y raccorder, et un clic pose l'équipement déjà connecté.
- Les **coloris** : chaque machine peut proposer plusieurs teintes de capotage.
- La **nomenclature** et le total, mis à jour en direct, avec demande de devis.

## Démarrer en local

```bash
python configurateur-3d/tools/serve.py
```

<http://localhost:5180> — une bibliothèque de démonstration (13 équipements,
4 dispositions) est fournie pour montrer le configurateur avant d'y publier le vrai
catalogue.

## Gestes

| Action | Geste |
|---|---|
| Charger une disposition | menu « Partir d'une disposition », puis *Charger* |
| Poser une machine | clic sur une vignette, puis clic dans la scène |
| Poser en série | maintenir <kbd>Maj</kbd> au moment de poser |
| Machines compatibles | **clic droit** sur une machine posée |
| Déplacer / pivoter | gizmo, ou <kbd>G</kbd> / <kbd>R</kbd> |
| Dupliquer · Supprimer | <kbd>D</kbd> · <kbd>Suppr</kbd> |
| Annuler / rétablir | <kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd> |
| Recadrer | <kbd>F</kbd> |

Deux aimants indépendants dans la barre d'outils : celui des **points d'insertion**
(machines entre elles) et celui de la **grille** (pas de 100 mm par défaut).

## Format publié

Le plug-in écrit `data/library.json`. Sa structure, si vous devez la produire autrement :

```jsonc
{
  "name": "…", "units": "mm", "gridStep": 100, "currency": "€", "priceEnabled": true,
  "categories":     [{ "id": "Cardio", "name": "Cardio" }],
  "connectorTypes": [{ "id": "A", "name": "A — alignement latéral" }],
  "presets": [{                                   // dispositions types
    "id": "cardio", "name": "Plateau cardio", "featured": true,
    "items": [{ "blockId": "tapis-course", "pos": [0,0,0], "rot": 0 }]
  }],
  "blocks": [{
    "id": "tapis-course", "name": "Tapis de course", "category": "Cardio",
    "price": 4290, "ref": "PF-TC-01", "description": "…",
    "finishes":   [{ "id": "violet", "name": "Violet", "color": "#5B2D8E" }],
    "connectors": [{ "type": "A", "pos": [-950,0,400], "dir": [-1,0,0] }],
    "meshes":     [{ "color": "#2C3038", "paintable": true,
                     "positions": [], "normals": [], "indices": [] }]
  }]
}
```

`pos` est dans l'unité de la bibliothèque, dans le repère local du bloc ; `dir` est l'axe
du point d'insertion, orienté vers l'extérieur. Un maillage `paintable` suit le coloris
choisi par le client. Validation :

```bash
python tools/check_library.py data/library.json
```

## Réglages du site

`config.json` : titre, marque, e-mail de devis, mention de prix, et source des blocs
(`static` = fichier du site, `drive` = un dossier Google Drive — voir
`config.drive.exemple.json`).

| Paramètre d'URL | Effet |
|---|---|
| `?view=1` | lecture seule, le visiteur peut basculer en édition d'un clic |
| `?embed=1` | masque le catalogue, pour l'iframe |
| `#c=…` | la configuration elle-même, encodée dans le lien |

## Structure

```
configurateur-3d/
├── index.html              interface + politique CSP (périmètre réseau)
├── config.json             titre, marque, devis, source des blocs
├── assets/style.css
├── src/
│   ├── main.js             état, catalogue, dispositions, compatibles, devis
│   ├── viewer.js           scène Three.js (Z-up), pose, magnétisme, gizmo
│   ├── library.js          lecture du library.json → géométries, connecteurs, presets
│   ├── drive.js            source Google Drive bornée à un dossier
│   ├── thumbnails.js       vignettes du catalogue
│   ├── share.js            configuration ⇄ URL (deflate + base64url)
│   └── exporters.js        PNG, composition JSON, OBJ, devis
├── vendor/three/           Three.js embarqué — aucun CDN, aucun script tiers
├── data/library.json       catalogue publié
├── .github/workflows/      contrôle puis mise en ligne automatique
└── tools/
    ├── serve.py            serveur de développement sans cache
    ├── gen_demo_library.py bibliothèque de démonstration
    ├── check_library.py    validation d'un library.json
    └── check_drive_folder.py
```

Aucune dépendance réseau : Three.js est embarqué et la politique CSP interdit au
navigateur de charger quoi que ce soit d'autre que ce site.

> Les anciens scripts Python `rhino/` ont été retirés : le plug-in C# les remplace
> intégralement et évite deux implémentations divergentes du même format.

## Limites connues

- Le magnétisme ne corrige que la rotation **autour de Z**. Une machine à poser inclinée
  doit l'être dans Rhino.
- Pas de détection de collision générale : seul l'accrochage par clic droit évite de
  superposer deux machines.
- Les matériaux Rhino ne sont pas transférés — seules les couleurs d'affichage le sont,
  complétées par les coloris déclarés dans le panneau Variantes.
- Au-delà d'environ 400 machines, le lien de partage devient long : préférez alors
  l'export JSON.
