import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type AutostartupSystem, configureAutostartup } from "../src/management/autostartup";

async function fixture(platform = "linux") {
  const root = await mkdtemp(join(tmpdir(), "trackgeek-startup-'$%&-"));
  const directory = join(root, "installation space");
  const home = join(root, "home");
  await mkdir(home);
  await mkdir(join(directory, ".trackgeek"), { recursive: true });
  await writeFile(join(directory, ".trackgeek", "cli.js"), "");
  await writeFile(join(directory, ".trackgeek-installation"), "TrackGeek selfhost v1\n");
  for (const file of ["compose.yaml", ".env", "api/.env", "web/.env"]) {
    await mkdir(join(directory, file, ".."), { recursive: true });
    await writeFile(join(directory, file), "");
  }
  const commands: string[][] = [];
  const requests: boolean[] = [];
  const logs: string[] = [];
  let installed = false;
  const system: AutostartupSystem = {
    platform, directory, home,
    root: false,
    username: "test-user",
    uid: 1000,
    executable: join(root, "bun bin", "bun"),
    env: { PATH: "/custom/bin:/usr/bin:/bin" },
    exists: async (path) => path === "/run/systemd/system" || (path === "/etc/systemd/system/trackgeek.service" && installed),
    available: async (command) => command[1] !== "print",
    run: async (command) => {
      commands.push(command);
      if (command.includes("install")) installed = true;
      if (command.includes("rm")) installed = false;
      return 0;
    },
    capture: async (command) => { commands.push(command); return "aaa\nbbb\nccc\nddd\n"; },
    docker: async (start) => { requests.push(start); return ["docker"]; },
    log: (message) => logs.push(message),
  };
  return { root, directory, system, commands, requests, logs };
}

test("Linux registers boot startup under the user account, safely quotes paths and updates container policies", async () => {
  const f = await fixture();
  try {
    await configureAutostartup(true, f.system);
    const unit = await readFile(join(f.directory, ".trackgeek", "startup.service"), "utf8");
    expect(unit).toContain("User=test-user");
    expect(unit).toContain("SupplementaryGroups=docker");
    expect(unit).toContain("Requires=docker.service");
    expect(unit).toContain("WantedBy=multi-user.target");
    expect(unit).toContain("Restart=on-failure");
    expect(unit).toContain("'$$%%&");
    expect(unit).toContain('cli.js" "start"');
    expect(unit).not.toContain('"update"');
    expect(f.commands).toContainEqual(["sudo", "systemctl", "enable", "docker.service", "trackgeek.service"]);
    expect(f.commands).toContainEqual(["docker", "update", "--restart", "on-failure", "aaa", "bbb", "ccc", "ddd"]);
    expect(f.commands).toContainEqual(["docker", "compose", "ps", "--all", "--quiet", "postgres", "redis", "api", "web"]);
    expect(f.commands.some((command) => command.includes("up") || command.includes("stop"))).toBe(false);
    expect(f.logs.at(-1)).toContain("at boot");
    await configureAutostartup(true, f.system);
    expect(f.commands.filter((command) => command.includes("install")).map((command) => command.at(-1)))
      .toEqual(["/etc/systemd/system/trackgeek.service", "/etc/systemd/system/trackgeek.service"]);
    f.commands.length = 0;
    await configureAutostartup(false, f.system);
    expect(f.commands).toContainEqual(["sudo", "systemctl", "disable", "--now", "trackgeek.service"]);
    expect(f.commands).toContainEqual(["sudo", "rm", "-f", "/etc/systemd/system/trackgeek.service"]);
    expect(f.commands.some((command) => command.includes("stop") || command.includes("down") ||
      (command.includes("disable") && command.includes("docker.service")))).toBe(false);
    await configureAutostartup(false, f.system);
    expect(f.commands.filter((command) => command.includes("disable"))).toHaveLength(1);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("root Linux setup does not use sudo; absent containers do not produce an empty docker update", async () => {
  const f = await fixture();
  try {
    f.system.root = true;
    f.system.username = "root";
    f.system.capture = async () => "";
    await configureAutostartup(true, f.system);
    expect(f.commands.some((command) => command[0] === "sudo")).toBe(false);
    expect(f.commands.some((command) => command[1] === "update")).toBe(false);
    expect(await readFile(join(f.directory, ".trackgeek", "startup.service"), "utf8")).not.toContain("SupplementaryGroups");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("macOS registers a login agent with absolute paths, failure retries and logs; off unloads and removes it", async () => {
  const f = await fixture("darwin");
  try {
    await configureAutostartup(true, f.system);
    const path = join(f.system.home, "Library", "LaunchAgents", "com.trackgeek.startup.plist");
    const plist = await readFile(path, "utf8");
    expect(plist).toContain("&apos;$%&amp;");
    expect(plist).toContain("<key>RunAtLoad</key><true/>");
    expect(plist).toContain("<key>SuccessfulExit</key><false/>");
    expect(plist).toContain("<string>start</string>");
    expect(plist).toContain("startup.log");
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(f.logs.at(-1)).toContain("when you log in");
    f.system.available = async () => true;
    await configureAutostartup(false, f.system);
    expect(f.commands).toContainEqual(["launchctl", "bootout", "gui/1000/com.trackgeek.startup"]);
    expect(await Bun.file(path).exists()).toBe(false);
    f.system.available = async () => false;
    await configureAutostartup(false, f.system);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("Windows task uses current-user login, quoted paths, failure retries and removal without stored passwords", async () => {
  const f = await fixture("win32");
  try {
    await configureAutostartup(true, f.system);
    const command = f.commands.find((command) => command[0] === "powershell")!;
    const script = command.at(-1)!;
    expect(script).toContain("New-ScheduledTaskTrigger -AtLogOn -User $user");
    expect(script).toContain("-LogonType Interactive -RunLevel Limited");
    expect(script).toContain("-RestartCount 3");
    expect(script).toContain("-AllowStartIfOnBatteries -DontStopIfGoingOnBatteries");
    expect(script).toContain("''$%&");
    expect(script).toContain("cli.js\" start'");
    expect(script).toContain("-Force");
    expect(script).not.toContain("-Password");
    f.commands.length = 0;
    await configureAutostartup(false, f.system);
    expect(f.commands.find((command) => command[0] === "powershell")!.at(-1)).toContain("Unregister-ScheduledTask");
    expect(f.commands.some((command) => command.includes("stop") || command.includes("down"))).toBe(false);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("incomplete installation, unsupported OS, missing systemd/Docker service and unsafe paths fail before mutations", async () => {
  for (const problem of ["installation", "platform", "systemd", "docker-service", "path"]) {
    const f = await fixture();
    try {
      if (problem === "installation") await rm(join(f.directory, "api", ".env"));
      if (problem === "platform") f.system.platform = "freebsd";
      if (problem === "systemd") f.system.exists = async () => false;
      if (problem === "docker-service") f.system.available = async () => false;
      if (problem === "path") f.system.executable = "/bun\nExecStart=bad";
      await expect(configureAutostartup(true, f.system)).rejects.toThrow();
      expect(f.commands).toEqual([]);
      expect(f.requests).toEqual([]);
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  }
});

test("Docker failures do not register startup; templates preserve crash recovery without daemon boot restarts", async () => {
  const f = await fixture();
  try {
    f.system.docker = async () => { throw new Error("Docker unavailable"); };
    await expect(configureAutostartup(true, f.system)).rejects.toThrow("Docker unavailable");
    expect(f.commands).toEqual([]);
    const compose = await Bun.file(new URL("../templates/compose.yaml", import.meta.url)).text();
    expect(compose.match(/restart: on-failure/g)).toHaveLength(4);
    expect(compose).not.toContain("unless-stopped");
    for (const file of ["install.sh", "install.ps1"])
      expect(await Bun.file(new URL(`../${file}`, import.meta.url)).text()).toContain("src/management/autostartup.ts");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
