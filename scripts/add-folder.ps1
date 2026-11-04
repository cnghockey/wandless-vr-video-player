# Adds a video folder to folders.txt, once. With no -Folder it opens the normal Windows folder window.
# The headset shows the new folder after you reload the page. The server does not need a restart.
param(
  [string]$Folder,
  [string]$List = (Join-Path $PSScriptRoot '..\folders.txt'),
  [switch]$PrintOnly # the control page: show the window, print the folder picked (UTF-8), write nothing
)

if (-not $Folder) {
  Add-Type -AssemblyName System.Windows.Forms
  $dialog = New-Object System.Windows.Forms.FolderBrowserDialog
  $dialog.Description = 'Pick a video folder for Wandless'
  $dialog.ShowNewFolderButton = $false
  # An invisible on-top owner, shown at the screen centre: the folder window opens in front of the browser, not behind it.
  # (Windows does not let a background program take the focus, but it may put its window on top.)
  $owner = New-Object System.Windows.Forms.Form -Property @{
    TopMost = $true; ShowInTaskbar = $false; FormBorderStyle = 'None'; Opacity = 0
    StartPosition = 'CenterScreen'; Size = New-Object System.Drawing.Size(1, 1)
  }
  $owner.Show()
  $picked = $dialog.ShowDialog($owner)
  $owner.Dispose()
  if ($picked -ne [System.Windows.Forms.DialogResult]::OK) {
    if (-not $PrintOnly) { Write-Host 'No folder added.' }
    exit 0
  }
  $Folder = $dialog.SelectedPath
  if ($PrintOnly) {
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    [Console]::Out.Write($Folder)
    exit 0
  }
}

if (-not (Test-Path -LiteralPath $Folder -PathType Container)) {
  Write-Host "Not a folder: $Folder"
  exit 1
}
$existing = @()
if (Test-Path -LiteralPath $List) {
  $existing = @(Get-Content -LiteralPath $List -Encoding UTF8 | ForEach-Object { $_.Trim().Trim('"').TrimEnd('\') })
}
if ($existing -contains $Folder.TrimEnd('\')) {
  Write-Host "Already in the list: $Folder"
  exit 0
}
Add-Content -LiteralPath $List -Value $Folder -Encoding UTF8
Write-Host "Added: $Folder"
Write-Host 'On the headset, reload the Wandless page, then pick the folder in the Folder list.'
