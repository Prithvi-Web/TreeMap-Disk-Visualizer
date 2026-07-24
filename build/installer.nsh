!include LogicLib.nsh

; Register / unregister the elevated NTFS MFT broker Scheduled Task.
; Task runs at logon with highest privileges; the app talks to it over a
; named pipe (see scripts/ntfsMftBroker.ps1).

!macro customInstall
  DetailPrint "Registering TreeMap NTFS MFT broker Scheduled Task…"
  nsExec::ExecToLog 'schtasks /create /tn "TreeMapNtfsMftBroker" /tr "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File $\"$INSTDIR\\resources\\scripts\\ntfsMftBroker.ps1$\"" /sc onlogon /rl highest /f'
!macroend

!macro customUnInstall
  DetailPrint "Removing TreeMap NTFS MFT broker Scheduled Task…"
  nsExec::ExecToLog 'schtasks /delete /tn "TreeMapNtfsMftBroker" /f'
!macroend
