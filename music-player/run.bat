@echo off
cd /d "%~dp0"
REM 使用本机带 tkinter 的完整 Python（默认 E:\Python314；如不同请改此行）
python main.py
if errorlevel 1 pause
