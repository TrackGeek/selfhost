import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import {
  composeEnv,
  DEFAULT_API_PORT,
  DEFAULT_WEB_PORT,
  parseRawEnv,
  publicUrlDefault,
  rawEnv,
  secret,
  templateKeys,
  validatePort,
  validateUrl,
} from "./config/env";
import { installCommand } from "./management/install";
import { prepareDocker } from "./docker/runtime";
import { exists } from "./system/filesystem";
import { addGitPath } from "./system/git";
import { available as runtimeAvailable, run as runtimeRun } from "./system/process";

const projectDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let installDir = "";
let docker = ["docker"];

function answer<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Installation cancelled. Existing data preserved.");
    process.exit(1);
  }
  return value as T;
}

function run(command: string[], cwd = projectDir, quiet = false, allowedExitCodes = [0]) {
  return runtimeRun(command, cwd, quiet, allowedExitCodes);
}

function available(command: string[]) {
  return runtimeAvailable(command, projectDir);
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
    p.log.step("Git is missing. Installing it automatically...");
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
      addGitPath();
      if (!(await available(["git", "--version"])))
        throw new Error("Git installed, but is not available yet. Run this installer again in a new terminal.");
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
  docker = await prepareDocker(projectDir);
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
    await run(["git", "clone", "--branch", "main", "--depth", "1", `https://github.com/TrackGeek/${name}.git`, path]);
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
  let webPort = previous.WEB_PORT || DEFAULT_WEB_PORT;
  let apiPort = previous.API_PORT || DEFAULT_API_PORT;
  let webUrl = web.VITE_SITE_URL || `http://localhost:${webPort}`;
  let apiUrl = web.VITE_API_URL || `http://localhost:${apiPort}`;
  let bind = previous.BIND_ADDRESS || "127.0.0.1";
  p.note(
    `Web: ${webUrl} (port ${webPort})\nAPI: ${apiUrl} (port ${apiPort})\nAccess: ${bind === "127.0.0.1" ? "local only" : "network"}\nPress Enter to keep these settings. Choose No to customize ports, URLs or network access.`,
    "Network settings",
  );
  if (!answer(await p.confirm({ message: "Use these network settings?", initialValue: true }))) {
    const previousWebPort = webPort;
    const previousApiPort = apiPort;
    webPort = answer(
      await p.text({ message: "Web port", defaultValue: webPort, placeholder: webPort, validate: validatePort }),
    );
    apiPort = answer(
      await p.text({
        message: "API port",
        defaultValue: apiPort,
        placeholder: apiPort,
        validate: (value) =>
          validatePort(value) ||
          (Number(value) === Number(webPort) ? "Web and API ports must be different." : undefined),
      }),
    );
    webUrl = answer(
      await p.text({
        message: "Public web URL (used by the browser)",
        defaultValue: publicUrlDefault(webUrl, previousWebPort, webPort),
        validate: validateUrl,
      }),
    );
    apiUrl = answer(
      await p.text({
        message: "Public API URL (used by the browser)",
        defaultValue: publicUrlDefault(apiUrl, previousApiPort, apiPort),
        validate: validateUrl,
      }),
    );
    bind = answer(
      await p.select({
        message: "Access",
        initialValue: bind,
        options: [
          { value: "127.0.0.1", label: "Local / reverse proxy on this computer" },
          { value: "0.0.0.0", label: "Network / server (configure firewall and HTTPS)" },
        ],
      }),
    );
  }
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
    await copyFile(join(projectDir, "templates", file), join(installDir, file));
  await protectedWrite(join(installDir, ".gitignore"), ".env\n.trackgeek.json\n.trackgeek/\napi/\nweb/\n");
  const management = await installCommand(projectDir, installDir);
  await run([...docker, "compose", "config", "--quiet"], installDir);
  p.log.step("Building images, applying migrations, running the production seed and waiting for healthy services.");
  await run([...docker, "compose", "build"], installDir);
  await run([...docker, "compose", "up", "-d", "--wait", "--wait-timeout", "600"], installDir);
  p.outro(
    `TrackGeek is ready: ${root.VITE_SITE_URL}\n${management}\nLogs: cd "${installDir}"; ${docker.join(" ")} compose logs -f\nCreate your account through the web interface. Email requires a verified Resend domain.`,
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
