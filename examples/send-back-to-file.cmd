@echo off
rem An entail send-back command on Windows: appends the handoff for each PR
rem entail sends back or cancels to a file, one line of JSON each.
rem
rem   entail settings --send-back "C:\path\to\entail\examples\send-back-to-file.cmd"
rem
rem entail runs it as send-back-to-file.sh describes, with the handoff as one
rem line of JSON on standard input. Exit 0 once the work is handed off.
rem Set ENTAIL_SEND_BACK_FILE to choose the file; %USERPROFILE%\entail-send-backs.jsonl otherwise.
setlocal
if not defined ENTAIL_SEND_BACK_FILE set "ENTAIL_SEND_BACK_FILE=%USERPROFILE%\entail-send-backs.jsonl"
findstr "^" >> "%ENTAIL_SEND_BACK_FILE%"
