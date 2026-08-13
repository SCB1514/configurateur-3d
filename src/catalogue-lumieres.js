export const MATIERES_LUMIERE = [
  {
    id: "alu-mat",
    name: "Aluminium mat",
    color: "#9aa1a9",
    metalness: 0.9,
    roughness: 0.38,
    opacity: 1
  },
  {
    id: "noir-mat",
    name: "Noir mat",
    color: "#17191d",
    metalness: 0.1,
    roughness: 0.72,
    opacity: 1
  },
  {
    id: "diffuseur",
    name: "Diffuseur opale",
    color: "#0b0c0e",
    metalness: 0.0,
    roughness: 0.35,
    opacity: 1
  },
  {
    id: "verre-optique",
    name: "Verre optique",
    color: "#dfe9f2",
    metalness: 0.0,
    roughness: 0.06,
    opacity: 0.35
  }
]

// Arrondis pour limiter la taille des données géométriques
const round2 = (v) => Math.round(v * 100) / 100
const round4 = (v) => Math.round(v * 10000) / 10000

/**
 * Boîte axis-aligned centrée en (cx, cy, cz) de dimensions dx, dy, dz.
 * Normales par face, sens antihoraire vu de l'extérieur.
 */
function boite(cx, cy, cz, dx, dy, dz) {
  const hx = dx / 2, hy = dy / 2, hz = dz / 2
  const c = [
    [cx - hx, cy - hy, cz - hz], // 0
    [cx + hx, cy - hy, cz - hz], // 1
    [cx + hx, cy + hy, cz - hz], // 2
    [cx - hx, cy + hy, cz - hz], // 3
    [cx - hx, cy - hy, cz + hz], // 4
    [cx + hx, cy - hy, cz + hz], // 5
    [cx + hx, cy + hy, cz + hz], // 6
    [cx - hx, cy + hy, cz + hz]  // 7
  ]
  const faces = [
    { normal: [0, 0, 1], indices: [4, 5, 6, 7] }, // +Z
    { normal: [0, 0, -1], indices: [0, 3, 2, 1] }, // -Z
    { normal: [0, 1, 0], indices: [3, 7, 6, 2] }, // +Y
    { normal: [0, -1, 0], indices: [0, 1, 5, 4] }, // -Y
    { normal: [1, 0, 0], indices: [1, 2, 6, 5] }, // +X
    { normal: [-1, 0, 0], indices: [0, 4, 7, 3] }  // -X
  ]
  const positions = []
  const normals = []
  const indices = []
  let base = 0
  for (const face of faces) {
    for (const i of face.indices) {
      positions.push(round2(c[i][0]), round2(c[i][1]), round2(c[i][2]))
      normals.push(round4(face.normal[0]), round4(face.normal[1]), round4(face.normal[2]))
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3)
    base += 4
  }
  return { positions, normals, indices }
}

/**
 * Cylindre fermé centré en (cx, cy, cz), axe Z, hauteur totale, rayon donné.
 * Géométrie par triangles, normales par face pour un rendu net.
 */
function cylindre(cx, cy, cz, rayon, hauteur, segments) {
  const positions = []
  const normals = []
  const indices = []
  let index = 0

  const addTriangle = (p0, p1, p2, normal) => {
    positions.push(round2(p0[0]), round2(p0[1]), round2(p0[2]))
    positions.push(round2(p1[0]), round2(p1[1]), round2(p1[2]))
    positions.push(round2(p2[0]), round2(p2[1]), round2(p2[2]))
    normals.push(round4(normal[0]), round4(normal[1]), round4(normal[2]))
    normals.push(round4(normal[0]), round4(normal[1]), round4(normal[2]))
    normals.push(round4(normal[0]), round4(normal[1]), round4(normal[2]))
    indices.push(index, index + 1, index + 2)
    index += 3
  }

  const computeNormal = (p0, p1, p2) => {
    const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2]
    const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2]
    const nx = ay * bz - az * by
    const ny = az * bx - ax * bz
    const nz = ax * by - ay * bx
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    return [nx / len, ny / len, nz / len]
  }

  const topZ = cz + hauteur / 2
  const bottomZ = cz - hauteur / 2
  const angleStep = (Math.PI * 2) / segments

  // Paroi latérale
  for (let i = 0; i < segments; i++) {
    const theta = i * angleStep
    const thetaNext = (i + 1) % segments * angleStep
    const cos = Math.cos(theta), sin = Math.sin(theta)
    const cosN = Math.cos(thetaNext), sinN = Math.sin(thetaNext)

    const topI = [cx + rayon * cos, cy + rayon * sin, topZ]
    const bottomI = [cx + rayon * cos, cy + rayon * sin, bottomZ]
    const topN = [cx + rayon * cosN, cy + rayon * sinN, topZ]
    const bottomN = [cx + rayon * cosN, cy + rayon * sinN, bottomZ]

    // Triangle 1 : haut, bas, haut suivant
    const normal1 = computeNormal(topI, bottomI, topN)
    addTriangle(topI, bottomI, topN, normal1)

    // Triangle 2 : bas, bas suivant, haut suivant
    const normal2 = computeNormal(bottomI, bottomN, topN)
    addTriangle(bottomI, bottomN, topN, normal2)
  }

  // Capot supérieur
  const topCenter = [cx, cy, topZ]
  for (let i = 0; i < segments; i++) {
    const theta = i * angleStep
    const thetaNext = (i + 1) % segments * angleStep
    const pI = [cx + rayon * Math.cos(theta), cy + rayon * Math.sin(theta), topZ]
    const pN = [cx + rayon * Math.cos(thetaNext), cy + rayon * Math.sin(thetaNext), topZ]
    addTriangle(topCenter, pI, pN, [0, 0, 1])
  }

  // Capot inférieur
  const bottomCenter = [cx, cy, bottomZ]
  for (let i = 0; i < segments; i++) {
    const theta = i * angleStep
    const thetaNext = (i + 1) % segments * angleStep
    const pI = [cx + rayon * Math.cos(theta), cy + rayon * Math.sin(theta), bottomZ]
    const pN = [cx + rayon * Math.cos(thetaNext), cy + rayon * Math.sin(thetaNext), bottomZ]
    // Ordre inversé pour obtenir la normale -Z
    addTriangle(bottomCenter, pN, pI, [0, 0, -1])
  }

  return { positions, normals, indices }
}

// Correspondance matériaux pour assemblage rapide
const matMap = Object.fromEntries(MATIERES_LUMIERE.map(m => [m.id, m]))

// Helper pour créer un mesh avec la matière appliquée et éventuellement émission
function meshAvecMatiere(name, geometry, materialId, emissive = null, emissiveIntensite = 0) {
  const mat = matMap[materialId]
  const mesh = {
    name,
    positions: geometry.positions,
    normals: geometry.normals,
    indices: geometry.indices,
    color: mat.color,
    metalness: mat.metalness,
    roughness: mat.roughness,
    opacity: mat.opacity
  }
  if (emissive !== null) {
    mesh.emissive = emissive
    mesh.emissiveIntensite = emissiveIntensite
  }
  return mesh
}

/* Portee nulle sur tous les appareils : le faisceau descend jusqu'au sol.

   Une portee chiffree fige une hauteur d'installation. Le meme downlight
   pose sous un plafond de 2,50 m ou de 4 m doit voir son cone s'arreter au
   plancher dans les deux cas — c'est la tache de lumiere qui interesse, pas
   une distance abstraite. Zero veut dire « jusqu'au sol », et la longueur
   suit l'appareil quand on le deplace. */
export const BLOCS_LUMIERE = [
  {
    id: "spot-rail",
    name: "Spot sur rail",
    category: "Eclairage",
    price: 145,
    description: "Spot orientable sur rail, finition aluminium et diffuseur chaud.",
    baseOffset: 0,
    meshes: [
      meshAvecMatiere("Rail", boite(0, 0, 2900, 1200, 40, 40), "noir-mat"),
      meshAvecMatiere("Corps", cylindre(0, 0, 2720, 62, 190, 24), "noir-mat"),
      meshAvecMatiere("Lentille", cylindre(0, 0, 2622, 52, 8, 24), "diffuseur", "#fff2e2", 4)
    ],
    connectors: [{ type: "*", main: true, pos: [0, 0, 0] }],
    lumieres: [
      {
        type: "spot",
        pos: [0, 0, 2618],
        rot: [18, 0, 0],
        rayon: 52,
        couleur: "#fff2e2",
        intensite: 16,
        eclat: 4,
        portee: 0,
        angle: 26,
        penombre: 0.25,
        nom: "Spot rail",
        actif: true
      }
    ]
  },
  {
    id: "spot-encastre",
    name: "Spot encastre",
    category: "Eclairage",
    price: 78,
    description: "Spot encastrable discret avec collerette aluminium.",
    baseOffset: 0,
    meshes: [
      meshAvecMatiere("Collerette", cylindre(0, 0, 2795, 60, 26, 24), "alu-mat"),
      meshAvecMatiere("Optique", cylindre(0, 0, 2780, 48, 6, 24), "diffuseur", "#ffe9cc", 3.5)
    ],
    connectors: [{ type: "*", main: true, pos: [0, 0, 0] }],
    lumieres: [
      {
        type: "spot",
        pos: [0, 0, 2776],
        rot: [0, 0, 0],
        rayon: 48,
        couleur: "#ffe9cc",
        intensite: 11,
        eclat: 3.5,
        portee: 0,
        angle: 32,
        penombre: 0.35,
        nom: "Spot encastre",
        actif: true
      }
    ]
  },
  {
    id: "spot-pied",
    name: "Spot sur pied orientable",
    category: "Eclairage",
    price: 210,
    description: "Spot sur pied articulé, structure robuste en aluminium.",
    meshes: [
      meshAvecMatiere("Socle", cylindre(0, 0, 20, 180, 40, 32), "noir-mat"),
      meshAvecMatiere("Mat", cylindre(0, 0, 900, 22, 1720, 24), "alu-mat"),
      meshAvecMatiere("Tete", cylindre(0, 0, 1820, 70, 200, 24), "noir-mat"),
      meshAvecMatiere("Lentille", cylindre(0, 0, 1715, 58, 8, 24), "diffuseur", "#ffffff", 4.5)
    ],
    connectors: [{ type: "*", main: true, pos: [0, 0, 0] }],
    lumieres: [
      {
        type: "spot",
        pos: [0, 0, 1710],
        rot: [25, 0, 0],
        rayon: 58,
        couleur: "#ffffff",
        intensite: 18,
        eclat: 4.5,
        portee: 0,
        angle: 22,
        penombre: 0.2,
        nom: "Spot pied",
        actif: true
      }
    ]
  },
  {
    id: "plan-rect-1200",
    name: "Plan lumineux 1200 x 300",
    category: "Eclairage",
    price: 240,
    description: "Panneau lumineux rectangulaire pour plafond, éclairage homogène.",
    baseOffset: 0,
    meshes: [
      meshAvecMatiere("Cadre", boite(0, 0, 2830, 1240, 340, 60), "alu-mat"),
      meshAvecMatiere("Diffuseur", boite(0, 0, 2798, 1200, 300, 8), "diffuseur", "#f6f9ff", 3)
    ],
    connectors: [{ type: "*", main: true, pos: [0, 0, 0] }],
    lumieres: [
      {
        type: "rectangle",
        pos: [0, 0, 2793],
        rot: [0, 0, 0],
        taille: [1200, 300],
        couleur: "#f6f9ff",
        intensite: 16,
        eclat: 3,
        portee: 0,
        nom: "Plan 1200",
        actif: true
      }
    ]
  },
  {
    id: "plan-rect-600",
    name: "Plan lumineux 600 x 600",
    category: "Eclairage",
    price: 180,
    description: "Panneau lumineux carré pour plafond.",
    baseOffset: 0,
    meshes: [
      meshAvecMatiere("Cadre", boite(0, 0, 2830, 640, 640, 60), "alu-mat"),
      meshAvecMatiere("Diffuseur", boite(0, 0, 2798, 600, 600, 8), "diffuseur", "#f6f9ff", 3)
    ],
    connectors: [{ type: "*", main: true, pos: [0, 0, 0] }],
    lumieres: [
      {
        type: "rectangle",
        pos: [0, 0, 2793],
        rot: [0, 0, 0],
        taille: [600, 600],
        couleur: "#f6f9ff",
        intensite: 14,
        eclat: 3,
        portee: 0,
        nom: "Plan 600",
        actif: true
      }
    ]
  },
  {
    id: "plan-disque-400",
    name: "Plan lumineux circulaire 400",
    category: "Eclairage",
    price: 165,
    description: "Panneau lumineux circulaire pour plafond.",
    baseOffset: 0,
    meshes: [
      meshAvecMatiere("Cadre", cylindre(0, 0, 2825, 220, 50, 32), "alu-mat"),
      meshAvecMatiere("Diffuseur", cylindre(0, 0, 2798, 200, 8, 32), "diffuseur", "#f6f9ff", 3)
    ],
    connectors: [{ type: "*", main: true, pos: [0, 0, 0] }],
    lumieres: [
      {
        type: "disque",
        pos: [0, 0, 2793],
        rot: [0, 0, 0],
        rayon: 200,
        couleur: "#f6f9ff",
        intensite: 13,
        eclat: 3,
        portee: 0,
        angle: 62,
        penombre: 0.6,
        nom: "Disque 400",
        actif: true
      }
    ]
  },
  {
    id: "bandeau-led-2000",
    name: "Bandeau LED 2000",
    category: "Eclairage",
    price: 95,
    description: "Bandeau LED long pour éclairage linéaire.",
    baseOffset: 0,
    meshes: [
      meshAvecMatiere("Profil", boite(0, 0, 2790, 2000, 30, 22), "alu-mat"),
      meshAvecMatiere("Diffuseur", boite(0, 0, 2777, 1960, 22, 6), "diffuseur", "#eaf4ff", 4)
    ],
    connectors: [{ type: "*", main: true, pos: [0, 0, 0] }],
    lumieres: [
      {
        type: "bande",
        pos: [0, 0, 2773],
        rot: [0, 0, 0],
        taille: [1960, 22],
        couleur: "#eaf4ff",
        intensite: 9,
        eclat: 4,
        portee: 0,
        nom: "Bandeau LED",
        actif: true
      }
    ]
  }
]