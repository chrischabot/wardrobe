/**
 * Emits JSON Schema files for every exported contract into packages/contracts/json-schema/.
 * Run: npm run schemas (from garderobe/). A test fails if the committed files are out of date.
 */
import { mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CONTRACTS_VERSION, JSON_SCHEMA_EXPORTS } from '../src/index.js';
import { renderJsonSchemaFile } from '../src/json-schema.js';

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'json-schema');
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(outDir)) if (f.endsWith('.json')) rmSync(join(outDir, f));
const names = Object.keys(JSON_SCHEMA_EXPORTS).sort();
for (const name of names) writeFileSync(join(outDir, `${name}.json`), renderJsonSchemaFile(name, CONTRACTS_VERSION));
writeFileSync(join(outDir, 'index.json'), JSON.stringify({ contractsVersion: CONTRACTS_VERSION, schemas: names.map((n) => `${n}.json`) }, null, 2) + '\n');
console.log(`Wrote ${names.length} schemas to ${outDir}`);
