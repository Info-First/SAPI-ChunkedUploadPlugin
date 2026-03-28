# SAPI Chunked Upload Plugin

This solution provides a custom Content Manager ServiceAPI plugin and companion Web Client script for large-file, resumable chunk uploads.

## Current deployment model

This project is configured for the Content Manager Web Client deployment path:

- Plugin assembly loaded by Web Client ServiceAPI.
- Browser script in custom/chunked-upload.js intercepts native file input changes.
- Upload routes use /contentmanager/serviceapi/UploadChunks/*.

## What is implemented

- Resumable chunk session start, status, missing-chunk query, upload, complete, cancel, and abort endpoints.
- 4 MB chunk upload flow in the browser script.
- CSRF-safe request format for CM Web Client anti-forgery enforcement.
- Native uploader bypass for selected files (capture-phase change interception).
- Knockout ViewModel integration so Record save uses chunked upload output.
- Native RecordFilePath compatibility bridge from plugin complete response.

## CSRF token support (important)

Content Manager Web Client enforces anti-forgery validation in request filters.

For POST operations in this chunked flow, the token is sent as a form field:

- __RequestVerificationToken in multipart FormData.

Token source order in custom/chunked-upload.js:

1. HPRMWebConfig.antiForgeryToken (preferred).
2. window.HP.HPTRIM.trimOptions.antiForgeryToken.
3. window.__RequestVerificationToken.
4. DOM input named __RequestVerificationToken.

Notes:

- Start, chunk, and complete calls all use FormData so anti-forgery form field validation succeeds.
- credentials: include / withCredentials = true is used so Windows Auth context is preserved.

## Runtime flow

1. Browser selects file on CM form.
2. Script blocks native handler and starts /UploadChunks/start.
3. Script calls /UploadChunks/{sessionId}/missing and uploads only missing chunks.
4. Script calls /UploadChunks/{sessionId}/complete.
5. Plugin materializes assembled file and returns:
   - StagedFilePath (physical assembled file path).
   - RecordFilePath (native CM token format: userUri\\fileName).
   - FullUploadedFileName (full path in upload base path).
6. Script injects uploaded file metadata into the Knockout uploadedFiles observable.
7. Normal CM create/save submits RecordFilePath and succeeds.

## Endpoints

All routes are under UploadChunks:

- POST /UploadChunks/start
- GET /UploadChunks/{SessionId}
- GET /UploadChunks/{SessionId}/missing
- POST /UploadChunks/{SessionId}/chunk/{ChunkNumber}
- PUT /UploadChunks/{SessionId}/chunk/{ChunkNumber}
- POST /UploadChunks/{SessionId}/complete
- POST /UploadChunks/{SessionId}/cancel
- DELETE /UploadChunks/{SessionId}

## Key files

- ChunkedUploadPlugin/ChunkedUploadService.cs
- ChunkedUploadPlugin/UploadSessionStore.cs
- custom/chunked-upload.js

## Configuration

hprmServiceAPI.config must include plugin registration:

```xml
<pluginAssemblies>
  <add name="ChunkedUploadPlugin" />
</pluginAssemblies>
```

Optional appSettings:

```xml
<appSettings>
  <add key="ChunkedUpload.TempPath" value="D:\\Micro Focus Content Manager\\ServiceAPIWorkpath\\ChunkedUploads" />
  <add key="ChunkedUpload.SessionExpiryHours" value="24" />
  <add key="ChunkedUpload.NativeUploadBasePath" value="D:\\Micro Focus Content Manager\\ServiceAPIWorkpath\\Uploads" />
</appSettings>
```

## Build and deploy

1. Build ChunkedUploadPlugin.sln.
2. Copy ChunkedUploadPlugin.dll to Web Client bin.
3. Ensure custom/chunked-upload.js is present in Web Client custom folder.
4. Hard refresh browser (Ctrl+F5).

## Verification checklist

- Console shows chunked script loaded.
- Network shows start, missing, chunk, complete requests under UploadChunks.
- Console shows injected KO observable with UploadedFileName in native token format.
- Record create/save payload includes RecordFilePath in userUri\\fileName format.
- Record creation succeeds and file is attached.
