# Notes de développement

État du configurateur au commit `3a936cf`. Ce document existe pour qu'une
reprise — la vôtre, la mienne, celle d'un autre modèle — parte de ce qui a
déjà été payé plutôt que de le redécouvrir.

---

## Ce que c'est

Un configurateur 3D en ligne, publié sur GitHub Pages
(`https://scb1514.github.io/configurateur-3d/`), alimenté depuis Rhino par un
plug-in C# séparé. On y pose des équipements de salle de sport depuis une
bibliothèque, on trace des murs, on place des luminaires, on partage un lien.

**Contrainte de fond** : une politique de sécurité stricte interdit tout script
et toute image venus d'ailleurs que du site. Rien ne se charge depuis un CDN.
Chaque dépendance est recopiée dans `vendor/`, imports repointés sur la copie
locale de three. Une bibliothèque oubliée là, et c'est l'application entière
qui reste noire — c'est arrivé avec `three-bvh-csg`.

## Architecture

| Module | Rôle |
|---|---|
| `main.js` | état de l'application, catalogue, panneaux, historique |
| `viewer.js` | scène, sélection, gizmo, caméras, boucle de rendu |
| `render.js` | ambiances, sol, post-traitement, qualité |
| `library.js` | lecture des bibliothèques, matériaux, textures |
| `lumieres.js` | luminaires : sources, faisceaux, calques, budget |
| `panneau-lumieres.js` | interface des lumières (écrit par DeepSeek, relu) |
| `batiment.js` | murs, ouvertures, plan de coupe, tracé |
| `core/topologie.js` | graphe des murs — source de vérité, en mètres |
| `core/osnap.js` | accrochages : « sur quoi suis-je ? » |
| `core/reperage.js` | repérage intelligent : « à quoi suis-je aligné ? » |
| `textures-procedurales.js` | matières fabriquées au chargement |

Bibliothèques dans `data/` : `library.json` (démo), `library-crossfit.json`
(par défaut, cf. `config.json`), `library-salle.json`, `library-rendu.json`
(banc d'essai des matières et des luminaires).

---

## Les pièges déjà payés

Ceux-ci ont coûté du temps. Les relire vaut mieux que les revivre.

**Un objet three retient la caméra qu'on lui donne à sa construction.** Cela
vaut pour `RenderPass`, `GTAOPass` et `TransformControls`. Le mode plan échange
la caméra perspective contre une orthographique : sans resynchronisation à
chaque image, le compositeur rend avec l'ancienne et le gizmo se projette à
côté de l'objet. Corrigé aux trois endroits — s'en souvenir pour tout nouvel
objet qui prend une caméra en paramètre.

**Une caméra orthographique n'a pas de `fov`.** Toute comparaison avec
`undefined` donne `NaN`, et un test de mouvement basé dessus bascule en
permanence du côté « ça bouge ». L'occlusion ne revenait jamais après un
passage par le plan.

**La scène ne se redessine qu'à la demande.** Tout code qui change ce qui est
affiché doit appeler `demanderImage()` ou `marquerOmbres()`. Un oubli ne casse
rien de visible tout de suite : le battement de sécurité (4 images/s) rattrape
en un quart de seconde. C'est délibéré, et c'est ce qui rend le système sûr.

**Une exception dans la boucle tuait tout.** `requestAnimationFrame` est
appelé en premier, donc la boucle continue de tourner mais son corps échoue à
chaque tour : plus de rendu, plus de gizmo, aucun message. La boucle est
maintenant gardée. Ne pas retirer ce `try`.

**L'anisotropie exige des tangentes, donc des coordonnées de texture.** Sans
elles, three compile un nuancier invalide et la scène ENTIÈRE part au noir —
pas seulement la pièce fautive. Un garde-fou l'ignore désormais avec un
avertissement.

**Épaisseur et distance d'atténuation sont des longueurs.** Passées en
millimètres à un moteur qui compte en mètres, un verre de 26 cm se comporte
comme un bloc de 260 m.

**Le test de fermeture d'un maillage doit comparer des POSITIONS.** Un cube
exporté porte vingt-quatre sommets et non huit — chaque face a les siens pour
que sa normale soit franche. Un test par indices déclare tout ouvert.

**Interroger le DOM avant de suspecter la scène.** Une forme claire en
surimpression, cherchée quatre fois dans le rendu 3D, était un `<div>`.

---

## Ce qui a été appris du rendu de référence

La Porsche de dyadstudios, mesurée sur place : **1 766 649 triangles par
image**, cinquante fois notre scène, et pourtant plus fluide. Le nombre de
triangles n'est pas le sujet.

Ses fichiers disent tout — `bakeExterior2k`, `bakeSeats2k` : **son éclairage
est précalculé dans des textures**. Elle ne calcule pas la lumière, elle la
relit. Elle rend à un pixel pour un pixel, et ne lie qu'une seule cible de
rendu.

Ce qu'on en a tiré : pixel ratio 1, chemin court vers l'écran pendant le
mouvement, tampon de dessin non conservé. Résultat mesuré : 13 → 29 images par
seconde sur seize machines en rotation.

Ce qu'on ne peut pas reprendre : la cuisson. Elle suppose une scène figée. Ici
les machines se posent au clic — il n'y a rien à cuire. **Piste ouverte** :
cuire l'occlusion *par bloc*, une fois, dans le plug-in Rhino, et la livrer
avec la bibliothèque.

---

## Licences

Les textures d'`data/textures/` viennent d'Architextures. Leurs conditions
interdisent expressément de republier les images sur un autre site et
d'automatiser le téléchargement. Ce dépôt étant publié, elles sont **exclues
par `.gitignore`** et l'application se rabat sur `textures-procedurales.js`
quand le fichier manque — le nom décide de la matière de remplacement.

La voie légitime pour vos vraies textures : le plug-in Rhino d'Architextures,
avec un abonnement Pro. Elles entrent alors dans la bibliothèque sous votre
licence.

---

## Délégation

Trois modèles, trois usages. `gemini-delegate` pour ingérer un gros volume et
n'en rendre que peu — audits de diff, dépouillage de fichiers three.
`deepseek-delegate` pour écrire un module spécifiable et vérifiable — le
panneau des lumières et le catalogue en viennent, relus ligne à ligne ici.

Ce qu'ils ne font pas : les arbitrages. Et **une revue automatique propose des
pistes, elle ne constate pas** — sur huit risques signalés par Gemini dans un
diff, six étaient faux après vérification dans le code.

---

## En cours

- **Sélection multiple** : le moteur a `_selection` avec gestion du Maj, mais
  un gizmo commun à plusieurs objets n'est pas vérifié.
- **Rectangle de capture** : absent, et c'est le geste le plus attendu en plan.
- **Repérage** : acquisition manuelle au Ctrl, perpendiculaires, réglages
  exposés au panneau (ils existent dans le module). Les tangentes sont
  faites — et elles ont demandé une exception à la règle de priorité :
  un cercle est polygonisé en vingt-quatre murs, dont les sommets et les
  milieux sont des points « réels » pour le graphe mais des artefacts pour
  l'utilisateur. Le milieu d'un segment tombe à quatre centimètres du vrai
  contact. La tangente passe donc AVANT les accrochages de points, à
  tolérance réduite de moitié pour que l'exception ne déborde pas. Le cercle
  idéal est retenu dans `batiment.cercles`, hors du graphe qui l'oublie.
- **Interface** : trois panneaux flottants qui se recouvrent. Les réunir en un
  panneau à onglets à droite.
- **Ambiance « Intérieur »** : les quatre existantes éclairent comme un studio
  et délavent une salle fermée dont les luminaires devraient faire le travail.
- **Plan de coupe** : rend trop pâle, le poché s'écrase sous l'ambiance claire.

## Vérifier, toujours

Le code n'est pas fait parce qu'il est écrit. Un script de patch a échoué sur
une ancre avant d'écrire le fichier, et le correctif suivant a été rapporté
comme posé alors que la méthode n'existait pas. C'est la mesure dans le
navigateur qui l'a dit.
