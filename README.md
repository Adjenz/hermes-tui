# hermes-tui (`htui`)

Une vraie TUI moderne (React + Ink) pour remplacer l'interface terminal d'origine d'**Hermes Agent**, avec **contrôle à distance** natif via SSH et le daemon **Paseo**.

> Pilotez vos agents Hermes hébergés sur un serveur distant (ou en local) depuis un terminal fluide, multi-sessions, avec rendu Markdown soigné, blocs d'outils repliables et synchronisation en temps réel avec Paseo Desktop/Mobile.

---

## Pourquoi `hermes-tui` ?

- **Remplacer la TUI d'origine d'Hermes** par une interface épurée, inspirée d'`agy` / `opencode` : couleurs adaptatives au thème du terminal, tableaux alignés, blocs de code encadrés, listes propres sans rognage.
- **Remote control via le daemon Paseo :** vos agents tournent en continu sur votre serveur (`hermes` + `paseo`). Vous vous connectez en SSH depuis votre poste local sans perdre vos sessions en cours, et vous retrouvez le même état en temps réel partout.
- **Multi-sessions instantané :** onglets groupés par agent tout en haut de la fenêtre, cliquables à la souris, avec badges d'état :
  - `⠋` **orange** : en cours d'exécution (*working*)
  - `●` **vert** : tour terminé (*terminé*)
  - `○` **discret** : en attente (*idle*)
- **Appels d'outils propres (`Ctrl+O`) :** les appels consécutifs (`Bash`, `Edit`, `Read`, `Memory`, etc.) sont regroupés et repliés par défaut (`● Bash(…) (ctrl+o to expand)`), puis dépliables instantanément.
- **Expérience terminal soignée :**
  - Sélection souris avec **copie automatique au relâcher** (`wl-copy` + `OSC 52`).
  - Défilement à la **molette** ou `PgUp`/`PgDn`.
  - Envoi d'**images, PDF et fichiers** depuis le presse-papiers avec `Ctrl+V` (ou collage de chemin / URI `file://`).
  - Sélecteurs interactifs de **modèle/provider** (`Ctrl+L`), **thinking** (`Ctrl+T`), **mode d'approbation** (`/mode`) et **sessions** (`Ctrl+S` / `Ctrl+A`).
  - Autocomplétion des **commandes slash** (`/`) et archivage de session (`/archive`).

---

## Architecture

```
[ Poste local: hermes-tui (htui) ]
        │  NDJSON sur stdin/stdout (local ou SSH BatchMode)
        ▼
[ Serveur / Local: bridge/hermes-paseo-bridge.mjs ]
        │  @getpaseo/cli client (connectToDaemon)
        ▼
[ Daemon Paseo (~/.paseo) ] ──► [ Agents Hermes ACP ]
```

- `src/index.tsx` : Interface TUI React + Ink, gestion souris SGR, presse-papiers, onglets, modales.
- `src/markdown.tsx` : Rendu Markdown terminal (tableaux Unicode, blocs de code, titres, listes, liens, wrap ANSI).
- `src/types.ts` : Types TypeScript partagés.
- `bridge/hermes-paseo-bridge.mjs` : Pont NDJSON léger reliant la TUI au daemon Paseo local ou distant.

---

## Installation

### 1. Sur le poste client

```bash
git clone git@github.com:Adjenz/hermes-tui.git
cd hermes-tui
npm install
```

### 2. Sur le serveur hébergeant Paseo + Hermes (pour le remote control)

Copiez le pont sur la machine distante :

```bash
scp bridge/hermes-paseo-bridge.mjs user@votre-serveur:~/.local/bin/hermes-paseo-bridge.mjs
```

> Prérequis côté serveur : Node.js, `@getpaseo/cli` installé et le daemon Paseo démarré (`~/.paseo`).
> Côté client (Linux/Wayland) : `wl-clipboard` (`wl-paste` / `wl-copy`) pour les pièces jointes et la copie presse-papiers.

### 3. Configuration (variables d'environnement)

| Variable | Description | Défaut |
|---|---|---|
| `HERMES_TUI_HOST` | Cible SSH (`user@serveur`). Si vide, lance le pont en local. | *(vide = local)* |
| `HERMES_TUI_BRIDGE_PATH` | Chemin vers `hermes-paseo-bridge.mjs` sur la cible. | `~/.local/bin/hermes-paseo-bridge.mjs` (SSH) ou local |
| `PASEO_HOME` | Répertoire du daemon Paseo côté serveur. | `~/.paseo` |
| `PASEO_CLIENT_PATH` | Chemin explicite vers `@getpaseo/cli/dist/utils/client.js`. | Détection automatique |

Exemple de wrapper `~/.local/bin/htui` :

```sh
#!/bin/sh
export HERMES_TUI_HOST="user@mon-serveur"
exec /chemin/vers/hermes-tui/node_modules/.bin/tsx /chemin/vers/hermes-tui/src/index.tsx "$@"
```

---

## Utilisation & Raccourcis

```bash
htui            # Lance la TUI
htui mon-agent  # Cible directement une session par nom ou préfixe d'ID
htui --check    # Vérifie la connexion au pont Paseo et liste les stats
htui --help     # Affiche l'aide
```

| Raccourci | Action |
|---|---|
| Clic sur onglet (en haut) | Changer de session |
| Clic-glisser dans la discussion | Sélectionner + copier automatiquement au relâcher |
| Molette / `PgUp` / `PgDn` | Faire défiler l'historique |
| `Ctrl+O` | Déplier / replier les appels d'outils |
| `Ctrl+V` | Joindre une image / PDF / fichier du presse-papiers (ou coller du texte) |
| `Ctrl+S` / `Ctrl+A` / `/sessions` | Menu complet des sessions avec filtre |
| `Ctrl+N` / `Ctrl+P` | Session suivante / précédente |
| `Ctrl+L` / `/model` | Changer de modèle / provider |
| `Ctrl+T` / `/thinking` | Changer le niveau de thinking |
| `/mode` | Changer le mode d'approbation (`default`, `accept_edits`, `dont_ask`) |
| `/archive` | Archiver la session courante |
| `/` + `Tab` | Autocomplétion des commandes slash |
| `Esc` | Annuler le tour en cours ou fermer un menu |
| `Ctrl+C` | Quitter |
