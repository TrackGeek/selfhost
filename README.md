# TrackGeek Self-host

Interactive installer for Linux, macOS and Windows. Clones [TrackGeek/web](https://github.com/TrackGeek/web) and [TrackGeek/api](https://github.com/TrackGeek/api), builds production images, starts PostgreSQL and Redis, deploys Prisma migrations and seeds the database.

## Install

Run in an interactive terminal. Internet access and enough disk space/RAM to build both applications are required. Git and Docker Compose 2.30+ are required; the wizard offers installation using supported system package managers. Bun is installed by the bootstrap when missing. Linux needs `curl` and `unzip`; macOS automatic Docker installation needs Homebrew. Docker Desktop on Windows requires its Linux container backend and may need a reboot. Native Windows uses PowerShell, not `install.sh`.

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

## Configuration

The wizard asks for installation directory, ports, public browser URLs, network binding and API credentials. It writes `<install-dir>/.env`, `api/.env`, `web/.env` and `.trackgeek.json`. Passwords and the Better Auth secret are generated cryptographically. Existing secrets and volumes are retained when rerunning. Clones are reused without automatically updating or resetting code. Keep the installation directory private; Unix configuration files use mode `0600`. Windows inherits filesystem permissions, so restrict its ACL to your account.

The wizard requires `IMGBB_API_KEY`, `HARDCOVER_API_KEY`, `TMDB_API_KEY`, `IGDB_CLIENT_ID` and `IGDB_CLIENT_SECRET` for image uploads and media lookup. Empty or whitespace-only credentials are rejected. `RESEND_API_KEY` and `RESEND_FROM` remain required; configure the sender using a verified Resend domain.

OAuth client IDs/secrets and `DISCORD_BOT_TOKEN` are optional and can be configured individually in the wizard. Empty optional integrations leave their corresponding features unavailable. No OAuth applications or external service accounts are created automatically.

Stripe is optional and disabled by default for new installations: declining it clears `STRIPE_SECRET_KEY` and `STRIPE_WEBHOOK_SECRET`. Without a secret key, the API starts normally, prices/perks are empty, and checkout/webhook requests return `503 STRIPE_NOT_CONFIGURED`. Enabling webhooks also requires a webhook secret. Dataxamas is optional: declining it leaves `VITE_DATAXAMAS_API_KEY` empty and disables browser/server tracking.

Default URLs are `http://localhost:3000` and `http://localhost:40287`. API and web must have distinct ports. PostgreSQL and Redis are accessible only inside the Compose network. The default binds web/API to `127.0.0.1`. For access from another device, set URLs to a hostname/IP that its browser can reach and select network access. For public hosting, configure a reverse proxy, DNS, TLS and firewall yourself. The installer does not provision domains or HTTPS. Passkeys require HTTPS except on localhost.

The production seed inserts the API's reference data (medals and missions); it does not create demo users with shared passwords or a media catalogue. Create your account through the web interface. The seed runs after migrations and before the API starts; healthchecks gate service startup.

## Manage

Run inside the installation directory. Use `sudo docker` instead of `docker` if selected during installation.

```sh
docker compose ps
docker compose logs -f
docker compose stop
docker compose up -d --wait
```

Rerun the installer to change configuration and rebuild. Web environment values are baked into its build; changing `web/.env` alone does not change the running frontend. The root `.env` supplies web build arguments, while `api/.env` is injected at runtime using Compose's raw format. API-only manual changes need `docker compose up -d --force-recreate api`.

Before updating source or running new migrations, back up the database and configuration. To update, review upstream changes and advance the existing `api`/`web` Git checkouts, then rerun the installer. No automatic destructive database reset or rollback is performed. `docker compose down` retains data volumes; adding `--volumes` permanently deletes them.

```sh
docker compose exec -T postgres pg_dump -U trackgeek -d trackgeek > trackgeek.sql
```

Keep database dumps private. On Windows PowerShell, use a binary-safe output method or run the backup command in a shell that preserves UTF-8 output.
