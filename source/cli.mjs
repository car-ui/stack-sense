import { readFile, writeFile } from 'node:fs/promises';
import { invalidResult, recommend } from './engine.mjs';

const usage = 'Usage: node cli.mjs <scenario.json> [--out result.json] [--no-llm]\n';
const args = process.argv.slice(2).filter((arg) => arg !== '--no-llm');
if (!args.length || args[0] === '--help' || args[0] === '-h') {
  process.stdout.write(usage);
} else if (args[0].startsWith('--') || (args.length !== 1 && (args.length !== 3 || args[1] !== '--out'))) {
  process.stderr.write(usage);
  process.exitCode = 1;
} else {
  let result;
  try {
    const contents = await readFile(args[0], 'utf8');
    result = recommend(JSON.parse(contents.replace(/^\uFEFF/, '')));
  } catch (error) {
    if (!(error instanceof SyntaxError) && !error.code) throw error;
    result = invalidResult([{ field: '$', message: error instanceof SyntaxError ? 'Invalid JSON: ' + error.message : 'Could not read the input file: ' + error.code }]);
  }
  const json = JSON.stringify(result, null, 2) + '\n';
  if (args[2]) await writeFile(args[2], json, { encoding: 'utf8' });
  else process.stdout.write(json);
  process.exitCode = result.status === 'invalid_input' ? 2 : result.status === 'infeasible' ? 3 : 0;
}
