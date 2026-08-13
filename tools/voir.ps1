# voir.ps1 - capture d'ecran du configurateur, decrite par Gemini (vision).
#
#   .\tools\voir.ps1                          -> capture localhost:5181?preset=club
#   .\tools\voir.ps1 -Url "http://localhost:5181" -Prompt "..." -W 1920 -H 1080
#
# Le modele deepseek-v4-pro ne lit pas les images : ce script fait le pont.
# Il prend une capture headless (Edge/Chrome), l'envoie a Gemini qui la decrit
# en texte, et affiche la description. ASCII pur : PowerShell 5.1 lit en ANSI.
param(
    [string]$Url = "http://localhost:5181?preset=club",
    [string]$Prompt = "Decris en francais, de facon factuelle et breve, cette capture d'un configurateur 3D. Indique : 1) la geometrie visible (sol, murs, structures, machines, luminaires), 2) les materiaux et textures apparents, 3) l'eclairage (zones claires/sombres, presence de neons ou faisceaux), 4) tout defaut evident (noir complet, objet manquant, flottement, superposition, texture absente). Termine par une liste a puces de 6 defauts ou points a corriger MAXIMUM, sans commentaires superflus.",
    [int]$W = 1600,
    [int]$H = 1000,
    [string]$Shot = "",
    [string]$Model = ""
)

# --- navigateur headless ------------------------------------------------
$edge = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if (-not (Test-Path -LiteralPath $edge)) {
    $edge = "C:\Program Files\Microsoft\Edge\Application\msedge.exe"
}
if (-not (Test-Path -LiteralPath $edge)) {
    $edge = "C:\Program Files\Google\Chrome\Application\chrome.exe"
}
if (-not (Test-Path -LiteralPath $edge)) {
    Write-Host "ECHEC : ni Edge ni Chrome trouves." -ForegroundColor Red
    exit 3
}

if (-not $Shot) {
    $Shot = Join-Path $env:TEMP ("config-" + [DateTime]::Now.ToString("HHmmss") + ".png")
}

# user-data-dir isole : sinon headless refuse si une instance tourne deja
$prof = Join-Path $env:TEMP ("edge-profil-" + [guid]::NewGuid().ToString("N"))
$errLog = Join-Path $env:TEMP "edge-err.log"
$outLog = Join-Path $env:TEMP "edge-out.log"
$args = @(
    '--headless', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    "--user-data-dir=$prof",
    "--window-size=$W,$H",
    '--virtual-time-budget=12000',
    '--timeout=20000',
    "--screenshot=$Shot",
    $Url
)
try {
    Start-Process -FilePath $edge -ArgumentList $args -Wait `
        -WindowStyle Hidden -RedirectStandardError $errLog -RedirectStandardOutput $outLog
} finally {
    if (Test-Path $prof) { Remove-Item -LiteralPath $prof -Recurse -Force -ErrorAction SilentlyContinue }
}

if (-not (Test-Path -LiteralPath $Shot)) {
    Write-Host "ECHEC : capture introuvable ($Shot). Le serveur tourne-t-il sur le bon port ?" -ForegroundColor Red
    exit 4
}

# --- envoi a Gemini ------------------------------------------------------
$key = $env:GEMINI_API_KEY
if (-not $key) { $key = [Environment]::GetEnvironmentVariable('GEMINI_API_KEY', 'User') }
if (-not $key) {
    Write-Host "ECHEC : GEMINI_API_KEY introuvable." -ForegroundColor Red
    exit 2
}

$img = [Convert]::ToBase64String([IO.File]::ReadAllBytes($Shot))

$rotation = @('gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-3.1-flash-lite')
if ($Model) { $rotation = @($Model) + ($rotation | Where-Object { $_ -ne $Model }) }

$body = @{
    contents = @(@{
        parts = @(
            @{ text = $Prompt },
            @{ inline_data = @{ mime_type = "image/png"; data = $img } }
        )
    })
} | ConvertTo-Json -Depth 10 -Compress
$bytes = [Text.Encoding]::UTF8.GetBytes($body)

$used = $null; $r = $null
foreach ($m in $rotation) {
    $uri = "https://generativelanguage.googleapis.com/v1beta/models/$m" + ":generateContent"
    try {
        $r = Invoke-RestMethod -Uri $uri -Method Post -ErrorAction Stop `
            -Headers @{ 'x-goog-api-key' = $key; 'Content-Type' = 'application/json' } `
            -Body $bytes
        $used = $m
        break
    }
    catch {
        $code = $_.Exception.Response.StatusCode.value__
        if ($code -eq 429) {
            Write-Host "[$m sature - bascule]" -ForegroundColor DarkGray
            continue
        }
        Write-Host "ECHEC API ($code) sur $m." -ForegroundColor Red
        if ($_.ErrorDetails.Message) {
            Write-Host ($_.ErrorDetails.Message.Substring(0, [Math]::Min(400, $_.ErrorDetails.Message.Length))) -ForegroundColor DarkGray
        }
        exit 5
    }
}
if (-not $r) {
    Write-Host "QUOTA EPUISE sur tous les modeles." -ForegroundColor Yellow
    exit 5
}

$answer = ($r.candidates[0].content.parts | Where-Object { $_.text } | ForEach-Object { $_.text }) -join "`n"
Write-Host ""
Write-Host $answer
Write-Host ""
Write-Host "[capture: $Shot | modele: $used]" -ForegroundColor DarkGray
exit 0
