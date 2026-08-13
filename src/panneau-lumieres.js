export const CSS_PANNEAU_LUMIERES = `
.pl {
  background: var(--panel);
  color: var(--txt);
  border-radius: var(--radius);
  padding: 8px;
  font-size: 12px;
  line-height: 1.4;
  box-sizing: border-box;
}
.pl-tete {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: bold;
  border-bottom: 1px solid var(--line);
  padding-bottom: 4px;
  margin-bottom: 6px;
}
.pl-compte {
  background: var(--panel-2);
  border-radius: 10px;
  padding: 0 6px;
  font-size: 11px;
}
.pl-ajout {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}
.pl-add {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--txt);
  padding: 3px 8px;
  font-size: 11px;
  cursor: pointer;
}
.pl-add:hover {
  background: var(--accent);
  color: var(--txt);
}
.pl-liste {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 190px;
  overflow-y: auto;
  border: 1px solid var(--line);
  border-radius: var(--radius);
  margin-bottom: 6px;
}
.pl-item {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  cursor: pointer;
  border-bottom: 1px solid var(--line);
}
.pl-item:last-child {
  border-bottom: none;
}
.pl-item.on {
  background: var(--accent);
  color: var(--txt);
}
.pl-item.on .pl-nom,
.pl-item.on .pl-type {
  color: var(--txt);
}
.pl-item button {
  background: none;
  border: none;
  cursor: pointer;
  padding: 2px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: inherit;
}
.pl-item button:hover {
  opacity: 0.7;
}
.pl-nom {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.pl-type {
  font-size: 10px;
  color: var(--txt-dim);
  text-transform: capitalize;
}
.pl-vide {
  padding: 8px;
  text-align: center;
  color: var(--txt-dim);
  font-style: italic;
}
.pl-form {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.pl-champ {
  display: grid;
  grid-template-columns: 120px 1fr auto;
  align-items: center;
  gap: 6px;
}
.pl-champ label {
  font-size: 11px;
  color: var(--txt-dim);
  text-align: right;
}
.pl-champ input[type="range"] {
  width: 100%;
}
.pl-champ input[type="number"],
.pl-champ input[type="text"],
.pl-champ input[type="color"] {
  background: var(--panel-2);
  border: 1px solid var(--line);
  border-radius: var(--radius);
  color: var(--txt);
  padding: 2px 4px;
  font-size: 11px;
}
.pl-champ input[type="color"] {
  width: 40px;
  height: 24px;
  padding: 0;
  border: none;
  background: var(--panel-2);
}
.pl-valeur {
  font-size: 10px;
  color: var(--txt-dim);
  min-width: 50px;
  text-align: right;
}
.pl-bascule {
  display: flex;
  gap: 8px;
}
.pl-bascule label {
  display: flex;
  align-items: center;
  gap: 2px;
  font-size: 11px;
  cursor: pointer;
  color: var(--txt-dim);
}
.pl-bascule input[type="radio"] {
  margin: 0;
}
.pl-pastille {
  display: inline-block;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 1px solid var(--line);
  margin: 0 4px;
}
.pl-temp-ligne {
  display: flex;
  align-items: center;
  gap: 4px;
}
`;

export function creerPanneauLumieres(hote, api) {
  // Approximation de Tanner Helland pour la couleur du corps noir.
  function couleurDepuisKelvin(k) {
    const t = k / 100;
    let r, g, b;

    // Rouge
    if (t <= 66) {
      r = 255;
    } else {
      r = t - 60;
      r = 329.698727446 * Math.pow(r, -0.1332047592);
      if (r < 0) r = 0;
      if (r > 255) r = 255;
    }

    // Vert
    if (t <= 66) {
      g = t;
      g = 99.4708025861 * Math.log(g) - 161.1195681661;
      if (g < 0) g = 0;
      if (g > 255) g = 255;
    } else {
      g = t - 60;
      g = 288.1221695283 * Math.pow(g, -0.0755148492);
      if (g < 0) g = 0;
      if (g > 255) g = 255;
    }

    // Bleu
    if (t >= 66) {
      b = 255;
    } else if (t <= 19) {
      b = 0;
    } else {
      b = t - 10;
      b = 138.5177312231 * Math.log(b) - 305.0447927307;
      if (b < 0) b = 0;
      if (b > 255) b = 255;
    }

    return `#${Math.round(r).toString(16).padStart(2, '0')}${Math.round(g).toString(16).padStart(2, '0')}${Math.round(b).toString(16).padStart(2, '0')}`;
  }

  function motTemperature(k) {
    if (k <= 2200) return "flamme";
    if (k <= 3000) return "incandescent";
    if (k <= 4000) return "blanc chaud";
    if (k <= 5000) return "blanc neutre";
    if (k <= 6500) return "lumiere du jour";
    return "ciel couvert";
  }

  function libelleType(type) {
    switch(type) {
      case 'point': return 'Ponctuelle';
      case 'spot': return 'Projecteur';
      case 'bande': return 'Bandeau';
      case 'rectangle': return 'Rectangle';
      case 'disque': return 'Disque';
      default: return type;
    }
  }

  function creerIcone(chemins, title) {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '16');
    svg.setAttribute('height', '16');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    if (title) {
      const titleEl = document.createElementNS('http://www.w3.org/2000/svg', 'title');
      titleEl.textContent = title;
      svg.appendChild(titleEl);
    }
    chemins.forEach(chemin => {
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      path.setAttribute('d', chemin);
      svg.appendChild(path);
    });
    return svg;
  }

  const cheminOeilOuvert = "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z";
  const cheminOeilFerme1 = "M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z";
  const cheminOeilFerme2 = "M4 4 L20 20";
  const cheminCadrer = "M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm0 6c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm0-12C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z";
  const cheminSupprimer = "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z";

  function iconeOeil(ouvert) {
    if (ouvert) {
      return creerIcone([cheminOeilOuvert], 'Allumer ou eteindre');
    } else {
      return creerIcone([cheminOeilFerme1, cheminOeilFerme2], 'Allumer ou eteindre');
    }
  }

  function iconeCadrer() {
    return creerIcone([cheminCadrer], 'Centrer la vue');
  }

  function iconeSupprimer() {
    return creerIcone([cheminSupprimer], 'Supprimer');
  }

  // Construction du DOM racine
  const racine = document.createElement('div');
  racine.className = 'pl';

  // En-tête
  const entete = document.createElement('header');
  entete.className = 'pl-tete';
  const titre = document.createElement('strong');
  titre.textContent = 'Lumieres';
  const compte = document.createElement('span');
  compte.className = 'pl-compte';
  entete.appendChild(titre);
  entete.appendChild(compte);
  racine.appendChild(entete);

  // Zone d'ajout
  const ajout = document.createElement('div');
  ajout.className = 'pl-ajout';
  const types = ['point', 'spot', 'bande', 'rectangle', 'disque'];
  const libelles = ['Ponctuelle', 'Spot', 'Bande', 'Rectangle', 'Disque'];
  types.forEach((type, index) => {
    const bouton = document.createElement('button');
    bouton.className = 'pl-add';
    bouton.dataset.type = type;
    bouton.textContent = libelles[index];
    bouton.addEventListener('click', () => {
      const uid = api.ajouter(type);
      if (uid) {
        api.selectionner(uid);
      }
      rafraichir();
    });
    ajout.appendChild(bouton);
  });
  racine.appendChild(ajout);

  // Liste des lumières
  const liste = document.createElement('ul');
  liste.className = 'pl-liste';
  racine.appendChild(liste);

  // Formulaire
  const formulaire = document.createElement('div');
  formulaire.className = 'pl-form';
  racine.appendChild(formulaire);

  hote.appendChild(racine);

  // Fonctions de création de champs
  function creerLigne(label, controle) {
    const ligne = document.createElement('div');
    ligne.className = 'pl-champ';
    const lab = document.createElement('label');
    lab.textContent = label;
    ligne.appendChild(lab);
    ligne.appendChild(controle);
    const val = document.createElement('span');
    val.className = 'pl-valeur';
    ligne.appendChild(val);
    formulaire.appendChild(ligne);
    return { ligne, val };
  }

  function creerChampTexte(label, valeur, onchange) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = valeur;
    input.addEventListener('change', () => onchange(input.value));
    return creerLigne(label, input);
  }

  function creerCase(label, coche, onchange) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = coche;
    input.addEventListener('change', () => onchange(input.checked));
    return creerLigne(label, input);
  }

  function creerCurseur(label, valeur, min, max, step, unite, oninput) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = valeur;
    const ligne = creerLigne(label, input);
    const val = ligne.val;
    const mettreAJour = () => {
      const v = parseFloat(input.value);
      val.textContent = unite ? `${v} ${unite}` : `${v}`;
    };
    input.addEventListener('input', () => {
      mettreAJour();
      oninput(parseFloat(input.value));
    });
    mettreAJour();
    return ligne;
  }

  function creerCurseurAvecFormat(label, valeur, min, max, step, formateur, oninput) {
    const input = document.createElement('input');
    input.type = 'range';
    input.min = min;
    input.max = max;
    input.step = step;
    input.value = valeur;
    const ligne = creerLigne(label, input);
    const val = ligne.val;
    const mettreAJour = () => {
      val.textContent = formateur(parseFloat(input.value));
    };
    input.addEventListener('input', () => {
      mettreAJour();
      oninput(parseFloat(input.value));
    });
    mettreAJour();
    return ligne;
  }

  function creerNombre(label, valeur, min, max, step, onchange) {
    const input = document.createElement('input');
    input.type = 'number';
    if (min !== undefined) input.min = min;
    if (max !== undefined) input.max = max;
    input.step = step;
    input.value = valeur;
    const ligne = creerLigne(label, input);
    const val = ligne.val;
    const mettreAJour = () => {
      val.textContent = input.value === '' ? '' : `${input.value}`;
    };
    input.addEventListener('change', () => {
      mettreAJour();
      if (input.value !== '') {
        onchange(Number(input.value));
      }
    });
    mettreAJour();
    return ligne;
  }

  function creerChampIes(label, valeur, onchange) {
    const input = document.createElement('input');
    input.type = 'text';
    input.value = valeur || '';
    input.placeholder = 'Chemin IES (optionnel)';
    input.addEventListener('change', () => onchange(input.value.trim() || null));
    return creerLigne(label, input);
  }

  function creerSectionCouleur(reglages, uid, api) {
    let temperatureActuelle = reglages.temperature;
    let teinteActuelle = reglages.teinte;
    let parTemperatureActuel = reglages.parTemperature;

    const conteneur = document.createElement('div');
    conteneur.className = 'pl-champ pl-couleur';

    const label = document.createElement('label');
    label.textContent = 'Couleur';
    conteneur.appendChild(label);

    // Bascule température / teinte
    const bascule = document.createElement('div');
    bascule.className = 'pl-bascule';
    const optionTemp = document.createElement('label');
    const radioTemp = document.createElement('input');
    radioTemp.type = 'radio';
    radioTemp.name = 'parTemperature';
    radioTemp.value = 'true';
    radioTemp.checked = parTemperatureActuel === true;
    optionTemp.appendChild(radioTemp);
    optionTemp.appendChild(document.createTextNode(' Température'));
    const optionTeinte = document.createElement('label');
    const radioTeinte = document.createElement('input');
    radioTeinte.type = 'radio';
    radioTeinte.name = 'parTemperature';
    radioTeinte.value = 'false';
    radioTeinte.checked = parTemperatureActuel === false;
    optionTeinte.appendChild(radioTeinte);
    optionTeinte.appendChild(document.createTextNode(' Teinte'));
    bascule.appendChild(optionTemp);
    bascule.appendChild(optionTeinte);
    conteneur.appendChild(bascule);

    const zoneCouleur = document.createElement('div');
    zoneCouleur.className = 'pl-couleur-zone';
    conteneur.appendChild(zoneCouleur);

    function rendreZoneCouleur(parTemperature) {
      zoneCouleur.innerHTML = '';
      if (parTemperature) {
        const ligneTemp = document.createElement('div');
        ligneTemp.className = 'pl-temp-ligne';
        const inputTemp = document.createElement('input');
        inputTemp.type = 'range';
        inputTemp.min = 1700;
        inputTemp.max = 12000;
        inputTemp.step = 50;
        inputTemp.value = temperatureActuelle;
        const pastille = document.createElement('span');
        pastille.className = 'pl-pastille';
        const infoTemp = document.createElement('span');
        infoTemp.className = 'pl-valeur';
        const mettreAJourTemp = () => {
          const k = parseFloat(inputTemp.value);
          pastille.style.backgroundColor = couleurDepuisKelvin(k);
          infoTemp.textContent = `${k} K - ${motTemperature(k)}`;
        };
        inputTemp.addEventListener('input', () => {
          temperatureActuelle = parseFloat(inputTemp.value);
          mettreAJourTemp();
          api.modifier(uid, { temperature: temperatureActuelle });
        });
        ligneTemp.appendChild(inputTemp);
        ligneTemp.appendChild(pastille);
        ligneTemp.appendChild(infoTemp);
        mettreAJourTemp();
        zoneCouleur.appendChild(ligneTemp);
      } else {
        const inputCouleur = document.createElement('input');
        inputCouleur.type = 'color';
        inputCouleur.value = teinteActuelle;
        inputCouleur.addEventListener('change', () => {
          teinteActuelle = inputCouleur.value;
          api.modifier(uid, { teinte: teinteActuelle });
        });
        zoneCouleur.appendChild(inputCouleur);
      }
    }

    const gererChangement = () => {
      if (radioTemp.checked) parTemperatureActuel = true;
      else if (radioTeinte.checked) parTemperatureActuel = false;
      api.modifier(uid, { parTemperature: parTemperatureActuel });
      rendreZoneCouleur(parTemperatureActuel);
    };
    radioTemp.addEventListener('change', gererChangement);
    radioTeinte.addEventListener('change', gererChangement);

    rendreZoneCouleur(parTemperatureActuel);
    return conteneur;
  }

  // Construction du formulaire pour une lumière sélectionnée
  function construireFormulaire(uid, type, api) {
    const reglages = api.lire(uid);
    if (!reglages) return;

    formulaire.innerHTML = '';

    // Nom
    creerChampTexte('Nom', reglages.nom, (v) => api.modifier(uid, { nom: v }));

    // Actif
    creerCase('Active', reglages.actif, (v) => api.modifier(uid, { actif: v }));

    // Intensité
    creerCurseur('Intensité', reglages.intensite, 0, 200000, 10, 'cd', (v) => api.modifier(uid, { intensite: v }));

    // Couleur (température ou teinte)
    formulaire.appendChild(creerSectionCouleur(reglages, uid, api));

    // Rayon source
    creerCurseur('Rayon source', reglages.rayonSource, 0, 1000, 5, 'mm', (v) => api.modifier(uid, { rayonSource: v }));

    // Portée (0 = illimité)
    creerCurseurAvecFormat('Portée', reglages.portee, 0, 50000, 100, (v) => v === 0 ? 'Illimité' : `${v} mm`, (v) => api.modifier(uid, { portee: v }));

    // Reflets visibles
    creerCase('Reflets visibles', reglages.refletsVisibles, (v) => api.modifier(uid, { refletsVisibles: v }));

    // Ombres
    creerCase('Ombres', reglages.ombres, (v) => api.modifier(uid, { ombres: v }));

    // Champs spécifiques selon le type
    if (type === 'spot') {
      creerCurseur('Angle cône', reglages.angleCone, 1, 90, 1, '°', (v) => api.modifier(uid, { angleCone: v }));
      creerCurseur('Pénombre', reglages.penombre, 0, 1, 0.05, '', (v) => api.modifier(uid, { penombre: v }));
      creerChampIes('IES', reglages.ies, (v) => api.modifier(uid, { ies: v }));
      creerNombre('Rayon', reglages.rayon, 0, undefined, 1, (v) => api.modifier(uid, { rayon: v }));
    } else if (type === 'disque') {
      creerCurseur('Pénombre', reglages.penombre, 0, 1, 0.05, '', (v) => api.modifier(uid, { penombre: v }));
      creerNombre('Rayon', reglages.rayon, 0, undefined, 1, (v) => api.modifier(uid, { rayon: v }));
    } else if (type === 'bande' || type === 'rectangle') {
      creerCurseur('Volets', reglages.volets, 0, 90, 1, '°', (v) => api.modifier(uid, { volets: v }));
      creerCurseur('Volets longueur', reglages.voletsLongueur, 0, 100, 1, '', (v) => api.modifier(uid, { voletsLongueur: v }));
      let taille = reglages.taille ? [...reglages.taille] : [0, 0];
      creerNombre('Largeur (mm)', taille[0], 0, undefined, 1, (v) => {
        taille[0] = v;
        api.modifier(uid, { taille: taille });
      });
      creerNombre('Hauteur (mm)', taille[1], 0, undefined, 1, (v) => {
        taille[1] = v;
        api.modifier(uid, { taille: taille });
      });
    }
  }

  // Rafraîchit la liste et le formulaire
  function rafraichir() {
    liste.innerHTML = '';
    formulaire.innerHTML = '';

    const lumieres = api.lister();
    const selectionUid = api.selection();

    compte.textContent = lumieres ? lumieres.length : 0;

    if (!lumieres || lumieres.length === 0) {
      const itemVide = document.createElement('li');
      itemVide.className = 'pl-vide';
      itemVide.textContent = 'Aucune lumiere dans la scene.';
      liste.appendChild(itemVide);
      return;
    }

    lumieres.forEach(lumiere => {
      const item = document.createElement('li');
      item.className = 'pl-item';
      if (lumiere.uid === selectionUid) item.classList.add('on');
      item.dataset.uid = lumiere.uid;

      // Bouton œil
      const oeil = document.createElement('button');
      oeil.className = 'pl-oeil';
      oeil.title = 'Allumer ou eteindre';
      oeil.appendChild(iconeOeil(lumiere.actif));
      oeil.addEventListener('click', (e) => {
        e.stopPropagation();
        api.modifier(lumiere.uid, { actif: !lumiere.actif });
        rafraichir();
      });
      item.appendChild(oeil);

      // Nom
      const nom = document.createElement('span');
      nom.className = 'pl-nom';
      nom.textContent = lumiere.nom; // textContent pour éviter toute injection
      item.appendChild(nom);

      // Type
      const typeSpan = document.createElement('span');
      typeSpan.className = 'pl-type';
      typeSpan.textContent = libelleType(lumiere.type);
      item.appendChild(typeSpan);

      // Bouton cadrer
      const cadrer = document.createElement('button');
      cadrer.className = 'pl-cadrer';
      cadrer.title = 'Centrer la vue';
      cadrer.appendChild(iconeCadrer());
      cadrer.addEventListener('click', (e) => {
        e.stopPropagation();
        api.cadrer(lumiere.uid);
      });
      item.appendChild(cadrer);

      // Bouton supprimer
      const suppr = document.createElement('button');
      suppr.className = 'pl-suppr';
      suppr.title = 'Supprimer';
      suppr.appendChild(iconeSupprimer());
      suppr.addEventListener('click', (e) => {
        e.stopPropagation();
        api.supprimer(lumiere.uid);
        rafraichir();
      });
      item.appendChild(suppr);

      // Sélection au clic sur l'item
      item.addEventListener('click', () => {
        api.selectionner(lumiere.uid);
        rafraichir();
      });

      liste.appendChild(item);
    });

    // Construction du formulaire si une lumière est sélectionnée
    if (selectionUid) {
      const lumiereSelectionnee = lumieres.find(l => l.uid === selectionUid);
      if (lumiereSelectionnee) {
        construireFormulaire(selectionUid, lumiereSelectionnee.type, api);
      }
    }
  }

  // Initialisation
  rafraichir();

  return { rafraichir };
}