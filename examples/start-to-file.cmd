@echo off
rem An entail start command on Windows: appends the handoff for each go to a
rem file, one line of JSON per go, for whatever picks up work there.
rem
rem   entail settings --start "C:\path\to\entail\examples\start-to-file.cmd"
rem
rem entail runs it as start-to-file.sh describes, with the handoff as one line
rem of JSON on standard input. Exit 0 once the work is handed off.
rem Set ENTAIL_START_FILE to choose the file; %USERPROFILE%\entail-starts.jsonl otherwise.
setlocal
if not defined ENTAIL_START_FILE set "ENTAIL_START_FILE=%USERPROFILE%\entail-starts.jsonl"
findstr "^" >> "%ENTAIL_START_FILE%"
