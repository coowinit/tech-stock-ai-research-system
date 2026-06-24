@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>nul
if %errorlevel% neq 0 (
  echo 未检测到 Node.js，无法运行自动测试。
  pause
  exit /b 1
)
node tests\stage1-tests.js
if %errorlevel% neq 0 (
  echo.
  echo 测试失败，请查看上方错误。
  pause
  exit /b 1
)
echo.
echo 阶段1自动测试全部通过。
pause
