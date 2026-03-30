# SAPI Chunked Upload Plugin

This solution provides a Content Manager ServiceAPI plugin for resumable chunk uploads, plus an optional Web Client browser script integration.

## What this project includes

- ServiceAPI routes for chunked upload session lifecycle and chunk transfer.
- 4 MB chunk upload strategy with resumable missing-chunk support.
- Stage-only completion path that returns a native CM `RecordFilePath` token (`userUri\\fileName`).
- Optional Web Client script that intercepts native file input and drives chunked uploads.
- Parallel chunk uploads with user-configurable concurrency.
- Resume hardening (stale session sweep, resumed-tail healing, and one-time fresh-session retry on contiguous errors).
- Overlay cancel support and uploaded-file delete integration (`DELETE /Upload/{SessionId}`) from CM UI.
- Post-save document hash verification (single lookup).
- Post-save cleanup call to delete staged session artifacts.

## Deployment topologies

This plugin supports two deployment models.

1. Web Client hosted ServiceAPI
: Plugin is loaded by the Web Client ServiceAPI host and used by `custom/chunker.js`.

2. Standalone ServiceAPI host
: Plugin is loaded by a standalone ServiceAPI site or service. Browser script is optional and usually not required unless you are integrating a custom UI.

## Key files

- `ChunkedUploadPlugin/ChunkedUploadService.cs`
- `ChunkedUploadPlugin/UploadSessionStore.cs`
- `ChunkedUploadPlugin/Send-CMChunkedUpload.ps1` (standalone/API testing helper)
- `custom/chunker.js` (Web Client integration script)

## Endpoint reference

All routes are under `Upload`:

- `POST /Upload/start`
- `GET /Upload/{SessionId}`
- `GET /Upload/{SessionId}/missing`
- `POST /Upload/{SessionId}/chunk/{ChunkNumber}`
- `PUT /Upload/{SessionId}/chunk/{ChunkNumber}`
- `POST /Upload/{SessionId}/complete`
- `POST /Upload/{SessionId}/cancel`
- `DELETE /Upload/{SessionId}`
- `POST /Upload/cleanup`

## Configuration

Register the plugin assembly in `hprmServiceAPI.config`:

```xml
<pluginAssemblies>
  <add name="ChunkedUploadPlugin" />
</pluginAssemblies>
```

Optional `appSettings`:

```xml
<appSettings>
  <add key="ChunkedUpload.TempPath" value="D:\\Micro Focus Content Manager\\ServiceAPIWorkpath\\ChunkedUploads" />
  <add key="ChunkedUpload.SessionExpiryHours" value="24" />
  <add key="ChunkedUpload.NativeUploadBasePath" value="D:\\Micro Focus Content Manager\\ServiceAPIWorkpath\\Uploads" />
</appSettings>
```

Setting notes:

- `ChunkedUpload.TempPath`: session folders, chunk parts, and assembled temp file location.
- `ChunkedUpload.SessionExpiryHours`: expiration window used by session validation.
- `ChunkedUpload.NativeUploadBasePath`: destination root for native CM upload token file copy.

## Installation: Web Client deployment

Use this when ServiceAPI is hosted by Content Manager Web Client.

1. Build `ChunkedUploadPlugin.sln`.
2. Copy `ChunkedUploadPlugin.dll` to the Web Client `bin` folder.
3. Update Web Client `hprmServiceAPI.config` with plugin registration and optional appSettings.
4. Copy `custom/chunker.js` into the Web Client `custom` folder.
5. Update `Views/Home/Index.cshtml` to include:

```cshtml
<script src="@Url.Content("~/custom/chunker.js")"></script>
```

6. Recycle app pool or restart the Web Client site.
7. Hard refresh browser (Ctrl+F5).

**Important deployment note:**

The active runtime script is the Web Client file copy at `C:\Program Files\Micro Focus\Content Manager\Web Client\custom\chunker.js`, not the repo source. This is the file the browser loads and executes. Changes to the repo source will not take effect until you copy the updated file into the Web Client custom folder and the browser refreshes. For development/testing, keep both in sync; for production, only the deployed Web Client copy matters.

Web Client script notes:

- Script currently targets ServiceAPI base path `/contentmanager/serviceapi`.
- Script sends anti-forgery token as `__RequestVerificationToken` in multipart `FormData` for POST calls.
- Script uses `credentials: include`/`withCredentials = true` for Windows auth continuity.
- Default max parallel chunks is `4` (runtime configurable):

```javascript
window.setChunkedUploadConcurrency(4);
window.getChunkedUploadConcurrency();
```

- Verbose diagnostics toggle:

```javascript
window.setChunkedUploadVerbose(true);
window.getChunkedUploadVerbose();
```

- Resume metadata is periodically swept from localStorage when sessions are stale/invalid.

## Installation: standalone ServiceAPI deployment

Use this when ServiceAPI runs independently from Web Client.

1. Build `ChunkedUploadPlugin.sln`.
2. Copy `ChunkedUploadPlugin.dll` to the standalone ServiceAPI host `bin` folder.
3. Update standalone `hprmServiceAPI.config` with plugin registration and optional appSettings.
4. Restart the standalone ServiceAPI host/service.
5. Validate endpoint availability with `GET /Upload/{sessionId}` after creating a test session.

Standalone client integration options:

- Use your own HTTP client against `Upload/*` routes.
- Use `ChunkedUploadPlugin/Send-CMChunkedUpload.ps1` for scripted upload testing.
- If you choose to use `custom/chunker.js` outside Web Client, adjust its base path constant to your standalone ServiceAPI root and ensure equivalent CSRF/auth behavior.

PowerShell helper notes (`Send-CMChunkedUpload.ps1`):

- Defaults to `-StageOnly $true` to match browser script behavior.
- Reuses cached session IDs by file signature and resumes via `/missing`.
- Performs one-time automatic fresh-session retry when `/complete` reports a contiguous-session failure.
- Supports optional immediate cleanup after completion with `-CleanupAfterComplete` (StageOnly mode).
- Exposes Check In/session flags: `-NewRevision`, `-KeepCheckedOut`, `-Comments`.

Example commands:

```powershell
# 1) Stage-only upload (default behavior), then cleanup staged artifacts immediately.
. .\ChunkedUploadPlugin\Send-CMChunkedUpload.ps1
Send-CmChunkedUpload `
  -BaseUrl "http://your-host/contentmanager/serviceapi" `
  -FilePath "C:\Temp\large-file.bin" `
  -UseDefaultCredentials `
  -StageOnly $true `
  -CleanupAfterComplete

# 2) Non-stage-only upload: complete directly into a record.
. .\ChunkedUploadPlugin\Send-CMChunkedUpload.ps1
Send-CmChunkedUpload `
  -BaseUrl "http://your-host/contentmanager/serviceapi" `
  -FilePath "C:\Temp\large-file.bin" `
  -UseDefaultCredentials `
  -StageOnly $false `
  -RecordUri 12345 `
  -NewRevision $true `
  -KeepCheckedOut $false `
  -Comments "Uploaded by scripted chunked upload"

# 3) Non-stage-only upload: create a new record using RecordTypeUri + Title.
. .\ChunkedUploadPlugin\Send-CMChunkedUpload.ps1
Send-CmChunkedUpload `
  -BaseUrl "http://your-host/contentmanager/serviceapi" `
  -FilePath "C:\Temp\large-file.bin" `
  -UseDefaultCredentials `
  -StageOnly $false `
  -RecordTypeUri 9876 `
  -Title "Scripted upload example" `
  -NewRevision $true `
  -KeepCheckedOut $false `
  -Comments "Created with Send-CmChunkedUpload"
```

## Runtime flow (Web Client script path)

1. User selects or drags a file in New Record or Check In upload UI.
2. Script intercepts file input change/dropzone drop and starts chunk session.
3. Script queries missing chunks and uploads only missing chunks.
4. Script completes session and receives:
   - `StagedFilePath`
   - `RecordFilePath` (`userUri\\fileName`)
   - `FullUploadedFileName`
   - `AssembledSha256`
5. Script injects `uploadedFiles` KO payload so normal CM save uses `RecordFilePath`.
6. After successful record save:
  - script verifies record hash
  - script calls `/Upload/cleanup`

Runtime behaviors:

- Upload chunks are sent in parallel batches (default 4 concurrent).
- User cancel aborts in-flight request/retry timers and calls `POST /Upload/{SessionId}/cancel`.
- If a resumed session fails `/complete` with `Uploaded chunks are not contiguous`, script clears cached session, aborts it, and retries once with a fresh session.
- On resumed sessions, a small tail-window of already uploaded chunks is re-sent before complete to heal interrupted writes.

## Verification checklist

Web Client deployment:

- Upload requests appear under `Upload/*`.
- Record save includes `RecordFilePath` in `userUri\\fileName` format.
- Record creates successfully with electronic document attached.
- Console shows hash verification success or mismatch message.
- Cleanup call returns success (empty body is acceptable).

Standalone deployment:

- `start`, `missing`, `chunk`, and `complete` routes succeed end-to-end.
- Session folders are created under `ChunkedUpload.TempPath`.
- Native upload copy path resolves under `ChunkedUpload.NativeUploadBasePath`.
- `cleanup` removes session/temp artifacts as expected.

## Supported upload entry points

The chunked upload integration works with any CM action that uses the standard file upload widget (TRIMFileUpload or files[] input):

- **New Record** — create a new record with an electronic document attached
- **Check In** — attach an electronic object to an existing metadata-only record or create a new revision
- **MainObjectUpdateTaskForm-based tasks** — any workflow or custom task that includes a file field
- **Any custom form** using `files[]` input in the Web Client

The integration intercepts file input changes and dropzone events globally via event capture, so all forms automatically benefit from chunked upload and cancellation support.

## Troubleshooting

### Hash verification empty value

Post-save hash verification depends on dataset document hashing being enabled.

- If dataset hashing is disabled, ServiceAPI can return empty `RecordDocumentHash`.
- Enable dataset document hashing before relying on verification output.

### Cleanup returns HTTP 200 with empty body

This is valid. The script treats empty cleanup response body as success.

### Browser console errors from `chrome-extension://...`

Errors referencing browser extensions (for example `recordingStatus`) are external to this plugin.

### Upload works in New Record but not in other forms

The chunked upload integration uses event capture on `files[]` inputs, which may conflict with form initialization order in some edge cases. If another form isn't triggering the upload:

1. Open browser developer tools (F12) and check the Console tab.
2. Set `window.CHUNKED_UPLOAD_VERBOSE = true` and reload to enable debug logging.
3. Check that the file input has `name="files[]"` attribute.
4. Verify the form is using the standard TRIMFileUpload widget.
5. If still not working, file an issue with the form name and debug output.

## Recent changes

- Added post-save hash verification against record hash properties (`RecordDocumentHash` with fallback handling).
- Added post-save cleanup endpoint (`POST /Upload/cleanup`) for session/temp/native file cleanup.
- Updated Web Client script to call cleanup after successful record save.
- Simplified hash verification to single-lookup mode (no retry loop).
- Reduced script console noise with verbose debug toggle (`window.CHUNKED_UPLOAD_VERBOSE = true`).
- Added duplicate-install guards for XHR interceptor and file-input change handler.
- Expanded Web Client interception to support Check In modal upload flows (including drag/drop zone handling).
- Added stale resume-key cleanup and resumed-upload progress messaging.
- Added configurable parallel chunk upload concurrency and persisted verbose debug switch.
- Added uploaded-file delete hooks to abort matching chunk sessions after confirmation.
- Hardened contiguous-error recovery in browser flow with fresh-session retry and resumed-tail healing.
- Hardened cancel/delete race handling server-side to avoid transient directory-lock cancellation failures.
- Updated `Send-CMChunkedUpload.ps1` to support stage-only defaults, resumable session cache, contiguous-error recovery retry, and optional cleanup.
