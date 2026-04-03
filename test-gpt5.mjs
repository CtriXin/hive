import { query } from '@anthropic-ai/claude-code';

const messages = query({
  prompt: 'Say hello from GPT-5 in one sentence.',
  options: {
    cwd: process.cwd(),
    env: {
      ANTHROPIC_MODEL: 'gpt-5',
      PATH: process.env.PATH || '',
      HOME: process.env.HOME || '',
    },
    maxTurns: 1,
  },
});

let output = '';
for await (const msg of messages) {
  if (msg.type === 'assistant') {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      output += content.map(b => b.type === 'text' ? b.text : '').join('');
    } else if (typeof content === 'string') {
      output += content;
    }
  }
}
console.log('OUTPUT_START');
console.log(output);
console.log('OUTPUT_END');
