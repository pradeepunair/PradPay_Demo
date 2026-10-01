import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createAgentScenario } from '../lib/replay/agent-simulation-fixtures.mjs';

const directory = fileURLToPath(new URL('../fixtures/agent-studio-recordings/', import.meta.url));
export const recordingFaults = Object.freeze([
  'none', 'buyer_decline', 'token_expired', 'changed_cart', 'lost_response', 'lost_response_recovered',
]);

export function recordedScenario(fault) {
  const scenario = createAgentScenario({ fault });
  return `${JSON.stringify(scenario, null, 2)}\n`;
}

export async function buildAgentStudioRecordings({ check = false } = {}) {
  if (!check) await mkdir(directory, { recursive: true });
  for (const fault of recordingFaults) {
    const path = `${directory}/${fault}.json`;
    const expected = recordedScenario(fault);
    if (check) {
      const existing = await readFile(path, 'utf8');
      if (existing !== expected) throw new Error(`Stale Agent Studio recording: ${fault}`);
    } else await writeFile(path, expected);
  }
  return recordingFaults.length;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === fileURLToPath(new URL(`file://${process.argv[1]}`))) {
  buildAgentStudioRecordings({ check: process.argv.includes('--check') })
    .then(count => console.log(`${count} Agent Studio recordings ${process.argv.includes('--check') ? 'verified' : 'written'}.`))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
