param(
    [Parameter(Mandatory = $true)]
    [string]$ConfigPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if (-not (Test-Path -LiteralPath $ConfigPath)) {
    exit 0
}

$resolvedConfigPath = (Resolve-Path -LiteralPath $ConfigPath).Path
$configDir = Split-Path -Parent $resolvedConfigPath
$raw = Get-Content -LiteralPath $resolvedConfigPath -Raw
if ([string]::IsNullOrWhiteSpace($raw)) {
    exit 0
}

$config = $raw | ConvertFrom-Json

function Emit-Setting {
    param(
        [string]$Name,
        [AllowNull()]
        $Value
    )

    if ($null -eq $Value) {
        return
    }

    $text = [string]$Value
    if ([string]::IsNullOrWhiteSpace($text)) {
        return
    }

    Write-Output ($Name + '=' + $text)
}

if ($config.PSObject.Properties.Name -contains 'sourceAppDir') {
    $sourcePath = [string]$config.sourceAppDir
    if (-not [string]::IsNullOrWhiteSpace($sourcePath)) {
        if ([IO.Path]::IsPathRooted($sourcePath)) {
            Emit-Setting 'SOURCE_APP_DIR' ([IO.Path]::GetFullPath($sourcePath))
        } else {
            Emit-Setting 'SOURCE_APP_DIR' ([IO.Path]::GetFullPath((Join-Path $configDir $sourcePath)))
        }
    }
}

Emit-Setting 'INSTALL_PATH' $config.installPath
Emit-Setting 'SERVICE_NAME' $config.serviceName
Emit-Setting 'SERVICE_DISPLAY_NAME' $config.serviceDisplayName
Emit-Setting 'SERVICE_PORT' $config.servicePort
Emit-Setting 'ENV_FILE' $config.envFile
Emit-Setting 'ENV_EXAMPLE_FILE' $config.envExampleFile
Emit-Setting 'DB_FILE' $config.dbRelativePath
