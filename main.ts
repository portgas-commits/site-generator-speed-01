// The harness entrypoint: `node main.ts` (Node 22.18 or later, which runs
// TypeScript as it is). It reads every case from /input/cases.json (or
// MAKEFUN_INPUT_DIR), answers each one alone with run() from solve.js, and
// writes /output/answers.json (or MAKEFUN_OUTPUT_DIR): a JSON array of the
// answers, one per case and in the cases' order.

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setFlagsFromString } from 'node:v8';

// V8's incremental marking off, set before solve.js is imported so all of its
// work runs under it: the house baseline runs with --no-incremental-marking,
// and an entry may tune V8's flags the same way.
setFlagsFromString('--no-incremental-marking');

/** solve.js, imported by its URL (a .js module carries no types) and typed by its contract. */
const { run } = (await import(new URL('./solve.js', import.meta.url).href)) as {
  run: (input: unknown) => unknown;
};

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** One case as the harness hands it over: its id and its input site. */
type Case = { id: string; input: unknown };

const raw = readFileSync(join(INPUT_DIR, 'cases.json'), 'utf8');
const cases = JSON.parse(raw) as Case[];

const answers: unknown[] = new Array(cases.length);
for (let i = 0; i < cases.length; i++) {
  answers[i] = run(cases[i].input);
}

writeFileSync(join(OUTPUT_DIR, 'answers.json'), JSON.stringify(answers));
