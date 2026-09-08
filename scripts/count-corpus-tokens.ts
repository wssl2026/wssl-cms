import Anthropic from '@anthropic-ai/sdk';
import { buildCorpus } from './lib/corpus';
import { MODEL, SYSTEM_PROMPT, buildMessages } from '../functions/_lib/chat';

const client = new Anthropic();
const corpus = await buildCorpus();
const res = await client.beta.messages.countTokens({
  model: MODEL,
  system: SYSTEM_PROMPT,
  messages: buildMessages(corpus, [{ role: 'user', content: 'What is the refund policy?' }]),
});
const t = res.input_tokens;
console.log(`input tokens: ${t}`);
console.log(`cached read cost/question ≈ $${((t / 1e6) * 5 * 0.1).toFixed(4)}; 1h cache write ≈ $${((t / 1e6) * 5 * 2).toFixed(3)}`);
if (t > 150_000) { console.error('Corpus is larger than expected — revisit the full-context design (see spec).'); process.exit(1); }
