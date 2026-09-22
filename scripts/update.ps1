<#
.SYNOPSIS
Update adventure-call: git pull this checkout, then reinstall the global command.
Accepts the same switches as install.ps1 (-Editable, -NoWeb, -Js, -Python X).
#>
param(
    [switch]$Editable,
    [switch]$NoWeb,
    [switch]$Js,
    [string]$Python
)
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install.ps1') -Pull -Editable:$Editable -NoWeb:$NoWeb -Js:$Js -Python $Python
