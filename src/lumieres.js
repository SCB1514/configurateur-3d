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

  // L'apercu filaire du faisceau (cone, sphere ou nappe), masque par defaut.
  // Il suit le groupe : deplacement, rotation et echelle s'appliquent a lui.
  const apercu = construireApercu(source, 0, { ...spec, __echelle: echelle });
  g.add(apercu);

  g.userData.source = source;
  g.userData.surface = surface;
  g.userData.apercu = apercu;
  /* Le panneau attend un jeu de reglages complet. Une bibliotheque n'en
     fournit qu'une partie : on comble le reste avec les valeurs par defaut du
     type, sans jamais ecraser ce qui a ete declare. */
  g.userData.spec = { ...Luminaires.defaut(spec.type || 'rectangle'), ...spec,
                      parTemperature: spec.parTemperature === true };
  return g;
}

/**
 * Aperçu filaire de l'étendue d'un luminaire : le cône d'un projecteur, la
 * sphère d'une source ponctuelle, ou la nappe d'une source surfacique.
 *
 * C'est une aide à la pose, pas une simulation photométrique : on dessine la
 * portée nominale (ou un repli raisonnable quand elle est illimitée), telle
 * que la source la déclare. Les dimensions vivent dans l'espace local du
 * groupe — le même que celui de la source — pour que l'aperçu suive la
 * transformation de l'appareil sans recalcul.
 */
/**
 * L'apercu filaire du faisceau.
 *
 * Trois principes, tires de l'usage :
 *
 *   — TOUTE source a un faisceau. Une nappe lumineuse en est privee dans la
 *     plupart des logiciels, ce qui oblige a deviner ou elle porte. On lui
 *     donne le meme cone qu'a un projecteur : elle eclaire vers le bas, on
 *     doit le voir.
 *   — le cone descend JUSQU'AU SOL par defaut. Une portee arbitraire de cinq
 *     metres flotte au milieu de rien ; une portee qui s'arrete au plancher
 *     montre exactement la tache de lumiere qu'on aura.
 *   — la base est la poignee. C'est elle qu'on tire pour regler d'un meme
 *     geste la portee et l'ouverture.
 */
/**
 * L'apercu d'une source, a la maniere de Rhino et de D5.
 *
 * Le cone est reserve au PROJECTEUR, et c'est une convention, pas un detail
 * graphique : un cone dit « la lumiere ne sort que dans cet angle ». C'est
 * vrai d'un projecteur, faux de tout le reste. Une dalle de plafond emet sur
 * tout l'hemisphere devant elle ; lui dessiner un cone laisserait croire
 * qu'elle n'eclaire pas ce qui est sur le cote, ce qui est faux et se voit
 * au rendu.
 *
 * Les deux autres familles se representent donc comme dans les logiciels de
 * metier :
 *
 *   — la SURFACE emettrice, a sa taille reelle : disque, rectangle ou
 *     bandeau. C'est elle qu'on saisit pour la redimensionner ;
 *   — une NORMALE, fleche qui dit dans quel sens la lumiere part. Sans
 *     elle, une nappe retournee ne se distingue pas d'une nappe correcte ;
 *   — un rayon d'ATTENUATION, cercle au sol pour les emetteurs orientes,
 *     sphere pour la ponctuelle qui rayonne partout. C'est la poignee de
 *     portee.
 */
function construireApercu(source, hauteurSol = 0, spec = {}) {
  const holder = new THREE.Group();
  holder.userData.apercu = true;
  holder.userData.poignees = [];

  const trait = new THREE.LineBasicMaterial({
    color: 0xffc53d, transparent: true, opacity: 0.5,
    depthTest: false, depthWrite: false,
  });
  const traitVif = new THREE.LineBasicMaterial({
    color: 0xffd98a, transparent: true, opacity: 0.95,
    depthTest: false, depthWrite: false,
  });
  const voile = (opacite = 0.13) => new THREE.MeshBasicMaterial({
    color: 0xffc53d, transparent: true, opacity: opacite,
    side: THREE.DoubleSide, depthTest: false, depthWrite: false,
  });

  const marquer = (o, type) => {
    o.userData.apType = type;
    holder.userData.poignees.push(o);
    holder.add(o);
    return o;
  };

  /** La portee effective : celle qui est fixee, sinon la hauteur au sol. */
  const portee = source.distance || hauteurSol || 4;

  /** Un cercle horizontal, a une altitude locale donnee. */
  const cercle = (rayon, z, segments = 48) => {
    const pts = [];
    for (let i = 0; i <= segments; i++) {
      const a = (i / segments) * Math.PI * 2;
      pts.push(new THREE.Vector3(Math.cos(a) * rayon, Math.sin(a) * rayon, z));
    }
    return new THREE.BufferGeometry().setFromPoints(pts);
  };

  /**
   * La fleche de direction, avec sa pointe saisissable.
   *
   * Sa longueur EST la portee : on la tire pour l'allonger. C'est le geste
   * de D5, et il a l'avantage de rendre la portee visible en permanence au
   * lieu de la cacher dans un champ.
   */
  const normale = (longueur) => {
    const tige = new THREE.BufferGeometry().setFromPoints(
      [new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -longueur)]);
    holder.add(new THREE.Line(tige, traitVif));

    const pointe = new THREE.Mesh(
      new THREE.ConeGeometry(Math.max(0.04, longueur * 0.05), Math.max(0.1, longueur * 0.14), 16),
      voile(0.75));
    pointe.rotation.x = Math.PI / 2;          // la pointe regarde vers -Z
    pointe.position.z = -longueur * 0.93;
    marquer(pointe, 'portee');
  };

  /** Les volets coupe-flux, quatre lames inclinees autour d'une nappe. */
  const volets = (demiL, demiH, angleDeg) => {
    if (!(angleDeg > 0.5)) return;
    const a = angleDeg * DEG;
    const profondeur = Math.max(demiL, demiH) * 0.9;
    for (const [nx, ny, l, h] of [[1, 0, demiH, 0], [-1, 0, demiH, 0],
                                  [0, 1, demiL, 0], [0, -1, demiL, 0]]) {
      const lame = new THREE.Mesh(new THREE.PlaneGeometry(
        nx ? profondeur : demiL * 2, nx ? demiH * 2 : profondeur), voile(0.10));
      const bord = nx ? demiL * nx : demiH * ny;
      if (nx) {
        lame.position.set(bord + Math.sin(a) * profondeur / 2, 0, -Math.cos(a) * profondeur / 2);
        lame.rotation.y = Math.PI / 2 - a * nx;
      } else {
        lame.position.set(0, bord + Math.sin(a) * profondeur / 2 * ny, -Math.cos(a) * profondeur / 2);
        lame.rotation.x = Math.PI / 2 - a * ny;
      }
      holder.add(lame);
    }
  };

  const type = spec.type || (source.isPointLight ? 'point'
                          : source.isRectAreaLight ? 'rectangle' : 'spot');

  if (type === 'point') {
    /* Ponctuelle : deux spheres, comme Rhino et D5.
       La petite est la source physique — c'est elle qui adoucit les ombres.
       La grande est la portee, et c'est la poignee. */
    const rSource = Math.max(0.02, (Number(spec.rayonSource) || 60) *
                             (spec.__echelle || 0.001));
    const noyau = new THREE.Mesh(new THREE.SphereGeometry(rSource, 16, 12), voile(0.55));
    holder.add(noyau);

    marquer(new THREE.Mesh(
      new THREE.SphereGeometry(portee, 24, 16),
      new THREE.MeshBasicMaterial({
        color: 0xffc53d, wireframe: true, transparent: true,
        opacity: 0.22, depthTest: false, depthWrite: false,
      })), 'sphere');

  } else if (type === 'spot') {
    /* Projecteur : le cone, seul cas ou il dit la verite. */
    const rayon = Math.tan((source.angle || 0.5) / 2) * portee;
    holder.add(new THREE.LineLoop(cercle(rayon, -portee), traitVif));

    const disque = new THREE.Mesh(new THREE.CircleGeometry(rayon, 48), voile());
    disque.rotation.x = Math.PI;
    disque.position.z = -portee;
    marquer(disque, 'cone');

    const rayons = [];
    for (let i = 0; i < 48; i += 6) {
      const a = (i / 48) * Math.PI * 2;
      rayons.push(new THREE.Vector3(0, 0, 0),
                  new THREE.Vector3(Math.cos(a) * rayon, Math.sin(a) * rayon, -portee));
    }
    holder.add(new THREE.LineSegments(
      new THREE.BufferGeometry().setFromPoints(rayons), trait));

  } else if (type === 'disque') {
    /* Disque : sa face emettrice a sa taille reelle, une normale, et le
       cercle d'attenuation au sol. Pas de cone — un disque encastre eclaire
       tout ce qui est devant lui, pas seulement un cone. */
    const r = source.__rayonDisque || Math.max(0.05, (Number(spec.rayon) || 200) *
                                               (spec.__echelle || 0.001));
    holder.add(new THREE.LineLoop(cercle(r, 0), traitVif));
    marquer(new THREE.Mesh(new THREE.CircleGeometry(r, 48), voile(0.18)), 'disque');

    normale(portee);
    holder.add(new THREE.LineLoop(cercle(r + portee * 0.55, -portee), trait));

  } else {
    /* Rectangle et bandeau : le contour de la nappe, sa normale, ses volets,
       et l'empreinte au sol. Le bandeau n'est qu'un rectangle tres allonge —
       le distinguer ne servirait a rien. */
    const w = source.width / 2, h = source.height / 2;
    const coins = [
      new THREE.Vector3(-w, -h, 0), new THREE.Vector3(w, -h, 0),
      new THREE.Vector3(w, h, 0), new THREE.Vector3(-w, h, 0),
    ];
    holder.add(new THREE.LineLoop(
      new THREE.BufferGeometry().setFromPoints(coins), traitVif));
    marquer(new THREE.Mesh(
      new THREE.PlaneGeometry(source.width, source.height), voile(0.18)), 'rect');

    volets(w, h, Number(spec.volets) || 0);
    normale(portee);

    const eL = w + portee * 0.5, eH = h + portee * 0.5;
    const sol = [
      new THREE.Vector3(-eL, -eH, -portee), new THREE.Vector3(eL, -eH, -portee),
      new THREE.Vector3(eL, eH, -portee), new THREE.Vector3(-eL, eH, -portee),
    ];
    holder.add(new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(sol), trait));
  }

  // L'apercu ne capte jamais un clic normal ; la poignee ne redevient
  // saisissable que pendant l'apercu (voir setApercu).
  holder.traverse(o => { o.userData._raycast = o.raycast; o.raycast = () => {}; });
  holder.visible = false;
  return holder;
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

  if (surface && Number.isFinite(spec.rayon) && surface.geometry?.parameters?.radius) {
    /* Redimensionner un disque sans reconstruire sa geometrie.

       Reconstruire couterait une allocation a chaque image pendant qu'on
       tire la poignee, et ferait perdre l'identite du maillage — donc la
       selection en cours. Une mise a l'echelle du seul maillage suffit :
       elle ne touche ni au groupe, ni a la source, ni au faisceau. */
    surface.userData.rayonBase ??= surface.geometry.parameters.radius;
    const voulu = spec.rayon * echelle;
    const k = Math.max(0.01, voulu / surface.userData.rayonBase);
    surface.scale.set(k, k, 1);
  }

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
  static _compteurCalque = 0;

  constructor(viewer) {
    this.viewer = viewer;
    this.groupes = new Set();
    /* Les calques sont une commodite d'organisation, pas une propriete de la
       scene : ils regroupent des appareils pour les eteindre ensemble.
       Une lumiere sans calque reste parfaitement valable. */
    this.calques = new Map();
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

      // un calque masque coupe aussi la source : sinon on continuerait de
      // payer le prix d'un appareil qu'on ne voit pas
      const eteint = g.userData.spec?.actif === false || s?.userData?.interdit;
      const marge = s.visible ? 1 : 0;                  // le sortant est favorisé
      const veut = !eteint && allumees < this.budget + marge && allumees < this.budget;

      if (s.visible !== veut) { s.visible = veut; change = true; }
      if (veut) allumees++;

      /* La visibilite de la surface ne se decide PAS ici.

         L'arbitrage passe trois fois par seconde et ne connait que le budget
         d'eclairage. En reglant lui-meme la surface, il rallumait tout ce que
         l'utilisateur venait de masquer, avec un tiers de seconde de retard —
         un masquage qui ne tient pas ressemble a une panne. */
      const surface = g.userData.surface;
      const avant = surface?.visible;
      this._appliquerVisibilite(g);
      if (surface && surface.visible !== avant) change = true;
    }

    if (change) this.viewer.marquerOmbres();
  }

  /* ══════════ l'API du panneau de gestion ══════════
     Le panneau ne connait ni three ni la scene : il manipule des uid et des
     objets de reglages. Tout ce qui suit est cette frontiere. */

  /** Valeurs de depart d'un appareil qu'on vient de poser.
      Ce sont des ordres de grandeur credibles, pas des valeurs de catalogue :
      un projecteur de salle fait quelques milliers de candelas et ouvre ~30°,
      une ampoule ponctuelle quelques centaines, une dalle ou un downlight
      quelques milliers. La portee par defaut amene le cone jusqu'au sol (la
      pose se fait a 2,80 m), pour que l'apercu pointe bien « jusqu'au plan 0 ». */
  static defaut(type) {
    const commun = { type, actif: true, intensite: 2500, temperature: 4000,
                     teinte: '#ffffff', parTemperature: true, rayonSource: 60,
                     portee: 0, refletsVisibles: true, ombres: true,
                     eclat: 3.2, pos: [0, 0, 2800], rot: [0, 0, 0] };
    /* Portee nulle : le faisceau descend jusqu'au sol.

       C'est le reglage utile par defaut. Une portee chiffree — 2,80 m pour
       un projecteur — suppose que l'appareil est au plafond ; deplace plus
       haut ou plus bas, son cone traverse le plancher ou s'arrete en l'air.
       Zero veut dire « jusqu'au sol », et la longueur suit l'appareil. */
    if (type === 'spot') return { ...commun, nom: 'Projecteur', intensite: 4200, rayon: 55, angleCone: 30, penombre: 0.35 };
    if (type === 'point') return { ...commun, nom: 'Ponctuelle', intensite: 900, rayon: 45 };
    if (type === 'disque') return { ...commun, nom: 'Disque', intensite: 2600, rayon: 200, angleCone: 60, penombre: 0.6 };
    if (type === 'bande') return { ...commun, nom: 'Bandeau', intensite: 1600, taille: [1200, 24], angleCone: 60, volets: 0, voletsLongueur: 0 };
    return { ...commun, nom: 'Panneau', type: 'rectangle', intensite: 2800, taille: [600, 600], angleCone: 60, volets: 0, voletsLongueur: 0 };
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

  /** Les groupes poses librement : ceux que l'on peut selectionner et bouger. */
  objetsLibres() {
    const l = [];
    for (const g of this.groupes) if (g.userData.libre) l.push(g);
    return l;
  }

  /** Le groupe portant cet identifiant, quel qu'il soit. */
  objet(uid) { return this._trouver(uid); }

  /**
   * Reporte dans les reglages ce que le gizmo vient de faire.
   *
   * Sans cela le panneau afficherait encore l'ancienne position, et la
   * prochaine saisie au clavier ferait bondir l'appareil en arriere.
   */
  noterTransformation(g) {
    const spec = g.userData.spec;
    if (!spec) return;
    // le cone s'arrete au sol : monter ou descendre l'appareil le rallonge
    if (this._apercu) queueMicrotask(() => this.rafraichirApercu(g));
    const e = this.viewer.lib?.scale ?? 1;
    spec.pos = [g.position.x / e, g.position.y / e, g.position.z / e];
    spec.rot = [g.rotation.x / DEG, g.rotation.y / DEG, g.rotation.z / DEG];
    spec.echelle = [g.scale.x, g.scale.y, g.scale.z];
  }

  /* ══════════ calques ══════════ */

  calquesListe() {
    return [...this.calques.values()].map(c => ({ ...c }));
  }

  creerCalque(nom) {
    const id = 'cal-' + (++Luminaires._compteurCalque);
    this.calques.set(id, { id, nom: nom || 'Calque ' + Luminaires._compteurCalque, visible: true });
    return id;
  }

  renommerCalque(id, nom) {
    const c = this.calques.get(id);
    if (c && nom) c.nom = String(nom).slice(0, 60);
  }

  supprimerCalque(id) {
    if (!this.calques.delete(id)) return;
    // les appareils survivent a leur calque : on les remet simplement a nu
    for (const g of this.groupes) {
      if (g.userData.spec?.calque === id) { g.userData.spec.calque = null; this._appliquerVisibilite(g); }
    }
    this.viewer.marquerOmbres();
  }

  basculerCalque(id) {
    const c = this.calques.get(id);
    if (!c) return;
    c.visible = !c.visible;
    for (const g of this.groupes) if (g.userData.spec?.calque === id) this._appliquerVisibilite(g);
    this._t = 0; this.arbitrer();
    this.viewer.marquerOmbres();
  }

  deplacerVers(uid, idCalque) {
    const g = this._trouver(uid);
    if (!g?.userData.spec) return;
    g.userData.spec.calque = idCalque && this.calques.has(idCalque) ? idCalque : null;
    this._appliquerVisibilite(g);
    this.viewer.marquerOmbres();
  }

  /**
   * Masquer n'est pas eteindre.
   *
   * Un appareil masque disparait de la vue mais continue d'eclairer — c'est
   * ainsi qu'on cache un plafonnier qui gene le cadrage sans changer
   * l'eclairage de la scene. Eteindre, a l'inverse, le laisse visible et lui
   * retire sa lumiere. D5 distingue les deux, et il a raison : ce sont deux
   * intentions differentes.
   */
  _appliquerVisibilite(g) {
    const spec = g.userData.spec || {};
    const calque = spec.calque ? this.calques.get(spec.calque) : null;
    const calqueVisible = !calque || calque.visible;

    if (g.userData.surface) g.userData.surface.visible = calqueVisible && !spec.masquee
                                                      && spec.refletsVisibles !== false;
    if (g.userData.source) g.userData.source.userData.interdit = !calqueVisible;
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
               masquee: !!s.masquee, calque: s.calque || null,
               libre: !!g.userData.libre };
    });
  }

  lire(uid) {
    const g = this._trouver(uid);
    if (!g) return null;
    /* Arrondi a la lecture, pas au stockage.

       Une position calculee par le gizmo vaut -1049,9999999999998 : juste,
       mais illisible dans un champ de saisie, et la moindre reprise au
       clavier propagerait le bruit. On arrondit ce qu'on montre. */
    const net = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
    const spec = g.userData.spec || {};
    return { ...spec,
             pos: (spec.pos || [0, 0, 0]).map(v => net(v, 1)),
             rot: (spec.rot || [0, 0, 0]).map(v => net(v, 1)),
             echelle: [g.scale.x, g.scale.y, g.scale.z].map(v => net(v, 3)),
             cotes: this.cotes(uid) };
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
    if (patch.echelle) g.scale.set(Math.max(0.01, s.echelle[0]),
                                   Math.max(0.01, s.echelle[1]),
                                   Math.max(0.01, s.echelle[2]));
    if (patch.cotes) this.reglerCotes(uid, patch.cotes);
    if (patch.masquee !== undefined || patch.calque !== undefined
        || patch.refletsVisibles !== undefined) this._appliquerVisibilite(g);
    if (patch.actif !== undefined) { this._t = 0; this.arbitrer(); }

    // angle, portee ou taille ont pu changer : l'aperçu doit suivre
    if (this._apercu) this.rafraichirApercu(g);

    this.viewer.marquerOmbres();
  }

  /**
   * Redimensionne un appareil en saisissant ses cotes.
   *
   * On tape la dimension voulue plutot que de tirer une poignee : c'est plus
   * juste et plus rapide sur un plan d'implantation, ou les dimensions sont
   * connues. Le calcul passe par la boite englobante reelle, ce qui rend la
   * methode independante du type d'appareil — un disque, un bandeau et un
   * projecteur s'y plient de la meme facon.
   */
  reglerCotes(uid, cotes) {
    const g = this._trouver(uid);
    if (!g) return null;
    const e = this.viewer.lib?.scale ?? 1;

    // on mesure a l'echelle 1 : sinon chaque reglage se composerait au
    // precedent et la valeur saisie ne serait jamais celle obtenue
    const memoire = g.scale.clone();
    g.scale.set(1, 1, 1);
    g.updateMatrixWorld(true);
    const boite = new THREE.Box3().setFromObject(g);
    const brut = boite.getSize(new THREE.Vector3());

    const facteur = [0, 1, 2].map(i => {
      const voulu = Number(cotes?.[i]);
      const nature = [brut.x, brut.y, brut.z][i];
      if (!(voulu > 0) || !(nature > 1e-6)) return memoire.getComponent(i);
      return (voulu * e) / nature;
    });

    g.scale.set(facteur[0], facteur[1], facteur[2]);
    g.updateMatrixWorld(true);
    this.noterTransformation(g);
    this.viewer.marquerOmbres();
    return this.cotes(uid);
  }

  /** Les dimensions actuelles, en unites de bibliotheque. */
  cotes(uid) {
    const g = this._trouver(uid);
    if (!g) return null;
    const e = this.viewer.lib?.scale ?? 1;
    g.updateMatrixWorld(true);
    const t = new THREE.Box3().setFromObject(g).getSize(new THREE.Vector3());
    return [t.x / e, t.y / e, t.z / e].map(v => Math.round(v * 10) / 10);
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

  /**
   * Affiche ou masque l'aperçu filaire de tous les faisceaux.
   *
   * L'aperçu est reconstruit à l'ouverture : angle, portée et taille ont pu
   * changer depuis la dernière fois. Une fois affiché, il suit le groupe
   * (déplacement, rotation, échelle) sans autre intervention.
   */
  setApercu(on) {
    this._apercu = !!on;
    for (const g of this.groupes) {
      if (!g.userData.apercu) continue;
      if (on) this.rafraichirApercu(g);
      g.userData.apercu.visible = on;
      // la poignee ne redevient saisissable que pendant l'apercu
      for (const p of g.userData.apercu.userData.poignees || []) {
        p.raycast = on ? (p.userData._raycast || (() => {})) : (() => {});
      }
    }
    this.viewer.demanderImage(2);
  }

  get apercuActif() { return !!this._apercu; }

  /**
   * La poignee d'apercu sous le curseur, ou null.
   * Appele par le viewer au pointerdown, uniquement quand l'apercu est actif.
   */
  poigneeSous(pointer, camera) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, camera);
    ray.params.Line = { threshold: 0.35 };      // une ligne est dure a saisir
    ray.params.Points = { threshold: 0.35 };
    for (const g of this.groupes) {
      const ap = g.userData.apercu;
      if (!ap?.visible) continue;
      const hits = ray.intersectObjects(ap.userData.poignees || [], false);
      if (hits.length) return { g, type: hits[0].object.userData.apType };
    }
    return null;
  }

  /**
   * Edite le faisceau en tirant sa poignee : la base du cone (portee + angle),
   * la sphere (portee) ou la nappe (taille). Le calcul se fait dans le repere
   * local du groupe, le meme que celui de la source.
   */
  editerFaisceau(g, type, pointer, camera) {
    const source = g.userData.source;
    const echelle = this.viewer.lib?.scale ?? 1;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, camera);

    const inv = new THREE.Matrix4().copy(g.matrixWorld).invert();
    const rayLocal = ray.ray.clone().applyMatrix4(inv);
    const p = new THREE.Vector3();

    /* La pointe de la normale : on la tire le long de l'axe pour allonger la
       portee. Le point vise est projete sur l'axe -Z local, ce qui rend le
       geste insensible au deplacement lateral de la souris. */
    if (type === 'portee') {
      const axe = new THREE.Ray(new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, -1));
      const surAxe = new THREE.Vector3();
      rayLocal.distanceSqToSegment(axe.origin,
        axe.origin.clone().addScaledVector(axe.direction, 1e4), null, surAxe);
      const d = Math.max(0.1, -surAxe.z);
      appliquerReglages(g, { portee: d / echelle }, echelle);

    } else if (type === 'disque') {
      const plan = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      if (!rayLocal.intersectPlane(plan, p)) return;
      const r = Math.max(0.02, Math.hypot(p.x, p.y));
      appliquerReglages(g, { rayon: r / echelle }, echelle);

    } else if (type === 'sphere') {
      const monde = new THREE.Vector3();
      g.getWorldPosition(monde);
      const regard = camera.getWorldDirection(new THREE.Vector3()).normalize();
      const plan = new THREE.Plane().setFromNormalAndCoplanarPoint(regard, monde);
      if (!ray.ray.intersectPlane(plan, p)) return;
      const r = Math.max(0.1, p.distanceTo(monde));
      appliquerReglages(g, { portee: r / echelle }, echelle);
    } else if (type === 'rect') {
      const plan = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
      if (!rayLocal.intersectPlane(plan, p)) return;
      const w = Math.max(0.05, Math.abs(p.x) * 2);
      const h = Math.max(0.05, Math.abs(p.y) * 2);
      appliquerReglages(g, { taille: [w / echelle, h / echelle] }, echelle);
    } else {
      // cone : la base est sur le plan z = -portee, dans le repere local
      g.updateMatrixWorld(true);
      const hSol = Math.max(0.2, g.getWorldPosition(new THREE.Vector3()).z);
      const d = source.distance || hSol;
      const plan = new THREE.Plane(new THREE.Vector3(0, 0, 1), d);
      if (!rayLocal.intersectPlane(plan, p)) return;
      const dist = Math.max(0.1, -p.z);
      const rayon = Math.hypot(p.x, p.y);
      const angle = Math.max(1, 2 * Math.atan2(rayon, dist) / DEG);
      appliquerReglages(g, { portee: dist / echelle, angleCone: angle }, echelle);
    }

    this.rafraichirApercu(g);
    this.viewer.marquerOmbres();
  }

  finEdition() {
    // la liste et le formulaire refletent les nouvelles valeurs
    this.viewer.hooks.onLuminaire?.();
  }

  /** Reconstruit l'aperçu d'un appareil d'après l'état réel de sa source. */
  rafraichirApercu(g) {
    const ancien = g.userData.apercu;
    if (ancien) g.remove(ancien);
    const source = g.userData.source;
    if (!source) return;

    /* La hauteur qui separe l'appareil du sol, mesuree dans le monde puis
       ramenee a l'echelle locale : un luminaire mis a l'echelle verrait
       sinon son faisceau s'allonger avec lui, ce qui n'a aucun sens
       physique — un spot agrandi n'eclaire pas plus loin. */
    g.updateMatrixWorld(true);
    const monde = g.getWorldPosition(new THREE.Vector3());
    const echelleZ = Math.abs(g.getWorldScale(new THREE.Vector3()).z) || 1;
    const hauteur = Math.max(0.2, monde.z) / echelleZ;

    /* La specification voyage avec l'apercu : c'est elle qui porte le type,
       et donc la representation. Le seul objet three ne suffit pas — un
       disque et un projecteur sont tous deux des SpotLight ici, alors qu'ils
       ne se dessinent pas du tout de la meme facon. */
    const spec = { ...(g.userData.spec || {}),
                   __echelle: this.viewer.lib?.scale ?? 0.001 };
    const ap = construireApercu(source, hauteur, spec);
    ap.visible = this._apercu === true;
    g.add(ap);
    g.userData.apercu = ap;
  }

  get compte() { return this.groupes.size; }
}
