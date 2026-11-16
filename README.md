# hermes-tui (`htui`)

A real, modern terminal UI (React + Ink) built to replace **Hermes Agent**'s default TUI — with native **remote control** over SSH powered by the **Paseo** daemon.

> Run your Hermes agents continuously on a remote server (or locally) via Paseo, and control every session from a fast, multi-tab terminal interface synchronized in real time with Paseo Desktop & Mobile.

---

## Why `hermes-tui`?

- **A real TUI replacement for Hermes:** clean, `agy` / `opencode`-inspired layout with theme-adaptive terminal colors, Unicode Markdown tables, framed code blocks, wrapped lists, and zero text clipping.
- **Native Remote Control via Paseo:** your agents stay alive on your server under the Paseo daemon (`~/.paseo`). Connect from any workstation over SSH without losing state or active turns, and switch seamlessly between `htui` and Paseo Desktop/Mobile.
- **Multi-session tab bar at the top:** sessions grouped by agent, clickable directly with the mouse, with live status badges:
  - `⠋` **orange**: running (*working*)
  - `●` **green**: turn finished (*terminé*)
  - `○` **dim**: waiting (*idle*)
- **Clean collapsible tool calls (`Ctrl+O`):** consecutive tool invocations (`Bash`, `Edit`, `Read`, `Memory`, etc.) are grouped and collapsed by default (`● Bash(…) (ctrl+o to expand)`), and expand/collapse instantly.
- **Modern terminal ergonomics:**
  - Mouse drag selection with **auto-copy on release** (`wl-copy` + `OSC 52`).
  - Mouse wheel and `PgUp`/`PgDn` scrolling.
  - Clipboard **image, PDF, and file attachments** via `Ctrl+V` (or pasted path / `file://` URI).
  - Interactive pickers for **models/providers** (`Ctrl+L`), **thinking level** (`Ctrl+T`), **approval mode** (`/mode`), and **sessions** (`Ctrl+S` / `Ctrl+A`).
  - Slash-command autocomplete (`/`) and session archiving (`/archive`).

---

## Architecture

```
[ Workstation: hermes-tui (htui) ]
        │  NDJSON over stdin/stdout (local or SSH BatchMode)
        ▼
[ Host: bridge/hermes-paseo-bridge.mjs ]
        │  @getpaseo/cli client (connectToDaemon)
        ▼
[ Paseo Daemon (~/.paseo) ] ──► [ Hermes ACP Agents ]
```

- `bin/htui.mjs` — CLI entrypoint (`htui` / `hermes-tui`).
- `src/index.tsx` — React + Ink TUI, SGR mouse & drag-selection handling, clipboard attachments, modals.
- `src/markdown.tsx` — Terminal Markdown renderer (tables, fenced code blocks, headings, lists, links, ANSI-aware wrapping).
- `src/types.ts` — Shared TypeScript types.
- `bridge/hermes-paseo-bridge.mjs` — Lightweight NDJSON bridge talking to the Paseo daemon.

---

## Installation

### Local (same machine as Paseo)

```bash
git clone git@github.com:Adjenz/hermes-tui.git
cd hermes-tui
npm install
npm link        # exposes `htui` and `hermes-tui` globally
htui --check
```

### Remote Control (SSH to a Paseo + Hermes server)

1. **On your workstation:**
   ```bash
   git clone git@github.com:Adjenz/hermes-tui.git
   cd hermes-tui
   npm install
   npm link
   ```
2. **On your server (where Paseo + Hermes run):**
   ```bash
   scp bridge/hermes-paseo-bridge.mjs user@your-server:~/.local/bin/hermes-paseo-bridge.mjs
   ```
3. **Configure the target host** (e.g. in `~/.bashrc` / `~/.zshrc` or a wrapper):
   ```bash
   export HERMES_TUI_HOST="user@your-server"
   htui --check
   ```

### Requirements

- **Client:** Node.js ≥ 18; on Linux/Wayland, `wl-clipboard` (`wl-paste` / `wl-copy`) for `Ctrl+V` file/image attachments and clipboard copy (`OSC 52` is also emitted as fallback).
- **Host running Paseo:** Node.js, `@getpaseo/cli` installed, and the Paseo daemon running (`~/.paseo`).

---

## Configuration

| Environment Variable | Description | Default |
|---|---|---|
| `HERMES_TUI_HOST` | SSH target (`user@host`). If unset/empty, runs the bridge locally. | *(empty = local)* |
| `HERMES_TUI_BRIDGE_PATH` | Path to `hermes-paseo-bridge.mjs` on the target host. | `~/.local/bin/hermes-paseo-bridge.mjs` (SSH) or local |
| `PASEO_HOME` | Paseo daemon home directory on the host. | `~/.paseo` |
| `PASEO_CLIENT_PATH` | Explicit path to `@getpaseo/cli/dist/utils/client.js`. | Auto-detected (common paths + `npm root -g`) |

---

## Usage & Shortcuts

```bash
htui              # Launch the TUI
htui my-agent     # Jump directly to a session by name or ID prefix
htui --check      # Test connection to the Paseo bridge
htui --help       # Show CLI help
```

| Shortcut | Action |
|---|---|
| Click a tab (top bar) | Switch to that session |
| Mouse drag in chat | Select text & auto-copy on release |
| Mouse wheel / `PgUp` / `PgDn` | Scroll conversation history |
| `Ctrl+O` | Expand / collapse tool call details |
| `Ctrl+V` | Attach clipboard image / PDF / file (or paste text) |
| `Ctrl+S` / `Ctrl+A` / `/sessions` | Open full session picker with search & badges |
| `Ctrl+N` / `Ctrl+P` | Next / previous session |
| `Ctrl+L` / `/model` | Switch LLM model / provider |
| `Ctrl+T` / `/thinking` | Change thinking level |
| `/mode` | Change approval mode (`default`, `accept_edits`, `dont_ask`) |
| `/archive` | Archive the current session |
| `/` + `Tab` | Slash-command autocomplete |
| `Esc` | Cancel active turn or close modal |
| `Ctrl+C` | Quit |

---

## Contributors

- **Adjenz** — Creator & maintainer
- **Gemini** — Architecture, UI/UX, and implementation
- **Claude** — Performance optimization, features, and polish
