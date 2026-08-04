# Configurateur 3D à partir de blocs Rhino

Application web qui laisse n'importe qui composer en 3D, dans son navigateur, à partir
d'une **bibliothèque de blocs Rhino pré-enregistrés** — puis partager le résultat
par un simple lien.

```
Rhino (.3dm, définitions de blocs)
        │  rhino/export_blocks_to_library.py
        ▼
   data/library.json ──────► application web (catalogue + scène 3D + devis)
                                     │
                                     ├─► lien partageable   …/#c=zXY…
                                     ├─► iframe intégrable sur votre site
                                     ├─► image PNG / maillage OBJ
                                     └─► composition.json ──► rhino/import_composition.py ──► Rhino
```

Aucun serveur applicatif, aucune base de données : ce sont des fichiers statiques.
**La configuration entière est encodée dans l'URL** (compressée), donc un lien suffit
à rejouer exactement la composition chez le destinataire.

---

## 1. Démarrer en local

```bash
python -m http.server 5180 --directory configurateur-3d
```

Puis ouvrir <http://localhost:5180>. Une bibliothèque de démonstration
(cuisine modulaire, 17 blocs) est déjà fournie.

> Un serveur est nécessaire : les modules ES et `fetch()` ne fonctionnent pas
> en `file://`.

## 2. Mettre en ligne

N'importe quel hébergement statique convient — glisser le dossier `configurateur-3d`
sur **Netlify Drop**, **Vercel**, **GitHub Pages**, ou dans un dossier de votre
serveur web. Le lien de partage reprend automatiquement l'adresse publique.

> **Google Drive ne peut pas héberger la page elle-même.** Google a supprimé
> l'hébergement web de Drive en 2016, et le contournement le plus connu
> (DriveToWeb) a fermé le 31 mai 2026. En revanche, Drive convient très bien
> pour héberger **la bibliothèque de blocs** : voir la section 3.

---

## 2 bis. Bibliothèque dans un dossier Google Drive

L'application sait lire ses blocs directement dans **un dossier Drive, et un seul**.
Vous déposez vos `library.json` dans ce dossier, vous les mettez à jour quand vous
voulez : le configurateur en ligne suit, sans redéploiement.

### Mise en place (10 minutes)

1. **Créer le dossier** dans votre Drive, par exemple `Bibliothèque configurateur`,
   et y déposer le `library.json` produit par le script d'export Rhino.
   Vous pouvez en mettre plusieurs (`cuisine.json`, `bureau.json`…) : un sélecteur
   apparaît alors en haut du catalogue.
2. **Partager le dossier** : *Partager → Accès général → Tous les utilisateurs
   disposant du lien → Lecteur*. Indispensable : vos clients ne sont pas connectés
   à Google.
3. **Créer une clé API** sur <https://console.cloud.google.com> :
   *API et services → Activer l'API Google Drive*, puis *Identifiants → Créer une
   clé API*. **Restreindre la clé** : référents HTTP = le domaine de votre site,
   API autorisées = Google Drive uniquement.
4. **Renseigner `config.json`** (modèle prêt : `config.drive.exemple.json`) :

```json
{
  "source": {
    "type": "drive",
    "folderId": "https://drive.google.com/drive/folders/1AbC…",
    "apiKey": "AIza…",
    "libraryFile": "library.json"
  }
}
```

5. **Vérifier avant mise en ligne** — le script rejoue exactement ce que fera le
   navigateur du visiteur (listing, contrôle du dossier parent, téléchargement,
   validation du contenu) :

```bash
python tools/check_drive_folder.py
```

### Périmètre d'accès — ce qui est garanti, et ce qui ne l'est pas

Le bouton **Confidentialité** en bas du catalogue affiche ce tableau au visiteur.

**Garanti par le code et par le navigateur :**

| | |
|---|---|
| Un seul dossier | chaque fichier renvoyé par Google est recontrôlé côté client : s'il n'a pas votre dossier dans ses `parents`, il est écarté. Les sous-dossiers ne sont pas parcourus. |
| Aucun téléchargement arbitraire | seuls les identifiants issus du listing de ce dossier sont téléchargeables ; un autre identifiant est refusé **sans même émettre de requête**. |
| Le reste de votre Drive est hors d'atteinte | l'application ne demande jamais de connexion Google ni de jeton OAuth. Une clé API ne donne accès qu'aux fichiers publics. |
| Aucune écriture | le module Drive n'a aucune méthode d'écriture ; rien ne peut être modifié ni supprimé. |
| Aucune fuite ailleurs | la politique CSP de `index.html` n'autorise que votre site et `www.googleapis.com`. Tout autre appel réseau — CDN, traceur, autre API Google — est bloqué par le navigateur. Aucun script tiers ne peut être chargé (Three.js est embarqué dans `vendor/`). |
| Rien n'est envoyé automatiquement | la composition reste dans le navigateur ; les exports et le devis partent du poste du client. |

**Ce qui n'est PAS garanti — à savoir avant de publier :** un dossier partagé
« toute personne disposant du lien » est **non répertorié, pas confidentiel**.
La clé API et l'identifiant du dossier sont lisibles dans le code de la page :
quelqu'un de motivé peut donc télécharger les `library.json` de ce dossier —
et rien d'autre. **N'y mettez que ce que vous acceptez de montrer à un prospect :
la bibliothèque publiée, jamais vos `.3dm`, vos tarifs internes ou vos projets clients.**

Si la bibliothèque elle-même doit rester privée, il faut une authentification :
hébergez le `library.json` derrière l'accès protégé de votre site (`type: "static"`,
le fichier est alors servi par votre serveur, qui décide qui y a droit).

---

## 3. Publier votre propre bibliothèque depuis Rhino

### 3.1 Préparer le fichier Rhino

1. Modélisez chaque élément puis transformez-le en **bloc** (`_Block`).
   Le **point de base** du bloc devient son point d'accroche dans le configurateur —
   choisissez-le au centre de l'emprise, au niveau du sol.
2. Orientez les blocs dans le repère Rhino habituel (Z vers le haut) ;
   le configurateur conserve exactement le même repère et les mêmes unités.
3. Les définitions dont le nom commence par `_` sont ignorées à l'export.

### 3.2 Renseigner catégorie, prix, finitions

Deux méthodes, cumulables.

**a) Attributs utilisateur** posés sur un objet *à l'intérieur* du bloc
(Propriétés → Attributs utilisateur) :

| Clé | Effet |
|---|---|
| `categorie` | onglet du catalogue |
| `prix` | prix unitaire (nombre) |
| `ref` | référence commerciale |
| `description` | texte de l'infobulle |
| `finition` | `1` sur les pièces dont la couleur suit la finition choisie |
| `empilable` | `0` pour interdire l'empilement |

**b) Fichier `catalogue.csv`** placé à côté du `.3dm` (prioritaire) :

```csv
bloc;categorie;prix;ref;description;finitions
Caisson bas 600;Caissons bas;222;CB-600;Caisson 2 portes;Blanc:#eeece7|Chêne:#c69b63
Plan de travail 1200;Plans;187;PT-1200;Stratifié 38 mm;Noir:#2c3036|Béton:#9aa0a6
```

Sans finition déclarée, le bloc garde les couleurs d'affichage de Rhino
(couleur d'objet ou de calque).

### 3.3 Exporter

Dans Rhino : `_RunPythonScript` → `rhino/export_blocks_to_library.py`.
Le script maille toutes les définitions de blocs (Brep, extrusions, SubD, maillages,
blocs imbriqués), regroupe les faces par couleur et écrit un `library.json`.

Copiez le fichier obtenu dans `configurateur-3d/data/library.json`,
ou déposez-le dans votre dossier Google Drive de bibliothèque (section 2 bis).

**Poids :** comptez ~5 à 40 Ko par bloc. Au-delà de ~8 Mo, réglez
`MESH_QUALITY = "coarse"` en tête du script, ou simplifiez les blocs
(les congés, vis et détails millimétriques n'apportent rien à l'écran).

### 3.4 Récupérer la composition dans Rhino

Le client clique **JSON** → il vous envoie `…-composition.json`.
Dans Rhino : `_RunPythonScript` → `rhino/import_composition.py`, choisir le fichier.
Les instances de blocs sont reposées à l'identique (position, rotation, échelle)
sur le calque *Configuration importée*, prêtes pour le chiffrage ou les plans.

---

## 4. Personnalisation

`config.json`, à la racine :

```json
{
  "title":      "Cuisine modulaire",
  "brand":      "Ma société",
  "quoteEmail": "contact@ma-societe.fr",
  "priceNote":  "Estimation indicative, hors pose et livraison.",
  "source":     { "type": "static", "library": "data/library.json" }
}
```

`source.type` vaut `static` (fichier servi par le site) ou `drive`
(un dossier Google Drive — section 2 bis). Il n'existe pas d'autre mode :
une URL externe arbitraire est refusée par `library.js`.

Couleurs de l'interface : variables CSS en tête de `assets/style.css`
(`--accent`, `--bg`, `--panel`…).

### Paramètres d'URL

| Paramètre | Effet |
|---|---|
| `?lib=…` | choisit une bibliothèque **parmi celles de la source** (chemin configuré, ou identifiant d'un fichier du dossier Drive) |
| `?view=1` | lecture seule (le visiteur peut basculer en édition d'un clic) |
| `?embed=1` | masque le catalogue — pour l'iframe |
| `#c=…` | la configuration elle-même |

Intégration sur un site (bouton **Partager le lien** → *Intégrer sur un site*) :

```html
<iframe src="https://…/?view=1&embed=1#c=zXY…"
        width="100%" height="620" style="border:0" allowfullscreen></iframe>
```

---

## 5. Utilisation

| Action | Geste |
|---|---|
| Poser un bloc | clic sur une vignette, puis clic dans la scène |
| Poser en série | maintenir <kbd>Maj</kbd> au moment de poser |
| Empiler | survoler la face supérieure d'un bloc déjà posé (hauteur exacte) |
| Sélectionner | clic sur un bloc |
| Déplacer / pivoter | flèches du gizmo, ou <kbd>G</kbd> / <kbd>R</kbd> |
| Pivoter de 90° | <kbd>R</kbd> (<kbd>Maj+R</kbd> dans l'autre sens) |
| Dupliquer | <kbd>D</kbd> · Supprimer <kbd>Suppr</kbd> |
| Annuler / rétablir | <kbd>Ctrl+Z</kbd> / <kbd>Ctrl+Y</kbd> |
| Recadrer | <kbd>F</kbd> |

Le panneau de droite tient à jour la **nomenclature**, l'encombrement et le
**total estimé** ; le bouton *Demander un devis* prépare un e-mail contenant le
récapitulatif et le lien 3D. La configuration en cours est sauvegardée
automatiquement dans le navigateur.

---

## 6. Format `library.json`

```jsonc
{
  "name": "Ma gamme", "units": "mm", "currency": "€",
  "priceEnabled": true, "gridStep": 50,          // pas d'aimantation, en unités biblio
  "categories": [{ "id": "Caissons", "name": "Caissons" }],
  "blocks": [{
    "id": "caisson-bas-600", "name": "Caisson bas 600",
    "category": "Caissons", "price": 222, "ref": "CB-600",
    "description": "600 × 580 × 820 mm",
    "finishes": [{ "id": "chene", "name": "Chêne", "color": "#c69b63" }],
    "meshes": [{
      "color": "#e8e6e1", "opacity": 1, "paintable": true,
      "positions": [x,y,z, …], "normals": [nx,ny,nz, …], "indices": [a,b,c, …]
    }]
  }]
}
```

Le format est volontairement trivial : n'importe quelle autre source
(Grasshopper, script maison, autre modeleur) peut produire ce fichier.
`tools/gen_demo_library.py` en est un exemple complet et exécutable.

---

## 7. Structure

```
configurateur-3d/
├── index.html              interface + politique CSP (périmètre réseau)
├── config.json             marque, source des blocs, e-mail de devis
├── config.drive.exemple.json   modèle pour une source Google Drive
├── assets/style.css
├── src/
│   ├── main.js             état, sources, catalogue, nomenclature, devis
│   ├── viewer.js           scène Three.js (Z-up), pose, empilement, gizmo
│   ├── library.js          lecture du library.json → géométries
│   ├── drive.js            accès Drive borné à un dossier (voir en-tête du fichier)
│   ├── thumbnails.js       vignettes du catalogue, rendues à la volée
│   ├── share.js            configuration ⇄ URL (deflate + base64url)
│   └── exporters.js        PNG, composition JSON, OBJ, récapitulatif
├── vendor/three/           Three.js embarqué (aucun CDN, aucun script tiers)
├── data/library.json       bibliothèque publiée (démo fournie)
├── rhino/
│   ├── export_blocks_to_library.py    Rhino → library.json
│   └── import_composition.py          composition JSON → Rhino
└── tools/
    ├── gen_demo_library.py            bibliothèque de démonstration
    └── check_drive_folder.py          diagnostic de la source Drive
```

Aucune dépendance réseau : Three.js est embarqué dans `vendor/three/`, et la
politique CSP de `index.html` interdit au navigateur de charger quoi que ce soit
d'autre que ce site et l'API Drive. L'application fonctionne hors-ligne en
mode `static`.

## 8. Limites connues

- Pas de gestion multi-utilisateurs ni de sauvegarde côté serveur : le lien est la donnée.
  Au-delà de ~400 éléments, l'URL devient longue (préférez alors l'export JSON).
- Les blocs sont posés tels quels : pas de contraintes d'assemblage ni de collisions.
  Un système de points d'accrochage peut être ajouté dans `viewer.js` (`_dropPoint`).
- Les matériaux Rhino ne sont pas transférés — seules les couleurs d'affichage le sont,
  complétées par les finitions déclarées au catalogue.
