import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { exists } from "../system/filesystem";

export type Command = "start" | "stop" | "update";

export interface Manager {
  directory: string;
  run: (command: string[], cwd: string, quiet?: boolean, allowedExitCodes?: number[]) => Promise<number>;
  capture: (command: string[], cwd: string) => Promise<string>;
  docker: (start: boolean) => Promise<string[]>;
  log: (message: string) => void;
}

export async function validateInstallation(directory: string) {
  if (!(await exists(join(directory, ".trackgeek-installation"))) ||
      (await readFile(join(directory, ".trackgeek-installation"), "utf8")) !== "TrackGeek selfhost v1\n")
    throw new Error(`No recognized TrackGeek installation at ${directory}. Run the installer first.`);
  for (const file of ["compose.yaml", ".env", "api/.env", "web/.env"])
    if (!(await exists(join(directory, file)))) throw new Error(`Missing ${file}. Run the installer again to finish setup.`);
}

export async function manage(command: Command, system: Manager) {
  const { directory, run, capture, log } = system;
  await validateInstallation(directory);

  if (command === "update") {
    for (const name of ["api", "web"]) {
      const path = join(directory, name);
      if ((await capture(["git", "remote", "get-url", "origin"], path)) !== `https://github.com/TrackGeek/${name}.git`)
        throw new Error(`Unexpected origin for ${name}. Update requires https://github.com/TrackGeek/${name}.git.`);
      if ((await capture(["git", "branch", "--show-current"], path)) !== "main")
        throw new Error(`${name} is not on main. Switch to main before updating.`);
      if (await capture(["git", "status", "--porcelain", "--untracked-files=all"], path))
        throw new Error(`${name} has local changes. Commit or stash them before updating.`);
    }
    for (const name of ["api", "web"]) {
      const path = join(directory, name);
      await run(["git", "fetch", "origin", "main:refs/remotes/origin/main"], path);
      if ((await run(["git", "merge-base", "--is-ancestor", "HEAD", "origin/main"], path, true, [0, 1])) !== 0)
        throw new Error(`${name} has local commits or diverges from origin/main. Resolve them before updating.`);
    }
  }

  const docker = await system.docker(command !== "stop");
  if (!docker.length) {
    log("Docker is already stopped. API and web are stopped.");
    return;
  }
  const compose = (args: string[]) => run([...docker, "compose", ...args], directory);
  await compose(["config", "--quiet"]);
  if (command === "stop") {
    await compose(["stop", "api", "web"]);
    log("API and web stopped. Docker, PostgreSQL and Redis remain running.");
    return;
  }
  if (command === "update") {
    for (const name of ["api", "web"])
      await run(["git", "merge", "--ff-only", "origin/main"], join(directory, name));
    log("Building the latest main branches. Existing services stay running during the build.");
    await compose(["build"]);
    await compose(["stop", "api", "web"]);
    await compose(["rm", "--force", "init"]);
    log("Applying migrations and the production seed, then starting API and web.");
  }
  await compose(["up", "-d", "--wait", "--wait-timeout", "600"]);
  log(command === "update" ? "TrackGeek updated and running." : "TrackGeek is running.");
}
