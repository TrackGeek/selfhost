import { join } from "node:path";

export function addGitPath() {
  if (process.platform !== "win32") return;
  const pathKey = Object.keys(process.env).find((key) => key.toLowerCase() === "path") || "PATH";
  process.env[pathKey] = `${join(process.env.ProgramFiles || "C:\\Program Files", "Git", "cmd")};${process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, "Programs", "Git", "cmd") : ""};${process.env[pathKey] || ""}`;
}
