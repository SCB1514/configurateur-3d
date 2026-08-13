import * as THREE from '../vendor/three/three.module.js';

/* ============================================================
   Qualité de rendu
   ------------------------------------------------------------
   Trois choses font la différence entre une maquette et une
   image de présentation, et aucune n'est le nombre de polygones :

     1. l'ÉCLAIRAGE d'environnement — ce que le matériau reflète ;
     2. l'ANCRAGE au sol — sans ombre de contact, tout flotte ;
     3. l'OCCLUSION dans les recoins, qui donne le volume.

   Ce module s'occupe des trois, plus le post-traitement.
   Tout est réglable : une salle de sport se présente en studio
   sombre pour un rendu produit, ou en showroom clair pour une
   implantation.
   ============================================================ */

/* ══════════════════ environnements ══════════════════
   Construits à la volée plutôt que chargés : une carte HDR pèse
   plusieurs mégaoctets, et une boîte de studio bien posée donne
   des reflets plus nets qu'un panorama générique.
   ==================================================== */

/* Réglage de l'exposition, pour mémoire — c'est là que tout se joue.
   L'environnement est un éclairage complet : ses couleurs de voûte sont
   l'ambiance de base, présente partout, et les panneaux ne sont que des
   reflets ponctuels. Une voûte blanche donne un blanc cramé quelle que soit
   l'exposition. On garde donc la voûte à mi-clair, même en showroom, et on
   laisse les panneaux — petits et vifs — porter l'éclat. */

export const ENVIRONNEMENTS = {
  studio: {
    nom: 'Studio',
    // Un cyclorama : clair au centre, sombre aux bords. C'est ce dégradé,
    // et non une couleur unie, qui détache le sujet et donne la profondeur.
    fondCentre: 0x2b323d, fondBord: 0x0a0c10,
    sol: 0x1b1f27, solRugosite: 0.26, solMetal: 0.0,
    // Attention au piège : la voûte d'éclairage n'est PAS le fond visible.
    // Un métal poli ne montre rien d'autre que ce qu'il reflète ; avec une
    // voûte aussi sombre que le fond, le chrome vire au noir et les huit
    // matières se ressemblent toutes. On garde donc un fond de studio
    // sombre et une voûte de mi-gris, comme une vraie boîte à lumière.
    env: { ciel: 0x5c6470, horizon: 0x343b46, sol: 0x191d24 },
    exposition: 1.15, soleil: 2.6, ambiance: 0.15, reflet: 0.30,
    // trois boîtes lumineuses : clé, contre-jour, remplissage. Petites et
    // vives : c'est ce qui donne au chrome sa traînée franche.
    sources: [
      { pos: [4, -5, 6], taille: [5, 3], couleur: 0xffffff, force: 7.0 },
      { pos: [-6, 3, 4], taille: [4, 4], couleur: 0xa8c8ff, force: 3.0 },
      { pos: [0, 7, 3], taille: [6, 2], couleur: 0xfff0dc, force: 2.0 },
    ],
  },
  showroom: {
    nom: 'Showroom',
    fondCentre: 0xf2f5f8, fondBord: 0xc6ccd5,
    sol: 0xdfe3e9, solRugosite: 0.45, solMetal: 0.0,
    env: { ciel: 0xc4cad3, horizon: 0x99a0aa, sol: 0x79808a },
    exposition: 0.95, soleil: 2.2, ambiance: 0.10, reflet: 0.18,
    sources: [
      { pos: [5, -4, 7], taille: [6, 4], couleur: 0xffffff, force: 2.4 },
      { pos: [-5, 4, 6], taille: [6, 4], couleur: 0xffffff, force: 1.6 },
      { pos: [0, 0, 9], taille: [8, 8], couleur: 0xffffff, force: 1.2 },
    ],
  },
  atelier: {
    nom: 'Atelier',
    fondCentre: 0x3b434f, fondBord: 0x171a20,
    sol: 0x2f343d, solRugosite: 0.62, solMetal: 0.0,
    env: { ciel: 0x6b7381, horizon: 0x3a414c, sol: 0x1f242b },
    exposition: 1.0, soleil: 3.0, ambiance: 0.18, reflet: 0.25,
    sources: [
      { pos: [6, -6, 8], taille: [3, 3], couleur: 0xfff2e0, force: 5.0 },
      { pos: [-7, 2, 5], taille: [2, 5], couleur: 0x9fc0ff, force: 1.6 },
    ],
  },
};

/**
 * Le fond : un dégradé radial peint une fois, posé comme image de fond.
 * Three dessine une texture 2D en plein cadre — c'est exactement le mur de
 * fond dégradé d'un studio photo, sans géométrie ni coût de rendu.
 */
function textureFond(centre, bord) {
  const t = document.createElement('canvas');
  t.width = t.height = 512;
  const c = t.getContext('2d');
  // centre légèrement haut : la lumière tombe d'en haut, comme dans la vraie vie
  const d = c.createRadialGradient(256, 200, 20, 256, 256, 400);
  d.addColorStop(0, '#' + new THREE.Color(centre).getHexString());
  d.addColorStop(1, '#' + new THREE.Color(bord).getHexString());
  c.fillStyle = d;
  c.fillRect(0, 0, 512, 512);

  const texture = new THREE.CanvasTexture(t);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/**
 * Le voile du sol : opaque au centre, transparent aux bords.
 * Sans lui, le plan récepteur se termine par une arête franche en plein
 * cadre. Avec, il se dissout dans le fond et le sol paraît infini.
 */
function textureVoile() {
  const t = document.createElement('canvas');
  t.width = t.height = 256;
  const c = t.getContext('2d');
  const d = c.createRadialGradient(128, 128, 10, 128, 128, 126);
  d.addColorStop(0, '#ffffff');
  d.addColorStop(0.55, '#dddddd');
  d.addColorStop(1, '#000000');
  c.fillStyle = d;
  c.fillRect(0, 0, 256, 256);
  return new THREE.CanvasTexture(t);
}

/** Une scène d'éclairage : dégradé de fond + panneaux émissifs. */
function batirEnvironnement(reglage) {
  const scene = new THREE.Scene();

  // La voûte : un dégradé ciel/horizon, qui donne au métal sa direction.
  const voute = new THREE.Mesh(
    new THREE.SphereGeometry(40, 32, 24),
    new THREE.ShaderMaterial({
      side: THREE.BackSide,
      uniforms: {
        ciel: { value: new THREE.Color(reglage.env.ciel) },
        horizon: { value: new THREE.Color(reglage.env.horizon) },
        sol: { value: new THREE.Color(reglage.env.sol) },
      },
      vertexShader: `
        varying vec3 vPos;
        void main() {
          vPos = position;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }`,
      fragmentShader: `
        uniform vec3 ciel; uniform vec3 horizon; uniform vec3 sol;
        varying vec3 vPos;
        void main() {
          float h = normalize(vPos).z;
          vec3 c = h > 0.0 ? mix(horizon, ciel, pow(h, 0.6))
                           : mix(horizon, sol, pow(-h, 0.5));
          gl_FragColor = vec4(c, 1.0);
        }`,
    }));
  scene.add(voute);

  for (const s of reglage.sources) {
    const panneau = new THREE.Mesh(
      new THREE.PlaneGeometry(s.taille[0], s.taille[1]),
      new THREE.MeshBasicMaterial({ color: s.couleur }));
    panneau.material.color.multiplyScalar(s.force);
    panneau.position.set(...s.pos);
    panneau.lookAt(0, 0, 1);
    scene.add(panneau);
  }

  return scene;
}

/* ══════════════════ moteur ══════════════════ */

export class Rendu {
  constructor(viewer) {
    this.viewer = viewer;
    this.reglages = {
      environnement: 'studio',
      exposition: 1.15,
      ombres: 0.7,
      occlusion: 0.7,
      bloom: 0.2,
      sol: true,
      reflets: true,           // le sol renvoie les machines, comme un sol de showroom ciré
      reperes: true,           // grille et axes — utiles pour poser, non pour présenter
      qualite: 'haute',        // 'rapide' | 'haute'
    };
    this._pmrem = new THREE.PMREMGenerator(viewer.renderer);
    this._composer = null;
    this._passes = {};
  }

  /* ---------------- environnement ---------------- */

  appliquerEnvironnement(nom = this.reglages.environnement) {
    const reglage = ENVIRONNEMENTS[nom] || ENVIRONNEMENTS.studio;
    this.reglages.environnement = nom;

    const scene = batirEnvironnement(reglage);
    const cible = this._pmrem.fromScene(scene, 0.02);
    this.viewer.scene.environment?.dispose?.();
    this.viewer.scene.environment = cible.texture;

    this.viewer.scene.background?.dispose?.();
    this.viewer.scene.background = textureFond(reglage.fondCentre, reglage.fondBord);

    this.reglages.exposition = reglage.exposition;
    this.viewer.renderer.toneMappingExposure = reglage.exposition;

    // Les sources directes accompagnent l'ambiance : c'est le soleil qui porte
    // l'ombre, et une ombre ne se lit que si sa source l'emporte sur le diffus.
    if (this.viewer.sun) this.viewer.sun.intensity = reglage.soleil;
    if (this.viewer.hemi) this.viewer.hemi.intensity = reglage.ambiance;
    if (this.viewer.contre) this.viewer.contre.intensity = reglage.ambiance * 1.5;

    // La grille et les axes accompagnent le décor sans le trancher. La grille
    // porte ses couleurs dans ses sommets : toucher à material.color les
    // multiplierait et l'effacerait — on ne joue que sur l'opacité.
    this._clair = new THREE.Color(reglage.fondBord).getHSL({}).l > 0.5;
    if (this.viewer.grid) this.viewer.grid.material.opacity = this._clair ? 0.5 : 0.32;
    this.majReperes();

    scene.traverse(o => { o.geometry?.dispose(); o.material?.dispose(); });
    this.majSol();
    return reglage;
  }

  /** Grille et axes : utiles pour implanter, encombrants pour présenter. */
  majReperes() {
    const on = this.reglages.reperes;
    if (this.viewer.grid) this.viewer.grid.visible = on;
    for (const o of this.viewer.scene.children) {
      if (o.isGroup && o.userData.axes) o.visible = on;
    }
  }

  /* ---------------- sol et ombres ----------------
     Un plan récepteur borné à l'emprise réelle, et une caméra
     d'ombre ajustée à la même emprise. C'est ce couplage qui
     manquait : un plan infini hors du cadre d'ombre se peint
     entièrement en ombre douce et barre la vue.
     ------------------------------------------------ */

  majSol() {
    const viewer = this.viewer;
    const emprise = viewer.bounds();
    const reglage = ENVIRONNEMENTS[this.reglages.environnement] || ENVIRONNEMENTS.studio;

    if (!this._sol) {
      this._voile = textureVoile();
      this._sol = new THREE.Mesh(
        new THREE.PlaneGeometry(1, 1),
        new THREE.MeshStandardMaterial({
          transparent: true, depthWrite: false, alphaMap: this._voile,
        }));
      this._sol.receiveShadow = true;
      this._sol.renderOrder = -2;
      this._sol.raycast = () => {};      // le sol ne doit jamais capter un clic
      viewer.scene.add(this._sol);
    }

    // Le sol reflète l'environnement : c'est ce reflet, et non l'ombre seule,
    // qui pose les machines. Un capteur d'ombre pur sur fond noir ne montre
    // rien du tout — l'ombre y est invisible.
    Object.assign(this._sol.material, {
      color: new THREE.Color(reglage.sol),
      roughness: reglage.solRugosite,
      metalness: reglage.solMetal,
      envMapIntensity: 0.85,
      opacity: 0.35 + this.reglages.ombres * 0.65,
    });
    this._sol.material.needsUpdate = true;

    this._sol.visible = this.reglages.sol && !!emprise;
    if (!emprise) return;

    const centre = emprise.getCenter(new THREE.Vector3());
    const taille = emprise.getSize(new THREE.Vector3());
    const cote = Math.max(taille.x, taille.y) * 3.2 + 4;

    /* Pendant qu'on déplace une machine, l'emprise change à chaque image et
       majSol est rappelé quatre fois par seconde. Reconstruire le plan à
       chaque fois, c'est jeter puis réallouer une géométrie en pleine
       manipulation — un à-coup, précisément au moment où l'on demande de la
       fluidité. On ne le refait que si la taille a réellement bougé. */
    if (Math.abs((this._sol.geometry.parameters?.width ?? 0) - cote) > cote * 0.02) {
      this._sol.geometry.dispose();
      this._sol.geometry = new THREE.PlaneGeometry(cote, cote);
    }
    this._sol.position.set(centre.x, centre.y, Math.min(emprise.min.z, 0) + 0.001);
    this.polirSol(reglage);

    // La caméra d'ombre épouse les machines, pas le sol : chaque mètre carré
    // de carte d'ombre dépensé hors du sujet est de la finesse perdue.
    const sun = viewer.sun;
    if (sun?.shadow) {
      const rayon = Math.max(taille.length() * 0.62, 2);
      Object.assign(sun.shadow.camera, {
        left: -rayon, right: rayon, top: rayon, bottom: -rayon,
        near: 0.5, far: rayon * 6,
      });

      // Environ 32° au-dessus de l'horizon, et surtout décalé de la caméra :
      // une source dans l'axe du regard cache son ombre derrière le sujet, et
      // une source à la verticale la cache dessous. Placée en -X/-Y, elle
      // étale l'ombre vers la droite de la vue isométrique — celle des
      // partages et des vignettes.
      sun.position.set(centre.x - rayon * 0.90, centre.y - rayon * 1.00,
                       emprise.min.z + rayon * 0.85);
      sun.target.position.copy(centre);
      if (!sun.target.parent) viewer.scene.add(sun.target);
      sun.target.updateMatrixWorld();
      sun.shadow.camera.updateProjectionMatrix();
      sun.shadow.mapSize.set(this.reglages.qualite === 'haute' ? 2048 : 1024,
                             this.reglages.qualite === 'haute' ? 2048 : 1024);
      viewer.marquerOmbres();
      sun.shadow.bias = -0.0006;
      sun.shadow.normalBias = 0.02;
    }
  }

  /* ---------------- brillant du sol ----------------
     Un sol de showroom renvoie l'image des machines. La facon evidente de
     l'obtenir est un miroir plan : on rend la scene une seconde fois depuis
     une camera symetrique. Deux raisons de ne pas le faire ici.

     La premiere est le prix : c'est un doublement du rendu, sur une
     application dont on demande d'abord la fluidite.

     La seconde s'est vue a l'ecran. Le Reflector de three melange son
     resultat par superposition, et le reflet sortait plus lumineux que les
     objets reels — une impossibilite physique que l'oeil repere aussitot.

     Le sol renvoie donc son environnement par sa seule matiere : c'est
     gratuit, c'est juste, et cela suffit a poser les machines. Le reglage
     « reflets » commande alors le poli du sol, du mat au cire.
     ------------------------------------------------ */

  polirSol(reglage) {
    if (!this._sol) return;
    const poli = this.reglages.reflets ? (reglage.reflet ?? 0.3) : 0;

    // un sol cire est lisse et renvoie beaucoup ; un sol mat, l'inverse
    this._sol.material.roughness = reglage.solRugosite * (1 - poli * 0.75);
    this._sol.material.envMapIntensity = 0.6 + poli * 1.6;
    this._sol.material.needsUpdate = true;
  }

  /* ---------------- post-traitement ---------------- */

  async activerPostTraitement() {
    if (this._composer) return this._composer;
    const viewer = this.viewer;

    const [{ EffectComposer }, { RenderPass }, { OutputPass }, { UnrealBloomPass }, { SMAAPass }, { GTAOPass }] =
      await Promise.all([
        import('../vendor/three/addons/postprocessing/EffectComposer.js'),
        import('../vendor/three/addons/postprocessing/RenderPass.js'),
        import('../vendor/three/addons/postprocessing/OutputPass.js'),
        import('../vendor/three/addons/postprocessing/UnrealBloomPass.js'),
        import('../vendor/three/addons/postprocessing/SMAAPass.js'),
        import('../vendor/three/addons/postprocessing/GTAOPass.js'),
      ]);

    const el = viewer.canvas.parentElement;
    const largeur = el.clientWidth || 1, hauteur = el.clientHeight || 1;

    /* L'antialiasing materiel, reserve a WebGL 2.

       Un compositeur rend hors ecran, ou l'antialiasing du canevas ne
       s'applique plus : d'ou les escaliers sur les aretes des chassis des
       qu'on branche du post-traitement. WebGL 2 sait lisser la cible
       elle-meme, a quatre echantillons, dans le materiel. C'est meilleur
       que le lissage logiciel SMAA et cela coute moins cher sur une vraie
       carte — SMAA ne reste que pour les cartes qui refusent le multi-
       echantillonnage.  */
    const echantillons = viewer.renderer.capabilities.isWebGL2 ? 4 : 0;
    const cible = new THREE.WebGLRenderTarget(largeur, hauteur, {
      type: THREE.HalfFloatType, samples: echantillons,
      colorSpace: THREE.LinearSRGBColorSpace,
    });

    const composer = new EffectComposer(viewer.renderer, cible);
    this._msaa = echantillons;
    composer.setSize(largeur, hauteur);
    // 1,5 plutôt que 2 : les cibles de rendu du compositeur sont en virgule
    // flottante et coûtent quatre fois plus cher qu'un pixel d'écran. Le
    // lissage SMAA rattrape la finesse perdue, et bien plus vite.
    composer.setPixelRatio(Math.min(devicePixelRatio, 1.5));

    const rendu = new RenderPass(viewer.scene, viewer.camera);
    composer.addPass(rendu);

    // Occlusion ambiante : c'est elle qui creuse les recoins et pose
    // les machines dans l'espace au lieu de les laisser en aplat.
    const ao = new GTAOPass(viewer.scene, viewer.camera, largeur, hauteur);
    ao.output = GTAOPass.OUTPUT.Default;
    composer.addPass(ao);

    /* Le halo coute treize passes plein ecran par image — de loin le plus
       gourmand du compositeur. Or un halo est flou par nature : le calculer
       a demi-resolution divise son cout par quatre sans que rien ne se voie.
       EffectComposer impose sa taille a chaque passe lors d'un
       redimensionnement, d'ou l'interception. */
    const bloom = new UnrealBloomPass(
      new THREE.Vector2(largeur, hauteur), this.reglages.bloom, 0.45, 0.92);
    const tailleBloom = bloom.setSize.bind(bloom);
    bloom.setSize = (l, h) => tailleBloom(Math.max(1, Math.round(l * 0.5)),
                                          Math.max(1, Math.round(h * 0.5)));
    bloom.setSize(largeur, hauteur);
    composer.addPass(bloom);

    composer.addPass(new OutputPass());

    const smaa = new SMAAPass(largeur, hauteur);
    composer.addPass(smaa);

    this._composer = composer;
    this._passes = { rendu, ao, bloom, smaa };
    this.majPostTraitement();
    return composer;
  }

  majPostTraitement() {
    const p = this._passes;
    if (!p.ao) return;

    const haute = this.reglages.qualite === 'haute';
    const force = this.reglages.occlusion;

    p.ao.enabled = force > 0.01;
    p.ao.blendIntensity = force;              // le vrai bouton de dosage de l'AO
    p.ao.updateGtaoMaterial({
      // 35 cm : l'échelle des creux qui comptent — entre un capot et son
      // châssis, sous un repose-pied, autour d'une poulie.
      radius: 0.35, distanceExponent: 1.6, thickness: 0.6,
      scale: 1, samples: haute ? 16 : 8,
    });
    // le debruitage de l'occlusion : seize echantillons en qualite haute,
    // huit suffisent quand on cherche d'abord la vitesse
    p.ao.pdSamples = haute ? 16 : 8;

    p.bloom.enabled = this.reglages.bloom > 0.01;
    p.bloom.strength = this.reglages.bloom;
    // Le multi-echantillonnage materiel fait deja le travail : SMAA
    // par-dessus adoucirait les textures sans rien gagner sur les aretes.
    p.smaa.enabled = haute && !this._msaa;

    /* La résolution est le levier le plus direct : chaque pixel du
       compositeur se paie sur une cible en virgule flottante, quatre fois
       échantillonnée. Deux enseignements de la mise au point :

       — écran et compositeur doivent porter le MÊME facteur. S'ils
         divergent, l'image est rendue à une taille puis rééchantillonnée à
         une autre : on paie la finesse sans la voir.
       — au-delà de 1,25, la finesse supplémentaire ne se voit plus, parce
         que l'antialiasing matériel à quatre échantillons a déjà traité les
         arêtes. Sur un écran à haute densité, passer de 2 à 1,25 divise le
         travail par deux et demi sans que l'œil s'en aperçoive. */
    const ratio = haute ? Math.min(devicePixelRatio, 1.25) : 1;
    // Chaque source allumee se paie sur chaque pixel de chaque objet : le
    // budget d'eclairage est le premier levier quand la machine peine.
    this.viewer.luminaires?.reglerBudget(haute ? 8 : 3);

    /* L'ordre compte. Le compositeur calcule la taille de ses cibles à
       partir de celle du rendu : changer l'un sans l'autre, ou dans le
       mauvais ordre, laisse une image rendue au format précédent et
       étirée au nouveau — un éclair de vue déformée au moment où la
       qualité bascule. On pose donc l'écran, puis le compositeur, puis
       on redimensionne une seule fois. */
    if (this.viewer.renderer.getPixelRatio() !== ratio || this._ratio !== ratio) {
      this._ratio = ratio;
      this.viewer.renderer.setPixelRatio(ratio);
      this._composer.setPixelRatio(ratio);
      this.viewer.resize();
    }
    this.viewer.marquerOmbres();
  }

  desactiverPostTraitement() {
    this._composer = null;
    this._passes = {};
  }

  redimensionner(largeur, hauteur) {
    if (!this._composer) return;
    this._composer.setSize(largeur, hauteur);
    this._passes.ao?.setSize?.(largeur, hauteur);
    this._passes.bloom?.setSize?.(largeur, hauteur);
    this._passes.smaa?.setSize?.(largeur, hauteur);
  }

  /** Utilisé par la capture d'image, qui rend à une résolution supérieure. */
  setPixelRatio(ratio) {
    this._composer?.setPixelRatio(ratio);
  }

  /**
   * Signale que la vue bouge.
   *
   * L'occlusion ambiante et le halo coûtent à eux deux plus que tout le
   * reste réuni, et personne ne les examine en faisant tourner la scène. On
   * les suspend le temps du mouvement.
   *
   * Le délai de retour est volontairement long. À 200 ms, les micro-pauses
   * d'une main sur la souris — il y en a plusieurs par seconde dans une
   * rotation ordinaire — suffisaient à relancer l'enrichissement, qui
   * repartait aussitôt : c'était exactement le clignotement constaté.
   */
  signalerMouvement() {
    this._bougeJusqua = performance.now() + 380;
  }

  /**
   * Rend une image. Renvoie faux si le post-traitement n'est pas en place.
   * `forcer` impose la qualité pleine même en plein mouvement — la capture
   * d'image ne doit jamais livrer une vue dégradée.
   */
  rendre(forcer = false) {
    if (!this._composer) return false;

    /* ── l'enrichissement, en fondu ──

       Allumer d'un coup l'occlusion et le halo à l'arrêt de la rotation
       faisait sauter l'image : les creux se remplissaient d'ombre en une
       seule trame, et l'œil lisait un défaut d'affichage plutôt qu'un gain
       de qualité. Ils montent maintenant progressivement, sur environ un
       tiers de seconde, et redescendent d'un coup dès qu'on reprend la
       main — car là, personne ne regarde.

       Le fondu réclame lui-même des images : sans cela le rendu à la
       demande s'arrêterait à mi-chemin et figerait une occlusion à moitié
       appliquée. */
    const t = performance.now();
    const immobile = forcer || t >= (this._bougeJusqua || 0);

    /* Le fondu se compte en millisecondes, pas en images.

       Avancer d'un pourcentage par image paraît naturel, et c'est un piège :
       sur une machine qui rend à huit images par seconde, le même fondu
       s'étire sur trois secondes — l'occlusion arrive longtemps après que
       l'on a lâché la souris, et l'on croit à un défaut. Mesuré en temps, il
       dure un tiers de seconde partout. */
    const DUREE = 320;

    if (forcer) {
      this._fondu = 1;
    } else if (!immobile) {
      this._fondu = 0;
      this._fonduDepart = 0;
    } else {
      if (!this._fonduDepart) this._fonduDepart = t;
      this._fondu = Math.min(1, (t - this._fonduDepart) / DUREE);
      if (this._fondu < 1) this.viewer.demanderImage(2);
    }

    const k = this._fondu;

    const ao = this._passes.ao;
    if (ao) {
      ao.enabled = k > 0.02 && this.reglages.occlusion > 0.01;
      ao.blendIntensity = this.reglages.occlusion * k;
    }

    // Le halo suit le même sort : treize passes plein écran valent bien
    // qu'on s'en dispense le temps d'une rotation.
    const bloom = this._passes.bloom;
    if (bloom) {
      bloom.enabled = k > 0.02 && this.reglages.bloom > 0.01;
      bloom.strength = this.reglages.bloom * k;
    }

    this._composer.render();
    return true;
  }

  /* ---------------- réglages ---------------- */

  regler(patch) {
    Object.assign(this.reglages, patch);
    this.viewer.demanderImage(3);

    if (patch.environnement) this.appliquerEnvironnement(patch.environnement);
    if (patch.exposition !== undefined) this.viewer.renderer.toneMappingExposure = patch.exposition;
    // majSol repose tout ce qui touche au sol : opacité, miroir, cadre d'ombre
    if (patch.ombres !== undefined || patch.sol !== undefined || patch.reflets !== undefined) {
      this.majSol();
    }
    if (patch.reperes !== undefined) this.majReperes();
    if (patch.occlusion !== undefined || patch.bloom !== undefined || patch.qualite !== undefined) {
      this.majPostTraitement();
    }
  }
}
