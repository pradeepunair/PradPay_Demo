import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { APPROVED_NTP_COMMAND, assertExecutionEpoch, parseSntpSample } from "./clock.mjs";

const execFileAsync = promisify(execFile);

async function defaultRun(command, args) {
  return execFileAsync(command, args, { encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
}

export function createHostClockCapture({ run = defaultRun, now = Date.now } = {}) {
  if (typeof run !== "function" || typeof now !== "function") throw new TypeError("clock dependencies are required");

  return async function captureHostClock() {
    const [command, ...args] = APPROVED_NTP_COMMAND;
    let output = "";
    let exitCode = 0;
    try {
      const result = await run(command, args);
      output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`;
    } catch (error) {
      exitCode = Number.isSafeInteger(error?.code) ? error.code : 1;
      output = `${error?.stdout ?? ""}${error?.stderr ?? ""}`;
    }
    const observedAtMs = now();
    const observedAtEpoch = Math.floor(observedAtMs / 1000);
    const capturedAtMs = now();
    const nowEpoch = Math.floor(capturedAtMs / 1000);
    const evidence = Object.freeze({
      command: APPROVED_NTP_COMMAND,
      output,
      exitCode,
      observedAtEpoch,
      nowEpoch,
    });
    const sample = parseSntpSample(evidence);
    assertExecutionEpoch(nowEpoch);
    return Object.freeze({ authority: "ntp-corroborated-host-epoch", epoch: nowEpoch, capturedAtMs, evidence, sample });
  };
}
