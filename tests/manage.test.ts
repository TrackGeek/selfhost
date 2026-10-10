import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type Manager, manage } from "../src/management/commands";
import { capture, run } from "../src/system/process";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "trackgeek-manage-"));
  const directory = join(root, "installation");
  const commands: string[][] = [];
  const dockerRequests: boolean[] = [];
  const logs: string[] = [];
  await mkdir(directory);
  await writeFile(join(directory, ".trackgeek-installation"), "TrackGeek selfhost v1\n");
  await writeFile(join(directory, ".env"), "POSTGRES_PASSWORD=keep-this-secret\n");
  await writeFile(join(directory, "compose.yaml"), "name: trackgeek\n");
  const git = (args: string[], cwd: string) => capture(["git", ...args], cwd);
  for (const name of ["api", "web"]) {
    const upstream = join(root, `upstream-${name}`);
    await mkdir(upstream);
    await git(["init", "--initial-branch", "main"], upstream);
    await git(["config", "user.name", "Test"], upstream);
    await git(["config", "user.email", "test@example.com"], upstream);
    await writeFile(join(upstream, ".gitignore"), ".env\n");
    await writeFile(join(upstream, "version.txt"), "1\n");
    await git(["add", "."], upstream);
    await git(["commit", "-m", "Initial version"], upstream);
    await git(["clone", "--branch", "main", "--depth", "1", `file://${upstream}`, join(directory, name)], root);
    await git(["remote", "set-url", "origin", `https://github.com/TrackGeek/${name}.git`], join(directory, name));
    await writeFile(join(directory, name, ".env"), "TOKEN=existing-secret\n");
    await writeFile(join(upstream, "version.txt"), "2\n");
    await git(["commit", "-am", "New version"], upstream);
  }
  const system: Manager = {
    directory,
    capture,
    log: (message) => logs.push(message),
    docker: async (start) => { dockerRequests.push(start); return ["docker"]; },
    run: async (command, cwd, quiet, codes) => {
      commands.push(command);
      if (command[0] === "docker") return 0;
      if (command[1] === "fetch")
        return run(["git", "fetch", join(root, `upstream-${basename(cwd)}`), command[3]], cwd, true, codes);
      return run(command, cwd, true, codes);
    },
  };
  return { root, directory, system, git, commands, dockerRequests, logs };
}

test("start launches services; stop only stops API/web and does not start Docker", async () => {
  const f = await fixture();
  try {
    await manage("start", f.system);
    expect(f.dockerRequests).toEqual([true]);
    expect(f.commands).toContainEqual(["docker", "compose", "up", "-d", "--wait", "--wait-timeout", "600"]);
    f.commands.length = 0;
    await manage("stop", f.system);
    expect(f.dockerRequests).toEqual([true, false]);
    expect(f.commands).toContainEqual(["docker", "compose", "stop", "api", "web"]);
    expect(f.commands.some((command) => command.includes("up") || command.includes("down"))).toBe(false);
    f.commands.length = 0;
    f.system.docker = async () => [];
    await manage("stop", f.system);
    expect(f.commands).toEqual([]);
    expect(f.logs.at(-1)).toContain("already stopped");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("update advances both main branches, preserves env and reruns init after building", async () => {
  const f = await fixture();
  try {
    await manage("update", f.system);
    for (const name of ["api", "web"]) {
      expect(await readFile(join(f.directory, name, "version.txt"), "utf8")).toBe("2\n");
      expect(await readFile(join(f.directory, name, ".env"), "utf8")).toBe("TOKEN=existing-secret\n");
    }
    expect(await readFile(join(f.directory, ".env"), "utf8")).toBe("POSTGRES_PASSWORD=keep-this-secret\n");
    expect(f.commands.filter((command) => command[0] === "docker")).toEqual([
      ["docker", "compose", "config", "--quiet"],
      ["docker", "compose", "build"],
      ["docker", "compose", "stop", "api", "web"],
      ["docker", "compose", "rm", "--force", "init"],
      ["docker", "compose", "up", "-d", "--wait", "--wait-timeout", "600"],
    ]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("dirty or untracked web files block update before changing API or contacting Docker", async () => {
  for (const file of ["version.txt", "custom.txt"]) {
    const f = await fixture();
    try {
      await writeFile(join(f.directory, "web", file), "Local change\n");
      await expect(manage("update", f.system)).rejects.toThrow("web has local changes");
      expect(await readFile(join(f.directory, "api", "version.txt"), "utf8")).toBe("1\n");
      expect(f.commands).toEqual([]);
      expect(f.dockerRequests).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test("local commits, wrong branch or unexpected remote block update", async () => {
  for (const problem of ["commits", "branch", "remote"]) {
    const f = await fixture();
    try {
      const web = join(f.directory, "web");
      if (problem === "commits") {
        await f.git(["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Local commit"], web);
      } else if (problem === "branch") {
        await f.git(["switch", "-c", "custom"], web);
      } else {
        await f.git(["remote", "set-url", "origin", "https://example.com/web.git"], web);
      }
      await expect(manage("update", f.system)).rejects.toThrow(problem === "commits" ? "local commits" : problem === "branch" ? "not on main" : "Unexpected origin");
      expect(await readFile(join(f.directory, "api", "version.txt"), "utf8")).toBe("1\n");
      expect(f.dockerRequests).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test("failed build never stops running services; incomplete setup fails before Docker", async () => {
  const f = await fixture();
  try {
    const originalRun = f.system.run;
    f.system.run = async (...args) => {
      if (args[0].join(" ") === "docker compose build") throw new Error("Build failed");
      return originalRun(...args);
    };
    await expect(manage("update", f.system)).rejects.toThrow("Build failed");
    expect(f.commands.some((command) => command.includes("stop") || command.includes("up"))).toBe(false);
    f.dockerRequests.length = 0;
    await rm(join(f.directory, "api", ".env"));
    await expect(manage("start", f.system)).rejects.toThrow("Missing api/.env");
    expect(f.dockerRequests).toEqual([]);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
