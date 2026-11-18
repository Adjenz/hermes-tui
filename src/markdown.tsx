import React, { useEffect, useState } from "react";
import { Box, Text, useStdout } from "ink";
import defaultChalk, { Chalk } from "chalk";
import stringWidth from "string-width";

const chalk = new Chalk({
  level: process.env.NO_COLOR ? 0 : process.stdout.isTTY ? 3 : defaultChalk.level,
});

export { chalk };

const ANSI_RE = /\x1b\[[0-9;]*m/g;

export interface TerminalSize {
  columns: number;
  rows: number;
}

const sizeListeners = new Set<(size: TerminalSize) => void>();
let resizeAttached = false;

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const getSize = (): TerminalSize => ({
    columns: stdout?.columns || process.stdout.columns || 100,
    rows: stdout?.rows || process.stdout.rows || 30,
  });
  const [size, setSize] = useState<TerminalSize>(getSize);

  useEffect(() => {
    const stream = stdout || process.stdout;
    if (!resizeAttached) {
      resizeAttached = true;
      stream.on("resize", () => {
        const next: TerminalSize = {
          columns: stream.columns || 100,
          rows: stream.rows || 30,
        };
        for (const fn of sizeListeners) fn(next);
      });
    }
    sizeListeners.add(setSize);
    setSize({
      columns: stream.columns || 100,
      rows: stream.rows || 30,
    });
    return () => {
      sizeListeners.delete(setSize);
    };
  }, [stdout]);

  return size;
}

export function useTerminalColumns(): number {
  return useTerminalSize().columns;
}

export function stripAnsi(str: string): string {
  return str.replace(ANSI_RE, "");
}

export function visibleLength(str: string): number {
  return stringWidth(str);
}

export function padVisibleEnd(str: string, width: number): string {
  const diff = width - visibleLength(str);
  return diff > 0 ? str + " ".repeat(diff) : str;
}

export function formatInlineMarkdown(text: string): string {
  if (!text) return "";

  const codeTokens: string[] = [];
  let out = text.replace(/`([^`\n]+)`/g, (_, code: string) => {
    const idx = codeTokens.length;
    codeTokens.push(chalk.cyan(code));
    return `\u0000CODE${idx}\u0000`;
  });

  out = out.replace(/\[([^\]\n]+)\]\(([^)\s]+)\)/g, (_, label: string, url: string) => {
    if (url.startsWith("file://") || url === label) {
      return chalk.underline.blue(label);
    }
    return `${chalk.underline.blue(label)} ${chalk.dim(`(${url})`)}`;
  });

  out = out.replace(/\*\*\*([^\n*]+?)\*\*\*/g, (_, inner: string) => chalk.bold.italic.whiteBright(inner));
  out = out.replace(/\*\*([^\n]+?)\*\*/g, (_, inner: string) => chalk.bold.whiteBright(inner));
  out = out.replace(/(?<!\w)__([^\n_]+?)__(?!\w)/g, (_, inner: string) => chalk.bold.whiteBright(inner));
  out = out.replace(/~~([^\n~]+?)~~/g, (_, inner: string) => chalk.strikethrough(inner));
  out = out.replace(/(?<!\*)\*([^*\n]+?)\*(?!\*)/g, (_, inner: string) => chalk.italic(inner));
  out = out.replace(/(?<!\w)_([^_\n]+?)_(?!\w)/g, (_, inner: string) => chalk.italic(inner));

  out = out.replace(/\u0000CODE(\d+)\u0000/g, (_, idxStr: string) => codeTokens[Number(idxStr)] ?? "");
  return out;
}

/**
 * Tracks active ANSI SGR codes across a token so wrapped lines keep styles without
 * bleeding onto indentation spaces.
 */
function updateSgrState(activeCodes: string[], segment: string): void {
  const matches = segment.match(ANSI_RE);
  if (!matches) return;
  for (const seq of matches) {
    if (seq === "\x1b[0m" || seq === "\x1b[m") {
      activeCodes.length = 0;
    } else if (seq === "\x1b[22m") {
      for (let i = activeCodes.length - 1; i >= 0; i--) {
        if (activeCodes[i] === "\x1b[1m" || activeCodes[i] === "\x1b[2m") activeCodes.splice(i, 1);
      }
    } else if (seq === "\x1b[23m") {
      for (let i = activeCodes.length - 1; i >= 0; i--) {
        if (activeCodes[i] === "\x1b[3m") activeCodes.splice(i, 1);
      }
    } else if (seq === "\x1b[24m") {
      for (let i = activeCodes.length - 1; i >= 0; i--) {
        if (activeCodes[i] === "\x1b[4m") activeCodes.splice(i, 1);
      }
    } else if (seq === "\x1b[29m") {
      for (let i = activeCodes.length - 1; i >= 0; i--) {
        if (activeCodes[i] === "\x1b[9m") activeCodes.splice(i, 1);
      }
    } else if (seq === "\x1b[39m") {
      for (let i = activeCodes.length - 1; i >= 0; i--) {
        const m = activeCodes[i].match(/\x1b\[(\d+)m/);
        const n = m ? Number(m[1]) : 0;
        if ((n >= 30 && n <= 38) || (n >= 90 && n <= 97)) activeCodes.splice(i, 1);
      }
    } else {
      activeCodes.push(seq);
    }
  }
}

function splitLongToken(token: string, maxLen: number): string[] {
  if (maxLen <= 1 || visibleLength(token) <= maxLen) return [token];
  const parts: string[] = [];
  let current = "";
  let currentLen = 0;
  let i = 0;
  while (i < token.length) {
    if (token[i] === "\x1b") {
      const m = token.slice(i).match(/^\x1b\[[0-9;]*m/);
      if (m) {
        current += m[0];
        i += m[0].length;
        continue;
      }
    }
    const ch = token.codePointAt(i)!;
    const chStr = String.fromCodePoint(ch);
    if (currentLen >= maxLen && currentLen > 0) {
      parts.push(current);
      current = "";
      currentLen = 0;
    }
    current += chStr;
    currentLen += 1;
    i += chStr.length;
  }
  if (current) parts.push(current);
  return parts;
}

export function wrapAnsiText(
  text: string,
  maxWidth: number,
  firstIndent: string = "",
  nextIndent: string = ""
): string {
  const width = Math.max(20, maxWidth);
  if (!text) return firstIndent;

  const tokens = text.split(/(\s+)/).filter((t) => t.length > 0);
  const lines: string[] = [];
  const activeCodes: string[] = [];

  let currentIndent = firstIndent;
  let currentLine = "";
  let currentLen = 0;
  const availWidth = () => Math.max(10, width - visibleLength(currentIndent));

  const pushCurrentLine = () => {
    const suffix = activeCodes.length > 0 ? "\x1b[0m" : "";
    lines.push(currentIndent + currentLine.replace(/\s+$/, "") + suffix);
    currentIndent = nextIndent + activeCodes.join("");
    currentLine = "";
    currentLen = 0;
  };

  for (const rawToken of tokens) {
    if (/^\s+$/.test(rawToken)) {
      if (currentLen === 0) continue;
      const spaceWidth = rawToken.length;
      if (currentLen + spaceWidth <= availWidth()) {
        currentLine += rawToken;
        currentLen += spaceWidth;
      }
      continue;
    }

    const tokenLen = visibleLength(rawToken);
    if (currentLen > 0 && currentLen + tokenLen > availWidth()) {
      pushCurrentLine();
    }

    const limit = availWidth();
    if (tokenLen > limit) {
      const pieces = splitLongToken(rawToken, limit);
      for (let p = 0; p < pieces.length; p++) {
        const piece = pieces[p];
        if (p > 0) pushCurrentLine();
        currentLine += piece;
        currentLen += visibleLength(piece);
        updateSgrState(activeCodes, piece);
      }
    } else {
      currentLine += rawToken;
      currentLen += tokenLen;
      updateSgrState(activeCodes, rawToken);
    }
  }

  if (currentLine.length > 0 || lines.length === 0) {
    lines.push(currentIndent + currentLine.replace(/\s+$/, ""));
  }

  return lines.join("\n");
}

type MdBlock =
  | { type: "code"; lang: string; lines: string[] }
  | { type: "table"; headers: string[]; rows: string[][] }
  | { type: "text"; lines: string[] };

function isTableSeparatorLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed.startsWith("|")) return false;
  const cells = parseTableRow(trimmed);
  return cells.length > 0 && cells.every((c) => /^:?-{2,}:?$/.test(c.trim()));
}

function parseTableRow(line: string): string[] {
  let trimmed = line.trim();
  if (trimmed.startsWith("|")) trimmed = trimmed.slice(1);
  if (trimmed.endsWith("|")) trimmed = trimmed.slice(0, -1);
  return trimmed.split("|").map((c) => c.trim());
}

function splitMarkdownBlocks(markdown: string): MdBlock[] {
  const rawLines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: MdBlock[] = [];
  let textBuffer: string[] = [];

  const flushText = () => {
    if (textBuffer.length > 0) {
      blocks.push({ type: "text", lines: textBuffer });
      textBuffer = [];
    }
  };

  let i = 0;
  while (i < rawLines.length) {
    const line = rawLines[i];
    const fenceMatch = line.match(/^\s*```(.*)$/);
    if (fenceMatch) {
      flushText();
      const lang = fenceMatch[1].trim();
      const codeLines: string[] = [];
      i++;
      while (i < rawLines.length && !/^\s*```\s*$/.test(rawLines[i])) {
        codeLines.push(rawLines[i]);
        i++;
      }
      if (i < rawLines.length && /^\s*```\s*$/.test(rawLines[i])) {
        i++;
      }
      blocks.push({ type: "code", lang, lines: codeLines });
      continue;
    }

    if (line.trim().startsWith("|") && i + 1 < rawLines.length && isTableSeparatorLine(rawLines[i + 1])) {
      flushText();
      const headers = parseTableRow(line);
      const rows: string[][] = [];
      i += 2;
      while (i < rawLines.length && rawLines[i].trim().startsWith("|")) {
        if (!isTableSeparatorLine(rawLines[i])) {
          rows.push(parseTableRow(rawLines[i]));
        }
        i++;
      }
      blocks.push({ type: "table", headers, rows });
      continue;
    }

    textBuffer.push(line);
    i++;
  }
  flushText();
  return blocks;
}

function formatTextLine(line: string, maxWidth: number): string {
  const ruleWidth = Math.min(maxWidth, 76);
  const trimmed = line.trim();
  if (!trimmed) return "";

  if (/^([-*_])\1{2,}$/.test(trimmed)) {
    return chalk.dim("─".repeat(ruleWidth));
  }

  const hMatch = line.match(/^(#{1,4})\s+(.*)$/);
  if (hMatch) {
    const cleanHeading = stripAnsi(formatInlineMarkdown(hMatch[2]));
    const wrapped = wrapAnsiText(chalk.bold.whiteBright(cleanHeading), maxWidth);
    return `${wrapped}\n${chalk.dim("─".repeat(ruleWidth))}`;
  }

  const quoteMatch = line.match(/^>\s?(.*)$/);
  if (quoteMatch) {
    const bar = chalk.dim("│ ");
    return wrapAnsiText(chalk.italic(formatInlineMarkdown(quoteMatch[1])), maxWidth, bar, bar);
  }

  const bulletMatch = line.match(/^(\s*)[-*+]\s+(.*)$/);
  if (bulletMatch) {
    const indent = bulletMatch[1];
    const first = `${indent}• `;
    const next = `${indent}  `;
    return wrapAnsiText(formatInlineMarkdown(bulletMatch[2]), maxWidth, first, next);
  }

  const numMatch = line.match(/^(\s*)(\d+\.)\s+(.*)$/);
  if (numMatch) {
    const indent = numMatch[1];
    const num = numMatch[2];
    const first = `${indent}${num} `;
    const next = `${indent}${" ".repeat(num.length + 1)}`;
    return wrapAnsiText(formatInlineMarkdown(numMatch[3]), maxWidth, first, next);
  }

  return wrapAnsiText(formatInlineMarkdown(line), maxWidth);
}

function wrapTableCell(cell: string, colWidth: number): string[] {
  const limit = Math.max(1, colWidth);
  if (visibleLength(cell) <= limit) return [cell];
  const tokens = cell.split(/(\s+)/).filter((t) => t.length > 0);
  const lines: string[] = [];
  const activeCodes: string[] = [];
  let curLine = "";
  let curLen = 0;

  const pushLine = () => {
    const suffix = activeCodes.length > 0 ? "\x1b[0m" : "";
    lines.push(curLine.replace(/\s+$/, "") + suffix);
    curLine = activeCodes.join("");
    curLen = 0;
  };

  for (const tok of tokens) {
    if (/^\s+$/.test(tok)) {
      if (curLen === 0) continue;
      if (curLen + 1 <= limit) {
        curLine += " ";
        curLen += 1;
      }
      continue;
    }
    const tLen = visibleLength(tok);
    if (curLen > 0 && curLen + tLen > limit) {
      pushLine();
    }
    if (tLen > limit) {
      const pieces = splitLongToken(tok, limit);
      for (let p = 0; p < pieces.length; p++) {
        if (p > 0) pushLine();
        curLine += pieces[p];
        curLen += visibleLength(pieces[p]);
        updateSgrState(activeCodes, pieces[p]);
      }
    } else {
      curLine += tok;
      curLen += tLen;
      updateSgrState(activeCodes, tok);
    }
  }
  if (curLen > 0 || lines.length === 0) {
    const suffix = activeCodes.length > 0 ? "\x1b[0m" : "";
    lines.push(curLine.replace(/\s+$/, "") + suffix);
  }
  return lines;
}

function fitColumnWidths(naturalWidths: number[], maxWidth?: number): number[] {
  const colCount = naturalWidths.length;
  if (!maxWidth || colCount === 0) return naturalWidths;
  const overhead = 3 * colCount + 1;
  const totalNatural = naturalWidths.reduce((a, b) => a + b, 0) + overhead;
  if (totalNatural <= maxWidth) return naturalWidths;

  const availBudget = Math.max(colCount * 3, maxWidth - overhead);
  const widths = [...naturalWidths];
  const remaining = new Set<number>(naturalWidths.map((_, idx) => idx));
  let budgetLeft = availBudget;

  while (remaining.size > 0) {
    const fair = Math.max(3, Math.floor(budgetLeft / remaining.size));
    let lockedAny = false;
    for (const c of Array.from(remaining)) {
      if (widths[c] <= fair) {
        budgetLeft -= widths[c];
        remaining.delete(c);
        lockedAny = true;
      }
    }
    if (!lockedAny) {
      const remCols = Array.from(remaining);
      const remNaturalSum = remCols.reduce((acc, c) => acc + widths[c], 0) || 1;
      let allocated = 0;
      remCols.forEach((c, idx) => {
        if (idx === remCols.length - 1) {
          widths[c] = Math.max(3, budgetLeft - allocated);
        } else {
          const share = Math.max(3, Math.floor((widths[c] / remNaturalSum) * budgetLeft));
          widths[c] = share;
          allocated += share;
        }
      });
      break;
    }
  }
  return widths;
}

function renderTableLines(headers: string[], rows: string[][], maxWidth?: number): string[] {
  const colCount = Math.max(headers.length, ...rows.map((r) => r.length), 1);
  const formattedHeaders = Array.from({ length: colCount }, (_, c) =>
    chalk.bold.whiteBright(stripAnsi(formatInlineMarkdown(headers[c] ?? "")))
  );
  const formattedRows = rows.map((row) =>
    Array.from({ length: colCount }, (_, c) => formatInlineMarkdown(row[c] ?? ""))
  );

  const naturalWidths = Array.from({ length: colCount }, (_, c) =>
    Math.max(1, visibleLength(formattedHeaders[c]), ...formattedRows.map((r) => visibleLength(r[c])))
  );
  const widths = fitColumnWidths(naturalWidths, maxWidth);

  const border = (left: string, mid: string, right: string) =>
    chalk.dim(left + widths.map((w) => "─".repeat(w + 2)).join(mid) + right);

  const renderMultiLineRow = (cells: string[]): string[] => {
    const wrappedCells = cells.map((cell, c) => wrapTableCell(cell, widths[c]));
    const rowHeight = Math.max(1, ...wrappedCells.map((lines) => lines.length));
    const physicalLines: string[] = [];
    for (let lineIdx = 0; lineIdx < rowHeight; lineIdx++) {
      const lineStr =
        chalk.dim("│") +
        wrappedCells
          .map((cellLines, c) => ` ${padVisibleEnd(cellLines[lineIdx] ?? "", widths[c])} `)
          .join(chalk.dim("│")) +
        chalk.dim("│");
      physicalLines.push(lineStr);
    }
    return physicalLines;
  };

  return [
    border("┌", "┬", "┐"),
    ...renderMultiLineRow(formattedHeaders),
    border("├", "┼", "┤"),
    ...formattedRows.flatMap(renderMultiLineRow),
    border("└", "┴", "┘"),
  ];
}

export const CODE_CONTINUATION_MARKER = "\x1b[39;49m";

function renderCodeBlockLines(lang: string, codeLines: string[], maxWidth: number): string[] {
  const innerMax = Math.max(20, maxWidth - 4);
  const wrappedLines: Array<{ text: string; cont: boolean }> = [];
  for (const rawLine of codeLines) {
    if (visibleLength(rawLine) <= innerMax) {
      wrappedLines.push({ text: rawLine, cont: false });
    } else {
      const parts = splitLongToken(rawLine, innerMax);
      parts.forEach((p, idx) => wrappedLines.push({ text: p, cont: idx > 0 }));
    }
  }
  if (wrappedLines.length === 0) wrappedLines.push({ text: "", cont: false });

  const label = lang ? ` ${lang} ` : "";
  const copyHint = " copier ";
  const contentWidth = Math.min(
    innerMax,
    Math.max(visibleLength(label) + visibleLength(copyHint) + 4, ...wrappedLines.map((l) => visibleLength(l.text)), 16)
  );
  const availDashes = contentWidth + 2 - visibleLength(label) - 1;
  const showHint = availDashes >= visibleLength(copyHint) + 2;
  const topDashes = showHint ? availDashes - visibleLength(copyHint) - 1 : Math.max(0, availDashes);
  const top = showHint
    ? chalk.dim(`╭─${label}${"─".repeat(topDashes)}${copyHint}─╮`)
    : chalk.dim(`╭─${label}${"─".repeat(topDashes)}╮`);
  const bottom = chalk.dim(`╰${"─".repeat(contentWidth + 2)}╯`);
  const body = wrappedLines.map(
    (l) =>
      `${l.cont ? CODE_CONTINUATION_MARKER : ""}${chalk.dim("│")} ${chalk.cyan(
        padVisibleEnd(l.text, contentWidth)
      )} ${chalk.dim("│")}`
  );
  return [top, ...body, bottom];
}

export function renderMarkdownToLines(markdown: string, maxWidth: number, indent: string = ""): string[] {
  const effectiveWidth = Math.max(24, maxWidth - visibleLength(indent));
  const blocks = splitMarkdownBlocks(markdown);
  const out: string[] = [];

  for (const block of blocks) {
    if (block.type === "code") {
      for (const l of renderCodeBlockLines(block.lang, block.lines, effectiveWidth)) {
        out.push(indent + l);
      }
      continue;
    }
    if (block.type === "table") {
      for (const l of renderTableLines(block.headers, block.rows, effectiveWidth)) {
        out.push(indent + l);
      }
      continue;
    }
    for (const rawLine of block.lines) {
      const formatted = formatTextLine(rawLine, effectiveWidth);
      if (!formatted) {
        out.push("");
      } else {
        for (const sub of formatted.split("\n")) {
          out.push(sub ? indent + sub : "");
        }
      }
    }
  }
  return out;
}

export const MarkdownText: React.FC<{ text: string; width?: number; indent?: string }> = React.memo(
  ({ text, width, indent = "" }) => {
    const termCols = useTerminalColumns();
    const maxWidth = Math.max(40, (width ?? termCols) - 2);
    const rendered = React.useMemo(() => renderMarkdownToLines(text, maxWidth, indent).join("\n"), [text, maxWidth, indent]);

    return (
      <Box flexDirection="column">
        <Text>{rendered}</Text>
      </Box>
    );
  }
);
