@echo off
echo Pushing 888 to GitHub...
echo.

pushd "%~dp0"

echo [1/5] git init...
git init -b main 2>nul || git checkout -b main 2>nul

echo [2/5] Set remote + credential helper...
git remote remove origin 2>nul
git remote add origin https://github.com/eason1288/888.git
git config credential.helper manager-core

echo [3/5] Fetch from GitHub...
git fetch origin main

echo [4/5] Reset + stage index.html...
git reset origin/main
git add index.html

echo [5/5] Commit and push...
git commit -m "v5: 2-pick predictions, remove summary card, enhanced tracker, mobile-first layout"
git push origin main

echo.
echo Done! https://eason1288.github.io/888/
echo.
pause
