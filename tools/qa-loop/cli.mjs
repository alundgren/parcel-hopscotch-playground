#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { closeRun, createRun, loadRun, packetFor, promoteMemory, runDecision, updateRun } from './core.mjs';

function argumentsFor(argv) {
  const [command, ...rest] = argv;
  if (!command) throw new Error('command required: init, show, event, decision, packet, close, promote');
  const options = {};
  for (let index = 0; index < rest.length; index += 2) {
    const name = rest[index];
    if (!name?.startsWith('--') || !rest[index + 1]) throw new Error(`invalid option ${name ?? ''}`);
    if (Object.hasOwn(options, name.slice(2))) throw new Error(`duplicate option ${name}`);
    options[name.slice(2)] = rest[index + 1];
  }
  return { command, options };
}
async function inputJson(file) {
  if (!file) return {};
  if (file === '-') {
    let text = '';
    for await (const chunk of process.stdin) text += chunk;
    return JSON.parse(text);
  }
  return JSON.parse(await readFile(file, 'utf8'));
}
function required(options, key) {
  if (!options[key]) throw new Error(`--${key} is required`);
  return options[key];
}
async function main() {
  const { command, options } = argumentsFor(process.argv.slice(2));
  let result;
  switch (command) {
    case 'init':
      result = await createRun({ ...(await inputJson(required(options, 'input'))), ...(options.root ? { rootDir: options.root } : {}) });
      break;
    case 'show': result = await loadRun({ runDir: required(options, 'run-dir') }); break;
    case 'event': result = await updateRun({ runDir: required(options, 'run-dir'), event: await inputJson(required(options, 'input')) }); break;
    case 'decision': result = runDecision(await loadRun({ runDir: required(options, 'run-dir') }), await inputJson(options.input)); break;
    case 'packet': result = packetFor(await loadRun({ runDir: required(options, 'run-dir') }), required(options, 'role'), await inputJson(required(options, 'input'))); break;
    case 'close': result = await closeRun({ runDir: required(options, 'run-dir'), reason: required(options, 'reason') }); break;
    case 'promote': result = await promoteMemory({ runDir: required(options, 'run-dir'), memoryFile: required(options, 'memory-file'), ...(await inputJson(required(options, 'input'))) }); break;
    default: throw new Error(`unknown command ${command}`);
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
