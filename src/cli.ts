import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { type Command, manage } from "./management/commands";
import { prepareDocker } from "./docker/runtime";
import { addGitPath } from "./system/git";
import { capture, run } from "./system/process";

const directory = resolve(dirname(fileURLToPath(import.meta.url)), "..");

async function main() {
  const [command, ...extra] = process.argv.slice(2);
  if (!command || ["help", "--help", "-h"].includes(command)) {
    console.log("Usage: trackgeek <start|stop|update>\n\n  start   Start Docker, API and web\n  stop    Stop API and web, keeping Docker and databases running\n  update  Update API and web from GitHub main, rebuild and apply migrations");
    return;
  }
  if (!["start", "stop", "update"].includes(command) || extra.length)
    throw new Error("Usage: trackgeek <start|stop|update>");
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
