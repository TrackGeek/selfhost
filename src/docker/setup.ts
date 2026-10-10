import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

export interface DockerSystem {
  platform: string;
  arch: string;
  root: boolean;
  home: string;
  username: string;
  env: Record<string, string | undefined>;
  run: (command: string[], allowedExitCodes?: number[]) => Promise<number>;
  available: (command: string[]) => Promise<boolean>;
  exists: (path: string) => Promise<boolean>;
  download: (url: string, path: string) => Promise<void>;
  wait: (check: () => Promise<boolean>, message: string) => Promise<void>;
  log: (message: string) => void;
}

export async function ensureDocker(system: DockerSystem, start = true): Promise<string[]> {
  const { platform, arch, home, env } = system;
  if (!["linux", "darwin", "win32"].includes(platform)) throw new Error("Unsupported operating system.");
  const windowsRoots = [
    join(env.ProgramFiles || "C:\\Program Files", "Docker", "Docker"),
    ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, "Programs", "DockerDesktop")] : []),
  ];
  const paths =
    platform === "darwin"
      ? [join(home, ".docker", "bin"), "/Applications/Docker.app/Contents/Resources/bin"]
      : platform === "win32"
        ? windowsRoots.map((root) => join(root, "resources", "bin"))
        : [];
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") || "PATH";
  env[pathKey] = [...paths, env[pathKey] || ""].join(platform === "win32" ? ";" : delimiter);
  const desktop =
    platform === "darwin"
      ? (await system.exists("/Applications/Docker.app"))
        ? "/Applications/Docker.app"
        : undefined
      : platform === "win32"
        ? (
            await Promise.all(
              windowsRoots.map(async (root) => {
                const executable = join(root, "Docker Desktop.exe");
                return (await system.exists(executable)) ? executable : undefined;
              }),
            )
          ).find(Boolean)
        : undefined;
  const hasCli = await system.available(["docker", "--version"]);
  if (!hasCli && !desktop) {
    if (!start) return [];
    system.log("Docker is missing. Installing it automatically. Your system may ask for an administrator password.");
    const directory = await mkdtemp(join(tmpdir(), "trackgeek-docker-"));
    let mounted = false;
    try {
      if (platform === "linux") {
        const script = join(directory, "install.sh");
        await system.download("https://get.docker.com", script);
        await system.run([...(system.root ? [] : ["sudo"]), "sh", script]);
      } else {
        if (!["x64", "arm64"].includes(arch)) throw new Error(`Unsupported Docker Desktop architecture: ${arch}.`);
        const dockerArch = arch === "x64" ? "amd64" : "arm64";
        if (platform === "darwin") {
          const image = join(directory, "Docker.dmg");
          const mount = join(directory, "mount");
          await mkdir(mount);
          await system.download(`https://desktop.docker.com/mac/main/${dockerArch}/Docker.dmg`, image);
          await system.run(["hdiutil", "attach", image, "-mountpoint", mount, "-nobrowse", "-quiet"]);
          mounted = true;
          try {
            await system.run([
              ...(system.root ? [] : ["sudo"]),
              join(mount, "Docker.app", "Contents", "MacOS", "install"),
              "--accept-license",
              `--user=${system.username}`,
            ]);
          } finally {
            await system.run(["hdiutil", "detach", mount, "-quiet"]);
            mounted = false;
          }
        } else {
          const executable = join(directory, "Docker Desktop Installer.exe");
          await system.download(
            `https://desktop.docker.com/win/main/${dockerArch}/Docker%20Desktop%20Installer.exe`,
            executable,
          );
          const code = await system.run(
            [executable, "install", "--quiet", "--accept-license", "--user", "--backend=wsl-2"],
            [0, 3010],
          );
          if (code === 3010)
            throw new Error(
              "Docker is installed. Restart Windows, then run the TrackGeek installer again to continue.",
            );
        }
      }
    } finally {
      if (!mounted) await rm(directory, { recursive: true, force: true });
    }
  }
  let command = ["docker"];
  if (!(await system.available([...command, "info"]))) {
    if (start) system.log("Starting Docker automatically...");
    if (platform === "linux") {
      const prefix = system.root ? [] : ["sudo"];
      if (!system.root) {
        system.log("Docker needs administrator access. Enter your system password if prompted.");
        await system.run(["sudo", "-v"]);
      }
      command = [...prefix, "docker"];
      if (!(await system.available([...command, "info"]))) {
        if (!start) return [];
        if (await system.available(["systemctl", "--version"])) {
          await system.run([...prefix, "systemctl", "enable", "--now", "docker"]);
        } else {
          await system.run([...prefix, "service", "docker", "start"]);
        }
      }
    } else if (platform === "darwin") {
      if (!start) return [];
      await system.run(["open", "-a", "/Applications/Docker.app"]);
    } else {
      if (!start) return [];
      const executable =
        desktop ||
        (
          await Promise.all(
            windowsRoots.map(async (root) => {
              const path = join(root, "Docker Desktop.exe");
              return (await system.exists(path)) ? path : undefined;
            }),
          )
        ).find(Boolean);
      if (!executable)
        throw new Error("Docker Desktop installation did not finish. Restart Windows, then run the installer again.");
      env.TRACKGEEK_DOCKER_DESKTOP = executable;
      await system.run([
        "powershell",
        "-NoProfile",
        "-Command",
        "Start-Process -FilePath $env:TRACKGEEK_DOCKER_DESKTOP",
      ]);
    }
    await system.wait(
      () => system.available([...command, "info"]),
      "Waiting for Docker to start. Complete any Docker Desktop setup dialogs. If Windows requests a restart, restart and run this installer again.",
    );
  }
  return command;
}
