# Running Icarus as a Windows service (WinSW)

`setup.ps1` downloads `WinSW.exe` into this folder and installs the service
with `WinSW.exe install icarus.xml` to run under your user account (so it
inherits your Claude Code login). Manual commands once installed:

```powershell
# from the service/ folder
.\WinSW.exe start icarus.xml
.\WinSW.exe status icarus.xml
.\WinSW.exe stop icarus.xml
.\WinSW.exe uninstall icarus.xml
```

The service auto-starts on boot and restarts on failure. Logs roll in this folder.
