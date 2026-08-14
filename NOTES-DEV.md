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

**Le coin d'un mur ne se calcule PAS avec la normale canonique du voisin.**
`PlanGraph.cornerPoints(wallId, end)` mitre le coin de deux murs en
intersectant leurs faces `left`/`right` — mais ces faces doivent être
exprimées dans le repère LOCAL de chaque mur à CE nœud (`left =
perp(dInto)`, où `dInto` pointe vers le nœud depuis l'autre extrémité), et
non dans le repère CANONIQUE fixe A→B (`wallFrame(w).n`). La raison : dans
une polyligne tracée normalement, deux murs consécutifs partagent un nœud
qui est le `b` du premier et le `a` du second — une asymétrie systématique,
pas un cas rare. Utiliser le repère canonique du voisin pour ce pairage
revient à confondre « la gauche du voisin » avec « la face du voisin qui
touche réellement ce coin », qui NE SONT PAS la même chose dès que le
voisin touche le nœud par son extrémité `a`. Le symptôme : un chevauchement
en biais à l'angle, visuellement un chanfrein à 45°, sur pratiquement tous
les coins d'une polyligne. Mesuré, pas supposé : un test direct sur un
virage en L donne des coins strictement joints avec le repère local, et
des coins désalignés avec le repère canonique, sur les quatre
configurations d'angle testées. Le correctif introduit `_decalagesLocaux`
qui convertit les décalages canoniques de justification (`facesMur`) en
décalages locaux avant tout calcul de coin — le repère canonique reste
correct pour tout ce qui ne pairte PAS deux murs entre eux
(`openingOutline`, l'aperçu d'un mur seul).

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

**Un champ ajouté à un mur (justification, verrou) doit être ajouté à
`Batiment.serialiser()`/`restaurer()`, pas seulement à `addWall`.**
L'historique (undo/redo) sérialise le graphe entier à chaque geste ; un champ
absent de ces deux fonctions survit à la création mais disparaît au premier
Ctrl+Z — trouvé après coup en relisant, pas en cherchant.

**Pas de dalle ni de plafond automatiques en pièce fermée.** Décision
délibérée, pas un oubli : `_dalle()` et ses matériaux ont été retirés de
`generer3D()`. Si le besoin revient, le repère est `detectRooms()`, toujours
là pour les statistiques (« X pièce(s) ») — seule la génération de géométrie
a été retirée.

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

- **Gumball (Rhino) — deux comportements portés, le reste en réserve** :
  analysé contre https://docs.mcneel.com (page Gumball complète). FAIT :
  copie par Alt pendant le geste (translate/rotate/scale, items ET murs —
  `Viewer._altCopie`/`_restaurerOriginal`, `Batiment.copierMur`,
  `onGizmoCopy`) ; pivot aligné sur l'objet seul (`Viewer._poserPivot`
  bascule `gizmo.setSpace('local'|'world')`, angle lu sur `obj.rotation.z`
  pour un item, sur `Batiment.angleMur()` pour un mur — un mur n'a pas de
  rotation propre sur son maillage). Conçu avec DeepSeek (`deepseek-v4-pro`,
  22 325 tokens de sortie, $0,0245, hors quota Anthropic), relu et corrigé
  ligne à ligne avant intégration — trois défauts trouvés à la relecture :
  l'échelle d'un item peut être un tableau `[sx,sy,sz]` (voir `resizeAxis`),
  et `(tableau) * dSca` donne `NaN` sans garde explicite ; les luminaires
  n'ont pas de pendant « copie » et auraient été mutées en silence sans
  exclusion explicite ; la saisie numérique au clic (`applyGizmoAxis`)
  bougeait encore sur les axes du MONDE une fois le pivot passé en espace
  local, un angle tapé sur la poignée « longueur du mur » serait parti de
  travers. Les trois corrigés avant vérification.
  Contrainte de distance/angle tapée PENDANT le glisser : FAIT dans une
  seconde passe (DeepSeek, deepseek-v4-pro, 18 076 tokens de sortie,
  $0,0181). Glisser une poignée d'axe simple, taper un nombre, Entrée SANS
  lâcher la souris, continuer à glisser : la suite du geste se contraint
  aux multiples de ce nombre (distance le long de l'axe pour translate,
  degrés pour rotate — pas pour scale, absent de la doc Rhino sur ce
  point). Bulle flottante qui suit le curseur pendant la frappe
  (`_majIndicateurContrainte`/`_cacherIndicateurContrainte`).
  Défaut trouvé et corrigé avant vérification, plus grave que les trois
  précédents : `main.js` porte un écouteur clavier global où Retour
  arrière SUPPRIME l'objet sélectionné et Échap désélectionne. Le premier
  jet utilisait `e.stopPropagation()` pour empêcher ce doublon — TESTÉ,
  et le mur a bel et bien été supprimé pendant qu'on corrigeait une
  frappe. `stopPropagation()` n'arrête que la PROPAGATION vers d'autres
  éléments, pas les autres écouteurs du MÊME élément (`window` ici, les
  deux écouteurs y sont posés) : il fallait `stopImmediatePropagation()`.
  Reproduit puis corrigé, avec la vérification inverse (Échap SANS frappe
  en cours continue de désélectionner normalement, pour ne pas avaler un
  raccourci qui ne le concernait pas).
  Non repris (réserve, hors édition de géométrie qui reste hors sujet) :
  les poignées de plan/rotation/échelle affichées SIMULTANÉMENT (Rhino ne
  bascule jamais d'outil, ce projet le fait toujours via la barre
  d'outils — refonte plus lourde) ; double-clic pour reloger le pivot sans
  bouger l'objet ; le menu du gumball (Reset, Align to CPlane/World, Drag
  Strength) ; l'échelle non-uniforme par défaut au glisser (Scale1D — le
  modèle de données le permet déjà pour les items via `resizeAxis`, pas
  encore pour les murs).
  Limite pré-existante repérée en relisant, pas introduite ici : en
  sélection multiple incluant plusieurs murs, seul `_wallEdit` (le dernier
  mur sélectionné) reçoit `finGesteMur`/régénération dédiée à la fin du
  geste — les autres gardent un `_gesteMur` mémorisé qui fausserait leur
  PROCHAIN geste. `_regenThrottle`/`_regenImmediate` régénèrent déjà TOUS
  les murs à chaque frame donc le rendu reste correct ; seule la mémoire
  du geste suivant est concernée. À corriger si un vrai geste multi-murs
  simultané devient un usage courant.
- **Sélection multiple** : FAIT. Le gizmo s'accroche désormais à un pivot
  invisible posé au centre de la bounding box de la sélection
  (`Viewer._pivot`), jamais à l'objet lui-même — items, murs, ou un mélange
  des deux dans la même sélection, tous rejoués depuis leurs positions de
  départ (`_captureDepart`), jamais cumulés image après image. Un mur reçoit
  désormais rotation et échelle en plus de la translation (avant : translation
  seule) ; le geste est reporté au graphe topologique via `Batiment
  .transformerMur()`. Vérifié dans le navigateur : translation, rotation 90°
  et échelle ×2 sur un mur donnent des positions de nœuds exactes ; une
  sélection mixte (un mur + un item) bouge des deux côtés en un seul geste.
- **Verrouillage** (module 4.1 de la spec) : FAIT, items et murs. Un mur
  verrouillé refuse `_scinder`/`_deplacerExtremite`/`_aligner`/le glisser de
  poignée ; un item verrouillé refuse le gizmo (`onTransform` le remet à sa
  place). Boutons dans les deux panneaux d'inspection.
- **Copier par geste** (module 1.2) et **Créer similaire** (module 4.2) :
  FAITS. `Maj+D` fait suivre un fantôme translucide de la sélection au
  curseur, un clic commet, `Échap` clôt le geste en un seul `pushHistory`
  (pas un par copie). `C` pose un exemplaire dont blockId/finish/couleur
  viennent de la sélection, indépendant dès sa création.
- **Sélection façon Rhino** (analysé contre
  https://www.rhino3d.com/docs/guides/user-guide/selection/ — hors sujet,
  volontairement : toute sélection de SOUS-objets, cette appli n'édite pas
  de NURBS/SubD/maillage). FAIT pour les items de bibliothèque
  (`Viewer`, DeepSeek deepseek-v4-pro, $0,0228, hors quota Anthropic) :
  - **Rectangle de capture** — enfin fait. Glissé vers la DROITE = fenêtre
    (trait plein, objets ENTIÈREMENT dedans) ; vers la GAUCHE = recoupement
    (pointillé, moindre chevauchement suffit) — exactement la convention
    Rhino. Aperçu en `<div>` écran, projection des 8 coins de la bounding
    box de chaque objet via `.project(camera)` (le même patron que
    `coteSous`, déjà dans le fichier). Piège d'architecture identifié et
    câblé AVANT la délégation (sans quoi le geste aurait cassé la rotation
    caméra à la souris) : OrbitControls tourne la vue au clic gauche
    glissé par défaut (déjà coupé en mode plan via `enableRotate=false`,
    mais actif en 3D/iso) — `_onDown` gèle `enableRotate` dès qu'une
    fenêtre démarre sur du vide, `_onUp` la restaure à sa valeur
    mémorisée (pas à `true` en dur, pour ne pas la rallumer en mode plan).
  - **Maj = ajoute TOUJOURS, Ctrl/Cmd = retire TOUJOURS** — remplace
    l'ancien bascule unique (Ctrl OU Maj faisaient la même chose : ajouter
    si absent, retirer si présent). Un Maj-clic sur un objet déjà choisi
    reste maintenant sans effet au lieu de le désélectionner ; un
    Ctrl-clic sur du vide ne fait plus rien.
  Défaut trouvé à l'intégration (pas dans le premier jet de DeepSeek,
  hors de son contexte puisqu'absent de l'extrait envoyé) : `_onUp`
  porte déjà un retour anticipé sur tout mouvement > 5px (« orbite, pas un
  clic »), placé AVANT l'endroit où la résolution de la fenêtre allait
  être insérée — une vraie fenêtre glissée de plus de 5px n'aurait jamais
  été atteinte, jetée par ce retour avant même d'être vue. Repéré en
  relisant le point d'insertion exact dans le fichier réel (pas dans
  l'extrait fourni), corrigé en plaçant la résolution AVANT ce retour.
  Vérifié à la main, pas à l'œil : projection des 8 coins d'un objet à
  l'écran mesurée directement (pas déduite de son centre — un rectangle
  construit sur seulement 2 coins diagonaux du volume 3D ne correspond
  PAS à sa silhouette écran réelle, erreur faite une fois pendant la
  vérification elle-même et corrigée en refaisant la mesure sur les 8
  coins) ; fenêtre qui sélectionne seulement quand elle contient
  VRAIMENT toute la boîte projetée, recoupement qui sélectionne au
  moindre chevauchement sur le MÊME rectangle réduit ; Maj/Ctrl testés
  dans les deux sens ; `enableRotate` gelé puis restauré à sa valeur
  d'origine en mode plan ET en 3D.
  Non repris (réserve, portée volontairement restreinte aux items de
  bibliothèque pour garder cette passe vérifiable) : les murs/nœuds du
  bâtiment ont leur PROPRE sélection (`Batiment._selection`,
  `_selectionFenetre` déjà existante mais sans distinction fenêtre/
  recoupement, Maj en simple bascule) — même retrofit à leur appliquer
  dans une prochaine session. Le menu de désambiguïsation (clic sur des
  objets proches/superposés, Rhino ouvre une liste) et les commandes de
  sélection par nom/calque/couleur ne sont pas non plus repris.
- **Repérage** : perpendiculaires et réglages exposés au panneau restent à
  faire (ils existent dans le module). Tangentes, milieu-comme-référence et
  acquisition manuelle sont faits. Les tangentes ont demandé une exception à
  la règle de priorité : un cercle est polygonisé en vingt-quatre murs, dont
  les sommets et les milieux sont des points « réels » pour le graphe mais
  des artefacts pour l'utilisateur — le milieu d'un segment tombe à quatre
  centimètres du vrai contact. La tangente passe donc AVANT les accrochages
  de points, à tolérance réduite de moitié. Le cercle idéal est retenu dans
  `batiment.cercles`, hors du graphe qui l'oublie. Le survol d'un milieu émet
  sa propre direction (celle du mur qui le porte) : un rayon de repérage est
  une droite, pas une demi-droite — corrigé pour marcher des deux côtés.
  L'acquisition manuelle (Ctrl+clic) pose une référence n'importe où, sans
  attendre le délai de survol, en réutilisant la même cascade d'accrochage
  que le curseur ; un second Ctrl+clic à proximité la retire. Marqueurs
  verts, cohérent avec tout le reste de l'assistance au dessin.
- **Interface** : lumières et rendu réunis en un seul panneau flottant à
  onglets (`#tools-panel`, à droite). Bâtiment reste une bascule de la
  colonne de gauche — il remplace le catalogue, pas un panneau qui flotte,
  et fusionner l'aurait fait perdre ce comportement pour un gain flou.
- **Ambiance « Intérieur »** : les quatre existantes éclairent comme un studio
  et délavent une salle fermée dont les luminaires devraient faire le travail.
- **Outils topologiques des murs** (scinder, ajuster/prolonger, aligner,
  décaler) : intégrés depuis la branche « Open code », relus intégralement,
  un bug source corrigé au passage (`{ color }` sans variable `color` dans
  `_montrerMarqueur`). Nouvelle palette d'icônes dans le panneau Bâtiment
  (`data-outil`), qui remplace l'ancien couple de boutons Dessiner/Éditer —
  un seul outil actif à la fois, déduit de l'état de la machine
  (`outilActif()` dans `main.js`), jamais mémorisé à part.
- **Justification des murs** (axe central / nu intérieur / nu extérieur) :
  intégrée avec les outils topologiques, dont elle partage le code
  (`facesMur`, `decalageCorps` dans `core/topologie.js`). Sélecteurs dans le
  panneau (nouveaux murs) et dans l'inspecteur (mur sélectionné).
- **Plan de coupe** : rend trop pâle, le poché s'écrase sous l'ambiance claire.

## Vérifier, toujours

Le code n'est pas fait parce qu'il est écrit. Un script de patch a échoué sur
une ancre avant d'écrire le fichier, et le correctif suivant a été rapporté
comme posé alors que la méthode n'existait pas. C'est la mesure dans le
navigateur qui l'a dit.
