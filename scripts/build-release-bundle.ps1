param(
    [string]$Version = "1.0.6",
    [Parameter(Mandatory = $true)]
    [string]$CcxPath,
    [string]$OutputRoot = "release-build"
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$bundleRoot = Join-Path $projectRoot $OutputRoot
$bundleName = "tunan-paint-bridge-v$Version"
$stagingRoot = Join-Path $bundleRoot $bundleName
$photoshopDir = Join-Path $stagingRoot "photoshop"
$comfyDir = Join-Path $stagingRoot "comfyui"
$installDir = Join-Path $stagingRoot "install"
$nodeTempDir = Join-Path $comfyDir "tunan-paint-bridge-nodes"
$nodeZipName = "tunan-paint-bridge-nodes-v$Version.zip"
$bundleZipPath = Join-Path $bundleRoot "$bundleName.zip"

$resolvedCcx = Resolve-Path $CcxPath

if (Test-Path $stagingRoot) {
    Remove-Item -Recurse -Force $stagingRoot
}

if (Test-Path $bundleZipPath) {
    Remove-Item -Force $bundleZipPath
}

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

$ccxFileName = "图南画桥-v$Version.ccx"
Copy-Item -Path $resolvedCcx -Destination (Join-Path $photoshopDir $ccxFileName) -Force

$nodeZipPath = Join-Path $comfyDir $nodeZipName
Compress-Archive -Path (Join-Path $nodeTempDir "*") -DestinationPath $nodeZipPath -Force
Remove-Item -Recurse -Force $nodeTempDir

$installReadme = @"
# 图南画桥安装说明

1. Photoshop 插件：
   双击 photoshop/$ccxFileName 安装 `.ccx`
2. ComfyUI 节点：
   解压 comfyui/$nodeZipName 到 `ComfyUI/custom_nodes/`
3. 如果网站下载页还没上线，请查看 GitHub Releases 获取最新版本说明

官网：
https://tunanart.cn
"@

Set-Content -Path (Join-Path $installDir "README-安装.md") -Value $installReadme -Encoding UTF8

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

Write-Host "[build-release-bundle] Bundle created: $bundleZipPath"
