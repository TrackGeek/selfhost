import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { composeEnv, parseRawEnv, rawEnv, validatePort, validateUrl } from "./config";

test("rejects line injection and invalid browser origins", () => {
  expect(() => rawEnv({ TOKEN: "secret\nINJECTED=value" })).toThrow();
  expect(() => composeEnv({ TOKEN: "secret\0" })).toThrow();
  for (const url of [
    "file:///etc/passwd",
    "https://user:pass@example.com",
    "https://example.com/path",
    "https://example.com/?x=y",
  ]) {
    expect(validateUrl(url)).toBeDefined();
  }
  expect(validateUrl("https://trackgeek.example.com")).toBeUndefined();
  for (const port of ["0", "65536", "3e3", "3000:3000"]) expect(validatePort(port)).toBeDefined();
});

test("Compose preserves credentials literally and gates API on production initialization", async () => {
  const directory = await mkdtemp(join(tmpdir(), "trackgeek-compose-"));
  const credential = "dollar$VALUE # hash 'quote' \"double\" \\slash=equal";
  try {
    await mkdir(join(directory, "api"));
    await mkdir(join(directory, "web"));
    await writeFile(
      join(directory, "compose.yaml"),
      await readFile(new URL("./templates/compose.yaml", import.meta.url)),
    );
    await writeFile(
      join(directory, ".env"),
      composeEnv({
        POSTGRES_PASSWORD: "generated-postgres-secret",
        REDIS_PASSWORD: "generated-redis-secret",
        VITE_API_URL: "http://localhost:40287",
        VITE_SITE_URL: "http://localhost:3000",
        VITE_DATAXAMAS_API_KEY: credential,
      }),
    );
    await writeFile(join(directory, "api", ".env"), rawEnv({ STRIPE_SECRET_KEY: credential, NODE_ENV: "production" }));
    const child = Bun.spawn(["docker", "compose", "config", "--format", "json"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, VITE_DATAXAMAS_API_KEY: undefined },
    });
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    expect(await child.exited, error).toBe(0);
    const config = JSON.parse(output);
    expect(config.services.web.build.args.VITE_DATAXAMAS_API_KEY.replaceAll("$$", "$")).toBe(credential);
    expect(config.services.api.environment.STRIPE_SECRET_KEY.replaceAll("$$", "$")).toBe(credential);
    expect(config.services.init.environment.NODE_ENV).toBe("production");
    expect(config.services.api.depends_on.init.condition).toBe("service_completed_successfully");
    expect(config.services.postgres.ports).toBeUndefined();
    expect(config.services.redis.ports).toBeUndefined();
    expect(parseRawEnv(await readFile(join(directory, "api", ".env"), "utf8")).STRIPE_SECRET_KEY).toBe(credential);
    await writeFile(
      join(directory, ".env"),
      composeEnv({
        POSTGRES_PASSWORD: "generated-postgres-secret",
        REDIS_PASSWORD: "generated-redis-secret",
        VITE_API_URL: "http://localhost:40287",
        VITE_SITE_URL: "http://localhost:3000",
        VITE_DATAXAMAS_API_KEY: "",
      }),
    );
    const optional = Bun.spawn(["docker", "compose", "config", "--quiet"], {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
    });
    const optionalError = await new Response(optional.stderr).text();
    expect(await optional.exited, optionalError).toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
