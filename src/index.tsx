import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdin, useStdout } from "ink";
import { render } from "ink";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { spawn as spawnProc } from "node:child_process";
import stringWidth from "string-width";
import type {
  AgentUsage,
  HermesAgent,
  HermesModel,
  PermissionPrompt,
  SlashCommand,
  StaticEntry,
  TimelineItem,
  WorkStep,
} from "./types.js";
import {
  chalk,
  CODE_CONTINUATION_MARKER,
  renderMarkdownToLines,
  stripAnsi,
  useTerminalSize,
  visibleLength,
  wrapAnsiText,
} from "./markdown.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCAL_BRIDGE_PATH = path.resolve(__dirname, "../bridge/hermes-paseo-bridge.mjs");
const REMOTE_HOST = (process.env.HERMES_TUI_HOST || "").trim();
const REMOTE_BRIDGE_PATH = (process.env.HERMES_TUI_BRIDGE_PATH || "~/.local/bin/hermes-paseo-bridge.mjs").trim();
const BRIDGE_CMD = REMOTE_HOST
  ? ["ssh", "-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=2", REMOTE_HOST, "node", REMOTE_BRIDGE_PATH]
  : ["node", process.env.HERMES_TUI_BRIDGE_PATH || LOCAL_BRIDGE_PATH];
const TARGET_LABEL = REMOTE_HOST || "local";
interface PendingAttachment {
  name: string;
  mimeType: string;
  data: string; // base64
  size: number;
}

const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024;
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".zip": "application/zip",
  ".doc": "application/msword",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

function formatSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} Mo`;
  return `${Math.max(1, Math.round(bytes / 1024))} Ko`;
}

function attachmentFromFile(filePath: string): PendingAttachment | null {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return null;
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`${path.basename(filePath)} dépasse 40 Mo`);
    const ext = path.extname(filePath).toLowerCase();
    return {
      name: path.basename(filePath),
      mimeType: MIME_BY_EXT[ext] ?? "application/octet-stream",
      data: fs.readFileSync(filePath).toString("base64"),
      size: stat.size,
    };
  } catch (err) {
    if (err instanceof Error && err.message.includes("40 Mo")) throw err;
    return null;
  }
}

function normalizePastedPath(text: string): string | null {
  const t = text.trim().replace(/^['"]|['"]$/g, "");
  if (!t || t.includes("\n")) return null;
  if (t.startsWith("file://")) {
    try {
      return fileURLToPath(t);
    } catch {
      return null;
    }
  }
  if (t.startsWith("/") || t.startsWith("~/")) {
    return t.startsWith("~/") ? path.join(process.env.HOME ?? "", t.slice(2)) : t;
  }
  return null;
}

function runWlPaste(args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    execFile("wl-paste", args, { encoding: "buffer", maxBuffer: MAX_ATTACHMENT_BYTES + 1024 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout as Buffer);
    });
  });
}

/** Reads the Wayland clipboard: copied files (uri-list), images, or plain text. */
async function readClipboard(): Promise<{ attachments: PendingAttachment[]; text: string }> {
  let types: string[] = [];
  try {
    types = (await runWlPaste(["--list-types"])).toString("utf8").split("\n").map((t) => t.trim()).filter(Boolean);
  } catch {
    throw new Error("Presse-papiers illisible (wl-paste indisponible ?)");
  }

  if (types.includes("text/uri-list")) {
    const raw = (await runWlPaste(["--no-newline", "--type", "text/uri-list"])).toString("utf8");
    const files = raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => normalizePastedPath(l))
      .filter((f): f is string => Boolean(f));
    const attachments = files.map((f) => attachmentFromFile(f)).filter((a): a is PendingAttachment => Boolean(a));
    if (attachments.length > 0) return { attachments, text: "" };
  }

  const imageType = types.find((t) => t === "image/png") ?? types.find((t) => t.startsWith("image/"));
  if (imageType) {
    const buf = await runWlPaste(["--no-newline", "--type", imageType]);
    if (buf.length > MAX_ATTACHMENT_BYTES) throw new Error("Image du presse-papiers > 40 Mo");
    const ext = imageType.split("/")[1]?.replace("jpeg", "jpg") || "png";
    const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    return {
      attachments: [{ name: `presse-papiers-${stamp}.${ext}`, mimeType: imageType, data: buf.toString("base64"), size: buf.length }],
      text: "",
    };
  }

  if (types.some((t) => t.startsWith("text/"))) {
    const text = (await runWlPaste(["--no-newline"])).toString("utf8");
    const p = normalizePastedPath(text);
    const att = p ? attachmentFromFile(p) : null;
    if (att) return { attachments: [att], text: "" };
    return { attachments: [], text };
  }
  return { attachments: [], text: "" };
}

function sliceCols(plain: string, from: number, toExclusive: number): string {
  let col = 0;
  let out = "";
  for (const ch of Array.from(plain)) {
    const w = stringWidth(ch) || 0;
    if (col >= from && col < toExclusive) out += ch;
    col += w;
    if (col >= toExclusive) break;
  }
  return out;
}

function copyToClipboard(text: string): void {
  try {
    const proc = spawnProc("wl-copy", [], { stdio: ["pipe", "ignore", "ignore"] });
    proc.on("error", () => {});
    proc.stdin.on("error", () => {});
    proc.stdin.end(text);
  } catch {
    // ignore, OSC 52 below is the fallback
  }
  // OSC 52 as well (works over SSH / when wl-copy is unavailable)
  process.stdout.write(`\x1b]52;c;${Buffer.from(text, "utf8").toString("base64")}\x07`);
}

interface Selection {
  r1: number;
  c1: number;
  r2: number;
  c2: number;
}

interface PersistedState {
  lastActiveAgentId?: string | null;
  promptHistory?: string[];
  showDetails?: boolean;
}

const STATE_CACHE_DIR = path.join(
  process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"),
  "hermes-tui"
);
const STATE_CACHE_FILE = path.join(STATE_CACHE_DIR, "state.json");
let currentPersistedState: PersistedState = {};

function loadPersistedState(): PersistedState {
  try {
    if (fs.existsSync(STATE_CACHE_FILE)) {
      const raw = JSON.parse(fs.readFileSync(STATE_CACHE_FILE, "utf8"));
      if (raw && typeof raw === "object") {
        currentPersistedState = {
          lastActiveAgentId: typeof raw.lastActiveAgentId === "string" ? raw.lastActiveAgentId : null,
          promptHistory: Array.isArray(raw.promptHistory)
            ? raw.promptHistory.filter((x: unknown): x is string => typeof x === "string").slice(0, 50)
            : [],
          showDetails: typeof raw.showDetails === "boolean" ? raw.showDetails : false,
        };
      }
    }
  } catch {
    // ignore unreadable or corrupted cache file
  }
  return currentPersistedState;
}

function savePersistedState(patch: Partial<PersistedState>): void {
  currentPersistedState = { ...currentPersistedState, ...patch };
  try {
    fs.mkdirSync(STATE_CACHE_DIR, { recursive: true });
    fs.writeFileSync(STATE_CACHE_FILE, JSON.stringify(currentPersistedState, null, 2), "utf8");
  } catch {
    // ignore write failures
  }
}

function formatTimeHHMM(iso?: string): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

const PASTED_TOKEN_RE = /\[Pasted #\d+[^\]]*\]/g;
function findPastedTokenRanges(text: string): Array<{ start: number; end: number; token: string }> {
  const out: Array<{ start: number; end: number; token: string }> = [];
  PASTED_TOKEN_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PASTED_TOKEN_RE.exec(text)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length, token: m[0] });
  }
  return out;
}

function moveCursorWordLeft(text: string, pos: number): number {
  if (pos <= 0) return 0;
  const tokens = findPastedTokenRanges(text);
  const directHit = tokens.find((r) => pos > r.start && pos <= r.end);
  if (directHit) return directHit.start;

  let i = pos;
  while (i > 0 && /\s/.test(text[i - 1])) i--;
  if (i <= 0) return 0;

  const afterSpaceHit = tokens.find((r) => i > r.start && i <= r.end);
  if (afterSpaceHit) return afterSpaceHit.start;

  if (/[\p{L}\p{N}_]/u.test(text[i - 1])) {
    while (i > 0 && /[\p{L}\p{N}_]/u.test(text[i - 1])) {
      const tok = tokens.find((r) => i - 1 >= r.start && i - 1 < r.end);
      if (tok) return tok.start;
      i--;
    }
  } else {
    while (i > 0 && !/\s/.test(text[i - 1]) && !/[\p{L}\p{N}_]/u.test(text[i - 1])) {
      const tok = tokens.find((r) => i - 1 >= r.start && i - 1 < r.end);
      if (tok) return tok.start;
      i--;
    }
  }
  return i;
}

function moveCursorWordRight(text: string, pos: number): number {
  if (pos >= text.length) return text.length;
  const tokens = findPastedTokenRanges(text);
  const directHit = tokens.find((r) => pos >= r.start && pos < r.end);
  if (directHit) return directHit.end;

  let i = pos;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (i >= text.length) return text.length;

  const afterSpaceHit = tokens.find((r) => i >= r.start && i < r.end);
  if (afterSpaceHit) return afterSpaceHit.end;

  if (/[\p{L}\p{N}_]/u.test(text[i])) {
    while (i < text.length && /[\p{L}\p{N}_]/u.test(text[i])) {
      const tok = tokens.find((r) => i >= r.start && i < r.end);
      if (tok) return tok.end;
      i++;
    }
  } else {
    while (i < text.length && !/\s/.test(text[i]) && !/[\p{L}\p{N}_]/u.test(text[i])) {
      const tok = tokens.find((r) => i >= r.start && i < r.end);
      if (tok) return tok.end;
      i++;
    }
  }
  return i;
}

function moveCursorVertical(text: string, pos: number, dir: -1 | 1): number | null {
  if (!text.includes("\n")) return null;
  const lines = text.split("\n");
  let offset = 0;
  let curLine = 0;
  let col = 0;
  const starts: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    starts.push(offset);
    const end = offset + lines[i].length;
    if (pos >= offset && pos <= end) {
      curLine = i;
      col = pos - offset;
    }
    offset = end + 1;
  }
  const targetLine = curLine + dir;
  if (targetLine < 0 || targetLine >= lines.length) return null;
  let targetPos = starts[targetLine] + Math.min(col, lines[targetLine].length);
  const hit = findPastedTokenRanges(text).find((r) => targetPos > r.start && targetPos < r.end);
  if (hit) {
    targetPos = dir < 0 ? hit.start : hit.end;
  }
  return targetPos;
}

function isCodeTopBorder(plain: string): boolean {
  return /^\s*╭─.*╮\s*$/.test(plain);
}

function isCodeBottomBorder(plain: string): boolean {
  return /^\s*╰─+╯\s*$/.test(plain);
}

function extractCodeBodyContent(plain: string): string | null {
  const m = plain.match(/^\s*│ (.*) │\s*$/);
  return m ? m[1] : null;
}

function extractClickableCodeAt(
  lines: string[],
  convIdx: number,
  clickCol: number
): { text: string; kind: "block" | "line" | "inline" } | null {
  if (convIdx < 0 || convIdx >= lines.length) return null;
  const rawLine = lines[convIdx] ?? "";
  const plainLine = stripAnsi(rawLine);

  // 1. Check if the click is on or inside a fenced code block (╭─ ... ╰─)
  if (
    isCodeTopBorder(plainLine) ||
    isCodeBottomBorder(plainLine) ||
    extractCodeBodyContent(plainLine) !== null
  ) {
    let topIdx = -1;
    for (let i = convIdx; i >= 0; i--) {
      const p = stripAnsi(lines[i] ?? "");
      if (isCodeTopBorder(p)) {
        topIdx = i;
        break;
      }
      if (i < convIdx && (isCodeBottomBorder(p) || extractCodeBodyContent(p) === null)) {
        break;
      }
    }
    let botIdx = -1;
    if (topIdx >= 0) {
      for (let i = Math.max(convIdx, topIdx + 1); i < lines.length; i++) {
        const p = stripAnsi(lines[i] ?? "");
        if (isCodeBottomBorder(p)) {
          botIdx = i;
          break;
        }
        if (extractCodeBodyContent(p) === null) {
          break;
        }
      }
    }

    if (topIdx >= 0 && botIdx > topIdx + 1) {
      const logicalLines: Array<{ text: string; startRow: number; endRow: number }> = [];
      let curStart = topIdx + 1;
      for (let r = topIdx + 1; r < botIdx; r++) {
        const isLastOrNextIsNew =
          r + 1 >= botIdx || !(lines[r + 1] ?? "").includes(CODE_CONTINUATION_MARKER);
        if (isLastOrNextIsNew) {
          let acc = "";
          for (let k = curStart; k <= r; k++) {
            const body = extractCodeBodyContent(stripAnsi(lines[k] ?? "")) ?? "";
            acc += k < r ? body : body.trimEnd();
          }
          logicalLines.push({ text: acc, startRow: curStart, endRow: r });
          curStart = r + 1;
        }
      }

      const fullBlock = logicalLines.map((l) => l.text).join("\n").trimEnd();
      if (!fullBlock) return null;

      if (convIdx === topIdx || convIdx === botIdx || logicalLines.length === 1) {
        return { text: fullBlock, kind: logicalLines.length > 1 ? "block" : "line" };
      }

      const clickedLogical = logicalLines.find(
        (l) => convIdx >= l.startRow && convIdx <= l.endRow
      );
      if (clickedLogical && clickedLogical.text.trim()) {
        return { text: clickedLogical.text.trim(), kind: "line" };
      }
      return { text: fullBlock, kind: "block" };
    }
  }

  // 2. Check for inline code spans (\x1b[36m...\x1b[39m) on normal text lines
  if (!/^\s*(?:●|>)\s/.test(plainLine)) {
    const spans: Array<{ text: string; startCol: number; endCol: number }> = [];
    let col = 1;
    let inCyan = false;
    let curText = "";
    let curStart = 1;
    let i = 0;
    while (i < rawLine.length) {
      if (rawLine[i] === "\x1b") {
        const m = rawLine.slice(i).match(/^\x1b\[[0-9;]*m/);
        if (m) {
          const seq = m[0];
          if (seq === "\x1b[36m") {
            inCyan = true;
            curText = "";
            curStart = col;
          } else if (inCyan && (seq === "\x1b[39m" || seq === "\x1b[0m" || seq === "\x1b[m")) {
            inCyan = false;
            if (curText.trim()) {
              spans.push({ text: curText.trim(), startCol: curStart, endCol: Math.max(curStart, col - 1) });
            }
          }
          i += seq.length;
          continue;
        }
      }
      const cp = rawLine.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      const w = stringWidth(ch) || 0;
      if (inCyan) curText += ch;
      col += w;
      i += ch.length;
    }

    if (spans.length > 0) {
      const targetCol = Math.max(1, clickCol - 1);
      const hit = spans.find((s) => targetCol >= s.startCol - 2 && targetCol <= s.endCol + 2);
      if (hit) return { text: hit.text, kind: "inline" };
      if (spans.length === 1) return { text: spans[0].text, kind: "inline" };
    }
  }

  return null;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const COLOR_WORKING = "#f97316"; // Orange pour "working"
const COLOR_DONE = "#22c55e"; // Vert pour "terminé"

const LOCAL_COMMANDS: SlashCommand[] = [
  { name: "to", description: "Transférer la dernière réponse vers une autre session", argumentHint: "<session> [texte]", isLocal: true },
  { name: "new", description: "Créer une nouvelle session Hermes", argumentHint: "[titre]", isLocal: true },
  { name: "title", description: "Renommer l'onglet de session dans Paseo", argumentHint: "<titre>", isLocal: true },
  { name: "copy", description: "Copier la dernière réponse (ou '/copy code' pour le dernier bloc)", argumentHint: "[code]", isLocal: true },
  { name: "reset", description: "Recréer la session à neuf (même nom) et archiver l'ancienne", isLocal: true },
  { name: "sessions", description: "Menu des onglets de session avec badges", argumentHint: "[filtre]", isLocal: true },
  { name: "agent", description: "Basculer vers un autre agent / session Hermes", argumentHint: "[filtre]", isLocal: true },
  { name: "model", description: "Choisir le modèle / provider LLM", argumentHint: "[id]", isLocal: true },
  { name: "thinking", description: "Choisir le niveau de raisonnement (thinking)", argumentHint: "[niveau]", isLocal: true },
  { name: "mode", description: "Changer le mode d'édition (default / accept_edits / dont_ask)", argumentHint: "[mode]", isLocal: true },
  { name: "archive", description: "Archiver la session courante (la retire des onglets)", isLocal: true },
  { name: "reload", description: "Recharger l'historique de la session depuis Paseo", isLocal: true },
  { name: "clear", description: "Nettoyer la vue de conversation courante", isLocal: true },
  { name: "quit", description: "Quitter hermes-tui", isLocal: true },
];

const FALLBACK_HERMES_COMMANDS: SlashCommand[] = [
  { name: "help", description: "Lister les commandes Hermes" },
  { name: "model", description: "Afficher ou changer de modèle côté Hermes", argumentHint: "<modèle>" },
  { name: "tools", description: "Lister les outils disponibles" },
  { name: "context", description: "Afficher l'utilisation du contexte" },
  { name: "reset", description: "Réinitialiser l'historique de conversation" },
  { name: "compress", description: "Compresser le contexte de la session" },
  { name: "steer", description: "Injecter une instruction dans le tour en cours", argumentHint: "<texte>" },
  { name: "queue", description: "Mettre un message en file d'attente", argumentHint: "<texte>" },
  { name: "usage", description: "Afficher la consommation tokens/coût" },
  { name: "status", description: "État de la session Hermes" },
  { name: "version", description: "Version de Hermes Agent" },
  { name: "title", description: "Renommer la session", argumentHint: "<titre>" },
  { name: "undo", description: "Annuler le dernier échange" },
  { name: "retry", description: "Relancer le dernier prompt" },
];

const DEFAULT_THINKING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"];

let terminalInitialized = false;
function initTerminalScreen(): void {
  if (terminalInitialized || !process.stdout.isTTY) return;
  terminalInitialized = true;
  process.stdout.write("\x1b[?1049h\x1b[?1002h\x1b[?1006h\x1b[?2004h\x1b]2;hermes-tui\x07\x1b[2J\x1b[H");
}

function cleanupTerminalScreen(): void {
  if (!terminalInitialized || !process.stdout.isTTY) return;
  terminalInitialized = false;
  process.stdout.write("\x1b[?2004l\x1b[?1002l\x1b[?1000l\x1b[?1006l\x1b[?1049l\x1b]2;\x07");
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000;
    return `${Number.isInteger(m) ? m : m.toFixed(1)}M`;
  }
  if (n >= 1_000) {
    return `${Math.round(n / 1_000)}k`;
  }
  return String(n);
}

function formatContextUsage(usage: AgentUsage | null | undefined): { label: string; color?: string } | null {
  if (!usage) return null;
  const used = usage.contextWindowUsedTokens ?? usage.inputTokens;
  const max = usage.contextWindowMaxTokens;
  if (typeof used !== "number" || used <= 0) return null;
  if (typeof max === "number" && max > 0) {
    const pct = Math.min(100, Math.round((used / max) * 100));
    const color = pct >= 85 ? "red" : pct >= 60 ? "yellow" : undefined;
    return { label: `${formatTokens(used)}/${formatTokens(max)} (${pct}%)`, color };
  }
  return { label: `${formatTokens(used)} ctx` };
}

function sendDesktopNotification(title: string, body: string): void {
  if (process.env.HERMES_TUI_NOTIFY === "0") return;
  try {
    const p = spawnProc("notify-send", ["-a", "hermes-tui", "-t", "4000", title, body], {
      stdio: "ignore",
      detached: true,
    });
    p.on("error", () => {});
    p.unref();
  } catch {
    // ignore if notify-send is unavailable
  }
}

const SILENCE_MARKER_RE = /^[*_`.~]*(?:\[?SILENT\]?|NO[_\s]REPLY)[*_`.~]*$/i;
const HERMES_SILENCE_WARNING_RE = /^⚠️?\s*The model returned only a silence marker.*$/i;
const HERMES_REASONING_CLOSED_RE =
  /(?:^|\n)[ \t]*💭\s*[*_~]*Reasoning:?[*_~]*[ \t]*\n(?:[ \t]*╭[\s\S]*?╰[─━\s]*╯|[ \t]*```[\s\S]*?```)[ \t]*(?=\n|$)/g;
const HERMES_REASONING_OPEN_RE = /(?:^|\n)[ \t]*💭\s*[*_~]*Reasoning:?[*_~]*[\s\S]*$/;

function stripEmbeddedReasoning(rawText: string): string {
  return rawText
    .replace(/\r\n/g, "\n")
    .replace(HERMES_REASONING_CLOSED_RE, "\n")
    .replace(HERMES_REASONING_OPEN_RE, "");
}

function filterNoReply(rawText: string): { isSilentOnly: boolean; text: string } {
  const withoutReasoning = stripEmbeddedReasoning(rawText);
  const cleanedLines = withoutReasoning
    .split("\n")
    .filter((l) => !HERMES_SILENCE_WARNING_RE.test(l.trim()));
  const withoutWarning = cleanedLines.join("\n");
  const trimmed = withoutWarning.trim();
  if (!trimmed) {
    // If rawText had an embedded reasoning block and nothing else yet, hide it while streaming
    if (withoutReasoning.trim() !== rawText.trim()) {
      return { isSilentOnly: true, text: "" };
    }
    return { isSilentOnly: false, text: rawText };
  }
  if (SILENCE_MARKER_RE.test(trimmed)) {
    return { isSilentOnly: true, text: "" };
  }
  const lines = withoutWarning.replace(/\s+$/, "").split("\n");
  if (lines.length >= 2 && SILENCE_MARKER_RE.test(lines[lines.length - 1].trim())) {
    lines.pop();
    const cleaned = lines.join("\n").replace(/\s+$/, "");
    if (!cleaned.trim()) return { isSilentOnly: true, text: "" };
    return { isSilentOnly: false, text: cleaned };
  }
  return { isSilentOnly: false, text: withoutReasoning };
}

function colorizeToolOutputLine(ol: string, isEdit: boolean): string {
  if (isEdit || /^(diff --git |@@ |--- |\+\+\+ )/.test(ol)) {
    if (ol.startsWith("+++ ") || ol.startsWith("--- ") || ol.startsWith("@@ ")) {
      return chalk.cyan(ol);
    }
    if (ol.startsWith("+")) {
      return chalk.hex("#22c55e")(ol);
    }
    if (ol.startsWith("-")) {
      return chalk.hex("#ef4444")(ol);
    }
  }
  return chalk.dim(ol);
}

function getPersonaIcon(agent: HermesAgent | undefined): string {
  if (!agent) return "🔮";
  return "🤖";
}

function getAgentBadge(
  agent: HermesAgent,
  completedIds: ReadonlySet<string>
): { symbol: string; hex?: string; stateLabel: "working" | "terminé" | "idle" } {
  if (agent.status === "running") {
    return { symbol: "●", hex: COLOR_WORKING, stateLabel: "working" };
  }
  if (completedIds.has(agent.id)) {
    return { symbol: "●", hex: COLOR_DONE, stateLabel: "terminé" };
  }
  return { symbol: "○", hex: undefined, stateLabel: "idle" };
}

function renderBadgeDot(badge: { symbol: string; hex?: string; stateLabel: string }): string {
  return badge.hex ? chalk.hex(badge.hex)(badge.symbol) : chalk.dim(badge.symbol);
}

function classifyToolName(item: TimelineItem): string {
  const rawName = (item.name || item.metadata?.title || "").trim();
  const detailLabel = (item.detail?.label || item.metadata?.title || "").trim();
  const combined = `${rawName} ${detailLabel}`.toLowerCase();
  if (item.detail?.type === "shell" || /\b(terminal|bash|shell|execute_code|exec|run_command)\b/.test(combined)) {
    return "Bash";
  }
  if (item.detail?.type === "edit" || /\b(edit|patch|write_file|replace)\b/.test(combined)) {
    return "Edit";
  }
  if (/\b(read_file|view_file|cat)\b/.test(combined)) {
    return "Read";
  }
  if (/mnemosyne|memory/.test(combined)) {
    return "Memory";
  }
  if (/skill_/.test(combined)) {
    return "Skill";
  }
  if (/peer_/.test(combined)) {
    return "Peer";
  }
  if (/search|grep|find|web|fetch|url/.test(combined)) {
    return "Search";
  }
  const preferred = rawName.toLowerCase() === "other" && detailLabel ? detailLabel : rawName;
  const base = preferred.split(/[:\s]/)[0] || "Tool";
  return base.charAt(0).toUpperCase() + base.slice(1);
}

function extractToolStep(item: TimelineItem): WorkStep | null {
  const rawName = item.name || item.metadata?.title || "";
  if (rawName.startsWith("edit-approval-")) {
    return null;
  }

  const toolName = classifyToolName(item);
  let command = "";
  let output = "";

  if (item.detail?.type === "shell") {
    command = (item.detail.command || item.metadata?.title || rawName || "shell").trim();
    output = (item.detail.output || "").trim();
  } else if (item.detail?.type === "edit") {
    command = (item.detail.filePath || item.metadata?.title || "edit").trim();
    output = (item.detail.unifiedDiff || "").trim();
  } else {
    command = (item.detail?.label || item.metadata?.title || rawName || "tool").trim();
    output = (item.detail?.text || item.detail?.output || "").trim();
  }

  // Strip redundant tool prefix ("terminal: ", "execute_code: ", "write_file: "...) and normalize the
  // upstream "..." truncation into a single ellipsis so previews use the full terminal width.
  command = command.replace(/^[a-z_]+:\s+(?=\S)/i, "").replace(/\.{3}$/, "…").trim();

  const firstLine = command.replace(/\s+/g, " ").trim();
  return {
    kind: "tool",
    toolName,
    title: firstLine,
    command,
    output,
    status: item.status ?? "completed",
    timestamp: item.timestamp,
  };
}

function formatCollapsedToolLine(steps: WorkStep[], maxWidth: number, isExpandedHint = true): string {
  const primary = steps[0];
  const label = primary?.toolName || "Tool";
  const dot = chalk.hex(COLOR_WORKING)("● ");
  const titleText = chalk.bold.yellow(label);
  const extra = steps.length > 1 ? ` +${steps.length - 1}` : "";
  const hint = isExpandedHint ? " (ctrl+o to expand)" : " (ctrl+o to collapse)";
  const fixedLen = 2 + label.length + 2 + extra.length + hint.length + 3;
  const cmdBudget = Math.max(12, maxWidth - fixedLen);

  const rawPreview = (primary?.command || primary?.title || label).replace(/\s+/g, " ").trim();
  const cmdPreview =
    rawPreview.length > cmdBudget
      ? `${rawPreview.slice(0, Math.max(4, cmdBudget - 1)).replace(/…$/, "")}…`
      : rawPreview;

  return `${dot}${titleText}(${cmdPreview})${extra ? chalk.dim(extra) : ""}${chalk.dim(hint)}`;
}

function formatWorkGroupLines(steps: WorkStep[], showDetails: boolean, maxWidth: number): string[] {
  if (steps.length === 0) return [];
  if (!showDetails) {
    return [formatCollapsedToolLine(steps, maxWidth, true)];
  }

  const lines: string[] = [];
  steps.forEach((step, idx) => {
    const dot = step.status === "failed" ? chalk.red("● ") : chalk.hex(COLOR_WORKING)("● ");
    const titleText = step.status === "failed" ? chalk.bold.red(step.toolName) : chalk.bold.yellow(step.toolName);
    const collapseHint = idx === 0 ? chalk.dim(" (ctrl+o to collapse)") : "";
    const singleLineCmd = step.command.replace(/\s+/g, " ").trim();
    const cmdLine = `${dot}${titleText}(${singleLineCmd})${collapseHint}`;
    lines.push(...wrapAnsiText(cmdLine, maxWidth, "", "  ").split("\n"));

    if (step.output) {
      const nonEmptyLines = step.output
        .split("\n")
        .map((l) => l.trimEnd())
        .filter((l) => l.trim().length > 0);
      const maxOutLines = 40;
      const shown = nonEmptyLines.slice(0, maxOutLines);
      const isEdit = step.toolName === "Edit";
      shown.forEach((ol, oi) => {
        const prefix = oi === 0 ? "  ⎿  " : "     ";
        const colored = colorizeToolOutputLine(ol, isEdit);
        const wrapped = wrapAnsiText(colored, maxWidth, chalk.dim(prefix), "     ");
        lines.push(...wrapped.split("\n"));
      });
      if (nonEmptyLines.length > maxOutLines) {
        lines.push(chalk.dim(`     … (+${nonEmptyLines.length - maxOutLines} lignes)`));
      }
    }
  });
  return lines;
}

function timelineToStaticEntries(items: TimelineItem[], epoch: number): StaticEntry[] {
  const entries: StaticEntry[] = [];
  let idx = 0;
  let assistantAcc = "";
  let assistantTs: string | undefined;
  let workSteps: WorkStep[] = [];

  const flushWorkGroup = () => {
    if (workSteps.length > 0) {
      entries.push({
        key: `${epoch}-wg-${idx++}`,
        kind: "work_group",
        steps: workSteps,
        text: "",
        timestamp: workSteps[0]?.timestamp,
      });
      workSteps = [];
    }
  };

  const flushAssistant = () => {
    if (assistantAcc.trim()) {
      flushWorkGroup();
      const filtered = filterNoReply(assistantAcc.replace(/^\n+/, ""));
      if (!filtered.isSilentOnly && filtered.text.trim()) {
        entries.push({
          key: `${epoch}-a-${idx++}`,
          kind: "assistant",
          text: filtered.text,
          timestamp: assistantTs,
        });
      }
    }
    assistantAcc = "";
    assistantTs = undefined;
  };

  for (const item of items) {
    if (item.type === "reasoning") {
      continue;
    }
    if (item.type === "assistant_message") {
      assistantAcc += item.text ?? "";
      if (item.timestamp) assistantTs = item.timestamp;
    } else if (item.type === "tool_call") {
      flushAssistant();
      const step = extractToolStep(item);
      if (step) {
        workSteps.push(step);
      }
    } else {
      flushAssistant();
      flushWorkGroup();
      if (item.type === "user_message" && item.text) {
        entries.push({
          key: `${epoch}-u-${idx++}`,
          kind: "user",
          text: item.text.trim(),
          timestamp: item.timestamp,
        });
      } else if (item.type === "error" && item.message) {
        entries.push({
          key: `${epoch}-e-${idx++}`,
          kind: "error",
          text: item.message,
          timestamp: item.timestamp,
        });
      } else if (item.type === "notification" && item.message) {
        entries.push({
          key: `${epoch}-n-${idx++}`,
          kind: "notice",
          text: item.message,
          timestamp: item.timestamp,
        });
      }
    }
  }
  flushAssistant();
  flushWorkGroup();
  return entries;
}

function renderSeparatorRule(ruleLen: number, timestamp?: string): string {
  const ts = formatTimeHHMM(timestamp);
  if (ts) {
    const dashes = Math.max(4, ruleLen - ts.length - 1);
    return chalk.dim(`${"─".repeat(dashes)} ${ts}`);
  }
  return chalk.dim("─".repeat(ruleLen));
}

function buildConversationLines(
  entries: StaticEntry[],
  liveTools: LiveTool[],
  liveAssistant: string,
  busy: boolean,
  spinner: string,
  showDetails: boolean,
  contentWidth: number,
  isThinking: boolean = false
): string[] {
  const lines: string[] = [];
  const ruleLen = Math.max(20, Math.min(contentWidth, 64));
  let lastTurnKind: StaticEntry["kind"] | null = null;
  let lastShownHHMM: string | null = null;

  for (const entry of entries) {
    if (entry.kind === "banner") {
      continue;
    }
    if (entry.kind === "user") {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      lines.push(renderSeparatorRule(ruleLen, entry.timestamp));
      const hhmm = formatTimeHHMM(entry.timestamp);
      if (hhmm) lastShownHHMM = hhmm;
      const promptWrapped = wrapAnsiText(chalk.blue(entry.text), contentWidth, chalk.blue("> "), "  ");
      lines.push(...promptWrapped.split("\n"));
      lines.push("");
      lastTurnKind = "user";
      continue;
    }
    if (entry.kind === "work_group" && entry.steps) {
      const hhmm = formatTimeHHMM(entry.timestamp);
      if ((lastTurnKind === null || (lastTurnKind === "assistant" && hhmm && hhmm !== lastShownHHMM)) && entry.timestamp) {
        if (lines.length > 0 && lines[lines.length - 1] !== "") {
          lines.push("");
        }
        lines.push(renderSeparatorRule(ruleLen, entry.timestamp));
        lines.push("");
        if (hhmm) lastShownHHMM = hhmm;
      }
      lines.push(...formatWorkGroupLines(entry.steps, showDetails, contentWidth));
      lines.push("");
      lastTurnKind = "work_group";
      continue;
    }
    if (entry.kind === "assistant") {
      const hhmm = formatTimeHHMM(entry.timestamp);
      if ((lastTurnKind === null || lastTurnKind === "assistant") && entry.timestamp) {
        if (lines.length > 0 && lines[lines.length - 1] !== "") {
          lines.push("");
        }
        lines.push(renderSeparatorRule(ruleLen, entry.timestamp));
        lines.push("");
        if (hhmm) lastShownHHMM = hhmm;
      } else if (hhmm) {
        lastShownHHMM = hhmm;
      }
      const mdLines = renderMarkdownToLines(entry.text, contentWidth, "  ");
      lines.push(...mdLines);
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      lastTurnKind = "assistant";
      continue;
    }
    if (entry.kind === "error") {
      const wrapped = wrapAnsiText(chalk.red(`✖ ${entry.text}`), contentWidth, "  ", "    ");
      lines.push(...wrapped.split("\n"));
      lines.push("");
      continue;
    }
    if (entry.kind === "notice") {
      const wrapped = wrapAnsiText(chalk.blue(`ℹ ${entry.text}`), contentWidth, "  ", "    ");
      lines.push(...wrapped.split("\n"));
    }
  }

  if (liveTools.length > 0 || liveAssistant || busy) {
    const liveSteps: WorkStep[] = liveTools.map((t) => ({
      kind: "tool",
      toolName: t.toolName,
      title: t.title,
      command: t.command,
      output: t.output,
      status: t.status,
    }));

    if (liveSteps.length > 0 && (showDetails || !busy)) {
      lines.push(...formatWorkGroupLines(liveSteps, showDetails, contentWidth));
      if (liveAssistant) lines.push("");
    }
    if (liveAssistant) {
      const filtered = filterNoReply(liveAssistant.replace(/^\n+/, ""));
      if (!filtered.isSilentOnly && filtered.text.trim()) {
        lines.push(...renderMarkdownToLines(filtered.text, contentWidth, "  "));
      }
    }
    if (busy) {
      const dot = chalk.hex(COLOR_WORKING)(`● ${spinner} `);
      if (isThinking) {
        lines.push(`${dot}${chalk.cyan("Thinking…")}${chalk.dim(" (esc to stop)")}`);
      } else {
        const latest = liveSteps[liveSteps.length - 1];
        const liveBudget = Math.max(24, contentWidth - 40 - (latest?.toolName.length ?? 0));
        const stepInfo = latest
          ? ` ${chalk.bold.yellow(latest.toolName)}(${latest.title.slice(0, liveBudget)}${latest.title.length > liveBudget ? "…" : ""})${
              liveSteps.length > 1 ? ` +${liveSteps.length - 1}` : ""
            }`
          : "";
        lines.push(
          `${dot}${chalk.hex(COLOR_DONE)("Working…")}${stepInfo}${chalk.dim(
            ` (ctrl+o ${showDetails ? "to collapse" : "to expand"} · esc to stop)`
          )}`
        );
      }
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

interface TabHitBox {
  agentId: string;
  row: number; // 1-based terminal row
  startCol: number; // 1-based terminal col
  endCol: number; // 1-based terminal col
}

interface TopTabsLayout {
  rows: string[];
  hitBoxes: TabHitBox[];
  menuHitBox: { row: number; startCol: number; endCol: number } | null;
}

function getAgentTabGroupAndLabel(
  agent: HermesAgent,
  allAgents?: ReadonlyArray<HermesAgent>
): { group: string; label: string } {
  const title = (agent.title || "").trim();
  const project = (agent.projectName || "").trim();
  const workspace = (agent.workspaceName || "").trim();
  const parts = title.split(" - ");
  const group = project || parts[0]?.trim() || title || "Session";

  const siblingsInWorkspace =
    allAgents && agent.workspaceId
      ? allAgents.filter((a) => a.workspaceId === agent.workspaceId).length
      : 1;

  if (siblingsInWorkspace <= 1 && workspace && workspace.toLowerCase() !== group.toLowerCase()) {
    return { group, label: workspace };
  }

  let rawLabel = "";
  if (parts.length > 1) {
    if (parts[0].trim().toLowerCase() === group.toLowerCase()) {
      rawLabel = parts.slice(1).join(" - ").trim();
    } else {
      rawLabel = title;
    }
  } else if (title && title.toLowerCase() !== group.toLowerCase()) {
    rawLabel = title;
  } else if (workspace && workspace.toLowerCase() !== group.toLowerCase() && siblingsInWorkspace <= 1) {
    rawLabel = workspace;
  } else {
    rawLabel = "Principal";
  }

  return { group, label: rawLabel || "Principal" };
}

function buildTopTabsLayout(
  agents: HermesAgent[],
  activeAgentId: string | null,
  completedIds: ReadonlySet<string>,
  innerWidth: number,
  spinner: string
): TopTabsLayout {
  const hitBoxes: TabHitBox[] = [];
  if (agents.length === 0) {
    return { rows: [chalk.dim("Chargement des sessions…")], hitBoxes, menuHitBox: null };
  }

  // Group sessions by projectName (falling back to title prefix before " - ")
  const groups: { name: string; icon: string; items: { agent: HermesAgent; label: string }[] }[] = [];
  const enriched = agents.map((a) => ({ agent: a, ...getAgentTabGroupAndLabel(a, agents) }));
  enriched.sort(
    (x, y) =>
      x.group.localeCompare(y.group, "fr") ||
      x.label.localeCompare(y.label, "fr") ||
      x.agent.id.localeCompare(y.agent.id)
  );
  for (const { agent: a, group: name, label: rawLabel } of enriched) {
    let g = groups.find((x) => x.name === name);
    if (!g) {
      g = { name, icon: getPersonaIcon(a), items: [] };
      groups.push(g);
    }
    const dup = g.items.filter((i) => i.label === rawLabel || i.label.startsWith(`${rawLabel} #`)).length;
    g.items.push({ agent: a, label: dup > 0 ? `${rawLabel} #${dup + 1}` : rawLabel });
  }

  const headerWidth = Math.max(...groups.map((g) => visibleLength(`${g.icon} ${g.name}`))) + 1;
  const menuPlain = "[≡ ^S]";
  const menuWidth = visibleLength(menuPlain);
  const rows: string[] = [];
  let menuHitBox: TopTabsLayout["menuHitBox"] = null;

  groups.forEach((g, gi) => {
    const headPlain = `${g.icon} ${g.name}`;
    const firstPrefix =
      chalk.bold.whiteBright(headPlain) + " ".repeat(Math.max(1, headerWidth - visibleLength(headPlain))) + chalk.dim("│");
    const contPrefix = " ".repeat(headerWidth) + chalk.dim("│");

    let line = firstPrefix;
    let width = headerWidth + 1;
    let isFirstLineOfGroup = true;
    let chipsOnCurrentLine = 0;

    const finalizeLine = (appendMenu: boolean) => {
      if (appendMenu) {
        const gap = Math.max(1, innerWidth - width - menuWidth);
        const startCol = 2 + width + gap;
        line += " ".repeat(gap) + chalk.dim(menuPlain);
        menuHitBox = { row: rows.length + 1, startCol, endCol: startCol + menuWidth - 1 };
      }
      rows.push(line);
    };

    g.items.forEach((it) => {
      const isCurrent = it.agent.id === activeAgentId;
      const badge = getAgentBadge(it.agent, completedIds);
      const symbol = badge.stateLabel === "working" ? spinner : badge.symbol;
      const label = it.label.length > 22 ? `${it.label.slice(0, 21)}…` : it.label;
      const plain = ` ${symbol} ${label} `;
      const chipWidth = visibleLength(plain);
      const sepWidth = chipsOnCurrentLine > 0 ? 1 : 0;
      const reserve = gi === 0 && isFirstLineOfGroup ? menuWidth + 2 : 0;

      if (chipsOnCurrentLine > 0 && width + sepWidth + chipWidth + reserve > innerWidth) {
        finalizeLine(gi === 0 && isFirstLineOfGroup);
        isFirstLineOfGroup = false;
        line = contPrefix;
        width = headerWidth + 1;
        chipsOnCurrentLine = 0;
      }

      if (chipsOnCurrentLine > 0) {
        line += chalk.dim("│");
        width += 1;
      }
      const dot = badge.hex ? chalk.hex(badge.hex)(symbol) : chalk.dim(symbol);
      const rowNum = rows.length + 1;
      const startCol = 2 + width;
      if (isCurrent) {
        const dotOnBg = badge.hex ? chalk.bgWhiteBright.hex(badge.hex)(symbol) : chalk.bgWhiteBright.black(symbol);
        line += chalk.bgWhiteBright.black.bold(" ") + dotOnBg + chalk.bgWhiteBright.black.bold(` ${label} `);
      } else {
        line += ` ${dot} ${label} `;
      }
      width += chipWidth;
      chipsOnCurrentLine += 1;
      hitBoxes.push({ agentId: it.agent.id, row: rowNum, startCol, endCol: startCol + chipWidth - 1 });
    });

    finalizeLine(gi === 0 && isFirstLineOfGroup);
  });

  return { rows, hitBoxes, menuHitBox };
}

function fuzzyMatch(query: string, text: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const t = text.toLowerCase();
  if (t.includes(q)) return true;
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) qi++;
  }
  return qi === q.length;
}

function spawnBridge(): ChildProcessWithoutNullStreams {
  return spawn(BRIDGE_CMD[0], BRIDGE_CMD.slice(1), {
    stdio: ["pipe", "pipe", "pipe"],
  });
}

function printHelp(): void {
  console.log(`hermes-tui (htui) — TUI style agy pour Hermes via Paseo

Usage:
  hermes-tui [agent]         Démarre la TUI (optionnel: nom ou préfixe d'agent)
  hermes-tui --check         Teste la connexion au pont Paseo (${TARGET_LABEL})
  hermes-tui --help          Affiche cette aide

Raccourcis clavier & souris:
  Clic sur onglet (en haut)  Basculer directement sur une session
  Clic sur code / bloc       Copier la ligne de code ou le bloc entier (en-tête "copier")
  Molette / PgUp / PgDn      Défiler dans la discussion (verrouille la position pendant le stream)
  Ctrl+Y / /copy             Copier le dernier bloc de code ou la dernière réponse
  Ctrl+V                     Joindre image/PDF/fichier du presse-papiers (ou coller du texte)
  /archive                   Archiver la session courante
  Ctrl+F                     Rechercher dans la conversation active
  Ctrl+O                     Déplier / replier les commandes exécutées par l'agent
  Ctrl+S / Ctrl+A / /sessions Menu complet des onglets de session avec badges
  Ctrl+L / /model            Sélecteur de modèle / provider LLM
  Ctrl+T / /thinking         Sélecteur du niveau de thinking
  Ctrl+N / Ctrl+P            Session suivante / précédente
  /                          Menu d'autocomplétion des commandes slash
  Tab                        Compléter la commande sélectionnée
  Esc                        Annuler le tour en cours ou fermer un menu
  Ctrl+C                     Quitter`);
}

async function runCheck(): Promise<number> {
  const proc = spawnBridge();
  const rl = readline.createInterface({ input: proc.stdout });
  let stderr = "";
  proc.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const result = await new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Timeout waiting for init_ok${stderr ? `: ${stderr}` : ""}`));
    }, 12000);

    rl.on("line", (line) => {
      try {
        const msg = JSON.parse(line);
        if (msg.type === "init_ok") {
          clearTimeout(timer);
          resolve(msg);
        } else if (msg.type === "fatal" || msg.type === "error") {
          clearTimeout(timer);
          reject(new Error(msg.message || "Bridge error"));
        }
      } catch {
        // ignore non-json
      }
    });

    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`Bridge exited early (${code})${stderr ? `: ${stderr}` : ""}`));
    });

    proc.stdin.write(`${JSON.stringify({ cmd: "init" })}\n`);
  });

  proc.stdin.end();
  proc.kill("SIGTERM");

  const agents = (result.agents as HermesAgent[]) ?? [];
  const models = (result.models as HermesModel[]) ?? [];
  const commands = (result.commands as SlashCommand[]) ?? [];
  const activeId = result.activeAgentId as string | null;
  const active = agents.find((a) => a.id === activeId);

  console.log(
    JSON.stringify(
      {
        ok: true,
        agentsCount: agents.length,
        activeAgent: active ? { id: active.id, title: active.title, status: active.status, model: active.model } : null,
        modelsCount: models.length,
        commandsCount: commands.length,
      },
      null,
      2
    )
  );
  return 0;
}

type ModalKind = "none" | "agents" | "models" | "thinking" | "modes" | "permission";

interface LiveTool {
  callId: string;
  toolName: string;
  title: string;
  command: string;
  output: string;
  status: string;
}

interface Draft {
  text: string;
  cursor: number;
  attachments: PendingAttachment[];
  pastedTexts: Array<[string, string]>;
}

interface CachedSession {
  entries: StaticEntry[];
  commands: SlashCommand[];
  fingerprint: string;
  updatedAt: string;
}

function timelineFingerprint(items: TimelineItem[]): string {
  const len = items.length;
  if (len === 0) return "0";
  const last = items[len - 1];
  return `${len}:${last?.type ?? ""}:${last?.callId ?? last?.messageId ?? ""}:${(last?.text ?? last?.message ?? "").slice(-48)}`;
}

interface AppProps {
  initialQuery?: string;
}

const SGR_MOUSE_RE = /\[<(\d+);(\d+);(\d+)([Mm])/g;

const HermesTuiApp: React.FC<AppProps> = ({ initialQuery }) => {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const stdinCtx = useStdin() as unknown as { internal_eventEmitter?: { on: (ev: string, fn: (d: Buffer | string) => void) => void; removeListener: (ev: string, fn: (d: Buffer | string) => void) => void } };
  const lastRawKeySeqRef = useRef("");
  useEffect(() => {
    const em = stdinCtx?.internal_eventEmitter;
    if (!em) return;
    const onRaw = (data: Buffer | string) => {
      lastRawKeySeqRef.current = typeof data === "string" ? data : data.toString("utf8");
    };
    em.on("input", onRaw);
    return () => {
      em.removeListener("input", onRaw);
    };
  }, [stdinCtx]);
  const { columns: termCols, rows: termRows } = useTerminalSize();
  const initialPersisted = useMemo(() => loadPersistedState(), []);
  const persistedAgentIdRef = useRef<string | null>(initialPersisted.lastActiveAgentId ?? null);

  const bridgeRef = useRef<ChildProcessWithoutNullStreams | null>(null);
  const seqRef = useRef(0);
  const activeAgentIdRef = useRef<string | null>(null);
  const pendingSwitchIdRef = useRef<string | null>(null);

  const [connecting, setConnecting] = useState(true);
  const [agents, setAgents] = useState<HermesAgent[]>([]);
  const [models, setModels] = useState<HermesModel[]>([]);
  const [hermesCommands, setHermesCommands] = useState<SlashCommand[]>(FALLBACK_HERMES_COMMANDS);
  const [activeAgentId, setActiveAgentId] = useState<string | null>(null);

  const [sessionEpoch, setSessionEpoch] = useState(1);
  const [staticItems, setStaticItems] = useState<StaticEntry[]>([]);
  const staticItemsRef = useRef<StaticEntry[]>([]);
  staticItemsRef.current = staticItems;

  const [liveAssistant, setLiveAssistant] = useState("");
  const [liveTools, setLiveTools] = useState<LiveTool[]>([]);
  const [isStreaming, setIsStreaming] = useState(false);
  const [isThinking, setIsThinking] = useState(false);

  const [input, setInput] = useState("");
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef("");
  const cursorRef = useRef(0);
  inputRef.current = input;
  cursorRef.current = cursor;
  const intentionalCloseRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectDelayRef = useRef(1500);
  const [promptHistory, setPromptHistory] = useState<string[]>(() => initialPersisted.promptHistory ?? []);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const [scrollOffset, setScrollOffset] = useState(0);
  const scrollAnchorRef = useRef<number | null>(null);
  const pendingOptimisticUsersRef = useRef<string[]>([]);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const attachmentsRef = useRef<PendingAttachment[]>([]);
  attachmentsRef.current = attachments;
  const [selection, setSelection] = useState<Selection | null>(null);
  const selectionRef = useRef<Selection | null>(null);
  selectionRef.current = selection;
  const copyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const bracketPasteActiveRef = useRef(false);
  const bracketPasteBufRef = useRef("");

  const [modal, setModal] = useState<ModalKind>("none");
  const [modalFilter, setModalFilter] = useState("");
  const [modalIdx, setModalIdx] = useState(0);
  const [slashIdx, setSlashIdx] = useState(0);
  const [permission, setPermission] = useState<PermissionPrompt | null>(null);

  const [spinnerFrame, setSpinnerFrame] = useState(0);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState<boolean>(() => initialPersisted.showDetails ?? false);
  const [completedAgentIds, setCompletedAgentIds] = useState<Set<string>>(() => new Set());
  const prevStatusesRef = useRef<Map<string, string>>(new Map());
  const prevAttentionRef = useRef<Map<string, boolean>>(new Map());
  const timelineCacheRef = useRef<Map<string, CachedSession>>(new Map());
  const draftsRef = useRef<Map<string, Draft>>(new Map());
  const pastedTextsRef = useRef<Map<string, string>>(new Map());
  const pasteSeqRef = useRef(0);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchMatchIdx, setSearchMatchIdx] = useState(0);

  const activeAgent = useMemo(
    () => agents.find((a) => a.id === activeAgentId),
    [agents, activeAgentId]
  );

  const liveAssistantRef = useRef("");
  const liveToolsRef = useRef<LiveTool[]>([]);
  liveAssistantRef.current = liveAssistant;
  liveToolsRef.current = liveTools;
  const agentsRef = useRef<HermesAgent[]>([]);
  agentsRef.current = agents;
  const epochRef = useRef(1);
  epochRef.current = sessionEpoch;

  function sendBridge(obj: Record<string, unknown>): void {
    const proc = bridgeRef.current;
    if (proc && !proc.killed && proc.stdin.writable) {
      proc.stdin.write(`${JSON.stringify(obj)}\n`);
    }
  }

  function pushStatic(entry: Omit<StaticEntry, "key">): void {
    seqRef.current += 1;
    const item: StaticEntry = {
      ...entry,
      key: `live-${seqRef.current}`,
      timestamp: entry.timestamp ?? new Date().toISOString(),
    };
    setStaticItems((prev) => {
      const next = [...prev, item];
      const curId = activeAgentIdRef.current;
      if (curId) {
        const cached = timelineCacheRef.current.get(curId);
        if (cached) cached.entries = next;
      }
      return next;
    });
  }

  function flushLiveTurnToStatic(): void {
    const t = liveToolsRef.current;
    const a = liveAssistantRef.current.replace(/^\n+/, "");
    const nowIso = new Date().toISOString();

    const workSteps: WorkStep[] = t.map((tool) => ({
      kind: "tool",
      toolName: tool.toolName,
      title: tool.title,
      command: tool.command,
      output: tool.output,
      status: tool.status,
      timestamp: nowIso,
    }));

    const additions: StaticEntry[] = [];
    if (workSteps.length > 0) {
      seqRef.current += 1;
      additions.push({
        key: `live-${seqRef.current}`,
        kind: "work_group",
        steps: workSteps,
        text: "",
        timestamp: nowIso,
      });
    }
    if (a.trim()) {
      const filtered = filterNoReply(a);
      if (!filtered.isSilentOnly && filtered.text.trim()) {
        seqRef.current += 1;
        additions.push({
          key: `live-${seqRef.current}`,
          kind: "assistant",
          text: filtered.text,
          timestamp: nowIso,
        });
      }
    }
    if (additions.length > 0) {
      setStaticItems((prev) => {
        const next = [...prev, ...additions];
        const curId = activeAgentIdRef.current;
        if (curId) {
          const cached = timelineCacheRef.current.get(curId);
          if (cached) cached.entries = next;
        }
        return next;
      });
    }
    liveToolsRef.current = [];
    liveAssistantRef.current = "";
    setLiveTools([]);
    setLiveAssistant("");
    setIsStreaming(false);
    setIsThinking(false);
  }

  function resetToAgentTimeline(
    agent: HermesAgent | undefined,
    timeline: TimelineItem[],
    cmds: SlashCommand[],
    preserveScroll = false
  ): void {
    const nextEpoch = epochRef.current + 1;
    setLiveAssistant("");
    setLiveTools([]);
    setIsStreaming(agent?.status === "running");
    setIsThinking(false);
    pendingOptimisticUsersRef.current = [];
    if (!preserveScroll) {
      scrollAnchorRef.current = null;
      setScrollOffset(0);
    }

    const entries = timelineToStaticEntries(timeline, nextEpoch);
    const resolvedCmds = cmds.length > 0 ? cmds : FALLBACK_HERMES_COMMANDS;
    if (agent?.id) {
      const existing = timelineCacheRef.current.get(agent.id);
      timelineCacheRef.current.set(agent.id, {
        entries,
        commands: cmds.length > 0 ? cmds : existing?.commands ?? resolvedCmds,
        fingerprint: timelineFingerprint(timeline),
        updatedAt: agent.updatedAt ?? "",
      });
    }
    setSessionEpoch(nextEpoch);
    setStaticItems(entries);
    if (cmds.length > 0) {
      setHermesCommands(resolvedCmds);
    }
  }

  const spinnerActive = connecting || isStreaming || agents.some((a) => a.status === "running");
  useEffect(() => {
    if (!spinnerActive) return;
    const id = setInterval(() => {
      setSpinnerFrame((f) => (f + 1) % SPINNER_FRAMES.length);
    }, 120);
    return () => clearInterval(id);
  }, [spinnerActive]);

  useEffect(() => {
    intentionalCloseRef.current = false;

    const connectBridge = () => {
      if (intentionalCloseRef.current) return;
      const proc = spawnBridge();
      bridgeRef.current = proc;

      const rl = readline.createInterface({ input: proc.stdout });
      proc.stderr.on("data", (chunk) => {
        const msg = chunk.toString().trim();
        if (msg) {
          setStatusNotice(msg.split("\n")[0]);
        }
      });

      proc.on("exit", () => {
        if (bridgeRef.current !== proc || intentionalCloseRef.current) return;
        bridgeRef.current = null;
        setConnecting(true);
        setIsStreaming(false);
        const delay = reconnectDelayRef.current;
        reconnectDelayRef.current = Math.min(5000, Math.round(delay * 1.5));
        setStatusNotice(`Connexion perdue — reconnexion dans ${Math.round(delay / 1000)}s…`);
        reconnectTimerRef.current = setTimeout(connectBridge, delay);
      });

      rl.on("line", (line) => {
        let msg: any;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }

        if (msg.type === "init_ok") {
          reconnectDelayRef.current = 1500;
          setStatusNotice(null);
          const list: HermesAgent[] = msg.agents ?? [];
          setAgents(list);
          setModels(msg.models ?? []);
          const nextStatuses = new Map<string, string>();
          for (const a of list) {
            nextStatuses.set(a.id, a.status);
          }
          prevStatusesRef.current = nextStatuses;

          let chosenId: string | null =
            (activeAgentIdRef.current && list.some((a) => a.id === activeAgentIdRef.current)
              ? activeAgentIdRef.current
              : null) ??
            (!initialQuery &&
            persistedAgentIdRef.current &&
            list.some((a) => a.id === persistedAgentIdRef.current)
              ? persistedAgentIdRef.current
              : null) ??
            msg.activeAgentId ??
            list[0]?.id ??
            null;
          if (!activeAgentIdRef.current && initialQuery) {
            const q = initialQuery.toLowerCase();
            const match = list.find(
              (a) =>
                a.id.toLowerCase().startsWith(q) ||
                a.title.toLowerCase().includes(q) ||
                a.projectName.toLowerCase().includes(q)
            );
            if (match) chosenId = match.id;
          }

          const nextAttention = new Map<string, boolean>();
          const initialUnread = new Set<string>();
          for (const a of list) {
            const att = Boolean(a.requiresAttention && a.id !== chosenId);
            nextAttention.set(a.id, att);
            if (att && a.status !== "running") {
              initialUnread.add(a.id);
            }
          }
          prevAttentionRef.current = nextAttention;
          setCompletedAgentIds(initialUnread);

          setActiveAgentId(chosenId);
          activeAgentIdRef.current = chosenId;
          if (chosenId) savePersistedState({ lastActiveAgentId: chosenId });
          setConnecting(false);

          if (chosenId && chosenId !== msg.activeAgentId) {
            pendingSwitchIdRef.current = chosenId;
            sendBridge({ cmd: "switch_agent", agentId: chosenId });
          } else {
            const active = list.find((a) => a.id === chosenId);
            resetToAgentTimeline(active, msg.timeline ?? [], msg.commands ?? []);
          }

          const prefetchIds = list.filter((a) => a.id !== chosenId).map((a) => a.id);
          if (prefetchIds.length > 0) {
            sendBridge({ cmd: "prefetch_timelines", agentIds: prefetchIds });
          }
          return;
        }

        if (msg.type === "agents_updated") {
          const list: HermesAgent[] = msg.agents ?? [];
          const prevMap = prevStatusesRef.current;
          const prevAttMap = prevAttentionRef.current;
          const nextMap = new Map<string, string>();
          const nextAttMap = new Map<string, boolean>();
          const newlyDone: string[] = [];
          const nowRunning: string[] = [];
          const clearedAttention: string[] = [];

          let activeFinished = false;
          for (const a of list) {
            nextMap.set(a.id, a.status);
            const prevStatus = prevMap.get(a.id);
            const att = Boolean(a.requiresAttention && a.id !== activeAgentIdRef.current);
            nextAttMap.set(a.id, att);
            const prevAtt = prevAttMap.get(a.id) ?? false;

            if (a.status === "running") {
              nowRunning.push(a.id);
            } else if (a.id === activeAgentIdRef.current) {
              if (
                prevStatus === "running" ||
                liveAssistantRef.current.trim().length > 0 ||
                liveToolsRef.current.length > 0
              ) {
                activeFinished = true;
              }
            } else if (prevStatus === "running" || (att && !prevAtt)) {
              newlyDone.push(a.id);
            } else if (!att && prevAtt) {
              clearedAttention.push(a.id);
            }
          }
          prevStatusesRef.current = nextMap;
          prevAttentionRef.current = nextAttMap;
          if (activeFinished) {
            flushLiveTurnToStatic();
            if (activeAgentIdRef.current) {
              sendBridge({ cmd: "reload_timeline", agentId: activeAgentIdRef.current });
            }
          }
          if (newlyDone.length > 0 || nowRunning.length > 0 || clearedAttention.length > 0) {
            setCompletedAgentIds((prev) => {
              const next = new Set(prev);
              for (const id of nowRunning) next.delete(id);
              for (const id of clearedAttention) next.delete(id);
              for (const id of newlyDone) next.add(id);
              return next;
            });
          }
          setAgents(list);
          return;
        }

        if (msg.type === "agent_finished_notify") {
          if (!msg.silent && msg.agentId !== activeAgentIdRef.current) {
            sendDesktopNotification(msg.title || "hermes-tui", msg.preview || "✓ Terminé");
          }
          return;
        }

        if (msg.type === "timeline_prefetched") {
          const prefId: string = msg.agentId;
          if (!prefId || prefId === activeAgentIdRef.current) return;
          const tl: TimelineItem[] = msg.timeline ?? [];
          const fp = timelineFingerprint(tl);
          const existing = timelineCacheRef.current.get(prefId);
          if (existing && existing.fingerprint === fp) return;
          const agent = agentsRef.current.find((a) => a.id === prefId);
          timelineCacheRef.current.set(prefId, {
            entries: timelineToStaticEntries(tl, epochRef.current),
            commands: existing?.commands ?? FALLBACK_HERMES_COMMANDS,
            fingerprint: fp,
            updatedAt: agent?.updatedAt ?? "",
          });
          return;
        }

        if (msg.type === "agent_switched") {
          const nextId: string = msg.agentId;
          if (pendingSwitchIdRef.current && nextId !== pendingSwitchIdRef.current) {
            return;
          }
          pendingSwitchIdRef.current = null;
          setActiveAgentId(nextId);
          activeAgentIdRef.current = nextId;
          savePersistedState({ lastActiveAgentId: nextId });
          const active = agentsRef.current.find((a) => a.id === nextId);
          const tl: TimelineItem[] = msg.timeline ?? [];
          const cmds: SlashCommand[] = msg.commands ?? [];
          const fp = timelineFingerprint(tl);
          const cached = timelineCacheRef.current.get(nextId);
          if (cached && cached.fingerprint === fp) {
            cached.updatedAt = active?.updatedAt ?? cached.updatedAt;
            if (cmds.length > 0) {
              cached.commands = cmds;
              setHermesCommands(cmds);
            }
          } else {
            resetToAgentTimeline(active, tl, cmds);
          }
          if (!copyTimerRef.current) {
            setStatusNotice(null);
          }
          return;
        }

        if (msg.type === "timeline_reloaded") {
          if (msg.agentId !== activeAgentIdRef.current) return;
          const active = agentsRef.current.find((a) => a.id === msg.agentId);
          const tl: TimelineItem[] = msg.timeline ?? [];
          const fp = timelineFingerprint(tl);
          const cached = timelineCacheRef.current.get(msg.agentId);
          if (cached && cached.fingerprint === fp) return;
          resetToAgentTimeline(active, tl, [], true);
          return;
        }

        if (msg.type === "stream_event") {
          if (msg.agentId !== activeAgentIdRef.current) return;
          const m = msg.message;
          if (m?.type === "agent.timeline.replacement") {
            sendBridge({ cmd: "reload_timeline", agentId: msg.agentId });
            return;
          }
          if (m?.type !== "agent_stream") return;
          const ev = m.payload?.event;
          if (!ev) return;

          if (ev.type === "turn_started") {
            if (liveAssistantRef.current.trim().length > 0 || liveToolsRef.current.length > 0) {
              flushLiveTurnToStatic();
            }
            setIsStreaming(true);
            setIsThinking(false);
            setLiveAssistant("");
            setLiveTools([]);
            setCompletedAgentIds((prev) => {
              if (!prev.has(msg.agentId)) return prev;
              const next = new Set(prev);
              next.delete(msg.agentId);
              return next;
            });
          } else if (ev.type === "timeline") {
            const item: TimelineItem = ev.item;
            if (item.type === "user_message" && item.text) {
              flushLiveTurnToStatic();
              const incoming = item.text.trim();
              const optIdx = pendingOptimisticUsersRef.current.findIndex(
                (opt) => incoming === opt || incoming.startsWith(`${opt}\n\n[Fichiers joints`)
              );
              if (optIdx >= 0) {
                pendingOptimisticUsersRef.current.splice(optIdx, 1);
              } else {
                pushStatic({ kind: "user", text: incoming, timestamp: item.timestamp });
                scrollAnchorRef.current = null;
                setScrollOffset(0);
              }
            } else if (item.type === "reasoning") {
              setIsStreaming(true);
              setIsThinking(true);
            } else if (item.type === "assistant_message" && item.text) {
              setIsStreaming(true);
              setIsThinking(false);
              setLiveAssistant((prev) => prev + item.text);
            } else if (item.type === "tool_call") {
              setIsThinking(false);
              const step = extractToolStep(item);
              if (step) {
                const callId = item.callId || `tool-${Date.now()}`;
                setLiveTools((prev) => {
                  const idx = prev.findIndex((x) => x.callId === callId);
                  const nextItem: LiveTool = {
                    callId,
                    toolName: step.toolName,
                    title: step.title,
                    command: step.command,
                    output: step.output,
                    status: step.status,
                  };
                  if (idx >= 0) {
                    const copy = [...prev];
                    copy[idx] = nextItem;
                    return copy;
                  }
                  return [...prev, nextItem];
                });
              }
            } else if (item.type === "error" && item.message) {
              pushStatic({ kind: "error", text: item.message });
            } else if (item.type === "notification" && item.message) {
              pushStatic({ kind: "notice", text: item.message });
            }
          } else if (ev.type === "turn_completed") {
            flushLiveTurnToStatic();
            if (msg.agentId !== activeAgentIdRef.current) {
              setCompletedAgentIds((prev) => {
                const next = new Set(prev);
                next.add(msg.agentId);
                return next;
              });
            }
          } else if (ev.type === "turn_failed") {
            flushLiveTurnToStatic();
            pushStatic({ kind: "error", text: ev.error || "Tour échoué" });
          } else if (ev.type === "turn_canceled") {
            flushLiveTurnToStatic();
            pushStatic({ kind: "notice", text: "Tour annulé." });
          } else if (ev.type === "permission_requested" && ev.request) {
            const reqId = String(ev.request.id ?? ev.request.requestId ?? "");
            const rawActions = Array.isArray(ev.request.actions) && ev.request.actions.length > 0
              ? ev.request.actions.map((act: any) => ({
                  id: String(act.id ?? act.optionId ?? "allow_once"),
                  label: String(act.label ?? act.name ?? act.id ?? "Autoriser"),
                  kind: act.kind ? String(act.kind) : undefined,
                }))
              : [
                  { id: "allow_once", label: "Autoriser une fois", kind: "allow" },
                  { id: "allow_always", label: "Toujours autoriser", kind: "allow" },
                  { id: "deny", label: "Refuser", kind: "deny" },
                ];
            setPermission({
              agentId: msg.agentId,
              requestId: reqId,
              name: ev.request.title || ev.request.name || "Permission",
              description: ev.request.description,
              options: rawActions,
            });
            setModal("permission");
            setModalIdx(0);
            const permAgent = agentsRef.current.find((a) => a.id === msg.agentId);
            sendDesktopNotification(
              "hermes-tui — Permission requise",
              `${permAgent?.title ?? "Agent"} : ${ev.request.title || ev.request.name || "Action"}`
            );
          } else if (ev.type === "permission_resolved") {
            setPermission(null);
            setModal((prev) => (prev === "permission" ? "none" : prev));
          }
          return;
        }

        if (msg.type === "archived") {
          if (msg.agentId === activeAgentIdRef.current) {
            const next = agentsRef.current.find((a) => a.id !== msg.agentId);
            if (next) {
              activeAgentIdRef.current = null;
              switchAgentById(next.id);
            }
          }
          return;
        }

        if (msg.type === "notice") {
          setStatusNotice(msg.text);
          pushStatic({ kind: "notice", text: msg.text });
          return;
        }

        if (msg.type === "error" || msg.type === "fatal") {
          setStatusNotice(msg.message);
          pushStatic({ kind: "error", text: msg.message });
        }
      });

      proc.stdin.write(`${JSON.stringify({ cmd: "init", ...(activeAgentIdRef.current ? { agentId: activeAgentIdRef.current } : {}) })}\n`);
    };

    connectBridge();

    return () => {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      try {
        bridgeRef.current?.stdin.end();
        bridgeRef.current?.kill("SIGTERM");
      } catch {
        // ignore
      }
    };
  }, []);

  const allSlashCommands = useMemo(() => {
    const merged = [...LOCAL_COMMANDS];
    const seen = new Set(merged.map((c) => c.name));
    for (const c of hermesCommands) {
      if (!seen.has(c.name)) {
        seen.add(c.name);
        merged.push(c);
      }
    }
    return merged;
  }, [hermesCommands]);

  const orderedAgents = useMemo(() => {
    const enriched = agents.map((a) => ({ agent: a, ...getAgentTabGroupAndLabel(a, agents) }));
    enriched.sort(
      (x, y) =>
        x.group.localeCompare(y.group, "fr") ||
        x.label.localeCompare(y.label, "fr") ||
        x.agent.id.localeCompare(y.agent.id)
    );
    return enriched;
  }, [agents]);

  const thinkingChoices = useMemo(() => {
    const activeModelObj = models.find((m) => m.id === activeAgent?.model);
    if (activeModelObj && activeModelObj.thinkingOptions.length > 0) {
      return activeModelObj.thinkingOptions.map((t) => t.id);
    }
    return DEFAULT_THINKING_LEVELS;
  }, [models, activeAgent]);

  const modeChoices = useMemo(() => {
    if (activeAgent && activeAgent.availableModes.length > 0) {
      return activeAgent.availableModes.map((m) => ({
        id: m.id,
        label: m.label || m.name || m.id,
        description: m.description || "",
      }));
    }
    return [
      { id: "default", label: "Default", description: "Ask before edits" },
      { id: "accept_edits", label: "Accept Edits", description: "Auto-allow workspace edits" },
      { id: "dont_ask", label: "Don't Ask", description: "Auto-allow edits" },
    ];
  }, [activeAgent]);

  const slashSuggestions = useMemo(() => {
    if (!input.startsWith("/") || modal !== "none") return [];
    const firstSpace = input.indexOf(" ");
    if (firstSpace < 0) {
      const q = input.slice(1).toLowerCase();
      const starts = allSlashCommands.filter((c) => c.name.toLowerCase().startsWith(q));
      const descOnly = allSlashCommands.filter(
        (c) => !c.name.toLowerCase().startsWith(q) && c.description.toLowerCase().includes(q)
      );
      return [...starts.sort((a, b) => (a.name.toLowerCase() === q ? -1 : b.name.toLowerCase() === q ? 1 : 0)), ...descOnly].slice(0, 10);
    }

    const cmdName = input.slice(1, firstSpace).toLowerCase();
    const argRaw = input.slice(firstSpace + 1);
    const argQuery = argRaw.trim().toLowerCase();

    if (cmdName === "to" || cmdName === "forward") {
      const candidates = orderedAgents
        .filter((x) => x.agent.id !== activeAgentId)
        .map((x) => {
          const full = `${x.group} - ${x.label}`;
          const isUniqueLabel =
            orderedAgents.filter((y) => y.label.toLowerCase() === x.label.toLowerCase()).length === 1;
          const token = isUniqueLabel ? x.label : full;
          return { ...x, full, token, isUniqueLabel };
        });

      // Once a valid target session is followed by a trailing space, close dropdown so user can type their consigne
      const argLower = argRaw.toLowerCase();
      const alreadyCompletedTarget = candidates.some(
        (c) =>
          argLower.startsWith(`${c.full.toLowerCase()} `) ||
          argLower.startsWith(`${c.group.toLowerCase()}-${c.label.toLowerCase()} `) ||
          (c.isUniqueLabel && argLower.startsWith(`${c.label.toLowerCase()} `))
      );
      if (alreadyCompletedTarget) return [];

      return candidates
        .filter((c) => fuzzyMatch(argQuery, `${c.full} ${c.agent.title}`))
        .slice(0, 10)
        .map((c) => ({
          name: `${cmdName} ${c.token}`,
          displayName: `/${cmdName} ${c.token}`,
          argumentHint: "[texte]",
          description: `Transférer la dernière réponse vers ${c.full}`,
          isLocal: true,
          fillValue: `/${cmdName} ${c.token} `,
          submitOnEnter: true,
        }));
    }

    if (cmdName === "sessions" || cmdName === "session" || cmdName === "agent" || cmdName === "agents") {
      return orderedAgents
        .filter((x) => fuzzyMatch(argQuery, `${x.group} - ${x.label} ${x.agent.title}`))
        .slice(0, 10)
        .map((x) => {
          const full = `${x.group} - ${x.label}`;
          const isUnique =
            orderedAgents.filter((y) => y.label.toLowerCase() === x.label.toLowerCase()).length === 1;
          const token = isUnique ? x.label : full;
          return {
            name: `${cmdName} ${full}`,
            displayName: `/${cmdName} ${token}`,
            description: `Basculer sur ${full}${x.agent.id === activeAgentId ? " ★" : ""}`,
            isLocal: true,
            fillValue: `/${cmdName} ${full}`,
            submitOnEnter: true,
          };
        });
    }

    if (cmdName === "thinking") {
      return thinkingChoices
        .filter((lvl) => lvl.toLowerCase().includes(argQuery))
        .map((lvl) => ({
          name: `thinking ${lvl}`,
          displayName: `/thinking ${lvl}`,
          description: `Niveau de raisonnement ${lvl}${lvl === activeAgent?.thinkingOptionId ? " ★" : ""}`,
          isLocal: true,
          fillValue: `/thinking ${lvl}`,
          submitOnEnter: true,
        }));
    }

    if (cmdName === "mode") {
      return modeChoices
        .filter((m) => fuzzyMatch(argQuery, `${m.id} ${m.label} ${m.description}`))
        .map((m) => ({
          name: `mode ${m.id}`,
          displayName: `/mode ${m.id}`,
          description: `${m.label} — ${m.description}${m.id === activeAgent?.modeId ? " ★" : ""}`,
          isLocal: true,
          fillValue: `/mode ${m.id}`,
          submitOnEnter: true,
        }));
    }

    if (cmdName === "model") {
      return models
        .filter((m) => fuzzyMatch(argQuery, `${m.label} ${m.id}`))
        .slice(0, 10)
        .map((m) => ({
          name: `model ${m.id}`,
          displayName: `/model ${m.id}`,
          description: `${m.label}${m.id === activeAgent?.model ? " ★" : ""}`,
          isLocal: true,
          fillValue: `/model ${m.id}`,
          submitOnEnter: true,
        }));
    }

    if (cmdName === "copy" || cmdName === "cp") {
      const opts: SlashCommand[] = [
        {
          name: `${cmdName}`,
          displayName: `/${cmdName}`,
          description: "Copier toute la dernière réponse de l'agent",
          isLocal: true,
          fillValue: `/${cmdName}`,
          submitOnEnter: true,
        },
        {
          name: `${cmdName} code`,
          displayName: `/${cmdName} code`,
          description: "Copier uniquement le dernier bloc de code",
          isLocal: true,
          fillValue: `/${cmdName} code`,
          submitOnEnter: true,
        },
      ];
      return opts.filter((o) => !argQuery || "code".includes(argQuery));
    }

    return [];
  }, [input, modal, allSlashCommands, orderedAgents, activeAgentId, thinkingChoices, modeChoices, models, activeAgent]);

  const filteredAgents = useMemo(() => {
    return agents.filter((a) => fuzzyMatch(modalFilter, `${a.title} ${a.projectName} ${a.workspaceName} ${a.cwd}`));
  }, [agents, modalFilter]);

  const filteredModels = useMemo(() => {
    return models.filter((m) => fuzzyMatch(modalFilter, `${m.label} ${m.id}`)).slice(0, 14);
  }, [models, modalFilter]);

  function openModal(kind: ModalKind): void {
    setModal(kind);
    setModalFilter("");
    setModalIdx(0);
  }

  function switchAgentById(id: string): void {
    const prevId = activeAgentIdRef.current;
    if (!id || id === prevId) {
      setModal("none");
      return;
    }
    const target = agentsRef.current.find((a) => a.id === id);
    if (prevId) {
      if (inputRef.current || attachmentsRef.current.length > 0) {
        draftsRef.current.set(prevId, {
          text: inputRef.current,
          cursor: cursorRef.current,
          attachments: attachmentsRef.current,
          pastedTexts: Array.from(pastedTextsRef.current.entries()),
        });
      } else {
        draftsRef.current.delete(prevId);
      }
    }
    const nextDraft = draftsRef.current.get(id);
    if (nextDraft) {
      pastedTextsRef.current = new Map(nextDraft.pastedTexts);
      setPrompt(nextDraft.text, nextDraft.cursor);
      setAttachments(nextDraft.attachments);
    } else {
      pastedTextsRef.current = new Map();
      setPrompt("", 0);
      setAttachments([]);
    }
    pendingSwitchIdRef.current = id;
    activeAgentIdRef.current = id;
    setActiveAgentId(id);
    savePersistedState({ lastActiveAgentId: id });
    prevAttentionRef.current.set(id, false);
    if (prevId) prevAttentionRef.current.set(prevId, false);
    setCompletedAgentIds((prev) => {
      if (!prev.has(id) && !(prevId && prev.has(prevId))) return prev;
      const next = new Set(prev);
      next.delete(id);
      if (prevId) next.delete(prevId);
      return next;
    });
    const cached = timelineCacheRef.current.get(id);
    if (cached) {
      setStaticItems(cached.entries);
      setHermesCommands(cached.commands.length > 0 ? cached.commands : FALLBACK_HERMES_COMMANDS);
      const stale = target?.status === "running" || Boolean(target?.updatedAt && target.updatedAt !== cached.updatedAt);
      if (!copyTimerRef.current) {
        setStatusNotice(stale ? "Synchronisation…" : null);
      }
    } else {
      setStaticItems([]);
      if (!copyTimerRef.current) {
        setStatusNotice(`Chargement de ${target?.title ?? id}…`);
      }
    }
    setLiveAssistant("");
    setLiveTools([]);
    setIsStreaming(target?.status === "running");
    setIsThinking(false);
    scrollAnchorRef.current = null;
    pendingOptimisticUsersRef.current = [];
    setScrollOffset(0);
    setModal("none");
    sendBridge({ cmd: "switch_agent", agentId: id });
  }

  function showTransientCopyNotice(notice: string, durationMs = 2200): void {
    setStatusNotice(notice);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    copyTimerRef.current = setTimeout(() => {
      copyTimerRef.current = null;
      setStatusNotice((n) => (n === notice ? null : n));
    }, durationMs);
  }

  function forwardLatestToSession(rawArg: string): void {
    const assistantTexts: string[] = [];
    for (const it of staticItemsRef.current) {
      if (it.kind === "assistant" && it.text.trim()) {
        assistantTexts.push(it.text.trim());
      }
    }
    if (liveAssistantRef.current.trim()) {
      const filtered = filterNoReply(liveAssistantRef.current.replace(/^\n+/, ""));
      if (!filtered.isSilentOnly && filtered.text.trim()) {
        assistantTexts.push(filtered.text.trim());
      }
    }
    if (assistantTexts.length === 0) {
      showTransientCopyNotice("Aucune réponse à transférer dans cette session.");
      return;
    }

    const cleanArg = rawArg.trim();
    if (!cleanArg) {
      setPrompt("/to ", 4);
      setSlashIdx(0);
      return;
    }

    const candidates = [
      ...orderedAgents.filter((x) => x.agent.id !== activeAgentId),
      ...orderedAgents.filter((x) => x.agent.id === activeAgentId),
    ];

    let matchedTarget: (typeof orderedAgents)[number] | undefined;
    let consigne = "";

    const prefixEntries: Array<{ prefix: string; item: (typeof orderedAgents)[number] }> = [];
    for (const item of candidates) {
      const full = `${item.group} - ${item.label}`;
      const dash = `${item.group}-${item.label}`;
      prefixEntries.push({ prefix: full, item });
      prefixEntries.push({ prefix: dash, item });
      if (item.agent.title) prefixEntries.push({ prefix: item.agent.title, item });
      prefixEntries.push({ prefix: item.label, item });
    }
    prefixEntries.sort((a, b) => b.prefix.length - a.prefix.length);

    const lowerArg = cleanArg.toLowerCase();
    for (const { prefix, item } of prefixEntries) {
      const pLow = prefix.toLowerCase();
      if (lowerArg === pLow || lowerArg.startsWith(`${pLow} `)) {
        matchedTarget = item;
        consigne = cleanArg.slice(prefix.length).trim();
        break;
      }
    }

    if (!matchedTarget) {
      const [firstWord, ...restWords] = cleanArg.split(/\s+/);
      matchedTarget = candidates.find((x) =>
        fuzzyMatch(firstWord, `${x.group} - ${x.label} ${x.agent.title}`)
      );
      consigne = restWords.join(" ").trim();
    }

    if (!matchedTarget) {
      showTransientCopyNotice(`Session cible introuvable : "${cleanArg}"`);
      return;
    }

    const latestReply = assistantTexts[assistantTexts.length - 1];
    const srcInfo = activeAgent ? getAgentTabGroupAndLabel(activeAgent, agents) : { group: "Session", label: "" };
    const sourceFull = srcInfo.label ? `${srcInfo.group} - ${srcInfo.label}` : srcInfo.group;
    const targetFull = `${matchedTarget.group} - ${matchedTarget.label}`;
    const forwardedBlock = `[Transféré depuis ${sourceFull}]\n${latestReply}`;

    pasteSeqRef.current += 1;
    const id = pasteSeqRef.current;
    const lineCount = forwardedBlock.split("\n").length;
    const tokenLabel = `[Pasted #${id} +${lineCount} lines]`;
    const promptText = consigne ? `${tokenLabel} ${consigne}` : `${tokenLabel} `;

    const existingDraft = draftsRef.current.get(matchedTarget.agent.id);
    const nextPasted: Array<[string, string]> = existingDraft
      ? [...existingDraft.pastedTexts, [tokenLabel, forwardedBlock]]
      : [[tokenLabel, forwardedBlock]];

    draftsRef.current.set(matchedTarget.agent.id, {
      text: promptText,
      cursor: promptText.length,
      attachments: existingDraft?.attachments ?? [],
      pastedTexts: nextPasted,
    });

    showTransientCopyNotice(`↪ Transféré depuis ${sourceFull} vers ${targetFull} (Entrée pour envoyer)`, 3200);
    switchAgentById(matchedTarget.agent.id);
  }

  function copyLatestFromConversation(mode: "auto" | "all" | "code"): void {
    const assistantTexts: string[] = [];
    for (const it of staticItemsRef.current) {
      if (it.kind === "assistant" && it.text.trim()) {
        assistantTexts.push(it.text.trim());
      }
    }
    if (liveAssistantRef.current.trim()) {
      const filtered = filterNoReply(liveAssistantRef.current.replace(/^\n+/, ""));
      if (!filtered.isSilentOnly && filtered.text.trim()) {
        assistantTexts.push(filtered.text.trim());
      }
    }
    if (assistantTexts.length === 0) {
      showTransientCopyNotice("Aucune réponse à copier.");
      return;
    }

    const extractCodeBlocks = (md: string): string[] => {
      const blocks: string[] = [];
      const re = /```[^\n]*\n([\s\S]*?)```/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(md)) !== null) {
        if (m[1]?.trim()) blocks.push(m[1].replace(/\s+$/, ""));
      }
      return blocks;
    };

    const latestReply = assistantTexts[assistantTexts.length - 1];
    if (mode === "all") {
      copyToClipboard(latestReply);
      showTransientCopyNotice("✓ Dernière réponse copiée");
      return;
    }

    const latestBlocks = extractCodeBlocks(latestReply);
    if (latestBlocks.length > 0) {
      const picked = latestBlocks[latestBlocks.length - 1];
      copyToClipboard(picked);
      const lineCount = picked.split("\n").length;
      const oneLine = picked.replace(/\s+/g, " ").trim();
      showTransientCopyNotice(
        lineCount > 1
          ? `✓ Dernier bloc de code copié (${lineCount} lignes)`
          : `✓ Code copié : ${oneLine.length > 40 ? `${oneLine.slice(0, 39)}…` : oneLine}`
      );
      return;
    }

    if (mode === "code") {
      for (let i = assistantTexts.length - 2; i >= 0; i--) {
        const blocks = extractCodeBlocks(assistantTexts[i]);
        if (blocks.length > 0) {
          const picked = blocks[blocks.length - 1];
          copyToClipboard(picked);
          showTransientCopyNotice(`✓ Dernier bloc de code copié (${picked.split("\n").length} lignes)`);
          return;
        }
      }
      showTransientCopyNotice("Aucun bloc de code trouvé.");
      return;
    }

    copyToClipboard(latestReply);
    showTransientCopyNotice("✓ Dernière réponse copiée");
  }

  function setPrompt(text: string, pos: number = text.length): void {
    const clamped = Math.max(0, Math.min(text.length, pos));
    inputRef.current = text;
    cursorRef.current = clamped;
    setInput(text);
    setCursor(clamped);
  }

  function insertAtCursor(addition: string): void {
    const curText = inputRef.current;
    const pos = cursorRef.current;
    setPrompt(curText.slice(0, pos) + addition + curText.slice(pos), pos + addition.length);
  }

  function cleanupRemovedPastedTokens(nextText: string): void {
    for (const token of Array.from(pastedTextsRef.current.keys())) {
      if (!nextText.includes(token)) {
        pastedTextsRef.current.delete(token);
      }
    }
  }

  function deletePromptWordBackward(): void {
    const curText = inputRef.current;
    const pos = cursorRef.current;
    if (!curText && attachmentsRef.current.length > 0) {
      setAttachments((prev) => prev.slice(0, -1));
      return;
    }
    if (pos <= 0) return;
    const cutAt = moveCursorWordLeft(curText, pos);
    const nextText = curText.slice(0, cutAt) + curText.slice(pos);
    cleanupRemovedPastedTokens(nextText);
    setPrompt(nextText, cutAt);
    setSlashIdx(0);
  }

  function deletePromptWordForward(): void {
    const curText = inputRef.current;
    const pos = cursorRef.current;
    if (pos >= curText.length) return;
    const cutTo = moveCursorWordRight(curText, pos);
    const nextText = curText.slice(0, pos) + curText.slice(cutTo);
    cleanupRemovedPastedTokens(nextText);
    setPrompt(nextText, pos);
    setSlashIdx(0);
  }

  function insertSmartPaste(rawText: string): void {
    const normalized = rawText.replace(/\r\n/g, "\n");
    if (!normalized) return;
    const lineCount = normalized.split("\n").length;
    if (lineCount >= 4 || normalized.length >= 250) {
      pasteSeqRef.current += 1;
      const id = pasteSeqRef.current;
      const label =
        lineCount >= 4
          ? `[Pasted #${id} +${lineCount} lines]`
          : `[Pasted #${id} · ${normalized.length} chars]`;
      pastedTextsRef.current.set(label, normalized);
      insertAtCursor(label);
    } else {
      insertAtCursor(normalized);
    }
  }

  function handleSubmitLine(raw: string): void {
    let expanded = raw;
    for (const [token, content] of pastedTextsRef.current.entries()) {
      if (expanded.includes(token)) {
        expanded = expanded.split(token).join(content);
      }
    }
    let trimmed = expanded.trim();
    const pendingFiles = attachmentsRef.current;
    if (!trimmed && pendingFiles.length === 0) return;
    if (!trimmed) trimmed = pendingFiles.length > 1 ? "Voici les fichiers joints." : "Voici le fichier joint.";

    pastedTextsRef.current.clear();
    setPromptHistory((prev) => {
      const next = [trimmed, ...prev.filter((p) => p !== trimmed).slice(0, 49)];
      savePersistedState({ promptHistory: next });
      return next;
    });
    setHistoryIdx(-1);
    setPrompt("", 0);

    if (trimmed.startsWith("/")) {
      const [cmdPart, ...rest] = trimmed.slice(1).split(/\s+/);
      const cmdName = (cmdPart || "").toLowerCase();
      const arg = rest.join(" ").trim();

      if (cmdName === "quit" || cmdName === "exit" || cmdName === "q") {
        intentionalCloseRef.current = true;
        if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
        bridgeRef.current?.stdin.end();
        bridgeRef.current?.kill("SIGTERM");
        cleanupTerminalScreen();
        exit();
        return;
      }
      if (cmdName === "copy" || cmdName === "cp") {
        const sub = arg.toLowerCase();
        copyLatestFromConversation(sub === "code" ? "code" : "all");
        return;
      }
      if (cmdName === "to" || cmdName === "forward") {
        forwardLatestToSession(arg);
        return;
      }
      if (cmdName === "new") {
        const cleanArg = arg.replace(/^["']|["']$/g, "").trim();
        const basePersona =
          activeAgent?.title?.split(" - ")[0]?.trim() || activeAgent?.projectName?.trim() || "";
        let finalTitle = cleanArg;
        if (basePersona) {
          if (!cleanArg) {
            finalTitle = `${basePersona} - Session`;
          } else if (!cleanArg.toLowerCase().startsWith(`${basePersona.toLowerCase()} - `)) {
            finalTitle = `${basePersona} - ${cleanArg}`;
          }
        }
        setStatusNotice("Création de la session…");
        sendBridge({ cmd: "create_agent", fromAgentId: activeAgentId, ...(finalTitle ? { title: finalTitle } : {}) });
        return;
      }
      if (cmdName === "title" || cmdName === "rename") {
        const cleanArg = arg.replace(/^["']|["']$/g, "").trim();
        if (!cleanArg) {
          setStatusNotice("Usage : /title <nouveau nom>");
          return;
        }
        const basePersona =
          activeAgent?.title?.split(" - ")[0]?.trim() || activeAgent?.projectName?.trim() || "";
        const finalTitle =
          basePersona && !cleanArg.toLowerCase().startsWith(`${basePersona.toLowerCase()} - `)
            ? `${basePersona} - ${cleanArg}`
            : cleanArg;
        if (activeAgentId) {
          setStatusNotice("Renommage de la session…");
          sendBridge({ cmd: "rename_agent", agentId: activeAgentId, name: finalTitle });
        }
        return;
      }
      if (cmdName === "clear") {
        setStaticItems([]);
        scrollAnchorRef.current = null;
        setScrollOffset(0);
        setSessionEpoch((e) => e + 1);
        return;
      }
      if (cmdName === "archive") {
        if (activeAgentId) {
          setStatusNotice("Archivage de la session…");
          sendBridge({ cmd: "archive_agent", agentId: activeAgentId });
        }
        return;
      }
      if (cmdName === "reset") {
        if (activeAgentId) {
          setStatusNotice("Réinitialisation de la session…");
          sendBridge({ cmd: "reset_agent", agentId: activeAgentId });
        }
        return;
      }
      if (cmdName === "reload") {
        if (activeAgentId) sendBridge({ cmd: "reload_timeline", agentId: activeAgentId });
        return;
      }
      if (cmdName === "sessions" || cmdName === "session" || cmdName === "agent" || cmdName === "agents") {
        if (arg) {
          const match = orderedAgents.find((x) =>
            fuzzyMatch(arg, `${x.group} - ${x.label} ${x.agent.title} ${x.agent.projectName}`)
          );
          if (match) {
            switchAgentById(match.agent.id);
            return;
          }
        }
        openModal("agents");
        if (arg) setModalFilter(arg);
        return;
      }
      if (cmdName === "model") {
        if (!arg) {
          openModal("models");
          return;
        }
        const exact = models.find((m) => m.id === arg || m.label.toLowerCase() === arg.toLowerCase());
        if (exact && activeAgentId) {
          sendBridge({ cmd: "set_model", agentId: activeAgentId, modelId: exact.id });
          return;
        }
      }
      if (cmdName === "thinking") {
        if (!arg) {
          openModal("thinking");
          return;
        }
        if (activeAgentId) {
          sendBridge({ cmd: "set_thinking", agentId: activeAgentId, thinkingId: arg });
          return;
        }
      }
      if (cmdName === "mode") {
        if (!arg) {
          openModal("modes");
          return;
        }
        if (activeAgentId) {
          sendBridge({ cmd: "set_mode", agentId: activeAgentId, modeId: arg });
          return;
        }
      }
    }

    if (!activeAgentId) {
      pushStatic({ kind: "error", text: "Aucun agent actif sélectionné." });
      return;
    }
    if (liveAssistantRef.current.trim().length > 0 || liveToolsRef.current.length > 0) {
      flushLiveTurnToStatic();
    }
    const optimisticDisplay =
      pendingFiles.length > 0
        ? `${trimmed}\n📎 ${pendingFiles.map((f) => `${f.name} (${formatSize(f.size)})`).join(" · ")}`
        : trimmed;
    pendingOptimisticUsersRef.current.push(trimmed);
    pushStatic({ kind: "user", text: optimisticDisplay, timestamp: new Date().toISOString() });
    scrollAnchorRef.current = null;
    setScrollOffset(0);
    setIsStreaming(true);
    setCompletedAgentIds((prev) => {
      if (!prev.has(activeAgentId)) return prev;
      const next = new Set(prev);
      next.delete(activeAgentId);
      return next;
    });
    sendBridge({
      cmd: "send",
      agentId: activeAgentId,
      text: trimmed,
      behavior: activeAgent?.status === "running" ? "steer" : "interrupt",
      ...(pendingFiles.length > 0
        ? { files: pendingFiles.map((f) => ({ name: f.name, mimeType: f.mimeType, data: f.data })) }
        : {}),
    });
    if (pendingFiles.length > 0) setAttachments([]);
  }

  const contentWidth = Math.max(40, termCols - 2);
  const topTabs = useMemo(
    () => buildTopTabsLayout(agents, activeAgentId, completedAgentIds, contentWidth, SPINNER_FRAMES[spinnerFrame]),
    [agents, activeAgentId, completedAgentIds, contentWidth, spinnerFrame]
  );

  const busy = isStreaming || activeAgent?.status === "running";
  const spinner = SPINNER_FRAMES[spinnerFrame];

  // Static history is rendered once per (items, width, details) — NOT on every keystroke/spinner tick.
  const staticLines = useMemo(
    () => buildConversationLines(staticItems, [], "", false, "", showDetails, contentWidth),
    [staticItems, showDetails, contentWidth]
  );
  // Live part (streaming tokens/tools) with a spinner placeholder swapped in cheaply at render time.
  const liveLines = useMemo(
    () => buildConversationLines([], liveTools, liveAssistant, busy, "\u0001", showDetails, contentWidth, isThinking),
    [liveTools, liveAssistant, busy, showDetails, contentWidth, isThinking]
  );
  const conversationLines = useMemo(() => {
    const live = busy ? liveLines.map((l) => (l.includes("\u0001") ? l.replace("\u0001", spinner) : l)) : liveLines;
    if (staticLines.length > 0 && live.length > 0) return [...staticLines, "", ...live];
    return [...staticLines, ...live];
  }, [staticLines, liveLines, busy, spinner]);

  const promptLines = useMemo(() => input.split("\n"), [input]);
  const visiblePromptRows = Math.min(5, Math.max(1, promptLines.length));
  const rootHeight = Math.max(12, termRows - 1);
  const hasTopInfoLine = connecting || Boolean(statusNotice) || scrollOffset > 0;
  const topBarHeight = topTabs.rows.length + 1 + (hasTopInfoLine ? 1 : 0); // tab rows + optional info line + borderBottom
  const promptHeight = 2 + visiblePromptRows + (attachments.length > 0 ? 1 : 0); // borderTop + lines + borderBottom + attachments row
  const statusBarHeight = 1;
  const searchHeight = searchOpen ? 1 : 0;
  const slashHeight = slashSuggestions.length > 0 ? slashSuggestions.length + 2 : 0;

  let modalHeight = 0;
  if (modal === "agents") {
    modalHeight = Math.max(1, Math.min(filteredAgents.length, 14)) + 3;
  } else if (modal === "models") {
    modalHeight = Math.max(1, Math.min(filteredModels.length, 14)) + 3;
  } else if (modal === "thinking") {
    modalHeight = thinkingChoices.length + 3;
  } else if (modal === "modes") {
    modalHeight = modeChoices.length + 3;
  } else if (modal === "permission" && permission) {
    modalHeight = permission.options.length + 3 + (permission.description ? 1 : 0);
  }

  const viewportHeight = Math.max(
    4,
    rootHeight - topBarHeight - promptHeight - statusBarHeight - searchHeight - slashHeight - modalHeight
  );
  const maxScroll = Math.max(0, conversationLines.length - viewportHeight);
  let effectiveScroll = Math.min(scrollOffset, maxScroll);
  if (scrollOffset > 0 && scrollAnchorRef.current !== null) {
    const anchoredEnd = Math.max(
      Math.min(viewportHeight, conversationLines.length),
      Math.min(conversationLines.length, scrollAnchorRef.current)
    );
    effectiveScroll = Math.max(0, Math.min(maxScroll, conversationLines.length - anchoredEnd));
  }
  const sliceEnd = Math.max(0, conversationLines.length - effectiveScroll);
  const sliceStart = Math.max(0, sliceEnd - viewportHeight);
  const visibleConversation = conversationLines.slice(sliceStart, sliceEnd);
  const viewportStartRow = topBarHeight + 1;
  const paddedConversation =
    visibleConversation.length < viewportHeight
      ? [...Array(viewportHeight - visibleConversation.length).fill(""), ...visibleConversation]
      : visibleConversation;

  function updateScrollOffset(nextOrUpdater: number | ((prev: number) => number)): void {
    setScrollOffset((prev) => {
      const base =
        prev > 0 && scrollAnchorRef.current !== null
          ? Math.max(0, Math.min(maxScroll, conversationLines.length - scrollAnchorRef.current))
          : prev;
      const rawNext = typeof nextOrUpdater === "function" ? nextOrUpdater(base) : nextOrUpdater;
      const clamped = Math.max(0, Math.min(maxScroll, rawNext));
      scrollAnchorRef.current = clamped > 0 ? conversationLines.length - clamped : null;
      return clamped;
    });
  }

  useEffect(() => {
    if (scrollOffset > 0 && effectiveScroll !== scrollOffset) {
      setScrollOffset(effectiveScroll);
    }
  }, [effectiveScroll, scrollOffset]);

  const searchMatches = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!searchOpen || !q) return [] as number[];
    const matches: number[] = [];
    for (let i = 0; i < conversationLines.length; i++) {
      if (stripAnsi(conversationLines[i]).toLowerCase().includes(q)) {
        matches.push(i);
      }
    }
    return matches;
  }, [conversationLines, searchOpen, searchQuery]);

  function jumpToSearchLine(lineIdx: number): void {
    const desiredEnd = Math.min(conversationLines.length, lineIdx + Math.ceil(viewportHeight / 2));
    const nextScroll = Math.max(0, Math.min(maxScroll, conversationLines.length - desiredEnd));
    updateScrollOffset(nextScroll);
  }

  const displayedConversation = useMemo(() => {
    let base = paddedConversation;

    if (searchOpen && searchQuery.trim() && searchMatches.length > 0) {
      const q = searchQuery.trim();
      const qRe = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi");
      const activeLineIdx = searchMatches[((searchMatchIdx % searchMatches.length) + searchMatches.length) % searchMatches.length];
      const padOffset = Math.max(0, viewportHeight - visibleConversation.length);
      base = base.map((line, idx) => {
        const convIdx = idx >= padOffset ? sliceStart + (idx - padOffset) : -1;
        if (convIdx < 0) return line;
        const plain = stripAnsi(line);
        if (!qRe.test(plain)) return line;
        qRe.lastIndex = 0;
        const isCurrentMatch = convIdx === activeLineIdx;
        return plain.replace(qRe, (m) =>
          isCurrentMatch ? chalk.bgYellow.black.bold(m) : chalk.bgGray.whiteBright(m)
        );
      });
    }

    if (!selection || (selection.r1 === selection.r2 && Math.abs(selection.c1 - selection.c2) <= 1)) {
      return base;
    }
    const forward = selection.r1 < selection.r2 || (selection.r1 === selection.r2 && selection.c1 <= selection.c2);
    const startRow = forward ? selection.r1 : selection.r2;
    const startCol = forward ? selection.c1 : selection.c2;
    const endRow = forward ? selection.r2 : selection.r1;
    const endCol = forward ? selection.c2 : selection.c1;

    return base.map((line, idx) => {
      const termRow = viewportStartRow + idx;
      if (termRow < startRow || termRow > endRow) return line;
      const plain = stripAnsi(line);
      const fromCol = termRow === startRow ? Math.max(0, startCol - 2) : 0;
      const toCol = termRow === endRow ? Math.max(fromCol, endCol - 1) : Number.MAX_SAFE_INTEGER;
      if (toCol <= fromCol) return line;
      const before = sliceCols(plain, 0, fromCol);
      const selected = sliceCols(plain, fromCol, toCol);
      const after = sliceCols(plain, toCol, Number.MAX_SAFE_INTEGER);
      return `${before}${chalk.bgHex("#3a3a3c").whiteBright(selected)}${after}`;
    });
  }, [paddedConversation, selection, viewportStartRow, searchOpen, searchQuery, searchMatches, searchMatchIdx, viewportHeight, visibleConversation.length, sliceStart]);

  function triggerClipboardPaste(): void {
    if (modal !== "none") return;
    setStatusNotice("Lecture du presse-papiers…");
    readClipboard()
      .then(({ attachments: got, text }) => {
        if (got.length > 0) {
          setAttachments((prev) => [...prev, ...got]);
          setStatusNotice(null);
        } else if (text) {
          insertSmartPaste(text);
          setStatusNotice(null);
        } else {
          setStatusNotice("Presse-papiers vide.");
          setTimeout(() => setStatusNotice((n) => (n === "Presse-papiers vide." ? null : n)), 2000);
        }
      })
      .catch((err) => setStatusNotice(String(err?.message || err)));
  }

  function applyPastedString(rawText: string): void {
    const clean = rawText.replace(/\x1b\[20[01]~/g, "").replace(/\[20[01]~/g, "");
    const maybePath = normalizePastedPath(clean);
    if (maybePath) {
      try {
        const att = attachmentFromFile(maybePath);
        if (att) {
          setAttachments((prev) => [...prev, att]);
          return;
        }
      } catch (err) {
        setStatusNotice(String((err as Error)?.message || err));
        return;
      }
    }
    const normalized = clean.replace(/\r\n/g, "\n");
    if (normalized) {
      insertSmartPaste(normalized);
      setSlashIdx(0);
    }
  }

  useInput((char, key) => {
    // Handle bracketed paste (\x1b[200~ ... \x1b[201~) sent by terminals on Shift+Insert / Super+V
    if (char && (bracketPasteActiveRef.current || char.includes("[200~") || char.includes("[201~"))) {
      let chunk = char;
      if (chunk.includes("[200~")) {
        bracketPasteActiveRef.current = true;
        bracketPasteBufRef.current = "";
        chunk = chunk.slice(chunk.indexOf("[200~") + 5);
      }
      if (chunk.includes("[201~")) {
        const endIdx = chunk.indexOf("[201~");
        bracketPasteBufRef.current += chunk.slice(0, endIdx).replace(/\x1b$/, "");
        bracketPasteActiveRef.current = false;
        const payload = bracketPasteBufRef.current;
        bracketPasteBufRef.current = "";
        applyPastedString(payload);
        return;
      }
      if (bracketPasteActiveRef.current) {
        bracketPasteBufRef.current += chunk;
        return;
      }
    }

    // Handle SGR mouse sequences before any key processing so clicks/drags/scrolls never leak into prompt text
    if (char && (char.includes("[<") || char.startsWith("[M"))) {
      let matched = false;
      SGR_MOUSE_RE.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = SGR_MOUSE_RE.exec(char)) !== null) {
        matched = true;
        const btn = Number(m[1]);
        const col = Number(m[2]);
        const row = Number(m[3]);
        const kind = m[4];

        if (btn === 0 && kind === "M") {
          const hit = topTabs.hitBoxes.find(
            (b) => b.row === row && col >= b.startCol && col <= b.endCol
          );
          if (hit) {
            setSelection(null);
            switchAgentById(hit.agentId);
            return;
          }
          if (
            topTabs.menuHitBox &&
            topTabs.menuHitBox.row === row &&
            col >= topTabs.menuHitBox.startCol &&
            col <= topTabs.menuHitBox.endCol
          ) {
            setSelection(null);
            openModal(modal === "agents" ? "none" : "agents");
            return;
          }
          if (row >= viewportStartRow && row < viewportStartRow + viewportHeight) {
            setSelection({ r1: row, c1: col, r2: row, c2: col });
          } else {
            setSelection(null);
          }
        } else if (btn === 32 && kind === "M") {
          const cur = selectionRef.current;
          if (cur) {
            const clampedRow = Math.max(viewportStartRow, Math.min(viewportStartRow + viewportHeight - 1, row));
            setSelection({ ...cur, r2: clampedRow, c2: col });
          }
        } else if (btn === 0 && kind === "m") {
          const sel = selectionRef.current;
          const isSingleClick = Boolean(sel && sel.r1 === sel.r2 && Math.abs(sel.c1 - sel.c2) <= 1);
          if (sel && !isSingleClick) {
            const forward = sel.r1 < sel.r2 || (sel.r1 === sel.r2 && sel.c1 <= sel.c2);
            const startRow = forward ? sel.r1 : sel.r2;
            const startCol = forward ? sel.c1 : sel.c2;
            const endRow = forward ? sel.r2 : sel.r1;
            const endCol = forward ? sel.c2 : sel.c1;

            const extractedLines: string[] = [];
            for (let r = Math.max(viewportStartRow, startRow); r <= Math.min(viewportStartRow + viewportHeight - 1, endRow); r++) {
              const lineIdx = r - viewportStartRow;
              const plain = stripAnsi(paddedConversation[lineIdx] ?? "");
              const fromCol = r === startRow ? Math.max(0, startCol - 2) : 0;
              const toCol = r === endRow ? Math.max(fromCol, endCol - 1) : Number.MAX_SAFE_INTEGER;
              extractedLines.push(sliceCols(plain, fromCol, toCol).trimEnd());
            }
            const copied = extractedLines.join("\n").trim();
            if (copied) {
              copyToClipboard(copied);
              showTransientCopyNotice("✓ Copié dans le presse-papiers");
            }
            setTimeout(() => setSelection(null), 160);
          } else if (sel && isSingleClick) {
            setSelection(null);
            const lineIdx = sel.r1 - viewportStartRow;
            const padOffset = Math.max(0, viewportHeight - visibleConversation.length);
            const convIdx = lineIdx >= padOffset ? sliceStart + (lineIdx - padOffset) : -1;
            const codeHit = extractClickableCodeAt(conversationLines, convIdx, sel.c1);
            if (codeHit && codeHit.text) {
              copyToClipboard(codeHit.text);
              if (codeHit.kind === "block") {
                showTransientCopyNotice(`✓ Bloc de code copié (${codeHit.text.split("\n").length} lignes)`);
              } else {
                const oneLine = codeHit.text.replace(/\s+/g, " ").trim();
                const preview = oneLine.length > 42 ? `${oneLine.slice(0, 41)}…` : oneLine;
                showTransientCopyNotice(`✓ Code copié : ${preview}`);
              }
            }
          } else {
            setSelection(null);
          }
        } else if (btn === 64) {
          setSelection(null);
          updateScrollOffset((s) => s + 3);
        } else if (btn === 65) {
          setSelection(null);
          updateScrollOffset((s) => s - 3);
        }
      }
      if (matched || char.startsWith("[<") || char.startsWith("[M")) {
        return;
      }
    }

    if (key.ctrl && char === "c") {
      intentionalCloseRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      bridgeRef.current?.stdin.end();
      bridgeRef.current?.kill("SIGTERM");
      cleanupTerminalScreen();
      exit();
      return;
    }

    if ((key.ctrl && char === "v") || char === "[118;6u" || char === "[86;6u") {
      triggerClipboardPaste();
      return;
    }

    if (key.ctrl && char === "f") {
      setSearchOpen((open) => {
        if (!open) {
          setSearchMatchIdx(0);
        }
        return !open;
      });
      return;
    }

    if (searchOpen && modal === "none") {
      if (key.escape) {
        setSearchOpen(false);
        return;
      }
      if (key.return || key.downArrow) {
        if (searchMatches.length > 0) {
          const next = (searchMatchIdx + 1) % searchMatches.length;
          setSearchMatchIdx(next);
          jumpToSearchLine(searchMatches[next]);
        }
        return;
      }
      if (key.upArrow) {
        if (searchMatches.length > 0) {
          const prev = (searchMatchIdx - 1 + searchMatches.length) % searchMatches.length;
          setSearchMatchIdx(prev);
          jumpToSearchLine(searchMatches[prev]);
        }
        return;
      }
      if (key.backspace || key.delete || char === "[127;5u" || char === "[8;5u") {
        const rawSeq = lastRawKeySeqRef.current;
        const isWordBack =
          key.backspace ||
          key.ctrl ||
          key.meta ||
          rawSeq === "\b" ||
          rawSeq === "\x1b\x7f" ||
          rawSeq === "\x1b\b" ||
          char === "[127;5u" ||
          char === "[8;5u";
        const nextQ = isWordBack
          ? searchQuery.slice(0, moveCursorWordLeft(searchQuery, searchQuery.length))
          : searchQuery.slice(0, -1);
        setSearchQuery(nextQ);
        setSearchMatchIdx(0);
        return;
      }
      if (char && !key.ctrl && !key.meta) {
        const nextQ = searchQuery + char;
        setSearchQuery(nextQ);
        const q = nextQ.trim().toLowerCase();
        if (q) {
          const matched = conversationLines.reduce<number[]>((acc, l, i) => {
            if (stripAnsi(l).toLowerCase().includes(q)) acc.push(i);
            return acc;
          }, []);
          if (matched.length > 0) {
            const lastIdx = matched.length - 1;
            setSearchMatchIdx(lastIdx);
            jumpToSearchLine(matched[lastIdx]);
          }
        }
        return;
      }
    }

    if (key.ctrl && char === "y") {
      copyLatestFromConversation("auto");
      return;
    }

    if (key.ctrl && (char === "a" || char === "s")) {
      openModal(modal === "agents" ? "none" : "agents");
      return;
    }
    if (key.ctrl && char === "o") {
      setShowDetails((v) => {
        const next = !v;
        savePersistedState({ showDetails: next });
        return next;
      });
      return;
    }
    if (key.ctrl && char === "l") {
      openModal(modal === "models" ? "none" : "models");
      return;
    }
    if (key.ctrl && char === "t") {
      openModal(modal === "thinking" ? "none" : "thinking");
      return;
    }
    if (key.ctrl && char === "n" && orderedAgents.length > 1) {
      const idx = orderedAgents.findIndex((x) => x.agent.id === activeAgentId);
      const next = orderedAgents[(idx + 1) % orderedAgents.length];
      if (next) switchAgentById(next.agent.id);
      return;
    }
    if (key.ctrl && char === "p" && orderedAgents.length > 1) {
      const idx = orderedAgents.findIndex((x) => x.agent.id === activeAgentId);
      const prev = orderedAgents[(idx - 1 + orderedAgents.length) % orderedAgents.length];
      if (prev) switchAgentById(prev.agent.id);
      return;
    }

    if (key.pageUp) {
      updateScrollOffset((s) => s + Math.max(4, Math.floor(viewportHeight / 2)));
      return;
    }
    if (key.pageDown) {
      updateScrollOffset((s) => s - Math.max(4, Math.floor(viewportHeight / 2)));
      return;
    }

    if (modal !== "none") {
      if (key.escape) {
        if (modal !== "permission") setModal("none");
        return;
      }

      const listLen =
        modal === "agents"
          ? filteredAgents.length
          : modal === "models"
          ? filteredModels.length
          : modal === "thinking"
          ? thinkingChoices.length
          : modal === "modes"
          ? modeChoices.length
          : permission?.options.length ?? 0;

      if (key.upArrow) {
        setModalIdx((i) => (listLen > 0 ? (i - 1 + listLen) % listLen : 0));
        return;
      }
      if (key.downArrow) {
        setModalIdx((i) => (listLen > 0 ? (i + 1) % listLen : 0));
        return;
      }
      if (key.return) {
        if (modal === "agents" && filteredAgents[modalIdx]) {
          switchAgentById(filteredAgents[modalIdx].id);
        } else if (modal === "models" && filteredModels[modalIdx] && activeAgentId) {
          sendBridge({ cmd: "set_model", agentId: activeAgentId, modelId: filteredModels[modalIdx].id });
          setModal("none");
        } else if (modal === "thinking" && thinkingChoices[modalIdx] && activeAgentId) {
          sendBridge({ cmd: "set_thinking", agentId: activeAgentId, thinkingId: thinkingChoices[modalIdx] });
          setModal("none");
        } else if (modal === "modes" && modeChoices[modalIdx] && activeAgentId) {
          sendBridge({ cmd: "set_mode", agentId: activeAgentId, modeId: modeChoices[modalIdx].id });
          setModal("none");
        } else if (modal === "permission" && permission) {
          const picked = permission.options[modalIdx] ?? permission.options[0];
          const choiceId = picked?.id ?? "allow_once";
          const isDeny = picked?.kind === "deny" || /deny|reject/i.test(choiceId);
          sendBridge({
            cmd: "respond_permission",
            agentId: permission.agentId,
            requestId: permission.requestId,
            response: {
              behavior: isDeny ? "deny" : "allow",
              ...(picked?.id ? { selectedActionId: picked.id } : {}),
            },
          });
          setPermission(null);
          setModal("none");
        }
        return;
      }

      if (modal === "agents" || modal === "models") {
        if (key.backspace || key.delete || char === "[127;5u" || char === "[8;5u") {
          const rawSeq = lastRawKeySeqRef.current;
          const isWordBack =
            key.backspace ||
            key.ctrl ||
            key.meta ||
            rawSeq === "\b" ||
            rawSeq === "\x1b\x7f" ||
            rawSeq === "\x1b\b" ||
            char === "[127;5u" ||
            char === "[8;5u";
          setModalFilter((f) => (isWordBack ? f.slice(0, moveCursorWordLeft(f, f.length)) : f.slice(0, -1)));
          setModalIdx(0);
          return;
        }
        if (char && !key.ctrl && !key.meta && !lastRawKeySeqRef.current.startsWith("\x1b[")) {
          setModalFilter((f) => f + char);
          setModalIdx(0);
        }
      }
      return;
    }

    if (key.escape) {
      if (isStreaming || activeAgent?.status === "running") {
        if (activeAgentId) sendBridge({ cmd: "cancel", agentId: activeAgentId });
      } else if (input) {
        setPrompt("", 0);
      }
      return;
    }

    if (slashSuggestions.length > 0) {
      if (key.upArrow) {
        setSlashIdx((i) => (i - 1 + slashSuggestions.length) % slashSuggestions.length);
        return;
      }
      if (key.downArrow) {
        setSlashIdx((i) => (i + 1) % slashSuggestions.length);
        return;
      }
      if (key.tab) {
        const picked = slashSuggestions[slashIdx] ?? slashSuggestions[0];
        if (picked) {
          const next = picked.fillValue ?? `/${picked.name}${picked.argumentHint ? " " : ""}`;
          setPrompt(next, next.length);
          setSlashIdx(0);
        }
        return;
      }
      if (key.return) {
        const picked = slashSuggestions[slashIdx] ?? slashSuggestions[0];
        if (picked?.submitOnEnter && picked.fillValue) {
          handleSubmitLine(picked.fillValue.trim());
          return;
        }
        const isExactCmd = allSlashCommands.some((c) => `/${c.name.toLowerCase()}` === input.toLowerCase());
        if (picked && !input.includes(" ")) {
          if (picked.argumentHint && picked.argumentHint.startsWith("<")) {
            const next = `/${picked.name} `;
            setPrompt(next, next.length);
            setSlashIdx(0);
            return;
          }
          if (!isExactCmd && input !== `/${picked.name}` && picked.isLocal && !picked.argumentHint) {
            handleSubmitLine(`/${picked.name}`);
            return;
          }
        }
      }
    } else {
      if (key.upArrow) {
        const vertPos = moveCursorVertical(inputRef.current, cursorRef.current, -1);
        if (vertPos !== null) {
          setPrompt(inputRef.current, vertPos);
          return;
        }
        if (promptHistory.length > 0) {
          const nextIdx = Math.min(historyIdx + 1, promptHistory.length - 1);
          setHistoryIdx(nextIdx);
          const h = promptHistory[nextIdx];
          setPrompt(h, h.length);
          return;
        }
      }
      if (key.downArrow) {
        const vertPos = moveCursorVertical(inputRef.current, cursorRef.current, 1);
        if (vertPos !== null) {
          setPrompt(inputRef.current, vertPos);
          return;
        }
        if (historyIdx > 0) {
          const nextIdx = historyIdx - 1;
          setHistoryIdx(nextIdx);
          const h = promptHistory[nextIdx];
          setPrompt(h, h.length);
        } else if (historyIdx === 0) {
          setHistoryIdx(-1);
          setPrompt("", 0);
        }
        return;
      }
    }

    const rawSeq = lastRawKeySeqRef.current;

    // Word-level cursor navigation: Ctrl+Left/Right, Alt+Left/Right (including CSI-u & rxvt sequences)
    const isWordLeft =
      (key.leftArrow && (key.ctrl || key.meta)) ||
      (key.meta && char === "b") ||
      /^\x1b(?:\[(?:1;[35]D|[35]D|d)|Od|\x1b\[D)$/.test(rawSeq);
    if (isWordLeft) {
      const curText = inputRef.current;
      setPrompt(curText, moveCursorWordLeft(curText, cursorRef.current));
      return;
    }

    const isWordRight =
      (key.rightArrow && (key.ctrl || key.meta)) ||
      (key.meta && char === "f") ||
      /^\x1b(?:\[(?:1;[35]C|[35]C|c)|Oc|\x1b\[C)$/.test(rawSeq);
    if (isWordRight) {
      const curText = inputRef.current;
      setPrompt(curText, moveCursorWordRight(curText, cursorRef.current));
      return;
    }

    // Character-level cursor navigation
    if (key.leftArrow) {
      const curText = inputRef.current;
      let target = Math.max(0, cursorRef.current - 1);
      const hit = findPastedTokenRanges(curText).find((r) => target > r.start && target < r.end);
      if (hit) target = hit.start;
      setPrompt(curText, target);
      return;
    }
    if (key.rightArrow) {
      const curText = inputRef.current;
      let target = Math.min(curText.length, cursorRef.current + 1);
      const hit = findPastedTokenRanges(curText).find((r) => target > r.start && target < r.end);
      if (hit) target = hit.end;
      setPrompt(curText, target);
      return;
    }
    if (char === "[H" || char === "[1~" || char === "OH" || rawSeq === "\x1b[H" || rawSeq === "\x1bOH" || rawSeq === "\x1b[1~") {
      const curText = inputRef.current;
      const pos = cursorRef.current;
      const lineStart = curText.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
      setPrompt(curText, pos === lineStart ? 0 : lineStart);
      return;
    }
    if (char === "[F" || char === "[4~" || char === "OF" || rawSeq === "\x1b[F" || rawSeq === "\x1bOF" || rawSeq === "\x1b[4~" || (key.ctrl && char === "e")) {
      const curText = inputRef.current;
      const pos = cursorRef.current;
      const nl = curText.indexOf("\n", pos);
      const lineEnd = nl === -1 ? curText.length : nl;
      setPrompt(curText, pos === lineEnd ? curText.length : lineEnd);
      return;
    }
    if (key.ctrl && char === "u") {
      const curText = inputRef.current;
      const pos = cursorRef.current;
      const lineStart = curText.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
      const nextText = curText.slice(0, lineStart) + curText.slice(pos);
      cleanupRemovedPastedTokens(nextText);
      setPrompt(nextText, lineStart);
      return;
    }
    if (key.ctrl && char === "k") {
      const curText = inputRef.current;
      const pos = cursorRef.current;
      const nl = curText.indexOf("\n", pos);
      const lineEnd = nl === -1 ? curText.length : nl;
      const nextText = curText.slice(0, pos) + curText.slice(lineEnd);
      cleanupRemovedPastedTokens(nextText);
      setPrompt(nextText, pos);
      return;
    }

    // Word-level deletion backward (Ctrl+Backspace, Alt+Backspace, Ctrl+W, Ctrl+H, CSI-u [127;5u / [8;5u)
    const isCtrlOrAltBackspace =
      key.backspace ||
      (key.ctrl && (char === "w" || char === "h")) ||
      ((key.delete || key.backspace) && (key.ctrl || key.meta) && !rawSeq.startsWith("\x1b[3")) ||
      rawSeq === "\b" ||
      rawSeq === "\x1b\x7f" ||
      rawSeq === "\x1b\b" ||
      /^\x1b\[(?:127|8);[357]u$/.test(rawSeq);
    if (isCtrlOrAltBackspace) {
      deletePromptWordBackward();
      return;
    }

    // Forward word deletion (Ctrl+Delete, Alt+Delete, Alt+D)
    const isForwardWordDelete =
      (key.meta && char === "d") ||
      /^\x1b\[3;[357]~$|^\x1b\[3\^$/.test(rawSeq);
    if (isForwardWordDelete) {
      deletePromptWordForward();
      return;
    }

    // Shift+Enter (CSI-u from foot/ghostty), Alt+Enter, or Ctrl+J inserts newline
    if (char === "[13;2u" || char === "[13;4u" || (key.meta && key.return) || (key.ctrl && char === "j")) {
      insertAtCursor("\n");
      setSlashIdx(0);
      return;
    }

    if (key.return) {
      handleSubmitLine(inputRef.current);
      return;
    }

    // Forward single-character/token Delete (Suppr key: \x1b[3~)
    if (rawSeq === "\x1b[3~") {
      const curText = inputRef.current;
      const pos = cursorRef.current;
      if (pos < curText.length) {
        const tokenHit = findPastedTokenRanges(curText).find((r) => pos >= r.start && pos < r.end);
        if (tokenHit) {
          const nextText = curText.slice(0, tokenHit.start) + curText.slice(tokenHit.end);
          cleanupRemovedPastedTokens(nextText);
          setPrompt(nextText, tokenHit.start);
        } else {
          setPrompt(curText.slice(0, pos) + curText.slice(pos + 1), pos);
        }
      }
      setSlashIdx(0);
      return;
    }

    // Normal Backspace (\x7f)
    if (key.delete || key.backspace) {
      const curText = inputRef.current;
      const pos = cursorRef.current;
      if (!curText && attachmentsRef.current.length > 0) {
        setAttachments((prev) => prev.slice(0, -1));
        return;
      }
      if (pos > 0) {
        const tokenHit = findPastedTokenRanges(curText).find((r) => pos > r.start && pos <= r.end);
        if (tokenHit) {
          const nextText = curText.slice(0, tokenHit.start) + curText.slice(tokenHit.end);
          cleanupRemovedPastedTokens(nextText);
          setPrompt(nextText, tokenHit.start);
          setSlashIdx(0);
          return;
        }
        setPrompt(curText.slice(0, pos - 1) + curText.slice(pos), pos - 1);
      }
      setSlashIdx(0);
      return;
    }

    if (char && !key.ctrl && !key.meta) {
      // Ignore unhandled terminal CSI/SS3 escape sequences so they never leak as text into the prompt
      if (rawSeq.startsWith("\x1b[") || rawSeq.startsWith("\x1bO")) {
        return;
      }
      if (char.length > 3) {
        const pastedPath = normalizePastedPath(char);
        if (pastedPath) {
          try {
            const att = attachmentFromFile(pastedPath);
            if (att) {
              setAttachments((prev) => [...prev, att]);
              return;
            }
          } catch (err) {
            setStatusNotice(String((err as Error)?.message || err));
            return;
          }
        }
        insertSmartPaste(char);
        setSlashIdx(0);
        return;
      }
      insertAtCursor(char);
      setSlashIdx(0);
    }
  });

  const activeBadge = activeAgent ? getAgentBadge(activeAgent, completedAgentIds) : null;

  return (
    <Box flexDirection="column" width={termCols} height={rootHeight} overflow="hidden">
      {/* Pinned Top Clickable Session Tabs Bar */}
      <Box
        flexDirection="column"
        borderStyle="single"
        borderTop={false}
        borderLeft={false}
        borderRight={false}
        borderBottom
        borderColor="gray"
        paddingX={1}
        width="100%"
      >
        {topTabs.rows.map((rowStr, rIdx) => (
          <Box key={`tab-row-${rIdx}`} height={1} overflow="hidden">
            <Text>{rowStr}</Text>
          </Box>
        ))}
        {connecting || statusNotice || scrollOffset > 0 ? (
          <Box height={1} overflow="hidden" justifyContent="space-between" gap={1}>
            <Text wrap="truncate-end">
              {connecting ? (
                <Text color="yellow">{spinner} {statusNotice || `Connexion à Paseo (${TARGET_LABEL})…`}</Text>
              ) : statusNotice ? (
                <Text color="yellow">{statusNotice}</Text>
              ) : (
                <Text dimColor>Historique</Text>
              )}
            </Text>
            <Text dimColor wrap="truncate-end">
              {scrollOffset > 0 ? `↑ ${effectiveScroll} lignes · PgDn pour revenir en bas` : ""}
            </Text>
          </Box>
        ) : null}
      </Box>

      {/* Active Session Conversation Viewport */}
      <Box flexDirection="column" paddingX={1} height={viewportHeight} overflow="hidden">
        <Text>{displayedConversation.join("\n")}</Text>
      </Box>

      {/* Modal pickers */}
      {modal === "agents" && (
        <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={1} height={modalHeight} overflow="hidden">
          <Text>
            <Text color="cyan" bold>
              Onglets de session ({agents.length})
            </Text>
            <Text dimColor>  </Text>
            <Text>{chalk.hex(COLOR_WORKING)("●")}</Text>
            <Text dimColor> working  </Text>
            <Text>{chalk.hex(COLOR_DONE)("●")}</Text>
            <Text dimColor> terminé  </Text>
            <Text dimColor>○ idle — filtre: {modalFilter || "(taper pour filtrer)"}</Text>
          </Text>
          {filteredAgents.slice(0, 14).map((a, idx) => {
            const selected = idx === modalIdx;
            const current = a.id === activeAgentId;
            const badge = getAgentBadge(a, completedAgentIds);
            const { group, label } = getAgentTabGroupAndLabel(a, agents);
            const displayTitle = a.projectName ? `${group} - ${label}` : a.title;
            return (
              <Text key={a.id} color={selected ? "black" : undefined} backgroundColor={selected ? "cyan" : undefined}>
                {selected ? "▸ " : "  "}
                {selected ? badge.symbol : renderBadgeDot(badge)}{" "}
                {displayTitle.padEnd(22)} [{badge.stateLabel.padEnd(7)}] {(a.model ?? "").split(":").pop()}
                {current ? " ★" : ""}
              </Text>
            );
          })}
          {filteredAgents.length === 0 && <Text dimColor>Aucun onglet correspondant.</Text>}
        </Box>
      )}

      {modal === "models" && (
        <Box flexDirection="column" borderStyle="round" borderColor="magenta" paddingX={1} height={modalHeight} overflow="hidden">
          <Text color="magenta" bold>
            Modèles / Providers Hermes ({models.length}) — filtre: {modalFilter || "(taper pour filtrer)"}
          </Text>
          {filteredModels.map((m, idx) => {
            const selected = idx === modalIdx;
            const current = m.id === activeAgent?.model;
            return (
              <Text key={m.id} color={selected ? "black" : undefined} backgroundColor={selected ? "magenta" : undefined}>
                {selected ? "▸ " : "  "}
                {m.label} ({m.id}){current ? " ★" : ""}
              </Text>
            );
          })}
          {filteredModels.length === 0 && <Text dimColor>Aucun modèle correspondant.</Text>}
        </Box>
      )}

      {modal === "thinking" && (
        <Box flexDirection="column" borderStyle="round" borderColor="yellow" paddingX={1} height={modalHeight} overflow="hidden">
          <Text color="yellow" bold>
            Niveau de Thinking
          </Text>
          {thinkingChoices.map((lvl, idx) => {
            const selected = idx === modalIdx;
            const current = lvl === activeAgent?.thinkingOptionId;
            return (
              <Text key={lvl} color={selected ? "black" : undefined} backgroundColor={selected ? "yellow" : undefined}>
                {selected ? "▸ " : "  "}
                {lvl}
                {current ? " ★" : ""}
              </Text>
            );
          })}
        </Box>
      )}

      {modal === "modes" && (
        <Box flexDirection="column" borderStyle="round" borderColor="blue" paddingX={1} height={modalHeight} overflow="hidden">
          <Text color="blue" bold>
            Mode d'approbation
          </Text>
          {modeChoices.map((m, idx) => {
            const selected = idx === modalIdx;
            const current = m.id === activeAgent?.modeId;
            return (
              <Text key={m.id} color={selected ? "black" : undefined} backgroundColor={selected ? "blue" : undefined}>
                {selected ? "▸ " : "  "}
                {m.label} ({m.id}) — {m.description}
                {current ? " ★" : ""}
              </Text>
            );
          })}
        </Box>
      )}

      {modal === "permission" && permission && (
        <Box flexDirection="column" borderStyle="round" borderColor="red" paddingX={1} height={modalHeight} overflow="hidden">
          <Text color="red" bold>
            Permission requise : {permission.name}
          </Text>
          {permission.description ? <Text dimColor>{permission.description}</Text> : null}
          {permission.options.map((opt, idx) => {
            const selected = idx === modalIdx;
            return (
              <Text key={opt.id} color={selected ? "black" : undefined} backgroundColor={selected ? "red" : undefined}>
                {selected ? "▸ " : "  "}
                {opt.label}
              </Text>
            );
          })}
        </Box>
      )}

      {/* Slash autocomplete */}
      {slashSuggestions.length > 0 && (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} height={slashHeight} overflow="hidden">
          {slashSuggestions.map((c, idx) => {
            const selected = idx === slashIdx;
            const cmdLabel = c.displayName ?? `/${c.name}`;
            return (
              <Text key={c.name} color={selected ? "cyan" : undefined} bold={selected} wrap="truncate-end">
                {selected ? "▸ " : "  "}
                {cmdLabel.padEnd(22)} {c.argumentHint ? `${c.argumentHint.padEnd(10)} ` : ""}
                <Text dimColor>{c.description}</Text>
              </Text>
            );
          })}
        </Box>
      )}

      {searchOpen && (
        <Box height={1} paddingX={1} overflow="hidden" justifyContent="space-between">
          <Text wrap="truncate-end">
            <Text color="yellow" bold>
              🔍{" "}
            </Text>
            <Text>{searchQuery}</Text>
            <Text color="yellow">█</Text>
          </Text>
          <Text dimColor>
            {searchQuery.trim()
              ? searchMatches.length > 0
                ? `${((searchMatchIdx % searchMatches.length) + searchMatches.length) % searchMatches.length + 1}/${searchMatches.length} · Entrée/↑↓ naviguer · Esc fermer`
                : "0 résultat · Esc fermer"
              : "Taper pour chercher · Esc fermer"}
          </Text>
        </Box>
      )}

      {attachments.length > 0 && (
        <Box height={1} paddingX={1} overflow="hidden">
          <Text wrap="truncate-end">
            <Text color="cyan">📎 </Text>
            {attachments.map((a) => `${a.name} (${formatSize(a.size)})`).join(" · ")}
            <Text dimColor>  ⌫ retirer · Entrée envoyer</Text>
          </Text>
        </Box>
      )}

      {/* Minimalist prompt box with Yoga-managed top/bottom borders */}
      <Box
        flexDirection="column"
        flexShrink={0}
        borderStyle="single"
        borderTop
        borderBottom
        borderLeft={false}
        borderRight={false}
        borderColor="gray"
        paddingX={1}
        width="100%"
      >
        {(() => {
          const linesWithOffsets: Array<{ text: string; start: number; end: number; idx: number }> = [];
          let offset = 0;
          promptLines.forEach((lineText, idx) => {
            linesWithOffsets.push({ text: lineText, start: offset, end: offset + lineText.length, idx });
            offset += lineText.length + 1;
          });
          const cursorLineIdx = linesWithOffsets.find((l) => cursor >= l.start && cursor <= l.end)?.idx ?? linesWithOffsets.length - 1;
          const startIdx = Math.max(0, Math.min(linesWithOffsets.length - visiblePromptRows, cursorLineIdx - visiblePromptRows + 1));
          const shown = linesWithOffsets.slice(startIdx, startIdx + visiblePromptRows);

          return shown.map((l) => {
            const hasCursor = l.idx === cursorLineIdx;
            const rel = hasCursor ? Math.max(0, Math.min(l.text.length, cursor - l.start)) : -1;
            const before = hasCursor ? l.text.slice(0, rel) : l.text;
            const curChar = hasCursor ? (rel < l.text.length ? chalk.inverse(l.text[rel]) : chalk.cyan("█")) : "";
            const after = hasCursor && rel < l.text.length ? l.text.slice(rel + 1) : "";
            const prefixStr = (busy ? chalk.bold.yellow : chalk.bold.cyan)(l.idx === 0 ? "> " : "  ");
            const colorPasted = (seg: string) =>
              seg.replace(/(\[Pasted #\d+[^\]]*\])/g, (_, m: string) => chalk.cyan(m));
            return (
              <Box key={`prompt-line-${l.idx}`} width="100%" height={1}>
                <Text>{`${prefixStr}${colorPasted(before)}${curChar}${colorPasted(after)}`}</Text>
              </Box>
            );
          });
        })()}
      </Box>

      {/* Single-line minimalist status bar */}
      <Box width="100%" height={1} paddingX={1} overflow="hidden" justifyContent="space-between" gap={1}>
        <Text dimColor wrap="truncate-end">
          ^S sessions · ^O expand{showDetails ? "*" : ""} · ^Y copier · ^V coller · ^L model · /
        </Text>
        <Text wrap="truncate-end">
          <Text color="yellow">
            {activeAgent
              ? (() => {
                  const { group, label } = getAgentTabGroupAndLabel(activeAgent, agents);
                  return `${group} - ${label}`;
                })()
              : "—"}
          </Text>
          <Text dimColor>
            {" "}
            · {(activeAgent?.model ?? "—").split(":").pop()} ({activeAgent?.thinkingOptionId ?? "default"})
          </Text>
          {(() => {
            const ctx = formatContextUsage(activeAgent?.lastUsage);
            if (!ctx) return null;
            return (
              <Text color={ctx.color} dimColor={!ctx.color}>
                {" "}
                · {ctx.label}
              </Text>
            );
          })()}
        </Text>
      </Box>
    </Box>
  );
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }
  if (args.includes("--check")) {
    const code = await runCheck();
    process.exit(code);
  }

  let initialQuery: string | undefined;
  const agentFlagIdx = args.indexOf("--agent");
  if (agentFlagIdx >= 0 && args[agentFlagIdx + 1]) {
    initialQuery = args[agentFlagIdx + 1];
  } else if (args[0] && !args[0].startsWith("-")) {
    initialQuery = args[0];
  }

  initTerminalScreen();
  process.on("exit", cleanupTerminalScreen);
  process.on("SIGINT", () => {
    cleanupTerminalScreen();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    cleanupTerminalScreen();
    process.exit(0);
  });

  const instance = render(<HermesTuiApp initialQuery={initialQuery} />);
  await instance.waitUntilExit();
  cleanupTerminalScreen();
}

main().catch((err) => {
  cleanupTerminalScreen();
  console.error(err);
  process.exit(1);
});
