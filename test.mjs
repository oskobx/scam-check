// Test the scam pipeline without FaceTime:  npm test -- path/to/photo.jpg
import { readFileSync } from 'node:fs';
import { readItem, safeSearchQuery, searchScamReports } from './scamtools.mjs';

const path = process.argv[2];
if (!path) { console.log('Usage: npm test -- path/to/photo.(jpg|png)'); process.exit(2); }
const mime = /\.png$/i.test(path) ? 'image/png' : 'image/jpeg';

console.log('Reading the item...\n');
const reading = await readItem(readFileSync(path), '', mime);
console.log(reading);

const query = safeSearchQuery(reading.match(/SEARCH QUERY:\s*(.+)/i)?.[1] || '');
if (query) {
  console.log(`\nSearching Keenable for: ${query}\n`);
  for (const r of await searchScamReports(query)) console.log(`- ${r.date || '?'}  ${r.site}  ${r.title}\n  ${r.url}`);
}
