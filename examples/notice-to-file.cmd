@echo off
rem An entail notice command on Windows: appends the one line and the link to a file.
rem
rem   entail settings --notice "C:\path\to\entail\examples\notice-to-file.cmd"
rem
rem entail runs the command with the line and the link as its last two
rem arguments, in double quotes: %~1 and %~2. The line says how many questions
rem and calls wait; it never carries the question.
rem Set ENTAIL_NOTICE_FILE to choose the file; %USERPROFILE%\entail-notices.txt otherwise.
setlocal
if not defined ENTAIL_NOTICE_FILE set "ENTAIL_NOTICE_FILE=%USERPROFILE%\entail-notices.txt"
for /f "delims=" %%t in ('powershell -NoProfile -NonInteractive -Command "Get-Date -Format 'yyyy-MM-dd HH:mm'"') do set "NOW=%%t"
>> "%ENTAIL_NOTICE_FILE%" echo %NOW% %~1 %~2
