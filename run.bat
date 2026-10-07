@echo off
cd /d "%~dp0"
python child_tasks.py %*
pause
