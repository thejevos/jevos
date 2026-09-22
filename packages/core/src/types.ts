export interface Action {
  tool: string;
  args?: Record<string, unknown>;
  rationale?: string;
}

export interface HistoryEntry {
  step: number;
  action: Action;
  ok: boolean;
  observation?: string;
  error?: string;
}

export interface Tool {
  name: string;
  description: string;
  /** Free-form grouping ("financial", "communication", ...) used for per-category thresholds. */
  category?: string;
}

export interface ContextItem {
  id: string;
  content: string;
  pinned?: boolean;
}

export interface Budget {
  tokens?: number;
  cost?: number;
  time?: number;
}

/**
 * Normalized, framework-agnostic view of an agent. The control plane never
 * cares which framework produced it.
 */
export interface AgentState {
  task: string;
  goal: {
    description: string;
    status: "active" | "complete" | "failed";
  };
  history: HistoryEntry[];
  /** The action the agent is proposing to take next, if any. */
  currentAction?: Action;
  tools: Tool[];
  context: ContextItem[];
  budget?: Budget;
  metadata?: Record<string, unknown>;
}

export function createState(task: string, tools: Tool[], goal?: string): AgentState {
  return {
    task,
    goal: { description: goal ?? task, status: "active" },
    history: [],
    tools,
    context: [],
  };
}
