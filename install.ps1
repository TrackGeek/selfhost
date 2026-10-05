$ErrorActionPreference = "Stop"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) {
  $bunPath = Join-Path $env:USERPROFILE ".bun\bin\bun.exe"
  if (-not (Test-Path $bunPath)) {
    $bunScript = Join-Path ([System.IO.Path]::GetTempPath()) ([System.IO.Path]::GetRandomFileName() + ".ps1")
    try {
      Invoke-WebRequest "https://bun.sh/install.ps1" -OutFile $bunScript
      & powershell -NoProfile -ExecutionPolicy Bypass -File $bunScript
      if ($LASTEXITCODE -ne 0) { throw "Bun installation failed." }
    } finally {
      Remove-Item $bunScript -Force -ErrorAction SilentlyContinue
    }
  }
  $env:Path = "$(Join-Path $env:USERPROFILE '.bun\bin');$env:Path"
}

$gitDirectory = Join-Path $env:ProgramFiles "Git\cmd"
if (Test-Path $gitDirectory) { $env:Path = "$gitDirectory;$env:Path" }
$dockerDirectory = Join-Path $env:ProgramFiles "Docker\Docker\resources\bin"
if (Test-Path $dockerDirectory) { $env:Path = "$dockerDirectory;$env:Path" }

$bundle = $null
try {
  if ($PSScriptRoot -and (Test-Path (Join-Path $PSScriptRoot "installer.ts"))) {
    $bundleDirectory = $PSScriptRoot
  } else {
    $bundle = Join-Path ([System.IO.Path]::GetTempPath()) ("trackgeek-" + [System.IO.Path]::GetRandomFileName())
    $bundleDirectory = $bundle
    New-Item -ItemType Directory -Path (Join-Path $bundle "templates") -Force | Out-Null
    $base = if ($env:TRACKGEEK_INSTALL_BASE_URL) { $env:TRACKGEEK_INSTALL_BASE_URL.TrimEnd('/') } else { "https://raw.githubusercontent.com/TrackGeek/selfhost/main" }
    foreach ($file in @("package.json", "bun.lock", "installer.ts", "config.ts", "templates/compose.yaml", "templates/Dockerfile.api", "templates/Dockerfile.web")) {
      Invoke-WebRequest "$base/$file" -OutFile (Join-Path $bundle $file)
    }
  }
  Push-Location $bundleDirectory
  try {
    & bun install --frozen-lockfile --production
    if ($LASTEXITCODE -ne 0) { throw "Installer dependencies failed." }
    & bun run installer.ts
    if ($LASTEXITCODE -ne 0) { throw "TrackGeek installation failed. Review the message above." }
  } finally {
    Pop-Location
  }
} finally {
  if ($bundle) { Remove-Item $bundle -Recurse -Force -ErrorAction SilentlyContinue }
}
