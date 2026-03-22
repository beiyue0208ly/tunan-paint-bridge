param(
    [string]$Version = "1.0.12",
    [Parameter(Mandatory = $true)]
    [string]$CcxPath,
    [string]$OutputRoot = "release-build"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$bundleRoot = Join-Path $projectRoot $OutputRoot
$workRoot = Join-Path $projectRoot "release-work"
$bundleName = "tunan-paint-bridge-v$Version"
$stagingRoot = Join-Path $workRoot $bundleName
$tempRoot = Join-Path $workRoot "_bundle-temp"
$photoshopDir = Join-Path $stagingRoot "photoshop"
$comfyDir = Join-Path $stagingRoot "comfyui"
$installDir = Join-Path $stagingRoot "install"
$nodeTempDir = Join-Path $tempRoot "tunan-paint-bridge-nodes"
$nodeZipTempPath = Join-Path $tempRoot "tunan-paint-bridge-nodes-v$Version.zip"
$nodeZipName = "tunan-paint-bridge-nodes-v$Version.zip"
$finalNodeZipPath = Join-Path $bundleRoot $nodeZipName
$nodeZipPath = Join-Path $comfyDir $nodeZipName
$ccxFileName = "tunan-paint-bridge-v$Version.ccx"
$finalCcxPath = Join-Path $bundleRoot $ccxFileName
$bundleZipPath = Join-Path $bundleRoot "$bundleName.zip"

$resolvedCcx = (Resolve-Path $CcxPath).Path

if (Test-Path $stagingRoot) {
    Remove-Item -Recurse -Force $stagingRoot
}

if (Test-Path $bundleZipPath) {
    Remove-Item -Force $bundleZipPath
}

if (Test-Path $tempRoot) {
    Remove-Item -Recurse -Force $tempRoot
}

New-Item -ItemType Directory -Force -Path $bundleRoot | Out-Null
New-Item -ItemType Directory -Force -Path $workRoot | Out-Null
New-Item -ItemType Directory -Force -Path $photoshopDir | Out-Null
New-Item -ItemType Directory -Force -Path $comfyDir | Out-Null
New-Item -ItemType Directory -Force -Path $installDir | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $nodeTempDir "backend") | Out-Null
New-Item -ItemType Directory -Force -Path (Join-Path $nodeTempDir "web") | Out-Null

$nodeSource = Join-Path $projectRoot "comfyui-nodes"
$nodeRootFiles = @(
    "__init__.py",
    "console_compat.py",
    "install.py",
    "pyproject.toml",
    "README.md",
    "requirements.txt",
    "tunan_backend.py",
    "tunan_bridge_nodes.py",
    "tunan_naming.py",
    "tunan_runtime.py",
    "tunan_tool_nodes.py",
    "TUNAN_PAINT_BRIDGE_SPEC.md"
)

foreach ($file in $nodeRootFiles) {
    Copy-Item -Path (Join-Path $nodeSource $file) -Destination (Join-Path $nodeTempDir $file) -Force
}

Copy-Item -Path (Join-Path $nodeSource "backend\*") -Destination (Join-Path $nodeTempDir "backend") -Recurse -Force
Copy-Item -Path (Join-Path $nodeSource "web\*") -Destination (Join-Path $nodeTempDir "web") -Recurse -Force

if ([System.IO.Path]::GetFullPath($resolvedCcx) -ne [System.IO.Path]::GetFullPath($finalCcxPath)) {
    Copy-Item -Path $resolvedCcx -Destination $finalCcxPath -Force
}

Copy-Item -Path $finalCcxPath -Destination (Join-Path $photoshopDir $ccxFileName) -Force

Compress-Archive -Path (Join-Path $nodeTempDir "*") -DestinationPath $nodeZipTempPath -Force
Copy-Item -Path $nodeZipTempPath -Destination $finalNodeZipPath -Force
Copy-Item -Path $finalNodeZipPath -Destination $nodeZipPath -Force
Remove-Item -Recurse -Force $nodeTempDir
Remove-Item -Force $nodeZipTempPath

Copy-Item -LiteralPath (Join-Path $projectRoot "INSTALL.md") -Destination (Join-Path $installDir "INSTALL.md") -Force

$manifestObject = [ordered]@{
    version = $Version
    photoshop_plugin = [ordered]@{
        version = $Version
        file = "photoshop/$ccxFileName"
    }
    comfyui_node = [ordered]@{
        version = $Version
        file = "comfyui/$nodeZipName"
    }
    compatibility = [ordered]@{
        plugin_requires_node = "$Version"
        node_requires_plugin = "$Version"
    }
    website = "https://tunanart.cn"
}

$manifestJson = $manifestObject | ConvertTo-Json -Depth 6
Set-Content -Path (Join-Path $stagingRoot "release-manifest.json") -Value $manifestJson -Encoding UTF8

Compress-Archive -Path (Join-Path $stagingRoot "*") -DestinationPath $bundleZipPath -Force

if (Test-Path $stagingRoot) {
    Remove-Item -Recurse -Force $stagingRoot
}

if (Test-Path $tempRoot) {
    Remove-Item -Recurse -Force $tempRoot
}

Write-Host "[build-release-bundle] Bundle created: $bundleZipPath"
