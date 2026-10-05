import { chmod, copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { composeEnv, parseRawEnv, rawEnv, secret, templateKeys, validatePort, validateUrl } from "./config";

const sourceDir = dirname(fileURLToPath(import.meta.url));
let installDir = "";
let docker = ["docker"];

function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Installation cancelled. Existing data preserved.");
    process.exit(1);
  }
  return value as T;
}

async function run(command: string[], cwd = sourceDir, quiet = false) {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "inherit",
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
  });
  const code = await child.exited;
  if (code !== 0) throw new Error(`${command.slice(0, 3).join(" ")} exited with code ${code}.`);
}

async function available(command: string[]) {
  try {
    await run(command, sourceDir, true);
    return true;
  } catch {
    return false;
  }
}

async function exists(path: string) {
  return stat(path).then(
    () => true,
    () => false,
  );
}

async function ask(message: string, value = "", required = false, masked = false) {
  const validate = (input = "") => {
    if (/[\r\n\0]/.test(input)) return "Use a single line.";
    if (required && !(input || value).trim()) return "This field is required.";
  };
  const result = answer(
    await (masked
      ? p.password({ message: `${message}${value ? " (press Enter to keep the current value)" : ""}`, validate })
      : p.text({ message, defaultValue: value, placeholder: value, validate })),
  );
  return result || value;
}

async function prerequisites() {
  if (!(await available(["git", "--version"]))) {
    if (!answer(await p.confirm({ message: "Git is missing. Install it using the system package manager?" }))) {
      throw new Error("Install Git and run the installer again: https://git-scm.com/downloads");
    }
    if (process.platform === "win32") {
      await run([
        "winget",
        "install",
        "--exact",
        "--id",
        "Git.Git",
        "--accept-source-agreements",
        "--accept-package-agreements",
      ]);
      throw new Error("Git installed. Run the installer again in a new terminal.");
    } else if (process.platform === "darwin") {
      if (!Bun.which("brew"))
        throw new Error(
          "Install Git using Xcode Command Line Tools (xcode-select --install), then run the installer again.",
        );
      await run(["brew", "install", "git"]);
    } else {
      const prefix = process.getuid?.() === 0 ? [] : ["sudo"];
      if (Bun.which("apt-get")) {
        await run([...prefix, "apt-get", "update"]);
        await run([...prefix, "apt-get", "install", "-y", "git"]);
      } else if (Bun.which("dnf")) {
        await run([...prefix, "dnf", "install", "-y", "git"]);
      } else if (Bun.which("pacman")) {
        await run([...prefix, "pacman", "-S", "--needed", "--noconfirm", "git"]);
      } else {
        throw new Error("Install Git using the system package manager, then run the installer again.");
      }
    }
  }
  if (!(await available(["docker", "--version"]))) {
    p.note(
      "Docker installs and runs PostgreSQL, Redis, the API and the web app. Administrator permissions and a restart may be required.",
      "Docker is missing",
    );
    if (!answer(await p.confirm({ message: "Install Docker?" }))) {
      throw new Error("Install Docker: https://docs.docker.com/get-started/get-docker/");
    }
    if (process.platform === "linux") {
      const response = await fetch("https://get.docker.com");
      if (!response.ok) throw new Error("Could not download the official Docker installer.");
      const path = join(sourceDir, "docker-install.sh");
      await writeFile(path, await response.text(), { mode: 0o600 });
      await run(process.getuid?.() === 0 ? ["sh", path] : ["sudo", "sh", path]);
    } else if (process.platform === "darwin") {
      if (!Bun.which("brew"))
        throw new Error("Install Docker Desktop: https://docs.docker.com/desktop/setup/install/mac-install/");
      await run(["brew", "install", "--cask", "docker"]);
      await run(["open", "-a", "Docker"]);
    } else if (process.platform === "win32") {
      await run([
        "winget",
        "install",
        "--exact",
        "--id",
        "Docker.DockerDesktop",
        "--accept-source-agreements",
        "--accept-package-agreements",
      ]);
      throw new Error(
        "Open Docker Desktop, enable Linux containers and run the installer again in a new terminal. Restart Windows if prompted.",
      );
    } else {
      throw new Error("Unsupported operating system.");
    }
  }
  if (!(await available(["docker", "info"]))) {
    if (
      process.platform === "linux" &&
      answer(await p.confirm({ message: "Docker is unavailable. Try sudo docker?", initialValue: false }))
    ) {
      docker = ["sudo", "docker"];
      await run([...docker, "info"], sourceDir, true);
    } else {
      throw new Error("Start Docker/Docker Desktop, check permissions and run the installer again.");
    }
  }
  const child = Bun.spawn([...docker, "compose", "version", "--short"], { stdout: "pipe", stderr: "inherit" });
  const version = (await new Response(child.stdout).text()).trim().replace(/^v/, "");
  if ((await child.exited) !== 0) throw new Error("Docker Compose is missing.");
  const [major, minor] = version.split(".").map(Number);
  if (!(major > 2 || (major === 2 && minor >= 30)))
    throw new Error("Docker Compose 2.30+ is required (raw env_file support).");
}

async function repository(name: "api" | "web") {
  const path = join(installDir, name);
  if (await exists(path)) {
    if (!(await exists(join(path, ".git"))))
      throw new Error(`${path} already exists and is not a Git clone. Choose another directory.`);
    const proc = Bun.spawn(["git", "remote", "get-url", "origin"], { cwd: path, stdout: "pipe", stderr: "inherit" });
    const origin = (await new Response(proc.stdout).text()).trim();
    if ((await proc.exited) !== 0 || origin !== `https://github.com/TrackGeek/${name}.git`) {
      throw new Error(`Unexpected repository at ${path}. Choose another directory.`);
    }
    p.log.info(`Existing ${name} clone: source preserved, no automatic git pull.`);
  } else {
    await run(["git", "clone", "--depth", "1", `https://github.com/TrackGeek/${name}.git`, path]);
  }
}

async function protectedWrite(path: string, content: string) {
  await writeFile(path, content, { mode: 0o600 });
  if (process.platform !== "win32") await chmod(path, 0o600);
}

async function main() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error("Run the installer in an interactive terminal.");
  p.intro("TrackGeek · full installation");
  await prerequisites();
  installDir = resolve(await ask("Installation directory", join(homedir(), "trackgeek"), true));
  const statePath = join(installDir, ".trackgeek.json");
  const markerPath = join(installDir, ".trackgeek-installation");
  const recognized = (await exists(markerPath)) && (await readFile(markerPath, "utf8")) === "TrackGeek selfhost v1\n";
  if ((await exists(installDir)) && !(await exists(statePath)) && !recognized) {
    const { readdir } = await import("node:fs/promises");
    if ((await readdir(installDir)).length)
      throw new Error(
        "The directory is not empty and has no recognized TrackGeek installation. Choose another directory.",
      );
  }
  await mkdir(installDir, { recursive: true, mode: 0o700 });
  await protectedWrite(markerPath, "TrackGeek selfhost v1\n");
  const previous: Record<string, string> = (await exists(statePath))
    ? JSON.parse(await readFile(statePath, "utf8"))
    : {};
  await repository("api");
  await repository("web");
  const apiPath = join(installDir, "api", ".env");
  const api = (await exists(apiPath)) ? parseRawEnv(await readFile(apiPath, "utf8")) : {};
  const webPath = join(installDir, "web", ".env");
  const web = (await exists(webPath)) ? parseRawEnv(await readFile(webPath, "utf8")) : {};
  const apiKeys = templateKeys(await readFile(join(installDir, "api", ".env.example"), "utf8"));
  const webKeys = templateKeys(await readFile(join(installDir, "web", ".env.example"), "utf8"));
  for (const key of apiKeys) api[key] ??= "";
  for (const key of webKeys) web[key] ??= "";
  const webPort = answer(
    await p.text({ message: "Web port", defaultValue: previous.WEB_PORT || "3000", validate: validatePort }),
  );
  const apiPort = answer(
    await p.text({
      message: "API port",
      defaultValue: previous.API_PORT || "40287",
      validate: (value) =>
        validatePort(value) || (Number(value) === Number(webPort) ? "Web and API ports must be different." : undefined),
    }),
  );
  const webUrl = answer(
    await p.text({
      message: "Public web URL (used by the browser)",
      defaultValue: web.VITE_SITE_URL || `http://localhost:${webPort}`,
      validate: validateUrl,
    }),
  );
  const apiUrl = answer(
    await p.text({
      message: "Public API URL (used by the browser)",
      defaultValue: web.VITE_API_URL || `http://localhost:${apiPort}`,
      validate: validateUrl,
    }),
  );
  const bind = answer(
    await p.select({
      message: "Access",
      initialValue: previous.BIND_ADDRESS || "127.0.0.1",
      options: [
        { value: "127.0.0.1", label: "Local / reverse proxy on this computer" },
        { value: "0.0.0.0", label: "Network / server (configure firewall and HTTPS)" },
      ],
    }),
  );
  p.note(
    "Resend, image upload and media integration credentials are required. Use real keys; the installer does not provide them. OAuth, the Discord bot, Stripe and Dataxamas are optional.",
    "Required credentials",
  );
  const requiredCredentials = [
    "RESEND_API_KEY",
    "RESEND_FROM",
    "IMGBB_API_KEY",
    "HARDCOVER_API_KEY",
    "TMDB_API_KEY",
    "IGDB_CLIENT_ID",
    "IGDB_CLIENT_SECRET",
  ];
  for (const key of requiredCredentials) api[key] = await ask(key, api[key], true, key !== "RESEND_FROM");
  if (
    answer(
      await p.confirm({ message: "Enable Stripe payments?", initialValue: Boolean(api.STRIPE_SECRET_KEY?.trim()) }),
    )
  ) {
    api.STRIPE_SECRET_KEY = await ask("STRIPE_SECRET_KEY", api.STRIPE_SECRET_KEY, true, true);
    api.STRIPE_WEBHOOK_SECRET = await ask(
      "STRIPE_WEBHOOK_SECRET (optional; required for webhooks)",
      api.STRIPE_WEBHOOK_SECRET,
      false,
      true,
    );
  } else {
    api.STRIPE_SECRET_KEY = "";
    api.STRIPE_WEBHOOK_SECRET = "";
  }
  if (
    answer(
      await p.confirm({
        message: "Enable Dataxamas? (the key is public in the browser)",
        initialValue: Boolean(web.VITE_DATAXAMAS_API_KEY),
      }),
    )
  ) {
    web.VITE_DATAXAMAS_API_KEY = await ask("VITE_DATAXAMAS_API_KEY", web.VITE_DATAXAMAS_API_KEY, true, true);
  } else {
    web.VITE_DATAXAMAS_API_KEY = "";
  }
  const managed = new Set([
    "PORT",
    "NODE_ENV",
    "DATABASE_URL",
    "REDIS_URL",
    "BETTER_AUTH_URL",
    "BETTER_AUTH_SECRET",
    "WEB_URL",
    "PASSKEY_RP_ID",
    "STRIPE_SECRET_KEY",
    "STRIPE_WEBHOOK_SECRET",
    ...requiredCredentials,
  ]);
  const optional = answer(
    await p.multiselect({
      message: "Optional variables to configure (Space to select, Enter to continue)",
      required: false,
      options: apiKeys.filter((key) => !managed.has(key)).map((key) => ({ value: key, label: key })),
    }),
  );
  for (const key of optional) api[key] = await ask(key, api[key], false, true);
  const root = {
    POSTGRES_PASSWORD: previous.POSTGRES_PASSWORD || secret(),
    REDIS_PASSWORD: previous.REDIS_PASSWORD || secret(),
    WEB_PORT: webPort,
    API_PORT: apiPort,
    BIND_ADDRESS: bind,
    VITE_SITE_URL: new URL(webUrl).origin,
    VITE_API_URL: new URL(apiUrl).origin,
    VITE_DATAXAMAS_API_KEY: web.VITE_DATAXAMAS_API_KEY,
  };
  Object.assign(api, {
    NODE_ENV: "production",
    PORT: "40287",
    DATABASE_URL: `postgresql://trackgeek:${root.POSTGRES_PASSWORD}@postgres:5432/trackgeek`,
    REDIS_URL: `redis://:${root.REDIS_PASSWORD}@redis:6379`,
    BETTER_AUTH_URL: root.VITE_API_URL,
    WEB_URL: root.VITE_SITE_URL,
    BETTER_AUTH_SECRET: api.BETTER_AUTH_SECRET || secret(),
    PASSKEY_RP_ID: new URL(webUrl).hostname,
  });
  Object.assign(web, { VITE_API_URL: root.VITE_API_URL, VITE_SITE_URL: root.VITE_SITE_URL });
  p.note(
    `Directory: ${installDir}\nWeb: ${root.VITE_SITE_URL}\nAPI: ${root.VITE_API_URL}\nDB: PostgreSQL + Redis, persistent volumes\nSeed: medals and missions, no demo users\nRepos: github.com/TrackGeek/web and github.com/TrackGeek/api`,
    "Summary",
  );
  if (!answer(await p.confirm({ message: "Save configuration, build images and start TrackGeek?" }))) {
    p.cancel("Installation cancelled. Clones kept; configuration unchanged.");
    return;
  }
  await protectedWrite(statePath, JSON.stringify(root, null, 2));
  await protectedWrite(apiPath, rawEnv(api));
  await protectedWrite(webPath, rawEnv(web));
  await protectedWrite(join(installDir, ".env"), composeEnv(root));
  for (const file of ["compose.yaml", "Dockerfile.api", "Dockerfile.web"])
    await copyFile(join(sourceDir, "templates", file), join(installDir, file));
  await protectedWrite(join(installDir, ".gitignore"), ".env\n.trackgeek.json\napi/\nweb/\n");
  await run([...docker, "compose", "config", "--quiet"], installDir);
  p.log.step("Building images, applying migrations, running the production seed and waiting for healthy services.");
  await run([...docker, "compose", "build"], installDir);
  await run([...docker, "compose", "up", "-d", "--wait", "--wait-timeout", "600"], installDir);
  p.outro(
    `TrackGeek is ready: ${root.VITE_SITE_URL}\nManagement: cd "${installDir}"; ${docker.join(" ")} compose logs -f\nCreate your account through the web interface. Email requires a verified Resend domain.`,
  );
}

main().catch((error) => {
  p.log.error(error instanceof Error ? error.message : String(error));
  if (installDir)
    p.log.info(
      `Data preserved in ${installDir}. Run the installer again to resume. Diagnostics: ${docker.join(" ")} compose logs --tail 100`,
    );
  process.exitCode = 1;
});
