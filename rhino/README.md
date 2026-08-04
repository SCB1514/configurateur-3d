# Côté Rhino — publier vos blocs vers le configurateur

Cinq commandes, installées une fois pour toutes.

## Installation (une seule fois)

Dans Rhino : `_RunPythonScript` → `rhino/installer.py`.

Les commandes suivantes deviennent disponibles dans la ligne de commande :

| Commande | Rôle |
|---|---|
| `PointInsertion` | poser un point d'insertion A / B / C sur la géométrie |
| `VerifierBibliotheque` | contrôler les blocs et les connexions avant publication |
| `ExporterBibliotheque` | écrire un `library.json` sur le disque |
| `PublierBibliotheque` | publier sur GitHub — le site se met à jour tout seul |
| `ImporterComposition` | relire la composition d'un client dans Rhino |

Relancez `installer.py` si vous déplacez le dossier.

---

## Les points d'insertion, en deux minutes

Un point d'insertion est **un petit bloc, imbriqué dans vos blocs produits**,
nommé `Point d'insertion A` (ou B, C, D…). Deux blocs porteurs de la **même
lettre** s'aimantent dans le configurateur : les deux points se superposent et
les axes Z se font face.

```
   Caisson bas                          Caisson bas
   ┌───────────┐                        ┌───────────┐
   │           │● A →              ← A ●│           │
   │           │                        │           │
   └───────────┘                        └───────────┘
        les deux points A se rejoignent, les meubles s'alignent
```

**L'axe Z du point pointe vers l'extérieur du bloc**, là où viendra le voisin.
C'est la seule règle à retenir : le configurateur met les Z en vis-à-vis.

- Un point **vertical** (dessus d'un caisson, dessous d'un plan) laisse
  l'orientation libre : seule la hauteur est imposée.
- Un point **horizontal** aligne aussi la rotation : deux meubles côte à côte
  gardent leur façade du même côté.
- Utilisez **une lettre par type de liaison** : A pour les flancs de meubles bas,
  B pour « plan de travail sur caisson », C pour les éléments hauts…
  Deux usages différents sous la même lettre rendraient n'importe quoi
  connectable à n'importe quoi.

Noms reconnus : `Point d'insertion A`, `Point insertion A`, `PI_A`, `PT INS A`.
Ces blocs ne sont jamais maillés ni publiés comme produits : ils ne servent
qu'aux connexions.

---

## Le déroulé complet

### 1. Poser les points

```
PointInsertion
```
→ lettre (A, B, C…), puis un point, puis la direction (un second point vers
l'extérieur, ou Entrée pour +Z). Enchaînez autant de points que nécessaire,
Entrée pour terminer.

La définition `Point d'insertion X` est créée automatiquement au premier usage,
sur le calque *Points d'insertion*.

### 2. Créer le bloc produit

Sélectionnez **la géométrie du produit ET ses points d'insertion**, puis `_Block`.
Le point de base du bloc devient son point d'accroche dans le configurateur —
choisissez-le au centre de l'emprise, au niveau du sol.

### 3. Renseigner prix et finitions (facultatif)

Soit des **attributs utilisateur** sur un objet à l'intérieur du bloc :
`categorie`, `prix`, `ref`, `description`, `finition` (1 sur les pièces qui
changent de couleur), `empilable`.

Soit un fichier **`catalogue.csv`** à côté du `.3dm` — il a priorité :

```csv
bloc;categorie;prix;ref;description;finitions
Caisson bas 600;Caissons bas;222;CB-600;2 portes;Blanc:#eeece7|Chêne:#c69b63
```

### 4. Contrôler

```
VerifierBibliotheque
```
Liste les blocs qui partiront, leurs points, ce qui pourra s'aimanter avec quoi,
et **signale les noms mal orthographiés** qui ne seront pas reconnus. Ne modifie
rien.

### 5. Publier

```
PublierBibliotheque
```

Première fois : la commande demande le compte GitHub, le dépôt, le chemin
(`data/library.json`) et un jeton. Tout est mémorisé dans
`%APPDATA%\Configurateur3D\publication.json` — **hors du dépôt**, le jeton n'est
donc jamais versionné.

Créer le jeton : <https://github.com/settings/tokens> → *Fine-grained tokens* →
dépôt concerné → permission **Contents : Read and write**.

Ensuite, un seul appel suffit : export → envoi → GitHub Actions redéploie Pages.
Le lien partagé à vos clients pointe sur la version à jour en 30 à 60 secondes.

### 6. Récupérer une composition client

Le client clique **JSON** dans le configurateur et vous envoie le fichier.

```
ImporterComposition
```
→ les instances sont reposées à l'identique sur le calque *Configuration importée*,
prêtes pour le chiffrage, les plans ou la fabrication.

---

## Réglages

En tête de `configurateur_lib.py` :

| Réglage | Effet |
|---|---|
| `MESH_QUALITY` | `"render"` (défaut), `"smooth"`, ou `"coarse"` si le fichier dépasse quelques Mo |
| `DECIMALS` | arrondi des coordonnées (3 par défaut) |
| `SKIP_PREFIX` | les définitions commençant par `_` ne sont pas publiées |
| `CURRENCY`, `PRICE_ENABLED` | devise, et affichage des prix dans le configurateur |

## En cas de souci

| Symptôme | Cause habituelle |
|---|---|
| Un bloc n'apparaît pas | nom commençant par `_`, ou aucune géométrie maillable (courbes seules) |
| Les blocs ne s'aimantent pas | pas de point d'insertion, ou lettres différentes → `VerifierBibliotheque` |
| Ils s'aimantent à l'envers | l'axe Z du point ne pointe pas vers l'extérieur |
| Tout se connecte à tout | une même lettre utilisée pour deux liaisons différentes |
| `ECHEC` à la publication | jeton sans droit *Contents: Read and write*, ou dépôt/branche inexistants |
| Changer de dépôt | supprimer `%APPDATA%\Configurateur3D\publication.json` |
