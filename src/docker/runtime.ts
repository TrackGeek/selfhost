import { homedir, userInfo } from "node:os";
import * as p from "@clack/prompts";
import { exists } from "../system/filesystem";
import { available, capture, run } from "../system/process";
import { ensureDocker } from "./setup";

export async function prepareDocker(cwd: string, start = true) {
  const docker = await ensureDocker({
    platform: process.platform,
    arch: process.arch,
    root: process.getuid?.() === 0,
    home: homedir(),
    username: userInfo().username,
    env: process.env,
    run: (command, codes) => run(command, cwd, false, codes),
    available: (command) => available(command, cwd),
    exists,
    download: async (url, path) => {
      const spinner = p.spinner();
      spinner.start("Downloading the official Docker installer...");
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Could not download Docker installer: HTTP ${response.status}.`);
        await Bun.write(path, response);
        spinner.stop("Docker installer downloaded.");
      } catch (error) {
        spinner.stop("Docker download failed. Check your internet connection and try again.");
        throw error;
      }
    },
    wait: async (check, message) => {
      const spinner = p.spinner();
      spinner.start(message);
      const deadline = Date.now() + 300000;
      try {
        while (!(await check())) {
          if (Date.now() >= deadline)
            throw new Error("Docker did not start within five minutes. Complete Docker Desktop setup or restart Windows if requested, then try again.");
          await Bun.sleep(2000);
        }
        spinner.stop("Docker is ready.");
      } catch (error) {
        spinner.stop("Docker startup needs attention.");
        throw error;
      }
    },
    log: p.log.step,
  }, start);
  if (!docker.length) return docker;
  if ((await capture([...docker, "info", "--format", "{{.OSType}}"], cwd)) !== "linux")
    throw new Error("TrackGeek needs Linux containers. Switch Docker Desktop to Linux containers and try again.");
  const version = (await capture([...docker, "compose", "version", "--short"], cwd)).replace(/^v/, "");
  const [major, minor] = version.split(".").map(Number);
  if (!(major > 2 || (major === 2 && minor >= 30)))
    throw new Error("Docker Compose 2.30+ is required (raw env_file support).");
  return docker;
}

