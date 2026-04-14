import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const studioRoot = resolve(__dirname, "..");
const repoRoot = resolve(studioRoot, "..", "..");
const tsxBin = join(studioRoot, "node_modules", ".bin", "tsx");
const viteBin = join(studioRoot, "node_modules", ".bin", "vite");
const apiPort = "4569";
const webPort = "4567";

// Resolve project root: explicit env var takes priority with no silent fallback.
// Without it, check cwd first, then fall back to repo root (useful for contributors).
let projectRoot;
if (process.env.INKOS_PROJECT_ROOT) {
  projectRoot = resolve(process.env.INKOS_PROJECT_ROOT);
  if (!existsSync(join(projectRoot, "inkos.json"))) {
    console.error(`[studio:dev] inkos.json not found in INKOS_PROJECT_ROOT=${projectRoot}`);
    console.error(
      "[studio:dev] Make sure the path contains a valid InkOS project (with inkos.json).\n" +
      "  Run: inkos init <name>    # to create a new project\n" +
      "  Or:  cd /path/to/project && inkos init",
    );
    process.exit(1);
  }
} else {
  const cwd = process.cwd();
  if (existsSync(join(cwd, "inkos.json"))) {
    projectRoot = cwd;
  } else if (existsSync(join(repoRoot, "inkos.json"))) {
    projectRoot = repoRoot;
  } else {
    console.error(`[studio:dev] inkos.json not found in ${cwd}`);
    console.error(
      "[studio:dev] Set INKOS_PROJECT_ROOT to your InkOS project path, e.g.\n" +
      "  INKOS_PROJECT_ROOT=/path/to/your-book pnpm --filter @actalk/inkos-studio dev",
    );
    process.exit(1);
  }
}

function launch(command, args, env = process.env) {
  const child = spawn(command, args, {
    cwd: studioRoot,
    stdio: "inherit",
    env,
  });
  child.on("error", (error) => {
    console.error(`[studio:dev] failed to launch ${command}: ${error.message}`);
    process.exitCode = 1;
  });
  return child;
}

const api = launch(tsxBin, ["src/api/index.ts", projectRoot], {
  ...process.env,
  INKOS_STUDIO_PORT: apiPort,
  INKOS_PROJECT_ROOT: projectRoot,
});

const web = launch(viteBin, ["--host", "--port", webPort], {
  ...process.env,
  INKOS_STUDIO_PORT: apiPort,
});

function shutdown(signal) {
  for (const child of [api, web]) {
    if (!child.killed) {
      child.kill(signal);
    }
  }
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => shutdown(signal));
}

api.on("exit", (code) => {
  if (!web.killed) web.kill("SIGTERM");
  process.exit(code ?? 0);
});

web.on("exit", (code) => {
  if (!api.killed) api.kill("SIGTERM");
  process.exit(code ?? 0);
});
