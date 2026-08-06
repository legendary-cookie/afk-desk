@rem Licensed under the Apache License, Version 2.0.
@if "%DEBUG%"=="" @echo off
setlocal
set DIRNAME=%~dp0
if "%DIRNAME%"=="" set DIRNAME=.
set APP_HOME=%DIRNAME%
set CLASSPATH=%APP_HOME%\gradle\wrapper\gradle-wrapper.jar
@rem Use the Java executable selected by PATH. This workstation's legacy
@rem JAVA_HOME points at Java 8 while Minecraft 1.21 requires Java 21.
java.exe -Dorg.gradle.appname=gradlew -classpath "%CLASSPATH%" org.gradle.wrapper.GradleWrapperMain %*
if errorlevel 1 exit /b 1
endlocal
