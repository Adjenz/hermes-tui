#!/usr/bin/env node
import readline from "node:readline";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function loadConnectToDaemon() {
  const candidates = [
    process.env.PASEO_CLIENT_PATH,
    path.join(os.homedir(), ".npm-global/lib/node_modules/@getpaseo/cli/dist/utils/client.js"),
    path.join(os.homedir(), ".local/share/npm/lib/node_modules/@getpaseo/cli/dist/utils/client.js"),
    "/usr/local/lib/node_modules/@getpaseo/cli/dist/utils/client.js",
    "/usr/lib/node_modules/@getpaseo/cli/dist/utils/client.js",
  ].filter(Boolean);

  try {
    const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8", timeout: 3000 }).trim();
    if (npmRoot) {
      candidates.push(path.join(npmRoot, "@getpaseo/cli/dist/utils/client.js"));
    }
  } catch {
    // ignore if npm is not in PATH
  }

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      const mod = await import(pathToFileURL(candidate).href);
      if (typeof mod.connectToDaemon === "function") return mod.connectToDaemon;
    }
  }
  const mod = await import("@getpaseo/cli/dist/utils/client.js");
  return mod.connectToDaemon;
}

const PASEO_HOME = process.env.PASEO_HOME || path.join(os.homedir(), ".paseo");
const TIMELINE_LIMIT = 120;
const UPLOAD_DIR = path.join(PASEO_HOME, "uploads");
const MAX_UPLOAD_BYTES = 40 * 1024 * 1024;

function emit(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`);
}

function statusRank(status) {
  if (status === "running") return 0;
  if (status === "idle") return 1;
  return 2;
}

function compactAgent(entry) {
  const a = entry.agent ?? entry;
  const p = entry.project ?? null;
  return {
    id: a.id,
    title: a.title || p?.workspaceName || a.id.slice(0, 8),
    projectName: p?.projectName ?? "",
    workspaceName: p?.workspaceName ?? "",
    provider: a.provider,
    cwd: a.cwd,
    status: a.status,
    model: a.model ?? a.runtimeInfo?.model ?? null,
    modeId: a.currentModeId ?? a.runtimeInfo?.modeId ?? "default",
    availableModes: a.availableModes ?? [],
    thinkingOptionId: a.effectiveThinkingOptionId ?? a.thinkingOptionId ?? a.runtimeInfo?.thinkingOptionId ?? null,
    updatedAt: a.updatedAt ?? a.createdAt ?? "",
    workspaceId: a.workspaceId ?? null,
    persistence: a.persistence ?? null,
    archivedAt: a.archivedAt ?? null,
    requiresAttention: Boolean(a.requiresAttention),
    lastUsage: a.lastUsage ?? null,
    pendingPermissions: a.pendingPermissions ?? [],
  };
}

function isArchived(a) {
  return Boolean(a.archivedAt) || /^\s*\[ARCHIVE\]/i.test(a.title || "");
}

function saveUploads(files) {
  const saved = [];
  if (!Array.isArray(files) || files.length === 0) return saved;
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
  for (const f of files) {
    const buf = Buffer.from(String(f.data || ""), "base64");
    if (buf.length === 0 || buf.length > MAX_UPLOAD_BYTES) {
      throw new Error(`Fichier invalide ou trop volumineux (${f.name}, max 40 Mo)`);
    }
    const safe = String(f.name || "fichier").replace(/[^\w.\-]+/g, "_").slice(-80) || "fichier";
    const dest = path.join(UPLOAD_DIR, `${Date.now()}-${Math.random().toString(36).slice(2, 6)}-${safe}`);
    fs.writeFileSync(dest, buf);
    saved.push({ path: dest, name: f.name, mimeType: f.mimeType || "application/octet-stream", data: f.data, size: buf.length });
  }
  return saved;
}

function sortHermesAgents(entries) {
  return entries
    .map(compactAgent)
    .filter((a) => a.provider === "hermes" && !isArchived(a))
    .sort((a, b) => {
      const rDiff = statusRank(a.status) - statusRank(b.status);
      if (rDiff !== 0) return rDiff;
      return String(b.updatedAt).localeCompare(String(a.updatedAt));
    });
}

async function main() {
  const connectToDaemon = await loadConnectToDaemon();
  const client = await connectToDaemon({
    target: { kind: "instance", home: PASEO_HOME },
  });

  let agentsMap = new Map();
  let cachedModels = null;
  let activeAgentId = null;
  let activeUnsub = null;
  let observeSub = null;
  let refreshTimer = null;

  async function refreshAgentsList(emitUpdate = true) {
    const res = await client.fetchAgents({});
    const nextMap = new Map();
    for (const entry of res.entries ?? []) {
      const a = compactAgent(entry);
      if (a.provider === "hermes" && !isArchived(a)) {
        nextMap.set(a.id, entry);
      }
    }
    agentsMap = nextMap;
    const sorted = sortHermesAgents(Array.from(agentsMap.values()));
    if (emitUpdate) {
      emit({ type: "agents_updated", agents: sorted });
    }
    return sorted;
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refreshAgentsList(true).catch((err) => {
        emit({ type: "error", message: String(err?.message || err) });
      });
    }, 120);
  }

  async function getModels() {
    if (cachedModels) return cachedModels;
    const res = await client.listProviderModels("hermes").catch(() => ({ models: [] }));
    cachedModels = (res?.models ?? []).map((m) => ({
      id: m.id,
      label: m.label ?? m.id,
      description: m.description ?? "",
      isDefault: Boolean(m.isDefault),
      thinkingOptions: (m.thinkingOptions ?? []).map((t) => ({
        id: t.id,
        label: t.label ?? t.id,
        isDefault: Boolean(t.isDefault),
      })),
    }));
    return cachedModels;
  }

  async function loadTimeline(agentId) {
    const timeline = await client.fetchAgentTimeline(agentId, {
      direction: "tail",
      limit: 0,
      projection: "projected",
      timeout: 4000,
    });
    return (timeline?.entries ?? []).slice(-TIMELINE_LIMIT).map((entry) => entry.item);
  }

  async function loadCommands(agentId, status) {
    if (status === "closed") return [];
    const timeoutPromise = new Promise((resolve) => setTimeout(() => resolve({ commands: [] }), 1000));
    const res = await Promise.race([
      client.listCommands({ agentId }).catch(() => ({ commands: [] })),
      timeoutPromise,
    ]);
    return (res?.commands ?? []).map((c) => ({
      name: c.name,
      description: c.description ?? "",
      argumentHint: c.argumentHint ?? "",
    }));
  }

  async function subscribeToAgent(agentId) {
    if (activeUnsub) {
      try {
        activeUnsub();
      } catch {
        // ignore
      }
      activeUnsub = null;
    }
    activeAgentId = agentId;
    if (!agentId) return;

    const unsub = client.subscribeAgentTimeline(agentId, (message) => {
      if (agentId !== activeAgentId) return;
      emit({ type: "stream_event", agentId, message });
    });
    activeUnsub = unsub;
    try {
      await unsub.ready;
    } catch (err) {
      emit({ type: "error", message: `Timeline subscription error: ${err?.message || err}` });
    }
  }

  observeSub = client.observeAgents({});
  observeSub.subscribe({
    snapshot() {},
    update(msg) {
      if (msg?.type === "agent_update") {
        scheduleRefresh();
      }
    },
    error(err) {
      emit({ type: "error", message: `Observe error: ${err?.message || err}` });
    },
  });

  async function handleCommand(msg) {
    const cmd = msg?.cmd;
    if (cmd === "init") {
      const [agents, models] = await Promise.all([refreshAgentsList(false), getModels()]);
      const requestedId = msg.agentId && agents.some((a) => a.id === msg.agentId)
        ? msg.agentId
        : agents[0]?.id ?? null;

      let timeline = [];
      let commands = [];
      if (requestedId) {
        const target = agents.find((a) => a.id === requestedId);
        void subscribeToAgent(requestedId);
        [timeline, commands] = await Promise.all([
          loadTimeline(requestedId).catch(() => []),
          loadCommands(requestedId, target?.status),
        ]);
      }
      emit({
        type: "init_ok",
        agents,
        models,
        activeAgentId: requestedId,
        timeline,
        commands,
      });
      return;
    }

    if (cmd === "switch_agent") {
      const agentId = msg.agentId;
      if (!agentId) throw new Error("Missing agentId");
      const entry = agentsMap.get(agentId);
      const status = entry ? compactAgent(entry).status : undefined;
      void subscribeToAgent(agentId);
      const [timeline, commands] = await Promise.all([
        loadTimeline(agentId).catch(() => []),
        loadCommands(agentId, status),
      ]);
      emit({ type: "agent_switched", agentId, timeline, commands });
      return;
    }

    if (cmd === "send") {
      const agentId = msg.agentId || activeAgentId;
      const text = msg.text;
      if (!agentId || typeof text !== "string" || !text.trim()) {
        throw new Error("Missing agentId or text");
      }
      const agents = await refreshAgentsList(false);
      const target = agents.find((a) => a.id === agentId);
      if (target && target.status === "closed" && target.persistence) {
        await client.resumeAgent(target.persistence).catch(() => {});
      }
      const saved = saveUploads(msg.files);
      let fullText = text;
      if (saved.length > 0) {
        fullText += "\n\n[Fichiers joints (sur cette machine)]\n" + saved.map((f) => `- ${f.path} (${f.mimeType}, ${Math.round(f.size / 1024)} Ko)`).join("\n");
      }
      const images = saved.filter((f) => f.mimeType.startsWith("image/")).map((f) => ({ data: f.data, mimeType: f.mimeType }));
      const receipt = await client.sendAgentMessage(agentId, fullText, {
        activeTurnBehavior: msg.behavior || "steer",
        ...(images.length > 0 ? { images } : {}),
      });
      emit({ type: "send_ack", agentId, deliveryStatus: receipt?.deliveryStatus ?? "sent" });
      return;
    }

    if (cmd === "create_agent") {
      const refEntry = msg.fromAgentId ? agentsMap.get(msg.fromAgentId) : null;
      const ref = refEntry ? compactAgent(refEntry) : null;
      const cwd = msg.cwd || ref?.cwd || os.homedir();
      const created = await client.createAgent({
        provider: "hermes",
        cwd,
        ...(msg.title ? { title: msg.title } : {}),
        ...(ref?.workspaceId ? { workspaceId: ref.workspaceId } : {}),
        ...(ref?.model ? { model: ref.model } : {}),
        ...(ref?.thinkingOptionId ? { thinkingOptionId: ref.thinkingOptionId } : {}),
        ...(ref?.modeId ? { modeId: ref.modeId } : {}),
      });
      await refreshAgentsList(true);
      const newId = created.id;
      void subscribeToAgent(newId);
      const [timeline, commands] = await Promise.all([
        loadTimeline(newId).catch(() => []),
        loadCommands(newId, created.status),
      ]);
      emit({ type: "agent_switched", agentId: newId, timeline, commands });
      return;
    }

    if (cmd === "archive_agent") {
      const agentId = msg.agentId || activeAgentId;
      if (!agentId) return;
      await client.archiveAgent(agentId);
      await refreshAgentsList(true);
      emit({ type: "archived", agentId });
      return;
    }

    if (cmd === "cancel") {
      const agentId = msg.agentId || activeAgentId;
      if (!agentId) return;
      await client.cancelAgent(agentId);
      emit({ type: "notice", text: "Tour annulé." });
      return;
    }

    if (cmd === "set_model") {
      const agentId = msg.agentId || activeAgentId;
      const modelId = msg.modelId;
      if (!agentId || !modelId) throw new Error("Missing agentId or modelId");
      await client.setAgentModel(agentId, modelId);
      await refreshAgentsList(true);
      emit({ type: "notice", text: `Modèle changé → ${modelId}` });
      return;
    }

    if (cmd === "set_thinking") {
      const agentId = msg.agentId || activeAgentId;
      const thinkingId = msg.thinkingId;
      if (!agentId || !thinkingId) throw new Error("Missing agentId or thinkingId");
      await client.setAgentThinkingOption(agentId, thinkingId);
      await refreshAgentsList(true);
      emit({ type: "notice", text: `Thinking → ${thinkingId}` });
      return;
    }

    if (cmd === "set_mode") {
      const agentId = msg.agentId || activeAgentId;
      const modeId = msg.modeId;
      if (!agentId || !modeId) throw new Error("Missing agentId or modeId");
      await client.setAgentMode(agentId, modeId);
      await refreshAgentsList(true);
      emit({ type: "notice", text: `Mode → ${modeId}` });
      return;
    }

    if (cmd === "reload_timeline") {
      const agentId = msg.agentId || activeAgentId;
      if (!agentId) return;
      const timeline = await loadTimeline(agentId);
      emit({ type: "timeline_reloaded", agentId, timeline });
      return;
    }

    if (cmd === "respond_permission") {
      const { agentId, requestId, response } = msg;
      await client.respondToPermission(agentId || activeAgentId, requestId, response);
      emit({ type: "notice", text: "Permission envoyée." });
      return;
    }
  }

  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  let chain = Promise.resolve();
  rl.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    chain = chain.then(async () => {
      try {
        const msg = JSON.parse(trimmed);
        await handleCommand(msg);
      } catch (err) {
        emit({ type: "error", message: String(err?.message || err) });
      }
    });
  });

  const cleanup = async () => {
    try {
      if (activeUnsub) activeUnsub();
      if (observeSub) await observeSub.release().catch(() => {});
      await client.close().catch(() => {});
    } finally {
      process.exit(0);
    }
  };

  rl.on("close", () => {
    chain.finally(cleanup);
  });
  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);
}

main().catch((err) => {
  emit({ type: "fatal", message: String(err?.stack || err?.message || err) });
  process.exit(1);
});
