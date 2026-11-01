param(
    [Parameter(Position=0, Mandatory=$true)]
    [ValidateSet("start", "stop", "status")]
    [string]$Action,

    [Parameter(Position=1)]
    [int]$Count = 0,

    [int]$Talkers = 0,
    [int]$DelayMs = 250
)

$ErrorActionPreference = "Stop"

$BaseDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigFile = Join-Path $BaseDir "config.json"
$PidFile = Join-Path $BaseDir ".mumble-bots-pids.json"
$LogDir = Join-Path $BaseDir "logs"

if (!(Test-Path $ConfigFile)) {
    throw "Missing config.json"
}

$config = Get-Content $ConfigFile -Raw | ConvertFrom-Json

$Server = ""
$ApiBase = [string]$config.connectionUrl
if ([string]::IsNullOrWhiteSpace($ApiBase)) {
    $ApiBase = "https://registrytest.elitepilotslounge.com"
}
$Token = [string]$config.apiToken
$Audio = [string]$config.audioFile
$FfmpegPath = Join-Path $BaseDir "runtime\ffmpeg\ffmpeg.exe"

function Expand-BotRecords($Item) {
    if ($null -eq $Item) {
        return
    }

    if ($Item -is [array]) {
        foreach ($child in $Item) {
            Expand-BotRecords $child
        }
        return
    }

    if ($Item.PSObject.Properties["pid"]) {
        $Item
    }
}

function Read-BotState {
    if (!(Test-Path -LiteralPath $PidFile)) {
        return @()
    }

    $raw = Get-Content -LiteralPath $PidFile -Raw

    if ([string]::IsNullOrWhiteSpace($raw)) {
        return @()
    }

    $data = ConvertFrom-Json -InputObject $raw

    foreach ($bot in @(Expand-BotRecords $data)) {
        $botPid = 0

        if (
            [int]::TryParse([string]$bot.pid, [ref]$botPid) -and
            $botPid -gt 0 -and
            [string]$bot.name -match '^LoadBot-[0-9]+$'
        ) {
            [pscustomobject]@{
                name = [string]$bot.name
                pid = $botPid
                server = [string]$bot.server
            }
        }
    }
}
function Write-BotState($State) {
    @($State) |
        ConvertTo-Json -Depth 5 |
        Set-Content $PidFile -Encoding UTF8
}

function Get-LiveState {
    $live = @()

    foreach ($bot in (Read-BotState)) {
        if (
            Get-Process `
                -Id ([int]$bot.pid) `
                -ErrorAction SilentlyContinue
        ) {
            $live += $bot
        }
    }

    return @($live)
}

if ($Action -eq "stop") {
    $state = @(Read-BotState)
    $stopped = 0
    $remaining = @()

    foreach ($bot in $state) {
        $botPid = [int]$bot.pid

        $process = Get-CimInstance Win32_Process `
            -Filter "ProcessId = $botPid" `
            -ErrorAction Stop

        if (!$process) {
            continue
        }

        if (
            $process.Name -notmatch '^node(\.exe)?$' -or
            [string]$process.CommandLine -notmatch 'connect-one\.js'
        ) {
            $remaining += $bot
            Write-Warning "PID $botPid is not a verified Mumble bot process."
            continue
        }

        try {
            Stop-Process `
                -Id $botPid `
                -Force `
                -ErrorAction Stop

            $deadline = (Get-Date).AddSeconds(5)

            while (
                (Get-Process -Id $botPid -ErrorAction SilentlyContinue) -and
                (Get-Date) -lt $deadline
            ) {
                Start-Sleep -Milliseconds 100
            }

            if (Get-Process -Id $botPid -ErrorAction SilentlyContinue) {
                $remaining += $bot
                Write-Warning "Bot $($bot.name) did not terminate."
            }
            else {
                $stopped++
                Write-Host "Stopped $($bot.name)."
            }
        }
        catch {
            $remaining += $bot
            Write-Warning "Could not stop $($bot.name): $($_.Exception.Message)"
        }
    }

    if ($remaining.Count -gt 0) {
        Write-BotState $remaining
        throw "Some bots are still running. VPS session release cancelled."
    }

    Remove-Item `
        $PidFile `
        -Force `
        -ErrorAction SilentlyContinue


    # LOADTEST STOP LEASE RELEASE
    # Do not release a token until the VPS confirms no capacity is occupied.
    $SessionFile = Join-Path $BaseDir ".mumble-loadtest-session.json"
    $StopApiBase = $ApiBase.TrimEnd("/")

    if (
        (Test-Path -LiteralPath $SessionFile) -and
        $StopApiBase -match '^https://[^/]+$' -and
        ![string]::IsNullOrWhiteSpace($Token)
    ) {
        try {
            $Saved = Get-Content -LiteralPath $SessionFile -Raw |
                ConvertFrom-Json

            $HashInput = [Text.Encoding]::UTF8.GetBytes(
                "$StopApiBase`0$Token"
            )
            $Hasher = [Security.Cryptography.SHA256]::Create()
            try {
                $ExpectedHash = [BitConverter]::ToString(
                    $Hasher.ComputeHash($HashInput)
                ).Replace("-", "")
            }
            finally {
                $Hasher.Dispose()
            }

            if ($Saved.tokenHash -eq $ExpectedHash) {
                $SessionId = ""

                if ($Saved.protectedSession) {
                    $Secure = ConvertTo-SecureString (
                        [string]$Saved.protectedSession
                    )
                    $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR(
                        $Secure
                    )
                    try {
                        $SessionId = [Runtime.InteropServices.Marshal]::PtrToStringBSTR(
                            $Pointer
                        )
                    }
                    finally {
                        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer)
                    }
                }
                elseif ($Saved.sessionId) {
                    $SessionId = [string]$Saved.sessionId
                }

                if ($SessionId -match '^[a-f0-9]{64}$') {
                    $Headers = @{
                        Authorization = "Bearer $Token"
                    }
                    $Body = @{
                        sessionId = $SessionId
                    } | ConvertTo-Json -Compress

                    $Released = $false

                    for ($Attempt = 0; $Attempt -lt 3; $Attempt++) {
                        $Status = Invoke-RestMethod `
                            -Method Post `
                            -Uri "$StopApiBase/internal/mumble-loadtest-session/status" `
                            -Headers $Headers `
                            -ContentType "application/json" `
                            -Body $Body `
                            -TimeoutSec 5

                        if (
                            $Status.success -eq $true -and
                            [int]$Status.activeBots -eq 0 -and
                            [int]$Status.reservedBots -eq 0
                        ) {
                            $Response = Invoke-RestMethod `
                                -Method Post `
                                -Uri "$StopApiBase/internal/mumble-loadtest-session/release" `
                                -Headers $Headers `
                                -ContentType "application/json" `
                                -Body $Body `
                                -TimeoutSec 5

                            if ($Response.success -eq $true) {
                                $Released = $true
                                break
                            }
                        }

                        if ($Attempt -lt 2) {
                            Start-Sleep -Milliseconds 300
                        }
                    }

                    if ($Released) {
                        Remove-Item -LiteralPath $SessionFile -Force
                        Write-Host "VPS token session released."
                    }
                    else {
                        Write-Warning "Bots stopped locally. VPS token remains locked until disconnect reconciliation completes."
                    }
                }
            }
        }
        catch {
            Write-Warning (
                "VPS token release not confirmed: " +
                $_.Exception.Message
            )
        }
    }
    Write-Host "Stopped $stopped bot(s)."
    exit 0
}

if ($Action -eq "status") {
    $live = Get-LiveState
    Write-BotState $live

    Write-Host "Running bots: $($live.Count)"

    foreach ($bot in $live) {
        Write-Host "$($bot.name) PID=$($bot.pid) Server=$($bot.server)"
    }

    exit 0
}

if ($Count -lt 1) {
    throw "Bot count must be at least 1."
}

if ([string]::IsNullOrWhiteSpace($Token)) {
    throw "apiToken missing from config.json"
}

if ($Talkers -lt 0 -or $Talkers -gt $Count) {
    throw "Talkers must be between 0 and Count."
}

$ApiBase = $ApiBase.TrimEnd("/")

if ($Talkers -gt 0) {
    if ([string]::IsNullOrWhiteSpace($Audio)) {
        throw "audioFile missing from config.json"
    }

    $Audio = (Resolve-Path (Join-Path $BaseDir $Audio)).Path
}

$headers = @{
    Authorization = "Bearer $Token"
}

# Session-bound connection details; no shared Murmur secret.
if ($ApiBase -notmatch '^https://[^/]+$') {
    throw "A valid HTTPS connection URL is required."
}

$remoteConfig = Invoke-RestMethod `
    -Method Get `
    -Uri "$ApiBase/internal/mumble-loadtest-session/connection" `
    -Headers $headers

if (
    !$remoteConfig.host `
    -or !$remoteConfig.port `
    -or !($remoteConfig.maxBots -ge 1)
) {
    throw "VPS returned incomplete connection details."
}

$SessionFile = Join-Path $BaseDir ".mumble-loadtest-session.json"

function Protect-LoadtestSession([string]$Value) {
    $Secure = ConvertTo-SecureString $Value -AsPlainText -Force
    return ConvertFrom-SecureString $Secure
}

function Unprotect-LoadtestSession([string]$Value) {
    $Secure = ConvertTo-SecureString $Value
    $Pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)

    try {
        return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($Pointer)
    }
    finally {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($Pointer)
    }
}

function Save-LoadtestSession([string]$TokenHash, [string]$SessionId) {
    $Record = @{
        tokenHash = $TokenHash
        protectedSession = Protect-LoadtestSession $SessionId
    } | ConvertTo-Json -Compress

    Set-Content -LiteralPath $SessionFile -Value $Record -Encoding UTF8
}

$HashInput = [System.Text.Encoding]::UTF8.GetBytes(
    "$ApiBase`0$Token"
)

$TokenHash = ([BitConverter]::ToString((& {
    $Hasher = [System.Security.Cryptography.SHA256]::Create()
    try {
        $Hasher.ComputeHash($HashInput)
    }
    finally {
        $Hasher.Dispose()
    }
})).Replace('-', ''))

# Recover stale local sessions without touching other clients' leases.
$SessionId = $null

function Get-VerifiedLoadtestStatus([string]$Id) {
    return Invoke-RestMethod `
        -Method Post `
        -Uri "$ApiBase/internal/mumble-loadtest-session/status" `
        -Headers $headers `
        -ContentType "application/json" `
        -Body (@{ sessionId = $Id } | ConvertTo-Json -Compress) `
        -TimeoutSec 10 `
        -ErrorAction Stop
}

if (Test-Path -LiteralPath $SessionFile) {
    try {
        $SavedSession = Get-Content -LiteralPath $SessionFile -Raw |
            ConvertFrom-Json

        if ($SavedSession.tokenHash -eq $TokenHash) {
            $Candidate = if ($SavedSession.protectedSession) {
                Unprotect-LoadtestSession ([string]$SavedSession.protectedSession)
            }
            else {
                [string]$SavedSession.sessionId
            }

            if ($Candidate -match '^[a-f0-9]{64}$') {
                try {
                    $Status = Get-VerifiedLoadtestStatus $Candidate

                    if ($Status.success -ne $true) {
                        throw "Saved session rejected"
                    }

                    $SessionId = $Candidate

                    if (!$SavedSession.protectedSession) {
                        Save-LoadtestSession $TokenHash $SessionId
                    }

                    Write-Host "Existing exclusive session verified."
                }
                catch {
                    $HttpStatus = 0

                    if ($_.Exception.Response) {
                        $HttpStatus = [int]$_.Exception.Response.StatusCode
                    }

                    if (
                        $HttpStatus -eq 403 -or
                        $HttpStatus -eq 404 -or
                        $_.Exception.Message -eq "Saved session rejected"
                    ) {
                        Write-Host "Stale session detected. Requesting a new lease."
                        $SessionId = $null
                    }
                    else {
                        throw "Session verification failed: $($_.Exception.Message)"
                    }
                }
            }
        }
    }
    catch {
        if ($_.Exception.Message -like "Session verification failed:*") {
            throw
        }

        Write-Host "Local session is unreadable or no longer valid."
        $SessionId = $null
    }
}

if (!$SessionId) {
    try {
        $Acquired = Invoke-RestMethod `
            -Method Post `
            -Uri "$ApiBase/internal/mumble-loadtest-session/acquire" `
            -Headers $headers `
            -ContentType "application/json" `
            -Body "{}" `
            -TimeoutSec 10 `
            -ErrorAction Stop
    }
    catch {
        $HttpStatus = 0

        if ($_.Exception.Response) {
            $HttpStatus = [int]$_.Exception.Response.StatusCode
        }

        if ($HttpStatus -eq 409) {
            throw "Load-test token is already in use by another session."
        }

        throw "VPS session acquisition failed (HTTP $HttpStatus): $($_.Exception.Message)"
    }

    if (
        $Acquired.success -ne $true -or
        [string]$Acquired.sessionId -notmatch '^[a-f0-9]{64}$'
    ) {
        throw "VPS returned an invalid exclusive session."
    }

    $SessionId = [string]$Acquired.sessionId

    $Status = Get-VerifiedLoadtestStatus $SessionId

    if ($Status.success -ne $true) {
        throw "New VPS session verification failed."
    }

    Save-LoadtestSession $TokenHash $SessionId

    Write-Host "New exclusive session acquired and verified."
}

$Status = Get-VerifiedLoadtestStatus $SessionId

if ($Status.success -ne $true) {
    throw "VPS session verification failed."
}

if ($Count -gt [int]$Status.remainingBots) {
    throw "Maximum allowed bots reached: $($Status.maxBots)"
}

$NodeCandidates = @(
    (Join-Path $BaseDir "runtime\node\node.exe"),
    (Join-Path $BaseDir "runtime\node-v22\node.exe")
)

$SystemNode = Get-Command node.exe -ErrorAction SilentlyContinue
if ($SystemNode) {
    $NodeCandidates += $SystemNode.Source
}

$node = $null

foreach ($Candidate in $NodeCandidates) {
    if (!(Test-Path -LiteralPath $Candidate -PathType Leaf)) {
        continue
    }

    try {
        & $Candidate --version *> $null

        if ($LASTEXITCODE -eq 0) {
            $node = $Candidate
            break
        }
    }
    catch {
        continue
    }
}

if (!$node) {
    throw "Node.js runtime missing. First-launch installation did not complete."
}

$script = Join-Path $BaseDir "connect-one.js"

if (!(Test-Path -LiteralPath $script -PathType Leaf)) {
    throw "Mumble bot script missing: connect-one.js"
}

Write-Host "Bot runtime: $node"
$script = Join-Path $BaseDir "connect-one.js"

New-Item `
    -ItemType Directory `
    -Path $LogDir `
    -Force |
    Out-Null

$state = @(Get-LiveState)

Write-Host "Server: $($remoteConfig.slug)"
Write-Host "Murmur: $($remoteConfig.host):$($remoteConfig.port)"
Write-Host "Starting $Count bot(s); talkers: $Talkers"

# Request all bot credentials in one atomic VPS transaction.
$BatchNames = @(
    for ($i = 1; $i -le $Count; $i++) {
        "LoadBot-{0:D3}" -f ($state.Count + $i)
    }
)

$BatchBody = @{
    sessionId = $SessionId
    names = $BatchNames
} | ConvertTo-Json -Compress -Depth 5

$BatchResponse = Invoke-RestMethod `
    -Method Post `
    -Uri "$ApiBase/internal/mumble-loadtest-session/credentials/batch" `
    -Headers $headers `
    -ContentType "application/json" `
    -Body $BatchBody `
    -TimeoutSec 20 `
    -ErrorAction Stop

$BatchCredentials = @($BatchResponse.credentials)

if (
    $BatchResponse.success -ne $true -or
    $BatchCredentials.Count -ne $Count
) {
    throw "VPS returned an incomplete bot credential batch."
}

for ($i = 1; $i -le $Count; $i++) {
    $nextNumber = $state.Count + 1
    $name = "LoadBot-{0:D3}" -f $nextNumber

    $Credential = $BatchCredentials[$i - 1]

    if (
        !$Credential -or
        $Credential.name -ne $name -or
        [string]::IsNullOrWhiteSpace($Credential.password)
    ) {
        throw "Batch credential mismatch for $name."
    }

    $args = @(
        "--max-old-space-size=64",
        """$script""",
        [string]$remoteConfig.host,
        [string]$remoteConfig.port,
        $name,
        [string]$Credential.password
    )

    if ($i -le $Talkers) {
        $args += """$Audio"""
    }

    $stdout = Join-Path $LogDir "$name.out.log"
    $stderr = Join-Path $LogDir "$name.err.log"

    $env:FFMPEG_PATH = $FfmpegPath

    try {
        $proc = Start-Process `
            -FilePath $node `
            -ArgumentList $args `
            -WorkingDirectory $BaseDir `
            -WindowStyle Hidden `
            -RedirectStandardOutput $stdout `
            -RedirectStandardError $stderr `
            -PassThru

        if (!$proc -or !$proc.Id) {
            throw "No process ID returned for $name."
        }

        $state += [pscustomobject]@{
            name = $name
            pid = $proc.Id
            server = $remoteConfig.slug
        }

        # Record each successful start immediately.
        Write-BotState $state
    }
    catch {
        $launchError = $_

        # Only unused credentials may be cancelled by the VPS.
        # If authentication already occurred, the VPS refuses
        # cancellation and retains authoritative accounting.
        try {
            $CancelBody = @{
                sessionId = $SessionId
                name = $name
            } | ConvertTo-Json -Compress

            Invoke-RestMethod `
                -Method Post `
                -Uri "$ApiBase/internal/mumble-loadtest-session/credential/cancel" `
                -Headers $headers `
                -ContentType "application/json" `
                -Body $CancelBody | Out-Null
        }
        catch {
            Write-Warning "VPS could not confirm credential cancellation for $name."
        }

        throw $launchError
    }

    if ($i -le $Talkers) {
        Write-Host "Started $name [TALKER]"
    } else {
        Write-Host "Started $name [SILENT]"
    }

    if ($i -lt $Count -and $DelayMs -gt 0) {
        Start-Sleep -Milliseconds $DelayMs
    }
}

Write-BotState $state
Write-Host "Launch complete."










