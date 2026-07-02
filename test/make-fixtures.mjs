// Writes deterministic sample calendars for offline iteration & testing.
//   node test/make-fixtures.mjs
import { writeFileSync, mkdirSync } from 'node:fs';
import { synthCalendar } from '../src/build.mjs';

mkdirSync(new URL('./fixtures/', import.meta.url), { recursive: true });
for (const profile of ['empty', 'sparse', 'heavy']) {
  const cal = synthCalendar(profile);
  const path = new URL(`./fixtures/${profile}.json`, import.meta.url);
  writeFileSync(path, JSON.stringify(cal, null, 0));
  console.log(`wrote fixtures/${profile}.json — ${cal.totalContributions} contributions`);
}
