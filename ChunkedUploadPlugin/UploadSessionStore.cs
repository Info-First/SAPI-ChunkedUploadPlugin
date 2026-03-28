using ServiceStack;
using System;
using System.Collections.Generic;
using System.Configuration;
using System.IO;
using System.Linq;
using System.Runtime.Serialization;
using System.Runtime.Serialization.Json;
using System.Security.Cryptography;
using System.Text;

namespace HP.HPTRIM.ServiceAPI
{
    internal sealed class UploadSessionStore
    {
        private const string ManifestFileName = "session.json";
        private static readonly object SyncRoot = new object();
        public int[] GetMissingChunks(UploadSessionState session)
        {
            if (session == null) throw new ArgumentNullException(nameof(session));
            var uploaded = session.ChunkMap.Keys.ToHashSet();
            var expected = Enumerable.Range(0, session.ExpectedChunkCount > 0 ? session.ExpectedChunkCount : uploaded.Count).ToArray();
            return expected.Where(i => !uploaded.Contains(i)).ToArray();
        }
        public bool CancelSession(string sessionId)
        {
            ValidateSessionId(sessionId);
            string dir = GetSessionDirectory(sessionId);
            if (Directory.Exists(dir))
            {
                Directory.Delete(dir, true);
                return true;
            }
            return false;
        }
        private readonly string rootPath;

        public UploadSessionStore()
        {
            rootPath = ResolveRootPath();
            Directory.CreateDirectory(rootPath);
        }

        public UploadSessionState CreateSession(StartChunkedUpload request)
        {
            if (request == null)
            {
                throw new ArgumentNullException(nameof(request));
            }

            if (!request.StageOnly && (!request.RecordUri.HasValue || request.RecordUri.Value <= 0))
            {
                throw HttpError.BadRequest("RecordUri is required.");
            }

            if (string.IsNullOrWhiteSpace(request.FileName))
            {
                throw HttpError.BadRequest("FileName is required.");
            }

            var session = new UploadSessionState
            {
                SessionId = Guid.NewGuid().ToString("N"),
                RecordUri = request.RecordUri ?? 0,
                FileName = Path.GetFileName(request.FileName),
                ContentType = string.IsNullOrWhiteSpace(request.ContentType) ? MimeTypes.GetMimeType(request.FileName) : request.ContentType,
                TotalBytes = request.TotalBytes,
                ExpectedChunkCount = request.ExpectedChunkCount,
                NewRevision = request.NewRevision,
                KeepCheckedOut = request.KeepCheckedOut,
                Comments = request.Comments,
                CreatedUtc = DateTime.UtcNow,
                UpdatedUtc = DateTime.UtcNow,
                ExpiresUtc = DateTime.UtcNow.AddHours(GetSessionExpiryHours()),
                ChunkMap = new Dictionary<int, ChunkDescriptor>(),
                StageOnly = request.StageOnly
            };

            SaveSession(session);
            return session;
        }

        public UploadSessionState GetRequiredSession(string sessionId)
        {
            var session = GetSession(sessionId);
            if (session == null)
            {
                throw HttpError.NotFound("Upload session not found.");
            }

            if (session.ExpiresUtc < DateTime.UtcNow)
            {
                DeleteSession(sessionId);
                throw new HttpError(System.Net.HttpStatusCode.Gone, "SessionExpired", "Upload session has expired.");
            }

            return session;
        }

        public UploadSessionState GetSession(string sessionId)
        {
            ValidateSessionId(sessionId);

            string manifestPath = GetManifestPath(sessionId);
            if (!File.Exists(manifestPath))
            {
                return null;
            }

            lock (SyncRoot)
            {
                using (var stream = File.OpenRead(manifestPath))
                {
                    var serializer = new DataContractJsonSerializer(typeof(UploadSessionState));
                    return (UploadSessionState)serializer.ReadObject(stream);
                }
            }
        }

        public UploadChunkWriteResult SaveChunk(UploadSessionState session, int chunkNumber, long offset, long totalBytes, Stream input, string chunkHash)
        {
            if (session == null)
            {
                throw new ArgumentNullException(nameof(session));
            }

            if (input == null)
            {
                throw HttpError.BadRequest("Chunk content is required.");
            }

            if (chunkNumber < 0)
            {
                throw HttpError.BadRequest("ChunkNumber must be zero or greater.");
            }

            if (offset < 0)
            {
                throw HttpError.BadRequest("Offset must be zero or greater.");
            }

            if (totalBytes > 0)
            {
                session.TotalBytes = totalBytes;
            }

            string chunkPath = GetChunkPath(session.SessionId, chunkNumber);
            Directory.CreateDirectory(Path.GetDirectoryName(chunkPath));

            string calculatedHash;
            long bytesWritten;
            using (var output = File.Create(chunkPath))
            using (var sha256 = SHA256.Create())
            using (var cryptoStream = new CryptoStream(Stream.Null, sha256, CryptoStreamMode.Write))
            {
                bytesWritten = CopyChunk(input, output, cryptoStream);
                cryptoStream.FlushFinalBlock();
                calculatedHash = ToHex(sha256.Hash);
            }

            if (!string.IsNullOrWhiteSpace(chunkHash) && !string.Equals(chunkHash, calculatedHash, StringComparison.OrdinalIgnoreCase))
            {
                File.Delete(chunkPath);
                throw HttpError.BadRequest("Chunk hash does not match the uploaded content.");
            }

            if (bytesWritten == 0)
            {
                File.Delete(chunkPath);
                throw HttpError.BadRequest("Chunk content is empty.");
            }

            lock (SyncRoot)
            {
                session.ChunkMap[chunkNumber] = new ChunkDescriptor
                {
                    ChunkNumber = chunkNumber,
                    Offset = offset,
                    Length = bytesWritten,
                    Sha256 = calculatedHash,
                    FileName = Path.GetFileName(chunkPath),
                    UploadedUtc = DateTime.UtcNow
                };

                session.UpdatedUtc = DateTime.UtcNow;
                SaveSession(session);
            }

            return new UploadChunkWriteResult
            {
                BytesWritten = bytesWritten,
                CalculatedHash = calculatedHash,
                TotalUploadedBytes = session.ChunkMap.Sum(item => item.Value.Length),
                ChunkCount = session.ChunkMap.Count
            };
        }

        public string MaterializeFile(UploadSessionState session)
        {
            if (session == null)
            {
                throw new ArgumentNullException(nameof(session));
            }

            var chunks = session.ChunkMap.Values.OrderBy(item => item.ChunkNumber).ToList();
            if (chunks.Count == 0)
            {
                throw HttpError.BadRequest("No uploaded chunks were found for this session.");
            }

            if (session.ExpectedChunkCount > 0 && chunks.Count != session.ExpectedChunkCount)
            {
                throw HttpError.BadRequest("Not all chunks have been uploaded yet.");
            }

            string assembledPath = Path.Combine(GetSessionDirectory(session.SessionId), "assembled.bin");
            string sha256Hex;
            using (var output = File.Create(assembledPath))
            using (var sha256 = System.Security.Cryptography.SHA256.Create())
            {
                long expectedOffset = 0;
                using (var cryptoStream = new System.Security.Cryptography.CryptoStream(output, sha256, System.Security.Cryptography.CryptoStreamMode.Write))
                {
                    foreach (var chunk in chunks)
                    {
                        if (chunk.Offset != expectedOffset)
                        {
                            throw HttpError.BadRequest("Uploaded chunks are not contiguous.");
                        }
                        string chunkPath = GetChunkPath(session.SessionId, chunk.ChunkNumber);
                        using (var input = File.OpenRead(chunkPath))
                        {
                            input.CopyTo(cryptoStream);
                        }
                        expectedOffset += chunk.Length;
                    }
                    cryptoStream.FlushFinalBlock();
                }
                sha256Hex = ToHex(sha256.Hash);
            }
            if (session.TotalBytes > 0)
            {
                long actualBytes = new FileInfo(assembledPath).Length;
                if (actualBytes != session.TotalBytes)
                {
                    throw HttpError.BadRequest("Uploaded bytes do not match the expected total size.");
                }
            }
            return assembledPath + "|" + sha256Hex;
        }

        public void DeleteSession(string sessionId)
        {
            ValidateSessionId(sessionId);

            string sessionDirectory = GetSessionDirectory(sessionId);
            if (Directory.Exists(sessionDirectory))
            {
                Directory.Delete(sessionDirectory, true);
            }
        }

        private void SaveSession(UploadSessionState session)
        {
            string sessionDirectory = GetSessionDirectory(session.SessionId);
            Directory.CreateDirectory(sessionDirectory);

            string manifestPath = GetManifestPath(session.SessionId);
            lock (SyncRoot)
            {
                using (var stream = File.Create(manifestPath))
                {
                    var serializer = new DataContractJsonSerializer(typeof(UploadSessionState));
                    serializer.WriteObject(stream, session);
                }
            }
        }

        private string GetManifestPath(string sessionId)
        {
            return Path.Combine(GetSessionDirectory(sessionId), ManifestFileName);
        }

        private string GetChunkPath(string sessionId, int chunkNumber)
        {
            return Path.Combine(GetSessionDirectory(sessionId), string.Format("{0:D8}.part", chunkNumber));
        }

        private string GetSessionDirectory(string sessionId)
        {
            return Path.Combine(rootPath, sessionId);
        }

        private static void ValidateSessionId(string sessionId)
        {
            if (string.IsNullOrWhiteSpace(sessionId) || sessionId.Any(ch => !char.IsLetterOrDigit(ch)))
            {
                throw HttpError.BadRequest("SessionId is invalid.");
            }
        }

        private static long CopyChunk(Stream input, Stream output, Stream hashStream)
        {
            var buffer = new byte[81920];
            long total = 0;
            int bytesRead;
            while ((bytesRead = input.Read(buffer, 0, buffer.Length)) > 0)
            {
                output.Write(buffer, 0, bytesRead);
                hashStream.Write(buffer, 0, bytesRead);
                total += bytesRead;
            }

            return total;
        }

        private static string ToHex(byte[] bytes)
        {
            var builder = new StringBuilder(bytes.Length * 2);
            for (int index = 0; index < bytes.Length; index++)
            {
                builder.Append(bytes[index].ToString("x2"));
            }

            return builder.ToString();
        }

        private string ResolveRootPath()
        {
            string configuredPath = ConfigurationManager.AppSettings["ChunkedUpload.TempPath"];
            if (!string.IsNullOrWhiteSpace(configuredPath))
            {
                return configuredPath;
            }

            // Centralized path in the ServiceAPI Workpath so permissions are consistent
            // and it isn't dependent on volatile user temp profiles.
            return @"D:\Micro Focus Content Manager\ServiceAPIWorkpath\ChunkedUploads";
        }

        private static int GetSessionExpiryHours()
        {
            int configuredHours;
            if (int.TryParse(ConfigurationManager.AppSettings["ChunkedUpload.SessionExpiryHours"], out configuredHours) && configuredHours > 0)
            {
                return configuredHours;
            }

            return 24;
        }
    }

    internal sealed class UploadChunkWriteResult
    {
        public long BytesWritten { get; set; }

        public int ChunkCount { get; set; }

        public string CalculatedHash { get; set; }

        public long TotalUploadedBytes { get; set; }
    }

    [DataContract]
    internal sealed class UploadSessionState
    {
        [DataMember(Order = 1)]
        public string SessionId { get; set; }

        [DataMember(Order = 2)]
        public long RecordUri { get; set; }

        [DataMember(Order = 3)]
        public string FileName { get; set; }

        [DataMember(Order = 4)]
        public string ContentType { get; set; }

        [DataMember(Order = 5)]
        public long TotalBytes { get; set; }

        [DataMember(Order = 6)]
        public int ExpectedChunkCount { get; set; }

        [DataMember(Order = 7)]
        public bool NewRevision { get; set; }

        [DataMember(Order = 8)]
        public bool KeepCheckedOut { get; set; }

        [DataMember(Order = 9)]
        public string Comments { get; set; }

        [DataMember(Order = 10)]
        public DateTime CreatedUtc { get; set; }

        [DataMember(Order = 11)]
        public DateTime UpdatedUtc { get; set; }

        [DataMember(Order = 12)]
        public DateTime ExpiresUtc { get; set; }

        [DataMember(Order = 13)]
        public Dictionary<int, ChunkDescriptor> ChunkMap { get; set; }

        [DataMember(Order = 14)]
        public bool StageOnly { get; set; }
    }

    [DataContract]
    internal sealed class ChunkDescriptor
    {
        [DataMember(Order = 1)]
        public int ChunkNumber { get; set; }

        [DataMember(Order = 2)]
        public long Offset { get; set; }

        [DataMember(Order = 3)]
        public long Length { get; set; }

        [DataMember(Order = 4)]
        public string FileName { get; set; }

        [DataMember(Order = 5)]
        public string Sha256 { get; set; }

        [DataMember(Order = 6)]
        public DateTime UploadedUtc { get; set; }
    }
}
