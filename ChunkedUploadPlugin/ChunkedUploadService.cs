
using HP.HPTRIM.Service;
using HP.HPTRIM.ServiceModel;
using TRIM.SDK;
using ServiceStack;
using System;
using System.IO;
using System.Linq;

namespace HP.HPTRIM.ServiceAPI
{
    public struct ParsedContentRange
    {
        public long From { get; set; }
        public long To { get; set; }
        public long? TotalSize { get; set; }
    }
    [Route("/UploadChunks/start", "POST")]
    public class StartChunkedUpload : IReturn<ChunkedUploadSessionResponse>
    {
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

    [Route("/UploadChunks/{SessionId}", "GET")]
    public class GetChunkedUploadStatus : IReturn<ChunkedUploadStatusResponse>
    {
        public string SessionId { get; set; }
    }

    [Route("/UploadChunks/{SessionId}/missing", "GET")]
    public class GetMissingChunks : IReturn<GetMissingChunksResponse>
    {
        public string SessionId { get; set; }
    }

    [Route("/UploadChunks/{SessionId}/cancel", "POST")]
    public class CancelChunkedUpload : IReturn<CancelChunkedUploadResponse>
    {
        public string SessionId { get; set; }
    }

    [Route("/UploadChunks/{SessionId}/chunk/{ChunkNumber}", "POST,PUT")]
    public class UploadChunk : IReturn<UploadChunkResponse>
    {
        public string SessionId { get; set; }

        public int ChunkNumber { get; set; }

        public long Offset { get; set; }

        public long TotalBytes { get; set; }

        public string Sha256 { get; set; }
    }

    [Route("/UploadChunks/{SessionId}/complete", "POST")]
    public class CompleteChunkedUpload : IReturn<CompleteChunkedUploadResponse>
    {
        public string SessionId { get; set; }
    }

    [Route("/UploadChunks/{SessionId}", "DELETE")]
    public class AbortChunkedUpload : IReturn<AbortChunkedUploadResponse>
    {
        public string SessionId { get; set; }
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
        public ResponseStatus ResponseStatus { get; set; }
    }

    public class AbortChunkedUploadResponse : IHasResponseStatus
    {
        public string SessionId { get; set; }

        public bool Deleted { get; set; }

        public ResponseStatus ResponseStatus { get; set; }
    }

    public class ChunkedUploadService : TrimServiceBase
    {
        private static readonly ServiceStack.Logging.ILog Logger = ServiceStack.Logging.LogManager.GetLogger(typeof(ChunkedUploadService));
        private readonly UploadSessionStore sessionStore = new UploadSessionStore();

        public object Post(StartChunkedUpload request)
        {
            // If RecordUri is not supplied, create a new record
            if ((!request.RecordUri.HasValue || request.RecordUri.Value <= 0))
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
                UploadChunkUrlTemplate = Request.GetAbsoluteUrl(string.Format("~/ChunkedUpload/{0}/chunk/{{chunkNumber}}", session.SessionId)),
                CompleteUrl = Request.GetAbsoluteUrl(string.Format("~/ChunkedUpload/{0}/complete", session.SessionId)),
                StatusUrl = Request.GetAbsoluteUrl(string.Format("~/ChunkedUpload/{0}", session.SessionId)),
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
            try
            {
                Logger.Info($"[CompleteChunkedUpload] SessionId={request.SessionId}, RecordUri={session.RecordUri}, FileName={session.FileName}");
                var result = sessionStore.MaterializeFile(session);
                var parts = result.Split('|');
                assembledPath = parts[0];
                assembledSha256 = parts.Length > 1 ? parts[1] : null;
                Logger.Info($"[CompleteChunkedUpload] Assembled file path: {assembledPath}, SHA256: {assembledSha256}");

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
                string trimHash = null;
                try
                {
                    trimHash = Database.CalculateDocumentHash(assembledPath);
                    Logger.Info($"[CompleteChunkedUpload] TRIM SDK Calculated Hash before checkin: {trimHash}");

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
                    UploadedBytes = new FileInfo(assembledPath).Length,
                    NewRevision = session.NewRevision,
                    KeepCheckedOut = session.KeepCheckedOut,
                    AssembledSha256 = trimHash
                };
            }
            catch (Exception ex)
            {
                Logger.Error($"[CompleteChunkedUpload] Exception: {ex}");
                throw;
            }
            finally
            {
                sessionStore.DeleteSession(request.SessionId);
            }
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

            var result = sessionStore.SaveChunk(session, request.ChunkNumber, offset, request.TotalBytes, Request.InputStream, request.Sha256);
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
    }
}