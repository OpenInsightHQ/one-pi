@echo off
rem Local dev launcher (Windows). Set your real keys in .env or here before running.
rem Do not commit real API keys.

set "PI_API_KEY=%PI_API_KEY%"
if "%PI_API_KEY%"=="" set PI_API_KEY=dev-local-key

if "%OPENCODE_API_KEY%"=="" (
	echo OPENCODE_API_KEY is not set. Set it in .env or export it before running.
	exit /b 1
)

set "PI_PROVIDER=%PI_PROVIDER%"
if "%PI_PROVIDER%"=="" set PI_PROVIDER=opencode-go
set "PI_MODEL=%PI_MODEL%"
if "%PI_MODEL%"=="" set PI_MODEL=glm-5

npx pi --http --http-port 3000 --provider %PI_PROVIDER% --model %PI_MODEL%
