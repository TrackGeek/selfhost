import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installCommand } from "../src/management/install";

test("installed bundled command runs from another directory and handles quoted paths", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "trackgeek-command-'$-"));
  const oldBunInstall = process.env.BUN_INSTALL;
  try {
    process.env.BUN_INSTALL = join(root, "bun");
    const directory = join(root, "install space");
    await mkdir(directory);
    await installCommand(resolve(dirname(fileURLToPath(import.meta.url)), ".."), directory);
    const launcher = join(root, "bun", "bin", "tg");
    for (const args of [[], ["help"], ["--help"], ["-h"]]) {
      const child = Bun.spawn([launcher, ...args], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
      const output = await new Response(child.stdout).text();
      expect(await child.exited).toBe(0);
      expect(output).toContain("Usage: tg");
      for (const command of ["start", "stop", "update", "help", "autostartup on", "autostartup off"])
        expect(output).toContain(command);
    }
    for (const args of [["delete"], ["start", "extra"], ["help", "extra"], ["autostartup"], ["autostartup", "yes"], ["autostartup", "on", "extra"]]) {
      const invalid = Bun.spawn([launcher, ...args], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
      const errors = (await new Response(invalid.stderr).text()) + (await new Response(invalid.stdout).text());
      expect(await invalid.exited).toBe(1);
      expect(errors).toContain("Usage: tg");
      expect(errors).not.toContain("No recognized TrackGeek installation");
    }
    const stop = Bun.spawn([launcher, "stop"], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
    const message = (await new Response(stop.stdout).text()) + (await new Response(stop.stderr).text());
    expect(await stop.exited).toBe(1);
    expect(message).toContain(`No recognized TrackGeek installation at ${directory}`);
    for (const enabled of ["on", "off"]) {
      const startup = Bun.spawn([launcher, "autostartup", enabled], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
      const output = (await new Response(startup.stdout).text()) + (await new Response(startup.stderr).text());
      expect(await startup.exited).toBe(1);
      expect(output).toContain(`No recognized TrackGeek installation at ${directory}`);
    }
    const legacyLauncher = join(root, "bun", "bin", "trackgeek");
    await writeFile(legacyLauncher, await readFile(launcher, "utf8"));
    const result = await installCommand(resolve(dirname(fileURLToPath(import.meta.url)), ".."), directory);
    expect(await Bun.file(legacyLauncher).exists()).toBe(false);
    expect(result).toContain("tg help");
    expect(result).toContain("tg autostartup on");
    await writeFile(legacyLauncher, "unrelated launcher");
    await installCommand(resolve(dirname(fileURLToPath(import.meta.url)), ".."), directory);
    expect(await readFile(legacyLauncher, "utf8")).toBe("unrelated launcher");
  } finally {
    if (oldBunInstall === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = oldBunInstall;
    await rm(root, { recursive: true, force: true });
  }
});
