import type { PromptPolicyFragmentId, PromptPolicySelection, SubTask } from './types.js';

export const PROMPT_POLICY_VERSION = 'worker-policy-v1';

const FRAGMENT_TEXT: Record<PromptPolicyFragmentId, string[]> = {
  strict_file_boundary: [
    'Modify ONLY the files listed in "Files to create/modify".',
    'If you believe another file is required, stop and explain why instead of editing outside scope.',
  ],
  exact_api_signatures: [
    'Before changing call sites or tests, verify the exact import path, exported symbol names, and function signatures from the real source files.',
    'Do not guess API names or argument order.',
  ],
  json_structure_sample: [
    'When reading or writing JSON/config data, inspect the actual on-disk structure first and mirror the real field names and nesting.',
    'Do not invent schema fields from memory.',
  ],
  output_format_guard: [
    'Your final file content must match the requested output format exactly.',
    'Do not write tool traces, JSON tool-call records, or meta commentary into deliverable files unless explicitly requested.',
  ],
  acceptance_checklist: [
    'Before finishing, re-check every acceptance criterion one by one and ensure the diff directly satisfies each item.',
  ],
};

function hasKeyword(task: SubTask, patterns: RegExp[]): boolean {
  const haystack = [
    task.description,
    task.category,
    ...task.acceptance_criteria,
    ...task.estimated_files,
  ].join('\n');
  return patterns.some((pattern) => pattern.test(haystack));
}

export function selectPromptPolicy(
  task: SubTask,
  learnedFragments: PromptPolicyFragmentId[] = [],
): PromptPolicySelection {
  const selected = new Set<PromptPolicyFragmentId>(learnedFragments);
  const reasons: string[] = [];

  if (task.estimated_files.length > 0) {
    selected.add('strict_file_boundary');
    reasons.push('task declares an explicit file scope');
  }

  selected.add('acceptance_checklist');
  reasons.push('all tasks benefit from an explicit acceptance re-check');

  if (hasKeyword(task, [/\bapi\b/i, /\bimport\b/i, /\bsignature\b/i, /\btest/i])) {
    selected.add('exact_api_signatures');
    reasons.push('task text suggests API-sensitive edits');
  }

  if (hasKeyword(task, [/\bjson\b/i, /\bconfig\b/i, /\bschema\b/i, /\.json\b/i, /\.ya?ml\b/i])) {
    selected.add('json_structure_sample');
    reasons.push('task touches structured config or serialized data');
  }

  if (hasKeyword(task, [/\bmarkdown\b/i, /\breport\b/i, /\boutput\b/i, /\bformat\b/i, /\bdoc\b/i])) {
    selected.add('output_format_guard');
    reasons.push('task mentions a concrete output format');
  }

  if (learnedFragments.length > 0) {
    reasons.push(`learned hints enabled: ${[...new Set(learnedFragments)].join(', ')}`);
  }

  return {
    version: PROMPT_POLICY_VERSION,
    fragments: [...selected],
    reasons: [...new Set(reasons)],
  };
}

export function renderPromptPolicy(selection: PromptPolicySelection | undefined): string {
  if (!selection || selection.fragments.length === 0) {
    return '';
  }

  const lines = [
    '### Prompt Policy',
    `- version: ${selection.version}`,
    ...selection.fragments.flatMap((fragment) => [
      `- ${fragment}:`,
      ...FRAGMENT_TEXT[fragment].map((line) => `  - ${line}`),
    ]),
  ];

  return lines.join('\n');
}
