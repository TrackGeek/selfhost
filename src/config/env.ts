import { randomBytes } from "node:crypto";

export const DEFAULT_WEB_PORT = "2026";
export const DEFAULT_API_PORT = "408";

export function publicUrlDefault(url: string | undefined, previousPort: string, port: string) {
  if (!url || url === `http://localhost:${previousPort}`) return `http://localhost:${port}`;
  return url;
}

export function secret() {
  return randomBytes(32).toString("hex");
}

export function templateKeys(source: string) {
  return [...source.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
}

export function rawEnv(values: Record<string, string>) {
  return `${Object.entries(values)
    .map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key) || /[\r\n\0]/.test(value)) {
        throw new Error(`Invalid environment variable: ${key}`);
      }
      return `${key}=${value}`;
    })
    .join("\n")}\n`;
}

export function composeEnv(values: Record<string, string>) {
  rawEnv(values);
  return `${Object.entries(values)
    .map(([key, value]) => `${key}='${value.replaceAll("'", "\\'")}'`)
    .join("\n")}\n`;
}

export function parseRawEnv(source: string): Record<string, string> {
  return Object.fromEntries(
    source.split(/\r?\n/).flatMap((line) => {
      const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
      return match ? [[match[1], match[2]]] : [];
    }),
  );
}

export function validatePort(value = "") {
  return /^\d+$/.test(value) && Number(value) > 0 && Number(value) <= 65535
    ? undefined
    : "Use a port between 1 and 65535.";
}

export function validateUrl(value = "") {
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      url.pathname !== "/"
    ) {
      return "Use an HTTP/HTTPS origin without a path or credentials.";
    }
  } catch {
    return "Invalid URL.";
  }
}
