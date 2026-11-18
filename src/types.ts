export interface ThinkingOption {
  id: string;
  label: string;
  isDefault: boolean;
}

export interface HermesModel {
  id: string;
  label: string;
  description: string;
  isDefault: boolean;
  thinkingOptions: ThinkingOption[];
}

export interface HermesMode {
  id: string;
  label?: string;
  name?: string;
  description?: string;
}

export interface AgentUsage {
  inputTokens?: number;
  cachedInputTokens?: number;
  outputTokens?: number;
  contextWindowMaxTokens?: number;
  contextWindowUsedTokens?: number;
}

export interface HermesAgent {
  id: string;
  title: string;
  projectName: string;
  workspaceName: string;
  provider: string;
  cwd: string;
  status: "running" | "idle" | "closed" | string;
  model: string | null;
  modeId: string;
  availableModes: HermesMode[];
  thinkingOptionId: string | null;
  updatedAt: string;
  requiresAttention: boolean;
  workspaceId?: string | null;
  lastUsage?: AgentUsage | null;
}

export interface SlashCommand {
  name: string;
  description: string;
  argumentHint?: string;
  isLocal?: boolean;
  displayName?: string;
  fillValue?: string;
  submitOnEnter?: boolean;
}

export interface TimelineItem {
  type: string;
  text?: string;
  message?: string;
  messageId?: string;
  callId?: string;
  name?: string;
  status?: string;
  error?: unknown;
  detail?: {
    type?: string;
    label?: string;
    text?: string;
    command?: string;
    output?: string;
    filePath?: string;
    unifiedDiff?: string;
  };
  metadata?: {
    kind?: string;
    title?: string;
  };
  items?: Array<{ text?: string; title?: string; completed?: boolean }>;
  level?: string;
  timestamp?: string;
}

export interface WorkStep {
  kind: "tool";
  toolName: string;
  title: string;
  command: string;
  output: string;
  status: string;
  timestamp?: string;
}

export interface StaticEntry {
  key: string;
  kind: "banner" | "user" | "assistant" | "work_group" | "notice" | "error";
  title?: string;
  text: string;
  status?: string;
  steps?: WorkStep[];
  summary?: string;
  timestamp?: string;
}

export interface PermissionPrompt {
  agentId: string;
  requestId: string;
  name: string;
  description?: string;
  options: Array<{ id: string; label: string; kind?: string }>;
}
