# Chay tuan tu 2 export (sales -> stock) trong 1 tien trinh doc lap, ghi log de theo doi.
# Dung: powershell -File tools/export-all.ps1 -Server ... -User ... -Pass ...
param(
  [Parameter(Mandatory)][string]$Server,
  [Parameter(Mandatory)][string]$User,
  [Parameter(Mandatory)][string]$Pass,
  [string]$Database = 'POS'
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
$log = Join-Path $root 'Sql\export.log'
Set-Content $log "BAT DAU $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')" -Encoding utf8
try {
  & "$PSScriptRoot\export-pos.ps1" -Server $Server -User $User -Pass $Pass -Database $Database `
    -SqlFile "$root\Sql\sales-history.sql" -OutFile "$root\Sql\sales-history.csv" -FirstColumn Barcode *>> $log
  Add-Content $log "SALES XONG $(Get-Date -Format 'HH:mm:ss')"
  & "$PSScriptRoot\export-pos.ps1" -Server $Server -User $User -Pass $Pass -Database $Database `
    -SqlFile "$root\Sql\stock-history.sql" -OutFile "$root\Sql\stock-history.csv" -FirstColumn ProductCode *>> $log
  Add-Content $log "STOCK XONG $(Get-Date -Format 'HH:mm:ss')"
  Add-Content $log 'HOAN TAT'
} catch {
  Add-Content $log "LOI: $_"
  throw
}
