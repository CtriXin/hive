import fs from 'fs';
import path from 'path';
import type {
  DoneCondition,
  DoneConditionType,
  PolicyHook,
  PolicyHookStage,
  VerificationScope,
} from './types.js';

export interface ProjectVerificationPolicy {
  source: string;
  done_conditions: DoneCondition[];
  hooks: PolicyHook[];
}

function parseScope(raw: string | undefined): VerificationScope {
  if (raw === 'worktree' || raw === 'suite' || raw === 'both') {
    return raw;
  }
  return 'both';
}

function parseType(raw: string): DoneConditionType | null {
  if (
    raw === 'test'
    || raw === 'build'
    || raw === 'lint'
    || raw === 'command'
    || raw === 'file_exists'
    || raw === 'review_pass'
  ) {
    return raw;
  }
  return null;
}

function parseJsonBlock(markdown: string): { done_conditions: DoneCondition[]; hooks: PolicyHook[] } | null {
  const match = markdown.match(/```(?:json|hive-project)\s*([\s\S]*?)```/i);
  if (!match?.[1]) return null;

  try {
    const parsed = JSON.parse(match[1]);
    const rawConditions = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsed?.done_conditions)
        ? parsed.done_conditions
        : null;
    const doneConditions = rawConditions
      ? rawConditions.flatMap((item: any): DoneCondition[] => {
        const type = parseType(String(item?.type || ''));
        if (!type) return [];
        return [{
          type,
          label: String(item?.label || item?.command || item?.path || type),
          command: typeof item?.command === 'string' ? item.command : undefined,
          path: typeof item?.path === 'string' ? item.path : undefined,
          must_pass: item?.must_pass !== false,
          timeout_ms: typeof item?.timeout_ms === 'number' ? item.timeout_ms : undefined,
          scope: parseScope(item?.scope),
        }];
      })
      : [];

    const rawHooks = Array.isArray(parsed?.hooks) ? parsed.hooks : [];
    const hooks = rawHooks.flatMap((item: any): PolicyHook[] => {
      const stage = parseHookStage(item?.stage);
      const command = typeof item?.command === 'string' ? item.command : '';
      if (!stage || !command) return [];
      return [{
        stage,
        label: String(item?.label || command),
        command,
        must_pass: item?.must_pass !== false,
      }];
    });

    if (doneConditions.length === 0 && hooks.length === 0) return null;
    return { done_conditions: doneConditions, hooks };
  } catch {
    return null;
  }
}

function parseListItem(line: string): DoneCondition | PolicyHook | null {
  const content = line.replace(/^\s*-\s*/, '').trim();
  const parts = content.split('|').map((part) => part.trim());
  if (parts.length < 2) return null;

  if (parts[0] === 'hook') {
    const stage = parseHookStage(parts[1]);
    const command = parts[2] || '';
    const label = parts[3] || command;
    const mustPass = parts[4] ? parts[4].toLowerCase() !== 'optional' : true;
    if (!stage || !command) return null;
    return {
      stage,
      label,
      command,
      must_pass: mustPass,
    };
  }

  const type = parseType(parts[0]);
  if (!type) return null;

  const commandOrPath = parts[1];
  const label = parts[2] || commandOrPath;
  const scope = parseScope(parts[3]);
  const mustPass = parts[4] ? parts[4].toLowerCase() !== 'optional' : true;

  return {
    type,
    label,
    command: type === 'file_exists' || type === 'review_pass' ? undefined : commandOrPath,
    path: type === 'file_exists' ? commandOrPath : undefined,
    must_pass: mustPass,
    scope,
  };
}

function parseMarkdownList(markdown: string): { done_conditions: DoneCondition[]; hooks: PolicyHook[] } {
  const items = markdown
    .split('\n')
    .filter((line) => /^\s*-\s+/.test(line))
    .map((line) => parseListItem(line))
    .filter((item): item is DoneCondition | PolicyHook => item !== null);

  return {
    done_conditions: items.filter((item): item is DoneCondition => 'type' in item),
    hooks: items.filter((item): item is PolicyHook => 'stage' in item && 'command' in item && !('type' in item)),
  };
}

export function loadProjectVerificationPolicy(cwd: string): ProjectVerificationPolicy | null {
  const filePath = path.join(cwd, '.hive', 'project.md');
  if (!fs.existsSync(filePath)) return null;

  try {
    const markdown = fs.readFileSync(filePath, 'utf-8');
    const jsonPolicy = parseJsonBlock(markdown);
    const markdownPolicy = parseMarkdownList(markdown);
    const doneConditions = jsonPolicy && jsonPolicy.done_conditions.length > 0
      ? jsonPolicy.done_conditions
      : markdownPolicy.done_conditions;
    const hooks = jsonPolicy && jsonPolicy.hooks.length > 0
      ? jsonPolicy.hooks
      : markdownPolicy.hooks;

    if (doneConditions.length === 0 && hooks.length === 0) return null;
    return {
      source: filePath,
      done_conditions: doneConditions,
      hooks,
    };
  } catch {
    return null;
  }
}
function parseHookStage(raw: string | undefined): PolicyHookStage | null {
  if (raw === 'pre_merge' || raw === 'post_verify') {
    return raw;
  }
  return null;
}
