@echo off
setlocal
cd /d "%~dp0"
set "DIR=%~dp0"
if "%DIR:~-1%"=="\" set "DIR=%DIR:~0,-1%"

if not exist "%DIR%\meter.html" (
  echo.
  echo   meter.html is not in this folder.
  echo   Put this file next to meter.html and run it again.
  echo.
  pause
  exit /b 1
)

echo.
echo   Creating a Meter shortcut on your Desktop...
echo.

powershell -NoProfile -ExecutionPolicy Bypass -Command "$d='%DIR%'; $ws=New-Object -ComObject WScript.Shell; $pf=[Environment]::GetEnvironmentVariable('ProgramFiles'); $px=[Environment]::GetEnvironmentVariable('ProgramFiles(x86)'); $cand=@($pf+'\Microsoft\Edge\Application\msedge.exe',$px+'\Microsoft\Edge\Application\msedge.exe',$pf+'\Google\Chrome\Application\chrome.exe',$px+'\Google\Chrome\Application\chrome.exe'); $b=$cand | Where-Object {Test-Path $_} | Select-Object -First 1; $desk=[Environment]::GetFolderPath('Desktop'); $l=$ws.CreateShortcut($desk+'\Meter.lnk'); if($b){$l.TargetPath=$b; $l.Arguments='--app=file:///'+($d+'\meter.html').Replace('\','/')+' --user-data-dir=' + [Environment]::GetFolderPath('LocalApplicationData') + '\MeterApp'; Write-Output ('  Opens in a clean app window via ' + [System.IO.Path]::GetFileName($b))} else {$l.TargetPath=$d+'\meter.html'; Write-Output '  Opens in your default browser'}; if(Test-Path ($d+'\meter.ico')){$l.IconLocation=$d+'\meter.ico,0'} else {Write-Output '  meter.ico missing - shortcut will use the default icon'}; $l.WorkingDirectory=$d; $l.Description='Meter - hourly earnings timer'; $l.Save(); Write-Output ('  Created: ' + $desk + '\Meter.lnk')"

echo.
echo   Done. Keep meter.html and meter.ico where they are -
echo   the shortcut points at them.
echo.
pause
