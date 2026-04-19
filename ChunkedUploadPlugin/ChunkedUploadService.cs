
using HP.HPTRIM.Service;
using HP.HPTRIM.ServiceModel;
using TRIM.SDK;
using ServiceStack;
using System;
using System.Collections.Concurrent;
using System.Configuration;
using System.IO;
using System.Linq;
using System.Threading;

namespace HP.HPTRIM.ServiceAPI
{
    public struct ParsedContentRange
    {
        public long From { get; set; }
        public long To { get; set; }
        public long? TotalSize { get; set; }
    }
    [Route("/Upload/start", "POST")]
    [Authenticate]
    public class StartChunkedUpload : IReturn<ChunkedUploadSessionResponse>
    {
        public bool StageOnly { get; set; }
        public long? RecordUri { get; set; } // Optional: if not supplied, a new record will be created
        public long? RecordTypeUri { get; set; } // Required if creating new record
        public string Title { get; set; } // Required if creating new record
        public string FileName { get; set; }
        public string ContentType { get; set; }
        public long TotalBytes { get; set; }
        public int ExpectedChunkCount { get; set; }
        public bool NewRevision { get; set; }
        public bool KeepCheckedOut { get; set; }
        public string Comments { get; set; }
    }

    [Route("/Upload/{SessionId}", "GET")]
    [Authenticate]
    public class GetChunkedUploadStatus : IReturn<ChunkedUploadStatusResponse>
    {
        public string SessionId { get; set; }
    }

    [Route("/Upload/{SessionId}/missing", "GET")]
    [Authenticate]
    public class GetMissingChunks : IReturn<GetMissingChunksResponse>
    {
        public string SessionId { get; set; }
    }

    [Route("/Upload/{SessionId}/cancel", "POST")]
    [Authenticate]
    public class CancelChunkedUpload : IReturn<CancelChunkedUploadResponse>
    {
        public string SessionId { get; set; }
    }

    [Route("/Upload/{SessionId}/chunk/{ChunkNumber}", "POST,PUT")]
    [Authenticate]
    public class UploadChunk : IReturn<UploadChunkResponse>
    {
        public string SessionId { get; set; }

        public int ChunkNumber { get; set; }

        public long Offset { get; set; }

        public long TotalBytes { get; set; }

        public string Sha256 { get; set; }
    }

    [Route("/Upload/{SessionId}/complete", "POST")]
    [Authenticate]
    public class CompleteChunkedUpload : IReturn<CompleteChunkedUploadResponse>
    {
        public string SessionId { get; set; }
    }

    [Route("/Upload/{SessionId}", "DELETE")]
    [Authenticate]
    public class AbortChunkedUpload : IReturn<AbortChunkedUploadResponse>
    {
        public string SessionId { get; set; }
    }

    [Route("/Upload/cleanup", "POST")]
    [Authenticate]
    public class CleanupChunkedUpload : IReturn<CleanupChunkedUploadResponse>
    {
        public string SessionId { get; set; }
        public string StagedFilePath { get; set; }
        public string FullUploadedFileName { get; set; }
    }

    [Route("/Upload/attach/start", "POST")]
    [Authenticate]
    public class StartAsyncAttach : IReturn<StartAsyncAttachResponse>
    {
        public string SessionId { get; set; }
        public long RecordUri { get; set; }
        public string FileName { get; set; }
        public string FullUploadedFileName { get; set; }
        public string StagedFilePath { get; set; }
        public bool? NewRevision { get; set; }
        public bool? KeepCheckedOut { get; set; }
        public string Comments { get; set; }
    }

    [Route("/Upload/attach/{JobId}", "GET")]
    [Authenticate]
    public class GetAsyncAttachStatus : IReturn<GetAsyncAttachStatusResponse>
    {
        public string JobId { get; set; }
    }

    public class ChunkedUploadSessionResponse : IHasResponseStatus
    {
        public string SessionId { get; set; }

        public string UploadChunkUrlTemplate { get; set; }

        public string CompleteUrl { get; set; }

        public string StatusUrl { get; set; }

        public DateTime ExpiresUtc { get; set; }

        public ResponseStatus ResponseStatus { get; set; }
    }

    public class ChunkedUploadStatusResponse : IHasResponseStatus
    {
        public string SessionId { get; set; }
        public long RecordUri { get; set; }
        public string FileName { get; set; }
        public string ContentType { get; set; }
        public long TotalBytes { get; set; }
        public long UploadedBytes { get; set; }
        public int UploadedChunkCount { get; set; }
        public int ExpectedChunkCount { get; set; }
        public DateTime CreatedUtc { get; set; }
        public DateTime UpdatedUtc { get; set; }
        public DateTime ExpiresUtc { get; set; }
        public bool IsReadyToComplete { get; set; }
        public int[] MissingChunks { get; set; } // For resumable support
        public ResponseStatus ResponseStatus { get; set; }
    }

    public class GetMissingChunksResponse : IHasResponseStatus
    {
        public string SessionId { get; set; }
        public int[] MissingChunks { get; set; }
        public ResponseStatus ResponseStatus { get; set; }
    }

    public class CancelChunkedUploadResponse : IHasResponseStatus
    {
        public string SessionId { get; set; }
        public bool Cancelled { get; set; }
        public ResponseStatus ResponseStatus { get; set; }
    }

    public class UploadChunkResponse : IHasResponseStatus
    {
        public string SessionId { get; set; }

        public int ChunkNumber { get; set; }

        public long BytesWritten { get; set; }

        public long TotalUploadedBytes { get; set; }

        public int UploadedChunkCount { get; set; }

        public string Sha256 { get; set; }

        public ResponseStatus ResponseStatus { get; set; }
    }

    public class CompleteChunkedUploadResponse : IHasResponseStatus
    {
        public long RecordUri { get; set; }
        public string FileName { get; set; }
        public long UploadedBytes { get; set; }
        public bool NewRevision { get; set; }
        public bool KeepCheckedOut { get; set; }
        public string AssembledSha256 { get; set; } // SHA256 of the assembled file
        public string StagedFilePath { get; set; }
        public string RecordFilePath { get; set; }
        public string FullUploadedFileName { get; set; }
        public ResponseStatus ResponseStatus { get; set; }
    }

    public class AbortChunkedUploadResponse : IHasResponseStatus
    {
        public string SessionId { get; set; }

        public bool Deleted { get; set; }

        public ResponseStatus ResponseStatus { get; set; }
    }

    public class CleanupChunkedUploadResponse : IHasResponseStatus
    {
        public string SessionId { get; set; }
        public bool SessionDeleted { get; set; }
        public bool StagedFileDeleted { get; set; }
        public bool NativeUploadFileDeleted { get; set; }
        public ResponseStatus ResponseStatus { get; set; }
    }

    public class StartAsyncAttachResponse : IHasResponseStatus
    {
        public string JobId { get; set; }
        public string StatusUrl { get; set; }
        public DateTime CreatedUtc { get; set; }
        public ResponseStatus ResponseStatus { get; set; }
    }

    public class GetAsyncAttachStatusResponse : IHasResponseStatus
    {
        public string JobId { get; set; }
        public long RecordUri { get; set; }
        public string Status { get; set; }
        public bool Completed { get; set; }
        public bool Succeeded { get; set; }
        public string ErrorMessage { get; set; }
        public DateTime CreatedUtc { get; set; }
        public DateTime UpdatedUtc { get; set; }
        public DateTime? CompletedUtc { get; set; }
        public ResponseStatus ResponseStatus { get; set; }
    }

    public class ChunkedUploadService : TrimServiceBase
    {
        private static readonly ServiceStack.Logging.ILog Logger = ServiceStack.Logging.LogManager.GetLogger(typeof(ChunkedUploadService));
        private static readonly ConcurrentDictionary<string, AsyncAttachJobState> AsyncAttachJobs = new ConcurrentDictionary<string, AsyncAttachJobState>(StringComparer.OrdinalIgnoreCase);
        private static readonly TimeSpan AsyncAttachJobRetention = TimeSpan.FromHours(6);
        private static readonly int AsyncAttachMaxConcurrency = GetAsyncAttachMaxConcurrency();
        private static readonly SemaphoreSlim AsyncAttachExecutionGate = new SemaphoreSlim(AsyncAttachMaxConcurrency, AsyncAttachMaxConcurrency);
        private readonly UploadSessionStore sessionStore = new UploadSessionStore();

        public object Post(StartChunkedUpload request)
        {
            // If RecordUri is not supplied and we are not in StageOnly mode, create a new record
            if (!request.StageOnly && (!request.RecordUri.HasValue || request.RecordUri.Value <= 0))
            {
                if (!request.RecordTypeUri.HasValue || string.IsNullOrWhiteSpace(request.Title))
                {
                    throw HttpError.BadRequest("RecordTypeUri and Title are required to create a new record.");
                }
                var recordType = new TRIM.SDK.RecordType(Database, request.RecordTypeUri.Value);
                if (recordType.Uri <= 0)
                {
                    throw HttpError.BadRequest("Invalid RecordTypeUri.");
                }
                var newRecord = new TRIM.SDK.Record(Database, recordType);
                newRecord.Title = request.Title;
                newRecord.Save();
                request.RecordUri = newRecord.Uri;
            }
            var session = sessionStore.CreateSession(request);
            return new ChunkedUploadSessionResponse
            {
                SessionId = session.SessionId,
                UploadChunkUrlTemplate = Request.GetAbsoluteUrl(string.Format("~/Upload/{0}/chunk/{{chunkNumber}}", session.SessionId)),
                CompleteUrl = Request.GetAbsoluteUrl(string.Format("~/Upload/{0}/complete", session.SessionId)),
                StatusUrl = Request.GetAbsoluteUrl(string.Format("~/Upload/{0}", session.SessionId)),
                ExpiresUtc = session.ExpiresUtc,
                ResponseStatus = new ResponseStatus()
            };
        }

        public object Get(GetChunkedUploadStatus request)
        {
            var session = sessionStore.GetRequiredSession(request.SessionId);
            long uploadedBytes = session.ChunkMap.Sum(item => item.Value.Length);
            var missingChunks = sessionStore.GetMissingChunks(session);
            return new ChunkedUploadStatusResponse
            {
                SessionId = session.SessionId,
                RecordUri = session.RecordUri,
                FileName = session.FileName,
                ContentType = session.ContentType,
                TotalBytes = session.TotalBytes,
                UploadedBytes = uploadedBytes,
                UploadedChunkCount = session.ChunkMap.Count,
                ExpectedChunkCount = session.ExpectedChunkCount,
                CreatedUtc = session.CreatedUtc,
                UpdatedUtc = session.UpdatedUtc,
                ExpiresUtc = session.ExpiresUtc,
                IsReadyToComplete = IsReadyToComplete(session, uploadedBytes),
                MissingChunks = missingChunks
            };
        }

        public object Get(GetMissingChunks request)
        {
            var session = sessionStore.GetRequiredSession(request.SessionId);
            var missingChunks = sessionStore.GetMissingChunks(session);
            return new GetMissingChunksResponse
            {
                SessionId = session.SessionId,
                MissingChunks = missingChunks
            };
        }

        public object Post(CancelChunkedUpload request)
        {
            bool cancelled = sessionStore.CancelSession(request.SessionId);
            return new CancelChunkedUploadResponse
            {
                SessionId = request.SessionId,
                Cancelled = cancelled
            };
        }

        public object Post(UploadChunk request)
        {
            return SaveChunk(request);
        }

        public object Put(UploadChunk request)
        {
            return SaveChunk(request);
        }

        public object Post(CompleteChunkedUpload request)
        {
            var session = sessionStore.GetRequiredSession(request.SessionId);
            string assembledPath = null;
            string assembledSha256 = null;
            bool calculateTrimHash = ShouldCalculateTrimHash();
            try
            {
                Logger.Info($"[CompleteChunkedUpload] SessionId={request.SessionId}, RecordUri={session.RecordUri}, FileName={session.FileName}, StageOnly={session.StageOnly}");
                var result = sessionStore.MaterializeFile(session);
                var parts = result.Split('|');
                assembledPath = parts[0];
                assembledSha256 = parts.Length > 1 ? parts[1] : null;
                Logger.Info($"[CompleteChunkedUpload] Assembled file path: {assembledPath}, SHA256: {assembledSha256}");

                string trimHash = null;

                if (session.StageOnly)
                {
                    if (calculateTrimHash)
                    {
                        try
                        {
                            trimHash = Database.CalculateDocumentHash(assembledPath);
                            Logger.Info($"[CompleteChunkedUpload] TRIM SDK Calculated Hash for staging: {trimHash}");
                        }
                        catch (Exception ex)
                        {
                            Logger.Warn($"[CompleteChunkedUpload] Failed to calculate TRIM hash: {ex.Message}");
                        }
                    }

                    string recordFilePath = null;
                    string fullUploadedFileName = null;
                    try
                    {
                        PrepareNativeUploadToken(assembledPath, session.FileName, out recordFilePath, out fullUploadedFileName);
                        Logger.Info($"[CompleteChunkedUpload] Prepared native RecordFilePath token: {recordFilePath}");
                    }
                    catch (Exception ex)
                    {
                        Logger.Warn($"[CompleteChunkedUpload] Failed to prepare native upload token: {ex}");
                    }

                    // assembled.bin has been moved to fullUploadedFileName by PrepareNativeUploadToken;
                    // use session.TotalBytes for size (file is no longer at assembledPath).
                    return new CompleteChunkedUploadResponse
                    {
                        RecordUri = session.RecordUri,
                        FileName = session.FileName,
                        UploadedBytes = session.TotalBytes,
                        NewRevision = session.NewRevision,
                        KeepCheckedOut = session.KeepCheckedOut,
                        AssembledSha256 = trimHash ?? assembledSha256,
                        StagedFilePath = fullUploadedFileName ?? assembledPath,
                        RecordFilePath = recordFilePath,
                        FullUploadedFileName = fullUploadedFileName
                    };
                }

                var record = new TRIM.SDK.Record(Database, session.RecordUri);
                Logger.Info($"[CompleteChunkedUpload] Loaded record: Uri={record.Uri}, Title={record.Title}, IsElectronic={record.IsElectronic}");
                if (record.Uri <= 0)
                {
                    Logger.Error($"[CompleteChunkedUpload] Record not found for Uri={session.RecordUri}");
                    throw HttpError.NotFound("Record not found.");
                }

                var inputDocument = new TRIM.SDK.InputDocument(assembledPath)
                {
                    CheckinAs = session.FileName
                };
                Logger.Info($"[CompleteChunkedUpload] Created InputDocument for {session.FileName}");

                string comments = string.IsNullOrWhiteSpace(session.Comments) ? "Uploaded via ChunkedUploadPlugin" : session.Comments;
                try
                {
                    if (calculateTrimHash)
                    {
                        trimHash = Database.CalculateDocumentHash(assembledPath);
                        Logger.Info($"[CompleteChunkedUpload] TRIM SDK Calculated Hash before checkin: {trimHash}");
                    }

                    record.SetDocument(inputDocument, session.NewRevision, session.KeepCheckedOut, comments);
                    record.Save();

                    Logger.Info($"[CompleteChunkedUpload] SetDocument and Save succeeded for record {record.Uri}");
                }
                catch (Exception ex)
                {
                    Logger.Error($"[CompleteChunkedUpload] SetDocument failed: {ex}");
                    throw;
                }

                return new CompleteChunkedUploadResponse
                {
                    RecordUri = session.RecordUri,
                    FileName = session.FileName,
                    UploadedBytes = session.TotalBytes,
                    NewRevision = session.NewRevision,
                    KeepCheckedOut = session.KeepCheckedOut,
                    AssembledSha256 = trimHash ?? assembledSha256
                };
            }
            catch (Exception ex)
            {
                Logger.Error($"[CompleteChunkedUpload] Exception: {ex}");
                throw;
            }
            finally
            {
                if (session != null && !session.StageOnly)
                {
                    sessionStore.DeleteSession(request.SessionId);
                }
            }
        }

        private void PrepareNativeUploadToken(string assembledPath, string fileName, out string recordFilePath, out string fullUploadedFileName)
        {
            if (string.IsNullOrWhiteSpace(assembledPath) || !File.Exists(assembledPath))
            {
                throw new FileNotFoundException("Assembled file not found.", assembledPath);
            }

            var sanitizedFileName = Path.GetFileName(fileName);
            if (string.IsNullOrWhiteSpace(sanitizedFileName))
            {
                sanitizedFileName = "uploaded.bin";
            }

            var userUri = ResolveCurrentUserUri();
            var uploadBasePath = ResolveUploadBasePath();
            var userFolderName = userUri.ToString();
            var userUploadDirectory = Path.Combine(uploadBasePath, userFolderName);
            Directory.CreateDirectory(userUploadDirectory);

            var targetFilePath = Path.Combine(userUploadDirectory, sanitizedFileName);

            // Prefer Move over Copy: on the same drive this is a near-instant metadata
            // operation regardless of file size. Fall back to Copy+Delete when source
            // and destination reside on different volumes (Move throws IOException).
            if (File.Exists(targetFilePath))
            {
                File.Delete(targetFilePath);
            }

            try
            {
                File.Move(assembledPath, targetFilePath);
            }
            catch (IOException)
            {
                // Cross-volume fallback: still copies bytes, but cleans up source afterwards
                // so at least we avoid doubling IO from a later session delete.
                File.Copy(assembledPath, targetFilePath, true);
                try { File.Delete(assembledPath); } catch { /* best-effort */ }
            }

            recordFilePath = userFolderName + "\\" + sanitizedFileName;
            fullUploadedFileName = targetFilePath;
        }

        private long ResolveCurrentUserUri()
        {
            try
            {
                var currentUser = Database.CurrentUser;
                if (currentUser != null && currentUser.Uri > 0)
                {
                    return currentUser.Uri;
                }
            }
            catch (Exception ex)
            {
                Logger.Warn($"[CompleteChunkedUpload] Unable to resolve current user URI from Database.CurrentUser: {ex.Message}");
            }

            return 0;
        }

        private string ResolveUploadBasePath()
        {
            var configured = ConfigurationManager.AppSettings["ChunkedUpload.NativeUploadBasePath"];
            if (!string.IsNullOrWhiteSpace(configured))
            {
                return configured;
            }

            return @"D:\Micro Focus Content Manager\ServiceAPIWorkpath\Uploads";
        }

        private static bool ShouldCalculateTrimHash()
        {
            var configured = ConfigurationManager.AppSettings["ChunkedUpload.CalculateTrimHash"];
            if (string.IsNullOrWhiteSpace(configured))
            {
                return true;
            }

            bool enabled;
            if (!bool.TryParse(configured, out enabled))
            {
                return true;
            }

            return enabled;
        }

        public object Delete(AbortChunkedUpload request)
        {
            sessionStore.DeleteSession(request.SessionId);
            return new AbortChunkedUploadResponse
            {
                SessionId = request.SessionId,
                Deleted = true
            };
        }

        public object Post(CleanupChunkedUpload request)
        {
            bool sessionDeleted = false;
            bool stagedDeleted = false;
            bool nativeDeleted = false;

            if (!string.IsNullOrWhiteSpace(request.SessionId))
            {
                try
                {
                    sessionStore.DeleteSession(request.SessionId);
                    sessionDeleted = true;
                }
                catch (Exception ex)
                {
                    Logger.Warn($"[CleanupChunkedUpload] Could not delete session {request.SessionId}: {ex.Message}");
                }
            }

            stagedDeleted = DeleteIfUnderAllowedRoot(request.StagedFilePath, ResolveChunkRootPath(), "staged file");
            nativeDeleted = DeleteIfUnderAllowedRoot(request.FullUploadedFileName, ResolveUploadBasePath(), "native upload file");

            return new CleanupChunkedUploadResponse
            {
                SessionId = request.SessionId,
                SessionDeleted = sessionDeleted,
                StagedFileDeleted = stagedDeleted,
                NativeUploadFileDeleted = nativeDeleted
            };
        }

        public object Post(StartAsyncAttach request)
        {
            if (request == null)
            {
                throw HttpError.BadRequest("Request body is required.");
            }

            if (request.RecordUri <= 0)
            {
                throw HttpError.BadRequest("RecordUri is required.");
            }

            if (string.IsNullOrWhiteSpace(request.SessionId))
            {
                throw HttpError.BadRequest("SessionId is required.");
            }

            var session = sessionStore.GetRequiredSession(request.SessionId);
            var sourcePath = ResolveAsyncAttachSourcePath(request, session);
            if (!File.Exists(sourcePath))
            {
                throw HttpError.NotFound("Async attach source file was not found.");
            }

            if (!IsPathUnderAllowedRoot(sourcePath, ResolveUploadBasePath()))
            {
                throw HttpError.Forbidden("Async attach source file is outside the allowed upload root.");
            }

            var job = new AsyncAttachJobState
            {
                JobId = Guid.NewGuid().ToString("N"),
                SessionId = session.SessionId,
                RecordUri = request.RecordUri,
                DatabaseContext = Database,
                FilePath = sourcePath,
                FileName = string.IsNullOrWhiteSpace(request.FileName) ? session.FileName : request.FileName,
                NewRevision = request.NewRevision ?? session.NewRevision,
                KeepCheckedOut = request.KeepCheckedOut ?? session.KeepCheckedOut,
                Comments = string.IsNullOrWhiteSpace(request.Comments) ? session.Comments : request.Comments,
                Status = "Queued",
                CreatedUtc = DateTime.UtcNow,
                UpdatedUtc = DateTime.UtcNow
            };

            AsyncAttachJobs[job.JobId] = job;
            CleanupExpiredAsyncAttachJobs();

            ThreadPool.QueueUserWorkItem(_ => ExecuteAsyncAttachJob(job.JobId));

            return new StartAsyncAttachResponse
            {
                JobId = job.JobId,
                StatusUrl = Request.GetAbsoluteUrl(string.Format("~/Upload/attach/{0}", job.JobId)),
                CreatedUtc = job.CreatedUtc,
                ResponseStatus = new ResponseStatus()
            };
        }

        public object Get(GetAsyncAttachStatus request)
        {
            if (request == null || string.IsNullOrWhiteSpace(request.JobId))
            {
                throw HttpError.BadRequest("JobId is required.");
            }

            CleanupExpiredAsyncAttachJobs();

            AsyncAttachJobState job;
            if (!AsyncAttachJobs.TryGetValue(request.JobId, out job))
            {
                throw HttpError.NotFound("Async attach job was not found.");
            }

            return new GetAsyncAttachStatusResponse
            {
                JobId = job.JobId,
                RecordUri = job.RecordUri,
                Status = job.Status,
                Completed = job.Completed,
                Succeeded = job.Succeeded,
                ErrorMessage = job.ErrorMessage,
                CreatedUtc = job.CreatedUtc,
                UpdatedUtc = job.UpdatedUtc,
                CompletedUtc = job.CompletedUtc,
                ResponseStatus = new ResponseStatus()
            };
        }

        private UploadChunkResponse SaveChunk(UploadChunk request)
        {
            var session = sessionStore.GetRequiredSession(request.SessionId);
            var contentRange = ParseContentRange(Request.Headers[HttpHeaders.ContentRange]);
            long offset = request.Offset;
            if (contentRange != null)
            {
                offset = contentRange.Value.From;
                if (request.TotalBytes <= 0 && contentRange.Value.TotalSize.HasValue)
                {
                    request.TotalBytes = contentRange.Value.TotalSize.Value;
                }
            }

            Stream chunkStream = Request.InputStream;
            if (Request.Files != null && Request.Files.Length > 0)
            {
                chunkStream = Request.Files[0].InputStream;
            }

            var result = sessionStore.SaveChunk(session, request.ChunkNumber, offset, request.TotalBytes, chunkStream, request.Sha256);
            return new UploadChunkResponse
            {
                SessionId = session.SessionId,
                ChunkNumber = request.ChunkNumber,
                BytesWritten = result.BytesWritten,
                TotalUploadedBytes = result.TotalUploadedBytes,
                UploadedChunkCount = result.ChunkCount,
                Sha256 = result.CalculatedHash
            };
        }

        private static bool IsReadyToComplete(UploadSessionState session, long uploadedBytes)
        {
            if (session.ExpectedChunkCount > 0 && session.ChunkMap.Count != session.ExpectedChunkCount)
            {
                return false;
            }

            if (session.TotalBytes > 0 && uploadedBytes != session.TotalBytes)
            {
                return false;
            }

            return session.ChunkMap.Count > 0;
        }

        private static ParsedContentRange? ParseContentRange(string headerValue)
        {
            if (string.IsNullOrWhiteSpace(headerValue))
            {
                return null;
            }

            string[] parts = headerValue.Split(' ');
            if (parts.Length != 2 || !string.Equals(parts[0], "bytes", StringComparison.OrdinalIgnoreCase))
            {
                throw HttpError.BadRequest("Content-Range header is invalid.");
            }

            string[] rangeAndTotal = parts[1].Split('/');
            if (rangeAndTotal.Length != 2)
            {
                throw HttpError.BadRequest("Content-Range header is invalid.");
            }

            string[] range = rangeAndTotal[0].Split('-');
            if (range.Length != 2)
            {
                throw HttpError.BadRequest("Content-Range header is invalid.");
            }
            long from, to;
            if (!long.TryParse(range[0], out from) || !long.TryParse(range[1], out to))
            {
                throw HttpError.BadRequest("Content-Range header is invalid.");
            }
            long? total = null;
            if (long.TryParse(rangeAndTotal[1], out long totalVal))
            {
                total = totalVal;
            }
            return new ParsedContentRange { From = from, To = to, TotalSize = total };
        }

        private bool DeleteIfUnderAllowedRoot(string filePath, string allowedRoot, string label)
        {
            if (string.IsNullOrWhiteSpace(filePath) || string.IsNullOrWhiteSpace(allowedRoot))
            {
                return false;
            }

            try
            {
                var fullPath = Path.GetFullPath(filePath);
                var fullAllowedRoot = Path.GetFullPath(allowedRoot)
                    .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                    + Path.DirectorySeparatorChar;

                if (!fullPath.StartsWith(fullAllowedRoot, StringComparison.OrdinalIgnoreCase))
                {
                    Logger.Warn($"[CleanupChunkedUpload] Skip delete outside allowed root ({label}): {fullPath}");
                    return false;
                }

                if (File.Exists(fullPath))
                {
                    File.Delete(fullPath);
                    Logger.Info($"[CleanupChunkedUpload] Deleted {label}: {fullPath}");
                    return true;
                }
            }
            catch (Exception ex)
            {
                Logger.Warn($"[CleanupChunkedUpload] Failed deleting {label}: {ex.Message}");
            }

            return false;
        }

        private string ResolveChunkRootPath()
        {
            var configured = ConfigurationManager.AppSettings["ChunkedUpload.TempPath"];
            if (!string.IsNullOrWhiteSpace(configured))
            {
                return configured;
            }

            return @"D:\Micro Focus Content Manager\ServiceAPIWorkpath\ChunkedUploads";
        }

        private string ResolveAsyncAttachSourcePath(StartAsyncAttach request, UploadSessionState session)
        {
            if (!string.IsNullOrWhiteSpace(request.FullUploadedFileName))
            {
                return request.FullUploadedFileName;
            }

            if (!string.IsNullOrWhiteSpace(request.StagedFilePath))
            {
                return request.StagedFilePath;
            }

            var sessionDirectory = Path.Combine(ResolveChunkRootPath(), session.SessionId);
            return Path.Combine(sessionDirectory, "assembled.bin");
        }

        private static void ExecuteAsyncAttachJob(string jobId)
        {
            AsyncAttachJobState job;
            if (!AsyncAttachJobs.TryGetValue(jobId, out job))
            {
                return;
            }

            job.Status = "Running";
            job.UpdatedUtc = DateTime.UtcNow;

            try
            {
                AsyncAttachExecutionGate.Wait();
                try
                {
                    // Run the long-running attach in a background worker so the client does not
                    // hold a proxy-limited HTTP request open.
                    // NOTE: this uses the same SDK/database context provided by the host process.
                    var db = job.DatabaseContext;
                    if (db == null)
                    {
                        throw new InvalidOperationException("Database context was not available for async attach.");
                    }

                    var record = new TRIM.SDK.Record(db, job.RecordUri);
                    if (record.Uri <= 0)
                    {
                        throw HttpError.NotFound("Record not found.");
                    }

                    var attachName = string.IsNullOrWhiteSpace(job.FileName)
                        ? Path.GetFileName(job.FilePath)
                        : Path.GetFileName(job.FileName);

                    var inputDocument = new TRIM.SDK.InputDocument(job.FilePath)
                    {
                        CheckinAs = attachName
                    };

                    var comments = string.IsNullOrWhiteSpace(job.Comments)
                        ? "Uploaded via ChunkedUploadPlugin (async attach)"
                        : job.Comments;

                    record.SetDocument(inputDocument, job.NewRevision, job.KeepCheckedOut, comments);
                    record.Save();
                }
                finally
                {
                    AsyncAttachExecutionGate.Release();
                }

                job.Status = "Succeeded";
                job.Succeeded = true;
                job.Completed = true;
                job.CompletedUtc = DateTime.UtcNow;
                job.UpdatedUtc = DateTime.UtcNow;
            }
            catch (Exception ex)
            {
                job.Status = "Failed";
                job.Succeeded = false;
                job.Completed = true;
                job.CompletedUtc = DateTime.UtcNow;
                job.UpdatedUtc = DateTime.UtcNow;
                job.ErrorMessage = ex.Message;
                Logger.Error($"[AsyncAttach] Job {job.JobId} failed: {ex}");
            }
        }

        private static void CleanupExpiredAsyncAttachJobs()
        {
            var now = DateTime.UtcNow;
            var expired = AsyncAttachJobs
                .Where(kvp => kvp.Value.Completed && kvp.Value.CompletedUtc.HasValue && (now - kvp.Value.CompletedUtc.Value) > AsyncAttachJobRetention)
                .Select(kvp => kvp.Key)
                .ToList();

            foreach (var key in expired)
            {
                AsyncAttachJobState removed;
                AsyncAttachJobs.TryRemove(key, out removed);
            }
        }

        private static int GetAsyncAttachMaxConcurrency()
        {
            int configured;
            if (int.TryParse(ConfigurationManager.AppSettings["ChunkedUpload.AsyncAttachMaxConcurrency"], out configured) && configured > 0)
            {
                return configured;
            }

            // Allow parallel async attach jobs by default while avoiding unbounded
            // resource pressure on the CM SDK host process.
            return 2;
        }

        private static bool IsPathUnderAllowedRoot(string filePath, string allowedRoot)
        {
            if (string.IsNullOrWhiteSpace(filePath) || string.IsNullOrWhiteSpace(allowedRoot))
            {
                return false;
            }

            var fullPath = Path.GetFullPath(filePath);
            var fullAllowedRoot = Path.GetFullPath(allowedRoot)
                .TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar)
                + Path.DirectorySeparatorChar;

            return fullPath.StartsWith(fullAllowedRoot, StringComparison.OrdinalIgnoreCase);
        }
    }

    internal sealed class AsyncAttachJobState
    {
        public string JobId { get; set; }
        public string SessionId { get; set; }
        public long RecordUri { get; set; }
        public TRIM.SDK.Database DatabaseContext { get; set; }
        public string FilePath { get; set; }
        public string FileName { get; set; }
        public bool NewRevision { get; set; }
        public bool KeepCheckedOut { get; set; }
        public string Comments { get; set; }
        public string Status { get; set; }
        public bool Completed { get; set; }
        public bool Succeeded { get; set; }
        public string ErrorMessage { get; set; }
        public DateTime CreatedUtc { get; set; }
        public DateTime UpdatedUtc { get; set; }
        public DateTime? CompletedUtc { get; set; }
    }
}