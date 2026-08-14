# Spécifications techniques — Suite d'outils d'édition paramétrique

Documentation destinée à coder ces outils *from scratch* dans ce dépôt, pas à les
utiliser. Chaque section est ancrée dans l'architecture réelle du configurateur —
pas une théorie de géométrie algorithmique abstraite.

## Ancrage dans l'architecture existante

Deux domaines de données coexistent, et chaque outil doit savoir dans lequel il opère :

- **Objets de bibliothèque** — `app.state.items[]` (`src/main.js`), tableau d'objets
  JSON plats : `{ uid, blockId, pos:[x,y,z], rot (degrés, axe Z seul), scale (scalaire
  UNIFORME), finish, color }`. Aucune rotation X/Y, aucune échelle anisotrope
  aujourd'hui — toute extension vers ces libertés est un changement de schéma, noté
  à chaque section concernée. `app.viewer` (classe `Viewer`, `src/viewer.js`) est la
  seule à connaître THREE : elle synchronise `Object3D` depuis ce JSON
  (`addItem`/`removeItem`/`syncAll`) et remonte les gestes du gizmo via
  `onTransform(uid, patch)`, qui ne fait que `Object.assign(it, patch)`.
- **Bâtiment** — `Batiment.graph` (classe `PlanGraph`, `src/core/topologie.js`) :
  `nodes: Map<id,{x,y,wallIds:Set}>`, `walls: Map<id,{a,b,thickness,height,
  elevation,openings:[]}>`. C'est un graphe topologique, pas une liste d'objets
  indépendants — déplacer un nœud déplace tous les murs qui l'utilisent, sans
  duplication de coordonnées.

**Identité** : `newUid()` (`'i' + horodatage36 + compteur36`) pour les items ;
`'n'+compteur`/`'w'+compteur` pour nœuds/murs (`PlanGraph._uid`). Jamais de
réutilisation d'id après suppression.

**Undo/Redo** : PAS un patron Commande/inverse. `pushHistory()` sérialise l'état
ENTIER (`{items, batiment: batiment.serialiser()}`) en JSON, l'empile sur
`app.history` (plafond 80, dédoublonné si identique au sommet), vide `app.future`.
`undo()`/`redo()` rejouent un instantané complet via `applySnapshot()` — aucune
opération n'a besoin d'écrire son inverse. Conséquence directe pour tous les
outils ci-dessous : **la seule discipline requise est d'appeler `pushHistory()`
une fois l'opération commise, jamais pendant la prévisualisation** (sinon 80
instantanés se remplissent avec les images intermédiaires d'un seul geste).

**Sélection** : deux systèmes distincts aujourd'hui — `app.selected`/`app.selection`
(uids d'items) et `Batiment._selection` (nœuds/murs, `{type:'node'|'wall', id}`).
Un gizmo commun aux deux domaines n'existe pas encore ; les machines à états
ci-dessous supposent qu'on l'unifie (prérequis transverse, noté une seule fois ici
plutôt que répété treize fois) : une fonction `ciblesActives()` qui retourne une
liste homogène `{domaine:'item'|'noeud'|'mur', id, pos, verrouille}` avant
d'entrer dans n'importe lequel des états 1-4 décrits plus bas.

**Contrainte hôte/enfant, précédent réel** : `paramsOuverture()` et
`ajouterOuverture()` (`src/batiment.js`) stockent déjà une porte comme une
FRACTION de la longueur du mur hôte (`s0, s1 ∈ [0,1]`, pas des mètres), obtenue via
`graph.wallFrame(w)` → `{A, d (direction unitaire), len}`. C'est le patron à
généraliser pour tout hébergement futur (machine sur un mur, prise électrique) :
**la position de l'enfant n'est jamais stockée en coordonnées monde, seulement en
coordonnées locales de son hôte**, recalculées à la demande. C'est ce qui rend le
déplacement d'un mur gratuit pour ses portes — et ce qui, à l'inverse, fait
DÉRIVER leur largeur physique quand le mur change de longueur (`largeur = (s1-s0)
× f.len` — une fraction fixe sur une longueur variable). Ce défaut précis est
repris dans la section Contraintes de l'outil Échelle ci-dessous, avec le correctif.

---

## Module 1 — Transformations spatiales

### 1.1 Déplacer

**1. Concept.** Translation vectorielle pure : `P' = P + T`, `T = (dx, dy, dz)`.
Forme homogène `T_matrix · P_hom` avec `T_matrix = [[1,0,0,dx],[0,1,0,dy],[0,0,1,dz],
[0,0,0,1]]` — mentionnée pour mémoire, mais THREE ne l'exige pas directement :
`Object3D.position` est un `Vector3`, l'addition est directe
(`position.copy(origine).add(delta)`), la matrice 4×4 n'est recomposée qu'en
interne à `updateMatrix()`. Pour un item hébergé (mur, surface), la translation
n'est plus dans R³ mais sur la variété 1D du mur — voir Contraintes.

**2. Machine à états.**
- **État 0 (Idle)** : rien sélectionné, aucun listener actif hors raycast de survol.
- **État 1 (Sélection)** : clic → raycast contre `viewer.selectables` (items) ou
  `graph.nodeSous`/`wallSous` (bâtiment) → peuple `ciblesActives()`.
- **État 2 (Point de base)** : `G` pressé ou outil « Déplacer » choisi → capture
  un point d'ancrage. Deux variantes légitimes : le point de clic au sol
  (raycast sur le plan Z=0, comme `_solSous` dans `batiment.js`), ou l'origine
  propre de l'objet si aucun clic préalable (Revit accepte les deux).
- **État 3 (Prévisualisation)** : `pointermove` → `delta = curseurMonde − ancrage`
  → appliqué en LIVE à `Object3D.position` de chaque cible (jamais encore à
  `app.state.items`) ; réutilise la cascade d'accrochage existante
  (`_snap`/`osnap`/`core/reperage.js`) au lieu d'en écrire une seconde, en
  l'étendant aux items (elle ne connaît aujourd'hui que les nœuds de murs).
  `Maj` verrouille un axe (comme le `shiftKey` déjà câblé sur l'ortho du tracé).
- **État 4 (Commit)** : `pointerup`/clic → écrit `it.pos` (ou `node.x/y` via
  `graph.setNodePos`) pour de vrai, **une seule fois** `pushHistory()`, retour
  État 0 ou nouvel État 1 (chaînage à la Rhino, sans réarmer l'outil).

**3. Données.** Mutation en place de `it.pos` (identité `uid` préservée — jamais
de clonage) ou de `node.x/y` (préserve `wallIds`, donc tous les murs incidents se
redessinent sans recalcul manuel). Rafraîchissement ciblé
(`viewer.updateItem(uid)`/`batiment._reconstruireProxy()`), pas un `syncAll`
complet à chaque frame de l'État 3 : c'est une question de fluidité, pas de
correction.

**4. Contraintes.** Un item hébergé (extension future, cf. précédent des
ouvertures) ne doit PAS accepter de delta 3D libre : projeter le delta sur la
direction `f.d` du mur hôte, recalculer sa fraction `s`, refuser le commit si
`s` sort de `[0,1]` (ou le détacher explicitement — décision produit, pas
technique). Nœud de mur : déplacer un nœud partagé par plusieurs murs les
déforme tous simultanément — c'est la sémantique attendue du graphe, pas un
effet de bord à corriger.

**5. Edge cases.** Delta nul (clic sans glisser) → aucun commit, aucune entrée
d'historique (le dédoublonnage de `pushHistory` le couvrirait de toute façon,
mais éviter l'écriture est plus propre). Sélection mixte avec un élément
verrouillé → exclu du déplacement, le reste bouge (jamais un verrou ne bloque
tout le groupe). Raycast au sol qui échoue (caméra en incidence rasante) →
geler sur le dernier point valide plutôt que de propager `NaN`.

### 1.2 Copier

**1. Concept.** Même mathématique que Déplacer, mais produit une nouvelle
identité au lieu de muter l'existante : `it' = {...it, uid: newUid(), pos: P+T}`.
Un clonage superficiel (`{...it}`) suffit tant que `it` ne référence aucun objet
imbriqué ; le jour où un item porte des enfants hébergés, le clonage doit être
profond ET reparenter les enfants sur le nouvel `uid` (sans quoi la copie et
l'original partagent leurs enfants — bug silencieux, rien ne crashe).

**2. Machine à états.** Identique à Déplacer jusqu'à l'État 2, puis diverge :
l'État 3 fait avancer un CLONE fantôme pendant que l'original reste immobile ;
Revit permet plusieurs copies depuis un seul point de base — chaque clic en
État 3 commet une copie et RESTE en État 3 (pas de retour à l'État 0), jusqu'à
`Échap`/clic droit qui clôt le geste. `duplicateSelected()`
(`src/main.js:608`) est déjà l'implémentation de référence pour le cas
« une seule copie, décalage fixe au clavier » — ce module la généralise au
geste souris à vecteur libre, pas ne la remplace pas.

**3. Données.** Chaque copie est poussée dans `app.state.items` et
`viewer.addItem()`ée au moment de son clic de commit — mais **un seul**
`pushHistory()` à la fin de la boucle entière (à `Échap`), pas un par copie :
c'est exactement ce que fait déjà `duplicateSelected()` pour un `uids.length`
quelconque.

**4. Contraintes.** Copier un item hébergé copie aussi son offset `s` relatif —
mais sur QUEL hôte ? Par défaut le même (deux portes sur le même mur), sauf si
le point de dépôt tombe sur un autre mur, auquel cas re-projeter `s` sur le
nouvel hôte (même calcul que `ajouterOuverture`).

**5. Edge cases.** Copier un item VERROUILLÉ doit réussir (Revit : le verrou
protège l'original du déplacement, pas de la copie — la copie elle-même n'hérite
pas forcément du verrou, à trancher côté produit). Vecteur nul (dépôt exactement
sur l'original) est un cas VALIDE ici, contrairement à Déplacer — « dupliquer sur
place » est un geste voulu pour ensuite éditer la copie séparément.

### 1.3 Rotation

**1. Concept.** Rotation autour d'un pivot `C` et d'un axe `n̂` : `P' = R(θ,n̂)·
(P−C) + C`. Cette application est **quasi exclusivement 2D** (axe Z) — la
rotation d'un item se limite aujourd'hui à `it.rot` (un scalaire, degrés). Forme
matricielle plane : `(x'−cx, y'−cy) = [[cosθ,−sinθ],[sinθ,cosθ]]·(x−cx, y−cy)`,
`z` inchangé. Pour une rotation 3D générale (hors scope actuel mais à prévoir si
le modèle s'étend), formule de Rodrigues ou quaternion :
`q = (cos(θ/2), n̂·sin(θ/2))`, et en THREE :
`position.sub(pivot).applyAxisAngle(axe, θ).add(pivot)` combiné à
`object.quaternion.premultiply(q)`.

**2. Machine à états.**
- État 0→1 : identique.
- État 2 : pivot = centre de la bounding box de la sélection par défaut, ou
  point cliqué explicitement, ou saisie numérique (cote dans le panneau,
  comme `sel-rot` dans l'inspecteur existant).
- État 3 : `θ = atan2(curseur−C) − atan2(ancrage−C)`, accumulé en continu
  (jamais modulo pendant le drag, seulement au commit — sinon le franchissement
  de ±360° fait sauter l'angle affiché). `Maj` arrondit `θ` au multiple de 15°
  le plus proche (`Math.round(θ/pas)*pas`).
- État 4 : commit → `it.rot = (it.rot + θ) % 360` ET `it.pos` recalculé par la
  formule ci-dessus (une rotation autour d'un pivot externe DÉPLACE l'objet en
  plus de le réorienter — deux champs mutés, pas un seul).

**3. Données.** Pour une sélection groupée, TOUS les items tournent autour du
MÊME pivot partagé (le centre du groupe), jamais chacun autour du sien — bug
fréquent si le pivot est recalculé par objet au lieu d'être figé à l'État 2.

**4. Contraintes.** C'est ici que le choix « offset paramétrique, pas coordonnée
monde » de `paramsOuverture` paie : faire tourner un mur hôte ne touche NI `s0`
NI `s1` de ses ouvertures — leur position recalculée via `wallFrame()` suit la
rotation automatiquement, par construction, sans code dédié. Documenter cette
invariance explicitement évite qu'un futur développeur ajoute un correctif
inutile « pour compenser la rotation des portes ».

**5. Edge cases.** Pivot confondu avec la position de l'objet → rotation sur
place, cas dégénéré mais bien défini (rayon nul). Angle exactement 180° avec
`atan2` : discontinuité en `±π`, gérée par l'accumulation continue déjà prescrite
au point 2, pas par un correctif de signe après coup.

### 1.4 Mise à l'échelle

**1. Concept.** Homogène : `P' = C + s·(P−C)`, `s` scalaire. Anisotrope :
`P' = C + S·(P−C)`, `S = diag(sx,sy,sz)`. **Changement de schéma requis** :
`it.scale` est aujourd'hui un nombre unique — l'échelle anisotrope exige de le
faire évoluer vers `[sx,sy,sz]` (ou de garder un scalaire ET d'ajouter des
facteurs par axe séparés), avec migration à la lecture (`typeof it.scale ===
'number' ? [it.scale,it.scale,it.scale] : it.scale`) pour ne pas casser les
configurations déjà partagées par lien.

**2. Machine à états.** État 2 : pivot ET distance de référence `d0 =
|curseur0 − pivot|` capturés ensemble (contrairement à Rotation où seul le pivot
compte). État 3 : `s = |curseur − pivot| / d0` appliqué à `object.scale` ET
recalcul de `position` par la même formule pivot que Rotation (s'éloigner d'un
pivot en s'agrandissant déplace aussi l'objet). Le CHOIX de la poignée saisie
détermine le mode : coin de bounding box → anisotrope sur les deux axes du plan ;
poignée médiane d'un bord → un seul axe ; `Maj` pendant le drag → force
l'uniforme même depuis une poignée de coin (convention Revit).

**3. Données.** `it.scale` (ou sa forme tableau) et `it.pos` tous deux mutés.

**4. Contraintes — le cas concret déjà identifié.** Étirer un mur hôte (ses deux
nœuds s'écartent) change `f.len`. Comme `largeur = (s1−s0) × f.len` avec `s0,s1`
FIXES, la largeur physique de la porte hébergée DÉRIVE avec la longueur du mur —
observable dès aujourd'hui, pas une hypothèse. Le correctif paramétrique correct :
à chaque étirement du mur hôte, recalculer `s0' = sMid − (largeur/2)/len'`,
`s1' = sMid + (largeur/2)/len'` en gardant `largeur` et `sMid` CONSTANTS et en
ne laissant dériver QUE `s0,s1` (les fractions), jamais l'inverse. C'est un
changement d'un endroit précis : le point où `graph.setNodePos` déplace un nœud
d'extrémité de mur doit itérer `w.openings` et réappliquer cette formule — la
dérive actuelle n'est pas un bug de l'outil Échelle à venir, c'est un manque
dans le déplacement de nœud d'aujourd'hui, révélé ici parce que Échelle
l'exercerait en continu.

**5. Edge cases.** `s → 0` (poignée ramenée sur le pivot) doit être plancher à
une valeur epsilon (`1e-3`) plutôt que d'atteindre zéro exactement — une échelle
nulle rend `Object3D.matrix` non inversible et casse le raycasting sur cet objet
pour le reste de la session. `s < 0` (poignée traversée de l'autre côté du
pivot) : soit interdit (clamp à epsilon), soit interprété comme une réflexion
(mirroring involontaire) — trancher explicitement plutôt que laisser le signe
filer, sans quoi un miroir accidentel surprend l'utilisateur.

---

## Module 2 — Symétries et répétitions

### 2.1 Miroir par axe existant

**1. Concept.** Réflexion par rapport à une droite définie par un point `A` et
une direction unitaire `d̂`. Formule vectorielle sans matrice de réflexion
explicite (plus lisible en 2D que la matrice de Householder) :
`P' = A + 2·((P−A)·d̂)·d̂ − (P−A)`, soit projeter `P−A` sur `d̂`, doubler la
projection, soustraire le vecteur original. Pour l'orientation de l'objet
(`it.rot`), la réflexion d'un angle par rapport à un axe de direction `d̂`
(angle `α = atan2(d̂.y,d̂.x)`) donne `rot' = 2α − rot` (mod 360) — PAS
`180−rot`, erreur fréquente qui ne fonctionne que pour un axe horizontal.

**2. Machine à états.** État 2 = sélectionner l'axe existant (un mur, une ligne
de repérage acquise par le module de repérage intelligent — réutilise
`Reperage.points`/directions plutôt que de redemander une saisie). État 3 :
prévisualisation en temps réel du reflet (fantôme translucide), pas de drag
continu — l'axe est fixe une fois choisi, donc pas de paramètre libre à faire
varier à la souris (différence structurelle avec les outils du Module 1). État 4 :
commit → option « garder l'original » (miroir = copie) vs « remplacer »
(miroir = transformation en place), à exposer comme un choix explicite avant
le clic final, pas une préférence globale cachée.

**3. Données.** Si copie : mêmes règles de clonage profond que 1.2. Si
remplacement : mutation en place de `pos` et `rot`.

**4. Contraintes.** Un item hébergé reflété change de côté du mur si l'axe de
miroir n'est pas parallèle au mur hôte — recalculer son offset perpendiculaire
au mur (`épaisseur/2` actuel côté intérieur/extérieur) en conséquence, sans quoi
la porte se retrouve incrustée dans la géométrie du mur après le miroir.

**5. Edge cases.** Direction `d̂` nulle (axe dégénéré, deux points confondus) →
rejet explicite avant d'entrer en État 3, message plutôt que division par une
norme nulle dans la normalisation de `d̂`. Objet exactement SUR l'axe → reflet
= identité, cas valide (pas d'erreur), à ne pas confondre avec la copie
« vecteur nul » du Module 1.2 qui elle mérite un avertissement.

### 2.2 Miroir par axe dessiné

**1. Concept.** Mathématique identique à 2.1 — seule la provenance de `(A, d̂)`
change : deux clics au lieu d'une sélection d'objet. `A` = premier clic,
`d̂` = normalisé(second clic − premier clic).

**2. Machine à états.** État 2 se scinde en deux sous-états : 2a (premier point,
avec accrochage plein — extrémités, milieux, repérage) puis 2b (second point,
avec un aperçu de la droite en temps réel, exactement le même rendu que la ligne
de guide du repérage intelligent — `Reperage.segments()` peut être réutilisé
tel quel pour la prévisualisation de cet axe). État 3/4 identiques à 2.1 une
fois l'axe fixé.

**3-5.** Identiques à 2.1 ; la seule différence est amont (acquisition de
l'axe), pas dans ce qui en est fait.

### 2.3 Réseau linéaire

**1. Concept.** Boucle d'instanciation vectorielle : `N` copies aux positions
`Pᵢ = P₀ + i·T` pour `i ∈ [1, N−1]` (l'original compte pour `i=0`), `T` étant
soit un vecteur fixe (espacement constant, mode « Distance ») soit dérivé d'une
contrainte globale (mode « Total » : point de fin donné, `T = (Pfin−P₀)/(N−1)`
— une interpolation numérique linéaire, pas géométrique). Les deux modes
existent dans Revit et doivent être un simple bouton bascule, pas deux outils.

**2. Machine à états.** État 2 : premier point de direction (clic ou saisie
d'angle+distance, comme la saisie de longueur déjà câblée sur le tracé de murs
— `draft-length` dans `index.html`). État 3 : glisser définit soit `T` (mode
Distance, `N` recalculé en fonction de la distance totale glissée divisée par un
pas fixe saisi au clavier) soit le point final (mode Total, `N` saisi au
clavier, `T` dérivé). Aperçu = `N` fantômes semi-transparents repositionnés à
chaque `pointermove`, PAS `N` objets THREE réels tant que non commis — un
`InstancedMesh` ou un pool de clones réutilisés évite `N` créations/destructions
à 60 i/s.

**3. Données.** Au commit, `N−1` nouvelles entrées dans `app.state.items`
(uids frais), **un seul** `pushHistory()`. Le réseau n'est PAS un objet de
groupe persistant dans ce modèle de données plat — contrairement à Revit où un
`Array` reste éditable après coup (changer `N` re-régénère les copies), ici
chaque copie devient un item indépendant dès le commit. Documenté comme un choix
délibéré de simplicité : un réseau éditable après coup demanderait un nouveau
type d'entité dans `app.state` (`{type:'array', base:uid, T, N}` avec
dérivation des membres au rendu) — extension possible mais hors du périmètre
« outils d'édition de base ».

**4. Contraintes.** Aucune par défaut (chaque copie est indépendante). Si
l'original est hébergé, chaque copie du réseau doit re-projeter son offset sur
l'hôte le plus proche de sa position générée — pas forcément le même hôte pour
toutes les copies si le réseau traverse plusieurs murs.

**5. Edge cases.** `N ≤ 1` → aucune copie générée, pas une erreur (état
transitoire normal pendant la saisie). `T` nul (les deux points de direction
confondus) en mode Distance → toutes les copies se superposeraient : rejeter
la saisie avant commit plutôt que produire `N` doublons empilés. `N` très grand
(saisie fautive, ex. 5000) → plafonner (le catalogue n'a pas vocation à
héberger des dizaines de milliers d'items ; un plafond explicite avec message
vaut mieux qu'un gel du navigateur).

### 2.4 Réseau radial

**1. Concept.** Boucle d'instanciation angulaire autour d'un centre `C` :
`Pᵢ = C + R(i·Δθ)·(P₀−C)` pour `i ∈ [1,N−1]`, `Δθ = θ_total/N` (répartition sur
un arc, mode Revit "angle entre éléments" vs "angle total" — même dualité que
le linéaire, mêmes deux modes). Rotation `R` = la matrice 2D de 1.3 ; chaque
copie reçoit AUSSI `rot' = it.rot + i·Δθ` si l'option « tourner avec le
réseau » est active (une chaise autour d'une table tourne pour faire face au
centre ; un plot au sol ne tourne pas) — booléon explicite dans l'outil, pas
un comportement implicite.

**2. Machine à états.** État 2 : centre `C` (clic ou saisie), puis point de
référence `P₀` = position de l'objet sélectionné (déjà connue, pas de second
clic nécessaire contrairement au linéaire). État 3 : glisser définit `θ_total`
(comme la Rotation du 1.3, même calcul `atan2`), `N` saisi au clavier en
simultané. Aperçu identique en nature à 2.3 (fantômes, pas d'objets réels).

**3-5.** Mêmes principes que 2.3 (commit unique, uids frais, pas d'entité
« réseau » persistante). Edge case propre au radial : `θ_total = 360°` avec `N`
copies réparties sur le cercle COMPLET a un dernier point qui coïncide avec le
premier UNIQUEMENT si le mode est « angle entre éléments » avec `Δθ = 360/N` —
en mode « angle total = 360 » avec division par `N−1` comme le linéaire, la
dernière copie se superpose à l'original (division par `N−1` au lieu de `N`
est l'erreur classique du radial complet, à ne pas reproduire).

---

## Module 3 — Édition topologique et intersections

Ce module opère majoritairement sur `PlanGraph` (murs), pas sur les items —
c'est le domaine des courbes/segments, pas des instances rigides.

### 3.1 Aligner

**1. Concept.** Projection géométrique d'un point/objet source vers la droite
ou le plan porté par une cible. Pour deux segments (murs) : projection
orthogonale d'un point `P` sur la droite `(A, d̂)` d'un mur cible :
`P_proj = A + ((P−A)·d̂)·d̂`. Pour un item aligné sur un mur : translater l'item
de sorte que son bord (calculé depuis sa bounding box orientée) coïncide avec
`P_proj`, pas son centre — Revit aligne des FACES, pas des origines.

**2. Machine à états.** État 1 : sélectionner la référence cible EN PREMIER
(convention Revit : l'outil demande d'abord « aligner SUR quoi »), État 1bis :
sélectionner l'élément à déplacer. État 3 : aperçu du déplacement (translation
pure vers la projection, pas de rotation — Aligner ne réoriente jamais). État 4 :
commit, `pushHistory()`. Le mode « multiple » de Revit (aligner plusieurs
éléments sur la même référence sans requitter l'outil) boucle l'État 1bis→3→4
sans revenir en État 0.

**3. Données.** Mutation de `it.pos` (composante perpendiculaire à la
référence uniquement — la composante parallèle ne bouge pas, sans quoi
« aligner » deviendrait « empiler au même point »).

**4. Contraintes.** Aligner un mur hôte sur une référence ne touche à aucune
`s0/s1` de ses ouvertures (translation pure, le mécanisme de 1.3 s'applique
identiquement : offset paramétrique invariant par translation ET rotation).

**5. Edge cases.** Référence et élément à aligner sont le MÊME objet →
no-op silencieux, pas d'erreur. Direction de référence parallèle à la
composante qu'on essaie d'aligner (le point est déjà sur la droite) →
distance de projection nulle, commit trivial accepté sans avertissement
(ce n'est pas un échec, c'est déjà aligné).

### 3.2 Décaler

**1. Concept.** Décalage (offset) d'une courbe fermée ou ouverte le long de sa
NORMALE, pas de sa direction. Pour un segment de mur `(A,B)` de direction
`d̂ = (B−A)/|B−A|`, la normale 2D est `n̂ = (−d̂.y, d̂.x)` (rotation de +90°) ;
le segment décalé est `(A + e·n̂, B + e·n̂)`, `e` = distance signée. Pour une
polyligne FERMÉE (contour de pièce), chaque sommet reçoit le décalage
résultant de l'INTERSECTION des deux segments adjacents décalés — pas une
simple translation par sommet, sans quoi les coins s'ouvrent ou se chevauchent
selon le signe de la courbure locale. Aux angles convexes vus depuis l'intérieur
du décalage, prévoir un raccord (arrondi, biseau, ou onglet — l'onglet est le
plus simple : intersection des deux droites décalées via `croiser()`, déjà
présente dans `core/reperage.js`, directement réutilisable ici).

**2. Machine à états.** État 1 : sélectionner la courbe (mur ou polyligne de
murs contigus). État 3 : glisser perpendiculairement définit `e` en continu, un
aperçu (proxy 2D léger, comme `_reconstruireProxy` du tracé) montre le résultat
sans régénérer la géométrie 3D lourde (CSG) à chaque frame — ne déclencher
`generer3D()` qu'au commit, exactement la discipline déjà en place pour le
tracé de murs. État 4 : commit crée soit de NOUVEAUX murs (mode copie, comme
Revit "Offset" sur une copie), soit modifie les nœuds existants (mode
déplacement) — deux boutons, pas deux outils.

**3. Données.** Mode copie : nouveaux nœuds (`newUid`-style ids), nouveaux
murs, graphe étendu. Mode déplacement : `graph.setNodePos` sur les nœuds
existants — attention, si ces nœuds sont partagés avec D'AUTRES murs non
concernés par le décalage, ce mode les déforme aussi (même remarque qu'en
1.1 point 4) ; le mode copie est donc le choix sûr par défaut dès qu'un
sommet du contour est partagé.

**4. Contraintes.** Ouvertures hébergées sur un mur décalé EN COPIE ne sont pas
dupliquées automatiquement (la copie est un nouveau mur vierge) — comportement
correct par défaut, à documenter pour ne pas surprendre (Revit ne duplique pas
non plus les portes lors d'un offset).

**5. Edge cases.** `e` qui dépasse le rayon de courbure local d'un contour très
concave → le décalage s'auto-intersecte (les segments décalés se croisent avant
même d'atteindre leurs voisins). Détection : si la distance entre deux sommets
adjacents décalés devient négative ou si `croiser()` renvoie un point situé
AVANT le sommet côté origine plutôt qu'après, dégénérer proprement (fusionner
les deux sommets en un seul plutôt que produire une boucle inversée qui
inverserait la normale de la face générée). `e = 0` → no-op.

### 3.3 Scinder l'élément

**1. Concept.** Division paramétrique. Pour un mur, c'est EXACTEMENT
`graph.splitWall(wallId, t)`, déjà implémenté (`core/topologie.js`) — la
première partie garde l'id d'origine, la seconde reçoit un id neuf, `t ∈ [0,1]`
étant le paramètre le long du segment au point de coupe. Pour un solide (hors
scope 2D actuel de ce configurateur, mentionné pour complétude), la scission
équivaut à une opération booléenne (`SUBTRACTION` avec un plan de coupe
converti en solide fin, comme déjà pratiqué pour les ouvertures via
`three-bvh-csg`/`Evaluator`, déjà vendorisé dans ce dépôt).

**2. Machine à états.** État 1 : sélectionner l'élément. État 2 : le point de
coupe EST le curseur, en survol continu — pas un clic séparé, la coupe est un
outil « clic unique au bon endroit », avec accrochage (extrémités interdites
comme point de coupe — scinder à `t=0` ou `t=1` est un no-op déguisé, à
détecter et refuser AVANT le commit plutôt qu'après). État 4 : commit direct
au clic, pas de prévisualisation nécessaire au-delà d'un simple marqueur au
point visé (la coupe elle-même n'a pas de paramètre continu à ajuster — soit
on clique là, soit ailleurs).

**3. Données.** `splitWall` réutilisé tel quel — sa gestion des ouvertures
existantes sur le mur scindé (celles à cheval sur le point de coupe) doit être
vérifiée à l'implémentation : une ouverture dont `s0 < t < s1` (le point de
coupe tombe DANS la porte) est un cas qui n'existe probablement pas encore dans
`splitWall`, puisque rien ne scindait un mur portant une ouverture jusqu'ici.

**4. Contraintes.** Ouvertures entièrement d'un côté du point de coupe (`s1 ≤
t` ou `s0 ≥ t`) : reprojeter leur `s0,s1` sur le nouveau mur qui les contient,
en repartant de zéro sur SA longueur propre (`s0' = s0/t`, `s1' = s1/t` pour le
segment `[0,t]`, formule symétrique pour `[t,1]`) — sans cette reprojection,
une porte migrerait à un endroit incohérent du sous-segment.

**5. Edge cases.** Point de coupe tombant exactement sur un nœud existant
(extrémité ou intersection en T) → refuser, message (« ce point existe déjà »),
pas de mur de longueur nulle créé. Ouverture À CHEVAL sur le point de coupe
(cas noté au point 3) → refuser la scission à cet endroit précis avec message
explicite plutôt que produire une porte à moitié dans un mur et à moitié dans
l'autre.

### 3.4 Ajuster / Prolonger en angle

**1. Concept.** Calcul d'intersection de deux segments/droites suivi d'une
modification d'extrémité. Réutilise `croiser()` (`core/reperage.js`) pour le
point d'intersection de deux droites porteuses ; la différence entre Ajuster
(Trim) et Prolonger (Extend) n'est PAS dans le calcul du point — identique dans
les deux cas — mais dans la décision de quelle extrémité déplacer et si le
point trouvé tombe DANS ou HORS du segment de référence
(`intersectionsApparentes()`, déjà présente, encode déjà cette distinction :
« vraie intersection » vs « apparente »). Trim raccourcit un segment jusqu'à une
intersection RÉELLE existante ; Extend allonge un segment jusqu'à une
intersection APPARENTE (prolongement).

**2. Machine à états.** État 1 : sélectionner l'élément de référence (la limite
à laquelle on ajuste/prolonge). État 1bis : cliquer le CÔTÉ du segment à
modifier — c'est cette moitié du clic qui détermine QUELLE extrémité bouge
(la plus proche du point cliqué), pas un choix explicite séparé. État 4 :
commit immédiat (comme Scinder, pas de paramètre continu à prévisualiser au-delà
du survol qui montre déjà, via la cascade de repérage existante, le point
d'intersection candidat en temps réel — le glyphe `apparente`/`croisement`
déjà dessiné par `batiment.js` sert littéralement d'aperçu à cet outil sans
rien ajouter).

**3. Données.** `graph.setNodePos(nodeId, x, y)` sur l'extrémité concernée —
aucune structure nouvelle, c'est un déplacement de nœud contraint à un point
calculé plutôt que suivant le curseur.

**4. Contraintes.** Une extrémité prolongée qui porte une ouverture proche du
bout voit son mur s'allonger : appliquer la même règle de préservation de
largeur physique que 1.4 point 4 (recalcul `s0,s1` à largeur constante). Une
extrémité RACCOURCIE (Trim) au point de risquer de couper à travers une
ouverture existante doit refuser (même garde qu'en 3.3 point 5).

**5. Edge cases.** Segments strictement parallèles → `croiser()` renvoie déjà
`null` (déterminant `< 1e-7`) — propager ce `null` jusqu'à l'UI comme un état
« pas d'intersection possible », pas une exception. Élément de référence et
élément à ajuster déjà sécants EN VRAI (accrochage `intersection` existant
suffit, cet outil ne sert à rien ici) → détecter ce cas en amont et le
désactiver (griser l'outil ou message) plutôt que de laisser l'utilisateur
cliquer dans le vide.

---

## Module 4 — Gestion de la scène et du graphe

### 4.1 Verrouiller / Déverrouiller

**1. Concept.** Aucune géométrie ici — un simple drapeau booléen porté par
l'entité (`it.verrouille = true`), consulté à l'ENTRÉE de chaque état 2 des
outils ci-dessus (Déplacer, Rotation, Échelle, Miroir, Décaler-déplacement,
Ajuster) pour exclure l'élément de `ciblesActives()`. Pas un système de
permissions, un simple filtre.

**2. Machine à états.** Un seul état effectif : sélection → bascule du
drapeau → aucune prévisualisation, aucun commit différé (c'est instantané,
comme cocher une case). `pushHistory()` immédiat après la bascule — le
verrouillage FAIT partie de l'état versionné (annuler un verrouillage
accidentel doit être possible par Ctrl+Z).

**3. Données.** Un champ de plus sur `it`/`node`/`wall`. Sérialisé et restauré
comme le reste par `snapState()`/`applySnapshot()` sans code spécifique — c'est
déjà couvert puisque ces fonctions sérialisent l'objet entier.

**4. Contraintes.** Un mur verrouillé doit-il bloquer l'ajout d'une NOUVELLE
ouverture dessus ? Décision produit à trancher explicitement (Revin verrouille
la géométrie du mur, pas ses hôtes futurs) — je recommande : verrou = protège
la géométrie propre de l'élément (position, forme), pas les opérations
d'hébergement d'autres éléments dessus.

**5. Edge cases.** Verrouiller un élément déjà sélectionné dans un geste EN
COURS (drag actif d'un autre outil au même moment) → improbable en UI
mono-thread à un seul focus de souris, donc non prioritaire, mais si le
raccourci clavier de verrouillage reste actif pendant un drag, l'ignorer
plutôt que de couper le geste en cours.

### 4.2 Créer similaire

**1. Concept.** Ce n'est PAS une copie géométrique (Module 1.2) : clonage des
ATTRIBUTS d'une instance (son `blockId`, son `finish`, sa `color`) SANS sa
matrice de transformation (`pos`, `rot`, `scale` repartent à des valeurs par
défaut ou suivent le prochain point cliqué). C'est l'outil qui répond à
« encore un de ceux-là, mais ailleurs », par opposition à Copier qui répond à
« encore celui-ci, à côté ».

**2. Machine à états.** État 1 : sélectionner le modèle. État 2 (spécifique) :
au lieu d'un point de base pour un delta, c'est directement l'emplacement de
POSE du nouvel exemplaire (réutilise le pipeline `onPlace`/`placeItem` déjà
câblé pour la pose depuis le catalogue — Créer Similaire n'est rien d'autre
qu'une pose catalogue dont le `blockId`/`finish` sont préremplis depuis la
sélection au lieu de venir du panneau de gauche). État 3 : fantôme suit le
curseur comme n'importe quelle pose. État 4 : commit = `placeItem` standard.

**3. Données.** `{ uid: newUid(), blockId: modele.blockId, finish:
modele.finish, color: modele.color, scale: 1, rot: 0, pos: <point de pose> }`
— nouvel item complet, aucune référence à l'original après création (divergent
immédiatement, contrairement à un système de « type » Revit où tous les
exemplaires d'un même type partagent des paramètres modifiables en masse ; ce
configurateur n'a pas cette notion de type partagé, chaque item est
définitivement indépendant dès sa création).

**4. Contraintes.** Aucune — c'est délibérément l'outil le PLUS simple du lot,
sans lien avec l'original une fois posé.

**5. Edge cases.** Modèle sélectionné dont le `blockId` a été retiré de la
bibliothèque active entre-temps (changement de bibliothèque en cours de
session) → repli sur le mécanisme déjà existant `matiereApprochante()`
(`library.js`) plutôt qu'un échec silencieux.

### 4.3 Supprimer

**1. Concept.** Destruction d'entité + nettoyage des dépendances. Pour un item :
retrait de `app.state.items` + `viewer.removeItem(uid)` (déjà l'implémentation
existante, `src/main.js` ligne ~601). Pour un nœud/mur : PAS une simple
suppression d'entrée de Map — `_purgerNoeudsOrphelins()` et
`graph.supprimerMur()` (déjà présents, cf. commit `7764061` de cette session)
gèrent déjà la cascade nœud→murs incidents→orphelins. Ce sous-module documente
donc surtout la règle générale à en tirer pour toute future entité : **une
suppression n'est jamais un `Map.delete()` isolé, toujours une fonction dédiée
qui connaît le graphe des dépendances de CETTE entité précise.**

**2. Machine à états.** État 1 : sélection (potentiellement multiple). État 4 :
`Suppr`/`Backspace` déclenche directement le commit — pas d'état de
prévisualisation pour une destruction (contrairement à Revit qui montre parfois
un fantôme grisé, ce configurateur supprime immédiatement, cohérent avec
l'existant `_supprimerSelection()`). `pushHistory()` après coup, pas avant —
Annuler doit RESSUSCITER l'élément, ce qui n'est possible que si l'instantané
précédent (avec l'élément encore présent) reste au sommet de la pile jusqu'au
commit de la suppression.

**3. Données.** Nettoyage des références croisées AVANT le retrait de l'entité
elle-même — supprimer un mur hôte doit décider explicitement du sort de ses
ouvertures (les supprimer avec lui : comportement actuel implicite de
`supprimerMur`, à vérifier qu'il purge bien `w.openings` en même temps que `w`,
puisque les deux vivent dans le même objet mur donc c'est automatique ici —
mais ce ne le serait plus si les ouvertures devenaient une collection à part).

**4. Contraintes.** Item hébergé sur un mur qui vient d'être supprimé : sans
lien direct aujourd'hui entre `app.state.items` et `Batiment.graph` (deux
domaines de données séparés, cf. préambule), une suppression de mur ne
préviendrait PAS un item qui s'y croirait accroché. C'est un TROU d'architecture
à combler avant que l'hébergement d'items sur des murs (mentionné en filigrane
dans plusieurs sections ci-dessus) ne devienne réel : soit une table de
references croisées `hébergements: Map<itemUid, {wallId, s}>` tenue à jour par
les deux domaines, soit un callback `batiment.onMurSupprime(wallId)` que
`main.js` écoute pour détacher (pas supprimer) les items concernés.

**5. Edge cases.** Sélection mixte items + murs + nœuds en une seule commande
`Suppr` → chaque domaine gère sa propre cascade (`_supprimerSelection()` côté
bâtiment, retrait direct côté items), mais un SEUL `pushHistory()` global à la
fin des deux, pas un par domaine (sans quoi Ctrl+Z ne défait que la moitié du
geste perçu comme unique par l'utilisateur). Suppression du DERNIER élément
d'une sélection déjà partiellement modifiée par un autre outil dans le même
tour d'événements (rare, mais possible avec des raccourcis clavier rapides) →
s'assurer que `ciblesActives()` est recalculé au moment du `Suppr`, pas mis en
cache depuis un état de sélection antérieur.

---

## Priorités d'implémentation suggérées

Dans l'ordre où chaque outil réutilise le plus de ce qui précède (donc le moins
coûteux à ajouter ensuite) :

1. **Verrouiller** (4.1) — un booléen, zéro dépendance, prérequis discret des
   autres (chaque outil doit le respecter dès le premier jour).
2. **Déplacer / Copier / Rotation** (1.1-1.3) — posent le `ciblesActives()`
   unifié et la discipline commit unique + `pushHistory()` que tout le reste
   réutilise tel quel.
3. **Créer similaire** (4.2) et **Supprimer** (4.3) — capitalisent directement
   sur le pipeline de pose et les fonctions de suppression déjà largement
   présentes.
4. **Échelle** (1.4) — after Déplacer/Rotation, introduit le changement de
   schéma `scale` et force la correction de dérive des ouvertures (à profit
   pour Ajuster/Prolonger qui en a besoin aussi).
5. **Scinder, Ajuster/Prolonger** (3.3-3.4) — réutilisent `splitWall`,
   `croiser()`, `intersectionsApparentes()` déjà écrits pour le repérage.
6. **Aligner, Décaler** (3.1-3.2) — dernier du Module 3, Décaler est le plus
   dense (raccords de coins).
7. **Miroir (axe existant, axe dessiné), Réseaux** (2.1-2.4) — dépendent de
   1.1-1.3 pour leur mathématique et bénéficient d'un `ciblesActives()` et
   d'un pipeline de commit déjà éprouvés sur des cas plus simples avant
   d'affronter la génération de N copies.
