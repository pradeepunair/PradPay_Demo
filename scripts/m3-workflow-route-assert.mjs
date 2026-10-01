import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const GENERATED_WORKFLOW_MARKERS = [
  ".well-known/workflow/v1/flow",
  ".well-known/workflow/v1/step",
  ".well-known/workflow/v1/webhook",
  "workflow-manifest",
  "workflow-config",
  "queue-trigger",
];
const ROUTE_MANIFEST = "routes-manifest.json";
const APP_PATHS_MANIFEST = path.join("server", "app-paths-manifest.json");

function filesUnder(root, prefix = "") {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    const relative = path.posix.join(prefix, entry.name);
    if (entry.isDirectory()) return [relative, ...filesUnder(absolute, relative)];
    return [relative];
  });
}

function readJson(filePath, label) {
  if (!fs.existsSync(filePath)) throw new Error(`Protected output is missing ${label}.`);
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    throw new Error(`Protected output ${label} is not valid JSON.`);
  }
}

function routeStrings(value, key = "") {
  if (typeof value === "string") return key.toLowerCase().includes("route") || key === "page" || key === "path" ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((entry) => routeStrings(entry, key));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([name, entry]) => routeStrings(entry, name));
  return [];
}

export function assertProtectedWorkflowOutput({ outputDir, mode, candidate, expectedCandidate, worktree = process.cwd(), verifyClean = false }) {
  if (mode !== "protected-deny") throw new Error("Protected output assertion requires protected-deny mode.");
  if (typeof candidate !== "string" || !/^[0-9a-f]{40}$/.test(candidate) || candidate !== expectedCandidate) {
    throw new Error("Protected output assertion requires the exact frozen successor candidate SHA.");
  }
  if (typeof expectedCandidate !== "string" || !/^[0-9a-f]{40}$/.test(expectedCandidate)) {
    throw new Error("Protected output assertion requires an exact expected successor SHA.");
  }
  if (typeof worktree !== "string" || !fs.existsSync(worktree) || !fs.statSync(worktree).isDirectory()) {
    throw new Error("Protected output assertion requires an existing source worktree.");
  }
  let actualHead;
  try {
    actualHead = execFileSync("git", ["-C", worktree, "rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    const status = execFileSync("git", ["-C", worktree, "status", "--porcelain=v2", "--untracked-files=all"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
    if (verifyClean && status !== "") throw new Error("source worktree is not clean");
  } catch {
    throw new Error("Protected output source identity unavailable.");
  }
  if (actualHead !== candidate) throw new Error("Protected output candidate does not match the independent source worktree HEAD.");

  if (typeof outputDir !== "string" || !fs.existsSync(outputDir) || !fs.statSync(outputDir).isDirectory()) {
    throw new Error("Protected output directory is missing.");
  }
  const routeManifest = readJson(path.join(outputDir, ROUTE_MANIFEST), ROUTE_MANIFEST);
  if (!routeManifest || typeof routeManifest !== "object" || !Array.isArray(routeManifest.staticRoutes) || !Array.isArray(routeManifest.dynamicRoutes)) {
    throw new Error("Protected output routes-manifest.json has no usable route inventory.");
  }
  const appPaths = readJson(path.join(outputDir, APP_PATHS_MANIFEST), APP_PATHS_MANIFEST);
  if (!appPaths || typeof appPaths !== "object" || Array.isArray(appPaths)) {
    throw new Error("Protected output app-paths-manifest.json has no usable route inventory.");
  }
  const inventory = routeStrings(routeManifest);
  const appRouteKeys = Object.keys(appPaths).map((route) => route.replace(/\/(?:route|page)$/, "") || "/");
  const unexpected = inventory.filter((route) => route.startsWith("/") && !appRouteKeys.includes(route));
  const unexpectedApp = appRouteKeys.filter((route) => route.startsWith("/") && !inventory.includes(route));
  const violations = [...filesUnder(outputDir), ...appRouteKeys, ...inventory].filter((entry) => GENERATED_WORKFLOW_MARKERS.some((marker) => entry.includes(marker)));
  if (unexpected.length > 0) violations.push(...unexpected);
  if (unexpectedApp.length > 0) violations.push(...unexpectedApp);
  if (violations.length > 0) {
    throw new Error(`Protected route/build inventory rejected: violationCount=${new Set(violations).size}`);
  }
  return Object.freeze({ mode, candidate, fileCount: filesUnder(outputDir).length, routeCount: inventory.length, violations: [] });
}

export const generatedWorkflowMarkers = Object.freeze([...GENERATED_WORKFLOW_MARKERS]);

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = new Map();
  for (let index = 2; index < process.argv.length; index += 2) args.set(process.argv[index], process.argv[index + 1]);
  try {
    const result = assertProtectedWorkflowOutput({
      outputDir: args.get("--output"),
      mode: args.get("--mode"),
      candidate: args.get("--candidate"),
      expectedCandidate: args.get("--expected-candidate"),
      worktree: args.get("--worktree"),
      verifyClean: true,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
