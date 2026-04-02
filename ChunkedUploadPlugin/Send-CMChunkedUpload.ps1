<#
.SYNOPSIS
Uploads files to Content Manager ServiceAPI using resumable chunked transfer.

.DESCRIPTION
Send-CmChunkedUpload uploads a local file in 4 MB chunks (configurable), supports
resume via /Upload/{SessionId}/missing, retries transient chunk failures, and
completes the session with /Upload/{SessionId}/complete.

By default, StageOnly is enabled to match the browser chunker flow: complete
returns staged metadata (RecordFilePath/StagedFilePath) without forcing direct
record write in the same operation.

The function supports:
- Windows Integrated auth (-UseDefaultCredentials)
- Basic auth (-Credential, or -Username with -Password)
- OIDC/OAuth bearer tokens via -AuthHeaderValue "Bearer <access_token>"
- File-signature-based session caching for resume across runs
- One-time automatic fresh-session retry for contiguous complete failures
- Optional cleanup of staged artifacts in StageOnly mode

.PARAMETER BaseUrl
ServiceAPI base URL, for example:
http://server/contentmanager/serviceapi

.PARAMETER FilePath
Path to the local file to upload.

.PARAMETER RecordUri
Target record URI when writing directly to an existing record (non-stage-only).

.PARAMETER RecordTypeUri
Record type URI for creating a new record when non-stage-only and RecordUri is not provided.

.PARAMETER Title
Title used when creating a new record (non-stage-only + RecordTypeUri).
Defaults to the source file name if omitted.

.PARAMETER ChunkSizeBytes
Chunk size in bytes. Defaults to 4 MB.

.PARAMETER AuthHeaderValue
Raw Authorization header value. If omitted and -Credential is supplied, a Basic
header is generated automatically.

.PARAMETER Credential
PSCredential used to build Basic authorization when AuthHeaderValue is not supplied.

.PARAMETER Username
Username for Basic authorization convenience mode. Requires -Password.

.PARAMETER Password
SecureString password paired with -Username.

.PARAMETER UseDefaultCredentials
Uses current Windows credentials for all HTTP requests.

.PARAMETER StageOnly
When false (default), complete writes directly to record content.
When true, complete returns staged metadata and native upload token data.

.PARAMETER NewRevision
Check In option forwarded to upload start request.

.PARAMETER KeepCheckedOut
Check In option forwarded to upload start request.

.PARAMETER Comments
Check In comments forwarded to upload start request.

.PARAMETER CleanupAfterComplete
If set and StageOnly is true, calls /Upload/cleanup after successful complete.

.PARAMETER MaxContiguousRecoveryAttempts
Maximum retries using a fresh session when /complete reports contiguous errors.
Default: 1

.PARAMETER SessionCacheFilePath
Path to JSON file storing file-signature to SessionId mappings.
Defaults to the temp directory.

.EXAMPLE
Send-CmChunkedUpload -BaseUrl "http://server/contentmanager/serviceapi" -FilePath "C:\Temp\large.bin" -UseDefaultCredentials

Stage-only upload (default), with resume cache support.

.EXAMPLE
Send-CmChunkedUpload -BaseUrl "http://server/contentmanager/serviceapi" -FilePath "C:\Temp\large.bin" -UseDefaultCredentials -StageOnly $false -RecordUri 12345

Directly writes uploaded content to an existing record.

.EXAMPLE
Send-CmChunkedUpload -BaseUrl "http://server/contentmanager/serviceapi" -FilePath "C:\Temp\large.bin" -UseDefaultCredentials -StageOnly $false -RecordTypeUri 9876 -Title "Scripted upload"

Creates a new record (non-stage-only) and attaches uploaded content.

.EXAMPLE
# OIDC client credentials flow example (token endpoint + bearer auth header).
$tokenEndpoint = "https://idp.example.com/connect/token"
$clientId = "your-client-id"
$clientSecret = "your-client-secret"
$scope = "cm.serviceapi"

$tokenResponse = Invoke-RestMethod -Method Post -Uri $tokenEndpoint -ContentType "application/x-www-form-urlencoded" -Body @{
        grant_type = "client_credentials"
        client_id = $clientId
        client_secret = $clientSecret
        scope = $scope
}

$accessToken = [string]$tokenResponse.access_token
if ([string]::IsNullOrWhiteSpace($accessToken)) {
        throw "Token endpoint did not return access_token."
}

Send-CmChunkedUpload `
    -BaseUrl "https://cm-host/contentmanager/serviceapi" `
    -FilePath "C:\Temp\large.bin" `
    -AuthHeaderValue "Bearer $accessToken" `
    -StageOnly $true

Requests an access token from an OIDC/OAuth token endpoint and sends it as a
Bearer authorization header for ServiceAPI calls.
#>

function Send-CmChunkedUpload {
    param(
        [Parameter(Mandatory=$true)][string]$BaseUrl,
        [Parameter(Mandatory=$true)][string]$FilePath,
        [Parameter(Mandatory=$false)][long]$RecordUri = 0,
        [Parameter(Mandatory=$false)][long]$RecordTypeUri = 0,
        [Parameter(Mandatory=$false)][string]$Title = "",
        [int]$ChunkSizeBytes = 4MB,
        [string]$AuthHeaderValue = "",
        [System.Management.Automation.PSCredential]$Credential,
        [string]$Username,
        [System.Security.SecureString]$Password,
        [switch]$UseDefaultCredentials,
        [bool]$StageOnly = $false,
        [bool]$NewRevision = $true,
        [bool]$KeepCheckedOut = $false,
        [string]$Comments = "Automated chunk upload",
        [switch]$CleanupAfterComplete,
        [int]$MaxContiguousRecoveryAttempts = 1,
        [string]$SessionCacheFilePath = ""
    )

    if ($null -eq $Credential -and -not [string]::IsNullOrWhiteSpace($Username)) {
        if ($null -eq $Password) {
            throw "When -Username is provided, -Password is also required."
        }

        $Credential = New-Object System.Management.Automation.PSCredential($Username, $Password)
    }

    $fileInfo = Get-Item $FilePath

    if ([string]::IsNullOrWhiteSpace($Title)) {
        $Title = $fileInfo.Name
    }

    if (-not $StageOnly -and $RecordUri -le 0 -and $RecordTypeUri -le 0) {
        throw "You must provide either a valid -RecordUri, OR a valid -RecordTypeUri to create a new record."
    }

    if ([string]::IsNullOrWhiteSpace($AuthHeaderValue) -and $null -ne $Credential) {
        $userPass = "{0}:{1}" -f $Credential.UserName, $Credential.GetNetworkCredential().Password
        $encoded = [Convert]::ToBase64String([System.Text.Encoding]::ASCII.GetBytes($userPass))
        $AuthHeaderValue = "Basic $encoded"
    }

    $headers = @{}
    if (-not [string]::IsNullOrWhiteSpace($AuthHeaderValue)) {
        $headers["Authorization"] = $AuthHeaderValue
    }

    $totalBytes = $fileInfo.Length
    $expectedChunks = [int][Math]::Ceiling($totalBytes / [double]$ChunkSizeBytes)

    if ([string]::IsNullOrWhiteSpace($SessionCacheFilePath)) {
        $SessionCacheFilePath = Join-Path ([System.IO.Path]::GetTempPath()) "cm-chunked-upload-session-cache.json"
    }

    $fileCacheKey = "{0}|{1}|{2}" -f $fileInfo.FullName.ToLowerInvariant(), $fileInfo.Length, $fileInfo.LastWriteTimeUtc.Ticks

    function Invoke-CmApi {
        param(
            [Parameter(Mandatory=$true)][string]$Method,
            [Parameter(Mandatory=$true)][string]$Uri,
            [hashtable]$Headers,
            [string]$ContentType,
            $Body
        )

        $invokeParams = @{
            Method = $Method
            Uri = $Uri
        }

        if ($null -ne $Headers -and $Headers.Count -gt 0) {
            $invokeParams.Headers = $Headers
        }
        if (-not [string]::IsNullOrWhiteSpace($ContentType)) {
            $invokeParams.ContentType = $ContentType
        }
        if ($null -ne $Body) {
            $invokeParams.Body = $Body
        }
        if ($UseDefaultCredentials) {
            $invokeParams.UseDefaultCredentials = $true
        }

        return Invoke-RestMethod @invokeParams
    }

    function Get-SessionCache {
        if (-not (Test-Path $SessionCacheFilePath)) {
            return @{}
        }

        try {
            $raw = Get-Content -Path $SessionCacheFilePath -Raw
            if ([string]::IsNullOrWhiteSpace($raw)) {
                return @{}
            }

            $obj = $raw | ConvertFrom-Json
            $hash = @{}
            if ($obj -ne $null) {
                foreach ($p in $obj.PSObject.Properties) {
                    $hash[$p.Name] = [string]$p.Value
                }
            }
            return $hash
        } catch {
            return @{}
        }
    }

    function Save-SessionCache {
        param([hashtable]$Cache)

        $dir = Split-Path -Parent $SessionCacheFilePath
        if (-not [string]::IsNullOrWhiteSpace($dir)) {
            [System.IO.Directory]::CreateDirectory($dir) | Out-Null
        }

        $json = ($Cache | ConvertTo-Json)
        Set-Content -Path $SessionCacheFilePath -Value $json -Encoding UTF8
    }

    function Remove-SessionCacheEntry {
        param([string]$Key)
        $cache = Get-SessionCache
        if ($cache.ContainsKey($Key)) {
            $cache.Remove($Key)
            Save-SessionCache -Cache $cache
        }
    }

    function Set-SessionCacheEntry {
        param([string]$Key, [string]$SessionId)
        $cache = Get-SessionCache
        $cache[$Key] = $SessionId
        Save-SessionCache -Cache $cache
    }

    function Get-CachedSessionId {
        param([string]$Key)
        $cache = Get-SessionCache
        if ($cache.ContainsKey($Key)) {
            return [string]$cache[$Key]
        }
        return ""
    }

    function Start-UploadSession {
        $startBodyObj = @{
            StageOnly = $StageOnly
            FileName = $fileInfo.Name
            ContentType = "application/octet-stream"
            TotalBytes = $totalBytes
            ExpectedChunkCount = $expectedChunks
            NewRevision = $NewRevision
            KeepCheckedOut = $KeepCheckedOut
            Comments = $Comments
        }

        if ($RecordUri -gt 0) {
            $startBodyObj.RecordUri = $RecordUri
        } elseif (-not $StageOnly) {
            $startBodyObj.RecordTypeUri = $RecordTypeUri
            $startBodyObj.Title = $Title
        }

        $startBody = $startBodyObj | ConvertTo-Json

        Write-Host "[INFO] Starting chunked upload for $($fileInfo.Name) ($totalBytes bytes)"
        $startResponse = Invoke-CmApi -Method "Post" -Uri "$BaseUrl/Upload/start" -Headers $startHeaders -ContentType "application/json" -Body $startBody
        if ([string]::IsNullOrWhiteSpace($startResponse.SessionId)) {
            throw "Failed to start upload session. No SessionId returned."
        }

        return [string]$startResponse.SessionId
    }

    function Get-MissingChunks {
        param([string]$SessionId)
        try {
            $resp = Invoke-CmApi -Method "Get" -Uri "$BaseUrl/Upload/$SessionId/missing" -Headers $headers
            if ($resp -and $resp.MissingChunks) {
                return @($resp.MissingChunks)
            }
            return @()
        } catch {
            Write-Host "[WARN] Could not query /missing endpoint, will upload all chunks."
            return 0..($expectedChunks - 1)
        }
    }

    function Abort-UploadSession {
        param([string]$SessionId)
        try {
            Invoke-CmApi -Method "Delete" -Uri "$BaseUrl/Upload/$SessionId" -Headers $headers | Out-Null
            Write-Host "[WARN] Aborted session $SessionId"
        } catch {
            Write-Host "[WARN] Failed to abort session $SessionId : $_"
        }
    }

    function Upload-MissingChunks {
        param(
            [string]$SessionId,
            [int[]]$MissingChunks
        )

        if ($MissingChunks.Count -eq 0) {
            $MissingChunks = 0..($expectedChunks - 1)
        }

        Write-Host "[INFO] Need to upload $($MissingChunks.Count) chunks out of $expectedChunks."

        $fs = [System.IO.File]::OpenRead($FilePath)
        try {
            $chunkNumber = 0
            $offset = 0L
            $buffer = New-Object byte[] $ChunkSizeBytes

            while (($read = $fs.Read($buffer, 0, $buffer.Length)) -gt 0) {
                if ($MissingChunks -contains $chunkNumber) {
                    $chunkBytes = New-Object byte[] $read
                    [Array]::Copy($buffer, 0, $chunkBytes, 0, $read)
                    $to = $offset + $read - 1
                    $url = "$BaseUrl/Upload/$SessionId/chunk/$chunkNumber"

                    $maxRetries = 3
                    $attempt = 0
                    $sent = $false

                    while (-not $sent -and $attempt -lt $maxRetries) {
                        $attempt++
                        try {
                            Write-Host "[INFO] Uploading chunk $chunkNumber ($read bytes)..."
                            $request = [System.Net.HttpWebRequest]::Create($url)
                            $request.Method = "PUT"
                            $request.ContentType = "application/octet-stream"
                            if ($UseDefaultCredentials) {
                                $request.UseDefaultCredentials = $true
                            }
                            if (-not [string]::IsNullOrWhiteSpace($AuthHeaderValue)) {
                                $request.Headers.Add("Authorization", $AuthHeaderValue)
                            }
                            $request.Headers.Add("Content-Range", "bytes $offset-$to/$totalBytes")
                            $request.ContentLength = $read

                            $reqStream = $request.GetRequestStream()
                            $reqStream.Write($chunkBytes, 0, $read)
                            $reqStream.Close()

                            $response = $request.GetResponse()
                            $response.Close()
                            $sent = $true
                        } catch {
                            if ($attempt -ge $maxRetries) {
                                throw "Chunk $chunkNumber failed after $maxRetries attempts: $_"
                            }
                            $backoff = [math]::Pow(2, $attempt)
                            Write-Host "[WARN] Chunk $chunkNumber attempt $attempt failed. Retrying in $backoff seconds... ($($_))"
                            Start-Sleep -Seconds $backoff
                        }
                    }
                }

                $offset += $read
                $chunkNumber++
            }
        } finally {
            $fs.Dispose()
        }
    }

    # Clone headers and add Accept: application/json for start request
    $startHeaders = @{}
    foreach ($k in $headers.Keys) { $startHeaders[$k] = $headers[$k] }
    $startHeaders["Accept"] = "application/json"

    $sessionId = Get-CachedSessionId -Key $fileCacheKey
    if (-not [string]::IsNullOrWhiteSpace($sessionId)) {
        try {
            Invoke-CmApi -Method "Get" -Uri "$BaseUrl/Upload/$sessionId" -Headers $headers | Out-Null
            Write-Host "[INFO] Resuming cached session $sessionId"
        } catch {
            Write-Host "[WARN] Cached session $sessionId is no longer valid. Starting a fresh session."
            $sessionId = ""
            Remove-SessionCacheEntry -Key $fileCacheKey
        }
    }

    $attempt = 0
    $completeResponse = $null

    while ($true) {
        if ([string]::IsNullOrWhiteSpace($sessionId)) {
            $sessionId = Start-UploadSession
            Set-SessionCacheEntry -Key $fileCacheKey -SessionId $sessionId
            Write-Host "[INFO] SessionId: $sessionId"
        }

        $missingChunks = Get-MissingChunks -SessionId $sessionId
        Upload-MissingChunks -SessionId $sessionId -MissingChunks $missingChunks

        Write-Host "[INFO] Completing upload session $sessionId..."
        try {
            $completeResponse = Invoke-CmApi -Method "Post" -Uri "$BaseUrl/Upload/$sessionId/complete" -Headers $startHeaders -ContentType "application/json" -Body "{}"
            break
        } catch {
            $errorText = "$_"
            $isContiguousError = $errorText -match "not contiguous|contiguous"
            if ($isContiguousError -and $attempt -lt $MaxContiguousRecoveryAttempts) {
                $attempt++
                Write-Host "[WARN] Complete failed with contiguous-session error. Retrying fresh session (attempt $attempt/$MaxContiguousRecoveryAttempts)."
                Abort-UploadSession -SessionId $sessionId
                Remove-SessionCacheEntry -Key $fileCacheKey
                $sessionId = ""
                continue
            }

            throw "Failed to complete upload session $sessionId : $_"
        }
    }
    
    Write-Host "[INFO] Upload completed successfully!"
    if ($completeResponse.RecordUri) {
        Write-Host "[INFO] Record URI: $($completeResponse.RecordUri)"
    }
    Write-Host "[INFO] Assembled File SHA256: $($completeResponse.AssembledSha256)"
    if ($StageOnly) {
        Write-Host "[INFO] Staged file path: $($completeResponse.StagedFilePath)"
        Write-Host "[INFO] Record file token: $($completeResponse.RecordFilePath)"
    }

    Remove-SessionCacheEntry -Key $fileCacheKey

    # Calculate local SHA256 (TRIM Hash equivalent)
    Write-Host "[INFO] Verifying local file SHA256..."
    $stream = [System.IO.File]::OpenRead($FilePath)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $hashBytes = $sha256.ComputeHash($stream)
    $stream.Dispose()
    $sha256.Dispose()
    
    $localSha256 = [System.BitConverter]::ToString($hashBytes).Replace("-", "").ToUpper()
    Write-Host "[INFO] Local File SHA256:     $localSha256"

    if (-not [string]::IsNullOrWhiteSpace($completeResponse.AssembledSha256) -and $localSha256 -eq $completeResponse.AssembledSha256.ToUpper()) {
        Write-Host "[SUCCESS] End-to-end checksum verification PASSED!" -ForegroundColor Green
    } else {
        Write-Host "[ERROR] End-to-end checksum verification FAILED!" -ForegroundColor Red
        throw "Checksum mismatch. Upload may be corrupted."
    }

    if ($CleanupAfterComplete -and $StageOnly) {
        Write-Host "[INFO] CleanupAfterComplete enabled. Calling /Upload/cleanup for session $sessionId..."
        $cleanupBodyObj = @{
            SessionId = $sessionId
            StagedFilePath = $completeResponse.StagedFilePath
            FullUploadedFileName = $completeResponse.FullUploadedFileName
        }
        $cleanupBody = $cleanupBodyObj | ConvertTo-Json

        try {
            $cleanupResp = Invoke-CmApi -Method "Post" -Uri "$BaseUrl/Upload/cleanup" -Headers $startHeaders -ContentType "application/json" -Body $cleanupBody
            Write-Host "[INFO] Cleanup response: SessionDeleted=$($cleanupResp.SessionDeleted) StagedFileDeleted=$($cleanupResp.StagedFileDeleted) NativeUploadFileDeleted=$($cleanupResp.NativeUploadFileDeleted)"
        } catch {
            Write-Host "[WARN] Cleanup call failed: $_"
        }
    }

    return $completeResponse
}
