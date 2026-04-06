function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function truncate(value: string, limit = 180): string {
  return value.length <= limit ? value : `${value.slice(0, limit - 3)}...`;
}

function parseStructuredValue(value: string): Record<string, unknown> | null {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function summarizeStructuredPrefix(value: string): string | undefined {
  const toolUseMatch = value.match(/"type":"tool_use".*?"name":"([^"]+)"/);
  if (toolUseMatch) {
    return `Running tool: ${toolUseMatch[1]}`;
  }

  if (value.includes('"type":"system"') && value.includes('"subtype":"init"')) {
    return 'Worker session started';
  }

  const assistantMatch = value.match(/"type":"assistant".*?"content":"([^"]+)/);
  if (assistantMatch) {
    return summarizeWorkerSurfaceText(assistantMatch[1], 1);
  }

  return undefined;
}

function summarizeStructuredValue(
  payload: Record<string, unknown>,
  depth: number,
): string | undefined {
  if (depth > 2) return undefined;

  const nestedContent = typeof payload.content === 'string'
    ? summarizeWorkerSurfaceText(payload.content, depth + 1)
    : undefined;
  const type = typeof payload.type === 'string' ? payload.type : '';

  if (type === 'tool_use') {
    const toolName = typeof payload.name === 'string' ? payload.name : 'tool';
    return `Running tool: ${toolName}`;
  }

  if (type === 'tool_result') {
    return nestedContent || 'Processing tool result';
  }

  if (type === 'system') {
    const subtype = typeof payload.subtype === 'string' ? payload.subtype : '';
    if (subtype === 'init') return 'Worker session started';
    return nestedContent || undefined;
  }

  if (type === 'assistant') {
    return nestedContent || 'Assistant response available';
  }

  return nestedContent || undefined;
}

export function summarizeWorkerSurfaceText(
  value?: string,
  depth = 0,
): string | undefined {
  if (!value) return undefined;
  const normalized = normalizeWhitespace(value);
  if (!normalized) return undefined;

  const structured = parseStructuredValue(normalized);
  if (structured) {
    const summary = summarizeStructuredValue(structured, depth);
    if (summary) return truncate(summary);
  }

  const structuredPrefix = summarizeStructuredPrefix(normalized);
  if (structuredPrefix) {
    return truncate(structuredPrefix);
  }

  return truncate(normalized);
}

export function pickWorkerSurfaceSummary(
  ...candidates: Array<string | undefined>
): string | undefined {
  for (const candidate of candidates) {
    const summary = summarizeWorkerSurfaceText(candidate);
    if (summary) return summary;
  }
  return undefined;
}
