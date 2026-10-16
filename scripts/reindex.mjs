import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncIndexes } from './catalog.mjs';

const docsDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../docs');
const check = process.argv.includes('--check');
try {
  const result = syncIndexes(docsDirectory, { check });
  console.log(`${check ? 'Validated' : 'Indexed'} ${result.taxa} taxa in ${result.files} index files.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
