import type { SlashCommand } from "./types.js";

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function commandRow(c: SlashCommand): string {
  const usage = `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`;
  return `| \`${cell(usage)}\` | ${cell(c.description)} |`;
}

/** Markdown for `/help`: every slash command currently available (local + Hermes). */
export function buildHelpMarkdown(commands: ReadonlyArray<SlashCommand>): string {
  const local = commands.filter((c) => c.isLocal);
  const remote = commands.filter((c) => !c.isLocal);
  const lines: string[] = ["## Aide — commandes disponibles", ""];

  lines.push("### Commandes hermes-tui", "", "| Commande | Description |", "| --- | --- |");
  lines.push(...local.map(commandRow), "");

  if (remote.length > 0) {
    lines.push(
      "### Commandes Hermes (envoyées à l'agent)",
      "",
      "| Commande | Description |",
      "| --- | --- |",
      ...remote.map(commandRow),
      ""
    );
  }

  lines.push("Tape `/shortcuts` pour la liste des raccourcis clavier et souris.");
  return lines.join("\n");
}

/** Markdown for `/shortcuts`: every keyboard / mouse shortcut. Keep in sync with useInput in index.tsx. */
export const SHORTCUTS_MARKDOWN = `## Raccourcis clavier & souris

### Sessions & navigation

| Raccourci | Action |
| --- | --- |
| Clic sur un onglet | Basculer sur cette session |
| \`Ctrl+S\` / \`Ctrl+A\` | Menu des sessions (filtrable) |
| \`Ctrl+N\` / \`Ctrl+P\` | Session suivante / précédente (ordre des onglets) |
| Molette / \`PgUp\` / \`PgDn\` | Défiler la conversation (position verrouillée pendant le stream) |
| \`Ctrl+F\` | Rechercher dans la conversation (\`Entrée\` / \`↑\` \`↓\` pour naviguer, \`Esc\` pour fermer) |

### Agent

| Raccourci | Action |
| --- | --- |
| \`Esc\` | Annuler le tour en cours, vider le prompt ou fermer un menu |
| \`Ctrl+L\` | Choisir le modèle |
| \`Ctrl+T\` | Choisir le niveau de thinking |
| \`Ctrl+O\` | Déplier / replier les appels d'outils |
| \`Ctrl+C\` | Quitter |

### Prompt

| Raccourci | Action |
| --- | --- |
| \`Entrée\` | Envoyer |
| \`Shift+Entrée\` / \`Alt+Entrée\` / \`Ctrl+J\` | Nouvelle ligne |
| \`←\` \`→\` | Déplacer le curseur |
| \`Ctrl+←\` \`Ctrl+→\` (ou \`Alt\`) | Aller au mot précédent / suivant |
| \`Home\` / \`End\` / \`Ctrl+E\` | Début / fin de ligne (2e appui : début / fin du texte) |
| \`↑\` \`↓\` | Historique des prompts (ou ligne précédente / suivante en multi-lignes) |
| \`Backspace\` / \`Suppr\` | Effacer avant / après le curseur |
| \`Ctrl+Backspace\` / \`Alt+Backspace\` / \`Ctrl+W\` | Effacer le mot précédent |
| \`Ctrl+Suppr\` / \`Alt+D\` | Effacer le mot suivant |
| \`Ctrl+U\` / \`Ctrl+K\` | Effacer jusqu'au début / à la fin de la ligne |
| \`Tab\` | Compléter la commande ou l'argument slash sélectionné |
| \`/\` puis \`↑\` \`↓\` | Menu des commandes slash |
| \`Ctrl+V\` | Coller fichier, image ou texte du presse-papiers |

### Copie

| Raccourci | Action |
| --- | --- |
| Clic sur une ligne de code | Copier cette ligne |
| Clic sur l'en-tête d'un bloc de code | Copier le bloc entier |
| Clic sur du \`code inline\` | Copier ce segment |
| Glisser avec la souris | Sélectionner et copier au relâchement |
| \`Ctrl+Y\` | Copier le dernier bloc de code (sinon la dernière réponse) |

Tape \`/help\` pour la liste des commandes slash.`;
