# TreeMap NTFS MFT elevated broker — long-lived process started by a Scheduled
# Task (/rl highest, logon trigger). Speaks newline-delimited JSON over a
# named pipe so the unprivileged app never needs per-scan UAC.
#
# Protocol (one JSON object per line):
#   {"id":1,"cmd":"ping"}
#   {"id":2,"cmd":"run","exe":"...\\ntfs-mft-scan.exe","args":["--volume","C",...]}
#   {"id":3,"cmd":"shutdown"}
# Responses:
#   {"id":1,"ok":true,"elevated":true}
#   {"id":2,"ok":true,"exitCode":0}
#   {"id":2,"ok":false,"error":"..."}

param(
  [string]$PipeName = 'TreeMapNtfsMftBroker'
)

$ErrorActionPreference = 'Stop'

function Test-IsElevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $p = [Security.Principal.WindowsPrincipal]::new($id)
  return $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

$elevated = Test-IsElevated
Write-Host "[treemap-broker] starting elevated=$elevated pipe=$PipeName pid=$PID"

$logFile = Join-Path $env:TEMP 'treemap-ntfs-mft-broker.log'
function Write-BrokerLog([string]$msg) {
  $line = "$(Get-Date -Format o) $msg"
  Add-Content -LiteralPath $logFile -Value $line -ErrorAction SilentlyContinue
  Write-Host $line
}

$security = [System.IO.Pipes.PipeSecurity]::new()
# Allow the interactive user (both elevated and medium IL tokens share this SID).
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$rule = [System.IO.Pipes.PipeAccessRule]::new(
  $sid,
  [System.IO.Pipes.PipeAccessRights]::ReadWrite -bor [System.IO.Pipes.PipeAccessRights]::CreateNewInstance,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$security.AddAccessRule($rule)

function Send-Json($writer, $obj) {
  $writer.WriteLine(($obj | ConvertTo-Json -Compress -Depth 6))
}

Write-BrokerLog "listening on $PipeName elevated=$elevated"

while ($true) {
  $server = $null
  try {
    $server = [System.IO.Pipes.NamedPipeServerStream]::new(
      $PipeName,
      [System.IO.Pipes.PipeDirection]::InOut,
      1,
      [System.IO.Pipes.PipeTransmissionMode]::Byte,
      [System.IO.Pipes.PipeOptions]::Asynchronous -bor [System.IO.Pipes.PipeOptions]::FirstPipeInstance,
      0, 0, $security
    )
    $server.WaitForConnection()
    Write-BrokerLog "client connected"
    $reader = [IO.StreamReader]::new($server)
    $writer = [IO.StreamWriter]::new($server)
    $writer.AutoFlush = $true
    while ($server.IsConnected) {
      $line = $reader.ReadLine()
      if ($null -eq $line) { break }
      try {
        $req = $line | ConvertFrom-Json
      } catch {
        Send-Json $writer @{ id = $null; ok = $false; error = 'invalid json' }
        continue
      }
      $id = $req.id
      switch ($req.cmd) {
        'ping' {
          Send-Json $writer @{ id = $id; ok = $true; elevated = $elevated }
        }
        'shutdown' {
          Send-Json $writer @{ id = $id; ok = $true }
          Write-BrokerLog "shutdown requested"
          exit 0
        }
        'run' {
          try {
            $exe = [string]$req.exe
            $argList = @($req.args)
            if (-not (Test-Path -LiteralPath $exe)) {
              throw "exe not found: $exe"
            }
            Write-BrokerLog "run $exe $($argList -join ' ')"
            $p = Start-Process -FilePath $exe -ArgumentList $argList -Wait -PassThru -WindowStyle Hidden
            Send-Json $writer @{ id = $id; ok = $true; exitCode = $p.ExitCode }
          } catch {
            Send-Json $writer @{ id = $id; ok = $false; error = $_.Exception.Message }
          }
        }
        default {
          Send-Json $writer @{ id = $id; ok = $false; error = "unknown cmd: $($req.cmd)" }
        }
      }
    }
  } catch {
    Write-BrokerLog "connection error: $($_.Exception.Message)"
    Start-Sleep -Seconds 2
  } finally {
    if ($null -ne $server) {
      try { $server.Dispose() } catch { }
    }
  }
}
