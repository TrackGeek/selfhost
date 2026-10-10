<p align="center">
  <img src="https://github.com/TrackGeek.png" height="100px">
</p>

<h1 align="center">
  <samp>Web</samp>
</h1>

<h4 align="center">
  <samp>Unified platform for tracking games, movies, series, anime, manga, and books — all in one place.</samp>
</h4>

<p align="center">
  <img src="https://img.shields.io/badge/Shell-99e3a0?style=for-the-badge&logo=shell&logoColor=004b38">
  <img src="https://img.shields.io/badge/TypeScript-99e3a0?style=for-the-badge&logo=typescript&logoColor=004b38">
  <img src="https://img.shields.io/badge/Docker-99e3a0?style=for-the-badge&logo=docker&logoColor=004b38">
</p>

## <samp>About</samp>

<samp>

Interactive installer and management CLI for Linux, macOS and Windows. Clones the `main` branches of [TrackGeek/web](https://github.com/TrackGeek/web) and [TrackGeek/api](https://github.com/TrackGeek/api), builds production images, starts PostgreSQL and Redis, deploys Prisma migrations and seeds the database. Installs `trackgeek start`, `trackgeek stop` and `trackgeek update`.

</samp>

## <samp>Install</samp>

<samp>

Run in an interactive terminal. The installer sets up missing Docker automatically, starts it and waits until it is ready before continuing. Linux uses the official Docker installer and starts the service; macOS and Windows download and install Docker Desktop directly, without requiring Homebrew or winget for Docker. Administrator password prompts and Docker Desktop setup dialogs may appear. Windows may require WSL setup, virtualization support and a restart; if requested, restart and run the same command again. Docker Desktop installation accepts its subscription agreement using the official installer flag. See the official [Linux](https://docs.docker.com/engine/install/), [macOS](https://docs.docker.com/desktop/setup/install/mac-install/) and [Windows](https://docs.docker.com/desktop/setup/install/windows-install/) instructions for supported systems.

Internet access and enough disk space/RAM to build both applications are required. Bun is installed by the bootstrap when missing; Git is installed using supported system package managers. Linux needs `curl` and `unzip`. Docker Compose 2.30+ and Linux containers are required and checked automatically. Native Windows uses PowerShell, not `install.sh`.

Linux / macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/TrackGeek/selfhost/main/install.sh -o /tmp/trackgeek-install.sh && bash /tmp/trackgeek-install.sh
```

Windows PowerShell:

```powershell
$script = Join-Path $env:TEMP "trackgeek-install.ps1"; Invoke-WebRequest https://raw.githubusercontent.com/TrackGeek/selfhost/main/install.ps1 -OutFile $script; & $script
```

From a local checkout:

```sh
bash install.sh
```

```powershell
.\install.ps1
```

</samp>

## <samp>Project structure</samp>

```text
selfhost/
├── src/
│   ├── installer.ts
│   ├── cli.ts
│   ├── config/
│   │   └── env.ts
│   ├── docker/
│   │   ├── setup.ts
│   │   └── runtime.ts
│   ├── management/
│   │   ├── commands.ts
│   │   └── install.ts
│   └── system/
│       ├── filesystem.ts
│       ├── git.ts
│       └── process.ts
├── tests/
├── templates/
├── install.sh
└── install.ps1
```

`installer.ts` coordinates the installation wizard; `cli.ts` dispatches management commands. Configuration parsing and validation live in `config/`. Docker installation/startup lives in `docker/`. Service lifecycle and CLI registration live in `management/`. Shared filesystem, process and Git PATH helpers live in `system/`. Tests and deployment templates have their own directories. The root bootstrap scripts support both local checkouts and remote downloads of this layout.

Use `bun run start` for the wizard, `bun test` for validation and `bun run types` for TypeScript checks.

## <samp>Configuration</samp>

<samp>

The wizard asks for installation directory, ports, public browser URLs, network binding and API credentials. It writes `<install-dir>/.env`, `api/.env`, `web/.env` and `.trackgeek.json`. Passwords and the Better Auth secret are generated cryptographically. Existing secrets and volumes are retained when rerunning. Clones are reused without automatically updating or resetting code. Keep the installation directory private; Unix configuration files use mode `0600`. Windows inherits filesystem permissions, so restrict its ACL to your account.

The wizard requires `IMGBB_API_KEY`, `HARDCOVER_API_KEY`, `TMDB_API_KEY`, `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` for image uploads and media lookup. Empty or whitespace-only credentials are rejected. `RESEND_API_KEY` and `RESEND_FROM` remain required; configure the sender using a verified Resend domain.

OAuth client IDs/secrets and `DISCORD_BOT_TOKEN` are optional and can be configured individually in the wizard. Empty optional integrations leave their corresponding features unavailable. No OAuth applications or external service accounts are created automatically.

Stripe is optional and disabled by default for new installations: declining it clears `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Without a secret key, the API starts normally, prices/perks are empty, and checkout/webhook requests return `503 STRIPE_NOT_CONFIGURED`. Enabling webhooks also requires a webhook secret. Dataxamas is optional: declining it leaves `VITE_DATAXAMAS_API_KEY` empty and disables browser/server tracking.

New installations use web port `2026` (`http://localhost:2026`) and API port `408` (`http://localhost:408`). The wizard displays these settings; press Enter to accept them or choose No to customize ports, public URLs and network access. Existing installations keep their saved settings. Changing a local port also updates its suggested localhost URL. API and web must have distinct ports. PostgreSQL and Redis are accessible only inside the Compose network. The default binds web/API to `127.0.0.1`. For access from another device, set URLs to a hostname/IP that its browser can reach and select network access. For public hosting, configure a reverse proxy, DNS, TLS and firewall yourself. The installer does not provision domains or HTTPS. Passkeys require HTTPS except on localhost.

The production seed inserts the API's reference data (medals and missions); it does not create demo users with shared passwords or a media catalogue. Create your account through the web interface. The seed runs after migrations and before the API starts; healthchecks gate service startup.

</samp>

## <samp>Manage</samp>

<samp>

The installer saves a standalone Bun CLI in `<install-dir>/.trackgeek/` and registers a `trackgeek` command for your user. It works from any directory and manages the installation selected in the wizard. Linux/macOS launchers live in `${BUN_INSTALL:-~/.bun}/bin`; Windows uses `%LOCALAPPDATA%\TrackGeek\bin` and adds it to your user PATH. Open a new terminal after installing. If the command is unavailable on Linux/macOS, add the launcher directory to PATH using the command shown by the installer. When installing multiple directories, the latest installation becomes the target of the user command. Existing installations gain the command by rerunning the installer.

```sh
trackgeek start
trackgeek stop
trackgeek update
trackgeek --help
```

`start` starts Docker automatically when needed, then starts the Compose services and waits for healthy API/web containers. `stop` stops only API and web; Docker, PostgreSQL, Redis and their volumes stay running. If Docker is already stopped, `stop` does not start or install it. Linux requests administrator access when required.

`update` fetches both GitHub `main` branches and advances the API/web clones using fast-forward merges. Both repositories must be on `main`, have the expected TrackGeek origin and have no local changes, untracked files or local commits. Ignored configuration files such as `.env` are retained. Both repositories are checked before either checkout is changed. The command builds production images while existing services remain running, then stops API/web, removes the completed initialization container and starts services again. This reruns migrations and the production seed before the API starts. Updates run on command, without a background scheduler; they update API/web source, using the installed Compose/Dockerfile templates. Rerun the installer to refresh the CLI and templates.

If fetching or repository validation fails, checkouts and running services are unchanged. A build failure leaves existing services running with the previous images, while source checkouts may already contain the new commits; fix the build and rerun `trackgeek update`. Migration/startup failures return a nonzero exit code and require checking Compose logs; volumes and configuration remain intact. Database migrations are not automatically rolled back. Newly required configuration variables must be configured by rerunning the wizard before retrying an update.

For logs, status and manual Compose management, run inside the installation directory. Use `sudo docker` instead of `docker` if the installer used administrator access on Linux.

```sh
docker compose ps
docker compose logs -f
docker compose stop
docker compose up -d --wait
```

Rerun the installer to change configuration and rebuild. Web environment values are baked into its build; changing `web/.env` alone does not change the running frontend. The root `.env` supplies web build arguments, while `api/.env` is injected at runtime using Compose's raw format. API-only manual changes need `docker compose up -d --force-recreate api`.

Before running `trackgeek update` or new migrations, back up the database and configuration. Review upstream changes before updating. No automatic destructive database reset or rollback is performed. `docker compose down` retains data volumes; adding `--volumes` permanently deletes them.

```sh
docker compose exec -T postgres pg_dump -U trackgeek -d trackgeek > trackgeek.sql
```

Keep database dumps private. On Windows PowerShell, use a binary-safe output method or run the backup command in a shell that preserves UTF-8 output.

</samp>
