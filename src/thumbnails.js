import * as THREE from '../vendor/three/three.module.js';
import { RoomEnvironment } from '../vendor/three/addons/environments/RoomEnvironment.js';
import { buildStandardMaterial } from './library.js';

/* ============================================================
   Vignettes du catalogue — rendues à la volée depuis la
   géométrie des blocs (aucune image à exporter depuis Rhino).

   Le même atelier sert aux pastilles de matériaux : une sphère
   éclairée comme la scène, pour que le panneau Matériaux montre
   la matière et non une simple couleur à plat.
   ============================================================ */

export class ThumbnailFactory {
  constructor(size = 256) {
    this.size = size;
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    // preserveDrawingBuffer : sans lui, toDataURL peut tomber sur un buffer
    // deja efface par le compositeur et renvoyer une image vide.
    this.renderer = new THREE.WebGLRenderer({
      canvas, antialias: true, alpha: true, preserveDrawingBuffer: true,
    });
    this.renderer.setPixelRatio(1);
    this.renderer.setSize(size, size, false);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;

    this.scene = new THREE.Scene();
    // Même environnement que la vue 3D : sans lui un métal rugueux paraît mat
    // et un chrome paraît gris. Les sources directes sont donc plus douces
    // qu'à l'époque où elles faisaient seules tout l'éclairage.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environment = this.environment;
    this.scene.add(new THREE.HemisphereLight(0xf0f6ff, 0x2a3038, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.6);
    key.position.set(3, -5, 6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fa8ff, 0.7);
    rim.position.set(-4, 3, 2);
    this.scene.add(rim);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 500);
    this.camera.up.set(0, 0, 1);
    this.cache = new Map();
    this.matCache = new Map();
    this._taille = size;
  }

  render(block) {
    if (this.cache.has(block.id)) return this.cache.get(block.id);

    const group = new THREE.Group();
    for (const p of block.parts) group.add(new THREE.Mesh(p.geometry, buildStandardMaterial(p)));
    const url = this._shoot(group, 1.45);
    if (url && url.length >= 400) this.cache.set(block.id, url);
    return url;
  }

  /**
   * Pastille d'un matériau : une sphère de cette matière, rendue avec
   * l'environnement de la scène. Métal, rugosité et transparence s'y lisent —
   * ce qu'un aplat de couleur ne montrait pas.
   */
  renderMaterial(mat, taille = 96) {
    const cle = `${mat.id}|${mat.color}|${mat.metalness}|${mat.roughness}|${mat.opacity}`;
    if (this.matCache.has(cle)) return this.matCache.get(cle);

    if (!this._sphere) {
      this._sphere = new THREE.SphereGeometry(1, 48, 32);
      // une carte d'occlusion lit le second jeu de coordonnées
      this._sphere.setAttribute('uv1', this._sphere.getAttribute('uv'));
    }
    const group = new THREE.Group();
    group.add(new THREE.Mesh(this._sphere, buildStandardMaterial({
      color: mat.color, opacity: mat.opacity,
      metalness: mat.metalness, roughness: mat.roughness,
      maps: mat.maps, material: mat.id,
    })));

    // la sphère occupe la vignette : cadrage serré, prise de face légèrement haute
    const url = this._shoot(group, 1.06, new THREE.Vector3(0.35, -0.9, 0.3), taille);
    if (url && url.length >= 400) this.matCache.set(cle, url);
    return url;
  }

  /** Rend un groupe dans l'atelier et en rapporte une image PNG. */
  _shoot(group, marge, direction = null, taille = this.size) {
    if (taille !== this._taille) {
      this.renderer.setSize(taille, taille, false);
      this._taille = taille;
    }
    this.scene.add(group);

    const box = new THREE.Box3().setFromObject(group);
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 1e-3);
    const dist = (r * marge) / Math.sin((this.camera.fov * Math.PI) / 360);
    const dir = (direction || new THREE.Vector3(0.62, -0.74, 0.5)).clone().normalize();
    this.camera.position.copy(c).addScaledVector(dir, dist);
    this.camera.lookAt(c);
    this.camera.updateProjectionMatrix();

    this.renderer.render(this.scene, this.camera);
    let url = this.renderer.domElement.toDataURL('image/png');
    if (!url || url.length < 400) {          // rendu vide : on retente une fois
      this.renderer.render(this.scene, this.camera);
      url = this.renderer.domElement.toDataURL('image/png');
    }

    this.scene.remove(group);
    group.traverse(o => { if (o.isMesh) o.material.dispose(); });
    return url;
  }
}
