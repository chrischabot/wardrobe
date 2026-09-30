/**
 * Writes the DEMO placeholder flat-lays for the owner's wardrobe (May 2026 CSV + owner-asserted
 * additions) to demo/assets/generated/ for inspection, with an index.html contact sheet.
 * Run from garderobe/: npx tsx demo/scripts/write-demo-assets.ts
 * These files are for looking at; the seed and the tests generate the same bytes in memory.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mapInventory } from '@garderobe/backend/import';
import { placeholderSvg } from '../assets/placeholders.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const out = join(root, 'demo', 'assets', 'generated');
const mapping = await mapInventory(readFileSync(join(root, 'data', 'wardrobe-inventory-2026-05.csv'), 'utf8'));
const additions = JSON.parse(readFileSync(join(root, 'data', 'owner-asserted-additions-2026-09-29.json'), 'utf8')) as { additions: { item: { name: string; category: string; color?: string | null } }[] };
const garments = [
  ...mapping.garments.map((g) => ({ name: g.name, category: g.category, color: g.color ?? null, pattern: g.pattern ?? null })),
  ...additions.additions.map((a) => ({ name: a.item.name, category: a.item.category, color: a.item.color ?? null, pattern: null })),
];
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const cells: string[] = [];
const seen = new Set<string>();
for (const g of garments) {
  let name = slug(`${g.category}-${g.name}`);
  while (seen.has(name)) name += '-x';
  seen.add(name);
  writeFileSync(join(out, `${name}.svg`), placeholderSvg(g).svg);
  cells.push(`<figure><img src="${name}.svg" alt=""><figcaption>${g.name.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</figcaption></figure>`);
}
writeFileSync(
  join(out, 'index.html'),
  `<!doctype html><meta charset="utf-8"><title>DEMO placeholders</title><style>body{font:14px system-ui;background:#fff;margin:24px}h1{font-size:18px}div{display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:16px}figure{margin:0;border:1px solid #ddd;border-radius:8px;padding:8px}img{width:100%;height:160px;object-fit:contain}figcaption{font-size:12px;margin-top:6px}</style><h1>DEMO placeholder drawings — not photographs (${garments.length} garments)</h1><div>${cells.join('')}</div>`,
);
console.log(`Wrote ${garments.length} DEMO placeholder SVGs to ${out}`);
