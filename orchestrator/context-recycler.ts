// ═══════════════════════════════════════════════════════════════════
// orchestrator/context-recycler.ts — Worker 间上下文传递
// ═══════════════════════════════════════════════════════════════════
// 核心功能：
//   - 从 upstream tasks 收集输出
//   - 构建 ContextPacket
//   - 为下游 worker 生成精简的上下文输入
// ═══════════════════════════════════════════════════════════════════

import type { ContextPacket, WorkerResult, SubTask } from './types.js';

// ── 上下文回收器 ──

export interface RecycleOptions {
  maxSummaryLength?: number; // 每个文件摘要最大长度，默认 500 字
  maxDecisions?: number; // 最多保留多少个决策，默认 10
  includeAllFiles?: boolean; // 是否包含所有文件（默认只包含关键输出）
}

/**
 * 从已完成的 worker 结果中回收上下文
 *
 * @param completedResults - 已完成的 worker 结果列表
 * @param targetTask - 目标任务（用于确定需要哪些上下文）
 * @param options - 配置选项
 * @returns ContextPacket 列表
 */
export function recycleContext(
  completedResults: WorkerResult[],
  targetTask: SubTask,
  options: RecycleOptions = {}
): ContextPacket[] {
  const {
    maxSummaryLength = 500,
    maxDecisions = 10,
    includeAllFiles = false,
  } = options;

  const packets: ContextPacket[] = [];

  // 找出 targetTask 依赖的任务
  const dependencies = targetTask.depends_on || [];

  // 如果没有显式依赖，使用所有已完成的 worker
  const relevantResults =
    dependencies.length > 0
      ? completedResults.filter((r) => dependencies.includes(r.taskId))
      : completedResults;

  for (const result of relevantResults) {
    const packet = buildContextPacketFromOptions(result, {
      maxSummaryLength,
      maxDecisions,
      includeAllFiles,
    });

    if (packet) {
      packets.push(packet);
    }
  }

  return packets;
}

/**
 * 从单个 worker 结果构建 ContextPacket
 */
function buildContextPacketFromOptions(
  result: WorkerResult,
  options: RecycleOptions
): ContextPacket | null {
  // 从 worker output 中提取关键信息
  const assistantMessages = result.output.filter(
    (m) => m.type === 'assistant' || m.type === 'system'
  );

  if (assistantMessages.length === 0) {
    return null;
  }

  // 生成摘要
  const summary = generateSummary(assistantMessages.map((m) => m.content));

  // 提取关键输出文件
  const keyOutputs = extractKeyOutputs(result.changedFiles);

  // 提取决策
  const decisionsMade = extractDecisions(assistantMessages, options.maxDecisions ?? 10);

  return {
    from_task: result.taskId,
    summary: truncate(summary, options.maxSummaryLength ?? 500),
    key_outputs: keyOutputs,
    decisions_made: decisionsMade,
  };
}

/**
 * 生成内容摘要
 */
function generateSummary(contents: string[]): string {
  const combined = contents.join('\n\n');

  // 提取关键信息：完成的工作、创建的文件、遇到的问题
  const lines = combined.split('\n');
  const relevantLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // 捕获关键模式
    if (
      trimmed.match(/^(完成 | 创建 | 修改 | 添加 | 修复 | 实现 | 重构)/i) ||
      trimmed.match(/^(created|modified|added|fixed|implemented|refactored)/i) ||
      trimmed.match(/^(文件 | file|模块 | module|函数 | function)/i)
    ) {
      relevantLines.push(trimmed);
    }
  }

  if (relevantLines.length > 0) {
    return relevantLines.slice(0, 20).join('\n');
  }

  // 退化：返回前 500 字符
  return combined.slice(0, 500);
}

/**
 * 从变更文件中提取关键输出
 */
function extractKeyOutputs(changedFiles: string[]): ContextPacket['key_outputs'] {
  return changedFiles.map((file) => ({
    file,
    purpose: inferFilePurpose(file),
    key_exports: [], // 需要静态分析才能提取，留给下游扩展
  }));
}

/**
 * 推断文件用途
 */
function inferFilePurpose(filePath: string): string {
  const parts = filePath.split('/');
  const fileName = parts[parts.length - 1] || '';

  // 根据文件名推断
  if (fileName.includes('.test.') || fileName.includes('.spec.')) {
    return '测试文件';
  }
  if (fileName.includes('.config.') || fileName.includes('.rc.')) {
    return '配置文件';
  }
  if (fileName.endsWith('.md')) {
    return '文档';
  }
  if (fileName.endsWith('.json')) {
    return '数据/配置';
  }
  if (fileName.endsWith('.ts') || fileName.endsWith('.js')) {
    if (fileName.includes('controller') || fileName.includes('handler')) {
      return '控制器/处理器';
    }
    if (fileName.includes('service')) {
      return '服务层';
    }
    if (fileName.includes('repository') || fileName.includes('dao')) {
      return '数据访问层';
    }
    if (fileName.includes('types') || fileName.endsWith('types.ts')) {
      return '类型定义';
    }
    if (fileName.includes('utils') || fileName.includes('helpers')) {
      return '工具函数';
    }
    return '源代码';
  }

  return '未知用途';
}

/**
 * 从消息中提取决策
 */
function extractDecisions(
  messages: Array<{ type: string; content: string }>,
  maxDecisions: number
): string[] {
  const decisions: string[] = [];

  for (const msg of messages) {
    const content = msg.content;

    // 捕获决策模式
    const decisionMatches = content.matchAll(
      /(决定 | 选择 | 采用 | 使用 | decided|chose|adopted|using)[:：]\s*(.+?)(?:\n|$)/g
    );

    for (const match of decisionMatches) {
      if (decisions.length >= maxDecisions) break;
      decisions.push(match[2].trim());
    }

    // 捕获结论模式
    const conclusionMatches = content.matchAll(
      /(结论 | 总结 | 综上 | conclusion|summary)[:：]\s*(.+?)(?:\n|$)/g
    );

    for (const match of conclusionMatches) {
      if (decisions.length >= maxDecisions) break;
      decisions.push(match[2].trim());
    }
  }

  return decisions;
}

/**
 * 截断字符串到最大长度
 */
function truncate(str: string, maxLength: number): string {
  if (str.length <= maxLength) return str;
  return str.slice(0, maxLength - 3) + '...';
}

// ── 上下文包构建器 ──

export interface ContextBuilder {
  addResult(result: WorkerResult): ContextBuilder;
  setTargetTask(task: SubTask): ContextBuilder;
  setOptions(options: RecycleOptions): ContextBuilder;
  build(): ContextPacket[];
}

/**
 * 流式上下文构建器
 */
export function createContextBuilder(): ContextBuilder {
  const results: WorkerResult[] = [];
  let targetTask: SubTask | null = null;
  let options: RecycleOptions = {};

  return {
    addResult(result: WorkerResult): ContextBuilder {
      results.push(result);
      return { ...this };
    },

    setTargetTask(task: SubTask): ContextBuilder {
      targetTask = task;
      return { ...this };
    },

    setOptions(opts: RecycleOptions): ContextBuilder {
      options = { ...options, ...opts };
      return { ...this };
    },

    build(): ContextPacket[] {
      if (!targetTask) {
        throw new Error('Target task not set');
      }
      return recycleContext(results, targetTask, options);
    },
  };
}

// ── 上下文合并 ──

/**
 * 合并多个 ContextPacket 为单一的上下文摘要
 */
export function mergeContextPackets(packets: ContextPacket[]): string {
  if (packets.length === 0) {
    return '';
  }

  const sections: string[] = [];

  for (const packet of packets) {
    let section = `## From Task: ${packet.from_task}\n\n`;
    section += `**Summary:** ${packet.summary}\n\n`;

    if (packet.key_outputs.length > 0) {
      section += '**Key Outputs:**\n';
      for (const output of packet.key_outputs) {
        section += `- \`${output.file}\` (${output.purpose})\n`;
      }
      section += '\n';
    }

    if (packet.decisions_made.length > 0) {
      section += '**Decisions Made:**\n';
      for (const decision of packet.decisions_made) {
        section += `- ${decision}\n`;
      }
      section += '\n';
    }

    sections.push(section);
  }

  return sections.join('---\n\n');
}

// ── 导出默认上下文格式 ──

export function formatContextForPrompt(packets: ContextPacket[]): string {
  if (packets.length === 0) {
    return '// No upstream context available\n';
  }

  return `
<upstream_context>
${mergeContextPackets(packets)}
</upstream_context>

请基于以上上下文继续工作。如果下游任务需要特定信息，请明确指出。
`.trim();
}

export function buildContextPacket(
  result: WorkerResult,
  taskOrOptions: SubTask | RecycleOptions,
): ContextPacket {
  const options = 'id' in taskOrOptions ? {} : taskOrOptions;
  return buildContextPacketFromOptions(result, options) ?? {
    from_task: result.taskId,
    summary: 'No assistant output available.',
    key_outputs: [],
    decisions_made: [],
  };
}

export function formatContextForWorker(packets: ContextPacket[]): string {
  return formatContextForPrompt(packets);
}
