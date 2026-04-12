const FAMILY_DEFAULT_CANDIDATES: Record<string, string[]> = {
  gpt: ['gpt-5.4', 'gpt-5', 'gpt-5-codex'],
  openai: ['gpt-5.4', 'gpt-5', 'gpt-5-codex'],
  kimi: ['kimi-for-coding', 'kimi-k2.5'],
  qwen: ['qwen3.5-plus', 'qwen3-max', 'qwen3.6-plus'],
  glm: ['glm-5.1', 'glm-5-turbo', 'glm-5'],
  minimax: ['MiniMax-M2.7', 'MiniMax-M2.5', 'MiniMax-M2.1'],
  mimo: ['mimo-v2-pro', 'mimo-v2-omni', 'mimo-v2-tts'],
};

export function resolveKnownFamilyDefault(
  alias: string,
  hasModel: (modelId: string) => boolean,
): string | undefined {
  const candidates = FAMILY_DEFAULT_CANDIDATES[alias.toLowerCase()];
  if (!candidates) {
    return undefined;
  }

  return candidates.find((modelId) => hasModel(modelId));
}
