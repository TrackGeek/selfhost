import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { type Manager, validateInstallation } from "./commands";

export interface AutostartupSystem extends Manager {
  platform: string;
  root: boolean;
  home: string;
  username: string;
  uid: number;
  executable: string;
  env: Record<string, string | undefined>;
  available: (command: string[]) => Promise<boolean>;
  exists: (path: string) => Promise<boolean>;
}

function systemdQuote(value: string, command = false) {
  const escaped = value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%");
  return `"${command ? escaped.replaceAll("$", () => "$$") : escaped}"`;
}

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function powershellQuote(value: string) {
  return `'${value.replaceAll("'", "''")}'`;
}

async function linux(enabled: boolean, system: AutostartupSystem) {
  const { directory, run } = system;
  const prefix = system.root ? [] : ["sudo"];
  const unit = "/etc/systemd/system/trackgeek.service";
  if (enabled) {
    const staged = join(directory, ".trackgeek", "startup.service");
    await writeFile(staged, `[Unit]
Description=TrackGeek infrastructure startup
Requires=docker.service
After=network-online.target docker.service
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=oneshot
User=${system.username.replaceAll("%", "%%")}
${system.root ? "" : "SupplementaryGroups=docker\n"}Environment=${systemdQuote(`HOME=${system.home}`)}
Environment=${systemdQuote(`PATH=${system.env.PATH || "/usr/local/bin:/usr/bin:/bin"}`)}
WorkingDirectory=${directory.replaceAll("%", "%%")}
ExecStart=${[system.executable, join(directory, ".trackgeek", "cli.js"), "start"].map((value) => systemdQuote(value, true)).join(" ")}
Restart=on-failure
RestartSec=30
TimeoutStartSec=900

[Install]
WantedBy=multi-user.target
`, { mode: 0o600 });
    await run([...prefix, "install", "-m", "644", staged, unit], directory);
    await run([...prefix, "systemctl", "daemon-reload"], directory);
    await run([...prefix, "systemctl", "enable", "docker.service", "trackgeek.service"], directory);
  } else if (await system.exists(unit)) {
    await run([...prefix, "systemctl", "disable", "--now", "trackgeek.service"], directory);
    await run([...prefix, "rm", "-f", unit], directory);
    await run([...prefix, "systemctl", "daemon-reload"], directory);
  }
}

async function macos(enabled: boolean, system: AutostartupSystem) {
  const label = "com.trackgeek.startup";
  const target = `gui/${system.uid}/${label}`;
  const agents = join(system.home, "Library", "LaunchAgents");
  const path = join(agents, `${label}.plist`);
  if (await system.available(["launchctl", "print", target]))
    await system.run(["launchctl", "bootout", target], system.directory);
  if (!enabled) {
    await rm(path, { force: true });
    return;
  }
  await mkdir(agents, { recursive: true });
  const log = join(system.directory, ".trackgeek", "startup.log");
  await writeFile(path, `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array>${[system.executable, join(system.directory, ".trackgeek", "cli.js"), "start"].map((value) => `<string>${xml(value)}</string>`).join("")}</array>
<key>WorkingDirectory</key><string>${xml(system.directory)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(system.env.PATH || "/usr/local/bin:/usr/bin:/bin")}</string><key>HOME</key><string>${xml(system.home)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ThrottleInterval</key><integer>30</integer>
<key>StandardOutPath</key><string>${xml(log)}</string>
<key>StandardErrorPath</key><string>${xml(log)}</string>
</dict></plist>
`, { mode: 0o600 });
  await system.run(["launchctl", "enable", target], system.directory);
}

async function windows(enabled: boolean, system: AutostartupSystem) {
  const identity = "$identity = [Security.Principal.WindowsIdentity]::GetCurrent(); $user = $identity.Name; $name = 'TrackGeekStartup-' + $identity.User.Value;";
  const script = enabled
    ? `${identity}
$action = New-ScheduledTaskAction -Execute ${powershellQuote(system.executable)} -Argument ${powershellQuote(`"${join(system.directory, ".trackgeek", "cli.js")}" start`)} -WorkingDirectory ${powershellQuote(system.directory)};
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user;
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited;
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Minutes 15);
Register-ScheduledTask -TaskName $name -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null;`
    : `${identity}
if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $name;
  Unregister-ScheduledTask -TaskName $name -Confirm:$false;
}`;
  await system.run(["powershell", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; ${script}`], system.directory);
}

export async function configureAutostartup(enabled: boolean, system: AutostartupSystem) {
  await validateInstallation(system.directory);
  if (!["linux", "darwin", "win32"].includes(system.platform)) throw new Error("Unsupported operating system.");
  for (const value of [system.directory, system.executable, system.home, system.username, system.env.PATH || ""])
    if (/[\r\n\0]/.test(value)) throw new Error("Autostartup paths and environment must use a single line.");
  if (system.platform === "linux" && (!(await system.exists("/run/systemd/system")) ||
      !(await system.available(["systemctl", "cat", "docker.service"]))))
    throw new Error("Autostartup on Linux requires systemd and a system Docker Engine service (docker.service).");

  const docker = await system.docker(true);
  await system.run([...docker, "compose", "config", "--quiet"], system.directory);
  const containers = await system.capture([...docker, "compose", "ps", "--all", "--quiet", "postgres", "redis", "api", "web"], system.directory);
  if (containers.trim())
    await system.run([...docker, "update", "--restart", "on-failure", ...containers.trim().split(/\s+/)], system.directory);
  await mkdir(join(system.directory, ".trackgeek"), { recursive: true, mode: 0o700 });
  if (system.platform === "linux") await linux(enabled, system);
  else if (system.platform === "darwin") await macos(enabled, system);
  else await windows(enabled, system);
  system.log(enabled
    ? `Autostartup enabled. TrackGeek will start ${system.platform === "linux" ? "at boot" : "when you log in"}.`
    : "Autostartup disabled. Running services are unchanged; Docker and unrelated startup settings are preserved.");
}
