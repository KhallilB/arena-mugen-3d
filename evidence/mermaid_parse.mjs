import fs from 'node:fs';
import { JSDOM } from 'jsdom';

const specPath = process.argv[2] || 'docs/3d_arena_mugen_spec.md';
const text = fs.readFileSync(specPath, 'utf8');
const blocks = [...text.matchAll(/```mermaid\n([\s\S]*?)```/g)].map((m) => m[1]);

const dom = new JSDOM('<!DOCTYPE html><html><body></body></html>');
globalThis.window = dom.window;
globalThis.document = dom.window.document;
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const mermaidMod = await import('mermaid');
const mermaid = mermaidMod.default || mermaidMod;
mermaid.initialize({ startOnLoad: false });

let passed = 0;
for (let i = 0; i < blocks.length; i++) {
  await mermaid.parse(blocks[i]);
  passed++;
}
console.log(`OK: ${passed}/${blocks.length} Mermaid diagrams parsed cleanly in ${specPath}`);
