export async function run(command: string[], cwd: string, quiet = false, allowedExitCodes = [0]) {
  const child = Bun.spawn(command, {
    cwd,
    stdin: "inherit",
    stdout: quiet ? "ignore" : "inherit",
    stderr: quiet ? "ignore" : "inherit",
    ...(quiet ? { timeout: 10000 } : {}),
  });
  const code = await child.exited;
  if (!allowedExitCodes.includes(code))
    throw new Error(`${command.slice(0, 3).join(" ")} exited with code ${code}.`);
  return code;
}

export async function capture(command: string[], cwd: string) {
  const child = Bun.spawn(command, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0) throw new Error(`${command.slice(0, 3).join(" ")} failed: ${stderr.trim()}`);
  return stdout.trim();
}

export async function available(command: string[], cwd: string) {
  try {
    await run(command, cwd, true);
    return true;
  } catch {
    return false;
  }
}

