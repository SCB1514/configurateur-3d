import * as THREE from '../vendor/three/three.module.js';

/* ============================================================
   Luminaires
   ------------------------------------------------------------
   Une machine de sport porte de la lumière : bandeau de LED sous
   un capot, écran rétroéclairé, anneau autour d'une poulie. Et la
   salle qui l'accueille en porte aussi : dalles lumineuses,
   downlights, projecteurs sur rail.

   Chaque luminaire est fait de deux choses, qu'il ne faut pas
   confondre :

     — une SURFACE ÉMISSIVE, qui se voit. Elle ne coûte rien, elle
       brille toujours, et le halo la ramasse ;
     — une SOURCE, qui éclaire les autres objets. Elle coûte cher :
       en rendu direct, chaque source se paie sur chaque pixel de
       chaque objet.

   D'où la règle de la maison : toutes les surfaces brillent, mais
   seules les sources les plus proches de la caméra éclairent
   réellement. Une salle de cent bandeaux reste fluide, et l'œil
   n'y voit rien — les bandeaux lointains brillent tout de même.
   ============================================================ */

const DEG = Math.PI / 180;

/** Émission vers le -Z local : un plafonnier non tourné éclaire le sol. */
const AXE = new THREE.Vector3(0, 0, -1);

/* ══════════════════ température de couleur ══════════════════ */

/**
 * Couleur d'un corps noir à une température donnée, en kelvins.
 *
 * Une lampe ne se décrit pas naturellement par un triplet rouge-vert-bleu :
 * un éclairagiste parle de 2700 K pour une ampoule chaude, de 4000 K pour un
 * néon de bureau, de 6500 K pour la lumière du jour. C'est la grandeur que
 * portent les fiches produit, et celle qu'on retrouve d'un logiciel à l'autre.
 *
 * L'approximation est celle de Tanner Helland : elle suit la courbe de Planck
 * de très près entre 1000 et 40000 K, pour trois logarithmes et rien d'autre.
 */
export function couleurDepuisKelvin(kelvin) {
  const t = Math.max(1000, Math.min(40000, kelvin)) / 100;
  let r, v, b;

  if (t <= 66) {
    r = 255;
    v = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    v = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }

  const borne = (x) => Math.max(0, Math.min(255, Math.round(x)));
  return new THREE.Color(borne(r) / 255, borne(v) / 255, borne(b) / 255);
}

/**
 * La couleur effective d'un luminaire.
 *
 * La teinte explicite l'emporte par defaut, et c'est voulu : une
 * bibliotheque decrit ses bandeaux par une couleur, pas par une temperature.
 * Basculer sur la temperature sans qu'on l'ait demande repeindrait en blanc
 * neutre tous les bandeaux colores deja publies.
 */
export function couleurLuminaire(spec) {
  if (spec.parTemperature === true) {
    return couleurDepuisKelvin(Number(spec.temperature) || 4000);
  }
  return new THREE.Color(spec.teinte || spec.couleur || '#ffffff');
}

/* ══════════════════ profils photométriques ══════════════════ */

/**
 * Convertit un profil IES en projecteur utilisable par le rendu WebGL.
 *
 * three sait lire un .ies, mais range le résultat dans `iesMap`, une
 * propriété que seul le moteur WebGPU exploite — le rendu WebGL l'ignore
 * purement et simplement. On refait donc le travail : la courbe
 * d'intensité par angle devient une texture carrée où la distance au
 * centre vaut l'angle, et cette texture sert de gobo au projecteur. Le
 * faisceau retrouve alors sa vraie signature : cœur chaud, coupure nette
 * ou dégradé selon l'optique décrite par le fichier.
 */
export async function cookieDepuisIES(texte, angleCone) {
  const { IESLoader } = await import('../vendor/three/addons/loaders/IESLoader.js');

  const lecteur = new IESLoader();
  // Par défaut le lecteur rend des demi-flottants, qu'un tableau JavaScript
  // ordinaire relit comme des entiers sans queue ni tête. On demande de vrais
  // flottants — la conversion est faite une fois, à l'import du luminaire.
  lecteur.type = THREE.FloatType;
  const courbe = lecteur.parse(texte);
  const valeurs = courbe.image.data;

  /* Ce que contient réellement ce tableau — les dimensions annoncées par le
     lecteur ne le disent pas : 360 × 180 valeurs déjà normalisées entre 0
     et 1, rangées à l'indice `phi + theta * 180`, où phi est l'angle
     vertical en degrés depuis l'axe du luminaire et theta l'azimut. Une
     optique de révolution — la quasi-totalité des projecteurs de salle —
     ne dépend pas de theta : on lit la coupe à theta = 0.  */
  const PHI = 180;
  const lire = (phiDeg) => valeurs[Math.max(0, Math.min(PHI - 1, Math.round(phiDeg)))] || 0;

  const cote = 256;
  const toile = document.createElement('canvas');
  toile.width = toile.height = cote;
  const ctx = toile.getContext('2d');
  const image = ctx.createImageData(cote, cote);

  const demi = cote / 2;
  const angleMax = Math.max(angleCone, 1 * DEG);

  for (let y = 0; y < cote; y++) {
    for (let x = 0; x < cote; x++) {
      const dx = (x - demi) / demi, dy = (y - demi) / demi;
      const r = Math.hypot(dx, dy);

      // hors du disque inscrit : le cône ne porte pas jusque-là
      let v = 0;
      if (r <= 1) {
        const phi = (r * angleMax) / DEG;               // degrés depuis l'axe
        const i = Math.floor(phi), f = phi - i;
        v = lire(i) * (1 - f) + lire(i + 1) * f;        // interpolation linéaire
      }

      const p = (y * cote + x) * 4;
      const o = Math.max(0, Math.min(255, Math.round(v * 255)));
      image.data[p] = image.data[p + 1] = image.data[p + 2] = o;
      image.data[p + 3] = 255;
    }
  }

  ctx.putImageData(image, 0, 0);
  courbe.dispose();

  const cookie = new THREE.CanvasTexture(toile);
  cookie.colorSpace = THREE.SRGBColorSpace;
  return cookie;
}

/* ══════════════════ construction ══════════════════ */

/**
 * Bâtit un luminaire et le renvoie sous forme de groupe, prêt à être posé
 * dans un bloc — il suivra la machine quand elle se déplacera.
 *
 * `echelle` convertit les unités de la bibliothèque en mètres.
 */
export function construireLuminaire(spec, echelle = 1) {
  const g = new THREE.Group();
  g.userData.luminaire = true;

  const couleur = couleurLuminaire(spec);
  const intensite = Number(spec.intensite) || 4;
  const eclat = Number(spec.eclat ?? Math.min(6, 1 + intensite * 0.4));

  const m = (v) => (Number(v) || 0) * echelle;
  g.position.set(m(spec.pos?.[0]), m(spec.pos?.[1]), m(spec.pos?.[2]));
  const r = spec.rot || [0, 0, 0];
  g.rotation.set(r[0] * DEG, r[1] * DEG, r[2] * DEG);

  /* -------- la surface qui se voit -------- */
  const matiere = new THREE.MeshStandardMaterial({
    color: 0x000000, emissive: couleur, emissiveIntensity: eclat,
    roughness: 0.4, metalness: 0, side: THREE.DoubleSide,
  });

  let geometrie, largeur = 0, hauteur = 0;
  switch (spec.type) {
    case 'bande': {
      // un bandeau : long, étroit, et rarement droit dans son axe
      largeur = m(spec.taille?.[0] ?? spec.longueur ?? 1000);
      hauteur = m(spec.taille?.[1] ?? spec.largeur ?? 12);
      geometrie = new THREE.PlaneGeometry(largeur, hauteur);
      break;
    }
    case 'disque': {
      const rayon = m(spec.rayon ?? 90);
      largeur = hauteur = rayon * 2;
      geometrie = new THREE.CircleGeometry(rayon, 48);
      break;
    }
    case 'spot': {
      const rayon = m(spec.rayon ?? 40);
      largeur = hauteur = rayon * 2;
      geometrie = new THREE.CircleGeometry(rayon, 32);
      break;
    }
    case 'point': {
      // Une source ponctuelle n'a pas de face : on la figure par une petite
      // sphere, qui rayonne dans toutes les directions comme elle.
      const rayon = m(spec.rayon ?? 45);
      largeur = hauteur = rayon * 2;
      geometrie = new THREE.SphereGeometry(rayon, 16, 12);
      break;
    }
    default: {                                    // rectangle
      largeur = m(spec.taille?.[0] ?? 600);
      hauteur = m(spec.taille?.[1] ?? 600);
      geometrie = new THREE.PlaneGeometry(largeur, hauteur);
    }
  }

  const surface = new THREE.Mesh(geometrie, matiere);
  surface.userData.surfaceLumineuse = true;
  g.add(surface);

  /* -------- la source qui éclaire -------- */
  const portee = m(spec.portee ?? 0);
  let source;

  if (spec.type === 'point') {
    source = new THREE.PointLight(couleur, intensite * 3, portee, 1.8);
  } else if (spec.type === 'bande' || spec.type === 'rectangle') {
    // Une source surfacique : c'est elle qui donne ces reflets allongés sur
    // le métal, qu'aucun point lumineux ne sait imiter.
    source = new THREE.RectAreaLight(couleur, intensite, largeur, hauteur);
    source.userData.surfacique = true;
  } else {
    const angle = (Number(spec.angle) || (spec.type === 'disque' ? 58 : 28)) * DEG;
    source = new THREE.SpotLight(couleur, intensite * 4, portee, angle,
                                 Number(spec.penombre ?? (spec.type === 'disque' ? 0.6 : 0.3)), 1.6);
    // la cible descend d'un mètre dans l'axe : elle suit le groupe
    source.target.position.copy(AXE);
    g.add(source.target);
    source.userData.ies = spec.ies || null;
    source.userData.angle = angle;
  }

  source.userData.luminaire = true;
  source.visible = false;                 // c'est le budget qui allume, pas nous
  g.add(source);

  g.userData.source = source;
  g.userData.surface = surface;
  /* Le panneau attend un jeu de reglages complet. Une bibliotheque n'en
     fournit qu'une partie : on comble le reste avec les valeurs par defaut du
     type, sans jamais ecraser ce qui a ete declare. */
  g.userData.spec = { ...Luminaires.defaut(spec.type || 'rectangle'), ...spec,
                      parTemperature: spec.parTemperature === true };
  return g;
}

/**
 * Applique un jeu de réglages à un luminaire déjà en place.
 *
 * Tout ne se transpose pas d'un logiciel de rendu hors ligne au rendu
 * temps réel, et il vaut mieux le dire que le maquiller :
 *
 *   — l'intensité en candelas n'a pas d'équivalent direct. On la ramène par
 *     une division constante à l'échelle de three, ce qui conserve les
 *     rapports entre appareils — le seul point qui compte à l'œil ;
 *   — le rayon de source ne pilote la douceur d'ombre que sur les
 *     projecteurs, seuls à porter une ombre ici ;
 *   — les volets coupe-flux n'existent pas dans le rendu temps réel. On les
 *     approche en rétrécissant la surface émettrice, ce qui resserre bien le
 *     faisceau et réduit la diffusion latérale, sans reproduire la coupure
 *     franche d'un vrai volet.
 */
export function appliquerReglages(g, patch, echelle = 1) {
  const spec = Object.assign(g.userData.spec ||= {}, patch);
  const source = g.userData.source;
  const surface = g.userData.surface;
  const m = (v) => (Number(v) || 0) * echelle;

  const couleur = couleurLuminaire(spec);
  const cd = Number(spec.intensite);
  // 1200 cd correspond a peu pres a une intensite de 1 dans three : une
  // ampoule domestique de 800 lumens tombe alors autour de l'unite.
  const force = Number.isFinite(cd) ? cd / 1200 : 4;

  if (surface) {
    surface.material.emissive.copy(couleur);
    surface.material.emissiveIntensity = Number(spec.eclat ?? Math.min(8, 1 + force * 0.5));
    surface.visible = spec.actif !== false && spec.refletsVisibles !== false;
    surface.material.needsUpdate = true;
  }

  if (source) {
    source.color.copy(couleur);
    if (source.isRectAreaLight) {
      const fermeture = Math.cos((Number(spec.volets) || 0) * DEG);
      const t = spec.taille || [];
      if (t[0]) source.width = m(t[0]) * fermeture;
      if (t[1]) source.height = m(t[1]) * fermeture;
      source.intensity = force * 1.5;
    } else {
      source.intensity = force * (source.isSpotLight ? 4 : 3);
      source.distance = m(spec.portee);
      if (source.isSpotLight) {
        if (Number.isFinite(spec.angleCone)) source.angle = spec.angleCone * DEG;
        if (Number.isFinite(spec.penombre)) source.penumbra = spec.penombre;
        source.castShadow = spec.ombres !== false;
        // le rayon de source elargit la penombre : c'est la taille apparente
        // de l'ampoule vue depuis le point eclaire
        source.shadow.radius = Math.max(1, m(spec.rayonSource) * 40);
      }
    }
  }
  return spec;
}

/* ══════════════════ budget d'éclairage ══════════════════ */

/**
 * Décide, à intervalles réguliers, quelles sources éclairent vraiment.
 *
 * Le rendu direct de WebGL recompile ses nuanciers quand le nombre de
 * sources change, et coûte sur chaque pixel pour chacune. On maintient donc
 * un nombre CONSTANT de sources allumées — on change lesquelles, jamais
 * combien — et le nuancier reste stable.
 */
export class Luminaires {
  static _compteur = 0;

  constructor(viewer) {
    this.viewer = viewer;
    this.groupes = new Set();
    this.budget = 8;
    this._surfaciquePrete = false;
    this._t = 0;
  }

  /** Recense les luminaires d'un objet fraîchement posé. */
  recenser(objet) {
    objet.traverse(o => {
      if (o.userData.luminaire && o.isGroup) this.groupes.add(o);
    });
    this._preparerSurfaciques();
    this._appliquerIES();
  }

  oublier(objet) {
    objet.traverse(o => { if (o.userData.luminaire && o.isGroup) this.groupes.delete(o); });
  }

  /**
   * Les sources surfaciques exigent des tables de coefficients que three ne
   * charge pas d'office — trois cents kilo-octets qu'on ne télécharge que
   * si une bibliothèque en contient réellement.
   */
  async _preparerSurfaciques() {
    if (this._surfaciquePrete) return;
    const besoin = [...this.groupes].some(g => g.userData.source?.userData.surfacique);
    if (!besoin) return;
    this._surfaciquePrete = true;
    try {
      const { RectAreaLightUniformsLib } =
        await import('../vendor/three/addons/lights/RectAreaLightUniformsLib.js');
      RectAreaLightUniformsLib.init();
    } catch (e) {
      console.warn('Sources surfaciques indisponibles :', e);
    }
  }

  /** Applique les profils photométriques, une seule fois par luminaire. */
  async _appliquerIES() {
    for (const g of this.groupes) {
      const s = g.userData.source;
      if (!s?.userData.ies || s.userData.iesFait) continue;
      s.userData.iesFait = true;
      try {
        s.map = await cookieDepuisIES(s.userData.ies, s.userData.angle);
        s.castShadow = true;        // three n'installe la matrice de projection qu'ainsi
        s.shadow.mapSize.set(512, 512);
        // Le profil arrive après coup, une fois le fichier lu : sans cette
        // demande, le faisceau n'apparaîtrait qu'au battement suivant.
        this.viewer.marquerOmbres();
      } catch (e) {
        console.warn('Profil IES illisible :', e);
      }
    }
  }

  /**
   * Allume les sources les plus proches, éteint les autres.
   * Appelé depuis la boucle, mais ne travaille que trois fois par seconde :
   * le classement ne change qu'en se déplaçant, et jamais brutalement.
   */
  arbitrer() {
    const t = performance.now();
    if (t - this._t < 330) return;
    this._t = t;
    if (!this.groupes.size) return;

    const oeil = this.viewer.camera.position;
    const p = new THREE.Vector3();
    const classees = [...this.groupes].map(g => {
      g.getWorldPosition(p);
      return { g, d: p.distanceToSquared(oeil) };
    }).sort((a, b) => a.d - b.d);

    /* Deux précautions, apprises à l'écran.

       L'hystérésis d'abord : une source qui éclaire déjà garde sa place tant
       qu'elle reste dans le budget élargi d'un cran. Sans cela, deux
       luminaires presque à égale distance se disputent la dernière place et
       s'allument tour à tour à chaque arbitrage — trois fois par seconde.

       Le signalement ensuite : allumer ou éteindre une source change à la
       fois l'image ET le nombre de sources actives, ce qui oblige WebGL à
       recompiler ses nuanciers. Il faut donc réclamer une image, sans quoi
       le changement n'apparaîtrait qu'au battement de sécurité suivant. */
    let allumees = 0, change = false;
    for (const { g } of classees) {
      const s = g.userData.source;
      if (!s) continue;

      const eteint = g.userData.spec?.actif === false;
      const marge = s.visible ? 1 : 0;                  // le sortant est favorisé
      const veut = !eteint && allumees < this.budget + marge && allumees < this.budget;

      if (s.visible !== veut) { s.visible = veut; change = true; }
      if (veut) allumees++;

      // la surface, elle, brille toujours — sauf si l'appareil est éteint
      const surface = g.userData.surface;
      if (surface && surface.visible === eteint) { surface.visible = !eteint; change = true; }
    }

    if (change) this.viewer.marquerOmbres();
  }

  /* ══════════ l'API du panneau de gestion ══════════
     Le panneau ne connait ni three ni la scene : il manipule des uid et des
     objets de reglages. Tout ce qui suit est cette frontiere. */

  /** Valeurs de depart d'un appareil qu'on vient de poser. */
  static defaut(type) {
    const commun = { type, actif: true, intensite: 6000, temperature: 4000,
                     teinte: '#ffffff', parTemperature: true, rayonSource: 60,
                     portee: 0, refletsVisibles: true, ombres: true,
                     eclat: 3.4, pos: [0, 0, 2800], rot: [0, 0, 0] };
    if (type === 'spot') return { ...commun, nom: 'Projecteur', rayon: 55, angleCone: 28, penombre: 0.3, portee: 12000 };
    if (type === 'point') return { ...commun, nom: 'Ponctuelle', rayon: 45, portee: 8000 };
    if (type === 'disque') return { ...commun, nom: 'Disque', rayon: 200, angleCone: 60, penombre: 0.6, portee: 10000 };
    if (type === 'bande') return { ...commun, nom: 'Bandeau', taille: [1960, 22], volets: 0, voletsLongueur: 0 };
    return { ...commun, nom: 'Panneau', type: 'rectangle', taille: [600, 600], volets: 0, voletsLongueur: 0 };
  }

  /** Pose un appareil libre, devant la camera, a hauteur de plafond. */
  ajouter(type) {
    const v = this.viewer;
    const spec = Luminaires.defaut(type);
    const echelle = v.lib?.scale ?? 1;

    // devant le regard plutot qu'a l'origine : on pose ce que l'on vise
    const cible = v.controls.target;
    spec.pos = [cible.x / echelle, cible.y / echelle, 2800];

    const g = construireLuminaire(spec, echelle);
    g.userData.uid = 'lum-' + (++Luminaires._compteur);
    g.userData.libre = true;
    v.scene.add(g);
    this.groupes.add(g);
    this._preparerSurfaciques();
    appliquerReglages(g, {}, echelle);
    this.reglerBudget(this.budget);
    v.marquerOmbres();
    return g.userData.uid;
  }

  _trouver(uid) {
    for (const g of this.groupes) if (g.userData.uid === uid) return g;
    return null;
  }

  lister() {
    const noms = { point: 'Ponctuelle', spot: 'Projecteur', bande: 'Bandeau',
                   rectangle: 'Panneau', disque: 'Disque' };
    return [...this.groupes].map(g => {
      const s = g.userData.spec || {};
      return { uid: g.userData.uid ||= 'lum-' + (++Luminaires._compteur),
               nom: s.nom || noms[s.type] || 'Luminaire',
               type: s.type || 'rectangle', actif: s.actif !== false,
               libre: !!g.userData.libre };
    });
  }

  lire(uid) {
    const g = this._trouver(uid);
    return g ? { ...(g.userData.spec || {}) } : null;
  }

  modifier(uid, patch) {
    const g = this._trouver(uid);
    if (!g) return;
    const echelle = this.viewer.lib?.scale ?? 1;
    appliquerReglages(g, patch, echelle);

    // La position et l'orientation ne passent pas par appliquerReglages :
    // elles portent sur le groupe, pas sur la source.
    const s = g.userData.spec;
    if (patch.pos) g.position.set(s.pos[0] * echelle, s.pos[1] * echelle, s.pos[2] * echelle);
    if (patch.rot) g.rotation.set(s.rot[0] * DEG, s.rot[1] * DEG, s.rot[2] * DEG);
    if (patch.actif !== undefined) { this._t = 0; this.arbitrer(); }

    this.viewer.marquerOmbres();
  }

  supprimer(uid) {
    const g = this._trouver(uid);
    if (!g || !g.userData.libre) return false;    // un appareil d'un bloc se supprime avec lui
    this.groupes.delete(g);
    g.parent?.remove(g);
    g.traverse(o => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    this.viewer.marquerOmbres();
    return true;
  }

  /** Centre la vue sur un appareil, sans le perdre de vue. */
  cadrer(uid) {
    const g = this._trouver(uid);
    if (!g) return;
    const p = g.getWorldPosition(new THREE.Vector3());
    const v = this.viewer;
    const dir = v.camera.position.clone().sub(v.controls.target).normalize();
    v._cadrer(p, p.clone().addScaledVector(dir, 4), true);
  }

  /** Le budget suit la qualité demandée. */
  reglerBudget(n) {
    this.budget = Math.max(0, n | 0);
    this._t = 0;
    this.arbitrer();
  }

  get compte() { return this.groupes.size; }
}
