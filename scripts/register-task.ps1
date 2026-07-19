# Registers Icarus as a Windows Task Scheduler task: starts at logon, restarts if the wrapper dies.
# Run once from an elevated-or-not PowerShell:  powershell -ExecutionPolicy Bypass -File scripts\register-task.ps1
$root = Split-Path -Parent $PSScriptRoot
$action = New-ScheduledTaskAction -Execute (Join-Path $root 'scripts\run-icarus.cmd') -WorkingDirectory $root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet `
  -ExecutionTimeLimit ([TimeSpan]::Zero) `
  -RestartCount 10 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew
Register-ScheduledTask -TaskName 'Icarus' -Action $action -Trigger $trigger -Settings $settings -Force
Write-Host 'Registered. Start now:  schtasks /Run /TN Icarus'
Write-Host 'Stop:                   schtasks /End /TN Icarus'
