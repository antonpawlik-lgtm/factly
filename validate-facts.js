#!/usr/bin/env node
// Validates facts.json before every deploy. Zero dependencies — run with `node validate-facts.js`.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const ALLOWED_CATEGORIES = [
  'science', 'history', 'nature', 'space', 'animals',
  'geography', 'technology', 'psychology', 'food', 'curiosities',
];
const ALLOWED_LANGS = ['de', 'en'];

const filePath = path.join(__dirname, 'facts.json');
const errors = [];

let facts;
try {
  facts = JSON.parse(fs.readFileSync(filePath, 'utf8'));
} catch (e) {
  console.error(`✗ facts.json is not valid JSON: ${e.message}`);
  process.exit(1);
}

if (!Array.isArray(facts)) {
  console.error('✗ facts.json must be a flat JSON array.');
  process.exit(1);
}

const seenIds = new Set();
facts.forEach((fact, i) => {
  const where = `fact at index ${i} (id: ${fact && fact.id})`;

  if (typeof fact.id !== 'number' || !Number.isInteger(fact.id)) {
    errors.push(`${where}: "id" must be an integer.`);
  } else if (seenIds.has(fact.id)) {
    errors.push(`${where}: duplicate id ${fact.id}.`);
  } else {
    seenIds.add(fact.id);
  }

  if (!ALLOWED_CATEGORIES.includes(fact.category)) {
    errors.push(`${where}: category "${fact.category}" is not in the allowed list (${ALLOWED_CATEGORIES.join(', ')}).`);
  }

  if (!ALLOWED_LANGS.includes(fact.lang)) {
    errors.push(`${where}: lang "${fact.lang}" must be one of ${ALLOWED_LANGS.join(', ')}.`);
  }

  if (typeof fact.text !== 'string' || fact.text.trim().length === 0) {
    errors.push(`${where}: "text" must be a non-empty string.`);
  }
});

if (errors.length > 0) {
  console.error(`✗ ${errors.length} problem(s) found in facts.json:\n`);
  errors.forEach((e) => console.error(`  - ${e}`));
  process.exit(1);
}

const byCategory = {};
const byLang = {};
facts.forEach((f) => {
  byCategory[f.category] = (byCategory[f.category] || 0) + 1;
  byLang[f.lang] = (byLang[f.lang] || 0) + 1;
});

console.log(`✓ facts.json is valid — ${facts.length} facts, ${seenIds.size} unique ids.\n`);
console.log('By category:');
Object.entries(byCategory).sort().forEach(([cat, count]) => console.log(`  ${cat.padEnd(12)} ${count}`));
console.log('\nBy language:');
Object.entries(byLang).sort().forEach(([lang, count]) => console.log(`  ${lang.padEnd(12)} ${count}`));
console.log(`\nNext free id: ${Math.max(...facts.map((f) => f.id)) + 1}`);
