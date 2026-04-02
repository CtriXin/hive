import type { TranslationResult } from './types.js';
import { resolveProvider } from './provider-resolver.js';
import { getRegistry } from './model-registry.js';
import { ensureStageModelAllowed, loadConfig, resolveTierModel } from './hive-config.js';
import { buildSdkEnv } from './project-paths.js';
import { safeQuery, extractTextFromMessages, extractTokenUsage } from './sdk-query-safe.js';

const TRANSLATE_PROMPT = `You are a precise technical translator.
Translate the following Chinese input into clean, natural English suitable as a prompt for an AI coding assistant.

RULES:
- Preserve all technical terms in their original English form
- Do NOT add information that isn't in the original
- Do NOT remove or simplify anything
- Output ONLY the English translation, no explanations
- If the input is already in English, output it as-is
- Keep code snippets, file paths, and variable names unchanged

Chinese input:
`;

export async function translateToEnglish(
  chineseInput: string,
  translatorModel: string,
  translatorProvider: string,
): Promise<TranslationResult> {
  // 如果输入已经是英文（ASCII > 70%），直接返回
  const asciiRatio = chineseInput.split('').filter(c => c.charCodeAt(0) < 128).length / chineseInput.length;
  if (asciiRatio > 0.7) {
    return {
      original: chineseInput,
      english: chineseInput,
      confidence: 1.0,
      translator_model: 'passthrough',
      duration_ms: 0,
      token_usage: { input: 0, output: 0 },
      stage_usage: {
        stage: 'translator',
        model: 'passthrough',
        input_tokens: 0,
        output_tokens: 0,
      },
    };
  }

  try {
    return await doTranslate(chineseInput, translatorModel, translatorProvider);
  } catch (err: any) {
    console.error(`⚠️ Translate failed with ${translatorModel}: ${err.message?.slice(0, 80)}`);

    const registry = getRegistry();
    const fallbackModel = registry.selectTranslatorFallback(translatorModel);
    const fallbackInfo = registry.get(fallbackModel);

    if (fallbackInfo) {
      console.error(`  -> Retrying with ${fallbackModel}`);
      return doTranslate(chineseInput, fallbackModel, fallbackInfo.provider);
    }

    throw err;
  }
}

async function doTranslate(
  input: string,
  model: string,
  provider: string,
): Promise<TranslationResult> {
  const startTime = Date.now();
  ensureStageModelAllowed('translator', model);
  const { baseUrl, apiKey } = resolveProvider(provider, model);

  const result = await safeQuery({
    prompt: TRANSLATE_PROMPT + input,
    options: {
      cwd: process.cwd(),
      env: buildSdkEnv(model, baseUrl, apiKey),
      model,
      maxTurns: 1,
    }
  });

  const english = extractTextFromMessages(result.messages);
  const tokenUsage = extractTokenUsage(result.messages);

  // 简单 confidence 评估
  const confidence = english.length > 0 && english.length >= input.length * 0.3 ? 0.9 : 0.5;

  return {
    original: input,
    english,
    confidence,
    translator_model: model,
    duration_ms: Date.now() - startTime,
    token_usage: tokenUsage,
    stage_usage: {
      stage: 'translator',
      model,
      input_tokens: tokenUsage.input,
      output_tokens: tokenUsage.output,
    },
  };
}
