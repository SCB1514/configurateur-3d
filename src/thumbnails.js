import * as THREE from '../vendor/three/three.module.js';

/* ============================================================
   Vignettes du catalogue — rendues à la volée depuis la
   géométrie des blocs (aucune image à exporter depuis Rhino).
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
    this.scene.add(new THREE.HemisphereLight(0xf0f6ff, 0x2a3038, 2.2));
    const key = new THREE.DirectionalLight(0xffffff, 2.4);
    key.position.set(3, -5, 6);
    this.scene.add(key);
    const rim = new THREE.DirectionalLight(0x6fa8ff, 1.1);
    rim.position.set(-4, 3, 2);
    this.scene.add(rim);

    this.camera = new THREE.PerspectiveCamera(38, 1, 0.01, 500);
    this.camera.up.set(0, 0, 1);
    this.cache = new Map();
  }

  render(block) {
    if (this.cache.has(block.id)) return this.cache.get(block.id);

    const group = new THREE.Group();
    for (const p of block.parts) {
      group.add(new THREE.Mesh(p.geometry, new THREE.MeshStandardMaterial({
        color: new THREE.Color(p.color),
        metalness: p.metalness, roughness: p.roughness,
        transparent: p.opacity < 1, opacity: p.opacity, side: THREE.DoubleSide,
      })));
    }
    this.scene.add(group);

    const box = new THREE.Box3().setFromObject(group);
    const c = box.getCenter(new THREE.Vector3());
    const r = Math.max(box.getSize(new THREE.Vector3()).length() * 0.5, 1e-3);
    const dist = (r * 1.45) / Math.sin((this.camera.fov * Math.PI) / 360);
    this.camera.position.copy(c).add(new THREE.Vector3(0.62, -0.74, 0.5).normalize().multiplyScalar(dist));
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
    if (url && url.length >= 400) this.cache.set(block.id, url);
    return url;
  }
}
