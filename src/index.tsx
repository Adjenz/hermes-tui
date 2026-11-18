import React, { useEffect, useMemo, useRef, useState } from "react";
import { Box, Text, useApp, useInput, useStdout } from "ink";
import { render } from "ink";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import readline from "node:readline";
import fs from "node:fs";
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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const COLOR_WORKING = "#f97316"; // Orange pour "working"
const COLOR_DONE = "#22c55e"; // Vert pour "terminé"

const LOCAL_COMMANDS: SlashCommand[] = [
  { name: "new", description: "Créer une nouvelle session Hermes", argumentHint: "[titre]", isLocal: true },
  { name: "title", description: "Renommer l'onglet de session dans Paseo", argumentHint: "<titre>", isLocal: true },
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
const HERMES_REASONING_CLOSED_RE = /(?:^|\n)[ \t]*💭\s*Reasoning:\s*\n[ \t]*╭[\s\S]*?╰[─━\s]*╯[ \t]*(?=\n|$)/g;
const HERMES_REASONING_OPEN_RE = /(?:^|\n)[ \t]*💭\s*Reasoning:[\s\S]*$/;

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
  let workSteps: WorkStep[] = [];

  const flushWorkGroup = () => {
    if (workSteps.length > 0) {
      entries.push({
        key: `${epoch}-wg-${idx++}`,
        kind: "work_group",
        steps: workSteps,
        text: "",
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
        });
      }
    }
    assistantAcc = "";
  };

  for (const item of items) {
    if (item.type === "reasoning") {
      continue;
    }
    if (item.type === "assistant_message") {
      assistantAcc += item.text ?? "";
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
        });
      } else if (item.type === "error" && item.message) {
        entries.push({
          key: `${epoch}-e-${idx++}`,
          kind: "error",
          text: item.message,
        });
      } else if (item.type === "notification" && item.message) {
        entries.push({
          key: `${epoch}-n-${idx++}`,
          kind: "notice",
          text: item.message,
        });
      }
    }
  }
  flushAssistant();
  flushWorkGroup();
  return entries;
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

  for (const entry of entries) {
    if (entry.kind === "banner") {
      continue;
    }
    if (entry.kind === "user") {
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
      lines.push(chalk.dim("─".repeat(ruleLen)));
      const promptWrapped = wrapAnsiText(chalk.blue(entry.text), contentWidth, chalk.blue("> "), "  ");
      lines.push(...promptWrapped.split("\n"));
      lines.push("");
      continue;
    }
    if (entry.kind === "work_group" && entry.steps) {
      lines.push(...formatWorkGroupLines(entry.steps, showDetails, contentWidth));
      lines.push("");
      continue;
    }
    if (entry.kind === "assistant") {
      const mdLines = renderMarkdownToLines(entry.text, contentWidth, "  ");
      lines.push(...mdLines);
      if (lines.length > 0 && lines[lines.length - 1] !== "") {
        lines.push("");
      }
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

  // Group sessions by persona ("Alfred - Mails" -> group "Alfred", label "Mails")
  const groups: { name: string; icon: string; items: { agent: HermesAgent; label: string }[] }[] = [];
  const stable = [...agents].sort((x, y) => x.title.localeCompare(y.title, "fr") || x.id.localeCompare(y.id));
  for (const a of stable) {
    const [head, ...tail] = a.title.split(" - ");
    const name = head.trim() || a.title;
    const rawLabel = tail.join(" - ").trim() || "Principal";
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
    let line = chalk.bold.whiteBright(headPlain) + " ".repeat(Math.max(1, headerWidth - visibleLength(headPlain))) + chalk.dim("│");
    let width = headerWidth + 1;
    const reserve = gi === 0 ? menuWidth + 2 : 0;
    let hidden = 0;

    g.items.forEach((it, ii) => {
      const isCurrent = it.agent.id === activeAgentId;
      const badge = getAgentBadge(it.agent, completedIds);
      const symbol = badge.stateLabel === "working" ? spinner : badge.symbol;
      const label = it.label.length > 22 ? `${it.label.slice(0, 21)}…` : it.label;
      const plain = ` ${symbol} ${label} `;
      const chipWidth = visibleLength(plain);
      const sepWidth = ii > 0 ? 1 : 0;
      if (width + sepWidth + chipWidth + reserve > innerWidth) {
        hidden++;
        return;
      }
      if (ii > 0) {
        line += chalk.dim("│");
        width += 1;
      }
      const dot = badge.hex ? chalk.hex(badge.hex)(symbol) : chalk.dim(symbol);
      const startCol = 2 + width;
      if (isCurrent) {
        const dotOnBg = badge.hex ? chalk.bgWhiteBright.hex(badge.hex)(symbol) : chalk.bgWhiteBright.black(symbol);
        line += chalk.bgWhiteBright.black.bold(" ") + dotOnBg + chalk.bgWhiteBright.black.bold(` ${label} `);
      } else {
        line += ` ${dot} ${label} `;
      }
      width += chipWidth;
      hitBoxes.push({ agentId: it.agent.id, row: gi + 1, startCol, endCol: startCol + chipWidth - 1 });
    });

    if (hidden > 0) {
      line += chalk.dim(` +${hidden}`);
      width += 2 + String(hidden).length;
    }
    if (gi === 0) {
      const gap = Math.max(1, innerWidth - width - menuWidth);
      const startCol = 2 + width + gap;
      line += " ".repeat(gap) + chalk.dim(menuPlain);
      menuHitBox = { row: 1, startCol, endCol: startCol + menuWidth - 1 };
    }
    rows.push(line);
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
  Molette / PgUp / PgDn      Défiler dans la discussion
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
  const { columns: termCols, rows: termRows } = useTerminalSize();

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
  const [promptHistory, setPromptHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState<number>(-1);
  const [scrollOffset, setScrollOffset] = useState(0);
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
  const [showDetails, setShowDetails] = useState(false);
  const [completedAgentIds, setCompletedAgentIds] = useState<Set<string>>(() => new Set());
  const prevStatusesRef = useRef<Map<string, string>>(new Map());
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
    setStaticItems((prev) => [...prev, { ...entry, key: `live-${seqRef.current}` }]);
  }

  function flushLiveTurnToStatic(): void {
    const t = liveToolsRef.current;
    const a = liveAssistantRef.current.replace(/^\n+/, "");

    const workSteps: WorkStep[] = t.map((tool) => ({
      kind: "tool",
      toolName: tool.toolName,
      title: tool.title,
      command: tool.command,
      output: tool.output,
      status: tool.status,
    }));

    const additions: StaticEntry[] = [];
    if (workSteps.length > 0) {
      seqRef.current += 1;
      additions.push({
        key: `live-${seqRef.current}`,
        kind: "work_group",
        steps: workSteps,
        text: "",
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
        });
      }
    }
    if (additions.length > 0) {
      setStaticItems((prev) => [...prev, ...additions]);
    }
    liveToolsRef.current = [];
    liveAssistantRef.current = "";
    setLiveTools([]);
    setLiveAssistant("");
    setIsStreaming(false);
    setIsThinking(false);
  }

  function resetToAgentTimeline(agent: HermesAgent | undefined, timeline: TimelineItem[], cmds: SlashCommand[]): void {
    const nextEpoch = epochRef.current + 1;
    setLiveAssistant("");
    setLiveTools([]);
    setIsStreaming(agent?.status === "running");
    setIsThinking(false);
    setScrollOffset(0);

    const entries = timelineToStaticEntries(timeline, nextEpoch);
    const resolvedCmds = cmds.length > 0 ? cmds : FALLBACK_HERMES_COMMANDS;
    if (agent?.id) {
      timelineCacheRef.current.set(agent.id, {
        entries,
        commands: resolvedCmds,
        fingerprint: timelineFingerprint(timeline),
        updatedAt: agent.updatedAt ?? "",
      });
    }
    setSessionEpoch(nextEpoch);
    setStaticItems(entries);
    setHermesCommands(resolvedCmds);
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
          setCompletedAgentIds(new Set());

          let chosenId: string | null =
            (activeAgentIdRef.current && list.some((a) => a.id === activeAgentIdRef.current)
              ? activeAgentIdRef.current
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

          setActiveAgentId(chosenId);
          activeAgentIdRef.current = chosenId;
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
          const nextMap = new Map<string, string>();
          const newlyDone: string[] = [];
          const nowRunning: string[] = [];

          let activeFinished = false;
          for (const a of list) {
            nextMap.set(a.id, a.status);
            const prevStatus = prevMap.get(a.id);
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
            } else if (prevStatus === "running") {
              newlyDone.push(a.id);
            }
          }
          prevStatusesRef.current = nextMap;
          if (activeFinished) {
            flushLiveTurnToStatic();
          }
          if (newlyDone.length > 0 || nowRunning.length > 0) {
            setCompletedAgentIds((prev) => {
              const next = new Set(prev);
              for (const id of nowRunning) next.delete(id);
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
          setStatusNotice(null);
          return;
        }

        if (msg.type === "timeline_reloaded") {
          if (msg.agentId !== activeAgentIdRef.current) return;
          const active = agentsRef.current.find((a) => a.id === msg.agentId);
          resetToAgentTimeline(active, msg.timeline ?? [], []);
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
              pushStatic({ kind: "user", text: item.text.trim() });
              setScrollOffset(0);
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

  const slashSuggestions = useMemo(() => {
    if (!input.startsWith("/") || input.includes(" ") || modal !== "none") return [];
    const q = input.slice(1).toLowerCase();
    const starts = allSlashCommands.filter((c) => c.name.toLowerCase().startsWith(q));
    const descOnly = allSlashCommands.filter(
      (c) => !c.name.toLowerCase().startsWith(q) && c.description.toLowerCase().includes(q)
    );
    return [...starts.sort((a, b) => (a.name.toLowerCase() === q ? -1 : b.name.toLowerCase() === q ? 1 : 0)), ...descOnly].slice(0, 10);
  }, [input, modal, allSlashCommands]);

  const filteredAgents = useMemo(() => {
    return agents.filter((a) => fuzzyMatch(modalFilter, `${a.title} ${a.projectName} ${a.workspaceName} ${a.cwd}`));
  }, [agents, modalFilter]);

  const filteredModels = useMemo(() => {
    return models.filter((m) => fuzzyMatch(modalFilter, `${m.label} ${m.id}`)).slice(0, 14);
  }, [models, modalFilter]);

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
      setStatusNotice(stale ? "Synchronisation…" : null);
    } else {
      setStaticItems([]);
      setStatusNotice(`Chargement de ${target?.title ?? id}…`);
    }
    setLiveAssistant("");
    setLiveTools([]);
    setIsStreaming(target?.status === "running");
    setIsThinking(false);
    setScrollOffset(0);
    setModal("none");
    sendBridge({ cmd: "switch_agent", agentId: id });
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
    setPromptHistory((prev) => [trimmed, ...prev.slice(0, 49)]);
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
          const match = agents.find((a) => fuzzyMatch(arg, `${a.title} ${a.projectName}`));
          if (match) {
            switchAgentById(match.id);
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
  const effectiveScroll = Math.min(scrollOffset, maxScroll);
  const sliceEnd = Math.max(0, conversationLines.length - effectiveScroll);
  const sliceStart = Math.max(0, sliceEnd - viewportHeight);
  const visibleConversation = conversationLines.slice(sliceStart, sliceEnd);
  const viewportStartRow = topBarHeight + 1;
  const paddedConversation =
    visibleConversation.length < viewportHeight
      ? [...Array(viewportHeight - visibleConversation.length).fill(""), ...visibleConversation]
      : visibleConversation;

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
    setScrollOffset(nextScroll);
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

    if (!selection || (selection.r1 === selection.r2 && selection.c1 === selection.c2)) {
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
          if (sel && (sel.r1 !== sel.r2 || sel.c1 !== sel.c2)) {
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
              setStatusNotice("✓ Copié dans le presse-papiers");
              if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
              copyTimerRef.current = setTimeout(() => {
                setStatusNotice((n) => (n === "✓ Copié dans le presse-papiers" ? null : n));
              }, 1800);
            }
            setTimeout(() => setSelection(null), 160);
          } else {
            setSelection(null);
          }
        } else if (btn === 64) {
          setSelection(null);
          setScrollOffset((s) => Math.min(maxScroll, s + 3));
        } else if (btn === 65) {
          setSelection(null);
          setScrollOffset((s) => Math.max(0, s - 3));
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
      if (key.backspace || key.delete) {
        const nextQ = searchQuery.slice(0, -1);
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

    if (key.ctrl && (char === "a" || char === "s")) {
      openModal(modal === "agents" ? "none" : "agents");
      return;
    }
    if (key.ctrl && char === "o") {
      setShowDetails((v) => !v);
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
    if (key.ctrl && char === "n" && agents.length > 1) {
      const idx = agents.findIndex((a) => a.id === activeAgentId);
      const next = agents[(idx + 1) % agents.length];
      if (next) switchAgentById(next.id);
      return;
    }
    if (key.ctrl && char === "p" && agents.length > 1) {
      const idx = agents.findIndex((a) => a.id === activeAgentId);
      const prev = agents[(idx - 1 + agents.length) % agents.length];
      if (prev) switchAgentById(prev.id);
      return;
    }

    if (key.pageUp) {
      setScrollOffset((s) => Math.min(maxScroll, s + Math.max(4, Math.floor(viewportHeight / 2))));
      return;
    }
    if (key.pageDown) {
      setScrollOffset((s) => Math.max(0, s - Math.max(4, Math.floor(viewportHeight / 2))));
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
        if (key.backspace || key.delete) {
          setModalFilter((f) => f.slice(0, -1));
          setModalIdx(0);
          return;
        }
        if (char && !key.ctrl && !key.meta) {
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
          const next = `/${picked.name}${picked.argumentHint ? " " : ""}`;
          setPrompt(next, next.length);
          setSlashIdx(0);
        }
        return;
      }
      if (key.return) {
        const isExactCmd = allSlashCommands.some((c) => `/${c.name.toLowerCase()}` === input.toLowerCase());
        const picked = slashSuggestions[slashIdx];
        if (!isExactCmd && picked && input !== `/${picked.name}` && picked.isLocal && !picked.argumentHint) {
          handleSubmitLine(`/${picked.name}`);
          return;
        }
      }
    } else {
      if (key.upArrow && promptHistory.length > 0) {
        const nextIdx = Math.min(historyIdx + 1, promptHistory.length - 1);
        setHistoryIdx(nextIdx);
        const h = promptHistory[nextIdx];
        setPrompt(h, h.length);
        return;
      }
      if (key.downArrow) {
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

    // Prompt cursor navigation & editing shortcuts
    if (key.leftArrow) {
      setPrompt(inputRef.current, cursorRef.current - 1);
      return;
    }
    if (key.rightArrow) {
      setPrompt(inputRef.current, cursorRef.current + 1);
      return;
    }
    if (char === "[H" || char === "[1~" || char === "OH") {
      setPrompt(inputRef.current, 0);
      return;
    }
    if (char === "[F" || char === "[4~" || char === "OF" || (key.ctrl && char === "e")) {
      setPrompt(inputRef.current, inputRef.current.length);
      return;
    }
    if (key.ctrl && char === "u") {
      const curText = inputRef.current;
      const pos = cursorRef.current;
      const lineStart = curText.lastIndexOf("\n", Math.max(0, pos - 1)) + 1;
      setPrompt(curText.slice(0, lineStart) + curText.slice(pos), lineStart);
      return;
    }
    if (key.ctrl && char === "k") {
      const curText = inputRef.current;
      const pos = cursorRef.current;
      const nl = curText.indexOf("\n", pos);
      const lineEnd = nl === -1 ? curText.length : nl;
      setPrompt(curText.slice(0, pos) + curText.slice(lineEnd), pos);
      return;
    }
    if (key.ctrl && char === "w") {
      const curText = inputRef.current;
      const pos = cursorRef.current;
      const before = curText.slice(0, pos);
      const trimmedRight = before.replace(/\s+$/, "");
      const wordStart = trimmedRight.search(/\S+$/);
      const cutAt = wordStart >= 0 ? wordStart : 0;
      setPrompt(curText.slice(0, cutAt) + curText.slice(pos), cutAt);
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

    if (key.backspace || key.delete) {
      const curText = inputRef.current;
      const pos = cursorRef.current;
      if (!curText && attachmentsRef.current.length > 0) {
        setAttachments((prev) => prev.slice(0, -1));
        return;
      }
      if (pos > 0) {
        setPrompt(curText.slice(0, pos - 1) + curText.slice(pos), pos - 1);
      }
      setSlashIdx(0);
      return;
    }

    if (char && !key.ctrl && !key.meta) {
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
            return (
              <Text key={a.id} color={selected ? "black" : undefined} backgroundColor={selected ? "cyan" : undefined}>
                {selected ? "▸ " : "  "}
                {selected ? badge.symbol : renderBadgeDot(badge)}{" "}
                {a.title.padEnd(22)} [{badge.stateLabel.padEnd(7)}] {(a.model ?? "").split(":").pop()}
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
            return (
              <Text key={c.name} color={selected ? "cyan" : undefined} bold={selected}>
                {selected ? "▸ " : "  "}/{c.name.padEnd(11)} {c.argumentHint ? `${c.argumentHint.padEnd(10)} ` : "           "}
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
          ^S sessions · ^O expand{showDetails ? "*" : ""} · ^V coller fichier · ^L model · /
        </Text>
        <Text wrap="truncate-end">
          <Text color="yellow">{activeAgent?.title ?? "—"}</Text>
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
