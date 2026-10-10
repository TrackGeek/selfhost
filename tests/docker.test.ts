import { expect, test } from "bun:test";
import { stat } from "node:fs/promises";
import { dirname } from "node:path";
import { type DockerSystem, ensureDocker } from "../src/docker/setup";

function fixture(platform: string, installed = false, ready = false) {
  const commands: string[][] = [];
  const downloads: Array<{ url: string; path: string }> = [];
  const system: DockerSystem = {
    platform,
    arch: "arm64",
    root: false,
    home: "/home/test",
    username: "test",
    env: { PATH: "/usr/bin", ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\Test\\AppData\\Local" },
    log: () => {},
    exists: async (path) => installed && (path.endsWith("Docker.app") || path.endsWith("Docker Desktop.exe")),
    available: async (command) => {
      if (command[0] === "systemctl") return true;
      if (command.includes("--version")) return installed;
      return ready && (platform !== "linux" || command[0] === "sudo" || system.root);
    },
    run: async (command) => {
      commands.push(command);
      if (command.includes("sh") || command.includes("--accept-license")) installed = true;
      if (command.includes("systemctl") || command[0] === "open" || command[0] === "powershell") ready = true;
      return 0;
    },
    download: async (url, path) => {
      downloads.push({ url, path });
    },
    wait: async (check) => {
      expect(await check()).toBe(true);
    },
  };
  return { system, commands, downloads };
}

test("missing Linux Docker installs and starts automatically, using sudo when required", async () => {
  const { system, commands, downloads } = fixture("linux");
  expect(await ensureDocker(system)).toEqual(["sudo", "docker"]);
  expect(downloads[0].url).toBe("https://get.docker.com");
  expect(commands).toContainEqual(["sudo", "systemctl", "enable", "--now", "docker"]);
  expect(await stat(dirname(downloads[0].path)).catch(() => undefined)).toBeUndefined();
});

test("root Linux installation never needs sudo", async () => {
  const { system, commands } = fixture("linux");
  system.root = true;
  expect(await ensureDocker(system)).toEqual(["docker"]);
  expect(commands.some((command) => command[0] === "sudo")).toBe(false);
});

test("macOS installs the native package without Homebrew and launches Desktop", async () => {
  const { system, commands, downloads } = fixture("darwin");
  expect(await ensureDocker(system)).toEqual(["docker"]);
  expect(downloads[0].url).toBe("https://desktop.docker.com/mac/main/arm64/Docker.dmg");
  expect(commands.some((command) => command.includes("--user=test"))).toBe(true);
  expect(commands.some((command) => command[0] === "hdiutil" && command[1] === "detach")).toBe(true);
  expect(commands).toContainEqual(["open", "-a", "/Applications/Docker.app"]);
});

test("failed macOS installation still detaches the mounted image", async () => {
  const { system, commands } = fixture("darwin");
  const run = system.run;
  system.run = async (command, codes) => {
    if (command.includes("--accept-license")) throw new Error("Installation failed");
    return run(command, codes);
  };
  await expect(ensureDocker(system)).rejects.toThrow("Installation failed");
  expect(commands.some((command) => command[0] === "hdiutil" && command[1] === "detach")).toBe(true);
});

test("Windows installs the native package, refreshes PATH and starts Desktop without a terminal restart", async () => {
  const { system, commands, downloads } = fixture("win32");
  expect(await ensureDocker(system)).toEqual(["docker"]);
  expect(downloads[0].url).toBe("https://desktop.docker.com/win/main/arm64/Docker%20Desktop%20Installer.exe");
  expect(commands.some((command) => command.includes("--user") && command.includes("--backend=wsl-2"))).toBe(true);
  expect(commands.some((command) => command[0] === "powershell")).toBe(true);
  expect(system.env.PATH).toContain("DockerDesktop");
  expect(system.env.TRACKGEEK_DOCKER_DESKTOP).toContain("Docker Desktop.exe");
});

test("Windows reboot requirement stops with a clear resume instruction", async () => {
  const { system, commands } = fixture("win32");
  const run = system.run;
  system.run = async (command, codes) => {
    await run(command, codes);
    return command.includes("--accept-license") ? 3010 : 0;
  };
  await expect(ensureDocker(system)).rejects.toThrow("Restart Windows");
  expect(commands.some((command) => command[0] === "powershell")).toBe(false);
});

test("existing running Desktop is reused without installation or startup commands", async () => {
  const { system, commands, downloads } = fixture("darwin", true, true);
  expect(await ensureDocker(system)).toEqual(["docker"]);
  expect(downloads).toEqual([]);
  expect(commands).toEqual([]);
});

test("installed Desktop with missing PATH is started without reinstalling", async () => {
  const { system, commands, downloads } = fixture("darwin", true);
  const available = system.available;
  system.available = (command) => (command.includes("--version") ? Promise.resolve(false) : available(command));
  expect(await ensureDocker(system)).toEqual(["docker"]);
  expect(downloads).toEqual([]);
  expect(commands).toContainEqual(["open", "-a", "/Applications/Docker.app"]);
});

test("stop does not install missing Docker or start stopped Desktop", async () => {
  for (const platform of ["linux", "darwin", "win32"]) {
    for (const installed of [false, true]) {
      const { system, commands, downloads } = fixture(platform, installed);
      expect(await ensureDocker(system, false)).toEqual([]);
      expect(downloads).toEqual([]);
      expect(commands.every((command) => command.join(" ") === "sudo -v")).toBe(true);
    }
  }
});

test("stop reuses running Docker with sudo when required", async () => {
  const { system, commands } = fixture("linux", true, true);
  expect(await ensureDocker(system, false)).toEqual(["sudo", "docker"]);
  expect(commands).toEqual([["sudo", "-v"]]);
});
