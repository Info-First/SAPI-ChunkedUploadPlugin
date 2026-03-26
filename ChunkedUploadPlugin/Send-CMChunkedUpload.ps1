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
        [switch]$UseDefaultCredentials
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

    if ($RecordUri -le 0 -and $RecordTypeUri -le 0) {
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

    $startBodyObj = @{
        FileName = $fileInfo.Name
        ContentType = "application/octet-stream"
        TotalBytes = $totalBytes
        ExpectedChunkCount = $expectedChunks
        NewRevision = $true
        KeepCheckedOut = $false
        Comments = "Automated chunk upload"
    }

    if ($RecordUri -gt 0) {
        $startBodyObj.RecordUri = $RecordUri
    } else {
        $startBodyObj.RecordTypeUri = $RecordTypeUri
        $startBodyObj.Title = $Title
    }

    $startBody = $startBodyObj | ConvertTo-Json

    # Clone headers and add Accept: application/json for start request
    $startHeaders = @{}
    foreach ($k in $headers.Keys) { $startHeaders[$k] = $headers[$k] }
    $startHeaders["Accept"] = "application/json"

    Write-Host "[INFO] Starting chunked upload for $($fileInfo.Name) ($totalBytes bytes)"
    $invokeParams = @{
        Method = "Post"
        Uri = "$BaseUrl/UploadChunks/start"
        Headers = $startHeaders
        ContentType = "application/json"
        Body = $startBody
    }
    if ($UseDefaultCredentials) {
        $invokeParams.UseDefaultCredentials = $true
    }
    $startResponse = Invoke-RestMethod @invokeParams
    
    $sessionId = $startResponse.SessionId
    if ([string]::IsNullOrWhiteSpace($sessionId)) {
        throw "Failed to start upload session. No SessionId returned."
    }
    Write-Host "[INFO] SessionId: $sessionId"

    # Query missing chunks
    $missingChunks = @()
    try {
        $missingParams = @{
            Method = "Get"
            Uri = "$BaseUrl/UploadChunks/$sessionId/missing"
            Headers = $headers
        }
        if ($UseDefaultCredentials) {
            $missingParams.UseDefaultCredentials = $true
        }
        $missingResp = Invoke-RestMethod @missingParams
        if ($missingResp -and $missingResp.MissingChunks) {
            $missingChunks = $missingResp.MissingChunks
        }
    } catch {
        Write-Host "[WARN] Could not query /missing endpoint, will upload all chunks."
        $missingChunks = 0..($expectedChunks - 1)
    }

    if ($missingChunks.Count -eq 0) {
        $missingChunks = 0..($expectedChunks - 1)
    }

    Write-Host "[INFO] Need to upload $($missingChunks.Count) chunks out of $expectedChunks."

    $fs = [System.IO.File]::OpenRead($FilePath)
    try {
        $chunkNumber = 0
        $offset = 0L
        $buffer = New-Object byte[] $ChunkSizeBytes

        while (($read = $fs.Read($buffer, 0, $buffer.Length)) -gt 0) {
            if ($missingChunks -contains $chunkNumber) {
                $chunkBytes = New-Object byte[] $read
                [Array]::Copy($buffer, 0, $chunkBytes, 0, $read)
                $to = $offset + $read - 1
                $url = "$BaseUrl/UploadChunks/$sessionId/chunk/$chunkNumber"
                
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

    Write-Host "[INFO] Completing upload session $sessionId..."
    $completeParams = @{
        Method = "Post"
        Uri = "$BaseUrl/UploadChunks/$sessionId/complete"
        Headers = $startHeaders
        ContentType = "application/json"
        Body = "{}"
    }
    if ($UseDefaultCredentials) {
        $completeParams.UseDefaultCredentials = $true
    }
    try {
        $completeResponse = Invoke-RestMethod @completeParams
    } catch {
        throw "Failed to complete upload session $sessionId : $_"
    }
    
    Write-Host "[INFO] Upload completed successfully!"
    Write-Host "[INFO] Record URI: $($completeResponse.RecordUri)"
    Write-Host "[INFO] Assembled File SHA256: $($completeResponse.AssembledSha256)"

    # Calculate local SHA256 (TRIM Hash equivalent)
    Write-Host "[INFO] Verifying local file SHA256..."
    $stream = [System.IO.File]::OpenRead($FilePath)
    $sha256 = [System.Security.Cryptography.SHA256]::Create()
    $hashBytes = $sha256.ComputeHash($stream)
    $stream.Dispose()
    $sha256.Dispose()
    
    $localSha256 = [System.BitConverter]::ToString($hashBytes).Replace("-", "").ToUpper()
    Write-Host "[INFO] Local File SHA256:     $localSha256"

    if ($localSha256 -eq $completeResponse.AssembledSha256.ToUpper()) {
        Write-Host "[SUCCESS] End-to-end checksum verification PASSED!" -ForegroundColor Green
    } else {
        Write-Host "[ERROR] End-to-end checksum verification FAILED!" -ForegroundColor Red
        throw "Checksum mismatch. Upload may be corrupted."
    }

    return $completeResponse
}
