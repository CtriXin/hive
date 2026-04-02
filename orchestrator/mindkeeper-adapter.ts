// orchestrator/mindkeeper-adapter.ts — Stub for hiveshell-dashboard dependency
// Full implementation in feature/hive-hiveshell-mainbase branch (C group)

export interface MindkeeperCheckpointPayload {
  repo: string;
  task: string;
  branch?: string;
  parent?: string;
  cli: string;
  model: string;
  decisions: string[];
  changes: string[];
  findings: string[];
  next: string[];
  status: string;
}
