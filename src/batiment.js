import * as THREE from '../vendor/three/three.module.js';
import { PlanGraph, add, scale, normalize, perp, cross, dist, sub, dot, lineIntersect, decalageCorps, facesMur } from './core/topologie.js';
import { snapOsnap, metresParPixel } from './core/osnap.js';
import { Reperage, intersectionsApparentes, tangentesVersCercle } from './core/reperage.js';
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
const MATERIAUX_CLIVES = [MATERIAU_MUR];

const evaluator = new Evaluator();

/* ══════════════════ menuiseries (composants fermés) ══════════════════ */

/** Paramètres d'une ouverture, en 1D sur le mur + hauteurs locales. */
function paramsOuverture(w, graph, op) {
  const f = graph.wallFrame(w);
  const largeur = (op.s1 - op.s0) * f.len;
  const sMid = (op.s0 + op.s1) / 2;
  // le corps du mur est decale lateralement par sa justification (nu
  // interieur/exterieur) ; l'ouverture generee en 3D doit suivre le corps,
  // pas rester sur l'axe trace.
  const centre = add(add(f.A, scale(f.d, sMid * f.len)), decalageCorps(w, f));
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
    if (this.b._noeudVerrouille(nid)) { this.b._onMessage?.('Mur verrouillé', true); return; }
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
    if (ev.ctrlKey) {
      // Ctrl+clic : acquisition manuelle du repere, jamais un point de mur —
      // il ne faut pas que la meme main pose a la fois une reference et un
      // sommet, sans quoi le trace se troue d'un point qu'on ne voulait pas.
      this.b.basculerRepere(ev);
      return;
    }
    const p = this.b._solSous(ev);
    if (!p) return;
    if (this.b._modeEdition) {
      // édition : saisir un nœud pour le déplacer/sélectionner, sinon fenêtre
      const node = this.b.graph.nodeSous(p, this.b._tolerancePixels(p, 20));
      if (node) {
        if (this.b._noeudVerrouille(node.id)) {
          this.b._onMessage?.('Mur verrouillé', true);
          return;
        }
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
        justification: this.b.justification,
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

/** Outils topologiques d'édition des murs, en vue de plan :
 *   • SCINDER : couper un mur en deux au point cliqué (clic unique) ;
 *   • AJUSTER : raccorder l'extrémité d'un mur à la droite d'un mur de
 *     référence — trim si l'intersection est réelle, prolongement si elle
 *     est apparente (le mur est raccourci ou allongé jusqu'à la limite) ;
 *   • ALIGNER : rendre un mur parallèle à un mur de référence (milieu conservé) ;
 *   • DÉCALER : copier un mur en parallèle, à distance signée.
 *  Les quatre opèrent sur le graphe topologique, jamais sur les items.
 *  Portée depuis la branche « Open code », relue intégralement — la seule
 *  correction nécessaire a été ailleurs (cornerPoints, voir core/topologie.js),
 *  ce module-ci raisonne sur un seul mur à la fois et n'a jamais eu ce défaut. */
class EtatTopo extends Etat {
  entrer() {
    this._depart = null;
    this._ref = null;              // mur choisi en premier : { wallId, frame }
    this._refCandidate = null;     // mur survolé (référence potentielle, aligner)
    this._marqueur = null;
    this._preview = null;          // ligne d'aperçu (décalage)
    this._lignesAxe = null;        // groupe des 3 axes d'alignement (aligner)
    this.b.setMurSelectionne(null);
    this.b.group.visible = false;
    this.b._apercu.visible = true;
    this.b._entrerPlan();
    this.b._reconstruireProxy();
    this.b._rafraichirApercu();
    this._statut();
  }
  quitter() {
    this.b._apercu.visible = false;
    this._retirerMarqueur();
    this._retirerPreview();
    this._retirerAxe();
    this.b._finirSelection();
    this.b.group.visible = true;
    if (!this.b.vide) this.b.generer3D();   // calcul lourd : une seule fois
    this.b._onStatut?.(null);
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
    if (this.b._outilTopo === 'scinder') {
      const sous = this.b.graph.murSous(p, this.b._tolerancePixels(p, 15));
      if (sous) this._montrerMarqueur(sous.pt);
      else this._retirerMarqueur();
    } else if (this.b._outilTopo === 'ajuster') {
      this._survolAjuster(p);
    } else if (this.b._outilTopo === 'aligner') {
      this._survolCandidat(p);
    } else {
      this._survolDecaler(p);
    }
  }
  surUp(ev) {
    if (ev.button !== 0) return;
    const dep = this._depart; this._depart = null;
    if (!dep || Math.hypot(ev.clientX - dep.x, ev.clientY - dep.y) > 5) return;
    const p = this.b._solSous(ev);
    if (!p) return;
    ev.stopPropagation();
    ev.preventDefault();
    if (this.b._outilTopo === 'scinder') this._clicScinder(p);
    else if (this.b._outilTopo === 'ajuster') this._clicAjuster(p);
    else if (this.b._outilTopo === 'aligner') this._clicAligner(p);
    else this._clicDecaler(p);
  }
  surKey(e) {
    if (e.key === 'Escape') this.b.arreter();
  }

  /** Texte de la barre de statut, propre à chaque outil et à son avancement. */
  _statut() {
    const txt = {
      scinder: 'Cliquez un mur pour le couper en deux',
      ajuster: this._ref ? 'Référence choisie — cliquez le mur à raccorder'
                         : 'Cliquez le mur limite (référence)',
      aligner: this._ref ? 'Référence choisie — cliquez le mur à aligner dessus'
                         : 'Survolez un mur : axe central, nu intérieur et nu extérieur sont détectés',
      decaler: this._ref ? 'Cliquez un point pour fixer la distance de décalage'
                         : 'Cliquez le mur à décaler',
    }[this.b._outilTopo];
    if (txt) this.b._onStatut?.({ type: 'topo', texte: txt });
  }

  /* — scinder — */
  _clicScinder(p) {
    const sous = this.b.graph.murSous(p, this.b._tolerancePixels(p, 15));
    if (!sous) { this._msg('Cliquez sur un mur à couper', true); return; }
    const r = this.b._scinder(sous.wallId, sous.s);
    this._msg(r.ok ? 'Mur scindé' : r.message, !r.ok);
  }

  /* — ajuster / prolonger — */
  _survolAjuster(p) {
    if (!this._ref) { this._retirerMarqueur(); return; }
    const sous = this.b.graph.murSous(p, this.b._tolerancePixels(p, 15));
    if (!sous || sous.wallId === this._ref.wallId) { this._retirerMarqueur(); return; }
    const ft = this.b.graph.wallFrame(sous.wall);
    const X = lineIntersect(ft.A, ft.d, this._ref.frame.A, this._ref.frame.d);
    if (X) this._montrerMarqueur(X, 0x3d8bff);
    else this._retirerMarqueur();
  }
  _clicAjuster(p) {
    const tol = this.b._tolerancePixels(p, 15);
    const sous = this.b.graph.murSous(p, tol);
    if (!sous) { this._msg('Cliquez sur un mur', true); return; }
    if (!this._ref) {
      // premier clic : le mur de référence (la limite à laquelle on raccorde)
      this._ref = { wallId: sous.wallId, frame: this.b.graph.wallFrame(sous.wall) };
      this._statut();
      this._msg('Référence choisie — cliquez le mur à raccorder');
      return;
    }
    if (sous.wallId === this._ref.wallId) { this._msg('Choisissez un AUTRE mur', true); return; }
    const ft = this.b.graph.wallFrame(sous.wall);
    const X = lineIntersect(ft.A, ft.d, this._ref.frame.A, this._ref.frame.d);
    if (!X) { this._msg('Murs parallèles : aucune intersection', true); return; }
    // extrémité déplacée = la plus proche du point cliqué (le « côté » choisi)
    const dA = dist(p, ft.A), dB = dist(p, ft.B);
    const extremite = dA < dB ? 'a' : 'b';
    const E = extremite === 'a' ? ft.A : ft.B;
    const F = extremite === 'a' ? ft.B : ft.A;
    // l'intersection doit rester du côté de l'extrémité déplacée, sans quoi
    // le mur se retournerait (elle tombe au-delà de l'autre extrémité).
    if (dot(sub(X, F), sub(E, F)) <= 1e-9) {
      this._msg('Intersection de l’autre côté du mur', true);
      return;
    }
    const r = this.b._deplacerExtremite(sous.wallId, extremite, X, this._ref.wallId);
    this._msg(r.ok ? 'Mur raccordé' : r.message, !r.ok);
  }

  /* — aligner — */
  _offAxe(w, axe) {
    const f = facesMur(w);
    return axe === 'interieur' ? f.g : (axe === 'exterieur' ? f.r : 0);
  }
  _nomAxe(axe) {
    return { centre: 'axe central', interieur: 'nu intérieur', exterieur: 'nu extérieur' }[axe] || axe;
  }
  _axeLePlusProche(w, frame, p) {
    const axes = [
      { axe: 'centre', off: 0 },
      { axe: 'interieur', off: facesMur(w).g },
      { axe: 'exterieur', off: facesMur(w).r },
    ];
    let best = axes[0], bestD = Infinity;
    for (const a of axes) {
      const d = Math.abs(dot(sub(p, frame.A), frame.n) - a.off);
      if (d < bestD) { bestD = d; best = a; }
    }
    return best;
  }
  _survolCandidat(p) {
    // Survol : les TROIS axes d'alignement du mur (centre, nu intérieur, nu
    // extérieur) sont affichés ; le plus proche du curseur est surligné. C'est
    // le geste SmartTrack — la référence se décide en regardant, pas en cliquant.
    const sous = this.b.graph.murSous(p, this.b._tolerancePixels(p, 15));
    if (sous && (!this._ref || sous.wallId !== this._ref.wallId)) {
      const frame = this.b.graph.wallFrame(sous.wall);
      const axe = this._axeLePlusProche(sous.wall, frame, p);
      this._refCandidate = { wallId: sous.wallId, frame, axe: axe.axe, wall: sous.wall };
      this._montrerAxes(sous.wall, frame, axe.axe);
    } else if (this._ref) {
      this._refCandidate = null;
      this._montrerAxes(this._ref.wall, this._ref.frame, this._ref.axe);
    } else {
      this._refCandidate = null;
      this._retirerAxe();
    }
  }
  _clicAligner(p) {
    const sous = this.b.graph.murSous(p, this.b._tolerancePixels(p, 15));
    if (!sous) { this._msg('Cliquez sur un mur', true); return; }
    if (!this._ref) {
      const frame = this.b.graph.wallFrame(sous.wall);
      const axe = this._axeLePlusProche(sous.wall, frame, p);
      this._ref = { wallId: sous.wallId, frame, axe: axe.axe, wall: sous.wall };
      this._montrerAxes(sous.wall, frame, axe.axe);
      this._statut();
      this._msg(`Référence choisie (${this._nomAxe(axe.axe)}) — cliquez le mur à aligner dessus`);
      return;
    }
    if (sous.wallId === this._ref.wallId) { this._msg('Choisissez un AUTRE mur', true); return; }
    const frame = this.b.graph.wallFrame(sous.wall);
    const axe = this._axeLePlusProche(sous.wall, frame, p);
    const r = this.b._aligner(sous.wallId, this._ref.wallId, axe.axe, this._ref.axe);
    this._msg(r.ok ? 'Mur aligné' : r.message, !r.ok);
  }

  /* — décaler — */
  _survolDecaler(p) {
    if (!this._ref) { this._retirerMarqueur(); this._retirerPreview(); return; }
    const f = this._ref.frame;
    const e = dot(sub(p, f.A), f.n);   // distance signée le long de la normale
    this._montrerPreview(add(f.A, scale(f.n, e)), add(f.B, scale(f.n, e)));
    this._montrerMarqueur(p, 0x3d8bff);
  }
  _clicDecaler(p) {
    const sous = this.b.graph.murSous(p, this.b._tolerancePixels(p, 15));
    if (!this._ref) {
      if (!sous) { this._msg('Cliquez sur un mur à décaler', true); return; }
      this._ref = { wallId: sous.wallId, frame: this.b.graph.wallFrame(sous.wall) };
      this._statut();
      this._msg('Mur choisi — cliquez un point pour la distance');
      return;
    }
    const f = this._ref.frame;
    const e = dot(sub(p, f.A), f.n);
    const r = this.b._decaler(this._ref.wallId, e);
    this._msg(r.ok ? 'Mur décalé' : r.message, !r.ok);
  }

  /* — marqueur / aperçu / retour utilisateur — */
  _montrerPreview(A, B) {
    if (!this._preview) {
      this._preview = new THREE.Line(new THREE.BufferGeometry(),
        new THREE.LineDashedMaterial({ color: 0xffb020, depthTest: false, dashSize: 0.16, gapSize: 0.1 }));
      this._preview.renderOrder = 1000;
      this.b._apercu.add(this._preview);
    }
    this._preview.geometry.dispose();
    this._preview.geometry = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(A.x, A.y, 0.05), new THREE.Vector3(B.x, B.y, 0.05),
    ]);
    this._preview.computeLineDistances();
    this._preview.visible = true;
  }
  _retirerPreview() {
    if (this._preview) this._preview.visible = false;
  }
  /** Affiche les TROIS axes d'alignement d'un mur (centre, nu intérieur, nu
   *  extérieur), l'axe le plus proche du curseur étant surligné. */
  _montrerAxes(wall, frame, axeActif = null) {
    if (!this._lignesAxe) {
      this._lignesAxe = new THREE.Group();
      this._lignesAxe.renderOrder = 1000;
      this._lignesAxe.userData.lignes = [];
      for (let i = 0; i < 3; i++) {
        const l = new THREE.Line(new THREE.BufferGeometry(),
          new THREE.LineDashedMaterial({ color: 0x3d8bff, depthTest: false, dashSize: 0.16, gapSize: 0.1, transparent: true }));
        this._lignesAxe.add(l);
        this._lignesAxe.userData.lignes.push(l);
      }
      this.b._apercu.add(this._lignesAxe);
    }
    const ext = Math.max(this.b.viewer.gridStep * 4, 2);
    const f = facesMur(wall);
    const axes = [
      { axe: 'centre', off: 0 },
      { axe: 'interieur', off: f.g },
      { axe: 'exterieur', off: f.r },
    ];
    axes.forEach((a, i) => {
      const l = this._lignesAxe.userData.lignes[i];
      const o = add(frame.A, scale(frame.n, a.off));
      const p1 = { x: o.x - frame.d.x * ext, y: o.y - frame.d.y * ext };
      const p2 = { x: o.x + frame.d.x * ext, y: o.y + frame.d.y * ext };
      l.geometry.dispose();
      l.geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(p1.x, p1.y, 0.05), new THREE.Vector3(p2.x, p2.y, 0.05),
      ]);
      l.computeLineDistances();
      const actif = a.axe === axeActif;
      l.material.color.set(actif ? 0x3ecf8e : 0x3d8bff);
      l.material.opacity = actif ? 1 : 0.3;
      l.visible = true;
    });
    this._lignesAxe.visible = true;
  }
  _retirerAxe() {
    if (this._lignesAxe) this._lignesAxe.visible = false;
  }
  _montrerMarqueur(p, couleur = 0xff5f56) {
    if (!this._marqueur) {
      this._marqueur = new THREE.Mesh(
        new THREE.SphereGeometry(1, 12, 8),
        new THREE.MeshBasicMaterial({ color: couleur, depthTest: false, transparent: true, opacity: 0.95 })
      );
      this._marqueur.renderOrder = 1001;
      this.b._apercu.add(this._marqueur);
    }
    this._marqueur.material.color.set(couleur);
    this._marqueur.scale.setScalar(Math.max(this.b.viewer.gridStep * 0.4, 0.04));
    this._marqueur.position.set(p.x, p.y, 0.06);
    this._marqueur.visible = true;
  }
  _retirerMarqueur() {
    if (this._marqueur) this._marqueur.visible = false;
  }
  _msg(texte, err = false) { this.b._onMessage?.(texte, err); }
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
    /* Les cercles traces, retenus sous leur forme IDEALE.

       Le graphe ne connait que des segments : un cercle y devient
       vingt-quatre murs et son centre disparait. Or c'est le cercle que
       l'utilisateur a en tete, et c'est de lui qu'il veut la tangente. On
       garde donc le couple centre-rayon a cote du graphe, sans quoi
       l'information est perdue a la seconde ou le trait est pose. */
    this.cercles = [];
    this._initMarqueursSnap();

    this._ancre = null;
    /* Les marqueurs de noeuds vivent dans leur propre groupe, et non dans
       une liste tenue a la main.

       C'est la difference entre « on retire ce qu'on se souvient d'avoir
       ajoute » et « on vide le tiroir ». L'anneau de selection etait ajoute
       a l'apercu sans entrer dans la liste : il n'en sortait donc jamais, et
       restait affiche a l'emplacement d'un point supprime. Un groupe qu'on
       vide en entier ne peut pas avoir cet oubli. */
    this._groupeNoeuds = new THREE.Group();
    this._groupeNoeuds.renderOrder = 999;
    this._apercu.add(this._groupeNoeuds);
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
    this._onMessage = null;      // callback toast (retour des outils topologiques)
    this._onEtat = null;         // callback changement d'état (synchronisation UI)
    this._outilTopo = 'scinder'; // outil topologique actif : scinder|ajuster|aligner|decaler
    this.justification = 'centre';   // ligne de référence des NOUVEAUX murs tracés
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
      topo: new EtatTopo(this),
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
  get etatNom() {
    return this._etat === this._etats.mur ? 'mur'
      : (this._etat === this._etats.porte ? 'porte'
      : (this._etat === this._etats.topo ? 'topo' : 'repos'));
  }

  _definirEtat(nom) {
    this._etat.quitter();
    this._etat = this._etats[nom];
    this._etat.entrer();
    this.actif = nom !== 'repos';
    this._onEtat?.(nom);
  }

  /* ---- entrées d'interface ---- */
  tracerMurs() { this._definirEtat('mur'); }
  insererPorte() { this._typeOuverture = 'door'; this._definirEtat('porte'); }
  insererFenetre() { this._typeOuverture = 'window'; this._definirEtat('porte'); }
  /** Outil Scinder : couper un mur en deux au point cliqué. */
  scinderMur() { this._outilTopo = 'scinder'; this._definirEtat('topo'); }
  /** Outil Ajuster/Prolonger : raccorder un mur à la droite d'un mur de référence. */
  ajusterMurs() { this._outilTopo = 'ajuster'; this._definirEtat('topo'); }
  /** Outil Aligner : rendre un mur parallèle à un mur de référence (nu au choix). */
  alignerMurs() { this._outilTopo = 'aligner'; this._definirEtat('topo'); }
  /** Outil Décaler : copier un mur en parallèle, à distance choisie. */
  decalerMurs() { this._outilTopo = 'decaler'; this._definirEtat('topo'); }
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
    if (!on) { this.reperage.vider(); this._rafraichirReperes(); }
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
    // le point de depart d'un trait jamais confirme n'a plus de raison d'etre
    if (this._purgerNoeudsOrphelins()) this._rafraichirApercu();
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
  /** Les directions remarquables portees par un point d'accrochage ou un
   *  candidat de reperage — reutilise a la fois par le survol automatique
   *  et par l'acquisition manuelle (Ctrl+clic), pour que les deux posent
   *  exactement les memes rayons a partir du meme point. */
  _directionsPour(s) {
    if (!s) return [];
    if (['end', 'mid', 'intersection'].includes(s.type)) {
      if (s.type === 'mid' && s.wallId) {
        /* Le milieu tient sa direction de SON mur, pas du voisinage : ce
           n'est l'extremite d'aucun mur, la recherche ci-dessous ne le
           trouverait pas. */
        const w = this.graph.walls.get(s.wallId);
        return w ? [this.graph.wallFrame(w).d] : [];
      }
      const dirs = [];
      for (const w of this.graph.walls.values()) {
        const A = this.graph.node(w.a), B = this.graph.node(w.b);
        if (dist(s, A) < 1e-6 || dist(s, B) < 1e-6) dirs.push(this.graph.wallFrame(w).d);
      }
      return dirs;
    }
    // tangente / apparente / repere existant : la direction est deja portee
    // par le candidat lui-meme, pas besoin de la redeviner depuis le graphe
    if (s.lignes?.length) return s.lignes.map(l => l.d);
    return [];
  }

  /** Pose ou retire manuellement une reference de reperage au point vise.
   *
   *  L'acquisition automatique demande d'attendre sur un point d'accrochage
   *  reel — c'est volontaire, un survol n'est pas toujours une intention.
   *  Mais un point qui n'existe dans aucun mur (un croisement de guides, un
   *  point choisi a main levee) n'a pas d'accrochage a survoler, et attendre
   *  n'aiderait de toute facon pas : Ctrl+clic pose la reference tout de
   *  suite, sur EXACTEMENT le point vise par la cascade d'accrochage
   *  courante — et un second Ctrl+clic pres d'une reference existante la
   *  retire, pour que le controle reste dans les deux sens. */
  basculerRepere(ev) {
    const p = this._solSous(ev);
    if (!p || !this.guides) return;
    const tol = this._tolerancePixels(p, 15);
    if (this.reperage.points.some(q => Math.hypot(q.x - p.x, q.y - p.y) < tol * 1.5)) {
      this.reperage.oublier(p, tol * 1.5);
    } else {
      const s = this._snap(p, ev.shiftKey);
      this.reperage.acquerir({ x: s.x, y: s.y }, this._directionsPour(s));
    }
    this._rafraichirReperes();
    this.viewer.demanderImage(2);
  }

  /** Les marqueurs des references de reperage — verts, comme tout ce qui
   *  releve de l'assistance au dessin dans cette application. */
  _rafraichirReperes() {
    if (!this._groupeReperes) {
      this._groupeReperes = new THREE.Group();
      this._groupeReperes.renderOrder = 997;
      this._apercu.add(this._groupeReperes);
      this._geoRepere = new THREE.SphereGeometry(1, 10, 6);
      this._matRepere = new THREE.MeshBasicMaterial({ color: 0x3ecf8e, depthTest: false, transparent: true, opacity: 0.85 });
    }
    for (const m of [...this._groupeReperes.children]) this._groupeReperes.remove(m);
    const r = Math.max(this.viewer.gridStep * 0.32, 0.03);
    for (const q of this.reperage.points) {
      const m = new THREE.Mesh(this._geoRepere, this._matRepere);
      m.scale.setScalar(r);
      m.position.set(q.x, q.y, 0.025);
      this._groupeReperes.add(m);
    }
  }

  _snap(p, ortho = false) {
    const tol = this._tolerancePixels(p, 15);
    const os = snapOsnap(p, this.graph, tol);

    /* Acquisition des points de reference.

       Survoler un point d'accrochage sans cliquer, le temps d'un battement,
       le retient comme reference. C'est le geste de SmartTrack : on ne
       declare rien, on regarde, et le logiciel comprend a quoi on pense. */
    this.reperage.actif = !!this.guides;
    const avant = this.reperage.points.length;
    if (os && ['end', 'mid', 'intersection'].includes(os.type)) {
      this.reperage.survol(os, this._directionsPour(os));
    } else {
      this.reperage.survol(null);
    }
    // l'acquisition automatique change discretement l'ensemble des references :
    // ne repeindre les marqueurs que quand ca arrive vraiment, pas a chaque survol
    if (this.reperage.points.length !== avant) this._rafraichirReperes();

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

    /* La tangente passe AVANT les points reels, et c'est la seule exception
       a la regle « un point qui existe l'emporte sur un point deduit ».

       Un cercle est polygonise en vingt-quatre segments : ses sommets et ses
       milieux sont des points reels au sens du graphe, mais ce sont des
       artefacts de discretisation, pas des points voulus. Le milieu d'un
       segment tombe a quatre centimetres du vrai point de tangence — assez
       pour que le raccord se voie. On donne donc la priorite au cercle
       IDEAL, celui qui a ete dessine.

       La tolerance est resserree de moitie pour que l'exception ne deborde
       pas ailleurs, et la tangente n'a de sens qu'avec un point de depart. */
    if (this.guides && this.reperage.tangentes && this._ancre && this.cercles.length) {
      const depuis = this.graph.node(this._ancre);
      for (const cercle of this.cercles) {
        const t = tangentesVersCercle(depuis, cercle, p, tol * 0.5);
        if (t) return t;
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
    for (const m of [...this._groupeNoeuds.children]) this._groupeNoeuds.remove(m);
    if (!this._geoMarqueur) {
      this._geoMarqueur = new THREE.SphereGeometry(1, 12, 8);
      this._matMarqueur = new THREE.MeshBasicMaterial({ color: 0xffb020, depthTest: false });
      this._matMarqueurSel = new THREE.MeshBasicMaterial({ color: 0x3ecf8e, depthTest: false });
      this._geoAnneau = new THREE.TorusGeometry(1, 0.28, 10, 24);
      this._matAnneau = new THREE.MeshBasicMaterial({ color: 0x3ecf8e, depthTest: false });
    }
    const r = Math.max(this.viewer.gridStep * 0.5, 0.05);
    for (const n of this.graph.nodes.values()) {
      /* Un point d'edition n'a de sens qu'a l'extremite d'un mur.

         Un noeud sans mur n'est rien qu'on puisse saisir ou deplacer : le
         montrer promet une prise qui n'existe pas. Le cas se produit des
         qu'un trace est commence puis abandonne — le point de depart est
         pose avant le premier mur. On le garde dans le graphe, le temps du
         trace, mais on ne le dessine pas. */
      if (!n.wallIds.size) continue;
      const sel = this._estSelectionne('node', n.id);
      const m = new THREE.Mesh(this._geoMarqueur, sel ? this._matMarqueurSel : this._matMarqueur);
      m.scale.setScalar(sel ? r * 1.4 : r);
      m.position.set(n.x, n.y, 0.01);
      m.renderOrder = 999;
      this._groupeNoeuds.add(m);
      if (sel) {
        // anneau vert autour du point sélectionné, bien visible
        const anneau = new THREE.Mesh(this._geoAnneau, this._matAnneau);
        anneau.scale.setScalar(r * 2.2);
        anneau.position.set(n.x, n.y, 0.02);
        anneau.rotation.x = Math.PI / 2;
        anneau.renderOrder = 1000;
        this._groupeNoeuds.add(anneau);
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
    tracer('tangente', (ctx, m, s) => { ctx.beginPath(); ctx.arc(m, m + s * 0.4, s * 0.6, 0, 2 * Math.PI); ctx.stroke(); ctx.beginPath(); ctx.moveTo(m - s, m - s * 0.2); ctx.lineTo(m + s, m - s * 0.2); ctx.stroke(); });
    tracer('apparente', (ctx, m, s) => { ctx.beginPath(); ctx.moveTo(m - s, m - s); ctx.lineTo(m + s, m + s); ctx.moveTo(m + s, m - s); ctx.lineTo(m - s, m + s); ctx.stroke(); ctx.beginPath(); ctx.setLineDash([6, 5]); ctx.moveTo(m - s * 1.5, m); ctx.lineTo(m + s * 1.5, m); ctx.stroke(); ctx.setLineDash([]); });
    tracer('croisement', (ctx, m, s) => { ctx.beginPath(); ctx.moveTo(m - s, m); ctx.lineTo(m + s, m); ctx.moveTo(m, m - s); ctx.lineTo(m, m + s); ctx.moveTo(m - s * 0.7, m - s * 0.7); ctx.lineTo(m + s * 0.7, m + s * 0.7); ctx.moveTo(m + s * 0.7, m - s * 0.7); ctx.lineTo(m - s * 0.7, m + s * 0.7); ctx.stroke(); });
    // milieu de deux reperes : deux petits cercles relies, comme un « between » de CAO
    tracer('milieu', (ctx, m, s) => {
      ctx.beginPath(); ctx.moveTo(m - s, m); ctx.lineTo(m + s, m); ctx.stroke();
      ctx.beginPath(); ctx.arc(m - s * 0.8, m, s * 0.28, 0, 2 * Math.PI); ctx.stroke();
      ctx.beginPath(); ctx.arc(m + s * 0.8, m, s * 0.28, 0, 2 * Math.PI); ctx.stroke();
    });

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
    if (s.type === 'alignement' || s.type === 'croisement'
        || s.type === 'apparente' || s.type === 'tangente' || s.type === 'milieu') {
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
    const opts = { thickness: this.epaisseur, height: this.hauteur, elevation: this.elevation, justification: this.justification };
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
    this.cercles.push({ cx: c.x, cy: c.y, r });
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
  /** Retire du graphe les noeuds qui ne tiennent plus aucun mur.
   *
   *  `graph.supprimerMur` le fait pour les deux extremites du mur qu'il
   *  retire, mais `removeWall` non, et un trace abandonne laisse son point
   *  de depart derriere lui. On epargne l'ancre et le point de depart : le
   *  trace en cours a encore besoin d'eux. */
  _purgerNoeudsOrphelins() {
    const epargnes = new Set([this._ancre, this._pointDepart].filter(Boolean));
    let n = 0;
    for (const [id, noeud] of [...this.graph.nodes]) {
      if (!noeud.wallIds.size && !epargnes.has(id)) { this.graph.nodes.delete(id); n++; }
    }
    return n;
  }

  /** Scinde un mur au paramètre s (0..1). Refuse aux extrémités (no-op déguisé)
   *  et si le point de coupe traverse une ouverture existante. */
  _scinder(wallId, s) {
    const w = this.graph.walls.get(wallId);
    if (!w) return { ok: false, message: 'Aucun mur' };
    if (w.verrouille) return { ok: false, message: 'Mur verrouillé' };
    if (s <= 1e-6 || s >= 1 - 1e-6) return { ok: false, message: 'Coupe impossible à une extrémité' };
    for (const o of w.openings) {
      if (o.s0 < s && s < o.s1) return { ok: false, message: 'Coupe impossible : traverse une ouverture' };
    }
    const nid = this.graph.splitWall(wallId, s);
    if (!nid) return { ok: false, message: 'Coupe impossible' };
    this._rafraichirApercu();
    this._reconstruireProxy();
    this._onChange();
    return { ok: true };
  }

  /** Déplace une extrémité de mur vers un point (ajustement/prolongement).
   *
   *  Les ouvertures gardent leur position et leur largeur PHYSIQUES : leurs
   *  fractions s0/s1 sont renormalisées sur la nouvelle longueur, et le geste
   *  est refusé s'il raccourcirait le mur à travers une ouverture. */
  _deplacerExtremite(wallId, extremite, vers, refWallId = null) {
    const w = this.graph.walls.get(wallId);
    if (!w) return { ok: false, message: 'Aucun mur' };
    if (w.verrouille) return { ok: false, message: 'Mur verrouillé' };
    const f = this.graph.wallFrame(w);
    const nid = extremite === 'a' ? w.a : w.b;
    const F = extremite === 'a' ? f.B : f.A;       // extrémité FIXE
    const L = Math.hypot(vers.x - F.x, vers.y - F.y);
    if (L < 1e-6) return { ok: false, message: 'Longueur nulle' };

    for (const o of w.openings) {
      // portée physique de l'ouverture depuis l'extrémité fixe : [d0 près, d1 loin]
      let d0, d1;
      if (extremite === 'b') { d0 = o.s0 * f.len; d1 = o.s1 * f.len; }
      else { d0 = (1 - o.s1) * f.len; d1 = (1 - o.s0) * f.len; }
      if (L < d1 - 1e-6) return { ok: false, message: 'Ajustement impossible : coupe une ouverture' };
      // renormalisation (les fractions restent mesurées de a vers b)
      if (extremite === 'b') { o.s0 = d0 / L; o.s1 = d1 / L; }
      else { o.s0 = (L - d1) / L; o.s1 = (L - d0) / L; }
    }

    this.graph.setNodePos(nid, vers.x, vers.y);

    // RACCORDEMENT : si le point tombe sur le mur de référence, les deux murs
    // partagent un nœud — sans cela ils se touchent visuellement mais restent
    // indépendants (le déplacement d'un mur n'entraîne pas l'autre, les pièces
    // ne se ferment pas). Le nœud déplacé sert de point de coupe à la référence.
    if (refWallId && refWallId !== wallId) {
      const r = this.graph.walls.get(refWallId);
      if (r) {
        const fr = this.graph.wallFrame(r);
        const sX = dot(sub(vers, fr.A), fr.d) / fr.len;
        if (sX > 1e-6 && sX < 1 - 1e-6) {
          this.graph.splitWall(refWallId, sX, nid);
        } else if (sX <= 1e-6 || sX >= 1 - 1e-6) {
          // le point tombe sur une extrémité de la référence : on adopte son nœud
          const nidRef = sX <= 1e-6 ? r.a : r.b;
          if (nidRef !== nid) {
            if (extremite === 'a') w.a = nidRef; else w.b = nidRef;
            this.graph.nodes.get(nidRef).wallIds.add(wallId);
            const an = this.graph.nodes.get(nid);
            if (an) { an.wallIds.delete(wallId); if (!an.wallIds.size) this.graph.nodes.delete(nid); }
          }
        }
        // sinon : point sur le prolongement de la référence → nœud libre, rien à lier
      }
    }

    this._rafraichirApercu();
    this._reconstruireProxy();
    this._onChange();
    return { ok: true };
  }

  /** Aligne une LIGNE du mur cible (axe central / nu intérieur / nu extérieur)
   *  sur une LIGNE du mur de référence (idem). Le mur devient parallèle à la
   *  référence, puis est translaté pour que la ligne choisie coïncide — à
   *  longueur constante. C'est ce qui permet d'aligner un nu sur un nu, quel
   *  que soit le mode de création (axe) de chaque mur. */
  _aligner(wallId, refWallId, axeCible = 'centre', axeRef = 'centre') {
    const w = this.graph.walls.get(wallId);
    const r = this.graph.walls.get(refWallId);
    if (!w || !r) return { ok: false, message: 'Aucun mur' };
    if (wallId === refWallId) return { ok: false, message: 'Choisissez un AUTRE mur' };
    if (w.verrouille) return { ok: false, message: 'Mur verrouillé' };
    const fw = this.graph.wallFrame(w);
    const fr = this.graph.wallFrame(r);

    const offAxe = (m, axe) => {
      const f = facesMur(m);
      return axe === 'interieur' ? f.g : (axe === 'exterieur' ? f.r : 0);
    };
    const offT = offAxe(w, axeCible);      // décalage signé de la ligne du mur cible
    const offS = offAxe(r, axeRef);        // décalage signé de la ligne de référence

    // direction de la référence, orientée au plus proche de la direction actuelle
    let d = { x: fr.d.x, y: fr.d.y };
    if (dot(d, fw.d) < 0) d = { x: -d.x, y: -d.y };
    const n = { x: -d.y, y: d.x };         // nouvelle normale gauche du mur cible

    // lignes en jeu (point d'origine + direction d)
    const oS = add(fr.A, scale(fr.n, offS));
    const oT = add(fw.A, scale(fw.n, offT));
    // projection de la ligne cible sur la ligne de référence (composante // conservée)
    const t = dot(sub(oT, oS), d);
    const oT2 = add(oS, scale(d, t));
    // nouvel axe du mur cible : sa ligne choisie repose sur la ligne de référence
    const A2 = sub(oT2, scale(n, offT));
    const B2 = add(A2, scale(d, fw.len));

    this.graph.setNodePos(w.a, A2.x, A2.y);
    this.graph.setNodePos(w.b, B2.x, B2.y);
    this._rafraichirApercu();
    this._reconstruireProxy();
    this._onChange();
    return { ok: true };
  }

  /** Copie un mur en parallèle, à distance signée e (le long de sa normale). */
  _decaler(wallId, e) {
    const w = this.graph.walls.get(wallId);
    if (!w) return { ok: false, message: 'Aucun mur' };
    if (Math.abs(e) < 1e-6) return { ok: false, message: 'Décalage nul' };
    const f = this.graph.wallFrame(w);
    const A = add(f.A, scale(f.n, e));
    const B = add(f.B, scale(f.n, e));
    const a = this.graph.addNode(A.x, A.y);
    const b = this.graph.addNode(B.x, B.y);
    const nwid = this.graph.addWall(a, b, { thickness: w.thickness, height: w.height, elevation: w.elevation, justification: w.justification });
    // le mur décalé croise peut-être d'autres murs : on le raccorde comme au tracé
    if (nwid) this.graph.intersectAndSplit(nwid);
    this._rafraichirApercu();
    this._reconstruireProxy();
    this._onChange();
    return { ok: true };
  }

  /** Copie un mur existant transformé (translation + rotation + échelle
   *  autour d'un pivot, même convention que `transformerMur`) : nouveaux
   *  nœuds, nouveau mur, jamais de mutation du mur source. Ne régénère PAS
   *  le 3D — appelée pour chaque mur d'une copie multiple, la régénération
   *  est laissée à l'appelant, une seule fois pour tous. */
  copierMur(wallId, t) {
    const w = this.graph.walls.get(wallId);
    if (!w) return null;
    const { dPos = { x: 0, y: 0 }, dRot = 0, dSca = 1, pivot = [0, 0] } = t || {};
    const cos = Math.cos(dRot), sin = Math.sin(dRot);
    const transformer = (n) => {
      const relX = (n.x - pivot[0]) * dSca, relY = (n.y - pivot[1]) * dSca;
      return { x: pivot[0] + relX * cos - relY * sin + dPos.x, y: pivot[1] + relX * sin + relY * cos + dPos.y };
    };
    const A2 = transformer(this.graph.node(w.a)), B2 = transformer(this.graph.node(w.b));
    const a = this.graph.addNode(A2.x, A2.y);
    const b = this.graph.addNode(B2.x, B2.y);
    const nwid = this.graph.addWall(a, b, {
      thickness: w.thickness, height: w.height, elevation: w.elevation, justification: w.justification,
    });
    if (nwid) this.graph.intersectAndSplit(nwid);
    this._rafraichirApercu();
    this._reconstruireProxy();
    this._onChange();
    return nwid;
  }

  /** Angle d'un mur en radians (direction A→B), ou null si absent —
   *  utilisé par le gizmo pour orienter le pivot sur le mur sélectionné. */
  angleMur(wallId) {
    const w = this.graph.walls.get(wallId);
    if (!w) return null;
    const f = this.graph.wallFrame(w);
    return Math.atan2(f.d.y, f.d.x);
  }

  /** Bascule le verrou d'un mur : un drapeau, pas un geste géométrique.
   *  Le verrou protège la géométrie propre (position, forme), pas les
   *  opérations d'hébergement (portes/fenêtres restent permises). */
  basculerVerrouMur(wallId) {
    const w = this.graph.walls.get(wallId);
    if (!w) return false;
    w.verrouille = !w.verrouille;
    this._onChange();
    return w.verrouille;
  }

  /** Le nœud appartient-il à un mur verrouillé ? (déplacements refusés) */
  _noeudVerrouille(nid) {
    for (const wid of this.graph.incident(nid)) {
      if (this.graph.walls.get(wid)?.verrouille) return true;
    }
    return false;
  }

  /** Points d'aimantation pour le déplacement au gizmo : nœuds, milieux,
   *  intersections et repères intelligents — les mêmes candidats qu'au
   *  tracé de murs, généralisés au gizmo. */
  pointsSnap() {
    const pts = [];
    for (const n of this.graph.nodes.values()) {
      if (!n.wallIds.size) continue;
      pts.push({ x: n.x, y: n.y, type: n.wallIds.size >= 3 ? 'intersection' : 'end' });
    }
    for (const w of this.graph.walls.values()) {
      const f = this.graph.wallFrame(w);
      pts.push({ x: (f.A.x + f.B.x) / 2, y: (f.A.y + f.B.y) / 2, type: 'mid' });
    }
    for (const q of this.reperage.points) pts.push({ x: q.x, y: q.y, type: 'repere' });
    return pts;
  }

  /** Applique un geste de gizmo (translation + rotation + échelle autour du
   *  pivot) aux nœuds d'un mur, depuis leurs positions ORIGINALES mémorisées
   *  au premier appel du geste — idempotent, jamais cumulatif. */
  transformerMur(wallId, t) {
    const w = this.graph.walls.get(wallId);
    if (!w) return false;
    if (w.verrouille) return false;
    if (!this._gesteMur || this._gesteMur.wallId !== wallId) {
      this._gesteMur = {
        wallId,
        a: { x: this.graph.node(w.a).x, y: this.graph.node(w.a).y },
        b: { x: this.graph.node(w.b).x, y: this.graph.node(w.b).y },
      };
    }
    const { angle = 0, scale: ech = 1, dx = 0, dy = 0, pivot = [0, 0] } = t;
    const cos = Math.cos(angle), sin = Math.sin(angle);
    const deplacer = (nid, origine) => {
      const n = this.graph.nodes.get(nid);
      if (!n) return;
      let x = (origine.x - pivot[0]) * ech;
      let y = (origine.y - pivot[1]) * ech;
      n.x = x * cos - y * sin + pivot[0] + dx;
      n.y = x * sin + y * cos + pivot[1] + dy;
    };
    deplacer(w.a, this._gesteMur.a);
    deplacer(w.b, this._gesteMur.b);
    this._rafraichirApercu();
    this._reconstruireProxy();
    this._regenThrottle();   // le 3D suit le geste, régénéré par à-coups
    return true;
  }

  /** Fin du geste de gizmo sur un mur : purge la mémoire d'origine et
   *  régénère le 3D une seule fois. */
  finGesteMur(wallId) {
    if (this._gesteMur?.wallId === wallId) this._gesteMur = null;
    this._regenImmediate();
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
    /* Supprimer un mur laisse son autre extremite sans rien a tenir : sans
       cette purge, chaque effacement sème un point isole de plus. */
    this._purgerNoeudsOrphelins();
    this._selection = [];
    this._murSel3D = null;
    this._majPoignees();
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
    this._purgerNoeudsOrphelins();
    if (this._murSel3D === wallId) { this._murSel3D = null; this._majPoignees(); }
    this._rafraichirApercu();
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

  /* ---- gestion ---- */
  vider() {
    this._nettoyer();
    this.graph = new PlanGraph();
    this.reperage.vider();
    this._rafraichirReperes();
    this._ancre = null;
    this._dernierMur = null;
    this._selection = [];
    this._murSel3D = null;
    this._majPoignees();
    this._reconstruireProxy();
    for (const m of [...this._groupeNoeuds.children]) this._groupeNoeuds.remove(m);
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
        elevation: w.elevation, justification: w.justification, verrouille: w.verrouille,
        openings: w.openings.map(o => ({ ...o })),
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
        elevation: w.elevation || 0, justification: w.justification || 'centre',
        verrouille: !!w.verrouille, openings: (w.openings || []).map(o => ({ ...o })),
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
