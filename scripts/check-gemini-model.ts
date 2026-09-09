/**
 * Does the model Ask WSSL is configured to use actually exist for this API key?
 *
 *   GEMINI_API_KEY=... npm run check-gemini-model
 *
 * Lists every model the key can call and reports whether GEMINI_MODEL (default
 * `gemini-3.8-flash`) is among them. Exits non-zero if it is not, so the operator
 * finds out before the widget does.
 */
import { GoogleGenAI } from '@google/genai';
import { DEFAULT_GEMINI_MODEL } from '../functions/_lib/providers/gemini';

const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  console.error('GEMINI_API_KEY is not set. Export it (or put it in .dev.vars and export it) and run again.');
  process.exit(1);
}

const target = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
const ai = new GoogleGenAI({ apiKey });

const names: string[] = [];
for await (const model of await ai.models.list()) {
  // The API returns resource names like "models/gemini-3.8-flash".
  if (model.name) names.push(model.name.replace(/^models\//, ''));
}
names.sort();

console.log(`${names.length} models available to this key:`);
for (const name of names) console.log(`  ${name}`);

const found = names.includes(target);
console.log(`\n${found ? 'OK' : 'MISSING'}: GEMINI_MODEL = ${target}${found ? '' : ' is not in the list above'}`);
if (!found) {
  const near = names.filter((n) => n.startsWith(target.split('-').slice(0, 2).join('-')));
  if (near.length) console.log(`Closest matches: ${near.join(', ')}`);
  process.exit(1);
}
