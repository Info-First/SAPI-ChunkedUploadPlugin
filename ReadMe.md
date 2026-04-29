# Chunked Upload ServiceAPI Plugin

This project adds a custom Content Manager ServiceAPI plugin that supports resumable chunked uploads to a new or existing electronic record.

## What it does

- Starts an upload session for a target record.
- Accepts binary chunks over POST or PUT.
- Stores chunks on disk until the upload is complete.
- Reassembles the file server-side.
- Checks the assembled file into the target Content Manager record.
- Supports upload status queries and upload cancellation.
- Includes a large-file async-attach path in the Web Client script to recover from proxy timeouts on CM save calls.
- Includes runtime debug logging controls for browser-side diagnostics.

## Large-file async-attach behavior

The Web Client integration script now includes a pilot behavior for very large files.

- Async-attach threshold is fixed at 256 MB.
- Files smaller than the threshold continue to use the normal flow.
- Files at or above the threshold are flagged as async candidates.
- If CM native save returns HTTP 504 or 524 after chunk upload has completed, the script:
  - cleans up staged/session artifacts,
  - shows a user-facing timeout recovery message,
  - refreshes the page to clear the stuck spinner.

This flow is designed to improve reliability behind reverse proxies (for example Cloudflare) while preserving current behavior for smaller uploads.

Runtime threshold check in browser console:

```javascript
window.getChunkedUploadLargeFilePilotThresholdMb();
```

### Dynamic concurrency tuning

The Web Client script can derive runtime concurrency from browser upload/performance hints when explicit overrides are not set.

- Concurrency resolution order: explicit override -> persisted user setting -> dynamic cached value -> computed dynamic value -> default (4).
- Dynamic concurrency values are cached in session storage for 30 minutes.
- Dynamic concurrency guardrails: min 1, max 8.
- Performance-only concurrency path is capped at 4 when Network Information API hints are unavailable.

Runtime diagnostics and refresh helpers:

```javascript
window.getChunkedUploadDynamicConcurrencyDiagnostics();
window.refreshChunkedUploadDynamicConcurrency();
window.getChunkedUploadConcurrency();
```

### Async attach operations notes

The async attach flow is now validated for simultaneous jobs and includes operational UI behavior for better visibility.

- Concurrent async attach jobs: validated successfully with multiple large-file saves in flight.
- Server-side concurrency is controlled by `ChunkedUpload.AsyncAttachMaxConcurrency` (default `2`).
- The status badge is shown as a bottom-left floating panel with states:
  - `queued`
  - `in progress`
  - `completed`
  - `failed`
- `completed` auto-dismisses after 5 seconds.
- Dismissing `queued`/`in progress` suppresses repeat transient updates for that upload lifecycle.
- The debug banner is rendered as a bottom-left floating panel so it does not cover bottom-right action buttons.

Recommended tuning guidance:

- Start with `ChunkedUpload.AsyncAttachMaxConcurrency=2`.
- Increase gradually only if CM host CPU/IO headroom and SDK stability are acceptable.
- If failures rise under load, reduce concurrency and review server/plugin logs around `[AsyncAttach]` entries.

## Debug logging

Browser-side debug logging can be enabled at runtime:

```javascript
window.setChunkedUploadVerbose(true);
window.getChunkedUploadVerbose();
```

When enabled, the script writes verbose diagnostics to the browser console and shows a debug banner in the UI.

## Project layout

- ChunkedUploadPlugin.sln
- ChunkedUploadPlugin/ChunkedUploadPlugin.csproj
- ChunkedUploadPlugin/ChunkedUploadService.cs
- ChunkedUploadPlugin/UploadSessionStore.cs
- lib/ReadMe.md

## Required assemblies

Copy the required Content Manager and ServiceStack assemblies into the lib folder before building. See lib/ReadMe.md for the exact list.

## Build

1. Copy the required DLLs into the lib folder.
2. Open ChunkedUploadPlugin.sln in Visual Studio.
3. Build the ChunkedUploadPlugin project.
4. Copy ChunkedUploadPlugin.dll to the Content Manager ServiceAPI bin folder.

## Plugin configuration

Add this to hptrim.config or hprmServiceAPI.config as a child of the hptrim element:

```xml
<pluginAssemblies>
  <add name="ChunkedUploadPlugin" />
</pluginAssemblies>
```

Optional appSettings values:

```xml
<appSettings>
  <add key="ChunkedUpload.TempPath" value="D:\CMUploads\Temp" />
  <add key="ChunkedUpload.SessionExpiryHours" value="24" />
</appSettings>
```

## Endpoints

### 0. End-to-end checksum verification

When the upload is completed, the server calculates the document hash of the fully assembled file (using `TRIM.SDK.Database.CalculateDocumentHash`) and returns it in the response to POST `/ChunkedUpload/{sessionId}/complete` as `AssembledSha256`. 

The client script (`Send-CMChunkedUpload.ps1`) automatically calculates the local file's SHA256 checksum and compares it against this returned value to verify file integrity.

### 1. Resumable Uploads

This plugin supports resumable uploads. If an upload is interrupted, you can resume by querying which chunks are missing and uploading only those. The provided PowerShell script automates this process and supports parallel chunk uploads.

#### Query missing chunks

GET /ChunkedUpload/{sessionId}/missing

Returns a list of missing chunk numbers for the session. Use this to resume interrupted uploads efficiently.

#### Cancel an upload session

POST /ChunkedUpload/{sessionId}/cancel

Cancels and deletes the upload session and all associated data.

### 2. Start a session

POST /ChunkedUpload/start

#### Upload to an existing record
```json
{
  "RecordUri": 9000000001,
  "FileName": "large-document.pdf",
  "ContentType": "application/pdf",
  "TotalBytes": 52428800,
  "ExpectedChunkCount": 50,
  "NewRevision": true,
  "KeepCheckedOut": false,
  "Comments": "Uploaded in chunks"
}
```

#### Create a new record before upload
If you do not supply `RecordUri`, you must provide `RecordTypeUri` (the URI of the record type to create) and `Title` (the new record's title):
```json
{
  "RecordTypeUri": 2,
  "Title": "My New Document",
  "FileName": "large-document.pdf",
  "ContentType": "application/pdf",
  "TotalBytes": 52428800,
  "ExpectedChunkCount": 50,
  "NewRevision": true,
  "KeepCheckedOut": false,
  "Comments": "Uploaded in chunks"
}
```

Example response:

```json
{
  "SessionId": "2e5f271a29cf45b3a45d09bde2635ea8",
  "UploadChunkUrlTemplate": "https://server/cm/serviceapi/ChunkedUpload/2e5f271a29cf45b3a45d09bde2635ea8/chunk/{chunkNumber}",
  "CompleteUrl": "https://server/cm/serviceapi/ChunkedUpload/2e5f271a29cf45b3a45d09bde2635ea8/complete",
  "StatusUrl": "https://server/cm/serviceapi/ChunkedUpload/2e5f271a29cf45b3a45d09bde2635ea8",
  "ExpiresUtc": "2026-03-25T04:00:00Z"
}
```

### 3. Upload each chunk

PUT or POST /ChunkedUpload/{sessionId}/chunk/{chunkNumber}?offset={offset}&totalBytes={totalBytes}

Send the raw binary chunk as the request body.

Recommended headers:

- Content-Type: application/octet-stream
- Content-Range: bytes 0-1048575/52428800
- X-Content-SHA256: optional if your client maps that to the Sha256 query value

If your client can easily send query parameters, include:

- offset
- totalBytes
- sha256

### 4. Check status

GET /ChunkedUpload/{sessionId}

### 5. Complete the upload

POST /ChunkedUpload/{sessionId}/complete

The plugin assembles all chunks and calls the CM SDK to set the document on the target record.

### 6. Abort the upload

DELETE /ChunkedUpload/{sessionId}

### 7. Cancel the upload (alternative)

POST /ChunkedUpload/{sessionId}/cancel

Cancels and deletes the upload session and all associated data. Use this if you want to explicitly cancel via POST.

## PowerShell Client Example

The included `Send-CMChunkedUpload.ps1` script automates chunked uploads, supports resumable and parallel uploads, and performs end-to-end checksum verification. Example usage:

```powershell
# Dot-source the script
. .\ChunkedUploadPlugin\Send-CMChunkedUpload.ps1

# Option A: Upload to an existing record
Send-CmChunkedUpload -BaseUrl "https://server/cm/serviceapi" -FilePath "C:\largefile.bin" -RecordUri 9000000001 -ChunkSizeBytes 4MB -Username "admin" -Password (Read-Host -AsSecureString)

# Option B: Create a new record and upload to it
# (Title will default to the filename if omitted)
Send-CmChunkedUpload -BaseUrl "https://server/cm/serviceapi" -FilePath "C:\largefile.bin" -RecordTypeUri 2 -Title "My Large Document"

# Option C: Stage file then start async attach for an existing record
Send-CmChunkedUpload -BaseUrl "https://server/cm/serviceapi" -FilePath "C:\largefile.bin" -RecordUri 9000000001 -StageOnly $true -StartAsyncAttach -WaitForAsyncAttach
```

Key features:
- Automatically creates new records or attaches to existing ones.
- Resumes interrupted uploads by querying the `/missing` endpoint.
- Performs end-to-end SHA256 checksum verification after assembly.
- Can call `/Upload/attach/preflight`, `/Upload/attach/start`, and `/Upload/attach/{jobId}` when `-StartAsyncAttach` is used.
- Handles authentication (Basic Auth or Default Credentials).
- Uses exponential backoff for retries on individual chunks.

See the script for more details and parameters.

## C# Client Example

Here is a basic example using `System.Net.Http.HttpClient` to upload a file in chunks, complete in stage-only mode, and then start async attach:

```csharp
using System;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;

public class ChunkedUploadClient
{
  public static async Task UploadFileAndStartAsyncAttachAsync(string baseUrl, string filePath, long recordUri, string username, string password)
    {
        var fileInfo = new FileInfo(filePath);
        int chunkSize = 4 * 1024 * 1024; // 4MB chunks
        int expectedChunks = (int)Math.Ceiling((double)fileInfo.Length / chunkSize);

        using var client = new HttpClient();
        var authBytes = Encoding.ASCII.GetBytes($"{username}:{password}");
        client.DefaultRequestHeaders.Authorization = new AuthenticationHeaderValue("Basic", Convert.ToBase64String(authBytes));
        client.DefaultRequestHeaders.Accept.Add(new MediaTypeWithQualityHeaderValue("application/json"));

        // 1. Start the Session
        var startPayload = new
        {
          StageOnly = true,
            RecordUri = recordUri,
            FileName = fileInfo.Name,
            ContentType = "application/octet-stream",
            TotalBytes = fileInfo.Length,
            ExpectedChunkCount = expectedChunks,
            NewRevision = true,
            KeepCheckedOut = false
        };

        var startContent = new StringContent(JsonSerializer.Serialize(startPayload), Encoding.UTF8, "application/json");
        var startRes = await client.PostAsync($"{baseUrl}/Upload/start", startContent);
        startRes.EnsureSuccessStatusCode();
        
        using var startStream = await startRes.Content.ReadAsStreamAsync();
        var startResponseData = await JsonSerializer.DeserializeAsync<JsonElement>(startStream);
        string sessionId = startResponseData.GetProperty("SessionId").GetString();
        Console.WriteLine($"[INFO] Started session: {sessionId}");

        // 2. Upload the Chunks
        using var fs = File.OpenRead(filePath);
        byte[] buffer = new byte[chunkSize];
        int bytesRead;
        int chunkNumber = 0;
        long offset = 0;

        while ((bytesRead = await fs.ReadAsync(buffer, 0, buffer.Length)) > 0)
        {
            Console.WriteLine($"[INFO] Uploading chunk {chunkNumber}...");
            using var chunkContent = new ByteArrayContent(buffer, 0, bytesRead);
            chunkContent.Headers.ContentType = new MediaTypeHeaderValue("application/octet-stream");
            
            long to = offset + bytesRead - 1;
            chunkContent.Headers.Add("Content-Range", $"bytes {offset}-{to}/{fileInfo.Length}");

            var uploadRes = await client.PutAsync($"{baseUrl}/Upload/{sessionId}/chunk/{chunkNumber}", chunkContent);
            uploadRes.EnsureSuccessStatusCode();

            offset += bytesRead;
            chunkNumber++;
        }

        // 3. Complete the Upload
        Console.WriteLine($"[INFO] Completing upload session {sessionId}...");
        var completeRes = await client.PostAsync($"{baseUrl}/Upload/{sessionId}/complete", new StringContent("{}", Encoding.UTF8, "application/json"));
        completeRes.EnsureSuccessStatusCode();
        
        using var completeStream = await completeRes.Content.ReadAsStreamAsync();
        var completeData = await JsonSerializer.DeserializeAsync<JsonElement>(completeStream);
        Console.WriteLine($"[SUCCESS] Upload complete. Assembled SHA256: {completeData.GetProperty("AssembledSha256").GetString()}");

        string stagedFilePath = completeData.GetProperty("StagedFilePath").GetString();
        string fullUploadedFileName = completeData.GetProperty("FullUploadedFileName").GetString();

        // 4. Preflight async attach source file
        var preflightPayload = new
        {
          SessionId = sessionId,
          StagedFilePath = stagedFilePath,
          FullUploadedFileName = fullUploadedFileName
        };
        var preflightContent = new StringContent(JsonSerializer.Serialize(preflightPayload), Encoding.UTF8, "application/json");
        var preflightRes = await client.PostAsync($"{baseUrl}/Upload/attach/preflight", preflightContent);
        preflightRes.EnsureSuccessStatusCode();

        using var preflightStream = await preflightRes.Content.ReadAsStreamAsync();
        var preflightData = await JsonSerializer.DeserializeAsync<JsonElement>(preflightStream);
        if (!preflightData.GetProperty("SourcePathAllowed").GetBoolean() || !preflightData.GetProperty("SourceExists").GetBoolean())
        {
          throw new InvalidOperationException("Async attach preflight failed. Source is missing or blocked.");
        }

        // 5. Start async attach job
        var attachStartPayload = new
        {
          SessionId = sessionId,
          RecordUri = recordUri,
          FileName = fileInfo.Name,
          FullUploadedFileName = fullUploadedFileName,
          StagedFilePath = stagedFilePath,
          NewRevision = true,
          KeepCheckedOut = false,
          Comments = "Uploaded in chunks"
        };
        var attachStartContent = new StringContent(JsonSerializer.Serialize(attachStartPayload), Encoding.UTF8, "application/json");
        var attachStartRes = await client.PostAsync($"{baseUrl}/Upload/attach/start", attachStartContent);
        attachStartRes.EnsureSuccessStatusCode();

        using var attachStartStream = await attachStartRes.Content.ReadAsStreamAsync();
        var attachStartData = await JsonSerializer.DeserializeAsync<JsonElement>(attachStartStream);
        string jobId = attachStartData.GetProperty("JobId").GetString();
        Console.WriteLine($"[INFO] Async attach job started: {jobId}");

        // 6. Poll async attach status
        while (true)
        {
          await Task.Delay(TimeSpan.FromSeconds(2));

          var statusRes = await client.GetAsync($"{baseUrl}/Upload/attach/{jobId}");
          statusRes.EnsureSuccessStatusCode();

          using var statusStream = await statusRes.Content.ReadAsStreamAsync();
          var statusData = await JsonSerializer.DeserializeAsync<JsonElement>(statusStream);
          string status = statusData.GetProperty("Status").GetString();
          Console.WriteLine($"[INFO] Async attach status: {status}");

          if (statusData.GetProperty("Completed").GetBoolean())
          {
            if (!statusData.GetProperty("Succeeded").GetBoolean())
            {
              string error = statusData.TryGetProperty("ErrorMessage", out var errorProp) ? errorProp.GetString() : "Unknown error";
              throw new InvalidOperationException($"Async attach failed: {error}");
            }

            Console.WriteLine("[SUCCESS] Async attach completed.");
            break;
          }
        }
    }
}
```

## Notes

- This implementation targets existing records by `RecordUri` or creates new ones via `RecordTypeUri`.
- Chunks are persisted on disk so large uploads do not stay in memory.
- Completion requires contiguous chunks with matching total size if `TotalBytes` was supplied.
- The plugin assumes the ServiceAPI process identity can read and write the temporary upload path.
- The exact behaviour of `Record.SetDocument` can vary slightly across CM versions, so test against your installed SDK version.
