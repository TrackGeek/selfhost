import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
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
    const launcher = join(root, "bun", "bin", "trackgeek");
    const child = Bun.spawn([launcher, "--help"], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
    const output = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    expect(output).toContain("trackgeek <start|stop|update>");
    const invalid = Bun.spawn([launcher, "delete"], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
    const errors = (await new Response(invalid.stderr).text()) + (await new Response(invalid.stdout).text());
    expect(await invalid.exited).toBe(1);
    expect(errors).toContain("Usage: trackgeek");
    const stop = Bun.spawn([launcher, "stop"], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe" });
    const message = (await new Response(stop.stdout).text()) + (await new Response(stop.stderr).text());
    expect(await stop.exited).toBe(1);
    expect(message).toContain(`No recognized TrackGeek installation at ${directory}`);
  } finally {
    if (oldBunInstall === undefined) delete process.env.BUN_INSTALL;
    else process.env.BUN_INSTALL = oldBunInstall;
    await rm(root, { recursive: true, force: true });
  }
});
