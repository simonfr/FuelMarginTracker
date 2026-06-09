# ⛽ FuelMarginTracker

> Observatoire automatisé et interactif corrélant le prix du baril de brut **WTI (West Texas Intermediate)** avec les prix réels pratiqués dans les stations-services en France.

**FuelMarginTracker** est un mini-site statique (JAMstack) autonome et gratuit, hébergé sur GitHub Pages et alimenté par un pipeline CI/CD quotidien via GitHub Actions. Il permet de visualiser si les stations répercutent équitablement et rapidement les fluctuations mondiales des cours du pétrole.

---

## 🚀 Fonctionnalités

1. **Dashboard National (Macro)** :
   - Graphique temporel combinant le cours du WTI (converti en €/L) et les moyennes nationales des prix à la pompe (Gazole, E10, SP95, SP98).
   - Courbe dynamique de la **Marge Brute Théorique** (Prix à la pompe − Cours du WTI en €/L).
   - Filtres par type de carburant et échelle de temps (15 jours, 30 jours, 60 jours).

2. **Comparateur par Station (Micro)** :
   - Moteur de recherche par **Code Postal** ou **Ville** avec autocomplétion rapide.
   - Vue détaillée par station (Adresse, Enseigne).
   - Graphique de comparaison dédié superposant le prix de la station choisie avec la moyenne nationale et le WTI.
   - **Calculateur de Latence** : Un algorithme qui analyse le décalage moyen (en jours) de la station à répercuter les baisses de prix du WTI.

---

## 🛠️ Architecture & Flux de Données

Le projet fonctionne sans base de données active ni serveur d'application (*serverless*) :

```
[Cours WTI (Yahoo Finance)] ----> [ GitHub Actions (Script Python) ] <---- [ Prix Carburants (France OpenData) ]
                                              |
                                              v
                               [ Calculs & Génération JSON ]
                                              |
                                              v
                               [ Déploiement GitHub Pages ] -------> [ Client Web (Chart.js / SPA) ]
```

- **Mise à jour quotidienne** : Un workflow GitHub Actions s'exécute chaque jour à **05:00 UTC**, télécharge le flux des prix de l'État et les cours financiers, puis recalcule les moyennes et met à jour des fichiers JSON légers dans `/data`.
- **Ressources légères** : Les données des stations sont partitionnées par code postal (ex: `data/stations/35000.json`) pour que le navigateur ne charge que les données requises lors d'une recherche locale.
- **Historique glissant** : Un historique glissant de **30 jours** pour les stations (et 60 jours au niveau national) est conservé pour éviter le gonflement inutile du dépôt Git.

---

## ⚙️ Déploiement sur GitHub Pages

Pour rendre le site accessible en ligne gratuitement :

1. Rendez-vous sur ton dépôt GitHub : [github.com/simonfr/FuelMarginTracker](https://github.com/simonfr/FuelMarginTracker).
2. Allez dans l'onglet **Settings** (Paramètres) > **Pages** (dans la barre latérale).
3. Dans la section **Build and deployment** :
   - **Source** : Laissez sur *Deploy from a branch*.
   - **Branch** : Sélectionnez **`main`** et le dossier **`/ (root)`**.
   - Cliquez sur **Save**.
4. Patientez 1 à 2 minutes. Votre site sera disponible à l'adresse suivante :
   `https://simonfr.github.io/FuelMarginTracker/`

---

## 💻 Développement Local

### Prérequis
- Python 3.10+ (pour exécuter ou tester les scripts de données).
- Un navigateur moderne.

### Lancer le site en local
Puisque le site charge des fichiers JSON locaux via l'API `fetch()`, le navigateur requiert un serveur local pour des raisons de sécurité (CORS) :
```bash
# Lancez un serveur Web ultra-léger avec Python à la racine du projet
python3 -m http.server 8000
```
Ouvrez ensuite votre navigateur sur `http://localhost:8000`.

### Mettre à jour les données manuellement
Pour lancer le script de mise à jour quotidien localement :
```bash
python3 scripts/update_data.py
```

---

## 📊 Sources des Données
- **Prix des carburants en France** : Flux instantané en Open Data de la Direction Générale de l'Énergie et du Climat ([data.gouv.fr](https://www.data.gouv.fr/fr/datasets/prix-des-carburants-en-france-flux-instantane-v2/)).
- **Cours du Brut WTI & Taux EUR/USD** : Données de marché fournies gratuitement par [Yahoo Finance](https://finance.yahoo.com/).
- **Enseignes des stations** : Enrichissement communautaire par la base publique de l'intégration Home Assistant de [Aohzan/hass-prixcarburant](https://github.com/Aohzan/hass-prixcarburant).

---
*Développé sous licence libre Open Data (Etalab).*
