# Export ket qua 1 script SQL (khong GO) ra file tab-separated UTF-8, stream tung dong —
# thay cho SSMS grid (dut file 2GB+) va sqlcmd (-W/-y xung dot, cat cot >256 ky tu).
# Dung: powershell -File tools/export-pos.ps1 -Server 172.16.10.11 -User possa -Pass *** -Database POS `
#         -SqlFile Sql/sales-history.sql -OutFile Sql/sales-history.csv -FirstColumn Barcode
param(
  [Parameter(Mandatory)][string]$Server,
  [Parameter(Mandatory)][string]$User,
  [Parameter(Mandatory)][string]$Pass,
  [Parameter(Mandatory)][string]$Database,
  [Parameter(Mandatory)][string]$SqlFile,
  [Parameter(Mandatory)][string]$OutFile,
  # Ten cot dau cua result set can lay — script co the tra them result set chan doan, chi ghi set khop.
  [Parameter(Mandatory)][string]$FirstColumn
)
$ErrorActionPreference = 'Stop'
$inv = [System.Globalization.CultureInfo]::InvariantCulture

$sql = [System.IO.File]::ReadAllText($SqlFile)
$cn = New-Object System.Data.SqlClient.SqlConnection("Server=$Server;Database=$Database;User ID=$User;Password=$Pass")
$cn.Open()
$cmd = $cn.CreateCommand()
$cmd.CommandText = $sql
$cmd.CommandTimeout = 0
$rd = $cmd.ExecuteReader()
$sw = New-Object System.IO.StreamWriter($OutFile, $false, (New-Object System.Text.UTF8Encoding($false)))
$total = 0
try {
  do {
    if ($rd.FieldCount -lt 1 -or $rd.GetName(0) -ne $FirstColumn) { continue } # result set chan doan — bo
    $names = for ($i = 0; $i -lt $rd.FieldCount; $i++) { $rd.GetName($i) }
    $sw.WriteLine(($names -join "`t"))
    while ($rd.Read()) {
      $vals = for ($i = 0; $i -lt $rd.FieldCount; $i++) {
        if ($rd.IsDBNull($i)) { 'NULL' }
        else {
          $v = $rd.GetValue($i)
          if ($v -is [datetime]) { $v.ToString('yyyy-MM-dd', $inv) }
          elseif ($v -is [System.IFormattable]) { $v.ToString($null, $inv) } # so thap phan phai ra dau cham, khong theo culture VN
          else { [string]$v }
        }
      }
      $sw.WriteLine(($vals -join "`t"))
      $total++
      if ($total % 1000000 -eq 0) { Write-Host "... $total dong" }
    }
  } while ($rd.NextResult())
} finally {
  $sw.Close(); $rd.Close(); $cn.Close()
}
Write-Host "Da ghi $total dong vao $OutFile"
if ($total -eq 0) { throw "Khong result set nao co cot dau '$FirstColumn' — kiem tra script/quyen." }
