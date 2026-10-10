import { chmod, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { capture, run } from "../system/process";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

export async function installCommand(projectDir: string, installDir: string) {
  const directory = join(installDir, ".trackgeek");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const build = await Bun.build({
    entrypoints: [join(projectDir, "src", "cli.ts")],
    target: "bun",
    packages: "bundle",
  });
  if (!build.success || build.outputs.length !== 1)
    throw new Error(`Could not build the TrackGeek command: ${build.logs.join("\n")}`);
  const entry = join(directory, "cli.js");
  await writeFile(entry, await build.outputs[0].text(), { mode: 0o600 });
  const bin = process.platform === "win32"
    ? join(process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "TrackGeek", "bin")
    : join(process.env.BUN_INSTALL || join(homedir(), ".bun"), "bin");
  await mkdir(bin, { recursive: true });
  const launcher = join(bin, process.platform === "win32" ? "trackgeek.cmd" : "trackgeek");
  if (process.platform === "win32") {
    const quote = (value: string) => `"${value.replaceAll("%", "%%")}"`;
    await writeFile(launcher, `@echo off\r\n${quote(process.execPath)} ${quote(entry)} %*\r\nexit /b %ERRORLEVEL%\r\n`);
    const path = await capture(["powershell", "-NoProfile", "-Command", "[Environment]::GetEnvironmentVariable('Path', 'User')"], installDir);
    if (!path.split(";").some((item) => item.toLowerCase() === bin.toLowerCase())) {
      process.env.TRACKGEEK_COMMAND_PATH = `${bin};${path}`;
      try {
        await run(["powershell", "-NoProfile", "-Command", "[Environment]::SetEnvironmentVariable('Path', $env:TRACKGEEK_COMMAND_PATH, 'User')"], installDir);
      } finally {
        delete process.env.TRACKGEEK_COMMAND_PATH;
      }
    }
    return "Management: trackgeek start | trackgeek stop | trackgeek update\nOpen a new terminal to load the updated PATH.";
  }
  await writeFile(launcher, `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(entry)} "$@"\n`, { mode: 0o755 });
  await chmod(launcher, 0o755);
  const inPath = (process.env.PATH || "").split(delimiter).some((item) => resolve(item) === resolve(bin));
  return `Management: trackgeek start | trackgeek stop | trackgeek update${inPath ? "" : `\nAdd the command to PATH: export PATH=${shellQuote(bin)}:"$PATH"`}`;
}
