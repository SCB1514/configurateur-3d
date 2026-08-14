import * as THREE from '../vendor/three/three.module.js';
import { PlanGraph, add, scale, normalize, perp, cross, dist, sub, dot, lineIntersect } from './core/topologie.js';
import { snapOsnap, metresParPixel } from './core/osnap.js';
import { Reperage, intersectionsApparentes } from './core/reperage.js';
import { Brush, Evaluator, SUBTRACTION } from '../vendor/three/addons/csg/index.js';

/* ============================================================
   Bâtiment — tracé des murs en plan 2D + génération 3D.

   Architecture :
     • graphe topologique (PlanGraph) : source de vérité, en mètres ;
     • générateurs de menuiseries (DoorGenerator / FenetreGenerator) :
       composants structurels FERMÉS (cadre + battant), liés à la
       coordonnée 1D de leur ouverture ;
     • machine à états (Repos / Mur / Porte) pour l'interface ;
     • perçage des ouvertures par CSG (three-bvh-csg), qui autorise des
       percements à hauteur arbitraire (linteau au-dessus d'une porte).
   ============================================================ */

const MATERIAU_MUR = new THREE.MeshStandardMaterial({ color: 0xcfd4db, roughness: 0.88, metalness: 0.02 });
const MATERIAU_SOL = new THREE.MeshStandardMaterial({ color: 0x5c6370, roughness: 0.92, metalness: 0, side: THREE.DoubleSide });
const MATERIAU_PLAFOND = new THREE.MeshStandardMaterial({ color: 0xe9ebef, roughness: 1, metalness: 0, side: THREE.DoubleSide });
const MATERIAU_BOIS = new THREE.MeshStandardMaterial({ color: 0x8a5a2b, roughness: 0.55, metalness: 0.05 });
const MATERIAU_CADRE = new THREE.MeshStandardMaterial({ color: 0x5d4630, roughness: 0.6, metalness: 0.05 });
const MATERIAU_VITRE = new THREE.MeshStandardMaterial({ color: 0xa8d8ea, roughness: 0.05, metalness: 0.2, transparent: true, opacity: 0.4 });
// Poché du plan de coupe : les éléments coupés se remplissent de noir.
const MATERIAU_SECTION = new THREE.MeshBasicMaterial({ color: 0x000000, side: THREE.DoubleSide, depthTest: true });
/* Surlignage du poche.

   En plan, un mur selectionne ne peut pas se signaler par un contour : le
   poche EST un aplat, et un liseré autour d'un aplat noir se perd. On
   remplit donc la section elle-meme d'une couleur franche — c'est ce que
   font les logiciels de plan, et cela se lit d'un coup d'oeil meme sur un
   mur de cloison de sept centimetres. */
const MATERIAU_SECTION_SEL = new THREE.MeshBasicMaterial({
  color: 0x3d8bff, side: THREE.DoubleSide, depthTest: true,
});
// Proxy de tracé : rubans plats, sans lumière, pour dessiner à 60 i/s.
const MATERIAU_PROXY = new THREE.MeshBasicMaterial({ color: 0x6ea8ff, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false });
const MATERIAU_PROXY_SEL = new THREE.MeshBasicMaterial({ color: 0xffb020, side: THREE.DoubleSide, transparent: true, opacity: 0.85, depthWrite: false });

// Matériaux du bâti que le plan de coupe clive (pas les équipements de la bibliothèque).
const MATERIAUX_CLIVES = [MATERIAU_MUR, MATERIAU_SOL, MATERIAU_PLAFOND];

const evaluator = new Evaluator();

/* ══════════════════ menuiseries (composants fermés) ══════════════════ */

/** Paramètres d'une ouverture, en 1D sur le mur + hauteurs locales. */
function paramsOuverture(w, graph, op) {
  const f = graph.wallFrame(w);
  const largeur = (op.s1 - op.s0) * f.len;
  const sMid = (op.s0 + op.s1) / 2;
  const centre = add(f.A, scale(f.d, sMid * f.len));
  return {
    largeur,
    hauteur: (op.z1 ?? w.height) - (op.z0 || 0),
    epaisseur: w.thickness,
    centre,
    angle: Math.atan2(f.d.y, f.d.x),
    z0: op.z0 || 0,
    elevation: w.elevation || 0,
  };
}

/**
 * Générateur de PORTE : un composant structurel complet et fermé.
 * Le battant est généré en position FERMÉE par défaut, pivot = charnière
 * (bord s0 de l'ouverture). Le cadre (dormant) encadre le percement.
 */
export class DoorGenerator {
  static generer(params) {
    const { largeur, hauteur, epaisseur, centre, angle, z0, elevation } = params;
    const g = new THREE.Group();
    const epJambage = 0.06;
    const eCadre = Math.max(epaisseur + 0.02, 0.08);

    // battant FERMÉ, dans le plan du mur, charnière à l'origine
    const battant = new THREE.Mesh(new THREE.BoxGeometry(largeur, hauteur, 0.04), MATERIAU_BOIS);
    battant.position.set(largeur / 2, 0, hauteur / 2);
    battant.castShadow = true;
    g.add(battant);

    // dormant : deux montants + linteau (cadre fermé)
    const montant = (x) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(epJambage, hauteur, eCadre), MATERIAU_CADRE);
      m.position.set(x, 0, hauteur / 2);
      m.castShadow = true;
      return m;
    };
    g.add(montant(-epJambage / 2));
    g.add(montant(largeur + epJambage / 2));

    const linteau = new THREE.Mesh(new THREE.BoxGeometry(largeur + epJambage, 0.09, eCadre), MATERIAU_CADRE);
    linteau.position.set(largeur / 2, 0, hauteur + 0.045);
    g.add(linteau);

    // poignée (côté opposé à la charnière)
    const poignee = new THREE.Mesh(new THREE.SphereGeometry(0.03, 8, 6), MATERIAU_CADRE);
    poignee.position.set(largeur - 0.07, 0, hauteur * 0.5);
    g.add(poignee);

    g.position.set(centre.x, centre.y, elevation + z0);
    g.rotation.z = angle;
    return g;
  }
}

/** Générateur de FENÊTRE : cadre + vitrage, fermé dans le percement. */
export class FenetreGenerator {
  static generer(params) {
    const { largeur, hauteur, epaisseur, centre, angle, z0, elevation } = params;
    const g = new THREE.Group();
    const eCadre = Math.max(epaisseur + 0.02, 0.08);
    const eBois = 0.06;

    const cadre = new THREE.Mesh(
      new THREE.BoxGeometry(largeur, hauteur, eCadre), MATERIAU_CADRE);
    cadre.position.set(largeur / 2, 0, hauteur / 2);
    g.add(cadre);

    const vitre = new THREE.Mesh(
      new THREE.BoxGeometry(largeur - 2 * eBois, hauteur - 2 * eBois, 0.01), MATERIAU_VITRE);
    vitre.position.set(largeur / 2, 0, hauteur / 2);
    g.add(vitre);

    g.position.set(centre.x, centre.y, elevation + z0);
    g.rotation.z = angle;
    return g;
  }
}

/* ══════════════════ machine à états ══════════════════ */

class Etat {
  constructor(batiment) { this.b = batiment; }
  entrer() {}
  quitter() {}
  surDown() {}
  surMove() {}
  surUp() {}
  surKey() {}
  surKeyUp() {}
}

/** Repos : en vue 3D (ou plan), on peut saisir les poignées de nœuds pour
 *  déplacer les points d'un mur sélectionné. */
class EtatRepos extends Etat {
  surDown(ev) {
    if (ev.button !== 0) return;
    const nid = this.b._poigneeSous(ev);
    if (nid == null) return;
    ev.stopPropagation();
    ev.preventDefault();
    this._dragNoeud = nid;
    this.b._poigneeActive = nid;
  }
  surMove(ev) {
    if (this._dragNoeud == null) return;
    const p = this.b._solSous(ev);
    if (!p) return;
    this.b.graph.setNodePos(this._dragNoeud, p.x, p.y);
    this.b._majPoignees();
    this.b._regenThrottle();
  }
  surUp(ev) {
    if (this._dragNoeud == null) return;
    this._dragNoeud = null;
    this.b._poigneeActive = null;
    this.b._regenImmediate();
    this.b._onChange();
  }
}

/** Tracé de murs : deux sous-modes
 *   • DESSIN  : polyligne, rectangle, cercle, osnaps, ortho, longueur ;
 *   • ÉDITION : sélection de mur/nœud, déplacement de points, suppression.
 *
 *  Séparation des préoccupations : pendant le tracé, seul le PROXY 2D est mis
 *  à jour (rubans plats + marqueurs, sans lumière ni CSG) ; l'extrusion 3D
 *  n'est recalculée qu'à la sortie du mode (ou au clic « Générer 3D »). */
class EtatMur extends Etat {
  entrer() {
    this._depart = null;
    this._drag = null;
    this._dragBouge = false;
    this._forme = null;                  // { type:'rectangle'|'cercle', a/c }
    this._marqueeStart = null;           // origine de la fenêtre de sélection
    this._dernierPoint = null;           // dernier point survolé (rééval Maj)
    this.b.setMurSelectionne(null);      // pas de poignées pendant le tracé
    this.b.group.visible = false;
    this.b._apercu.visible = true;
    this.b._entrerPlan();
    this.b._reconstruireProxy();
  }
  quitter() {
    // On reste en vue de plan après la génération : le poché noir montre le
    // bâtiment coupé, et l'utilisateur bascule en 3D quand il veut (cube de vue).
    this.b._apercu.visible = false;
    this.b._ligne = this.b._retirerApercu(this.b._ligne);
    this.b._formeApercu = this.b._retirerApercu(this.b._formeApercu);
    this.b._finirSelection();
    this.b.finirTrait();
    this.b.group.visible = true;
    if (!this.b.vide) this.b.generer3D();   // calcul lourd : une seule fois
    this.b._onStatut?.(null);
  }
  surDown(ev) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    const p = this.b._solSous(ev);
    if (!p) return;
    if (this.b._modeEdition) {
      // édition : saisir un nœud pour le déplacer/sélectionner, sinon fenêtre
      const node = this.b.graph.nodeSous(p, this.b._tolerancePixels(p, 20));
      if (node) {
        this._drag = { type: 'node', id: node.id };
        this._dragBouge = false;
      } else {
        this._depart = { x: ev.clientX, y: ev.clientY };
        this._marqueeStart = { x: p.x, y: p.y };
      }
    } else {
      this._depart = { x: ev.clientX, y: ev.clientY };
    }
  }
  surMove(ev) {
    const p = this.b._solSous(ev);
    if (!p) return;
    this.b.viewer.demanderImage(1);          // le point de tracé doit suivre le curseur
    if (this._drag?.type === 'node') {
      const s = this.b._snap(p, ev.shiftKey);
      const dx = s.x - this.b.graph.node(this._drag.id).x;
      const dy = s.y - this.b.graph.node(this._drag.id).y;
      if (Math.hypot(dx, dy) > this.b.viewer.gridStep * 0.5) this._dragBouge = true;
      this.b.graph.setNodePos(this._drag.id, s.x, s.y);
      this.b._rafraichirApercu();
      this.b._reconstruireProxy();
      return;
    }
    if (this.b._modeEdition) {
      if (this._marqueeStart) this.b._majMarquee(this._marqueeStart, p);
      else this.b._majCurseur({ x: p.x, y: p.y, type: 'libre' });
      return;
    }
    this._dernierPoint = p;
    this._majApercu(p, ev.shiftKey);
  }
  /** Met à jour l'aperçu de dessin (curseur, ligne, cote) pour un point. */
  _majApercu(p, shift) {
    const s = this.b._snap(p, shift);
    this.b._majCurseur(s);
    if (this._forme) {
      this.b._majFormeApercu(this._forme, s);
      this.b._majStatutForme(this._forme, s);
      return;
    }
    if (this.b._ancre) {
      const a = this.b.graph.node(this.b._ancre);
      this.b._majLigne(a, s);
      this.b._majStatut(a, s);
      const dx = s.x - a.x, dy = s.y - a.y;
      const r = Math.hypot(dx, dy);
      this.b._dirCourante = r > 1e-6 ? { x: dx / r, y: dy / r } : null;
    }
  }
  surUp(ev) {
    if (ev.button !== 0) return;
    // fin d'un déplacement de nœud (édition)
    if (this._drag?.type === 'node') {
      const id = this._drag.id;
      const etaitClic = !this._dragBouge;
      this._drag = null;
      this._dragBouge = false;
      if (etaitClic) {
        // clic sur un nœud : sélection (avec bascule additive si Maj)
        this.b._selection = ev.shiftKey
          ? (this.b._estSelectionne('node', id)
              ? this.b._selection.filter(s => !(s.type === 'node' && s.id === id))
              : [...this.b._selection, { type: 'node', id }])
          : [{ type: 'node', id }];
        this.b._rafraichirApercu();
        this.b._reconstruireProxy();
      } else {
        this.b._onChange();
      }
      return;
    }
    const dep = this._depart; this._depart = null;
    if (!dep) return;
    const p = this.b._solSous(ev);
    if (!p) return;
    ev.stopPropagation();
    ev.preventDefault();

    if (this.b._modeEdition) {
      const bouge = Math.hypot(ev.clientX - dep.x, ev.clientY - dep.y) > 5;
      if (this._marqueeStart) {
        const a = this._marqueeStart;
        this._marqueeStart = null;
        this.b._majMarquee(null, null);
        if (bouge && p) this.b._selectionFenetre(a, p, ev.shiftKey);
        else this.b._finirSelection();
        return;
      }
      // clic simple : sélection d'un mur (ou désélection)
      const tol = this.b._tolerancePixels(p, 20);
      const mur = this.b.graph.murSous(p, tol);
      if (mur) {
        this.b._selection = ev.shiftKey
          ? (this.b._estSelectionne('wall', mur.wallId)
              ? this.b._selection.filter(s => !(s.type === 'wall' && s.id === mur.wallId))
              : [...this.b._selection, { type: 'wall', id: mur.wallId }])
          : [{ type: 'wall', id: mur.wallId }];
      } else {
        this.b._finirSelection();
      }
      this.b._rafraichirApercu();
      this.b._reconstruireProxy();
      return;
    }

    // — DESSIN
    const s = this.b._snap(p, ev.shiftKey);

    // formes prédéfinies (rectangle / cercle)
    if (this.b._modeDessin === 'rectangle' || this.b._modeDessin === 'cercle') {
      if (!this._forme) {
        this._forme = this.b._modeDessin === 'rectangle'
          ? { type: 'rectangle', a: { x: s.x, y: s.y } }
          : { type: 'cercle', c: { x: s.x, y: s.y } };
        return;
      }
      if (this._forme.type === 'rectangle') this.b._genererRectangle(this._forme.a, { x: s.x, y: s.y });
      else this.b._genererCercle(this._forme.c, Math.hypot(s.x - this._forme.c.x, s.y - this._forme.c.y));
      this._forme = null;
      this.b._formeApercu = this.b._retirerApercu(this.b._formeApercu);
      this.b._onStatut?.(null);
      this.b._rafraichirApercu();
      this.b._reconstruireProxy();
      this.b._onChange();
      return;
    }

    // polyligne
    const etaitSansAncre = !this.b._ancre;
    const cible = this.b._resoudreSnap(s);
    if (etaitSansAncre) {
      this.b._pointDepart = cible;
      this.b._chaine = [];
    }
    if (this.b._ancre && cible !== this.b._ancre) {
      const wid = this.b.graph.addWall(this.b._ancre, cible, {
        thickness: this.b.epaisseur, height: this.b.hauteur, elevation: this.b.elevation,
      });
      if (wid) {
        this.b.graph.intersectAndSplit(wid);
        this.b._chaine.push(wid);
        this.b._dernierMur = wid;
      }
    }
    this.b._ancre = cible;
    if (etaitSansAncre) this.b._focusSaisie?.();   // point posé → on peut taper la longueur
    this.b._rafraichirApercu();
    this.b._reconstruireProxy();
    this.b._onChange();
  }
  surKey(e) {
    if (e.key === 'Shift') {
      // Maj enfoncé : on réévalue l'aperçu SANS bouger la souris (force la perpendiculaire)
      if (!this.b._modeEdition && this._dernierPoint) this._majApercu(this._dernierPoint, true);
      return;
    }
    if (e.key === 'Escape') {
      this.b.finirTrait();
      this.b._finirSelection();
      this._forme = null;
      this.b._formeApercu = this.b._retirerApercu(this.b._formeApercu);
      this.b._onStatut?.(null);
      this.b._viderSaisie?.();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      this.b._supprimerSelection();
    }
  }
  surKeyUp(e) {
    if (e.key === 'Shift') {
      if (!this.b._modeEdition && this._dernierPoint) this._majApercu(this._dernierPoint, false);
    }
  }
}

/** Insertion d'une menuiserie : prévisualisation glissée le long d'un mur (1D). */
class EtatPorte extends Etat {
  entrer() {
    this._depart = null;
    this._preview = null;
    this._murActif = null;
    this._apercuVisible = this.b._apercu.visible;
  }
  quitter() {
    if (this._preview) { this.b._apercu.remove(this._preview); this._preview = null; }
    this.b._apercu.visible = false;
  }
  surDown(ev) {
    if (ev.button !== 0) return;
    ev.stopPropagation();
    ev.preventDefault();
    this._depart = { x: ev.clientX, y: ev.clientY };
  }
  surMove(ev) {
    const p = this.b._solSous(ev);
    if (!p) return;
    this.b.viewer.demanderImage(1);
    const tol = this.b._tolerancePixels(p, 18);
    const sous = this.b.graph.murSous(p, tol);
    if (sous) this._montrerApercu(sous.wall, sous.s);
    else if (this._preview) this._preview.visible = false;
  }
  surUp(ev) {
    if (ev.button !== 0) return;
    const dep = this._depart; this._depart = null;
    if (!dep || Math.hypot(ev.clientX - dep.x, ev.clientY - dep.y) > 5) return;
    const p = this.b._solSous(ev);
    if (!p) return;
    const tol = this.b._tolerancePixels(p, 18);
    const sous = this.b.graph.murSous(p, tol);
    if (!sous) return;
    ev.stopPropagation();
    ev.preventDefault();
    this.b.ajouterOuverture(sous.wallId, sous.s, this.b._typeOuverture);
  }
  _montrerApercu(w, s) {
    const type = this.b._typeOuverture;
    const largeur = type === 'door' ? 0.9 : 1.2;
    const z1 = type === 'door' ? this.b.hauteurPorte : 1.1;
    const f = this.b.graph.wallFrame(w);
    const demi = Math.min(largeur / 2, f.len * 0.3);
    const s0 = Math.max(0, s - demi / f.len), s1 = Math.min(1, s + demi / f.len);
    if (!this._preview) {
      const gen = type === 'window' ? FenetreGenerator : DoorGenerator;
      this._preview = gen.generer(paramsOuverture(w, this.b.graph, { s0, s1, z0: 0, z1 }));
      this._preview.traverse(o => {
        if (o.material) { o.material = o.material.clone(); o.material.transparent = true; o.material.opacity = 0.6; o.material.depthWrite = false; }
      });
      this._preview.renderOrder = 998;
      this.b._apercu.add(this._preview);
      this.b._apercu.visible = true;
    } else {
      const np = paramsOuverture(w, this.b.graph, { s0, s1, z0: 0, z1 });
      this._preview.position.set(np.centre.x, np.centre.y, np.elevation + np.z0);
      this._preview.rotation.z = np.angle;
      this._preview.visible = true;
    }
  }
}

/* ══════════════════ façade ══════════════════ */

export class Batiment {
  constructor(viewer) {
    this.viewer = viewer;
    this.graph = new PlanGraph();
    this.actif = false;

    this.epaisseur = 0.15;       // m
    this.hauteur = 2.7;          // m
    this.elevation = 0;          // m (niveau)
    this.hauteurPorte = 2.1;     // m

    this.group = new THREE.Group();
    this.group.name = 'batiment';
    viewer.scene.add(this.group);

    this._apercu = new THREE.Group();
    this._apercu.renderOrder = 998;
    this._apercu.visible = false;
    viewer.scene.add(this._apercu);

    // proxy 2D ultra-léger : les murs dessinés en rubans plats, sans extrusion
    this._proxyMurs = new THREE.Group();
    this._proxyMurs.renderOrder = 997;
    this._apercu.add(this._proxyMurs);

    // repères d'accrochage en direct (glyphes + ligne de guidage)
    this._glyphes = {};
    this._guideLigne = null;
    /* Le reperage intelligent : il repond a « a quoi suis-je aligne ? »,
       la question que les accrochages ne posent pas. Voir core/reperage.js. */
    this.reperage = new Reperage();
    this._initMarqueursSnap();

    this._ancre = null;
    this._marqueurs = new Map();
    this._ligne = null;
    this._curseur = null;
    this._dimension = null;
    this._pointDepart = null;    // point de départ de la chaîne (fermeture)
    this._chaine = [];           // murs de la chaîne en cours
    this._dernierMur = null;
    this._typeOuverture = 'door';
    this._selection = [];         // liste de { type:'node'|'wall', id }
    this._precedent = null;      // caméra mémorisée pendant l'édition en plan
    this._sectionGroup = null;   // poché noir du plan de coupe
    this._menuiseries = [];      // composants porte/fenêtre (masqués en plan)
    this._modePlan = false;
    this.hauteurCoupe = 1.2;     // m — hauteur du plan de coupe
    this._modeDessin = 'polyligne';   // 'polyligne' | 'rectangle' | 'cercle'
    this._modeEdition = false;        // sous-mode : dessin (false) / édition (true)
    this._formeApercu = null;
    this._marqueeApercu = null;       // fenêtre de sélection (édition)
    this._poignees3D = null;          // poignées de nœuds (vue 3D / plan)
    this._regenTimer = null;          // minuterie de régénération 3D (drag)
    this._murSel3D = null;            // mur dont on affiche les poignées
    this._poigneeActive = null;       // nœud en cours de glisser
    this._dirCourante = null;    // direction du segment en cours (saisie au clavier)
    this._onStatut = null;       // callback barre de statut
    this._focusSaisie = null;    // focus le champ longueur (après le 1er clic)
    this._viderSaisie = null;    // vide le champ longueur (Échap)
    this._murs3D = [];           // maillages 3D des murs (sélection)
    this.snaps = {               // accrochages actifs (panneau à cocher)
      end: true, mid: true, intersection: true, surMur: true, prolongation: true,
      parallele: false, perpendiculaire: false, ortho: false, grille: false,
    };
    this.guides = true;           // système de GUIDES (lignes de repérage) activé
    this._longueurContrainte = null;   // longueur saisie au clavier (m)

    this._etats = {
      repos: new EtatRepos(this),
      mur: new EtatMur(this),
      porte: new EtatPorte(this),
    };
    this._etat = this._etats.repos;

    const c = viewer.canvas;
    this._surDown = e => this._etat.surDown(e);
    this._surMove = e => this._etat.surMove(e);
    this._surUp = e => this._etat.surUp(e);
    this._surKey = e => this._etat.surKey(e);
    this._surKeyUp = e => this._etat.surKeyUp(e);
    c.addEventListener('pointerdown', this._surDown, true);
    c.addEventListener('pointermove', this._surMove, true);
    c.addEventListener('pointerup', this._surUp, true);
    addEventListener('keydown', this._surKey);
    addEventListener('keyup', this._surKeyUp);
  }

  get vide() { return this.graph.walls.size === 0; }
  get etatNom() { return this._etat === this._etats.mur ? 'mur' : (this._etat === this._etats.porte ? 'porte' : 'repos'); }

  _definirEtat(nom) {
    this._etat.quitter();
    this._etat = this._etats[nom];
    this._etat.entrer();
    this.actif = nom !== 'repos';
  }

  /* ---- entrées d'interface ---- */
  tracerMurs() { this._definirEtat('mur'); }
  insererPorte() { this._typeOuverture = 'door'; this._definirEtat('porte'); }
  insererFenetre() { this._typeOuverture = 'window'; this._definirEtat('porte'); }
  /** Bascule le sous-mode du tracé : dessin (false) / édition (true). */
  setModeEdition(on) {
    this._modeEdition = !!on;
    this.finirTrait();
    this._finirSelection();
    this._formeApercu = this._retirerApercu(this._formeApercu);
    this._onStatut?.(null);
  }
  get modeEdition() { return this._modeEdition; }
  /** Active/désactive le système de GUIDES (repérage intelligent). */
  setGuides(on) {
    this.guides = !!on;
    if (!on) this.reperage.vider();
    this.finirTrait();
    this._onStatut?.(null);
  }
  get guidesActifs() { return this.guides; }
  arreter() {
    this.finirTrait();
    this._definirEtat('repos');       // EtatMur.quitter génère le 3D et le montre
    this.group.visible = true;
    this.viewer.demanderImage(2);
  }
  finirTrait() {
    this._ancre = null;
    this._pointDepart = null;
    this._chaine = [];
    this._ligne = this._retirerApercu(this._ligne);
  }

  /* ---- pointage au sol ---- */
  _solSous(ev) {
    const v = this.viewer;
    const r = v.canvas.getBoundingClientRect();
    v.pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    v.pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    v.ray.setFromCamera(v.pointer, v.camera);
    const p = new THREE.Vector3();
    return v.ray.ray.intersectPlane(v._plane, p) ? { x: p.x, y: p.y } : null;
  }

  /** Tolérance en mètres correspondant à `px` pixels, à la distance de la cible.
   *  Gère la caméra orthographique du plan (pas de fov) ET la perspective. */
  _tolerancePixels(pointSol, px) {
    const v = this.viewer, c = v.camera;
    let parPixel;
    if (c.isOrthographicCamera) {
      parPixel = (c.top - c.bottom) / v.canvas.clientHeight / (c.zoom || 1);
    } else {
      const d = c.position.distanceTo(new THREE.Vector3(pointSol.x, pointSol.y, 0));
      parPixel = metresParPixel(c, v.canvas.clientHeight, d);
    }
    return parPixel * px;
  }

  /** Accrochage, par priorité décroissante (résout les conflits) :
   *    0. FERMETURE à angle droit (on pointe le point de départ de la chaîne) ;
   *    0.5 PIED / DIRECTION perpendiculaire au mur proche (Maj = forçage) ;
   *    1. points nodaux (Extrémité / Milieu / Intersection) ;
   *    2. projection sur un mur (Sur-mur) et prolongation ;
   *    3. directions (ortho / parallèle / perpendiculaire) + longueur ;
   *    4. grille. */
  _snap(p, ortho = false) {
    const tol = this._tolerancePixels(p, 15);
    const os = snapOsnap(p, this.graph, tol);

    /* Acquisition des points de reference.

       Survoler un point d'accrochage sans cliquer, le temps d'un battement,
       le retient comme reference. C'est le geste de SmartTrack : on ne
       declare rien, on regarde, et le logiciel comprend a quoi on pense. */
    this.reperage.actif = !!this.guides;
    if (os && ['end', 'mid', 'intersection'].includes(os.type)) {
      const dirs = [];
      for (const w of this.graph.walls.values()) {
        const A = this.graph.node(w.a), B = this.graph.node(w.b);
        if (dist(os, A) < 1e-6 || dist(os, B) < 1e-6) dirs.push(this.graph.wallFrame(w).d);
      }
      this.reperage.survol(os, dirs);
    } else {
      this.reperage.survol(null);
    }

    /* Le repere passe APRES les points reels et AVANT les directions.

       Un point qui existe dans le modele l'emporte toujours sur un point
       deduit : c'est la regle de tous les logiciels de CAO, et elle evite
       qu'une ligne de suivi vous arrache a l'extremite que vous visiez.
       Mais un croisement de lignes de suivi vaut mieux qu'un simple ortho,
       parce qu'il designe un point unique la ou l'ortho laisse glisser. */
    if (this.guides && !(os && ['end', 'mid', 'intersection'].includes(os.type)
                         && this.snaps[os.type])) {
      const r = this.reperage.candidat(p, tol);
      if (r) return r;

      /* Intersection apparente : le coin que DEUX MURS formeraient s'ils
         etaient prolonges. En dessin de plan c'est capital — deux murs qui
         ne se touchent pas encore ont pourtant un coin, et c'est lui qu'on
         vise pour les raccorder. Sans cela il faut tracer trop long, puis
         ajuster. Rhino l'active par defaut. */
      if (this.snaps.prolongation) {
        const segs = [];
        for (const w of this.graph.walls.values()) {
          const f = this.graph.wallFrame(w);
          segs.push({ o: f.A, d: f.d, len: f.len });
        }
        const ap = intersectionsApparentes(segs, p, tol);
        if (ap) return ap;
      }
    }

    // 0. fermeture à angle droit : en pointant le point de départ, on propose le
    //    point qui referme le polygone en formant deux angles droits (rectangle).
    if (this.guides && this._ancre && this._pointDepart && this._chaine.length >= 2) {
      const a = this.graph.node(this._pointDepart);
      if (dist(p, a) < tol * 1.6) {
        const premier = this.graph.walls.get(this._chaine[0]);
        const dernier = this.graph.walls.get(this._chaine[this._chaine.length - 1]);
        if (premier && dernier) {
          const d1 = this.graph.wallFrame(premier).d;
          const d2 = this.graph.wallFrame(dernier).d;
          const c = this.graph.node(this._ancre);
          // D = intersection de (C, perp(d2)) et (A, perp(d1))
          const D = lineIntersect(c, perp(d2), a, perp(d1));
          if (D) return { x: D.x, y: D.y, type: 'cloture', depart: a, courant: c };
        }
      }
    }

    // 0.5 perpendiculaire au mur proche : PROPOSÉE quand on vise ~90°, FORCÉE
    //     avec Maj. S'applique à tout le mur (segment, milieu, extension) et
    //     prime sur l'extension ET sur le point snap du milieu. Le forçage Maj
    //     est INDÉPENDANT de la case « perpendiculaire ».
    //     Deux formes :
    //       • ancre HORS de la ligne du mur → PIED (projection de l'ancre sur la
    //         ligne infinie) : sur le segment = jonction en T, sur l'extension =
    //         nœud libre. C'est la « perpendiculaire à la ligne d'extension » ;
    //       • ancre SUR la ligne → DIRECTION perpendiculaire (le mur part à 90°).
    if (this.guides && this._ancre && (this.snaps.perpendiculaire || ortho)) {
      const a = this.graph.node(this._ancre);
      const dirAncre = normalize(sub(p, a));
      let meilleurMur = null, meilleureD = tol * 2.5;
      for (const w of this.graph.walls.values()) {
        const f = this.graph.wallFrame(w);
        const t = dot(sub(p, f.A), f.d);
        const proj = add(f.A, scale(f.d, t));
        const d = dist(p, proj);
        if (d < meilleureD) { meilleureD = d; meilleurMur = w; }
      }
      if (meilleurMur) {
        const f = this.graph.wallFrame(meilleurMur);
        const visePerp = Math.abs(dot(dirAncre, f.d)) < 0.7;
        if (ortho || (this.snaps.perpendiculaire && visePerp)) {
          // pied de l'ancre sur la ligne infinie du mur
          const tA = dot(sub(a, f.A), f.d);
          const sA = tA / f.len;
          const pied = add(f.A, scale(f.d, tA));
          if (dist(a, pied) > 1e-6) {
            // ancre hors de la ligne : on accroche le PIED.
            // Sur le segment → jonction en T (splitWall) ; sur l'extension →
            // nœud libre (pas de wallId).
            if (sA > 1e-6 && sA < 1 - 1e-6) {
              return { x: pied.x, y: pied.y, type: 'perpendiculaire', wallId: meilleurMur.id, s: sA };
            }
            return { x: pied.x, y: pied.y, type: 'perpendiculaire' };
          }
          // ancre sur la ligne : on force la DIRECTION perpendiculaire
          const wa = Math.atan2(f.d.y, f.d.x);
          const r = Math.hypot(p.x - a.x, p.y - a.y);
          let angle = wa + Math.PI / 2;
          let delta = angle - Math.atan2(p.y - a.y, p.x - a.x);
          delta = ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
          if (delta > Math.PI) delta -= 2 * Math.PI;
          if (Math.abs(delta) > Math.PI / 2) angle += Math.PI;
          const L = this._longueurContrainte;
          const d2 = (L && L > 0) ? L : r;
          return { x: a.x + d2 * Math.cos(angle), y: a.y + d2 * Math.sin(angle), type: 'perpendiculaire' };
        }
      }
    }

    // 1. points nodaux
    if (os && ['end', 'mid', 'intersection'].includes(os.type) && this.snaps[os.type]) return os;

    // 2. sur-mur / prolongation (projection du curseur)
    //    — la prolongation est un GUIDE : désactivée quand les guides sont coupés
    if (os && this.snaps[os.type] && (os.type !== 'prolongation' || this.guides)) return os;

    // 4. directions + longueur contrainte
    if (this._ancre) {
      const a = this.graph.node(this._ancre);
      const dx = p.x - a.x, dy = p.y - a.y;
      const r = Math.hypot(dx, dy);
      if (r > 1e-6) {
        let angle = Math.atan2(dy, dx);
        let type = 'libre';
        let guide = false;
        if (this.guides && (ortho || this.snaps.ortho || this.snaps.parallele || this.snaps.perpendiculaire)) {
          const candidats = [];
          if (ortho || this.snaps.ortho) for (let k = 0; k < 4; k++) candidats.push({ a: k * Math.PI / 2, t: 'ortho' });
          if (!ortho) {
            for (const w of this.graph.walls.values()) {
              const f = this.graph.wallFrame(w);
              const wa = Math.atan2(f.d.y, f.d.x);
              if (this.snaps.parallele) candidats.push({ a: wa, t: 'parallele', w });
              if (this.snaps.perpendiculaire) candidats.push({ a: wa + Math.PI / 2, t: 'perpendiculaire', w });
            }
          }
          const seuil = ortho ? Math.PI : (45 * Math.PI) / 180;   // couverture 360° (suivi polaire 90°)
          const PRIO = { ortho: 0, parallele: 1, perpendiculaire: 2 };
          let meilleur = null, meilleurEcart = seuil + 1e-6;   // inclut la frontière à 45°
          for (const c of candidats) {
            let ecart = Math.abs(angle - c.a) % Math.PI;
            if (ecart > Math.PI / 2) ecart = Math.PI - ecart;
            if (ecart < meilleurEcart - 1e-9
                || (Math.abs(ecart - meilleurEcart) < 1e-9 && meilleur && PRIO[c.t] > PRIO[meilleur.t])) {
              meilleurEcart = ecart; meilleur = c;
            }
          }
          if (meilleur) {
            angle = meilleur.a;
            type = meilleur.t;
            guide = true;
            // La comparaison se fait modulo 180° (ligne sans orientation) : on
            // choisit le SENS le plus proche du curseur, sinon le point part à
            // l'opposé (tirer à droite dessine à gauche).
            let delta = angle - Math.atan2(dy, dx);
            delta = ((delta % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
            if (delta > Math.PI) delta -= 2 * Math.PI;
            if (Math.abs(delta) > Math.PI / 2) angle += Math.PI;
          }
        }
        const L = this._longueurContrainte;
        const dist = (L && L > 0) ? L : r;
        let x = a.x + dist * Math.cos(angle), y = a.y + dist * Math.sin(angle);
        if (!guide && !(L && L > 0) && this.snaps.grille) {
          const gs = this.viewer.gridStep;
          x = Math.round(x / gs) * gs; y = Math.round(y / gs) * gs; type = 'grille';
        }
        return { x, y, type };
      }
    }

    if (this.snaps.grille) {
      const gs = this.viewer.gridStep;
      return { x: Math.round(p.x / gs) * gs, y: Math.round(p.y / gs) * gs, type: 'grille' };
    }
    return { x: p.x, y: p.y, type: 'libre' };
  }

  /** Résout un accrochage en un nœud du graphe (crée/scinde si nécessaire). */
  _resoudreSnap(s) {
    if (s.type === 'end' || s.type === 'intersection') return s.id;
    if (s.type === 'mid') return this.graph.splitWall(s.wallId, 0.5);
    if (s.type === 'surMur') return this.graph.splitWall(s.wallId, s.s);
    if (s.type === 'perpendiculaire' && s.wallId) {
      return this.graph.splitWall(s.wallId, s.s);   // jonction en T sur le mur cible
    }
    // cloture / prolongation / parallele / ortho / grille : nœud libre
    return this.graph.addNode(s.x, s.y);
  }

  /* ---- aperçu ---- */
  _retirerApercu(o) {
    if (o) {
      this._apercu.remove(o);
      o.traverse?.(c => { c.geometry?.dispose?.(); c.material?.map?.dispose?.(); c.material?.dispose?.(); });
    }
    return null;
  }
  /** Reconstruit les marqueurs de nœuds + la surbrillance de sélection.
   *  Géométrie et matériaux PARTAGÉS : on ne crée rien par nœud, juste des
   *  Mesh qui référencent la même sphère (pas de GC pendant le déplacement). */
  _rafraichirApercu() {
    for (const m of this._marqueurs.values()) this._apercu.remove(m);
    this._marqueurs.clear();
    if (!this._geoMarqueur) {
      this._geoMarqueur = new THREE.SphereGeometry(1, 12, 8);
      this._matMarqueur = new THREE.MeshBasicMaterial({ color: 0xffb020, depthTest: false });
      this._matMarqueurSel = new THREE.MeshBasicMaterial({ color: 0x3ecf8e, depthTest: false });
      this._geoAnneau = new THREE.TorusGeometry(1, 0.28, 10, 24);
      this._matAnneau = new THREE.MeshBasicMaterial({ color: 0x3ecf8e, depthTest: false });
    }
    const r = Math.max(this.viewer.gridStep * 0.5, 0.05);
    for (const n of this.graph.nodes.values()) {
      const sel = this._estSelectionne('node', n.id);
      const m = new THREE.Mesh(this._geoMarqueur, sel ? this._matMarqueurSel : this._matMarqueur);
      m.scale.setScalar(sel ? r * 1.4 : r);
      m.position.set(n.x, n.y, 0.01);
      m.renderOrder = 999;
      this._apercu.add(m);
      this._marqueurs.set(n.id, m);
      if (sel) {
        // anneau vert autour du point sélectionné, bien visible
        const anneau = new THREE.Mesh(this._geoAnneau, this._matAnneau);
        anneau.scale.setScalar(r * 2.2);
        anneau.position.set(n.x, n.y, 0.02);
        anneau.rotation.x = Math.PI / 2;
        anneau.renderOrder = 1000;
        this._apercu.add(anneau);
      }
    }
  }
  _majCurseur(s) {
    if (!this._curseur) {
      this._curseur = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 8),
        new THREE.MeshBasicMaterial({ color: 0x3ecf8e, depthTest: false, transparent: true, opacity: 0.9 }));
      this._curseur.renderOrder = 999;
      this._apercu.add(this._curseur);
    }
    // Quand un accrochage est actif, la sphère s'efface au profit du SYMBOLE
    // du snap (carré, triangle, croix…), plus lisible que la couleur.
    const estSnap = s.type !== 'grille' && s.type !== 'libre';
    this._curseur.visible = !estSnap;
    this._curseur.position.set(s.x, s.y, 0.02);
    this._majMarqueurSnap(s);
  }

  /** Repères d'accrochage en direct : un SYMBOLE (sprite canvas, taille écran
   *  constante comme dans Rhino/AutoCAD) par type de snap + ligne de guidage
   *  en pointillés pour les directions. */
  _initMarqueursSnap() {
    this._marqueursSnap = new THREE.Group();
    this._marqueursSnap.renderOrder = 1001;
    this._apercu.add(this._marqueursSnap);

    const taille = 96;
    const tracer = (type, dessin) => {
      const c = document.createElement('canvas');
      c.width = c.height = taille;
      const ctx = c.getContext('2d');
      ctx.lineWidth = 5;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      ctx.strokeStyle = '#00ff88';
      ctx.fillStyle = '#00ff88';
      dessin(ctx, taille / 2, 28);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
      sp.visible = false;
      this._marqueursSnap.add(sp);
      this._glyphes[type] = sp;
    };
    const trait = (ctx, m, s) => { ctx.beginPath(); ctx.moveTo(m - s, m - s); ctx.lineTo(m + s, m + s); ctx.moveTo(m + s, m - s); ctx.lineTo(m - s, m + s); ctx.stroke(); };
    tracer('end', (ctx, m, s) => ctx.strokeRect(m - s, m - s, 2 * s, 2 * s));              // carré
    tracer('mid', (ctx, m, s) => { ctx.beginPath(); ctx.moveTo(m, m - s); ctx.lineTo(m - s, m + s); ctx.lineTo(m + s, m + s); ctx.closePath(); ctx.stroke(); });   // triangle
    tracer('intersection', trait);                                                          // croix
    tracer('surMur', (ctx, m, s) => { ctx.beginPath(); ctx.moveTo(m - s, m + s); ctx.lineTo(m - s, m - s); ctx.lineTo(m + s, m - s); ctx.stroke(); });            // équerre
    tracer('prolongation', (ctx, m, s) => { ctx.beginPath(); ctx.moveTo(m - s, m); ctx.lineTo(m + s, m); ctx.stroke(); ctx.beginPath(); ctx.arc(m + s, m, 4, 0, 2 * Math.PI); ctx.fill(); });
    tracer('parallele', (ctx, m, s) => { ctx.beginPath(); ctx.moveTo(m - s, m - 8); ctx.lineTo(m + s, m - 8); ctx.moveTo(m - s, m + 8); ctx.lineTo(m + s, m + 8); ctx.stroke(); });
    tracer('perpendiculaire', (ctx, m, s) => { ctx.beginPath(); ctx.moveTo(m - s, m + s); ctx.lineTo(m - s, m - s); ctx.lineTo(m + s, m - s); ctx.moveTo(m - s + 10, m - s + 10); ctx.lineTo(m - s + 10, m - s + 18); ctx.lineTo(m - s + 18, m - s + 18); ctx.stroke(); });
    tracer('ortho', (ctx, m, s) => { ctx.beginPath(); ctx.moveTo(m - s, m); ctx.lineTo(m + s, m); ctx.moveTo(m, m - s); ctx.lineTo(m, m + s); ctx.stroke(); });
    tracer('cloture', (ctx, m, s) => { ctx.beginPath(); ctx.moveTo(m - s, m - s); ctx.lineTo(m - s, m + s); ctx.lineTo(m + s, m + s); ctx.stroke(); });  // angle droit fermant
    tracer('grille', (ctx, m, s) => { ctx.beginPath(); ctx.arc(m, m, s * 0.7, 0, 2 * Math.PI); ctx.stroke(); });
    // reperage : un chevron pour l'alignement, une etoile pour le croisement
    tracer('alignement', (ctx, m, s) => { ctx.beginPath(); ctx.moveTo(m - s, m - s * 0.5); ctx.lineTo(m, m); ctx.lineTo(m - s, m + s * 0.5); ctx.stroke(); });
    tracer('apparente', (ctx, m, s) => { ctx.beginPath(); ctx.moveTo(m - s, m - s); ctx.lineTo(m + s, m + s); ctx.moveTo(m + s, m - s); ctx.lineTo(m - s, m + s); ctx.stroke(); ctx.beginPath(); ctx.setLineDash([6, 5]); ctx.moveTo(m - s * 1.5, m); ctx.lineTo(m + s * 1.5, m); ctx.stroke(); ctx.setLineDash([]); });
    tracer('croisement', (ctx, m, s) => { ctx.beginPath(); ctx.moveTo(m - s, m); ctx.lineTo(m + s, m); ctx.moveTo(m, m - s); ctx.lineTo(m, m + s); ctx.moveTo(m - s * 0.7, m - s * 0.7); ctx.lineTo(m + s * 0.7, m + s * 0.7); ctx.moveTo(m + s * 0.7, m - s * 0.7); ctx.lineTo(m - s * 0.7, m + s * 0.7); ctx.stroke(); });

    this._guideLigne = new THREE.Line(new THREE.BufferGeometry(),
      new THREE.LineDashedMaterial({ color: 0x00ff88, depthTest: false, transparent: true, dashSize: 0.16, gapSize: 0.1 }));
    this._guideLigne.visible = false;
    this._guideLigne.renderOrder = 1000;
    this._apercu.add(this._guideLigne);
  }

  /** Taille écran (m) d'un marqueur de snap : constante quel que soit le zoom. */
  _echelleSprite(px = 40) {
    const v = this.viewer, c = v.camera;
    let parPixel;
    if (c.isOrthographicCamera) {
      parPixel = (c.top - c.bottom) / v.canvas.clientHeight / (c.zoom || 1);
    } else {
      parPixel = metresParPixel(c, v.canvas.clientHeight, this.viewer.controls.target.distanceTo(c.position));
    }
    return parPixel * px;
  }

  _majMarqueurSnap(s) {
    const echelle = this._echelleSprite();
    for (const [type, sp] of Object.entries(this._glyphes)) {
      const actif = type === s.type;
      sp.visible = actif;
      if (actif) {
        sp.position.set(s.x, s.y, 0.1);
        sp.scale.set(echelle, echelle, 1);
      }
    }
    // ligne en pointillés : depuis l'extrémité du mur (prolongation), depuis
    // l'ancre de tracé (parallèle / perpendiculaire / ortho), ou les deux
    // branches de la fermeture à angle droit (cloture).
    /* Les lignes de suivi du reperage : une par rayon ayant produit le
       candidat, tracee de part et d'autre de sa reference. C'est cette
       ligne qui explique le point propose — sans elle, le curseur
       s'accroche a un endroit dont rien ne dit pourquoi. */
    if (s.type === 'alignement' || s.type === 'croisement' || s.type === 'apparente') {
      const pts = [];
      for (const seg of Reperage.segments(s, this.viewer.gridStep * 200 || 60)) {
        pts.push(new THREE.Vector3(seg.a.x, seg.a.y, 0.04),
                 new THREE.Vector3(seg.b.x, seg.b.y, 0.04));
      }
      this._guideLigne.geometry.dispose();
      this._guideLigne.geometry = new THREE.BufferGeometry().setFromPoints(pts);
      this._guideLigne.computeLineDistances();
      this._guideLigne.visible = pts.length > 0;
      return;
    }

    let origine = null, extension = false;
    if (s.type === 'prolongation' && s.ancre) { origine = s.ancre; extension = true; }
    else if (s.type === 'cloture' && s.courant && s.depart) {
      // deux traits : l'ancre → point de fermeture → point de départ
      this._guideLigne.geometry.dispose();
      this._guideLigne.geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(s.courant.x, s.courant.y, 0.04),
        new THREE.Vector3(s.x, s.y, 0.04),
        new THREE.Vector3(s.depart.x, s.depart.y, 0.04),
      ]);
      this._guideLigne.computeLineDistances();
      this._guideLigne.visible = true;
      return;
    }
    else if ((s.type === 'parallele' || s.type === 'perpendiculaire' || s.type === 'ortho') && this._ancre) {
      origine = this.graph.node(this._ancre);
    }
    if (origine) {
      const a = new THREE.Vector3(origine.x, origine.y, 0.04);
      const b = new THREE.Vector3(s.x, s.y, 0.04);
      let points;
      if (extension) {
        // la ligne d'extension dépasse le point visé, comme un tracking AutoCAD
        const d = b.clone().sub(a);
        const depassement = d.clone().normalize().multiplyScalar(Math.max(d.length() * 0.5, this.viewer.gridStep * 2));
        points = [a.clone().sub(depassement), b.clone().add(depassement)];
      } else {
        points = [a, b];
      }
      this._guideLigne.geometry.dispose();
      this._guideLigne.geometry = new THREE.BufferGeometry().setFromPoints(points);
      this._guideLigne.computeLineDistances();
      this._guideLigne.visible = true;
    } else {
      this._guideLigne.visible = false;
    }
  }
  _majLigne(a, s) {
    if (!this._ligne) {
      this._ligne = new THREE.Line(new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true }));
      this._ligne.renderOrder = 998;
      this._apercu.add(this._ligne);
    }
    this._ligne.geometry.dispose();
    this._ligne.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(a.x, a.y, 0.03), new THREE.Vector3(s.x, s.y, 0.03),
    ]);
  }
  /** Longueur/angle du segment en cours, remontés à la barre de statut (DOM),
   *  pas dessinés dans la scène : un texte redessiné à chaque mouvement est
   *  une source de latence inutile. */
  _majStatut(a, s) {
    const long = Math.hypot(s.x - a.x, s.y - a.y);
    const angle = (Math.atan2(s.y - a.y, s.x - a.x) * 180 / Math.PI + 360) % 360;
    this._onStatut?.({ long, angle, type: s.type });
  }

  /* ---- formes prédéfinies ---- */

  _majFormeApercu(forme, s) {
    if (!this._formeApercu) {
      this._formeApercu = new THREE.LineLoop(new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0xffb020, depthTest: false, transparent: true }));
      this._formeApercu.renderOrder = 998;
      this._apercu.add(this._formeApercu);
    }
    const pts = [];
    if (forme.type === 'rectangle') {
      const a = forme.a;
      pts.push(a.x, a.y, 0.03, s.x, a.y, 0.03, s.x, s.y, 0.03, a.x, s.y, 0.03);
    } else {
      const c = forme.c, r = Math.hypot(s.x - c.x, s.y - c.y);
      for (let i = 0; i < 32; i++) {
        const ang = i * 2 * Math.PI / 32;
        pts.push(c.x + r * Math.cos(ang), c.y + r * Math.sin(ang), 0.03);
      }
    }
    this._formeApercu.geometry.dispose();
    this._formeApercu.geometry = new THREE.BufferGeometry();
    this._formeApercu.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  }

  _majStatutForme(forme, s) {
    if (forme.type === 'rectangle') {
      this._onStatut?.({
        type: 'rectangle',
        largeur: Math.abs(s.x - forme.a.x), hauteur: Math.abs(s.y - forme.a.y),
      });
    } else {
      this._onStatut?.({
        type: 'cercle',
        rayon: Math.hypot(s.x - forme.c.x, s.y - forme.c.y),
      });
    }
  }

  _genererRectangle(a, b) {
    if (Math.abs(a.x - b.x) < 1e-6 || Math.abs(a.y - b.y) < 1e-6) return;
    const opts = { thickness: this.epaisseur, height: this.hauteur, elevation: this.elevation };
    const n1 = this.graph.addNode(a.x, a.y);
    const n2 = this.graph.addNode(b.x, a.y);
    const n3 = this.graph.addNode(b.x, b.y);
    const n4 = this.graph.addNode(a.x, b.y);
    for (const [p, q] of [[n1, n2], [n2, n3], [n3, n4], [n4, n1]]) {
      const wid = this.graph.addWall(p, q, opts);
      if (wid) { this.graph.intersectAndSplit(wid); this._dernierMur = wid; }
    }
  }

  _genererCercle(c, r) {
    if (!(r > 0.05)) return;
    const N = 24;
    const opts = { thickness: this.epaisseur, height: this.hauteur, elevation: this.elevation };
    const ids = [];
    for (let i = 0; i < N; i++) {
      const ang = i * 2 * Math.PI / N;
      ids.push(this.graph.addNode(c.x + r * Math.cos(ang), c.y + r * Math.sin(ang)));
    }
    for (let i = 0; i < N; i++) {
      this.graph.addWall(ids[i], ids[(i + 1) % N], opts);
    }
    this._dernierMur = null;
  }

  /* ---- poignées de nœuds (édition en vue 3D / plan) ---- */

  /** Le nœud sous le curseur, via les poignées, ou null. */
  _poigneeSous(ev) {
    if (!this._poignees3D || !this._poignees3D.children.length) return null;
    const v = this.viewer;
    const r = v.canvas.getBoundingClientRect();
    v.pointer.x = ((ev.clientX - r.left) / r.width) * 2 - 1;
    v.pointer.y = -((ev.clientY - r.top) / r.height) * 2 + 1;
    v.ray.setFromCamera(v.pointer, v.camera);
    const hits = v.ray.intersectObjects(this._poignees3D.children, false);
    return hits.length ? hits[0].object.userData.nodeId : null;
  }

  /** Affiche les poignées des nœuds d'un mur sélectionné (ou les masque). */
  setMurSelectionne(wallId) {
    this._murSel3D = wallId || null;
    // repeindre suffit : reconstruire la section a chaque clic couterait une
    // triangulation par mur pour un changement de couleur
    for (const m of this._sectionGroup?.children || []) {
      m.material = m.userData.wallId === this._murSel3D ? MATERIAU_SECTION_SEL : MATERIAU_SECTION;
    }
    this._majPoignees();
    this.viewer?.demanderImage?.(2);
  }

  _majPoignees() {
    if (!this._poignees3D) {
      this._poignees3D = new THREE.Group();
      this._poignees3D.renderOrder = 1000;
      this.viewer.scene.add(this._poignees3D);
      this._geoPoignee = new THREE.SphereGeometry(1, 14, 10);
      this._matPoignee = new THREE.MeshBasicMaterial({ color: 0xff5f56, depthTest: false });
    }
    for (const m of [...this._poignees3D.children]) this._poignees3D.remove(m);
    if (!this._murSel3D) return;
    const w = this.graph.walls.get(this._murSel3D);
    if (!w) return;
    const r = Math.max(this.viewer.gridStep * 0.8, 0.08);
    for (const nid of [w.a, w.b]) {
      const n = this.graph.node(nid);
      const m = new THREE.Mesh(this._geoPoignee, this._matPoignee);
      m.scale.setScalar(r);
      m.position.set(n.x, n.y, (w.elevation || 0) + 0.06);
      m.userData.nodeId = nid;
      this._poignees3D.add(m);
    }
  }

  _regenThrottle() {
    if (this._regenTimer) return;
    this._regenTimer = setTimeout(() => {
      this._regenTimer = null;
      this.generer3D();
      this._majPoignees();
    }, 80);
  }

  _regenImmediate() {
    if (this._regenTimer) { clearTimeout(this._regenTimer); this._regenTimer = null; }
    this.generer3D();
    this._majPoignees();
  }

  /* ---- fenêtre de sélection (édition) ---- */

  _majMarquee(a, b) {
    if (!a || !b) {
      this._marqueeApercu = this._retirerApercu(this._marqueeApercu);
      return;
    }
    if (!this._marqueeApercu) {
      this._marqueeApercu = new THREE.LineLoop(new THREE.BufferGeometry(),
        new THREE.LineBasicMaterial({ color: 0x3d8bff, depthTest: false, transparent: true }));
      this._marqueeApercu.renderOrder = 1002;
      this._apercu.add(this._marqueeApercu);
    }
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    this._marqueeApercu.geometry.dispose();
    this._marqueeApercu.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(minX, minY, 0.05), new THREE.Vector3(maxX, minY, 0.05),
      new THREE.Vector3(maxX, maxY, 0.05), new THREE.Vector3(minX, maxY, 0.05),
    ]);
  }

  /** Sélection par fenêtre : nœuds contenus + murs entièrement contenus. */
  _selectionFenetre(a, b, additif = false) {
    const minX = Math.min(a.x, b.x), maxX = Math.max(a.x, b.x);
    const minY = Math.min(a.y, b.y), maxY = Math.max(a.y, b.y);
    const dans = (pt) => pt.x >= minX && pt.x <= maxX && pt.y >= minY && pt.y <= maxY;
    const sel = additif ? [...this._selection] : [];
    const ajout = (type, id) => { if (!sel.some(s => s.type === type && s.id === id)) sel.push({ type, id }); };
    for (const n of this.graph.nodes.values()) if (dans(n)) ajout('node', n.id);
    for (const w of this.graph.walls.values()) {
      if (dans(this.graph.node(w.a)) && dans(this.graph.node(w.b))) ajout('wall', w.id);
    }
    this._selection = sel;
    this._rafraichirApercu();
    this._reconstruireProxy();
  }

  /* ---- plan de coupe (vraie vue en plan) ---- */

  /** Emprise 3D du bâtiment (pour cadrer la vue en plan). */
  _bornes() {
    const box = new THREE.Box3().setFromObject(this.group);
    return box.isEmpty() ? null : box;
  }

  /**
   * Active/désactive le plan de coupe :
   *   • caméra orthographique de dessus (vraie projection en plan) ;
   *   • clivage du bâti au plan horizontal H (poché noir de la section) ;
   *   • les équipements de la bibliothèque ne sont PAS clivés.
   */
  setModePlan(on, H = this.hauteurCoupe) {
    this._modePlan = on;
    this.hauteurCoupe = H;
    const plan = on ? new THREE.Plane(new THREE.Vector3(0, 0, -1), H) : null;
    for (const m of MATERIAUX_CLIVES) m.clippingPlanes = plan ? [plan] : [];
    this.viewer.renderer.localClippingEnabled = true;
    for (const g of this._menuiseries) g.visible = !on;      // le poché montre déjà le trou
    // le poché (section) est bâti par generer3D, pas ici : pendant le tracé,
    // le groupe 3D est masqué et n'a pas besoin de section.
    if (this._sectionGroup) this._sectionGroup.visible = on;

    if (on) {
      this.viewer.setPlanBox(this._bornes());
      this.viewer.setModePlan(true);
    } else {
      this.viewer.setPlanBox(null);
      this.viewer.setModePlan(false);
    }
    this.viewer.demanderImage(3);
  }

  get modePlan() { return this._modePlan; }

  /* ---- plan (entrée du mode dessin) ---- */
  _entrerPlan() {
    this.setModePlan(true, this.hauteurCoupe);
  }

  /* ---- sélection / suppression ---- */
  _estSelectionne(type, id) {
    return this._selection.some(s => s.type === type && s.id === id);
  }
  _finirSelection() {
    this._selection = [];
    this._rafraichirApercu();
    this._reconstruireProxy();
  }
  _supprimerSelection() {
    if (!this._selection.length) return;
    const noeuds = new Set();
    for (const s of this._selection) {
      if (s.type === 'node') {
        for (const wid of this.graph.incident(s.id)) this.graph.supprimerMur(wid);
        noeuds.add(s.id);
      } else if (s.type === 'wall') {
        this.graph.supprimerMur(s.id);
      }
    }
    for (const nid of noeuds) this.graph.nodes.delete(nid);
    this._selection = [];
    this._rafraichirApercu();
    this._reconstruireProxy();
    this._onChange();
  }

  /* ---- proxy de tracé (2D, sans calcul lourd) ----
     Les murs sont dessinés en rubans plats (MeshBasicMaterial), sans extrusion,
     lumière ni CSG : c'est ce qui permet de déplacer un nœud à 60 i/s. Le 3D
     n'est régénéré qu'à la sortie du tracé. */
  _reconstruireProxy() {
    for (const m of [...this._proxyMurs.children]) {
      this._proxyMurs.remove(m);
      m.geometry?.dispose?.();
    }
    for (const w of this.graph.walls.values()) {
      const outline = this.graph.wallOutline(w.id);
      const shape = new THREE.Shape(outline.map(p => new THREE.Vector2(p.x, p.y)));
      const geo = new THREE.ShapeGeometry(shape);
      const sel = this._estSelectionne('wall', w.id);
      const mesh = new THREE.Mesh(geo, sel ? MATERIAU_PROXY_SEL : MATERIAU_PROXY);
      mesh.position.z = 0.005;
      this._proxyMurs.add(mesh);
    }
  }

  /* ---- ouverture ---- */
  ajouterOuverture(wallId, s, type) {
    const w = this.graph.walls.get(wallId);
    if (!w) return false;
    const f = this.graph.wallFrame(w);
    const largeur = type === 'door' ? 0.9 : 1.2;
    const demi = Math.min(largeur / 2, f.len * 0.3);
    const s0 = Math.max(0, s - demi / f.len), s1 = Math.min(1, s + demi / f.len);
    if ((s1 - s0) * f.len < 0.3) return false;
    w.openings.push({
      id: 'o' + (++this.graph._n), s0, s1,
      z0: 0, z1: type === 'door' ? this.hauteurPorte : 1.1, type,
    });
    this._dernierMur = wallId;
    this.generer3D();
    return true;
  }

  /* ---- génération 3D ---- */
  _nettoyer() {
    for (const o of [...this.group.children]) {
      this.group.remove(o);
      o.traverse?.(c => { c.geometry?.dispose?.(); });
    }
    this._menuiseries = [];
    this._sectionGroup = null;
    this._murs3D = [];
  }

  generer3D() {
    this._nettoyer();
    for (const w of this.graph.walls.values()) this._mur(w);
    for (const pts of this.graph.detectRooms()) this._dalle(pts);
    this._construireSection();
    // les murs 3D deviennent cliquables dans la sélection générale
    /* En plan, ce sont les sections qu'on vise, pas les volumes : vu de
       dessus un mur 3D n'offre que la tranche de son arete superieure. Les
       deux jeux sont donc proposes au clic, et celui qui est visible
       l'emporte naturellement puisque l'autre est masque. */
    this.viewer.selectables = [...this._murs3D, ...(this._sectionGroup?.children || [])];
    this.viewer.marquerOmbres();
    this.viewer.demanderImage(2);
  }

  _extruder(pts, hauteur) {
    const shape = new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.y)));
    return new THREE.ExtrudeGeometry(shape, { depth: hauteur, bevelEnabled: false });
  }

  _mur(w) {
    const outline = this.graph.wallOutline(w.id);
    let geo = this._extruder(outline, w.height);
    // percements : soustraction booléenne (CSG), qui respecte la hauteur
    // exacte de chaque ouverture (linteau conservé au-dessus d'une porte).
    if (w.openings.length) geo = this._percer(geo, w, outline);

    const mesh = new THREE.Mesh(geo, MATERIAU_MUR);
    mesh.position.z = w.elevation;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.userData.uid = w.id;
    mesh.userData.batiment = true;
    mesh.userData.wallId = w.id;
    this.group.add(mesh);
    this._murs3D.push(mesh);

    for (const op of w.openings) {
      const p = paramsOuverture(w, this.graph, op);
      const gen = op.type === 'window' ? FenetreGenerator : DoorGenerator;
      const menuiserie = gen.generer(p);
      menuiserie.userData.menuiserie = true;
      this.group.add(menuiserie);
      this._menuiseries.push(menuiserie);
    }
  }

  /** Supprime un mur (par son id topologique) et régénère. */
  supprimerMur(wallId) {
    if (!this.graph.walls.has(wallId)) return false;
    this.graph.supprimerMur(wallId);
    this.generer3D();
    this._onChange();
    return true;
  }

  /** Modifie les paramètres d'un mur (épaisseur / hauteur / élévation). */
  setParametresMur(wallId, patch) {
    const w = this.graph.walls.get(wallId);
    if (!w) return false;
    Object.assign(w, patch);
    this.generer3D();
    this._onChange();
    return true;
  }

  /**
   * Poché du plan de coupe : la section horizontale des murs à la hauteur H,
   * remplie de noir. Les percements traversant H y apparaissent en creux
   * (porte coupée), les linteaux au-dessus restent pleins.
   */
  _construireSection() {
    if (this._sectionGroup) this.group.remove(this._sectionGroup);
    this._sectionGroup = new THREE.Group();
    this._sectionGroup.name = 'section';
    this._sectionGroup.visible = this._modePlan;
    this.group.add(this._sectionGroup);

    const H = this.hauteurCoupe;
    for (const w of this.graph.walls.values()) {
      const z0 = w.elevation, z1 = w.elevation + w.height;
      if (H < z0 || H > z1) continue;          // le plan ne traverse pas ce mur
      const outline = this.graph.wallOutline(w.id);
      const shape = new THREE.Shape(outline.map(p => new THREE.Vector2(p.x, p.y)));
      for (const op of w.openings) {
        const o0 = w.elevation + (op.z0 || 0);
        const o1 = w.elevation + (op.z1 ?? w.height);
        if (o0 <= H && H < o1) {
          shape.holes.push(new THREE.Path(
            this.graph.openingOutline(w, op).map(p => new THREE.Vector2(p.x, p.y))));
        }
      }
      const geo = new THREE.ShapeGeometry(shape);
      const sel = this._murSel3D === w.id;
      const mesh = new THREE.Mesh(geo, sel ? MATERIAU_SECTION_SEL : MATERIAU_SECTION);
      mesh.position.z = H;
      mesh.renderOrder = 2;
      /* Le poche est cliquable, et c'est ce qui rend l'edition en plan
         praticable : vu de dessus, le mur 3D se reduit a une arete de
         quelques pixels, alors que sa section offre toute sa surface. */
      mesh.userData.uid = w.id;
      mesh.userData.wallId = w.id;
      mesh.userData.batiment = true;
      mesh.userData.section = true;
      this._sectionGroup.add(mesh);
    }
  }

  _percer(geo, w, outline) {
    try {
      let cur = new Brush(geo);
      cur.updateMatrixWorld(true);
      for (const op of w.openings) {
        const c = this.graph.caisseOuverture(w, op);
        const box = new THREE.BoxGeometry(c.largeur, c.epaisseur, c.z1 - c.z0);
        const trou = new Brush(box);
        trou.position.set(c.cx, c.cy, c.z0 + (c.z1 - c.z0) / 2);
        trou.rotation.z = c.angle;
        trou.updateMatrixWorld(true);
        cur = evaluator.evaluate(cur, trou, SUBTRACTION);
      }
      return cur.geometry;
    } catch (e) {
      console.warn('CSG indisponible, repli paramétrique :', e);
      // repli : percement pleine hauteur (contour évidé)
      const shape = new THREE.Shape(outline.map(p => new THREE.Vector2(p.x, p.y)));
      for (const op of w.openings) {
        shape.holes.push(new THREE.Path(this.graph.openingOutline(w, op).map(p => new THREE.Vector2(p.x, p.y))));
      }
      return new THREE.ExtrudeGeometry(shape, { depth: w.height, bevelEnabled: false });
    }
  }

  _dalle(pts) {
    const contour = pts.map(p => new THREE.Vector2(p.x, p.y));
    const faces = THREE.ShapeUtils.triangulateShape(contour, []);
    const pos = new Float32Array(faces.length * 9);
    for (let f = 0; f < faces.length; f++) {
      for (let k = 0; k < 3; k++) {
        const p = pts[faces[f][k]];
        const i = (f * 3 + k) * 3;
        pos[i] = p.x; pos[i + 1] = p.y; pos[i + 2] = 0;
      }
    }
    const geo = () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.computeVertexNormals();
      return g;
    };
    const sol = new THREE.Mesh(geo(), MATERIAU_SOL);
    sol.position.z = this.elevation;
    sol.receiveShadow = true;
    this.group.add(sol);

    const plafond = new THREE.Mesh(geo(), MATERIAU_PLAFOND);
    plafond.position.z = this.elevation + this.hauteur;
    plafond.rotation.x = Math.PI;
    this.group.add(plafond);
  }

  /* ---- gestion ---- */
  vider() {
    this._nettoyer();
    this.graph = new PlanGraph();
    this._ancre = null;
    this._dernierMur = null;
    this._selection = [];
    this._murSel3D = null;
    this._majPoignees();
    this._reconstruireProxy();
    for (const m of this._marqueurs.values()) this._apercu.remove(m);
    this._marqueurs.clear();
    this._ligne = this._retirerApercu(this._ligne);
    this._curseur = this._retirerApercu(this._curseur);
    this._formeApercu = this._retirerApercu(this._formeApercu);
    this._marqueeApercu = this._retirerApercu(this._marqueeApercu);
    this.viewer.selectables = [];
    this.viewer.demanderImage(2);
    this._onChange();
  }

  setParametres(patch) {
    Object.assign(this, patch);
  }

  stats() {
    return {
      murs: this.graph.walls.size,
      noeuds: this.graph.nodes.size,
      pieces: this.graph.detectRooms().length,
      ouvertures: [...this.graph.walls.values()].reduce((n, w) => n + w.openings.length, 0),
    };
  }

  /** État sérialisable du graphe, pour l'historique (undo/redo). */
  serialiser() {
    return {
      n: this.graph._n,
      nodes: [...this.graph.nodes.values()].map(n => ({ id: n.id, x: n.x, y: n.y })),
      walls: [...this.graph.walls.values()].map(w => ({
        id: w.id, a: w.a, b: w.b, thickness: w.thickness, height: w.height,
        elevation: w.elevation, openings: w.openings.map(o => ({ ...o })),
      })),
    };
  }

  /** Restaure le graphe depuis un état sérialisé, puis régénère le 3D. */
  restaurer(data) {
    if (!data) return;
    const g = new PlanGraph();
    g._n = data.n || 0;
    for (const n of data.nodes) g.nodes.set(n.id, { id: n.id, x: n.x, y: n.y, wallIds: new Set() });
    for (const w of data.walls) {
      g.walls.set(w.id, {
        id: w.id, a: w.a, b: w.b, thickness: w.thickness, height: w.height,
        elevation: w.elevation || 0, openings: (w.openings || []).map(o => ({ ...o })),
      });
      g.nodes.get(w.a)?.wallIds.add(w.id);
      g.nodes.get(w.b)?.wallIds.add(w.id);
    }
    this.graph = g;
    this._ancre = null;
    this._selection = [];
    this._murSel3D = null;
    this._majPoignees();
    this._reconstruireProxy();
    this.generer3D();
  }

  _onChange() {}
}
