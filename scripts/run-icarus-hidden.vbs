' Launch the Icarus supervisor loop with no visible console window.
' Wait=True keeps the scheduled task "Running", so IgnoreNew still blocks
' duplicate loops and "schtasks /end" still kills the whole tree.
Dim sh: Set sh = CreateObject("WScript.Shell")
WScript.Quit sh.Run("""C:\Users\jeon\Desktop\icarus\scripts\run-icarus.cmd""", 0, True)
