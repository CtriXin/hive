import fs from 'fs';
import os from 'os';
import path from 'path';

export interface CompactConversationContext {
  version: 1;
  source: 'claude_postcompact' | 'claude_session';
  summary: string;
  volatile_facts: string[];
  updated_at: string;
  session_id?: string;
  project_dir?: string;
}

interface ClaudeSessionRecord {
  type?: string;
  isCompactSummary?: boolean;
  sessionId?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
}

function truncate(text: string, limit: number): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit - 3)}...`;
}

function encodeClaudeProjectDir(cwd: string): string {
  return cwd.replace(/[:/\\]/g, '-');
}

function claudeProjectsRoot(): string {
  return process.env.CLAUDE_PROJECTS_ROOT || path.join(os.homedir(), '.claude', 'projects');
}

function projectDir(cwd: string): string {
  return path.join(claudeProjectsRoot(), encodeClaudeProjectDir(cwd));
}

function listSessionFiles(cwd: string): string[] {
  const dir = projectDir(cwd);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((entry) => entry.endsWith('.jsonl'))
    .map((entry) => path.join(dir, entry))
    .sort((a, b) => {
      const aTime = fs.statSync(a).mtimeMs;
      const bTime = fs.statSync(b).mtimeMs;
      return bTime - aTime;
    });
}

function parseJsonLines(filePath: string): ClaudeSessionRecord[] {
  try {
    return fs.readFileSync(filePath, 'utf-8')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ClaudeSessionRecord);
  } catch {
    return [];
  }
}

function extractText(content: unknown): string | null {
  if (typeof content === 'string') {
    const normalized = content.trim();
    return normalized || null;
  }
  return null;
}

function collectRelevantCompactLines(summary: string): string[] {
  const lines = summary
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  const picked: string[] = [];
  let captureSection = false;
  for (const line of lines) {
    const normalized = line.replace(/^[-*]\s+/, '').trim();
    if (!normalized) continue;
    if (/^(Summary:|1\. Primary Request and Intent:|5\. Problem Solving:|7\. Pending Tasks:|8\. Current Work:|9\. Optional Next Step:)/i.test(normalized)) {
      captureSection = true;
      if (!picked.includes(normalized)) picked.push(normalized);
      continue;
    }
    if (/^\d+\.\s[A-Z].+:/.test(normalized)) {
      captureSection = false;
    }
    if (captureSection || /(记住|remember|数字|number|偏好|测试|just know it|不要记|don't save)/i.test(normalized)) {
      if (!picked.includes(normalized)) picked.push(normalized);
    }
    if (picked.length >= 8) break;
  }

  if (picked.length === 0) {
    return lines.slice(0, 6).map((line) => truncate(line, 180));
  }
  return picked.map((line) => truncate(line, 180));
}

function buildFacts(summary: string): string[] {
  const facts = collectRelevantCompactLines(summary)
    .filter((line) => !line.includes('/Users/'))
    .map((line) => line.replace(/^\d+\.\s*/, '').trim())
    .filter((line) => !/^(Summary:|Primary Request and Intent:|Pending Tasks:|Current Work:|Optional Next Step:|Problem Solving:|Created with Write tool.*)$/i.test(line))
    .filter(Boolean);
  return Array.from(new Set(facts)).slice(0, 4);
}

export function buildConversationContextFromCompactSummary(
  summary: string,
  sessionId?: string,
  cwd?: string,
): CompactConversationContext | null {
  const normalized = summary.trim();
  if (!normalized) return null;
  const facts = buildFacts(normalized);
  return {
    version: 1,
    source: 'claude_postcompact',
    summary: truncate(normalized, 1400),
    volatile_facts: facts,
    updated_at: new Date().toISOString(),
    session_id: sessionId,
    project_dir: cwd ? projectDir(cwd) : undefined,
  };
}

export function buildConversationContextFromRecentSession(cwd: string): CompactConversationContext | null {
  const files = listSessionFiles(cwd);
  for (const filePath of files) {
    const records = parseJsonLines(filePath);
    const compactRecord = [...records].reverse().find((record) => record.type === 'user' && record.isCompactSummary);
    const compactText = extractText(compactRecord?.message?.content);
    if (compactText) {
      return buildConversationContextFromCompactSummary(
        compactText,
        compactRecord?.sessionId,
        cwd,
      );
    }

    const recentUserTexts = [...records]
      .reverse()
      .filter((record) => record.type === 'user' && !record.isCompactSummary)
      .map((record) => extractText(record.message?.content))
      .filter((value): value is string => Boolean(value))
      .filter((text) => !/^(按 \.ai\/restore|hive status|hive workers|hive score|\/compact)/i.test(text))
      .slice(0, 4)
      .reverse();

    if (recentUserTexts.length > 0) {
      const facts = recentUserTexts.map((text) => truncate(text, 180));
      return {
        version: 1,
        source: 'claude_session',
        summary: truncate(facts.join(' | '), 1000),
        volatile_facts: facts,
        updated_at: new Date().toISOString(),
        session_id: path.basename(filePath, '.jsonl'),
        project_dir: projectDir(cwd),
      };
    }
  }

  return null;
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function restoreDir(cwd: string): string {
  return path.join(cwd, '.ai', 'restore');
}

export function conversationContextJsonPath(cwd: string): string {
  return path.join(restoreDir(cwd), 'latest-compact-conversation.json');
}

export function conversationContextMarkdownPath(cwd: string): string {
  return path.join(restoreDir(cwd), 'latest-compact-conversation.md');
}

export function renderConversationContextMarkdown(context: CompactConversationContext): string {
  const lines = [
    '# Hive Compact Conversation Context',
    '',
    `- source: ${context.source}`,
    `- updated: ${context.updated_at}`,
    `- session: ${context.session_id || '-'}`,
    '',
    '## Volatile Facts',
    '',
  ];

  if (context.volatile_facts.length > 0) {
    context.volatile_facts.forEach((fact) => lines.push(`- ${fact}`));
  } else {
    lines.push('- none');
  }

  lines.push('', '## Summary', '', context.summary);
  return lines.join('\n');
}

export function saveConversationContext(cwd: string, context: CompactConversationContext): {
  jsonPath: string;
  markdownPath: string;
} {
  ensureDir(restoreDir(cwd));
  const jsonPath = conversationContextJsonPath(cwd);
  const markdownPath = conversationContextMarkdownPath(cwd);
  fs.writeFileSync(jsonPath, JSON.stringify(context, null, 2));
  fs.writeFileSync(markdownPath, `${renderConversationContextMarkdown(context)}\n`, 'utf-8');
  return { jsonPath, markdownPath };
}

export function loadConversationContext(cwd: string): CompactConversationContext | null {
  try {
    const filePath = conversationContextJsonPath(cwd);
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CompactConversationContext;
  } catch {
    return null;
  }
}
