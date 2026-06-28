#requires -Version 7
<#
.SYNOPSIS
    Fair cold/warm scan-time benchmark: FreeFileSync compare-only vs our scanbench.

.DESCRIPTION
    Times a FreeFileSync "compare-only" batch (all sync directions = none, so
    synchronize() is a no-op and the reported time ~= compare/enumeration time)
    against our `scanbench` example, for one or more walker-thread counts, in cold
    and/or warm cache state.

    WHY THE CARE AROUND CACHE STATE:
      Over SMB/NAS the metadata you read is cached in TWO independent places:
        - Windows client OS standby list   -> evicted by RAMMap -Et / EmptyStandbyList
        - NAS server RAM (ZFS ARC etc.)     -> NOT evictable from the client
      So "cold" here means CLIENT-cold / SERVER-warm, which is exactly the real
      post-reboot case. A truly end-to-end cold run needs a NAS reboot/pool reimport.

      The FIRST pass after eviction warms the standby list and poisons later passes,
      so for COLD we evict and run exactly ONE column per sample (never a sweep).

.PARAMETER NasPath
    The remote/NAS root (UNC path), e.g. \\NAS\share\folderA. FFS scans BOTH roots;
    our scanner scans one, so we run scanbench once per root and SUM them to line up
    against the single FFS number.

.PARAMETER LocalPath
    The local root paired with NasPath in the FFS batch.

.PARAMETER FfsBatch
    Path to the compare-only .ffs_batch (see CompareOnly.ffs_batch in this folder;
    GUI-export recommended for canonical 14.9 XML). Optional: omit to skip FFS and
    only profile our scanner.

.PARAMETER Threads
    Walker-thread counts to test (default 4,8,16). 0 = our app's auto default.

.PARAMETER EvictTool
    Path to EmptyStandbyList.exe or RAMMap64.exe. REQUIRED for -Mode Cold/Both.
    Must be run from an ELEVATED shell.

.PARAMETER Mode
    Cold | Warm | Both (default Both).

.PARAMETER Ffs
    Path to FreeFileSync.exe (default C:\Program Files\FreeFileSync\FreeFileSync.exe).

.PARAMETER Csv
    Optional path to also write the result rows as CSV.

.EXAMPLE
    # Elevated pwsh, NAS idle:
    .\Profile-Compare.ps1 -NasPath '\\NAS\share\folderA' -LocalPath 'C:\local\folderA' `
        -FfsBatch .\CompareOnly.ffs_batch -Threads 4,8,16 `
        -EvictTool 'C:\tools\EmptyStandbyList.exe' -Mode Both -Csv .\results.csv
#>
[CmdletBinding()]
param(
    [Parameter(Mandatory)] [string]   $NasPath,
    [Parameter(Mandatory)] [string]   $LocalPath,
    [string]   $FfsBatch,
    [int[]]    $Threads = @(4, 8, 16),
    [string]   $EvictTool,
    [ValidateSet('Cold', 'Warm', 'Both')] [string] $Mode = 'Both',
    [string]   $Ffs = 'C:\Program Files\FreeFileSync\FreeFileSync.exe',
    [string]   $Csv
)

$ErrorActionPreference = 'Stop'
$repoRoot   = Resolve-Path (Join-Path $PSScriptRoot '..' '..')
$srcTauri   = Join-Path $repoRoot 'src-tauri'
$scanbench  = Join-Path $srcTauri 'target\release\examples\scanbench.exe'

function Write-Head($t) { Write-Host "`n=== $t ===" -ForegroundColor Cyan }

# --- prereqs -----------------------------------------------------------------
$wantCold = $Mode -in 'Cold', 'Both'
if ($wantCold) {
    if (-not $EvictTool -or -not (Test-Path $EvictTool)) {
        throw "Mode '$Mode' needs -EvictTool pointing at EmptyStandbyList.exe or RAMMap64.exe (and an ELEVATED shell)."
    }
    $admin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()
             ).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
    if (-not $admin) { throw "Cold eviction requires an ELEVATED (Run as administrator) PowerShell." }
}
if (-not (Test-Path $scanbench)) {
    Write-Head "Building scanbench (one-time)"
    Push-Location $srcTauri
    try { cargo build --release --example scanbench } finally { Pop-Location }
}
if ($FfsBatch -and -not (Test-Path $Ffs))      { throw "FreeFileSync not found at $Ffs (-Ffs to override)." }
if ($FfsBatch -and -not (Test-Path $FfsBatch)) { throw "Batch file not found: $FfsBatch" }

# --- helpers -----------------------------------------------------------------
function Invoke-Evict {
    # One standby-list eviction. RAMMap takes -Et; EmptyStandbyList takes 'standbylist'.
    if ($EvictTool -match 'RAMMap') { & $EvictTool -Et } else { & $EvictTool standbylist }
    Start-Sleep -Milliseconds 250   # let the eviction settle before measuring
}

function Measure-Scan {
    param([string]$Path, [int]$T)
    # Run the prebuilt scanbench for a SINGLE column; parse its own millis/entries
    # (more precise than wrapping cargo, and avoids build/cargo overhead in timing).
    $out = & $scanbench $Path $T 2>&1
    $hdr = ($out | Select-String -SimpleMatch 'entries/s' | Select-Object -First 1)
    $row = $null
    if ($hdr) {
        $after = $out[($out.IndexOf($hdr.Line) + 1)..($out.Count - 1)]
        $row = $after | Where-Object { $_ -match '\S' } | Select-Object -First 1
    }
    if (-not $row) { return [pscustomobject]@{ entries = $null; millis = $null; raw = ($out -join "`n") } }
    $f = ($row -replace '^\s+', '') -split '\s+'
    # columns: threads entries errors skipped millis entries/s
    [pscustomobject]@{ entries = [int64]$f[1]; millis = [double]$f[4]; raw = $row.Trim() }
}

function Measure-Ffs {
    $stdout = $null
    $wall = Measure-Command { $script:stdout = & $Ffs $FfsBatch 2>&1 }
    $exit = $LASTEXITCODE
    $json = $stdout | Where-Object { $_ -match '^\s*\{' } | Select-Object -Last 1
    $totalSec = $null; $items = $null; $result = $null
    if ($json) {
        try { $o = $json | ConvertFrom-Json; $totalSec = $o.totalTimeSec; $items = $o.totalItems; $result = $o.syncResult } catch {}
    }
    [pscustomobject]@{
        wall_ms  = [math]::Round($wall.TotalMilliseconds, 1)
        json_sec = $totalSec    # SECOND granularity — trust wall_ms for small trees
        items    = $items
        result   = $result
        exit     = $exit        # 0 ok / 1 warning / 2 error / 3 cancelled
    }
}

# --- run ----------------------------------------------------------------------
$modes = if ($Mode -eq 'Both') { @('Cold', 'Warm') } else { @($Mode) }
$rows  = [System.Collections.Generic.List[object]]::new()

foreach ($m in $modes) {
    Write-Head "OURS — $m"
    foreach ($t in $Threads) {
        if ($m -eq 'Cold') { Invoke-Evict }
        $nas   = Measure-Scan -Path $NasPath   -T $t
        if ($m -eq 'Cold') { Invoke-Evict }    # evict again so the local root is also client-cold
        $local = Measure-Scan -Path $LocalPath -T $t
        $both  = if ($nas.millis -and $local.millis) { [math]::Round($nas.millis + $local.millis, 1) } else { $null }
        $rows.Add([pscustomobject]@{
            tool = 'ours'; mode = $m; threads = $t
            nas_ms = $nas.millis; local_ms = $local.millis; both_ms = $both
            entries_nas = $nas.entries; entries_local = $local.entries
        })
        "  t={0,-3} nas={1,10:N1}ms ({2} entries)  local={3,10:N1}ms  both={4,10:N1}ms" -f `
            $t, $nas.millis, $nas.entries, $local.millis, $both | Write-Host
    }

    if ($FfsBatch) {
        Write-Head "FFS — $m"
        if ($m -eq 'Cold') { Invoke-Evict }
        $f = Measure-Ffs
        $rows.Add([pscustomobject]@{
            tool = 'ffs'; mode = $m; threads = 'n/a'
            nas_ms = $null; local_ms = $null; both_ms = $f.wall_ms
            entries_nas = $f.items; entries_local = $null
        })
        "  wall={0,10:N1}ms  json={1}s  items={2}  result={3}  exit={4}" -f `
            $f.wall_ms, $f.json_sec, $f.items, $f.result, $f.exit | Write-Host
    }
}

Write-Head "SUMMARY"
$rows | Format-Table -AutoSize tool, mode, threads, nas_ms, local_ms, both_ms, entries_nas
if ($Csv) { $rows | Export-Csv -NoTypeInformation -Path $Csv; Write-Host "Wrote $Csv" -ForegroundColor Green }

Write-Host "`nReminder: FFS reads BOTH roots (compare 'both_ms' against the SUMMED ours both_ms)." -ForegroundColor DarkGray
Write-Host "Reminder: our scanner honors .gitignore; FFS (vanilla) does not. Match the file set or note the divergence." -ForegroundColor DarkGray
