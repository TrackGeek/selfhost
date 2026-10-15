import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, userInfo } from "node:os";
import * as p from "@clack/prompts";
import { type Command, manage } from "./management/commands";
import { configureAutostartup } from "./management/autostartup";
import { prepareDocker } from "./docker/runtime";
import { addGitPath } from "./system/git";
import { available, capture, run } from "./system/process";
import { exists } from "./system/filesystem";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const usage = "Usage: tg <start|stop|update|help|autostartup on|autostartup off>";
const help = `${usage}

  start             Start Docker, PostgreSQL, Redis, API and web; wait for healthy services
  stop              Stop API and web, keeping Docker, PostgreSQL and Redis running
  update            Update API/web from GitHub main, rebuild, apply migrations and seed
  help              Explain all commands (also --help or -h)
  autostartup on    Enable startup of the full infrastructure at boot (Linux/systemd)
                    or user login (macOS/Windows with Docker Desktop)
  autostartup off   Disable automatic startup without stopping running services

Linux autostartup setup requires administrator access and system Docker Engine.
Autostartup configuration may start Docker to update existing container restart policies.
Run tg help from any directory. Rerun the installer to refresh this CLI.`;

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) {
    if (extra.length) throw new Error(usage);
    console.log(help);
    return;
  }
  if (command === "autostartup") {
    if (extra.length !== 1 || !["on", "off"].includes(extra[0])) throw new Error(usage);
    await configureAutostartup(extra[0] === "on", {
      directory,
      platform: process.platform,
      root: process.getuid?.() === 0,
      home: homedir(),
      username: userInfo().username,
      uid: process.getuid?.() ?? 0,
      executable: process.execPath,
      env: process.env,
      run,
      capture,
      available: (command) => available(command, directory),
      exists,
      docker: (start) => prepareDocker(directory, start),
      log: p.log.info,
    });
    return;
  }
  if (!["start", "stop", "update"].includes(command) || extra.length)
    throw new Error(usage);
  addGitPath();
  await manage(command as Command, {
    directory,
    run,
    capture,
    docker: (start) => prepareDocker(directory, start),
    log: p.log.info,
  });
}

if (import.meta.main) main().catch((error) => {
  p.log.error(error instanceof Error ? error.message : String(error));
  p.log.info(`Installation: ${directory}. Diagnostics: docker compose --project-directory "${directory}" logs --tail 100`);
  process.exitCode = 1;
});
