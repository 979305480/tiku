@echo off
chcp 65001 >nul
setlocal

echo ============================================
echo   题库 TiKu - 一键编译
echo ============================================
echo.

set "CSC=%WINDIR%\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if not exist "%CSC%" set "CSC=%WINDIR%\Microsoft.NET\Framework\v4.0.30319\csc.exe"
if not exist "%CSC%" (
  echo [X] 找不到 C# 编译器 csc.exe
  echo     需要 .NET Framework 4.x（Windows 10/11 默认自带）
  pause
  exit /b 1
)

echo [1/2] 编译器: %CSC%
echo [2/2] 编译 src\launcher.cs ...

"%CSC%" /nologo /target:winexe /codepage:65001 /optimize+ /out:"题库.exe" /r:System.Windows.Forms.dll "src\launcher.cs"

if errorlevel 1 (
  echo.
  echo [X] 编译失败
  pause
  exit /b 1
)

echo.
echo [OK] 已生成 题库.exe
dir /b "题库.exe"
echo.
echo 双击 题库.exe 即可运行。
pause
