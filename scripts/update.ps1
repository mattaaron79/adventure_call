<#
.SYNOPSIS
Update adventure-call: git pull this checkout, then reinstall the global command.
Accepts the same switches as install.ps1 (-Editable, -Js, -Python X).
#>
param(
    [switch]$Editable,
    [switch]$Js,
    [string]$Python
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install.ps1') -Pull -Editable:$Editable -Js:$Js -Python $Python
