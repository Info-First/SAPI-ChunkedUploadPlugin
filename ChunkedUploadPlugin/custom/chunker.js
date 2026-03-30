const CHUNKED_UPLOAD_VERBOSE_STORAGE_KEY = 'cm_chunked_upload_verbose';
const CHUNKED_UPLOAD_DEBUG_BANNER_ID = 'cm-chunked-upload-debug-banner';
const SERVICE_API_BASE_URL = '/contentmanager/serviceapi';
const JSON_ACCEPT_HEADERS = { 'Accept': 'application/json' };
const CHUNKED_UPLOAD_ROUTE_ROOT = (window.CHUNKED_UPLOAD_ROUTE_ROOT || 'Upload').replace(/^\/+|\/+$/g, '');
const CHUNKED_UPLOAD_DEFAULT_MAX_CONCURRENT = 4;
const CHUNKED_UPLOAD_MAX_CONCURRENT_STORAGE_KEY = 'cm_chunked_upload_max_concurrent';
const CHUNKED_UPLOAD_RESUME_KEY_PREFIX = 'cm_upload_staged_';
const CHUNKED_UPLOAD_RESUME_SWEEP_MARKER_KEY = 'cm_upload_staged_last_sweep_utc';
const CHUNKED_UPLOAD_RESUME_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHUNKED_UPLOAD_RESUME_SWEEP_MAX_KEYS = 25;
const CHUNKED_UPLOAD_SESSION_ID_REGEX = /^[a-z0-9]{32}$/i;

let CHUNKED_UPLOAD_VERBOSE = false;

let _chunkedUploadResumeSweepPromise = null;

function clampChunkedUploadConcurrency(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return CHUNKED_UPLOAD_DEFAULT_MAX_CONCURRENT;
    if (parsed < 1) return 1;
    if (parsed > 8) return 8;
    return parsed;
}

function coerceChunkedUploadBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    return fallback;
}

function resolveChunkedUploadVerbose() {
    if (window.CHUNKED_UPLOAD_VERBOSE !== undefined && window.CHUNKED_UPLOAD_VERBOSE !== null) {
        return coerceChunkedUploadBoolean(window.CHUNKED_UPLOAD_VERBOSE, false);
    }

    try {
        const persistedValue = localStorage.getItem(CHUNKED_UPLOAD_VERBOSE_STORAGE_KEY);
        if (persistedValue !== null) {
            return coerceChunkedUploadBoolean(persistedValue, false);
        }
    } catch (e) {
        return false;
    }

    return false;
}

CHUNKED_UPLOAD_VERBOSE = resolveChunkedUploadVerbose();

function getPersistedChunkedUploadConcurrency() {
    try {
        return localStorage.getItem(CHUNKED_UPLOAD_MAX_CONCURRENT_STORAGE_KEY);
    } catch (e) {
        return null;
    }
}

function resolveChunkedUploadConcurrency() {
    // Priority: explicit page/global override, then persisted user setting, then default.
    if (window.CHUNKED_UPLOAD_MAX_CONCURRENT !== undefined && window.CHUNKED_UPLOAD_MAX_CONCURRENT !== null) {
        return clampChunkedUploadConcurrency(window.CHUNKED_UPLOAD_MAX_CONCURRENT);
    }

    const persistedValue = getPersistedChunkedUploadConcurrency();
    if (persistedValue !== null) {
        return clampChunkedUploadConcurrency(persistedValue);
    }

    return CHUNKED_UPLOAD_DEFAULT_MAX_CONCURRENT;
}

window.setChunkedUploadConcurrency = function (value) {
    const normalized = clampChunkedUploadConcurrency(value);
    try {
        localStorage.setItem(CHUNKED_UPLOAD_MAX_CONCURRENT_STORAGE_KEY, String(normalized));
    } catch (e) {
        logDebug('Could not persist chunk upload concurrency:', e);
    }
    return normalized;
};

window.getChunkedUploadConcurrency = function () {
    return resolveChunkedUploadConcurrency();
};

function getChunkedUploadDebugBanner() {
    let banner = document.getElementById(CHUNKED_UPLOAD_DEBUG_BANNER_ID);
    if (banner) return banner;

    banner = document.createElement('div');
    banner.id = CHUNKED_UPLOAD_DEBUG_BANNER_ID;
    banner.style.cssText = [
        'display:none',
        'position:fixed',
        'bottom:0',
        'left:0',
        'right:0',
        'z-index:100000',
        'background:#fff4d6',
        'border-top:1px solid #e0b252',
        'color:#553600',
        'font:600 12px/1.4 Segoe UI, Tahoma, sans-serif',
        'padding:10px 16px',
        'display:flex',
        'align-items:center',
        'justify-content:space-between',
        'gap:16px',
        'box-shadow:0 2px 10px rgba(0,0,0,0.08)'
    ].join(';');

    const message = document.createElement('div');
    message.id = 'cm-chunked-upload-debug-banner-message';
    banner.appendChild(message);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;align-items:center;gap:12px;';

    const turnOffButton = document.createElement('button');
    turnOffButton.type = 'button';
    turnOffButton.className = 'btn btn-flat btn-secondary';
    turnOffButton.textContent = 'Turn off';
    turnOffButton.onclick = function () {
        window.setChunkedUploadVerbose(false);
    };
    actions.appendChild(turnOffButton);

    banner.appendChild(actions);
    document.body.appendChild(banner);
    return banner;
}

function updateChunkedUploadDebugBanner() {
    if (!document.body) return;

    const banner = getChunkedUploadDebugBanner();
    const message = banner.querySelector('#cm-chunked-upload-debug-banner-message');
    if (!CHUNKED_UPLOAD_VERBOSE) {
        banner.style.display = 'none';
        return;
    }

    if (message) {
        message.textContent = 'Chunked Upload debug mode is ON. Verbose browser logging and diagnostic helpers are enabled.';
    }
    banner.style.display = 'flex';
}

window.setChunkedUploadVerbose = function (value) {
    const normalized = coerceChunkedUploadBoolean(value, false);
    CHUNKED_UPLOAD_VERBOSE = normalized;
    window.CHUNKED_UPLOAD_VERBOSE = normalized;
    try {
        localStorage.setItem(CHUNKED_UPLOAD_VERBOSE_STORAGE_KEY, String(normalized));
    } catch (e) {
        // Ignore localStorage write issues.
    }

    updateChunkedUploadDebugBanner();
    return normalized;
};

window.getChunkedUploadVerbose = function () {
    return CHUNKED_UPLOAD_VERBOSE === true;
};

function installChunkedUploadDebugBanner() {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', updateChunkedUploadDebugBanner, { once: true });
        return;
    }

    updateChunkedUploadDebugBanner();
}

function logDebug() {
    if (!CHUNKED_UPLOAD_VERBOSE) return;
    console.log.apply(console, arguments);
}

function createFormDataWithCsrf() {
    const formData = new FormData();
    const csrfToken = getCsrfToken();
    if (csrfToken) formData.append('__RequestVerificationToken', csrfToken);
    return formData;
}

function buildUploadRoute(path) {
    const suffix = (path || '').replace(/^\/+/, '');
    return `${SERVICE_API_BASE_URL}/${CHUNKED_UPLOAD_ROUTE_ROOT}/${suffix}`;
}

function isValidChunkedUploadSessionId(value) {
    return CHUNKED_UPLOAD_SESSION_ID_REGEX.test(String(value || '').trim());
}

function shouldRunChunkedUploadResumeSweep() {
    try {
        const lastSweepRaw = localStorage.getItem(CHUNKED_UPLOAD_RESUME_SWEEP_MARKER_KEY);
        const lastSweep = parseInt(lastSweepRaw || '0', 10);
        if (!Number.isFinite(lastSweep) || lastSweep <= 0) {
            return true;
        }

        return (Date.now() - lastSweep) >= CHUNKED_UPLOAD_RESUME_SWEEP_INTERVAL_MS;
    } catch (e) {
        return false;
    }
}

function markChunkedUploadResumeSweepRun() {
    try {
        localStorage.setItem(CHUNKED_UPLOAD_RESUME_SWEEP_MARKER_KEY, String(Date.now()));
    } catch (e) {
        // Ignore localStorage write issues.
    }
}

function getChunkedUploadResumeKeys() {
    const keys = [];
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || key.indexOf(CHUNKED_UPLOAD_RESUME_KEY_PREFIX) !== 0) continue;
        keys.push(key);
        if (keys.length >= CHUNKED_UPLOAD_RESUME_SWEEP_MAX_KEYS) break;
    }
    return keys;
}

async function cleanupStaleChunkedUploadResumeKeys() {
    if (!shouldRunChunkedUploadResumeSweep()) {
        return;
    }

    let resumeKeys = [];
    try {
        resumeKeys = getChunkedUploadResumeKeys();
    } catch (e) {
        return;
    }

    for (let i = 0; i < resumeKeys.length; i++) {
        const key = resumeKeys[i];
        let sessionId = '';
        try {
            sessionId = String(localStorage.getItem(key) || '').trim();
        } catch (e) {
            continue;
        }

        if (!sessionId || !isValidChunkedUploadSessionId(sessionId)) {
            try { localStorage.removeItem(key); } catch (e) { }
            continue;
        }

        try {
            const res = await fetch(buildUploadRoute(sessionId), {
                method: 'GET',
                credentials: 'include',
                headers: JSON_ACCEPT_HEADERS
            });

            // Remove keys only when the service confirms session is invalid/expired.
            if (res.status === 404 || res.status === 410 || res.status === 400) {
                try { localStorage.removeItem(key); } catch (e) { }
            }
        } catch (e) {
            // Network/transient errors should not drop resume state.
        }
    }

    markChunkedUploadResumeSweepRun();
}

function ensureChunkedUploadResumeSweep() {
    if (_chunkedUploadResumeSweepPromise) {
        return _chunkedUploadResumeSweepPromise;
    }

    _chunkedUploadResumeSweepPromise = cleanupStaleChunkedUploadResumeKeys().finally(function () {
        _chunkedUploadResumeSweepPromise = null;
    });

    return _chunkedUploadResumeSweepPromise;
}

function getChunkedUploadMessage(key, fallback) {
    const value =
        (typeof HP !== 'undefined' && HP.HPTRIM && HP.HPTRIM.Messages)
            ? HP.HPTRIM.Messages[key]
            : null;

    return (typeof value === 'string' && value.trim()) ? value : fallback;
}

function getChunkedUploadOverlayText() {
    const cancelText =
        getChunkedUploadMessage('web_dp_cancelText', null) ||
        getChunkedUploadMessage('web_cancel', 'Cancel');
    const uploadText = getChunkedUploadMessage('web_upload', 'Upload');
    const completeText = getChunkedUploadMessage('web_complete', 'Complete');
    const uploadCancelledText = getChunkedUploadMessage('web_upload_cancelled', 'Upload cancelled');
    const uploadFailedText = getChunkedUploadMessage('web_upload_failed', 'Upload failed');
    const uploadStartFailedText = getChunkedUploadMessage('web_upload_start_failed', 'Failed to start upload session');
    const missingChunksFailedText = getChunkedUploadMessage('web_upload_missing_failed', 'Failed to query missing chunks');
    const sessionExpiredText = getChunkedUploadMessage('web_session_may_have_expired', 'The session may have expired');
    const completeFailedPrefixText = getChunkedUploadMessage('web_upload_complete_failed_prefix', 'Failed to complete upload (HTTP ');
    const networkChunkErrorText = getChunkedUploadMessage('web_network_error_during_upload', 'Network error during chunk upload');
    const httpStatusPrefixText = getChunkedUploadMessage('web_http_status_prefix', 'HTTP');
    const uploadProgressText = getChunkedUploadMessage('web_upload_progress', 'Upload Progress');
    const uploadingFilesText = getChunkedUploadMessage('web_uploading_files', 'Uploading files');
    const resumingUploadText = getChunkedUploadMessage('web_resuming_upload', 'Resuming upload');
    const preparingText = getChunkedUploadMessage('web_preparing', 'Preparing');

    return {
        cancel: cancelText,
        cancelling: cancelText + '\u2026',
        preparing: preparingText + '\u2026',
        uploadComplete: uploadText + ' ' + completeText,
        uploadCancelled: uploadCancelledText,
        uploadFailedPrefix: uploadFailedText + ': ',
        uploadStartFailed: uploadStartFailedText,
        missingChunksFailed: missingChunksFailedText,
        sessionMayHaveExpired: sessionExpiredText,
        completeFailedPrefix: completeFailedPrefixText,
        networkChunkError: networkChunkErrorText,
        httpStatusPrefix: httpStatusPrefixText,
        uploadProgress: uploadProgressText,
        uploadingFiles: uploadingFilesText,
        resumingUpload: resumingUploadText
    };
}

function getChunkedUploadProgressMessage(percent, isResuming) {
    const text = getChunkedUploadOverlayText();
    const prefix = isResuming ? text.resumingUpload : text.uploadingFiles;
    return prefix + ' ' + percent + '%';
}

logDebug("🚀 CHUNKED UPLOAD SCRIPT IS LOADED AND RUNNING!");
installChunkedUploadDebugBanner();
void ensureChunkedUploadResumeSweep();

// ---------------------------------------------------------------------------
// Post-save hash verification
// After the chunked upload completes, we store the expected document hash here
// keyed by the RecordFilePath token (e.g. "1168\upload.bin").
// An XHR interceptor watches for the CM record-save response, extracts the
// new record URI, then queries DocumentHash via ServiceAPI and compares.
// ---------------------------------------------------------------------------
const _chunkedUploadPendingOps = {};
const _chunkedUploadPendingByOriginalFile = {};
const _chunkedUploadPendingDeleteConfirmation = {
    originalFileNames: [],
    clearTimer: null,
    setAtUtc: 0
};

function clearPendingChunkedUploadDeleteConfirmation() {
    if (_chunkedUploadPendingDeleteConfirmation.clearTimer) {
        clearTimeout(_chunkedUploadPendingDeleteConfirmation.clearTimer);
        _chunkedUploadPendingDeleteConfirmation.clearTimer = null;
    }
    _chunkedUploadPendingDeleteConfirmation.originalFileNames = [];
    _chunkedUploadPendingDeleteConfirmation.setAtUtc = 0;
}

function setPendingChunkedUploadDeleteConfirmation(originalFileNames) {
    clearPendingChunkedUploadDeleteConfirmation();
    const uniqueNames = [];
    (originalFileNames || []).forEach(function (name) {
        const normalized = String(name || '').trim();
        if (!normalized) return;
        if (uniqueNames.indexOf(normalized) === -1) {
            uniqueNames.push(normalized);
        }
    });
    _chunkedUploadPendingDeleteConfirmation.originalFileNames = uniqueNames;
    _chunkedUploadPendingDeleteConfirmation.setAtUtc = Date.now();
    _chunkedUploadPendingDeleteConfirmation.clearTimer = setTimeout(function () {
        clearPendingChunkedUploadDeleteConfirmation();
    }, 15000);
}

function consumePendingChunkedUploadDeleteConfirmation() {
    const originalFileNames = _chunkedUploadPendingDeleteConfirmation.originalFileNames.slice();
    clearPendingChunkedUploadDeleteConfirmation();
    return originalFileNames;
}

function extractOriginalFileName(raw) {
    if (raw === undefined || raw === null) return '';
    return String(raw).replace(/(^"|"$)/g, '').trim();
}

function resolveOriginalFileNamesFromDeleteAction(deleteLink, directItem) {
    const names = [];

    const directName = extractOriginalFileName(directItem && directItem.OriginalFileName !== undefined
        ? (typeof directItem.OriginalFileName === 'function' ? directItem.OriginalFileName() : directItem.OriginalFileName)
        : '');
    if (directName) {
        names.push(directName);
        return names;
    }

    if (typeof ko === 'undefined' || !ko.dataFor) {
        return names;
    }

    let current = deleteLink;
    let depth = 0;
    while (current && depth < 12) {
        const vm = ko.dataFor(current);
        if (vm && typeof vm.selections === 'function') {
            const selected = vm.selections() || [];
            selected.forEach(function (fileItem) {
                const name = extractOriginalFileName(fileItem && fileItem.OriginalFileName);
                if (name && names.indexOf(name) === -1) {
                    names.push(name);
                }
            });

            if (names.length > 0) {
                return names;
            }
        }
        current = current.parentElement;
        depth++;
    }

    return names;
}

function normalizeOriginalFileName(value) {
    if (value === undefined || value === null) return '';
    let normalized = String(value).trim();
    if ((normalized.startsWith('"') && normalized.endsWith('"')) || (normalized.startsWith("'") && normalized.endsWith("'"))) {
        normalized = normalized.slice(1, -1);
    }
    return normalized.toLowerCase();
}

function registerPendingUpload(uploadedFileName, pending, originalFileName) {
    if (!uploadedFileName || !pending) return;
    _chunkedUploadPendingOps[uploadedFileName] = pending;

    const originalKey = normalizeOriginalFileName(originalFileName);
    if (originalKey) {
        _chunkedUploadPendingByOriginalFile[originalKey] = uploadedFileName;
    }
}

function unregisterPendingUpload(uploadedFileName, pending) {
    if (uploadedFileName && _chunkedUploadPendingOps[uploadedFileName]) {
        delete _chunkedUploadPendingOps[uploadedFileName];
    }

    const originalKey = normalizeOriginalFileName(pending && pending.originalFileName);
    if (originalKey && _chunkedUploadPendingByOriginalFile[originalKey] === uploadedFileName) {
        delete _chunkedUploadPendingByOriginalFile[originalKey];
    }
}

async function abortChunkedUploadSessionForOriginalFile(originalFileName) {
    const originalKey = normalizeOriginalFileName(originalFileName);
    if (!originalKey) return;

    const uploadedFileName = _chunkedUploadPendingByOriginalFile[originalKey];
    if (!uploadedFileName) return;

    const pending = _chunkedUploadPendingOps[uploadedFileName];
    if (!pending || !pending.sessionId) {
        unregisterPendingUpload(uploadedFileName, pending || { originalFileName: originalFileName });
        return;
    }

    try {
        const res = await fetch(buildUploadRoute(pending.sessionId), {
            method: 'DELETE',
            credentials: 'include',
            headers: JSON_ACCEPT_HEADERS
        });

        if (!res.ok) {
            logDebug(`Delete session call failed for ${pending.sessionId} (HTTP ${res.status}).`);
        } else {
            logDebug(`Deleted chunked upload session ${pending.sessionId} for file ${originalFileName}.`);
        }
    } catch (e) {
        logDebug('Delete session call failed:', e);
    } finally {
        if (pending.fileCacheKey) {
            localStorage.removeItem(pending.fileCacheKey);
        }
        unregisterPendingUpload(uploadedFileName, pending);
    }
}

async function cleanupChunkedUpload(pending) {
    try {
        if (!pending || typeof pending !== 'object') {
            return;
        }

        const formData = createFormDataWithCsrf();
        if (pending.sessionId) formData.append('SessionId', pending.sessionId);
        if (pending.stagedFilePath) formData.append('StagedFilePath', pending.stagedFilePath);
        if (pending.fullUploadedFileName) formData.append('FullUploadedFileName', pending.fullUploadedFileName);

        const res = await fetch(buildUploadRoute('cleanup'), {
            method: 'POST',
            credentials: 'include',
            headers: JSON_ACCEPT_HEADERS,
            body: formData
        });

        if (!res.ok) {
            console.warn(`Cleanup call failed (HTTP ${res.status}).`);
            return;
        }

        // Some ServiceAPI responses can be empty (or non-JSON) even on success.
        // Avoid throwing when body is blank.
        const bodyText = await res.text();
        if (!bodyText || !bodyText.trim()) {
            logDebug(`Cleanup call succeeded (HTTP ${res.status}) with empty response body.`);
            return;
        }

        try {
            const data = JSON.parse(bodyText);
            logDebug('Cleanup result:', data);
        } catch (parseError) {
            logDebug(`Cleanup call succeeded (HTTP ${res.status}) with non-JSON response body.`);
        }
    } catch (e) {
        console.warn('Cleanup request failed:', e);
    }
}

async function abortChunkedUploadSessionById(sessionId) {
    if (!sessionId) return;

    try {
        const res = await fetch(buildUploadRoute(sessionId), {
            method: 'DELETE',
            credentials: 'include',
            headers: JSON_ACCEPT_HEADERS
        });

        if (!res.ok) {
            logDebug(`Abort session call failed for ${sessionId} (HTTP ${res.status}).`);
        }
    } catch (e) {
        logDebug('Abort session call failed:', e);
    }
}

(function installSaveInterceptor() {
    if (window.__chunkedUploadSaveInterceptorInstalled === true) {
        return;
    }
    window.__chunkedUploadSaveInterceptorInstalled = true;

    const OriginalXHR = window.__chunkedUploadOriginalXHR || window.XMLHttpRequest;
    window.__chunkedUploadOriginalXHR = OriginalXHR;

    function PatchedXHR() {
        const xhr = new OriginalXHR();
        let _method = '';
        let _url = '';

        const originalOpen = xhr.open.bind(xhr);
        xhr.open = function (method, url) {
            _method = (method || '').toUpperCase();
            _url = url || '';
            return originalOpen.apply(xhr, arguments);
        };

        const originalSend = xhr.send.bind(xhr);
        xhr.send = function (body) {
            const isRecordSaveCall =
                _method === 'POST' &&
                (/\/ServiceApi\/Record\b/i.test(_url) || /\/ServiceApi\/RecordCheckIn\b/i.test(_url) || /\/ServiceApi\/Record\/\d+\/CheckIn\b/i.test(_url));

            if (isRecordSaveCall) {
                xhr.addEventListener('load', async function () {
                    try {
                        if (xhr.status < 200 || xhr.status >= 300) return;
                        const data = JSON.parse(xhr.responseText);
                        if (!data || !data.Results || !data.Results.length) return;
                        const uri = data.Results[0].Uri;
                        if (!uri) return;

                        const pendingKeys = Object.keys(_chunkedUploadPendingOps);
                        if (!pendingKeys.length) return;

                        let pending = null;
                        let matchedKey = null;
                        for (const key of pendingKeys) {
                            if (typeof body === 'string' && body.includes(key.replace(/\\/g, '\\\\'))) {
                                pending = _chunkedUploadPendingOps[key];
                                matchedKey = key;
                                break;
                            }
                        }

                        if (!pending) {
                            matchedKey = pendingKeys[0];
                            pending = _chunkedUploadPendingOps[matchedKey];
                        }

                        if (!pending) return;

                        unregisterPendingUpload(matchedKey, pending);

                        if (pending.expectedHash) {
                            await verifyDocumentHash(uri, pending.expectedHash);
                        }

                        await cleanupChunkedUpload(pending);
                    } catch (e) {
                        console.warn('Post-save hash verification error:', e);
                    }
                });
            }
            return originalSend.apply(xhr, arguments);
        };

        return xhr;
    }

    PatchedXHR.prototype = OriginalXHR.prototype;
    window.XMLHttpRequest = PatchedXHR;
})();

async function verifyDocumentHash(recordUri, expectedHash) {
    try {
        const url = `${SERVICE_API_BASE_URL}/Record/${recordUri}?properties=RecordDocumentHash,DocumentHash`;

        const resolveHashValue = function (raw) {
            if (!raw) return '';
            if (typeof raw === 'string') return raw;
            return raw.Value || raw.StringValue || raw.Hash || '';
        };

        const res = await fetch(url, { credentials: 'include', headers: JSON_ACCEPT_HEADERS });
        if (!res.ok) {
            console.warn(`Hash verification: could not fetch record ${recordUri} (HTTP ${res.status})`);
            return;
        }

        const data = await res.json();
        const rec = data.Results && data.Results[0];
        if (!rec) {
            console.warn('Hash verification: no Results[0] in response.');
            return;
        }

        const recordHash =
            resolveHashValue(rec.RecordDocumentHash) ||
            resolveHashValue(rec.DocumentHash);

        if (!recordHash) {
            console.warn('Hash verification: hash value is empty in response. Final Results[0]:', JSON.stringify(rec, null, 2));
            return;
        }

        if (recordHash.toLowerCase() === expectedHash.toLowerCase()) {
            console.log(`%c✅ Document hash verified for record ${recordUri}. Hash: ${recordHash}`, 'color: green; font-weight: bold;');
        } else {
            console.error(`❌ Hash MISMATCH for record ${recordUri}! Expected: ${expectedHash} | Got: ${recordHash}`);
        }
    } catch (e) {
        console.warn('Hash verification fetch failed:', e);
    }
}

/**
 * Helper function to retrieve the CSRF Token from the DOM
 * Content Manager Web Client ServiceAPI heavily enforces Anti-Forgery tokens on POST/PUT endpoints.
 */
function getCsrfToken() {
    // 1. Check the official Content Manager global HPRMWebConfig object
    if (typeof HPRMWebConfig !== 'undefined') {
        if (HPRMWebConfig.requireAntiForgeryToken === true && HPRMWebConfig.antiForgeryToken) {
            return HPRMWebConfig.antiForgeryToken;
        }
    }

    // 2. Fallback to older Web Client objects just in case
    if (window.HP && window.HP.HPTRIM) {
        if (window.HP.HPTRIM.trimOptions && window.HP.HPTRIM.trimOptions.antiForgeryToken) {
            return window.HP.HPTRIM.trimOptions.antiForgeryToken;
        }
    }

    // 3. Check the global __RequestVerificationToken object
    if (window.__RequestVerificationToken) {
        return window.__RequestVerificationToken;
    }

    // 4. Fallback to DOM elements
    const inputElement = document.querySelector('input[name="__RequestVerificationToken"]');
    if (inputElement) {
        return inputElement.value;
    }
    
    return null;
}

function createChunkedUploadCancelledError() {
    const error = new Error(getChunkedUploadOverlayText().uploadCancelled);
    error.isChunkedUploadCancelled = true;
    return error;
}

function isChunkedUploadCancelled(error) {
    return !!(error && (error.isChunkedUploadCancelled === true || error.name === 'AbortError'));
}

function resolveValueCandidate(source, keys) {
    if (!source) return undefined;

    for (let i = 0; i < keys.length; i++) {
        const key = keys[i];
        if (!(key in source)) continue;
        const raw = source[key];
        try {
            return (typeof raw === 'function') ? raw.call(source) : raw;
        } catch (e) {
            return raw;
        }
    }

    return undefined;
}

function coerceBoolean(value, fallback) {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'string') {
        const normalized = value.trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
    }
    return fallback;
}

function coerceString(value, fallback) {
    if (value === undefined || value === null) return fallback;
    return String(value);
}

function readCheckInOptionsFromModel(model) {
    if (!model || typeof model !== 'object') return null;

    const newRevision = resolveValueCandidate(model, ['makeNewRevision', 'newRevision', 'NewRevision']);
    const keepCheckedOut = resolveValueCandidate(model, ['keepCheckedOut', 'keepBookedOut', 'KeepCheckedOut']);
    const comments = resolveValueCandidate(model, ['comments', 'Comments']);

    if (newRevision === undefined && keepCheckedOut === undefined && comments === undefined) {
        return null;
    }

    return {
        newRevision: coerceBoolean(newRevision, true),
        keepCheckedOut: coerceBoolean(keepCheckedOut, false),
        comments: coerceString(comments, '')
    };
}

function resolveCheckInOptionsFromContext(sourceElement) {
    // Defaults match current behavior when no Check In context is detected.
    const defaults = {
        newRevision: true,
        keepCheckedOut: false,
        comments: ''
    };

    if (typeof ko !== 'undefined' && sourceElement) {
        let current = sourceElement;
        let depth = 0;
        while (current && depth < 16) {
            const model = ko.dataFor(current);
            const options = readCheckInOptionsFromModel(model);
            if (options) {
                return options;
            }
            current = current.parentElement;
            depth++;
        }
    }

    // Fallback to app-level Check In form when KO context chain does not expose options.
    const rootCheckInForm = window.root && window.root.checkInForm;
    const rootOptions = readCheckInOptionsFromModel(rootCheckInForm);
    if (rootOptions) {
        return rootOptions;
    }

    return defaults;
}

function cancelChunkedUploadState(state) {
    if (!state || state.cancelled) return;

    state.cancelled = true;

    if (state.retryTimer) {
        clearTimeout(state.retryTimer);
        state.retryTimer = null;
    }

    if (state.abortController) {
        try {
            state.abortController.abort();
        } catch (e) {
            logDebug('AbortController abort failed:', e);
        }
    }

    if (state.activeXhr) {
        try {
            state.activeXhr.abort();
        } catch (e) {
            logDebug('XHR abort failed:', e);
        }
        state.activeXhr = null;
    }
}

async function notifyChunkedUploadCancelled(state) {
    if (!state) return;

    if (state.fileCacheKey) {
        localStorage.removeItem(state.fileCacheKey);
    }

    if (!state.sessionId) {
        return;
    }

    try {
        const formData = createFormDataWithCsrf();
        const res = await fetch(buildUploadRoute(`${state.sessionId}/cancel`), {
            method: 'POST',
            credentials: 'include',
            headers: JSON_ACCEPT_HEADERS,
            body: formData
        });

        if (!res.ok) {
            logDebug(`Cancel call failed for session ${state.sessionId} (HTTP ${res.status}).`);
        }
    } catch (e) {
        logDebug('Cancel call failed:', e);
    }
}

function uploadChunkWithRetry(url, chunk, offset, totalBytes, cancellationState, maxRetries = 3) {
    return new Promise((resolve, reject) => {
        const attemptUpload = (attempt) => {
            if (cancellationState && cancellationState.cancelled) {
                reject(createChunkedUploadCancelledError());
                return;
            }

            const xhr = new XMLHttpRequest();
            if (cancellationState) {
                cancellationState.activeXhr = xhr;
            }

            xhr.open('POST', url, true);
            xhr.withCredentials = true;

            const formData = createFormDataWithCsrf();
            formData.append('Offset', String(offset));
            formData.append('TotalBytes', String(totalBytes));
            formData.append('chunk', chunk, 'chunk.bin');

            xhr.onload = function () {
                if (cancellationState) {
                    cancellationState.activeXhr = null;
                }

                if (xhr.status >= 200 && xhr.status < 300) {
                    resolve(xhr.responseText);
                    return;
                }

                if (attempt >= maxRetries) {
                    console.error(`Max retries (${maxRetries}) reached for URL: ${url}`);
                    const text = getChunkedUploadOverlayText();
                    reject(new Error(`${text.httpStatusPrefix} ${xhr.status}: ${xhr.statusText}`));
                    return;
                }

                const delay = 1000 * Math.pow(2, attempt);
                console.warn(`Chunk upload failed. Retrying in ${delay}ms... (Attempt ${attempt + 1} of ${maxRetries})`);
                if (cancellationState) {
                    cancellationState.retryTimer = setTimeout(function () {
                        cancellationState.retryTimer = null;
                        attemptUpload(attempt + 1);
                    }, delay);
                } else {
                    setTimeout(() => attemptUpload(attempt + 1), delay);
                }
            };

            xhr.onerror = function () {
                if (cancellationState && cancellationState.cancelled) {
                    cancellationState.activeXhr = null;
                    reject(createChunkedUploadCancelledError());
                    return;
                }

                if (cancellationState) {
                    cancellationState.activeXhr = null;
                }

                if (attempt >= maxRetries) {
                    console.error(`Max retries (${maxRetries}) reached for URL: ${url}`);
                    reject(new Error(getChunkedUploadOverlayText().networkChunkError));
                    return;
                }

                const delay = 1000 * Math.pow(2, attempt);
                console.warn(`Chunk upload failed. Retrying in ${delay}ms... (Attempt ${attempt + 1} of ${maxRetries})`);
                if (cancellationState) {
                    cancellationState.retryTimer = setTimeout(function () {
                        cancellationState.retryTimer = null;
                        attemptUpload(attempt + 1);
                    }, delay);
                } else {
                    setTimeout(() => attemptUpload(attempt + 1), delay);
                }
            };

            xhr.onabort = function () {
                if (cancellationState) {
                    cancellationState.activeXhr = null;
                }
                reject(createChunkedUploadCancelledError());
            };

            xhr.send(formData);
        };

        attemptUpload(0);
    });
}

/**
 * Uploads a file in chunks to the Content Manager ServiceAPI with resumability and retries.
 * @param {File} file - The file object from the <input type="file">
 * @param {number} recordUri - The target Record URI
 * @param {function} onProgress - Optional callback for progress updates
 */
async function uploadFileInChunks(file, onProgress, cancellationState, checkInOptions, hasRetriedAfterContiguousError) {
    const chunkSize = 4 * 1024 * 1024; // 4MB chunk size
    const expectedChunks = Math.ceil(file.size / chunkSize);
    
    // Create a unique cache key for this specific file
    const fileCacheKey = `cm_upload_staged_${file.name}_${file.size}_${file.lastModified}`;
    if (cancellationState) {
        cancellationState.fileCacheKey = fileCacheKey;
    }
    let sessionId = localStorage.getItem(fileCacheKey);
    let isResumingUpload = !!sessionId;

    try {
        // Step 1: Start or Resume the Session
        if (!sessionId) {
            logDebug("No existing session found. Starting a new upload session...");
            // Must use FormData so ValidateHttpAntiForgeryToken can find the token as a form field.
            const startFormData = createFormDataWithCsrf();
            startFormData.append('StageOnly', 'true');
            startFormData.append('FileName', file.name);
            startFormData.append('ContentType', file.type || 'application/octet-stream');
            startFormData.append('TotalBytes', String(file.size));
            startFormData.append('ExpectedChunkCount', String(expectedChunks));
            const startOptions = checkInOptions || { newRevision: true, keepCheckedOut: false, comments: '' };
            startFormData.append('NewRevision', String(startOptions.newRevision === true));
            startFormData.append('KeepCheckedOut', String(startOptions.keepCheckedOut === true));
            startFormData.append('Comments', startOptions.comments || '');

            const startRes = await fetch(buildUploadRoute('start'), {
                method: 'POST',
                credentials: 'include',
                headers: JSON_ACCEPT_HEADERS,
                body: startFormData,
                signal: cancellationState && cancellationState.abortController ? cancellationState.abortController.signal : undefined
            });

            if (!startRes.ok) throw new Error(getChunkedUploadOverlayText().uploadStartFailed);
            const startData = await startRes.json();

            sessionId = startData.SessionId;
            localStorage.setItem(fileCacheKey, sessionId);
        }

        if (cancellationState) {
            cancellationState.sessionId = sessionId;
            if (cancellationState.cancelled) {
                throw createChunkedUploadCancelledError();
            }
        }

        // Step 2: Query Missing Chunks and Upload
        const missingRes = await fetch(buildUploadRoute(`${sessionId}/missing`), {
            method: 'GET',
            credentials: 'include',
            headers: JSON_ACCEPT_HEADERS,
            signal: cancellationState && cancellationState.abortController ? cancellationState.abortController.signal : undefined
        });

        if (!missingRes.ok) {
            localStorage.removeItem(fileCacheKey);
            const text = getChunkedUploadOverlayText();
            throw new Error(`${text.missingChunksFailed}. ${text.sessionMayHaveExpired}.`);
        }

        const missingData = await missingRes.json();
        const missingChunks = missingData.MissingChunks || [];
        const maxConcurrentUploads = resolveChunkedUploadConcurrency();
        const selectedChunkSet = new Set(missingChunks);
        const chunksToUpload = missingChunks.slice();

        // On resumed sessions, re-upload a small tail window of already-uploaded
        // chunks to heal any partial chunk writes caused by page refresh/interrupt.
        if (isResumingUpload && expectedChunks > 0 && missingChunks.length < expectedChunks) {
            const uploadedChunks = [];
            for (let chunkNumber = 0; chunkNumber < expectedChunks; chunkNumber++) {
                if (!selectedChunkSet.has(chunkNumber)) {
                    uploadedChunks.push(chunkNumber);
                }
            }

            const safetyReuploadCount = Math.min(maxConcurrentUploads, uploadedChunks.length);
            for (let i = uploadedChunks.length - safetyReuploadCount; i < uploadedChunks.length; i++) {
                const chunkNumber = uploadedChunks[i];
                if (!selectedChunkSet.has(chunkNumber)) {
                    chunksToUpload.push(chunkNumber);
                    selectedChunkSet.add(chunkNumber);
                }
            }

            chunksToUpload.sort(function (a, b) { return a - b; });
        }

        let uploadedCount = expectedChunks - chunksToUpload.length;

        if (!isResumingUpload && uploadedCount > 0) {
            isResumingUpload = true;
        }

        if (cancellationState) {
            cancellationState.isResumingUpload = isResumingUpload;
        }

        if (onProgress && expectedChunks > 0) {
            onProgress(Math.round((uploadedCount / expectedChunks) * 100));
        }

        // Upload selected chunks in parallel batches (missing + resume safety window)

        for (let i = 0; i < chunksToUpload.length; i += maxConcurrentUploads) {
            if (cancellationState && cancellationState.cancelled) {
                throw createChunkedUploadCancelledError();
            }

            // Build a batch of up to maxConcurrentUploads chunks
            const batch = chunksToUpload.slice(i, i + maxConcurrentUploads);
            const batchPromises = batch.map(async (chunkNumber) => {
                const offset = chunkNumber * chunkSize;
                const chunk = file.slice(offset, offset + chunkSize);
                const url = buildUploadRoute(`${sessionId}/chunk/${chunkNumber}`);

                await uploadChunkWithRetry(url, chunk, offset, file.size, cancellationState, 3);

                // Update progress after each chunk completes
                uploadedCount++;
                if (onProgress) {
                    const percentComplete = Math.round((uploadedCount / expectedChunks) * 100);
                    onProgress(percentComplete);
                }
            });

            // Wait for this batch to complete before starting the next batch
            await Promise.all(batchPromises);
        }

        if (cancellationState && cancellationState.cancelled) {
            throw createChunkedUploadCancelledError();
        }

        // Step 3: Complete the Upload
        // Must use FormData so ValidateHttpAntiForgeryToken can find the token as a form field.
        const completeFormData = createFormDataWithCsrf();

        const completeRes = await fetch(buildUploadRoute(`${sessionId}/complete`), {
            method: 'POST',
            credentials: 'include',
            headers: JSON_ACCEPT_HEADERS,
            body: completeFormData,
            signal: cancellationState && cancellationState.abortController ? cancellationState.abortController.signal : undefined
        });

        if (!completeRes.ok) {
            let detail = '';
            try {
                detail = (await completeRes.text() || '').trim();
            } catch (e) {
                detail = '';
            }

            const detailLower = detail.toLowerCase();
            if (completeRes.status === 400 && detailLower.indexOf('uploaded chunks are not contiguous') >= 0) {
                // Resume metadata can be corrupted after interrupted requests.
                // Drop cached session so the next attempt starts from a clean session.
                localStorage.removeItem(fileCacheKey);
                await abortChunkedUploadSessionById(sessionId);

                if (hasRetriedAfterContiguousError !== true && !(cancellationState && cancellationState.cancelled)) {
                    logDebug('Detected non-contiguous upload session; retrying once with a fresh session.');
                    if (onProgress) {
                        onProgress(0);
                    }
                    return await uploadFileInChunks(file, onProgress, cancellationState, checkInOptions, true);
                }
            }

            const detailSuffix = detail ? ` | ${detail.slice(0, 300)}` : '';
            const text = getChunkedUploadOverlayText();
            throw new Error(`${text.completeFailedPrefix}${completeRes.status})${detailSuffix}`);
        }

        // Clean up local storage once fully successful
        localStorage.removeItem(fileCacheKey);

        const completeData = await completeRes.json();
        completeData.SessionId = sessionId;
        return completeData;
    } catch (error) {
        if (isChunkedUploadCancelled(error)) {
            await notifyChunkedUploadCancelled(cancellationState);
            throw createChunkedUploadCancelledError();
        }

        throw error;
    }
}

// ---------------------------------------------------------------------------
// Centered upload progress overlay
// ---------------------------------------------------------------------------
(function () {
    const OVERLAY_ID = 'cm-chunked-upload-overlay';

    function getOrCreateOverlay() {
        let overlay = document.getElementById(OVERLAY_ID);
        if (overlay) return overlay;

        overlay = document.createElement('div');
        overlay.id = OVERLAY_ID;
        overlay.style.cssText = [
            'display:none',
            'position:fixed',
            'inset:0',
            'z-index:99999',
            'background:rgba(0,0,0,0.45)',
            'align-items:center',
            'justify-content:center',
        ].join(';');

        overlay.innerHTML = [
            '<div style="',
                'background:#fff;',
                'border-radius:8px;',
                'padding:32px 40px;',
                'min-width:320px;',
                'max-width:480px;',
                'box-shadow:0 8px 32px rgba(0,0,0,0.28);',
                'text-align:center;',
                'font-family:inherit;',
            '">',
            '<div id="cm-cup-filename" style="',
                'font-size:14px;',
                'color:#555;',
                'margin-bottom:16px;',
                'word-break:break-all;',
            '"></div>',
            '<div style="',
                'background:#e9ecef;',
                'border-radius:4px;',
                'height:20px;',
                'overflow:hidden;',
                'margin-bottom:12px;',
            '">',
            '<div id="cm-cup-bar" style="',
                'height:100%;',
                'width:0%;',
                'background:#0078d4;',
                'border-radius:4px;',
                'transition:width 0.2s ease;',
            '"></div>',
            '</div>',
            '<div id="cm-cup-label" style="',
                'font-size:13px;',
                'color:#333;',
                'margin-bottom:20px;',
            '"></div>',
            '<div style="display:flex;justify-content:center;">',
            '<button id="cm-cup-cancel" type="button" class="btn btn-flat btn-secondary" style="min-width:140px;">Cancel</button>',
            '</div>',
            '</div>',
        ].join('');

        document.body.appendChild(overlay);
        return overlay;
    }

    window._chunkedUploadOverlay = {
        show: function (fileName, onCancel) {
            const text = getChunkedUploadOverlayText();
            const overlay = getOrCreateOverlay();
            const cancelButton = overlay.querySelector('#cm-cup-cancel');
            overlay.querySelector('#cm-cup-filename').textContent = fileName || '';
            overlay.querySelector('#cm-cup-bar').style.width = '0%';
            overlay.querySelector('#cm-cup-label').textContent = text.preparing;
            if (cancelButton) {
                cancelButton.disabled = false;
                cancelButton.textContent = text.cancel;
                cancelButton.onclick = function () {
                    cancelButton.disabled = true;
                    cancelButton.textContent = text.cancelling;
                    if (typeof onCancel === 'function') {
                        onCancel();
                    }
                };
            }
            overlay.style.display = 'flex';
        },
        update: function (percent, message) {
            const overlay = document.getElementById(OVERLAY_ID);
            if (!overlay) return;
            overlay.querySelector('#cm-cup-bar').style.width = percent + '%';
            overlay.querySelector('#cm-cup-label').textContent = message || (percent + '%');
        },
        disableCancel: function () {
            const overlay = document.getElementById(OVERLAY_ID);
            if (!overlay) return;
            const cancelButton = overlay.querySelector('#cm-cup-cancel');
            if (cancelButton) {
                cancelButton.disabled = true;
            }
        },
        hide: function () {
            const overlay = document.getElementById(OVERLAY_ID);
            if (overlay) overlay.style.display = 'none';
        }
    };
}());

const handleChunkedUploadFileChange = async function(event) {
    const fileInput = event && event.target && event.target.closest
        ? event.target.closest('input[type="file"][name="files[]"]')
        : null;

    if (!fileInput || !fileInput.files || fileInput.files.length === 0) return;

    // Stop CM's native uploader from also processing this file selection.
    event.preventDefault();
    event.stopImmediatePropagation();

    await processChunkedUploadFile(fileInput.files[0], fileInput, fileInput);
};

function resolveUploadKoViewModel(sourceElement) {
    if (typeof ko === 'undefined' || !sourceElement) return null;

    // In some CM dialogs (including Check In), KO bindings may live on a parent container.
    let current = sourceElement;
    let depth = 0;
    while (current && depth < 12) {
        const vm = ko.dataFor(current);
        if (vm && typeof vm.uploadedFiles === 'function') {
            return vm;
        }
        current = current.parentElement;
        depth++;
    }

    return null;
}

function syncUploadWidgetProgressDom(koViewModel, percent) {
    if (!koViewModel || !koViewModel.id) return;

    const widgetRoot = document.getElementById(koViewModel.id);
    if (!widgetRoot) return;

    const progressBar = widgetRoot.querySelector('#uploadprogress');
    const cancelContainer = widgetRoot.querySelector('#cancelContainer');

    if (progressBar) {
        progressBar.classList.remove('progress-bar-danger');
        progressBar.classList.add('progress-bar-success');
        progressBar.setAttribute('value', String(percent));
        progressBar.setAttribute('aria-valuenow', String(percent));
        progressBar.innerHTML = percent + '%';
        progressBar.style.width = percent + '%';
    }

    if (cancelContainer) {
        cancelContainer.classList.add('hidden');
    }
}

function applySuccessfulUploadState(koViewModel, file, uploadedFileName, fullUploadedFileName) {
    if (!koViewModel || typeof ko === 'undefined') return false;

    const readyStatus =
        (typeof HP !== 'undefined' &&
            HP.HPTRIM &&
            HP.HPTRIM.App &&
            HP.HPTRIM.App.Widgets &&
            HP.HPTRIM.App.Widgets.FilesUploadStatus &&
            HP.HPTRIM.App.Widgets.FilesUploadStatus.Ready) ||
        'Ready';

    const visibleFile = {
        name: file.name,
        size: file.size,
        type: file.type || 'application/octet-stream',
        state: ko.observable('complete'),
        error: ko.observable(null)
    };

    if (typeof koViewModel.files === 'function') {
        koViewModel.files([visibleFile]);
    }

    if (typeof koViewModel.uploadedFiles === 'function') {
        koViewModel.uploadedFiles([{
            FullUploadedFileName: fullUploadedFileName,
            UploadedFileName: uploadedFileName,
            OriginalFileName: '"' + file.name + '"',
            FileStatus: ko.observable(readyStatus)
        }]);
    }

    if (typeof koViewModel.uploadSuccessStatus === 'function') {
        koViewModel.uploadSuccessStatus(true);
    }

    if (typeof koViewModel.showUploadingPanel === 'function') {
        koViewModel.showUploadingPanel(false);
    }

    if (typeof koViewModel.disableRemoveBtn === 'function') {
        koViewModel.disableRemoveBtn(false);
    }

    if (typeof koViewModel.statusMessage === 'function') {
        koViewModel.statusMessage(getChunkedUploadOverlayText().uploadComplete);
    }

    if (typeof koViewModel.uploadProgress === 'function') {
        koViewModel.uploadProgress(100);
    }

    syncUploadWidgetProgressDom(koViewModel, 100);
    return true;
}

const handleChunkedUploadDeleteClick = function (event) {
    const deleteLink = event && event.target && event.target.closest
        ? event.target.closest('a[data-bind*="onDeleteFileAction"]')
        : null;

    if (!deleteLink) return;

    let item = null;
    try {
        if (typeof ko !== 'undefined' && ko.dataFor) {
            const deleteRow = deleteLink.closest('li') || deleteLink.parentElement;
            item = ko.dataFor(deleteLink) || ko.dataFor(deleteRow);
        }
    } catch (e) {
        logDebug('Could not resolve delete-click KO context:', e);
    }

    const originalFileNames = resolveOriginalFileNamesFromDeleteAction(deleteLink, item);
    if (!originalFileNames.length) return;
    setPendingChunkedUploadDeleteConfirmation(originalFileNames);
};

const handleChunkedUploadDeleteConfirmOkClick = function (event) {
    const okButton = event && event.target && event.target.closest
        ? event.target.closest('button#okBtn')
        : null;

    if (!okButton) return;

    const originalFileNames = consumePendingChunkedUploadDeleteConfirmation();
    if (!originalFileNames.length) return;

    originalFileNames.forEach(function (name) {
        void abortChunkedUploadSessionForOriginalFile(name);
    });
};

const handleChunkedUploadDeleteConfirmCancelClick = function (event) {
    const cancelButton = event && event.target && event.target.closest
        ? event.target.closest('button#cancelBtn, button[data-bind*="cancelHandler"]')
        : null;

    if (!cancelButton) return;
    clearPendingChunkedUploadDeleteConfirmation();
};

async function processChunkedUploadFile(file, contextElement, clearInputElement) {
    if (!file) return;

    const koViewModel = resolveUploadKoViewModel(contextElement);
    const checkInOptions = resolveCheckInOptionsFromContext(contextElement);
    const cancellationState = {
        cancelled: false,
        sessionId: '',
        fileCacheKey: '',
        activeXhr: null,
        retryTimer: null,
        abortController: typeof AbortController !== 'undefined' ? new AbortController() : null
    };

    window._chunkedUploadOverlay.show(file.name, function () {
        const text = getChunkedUploadOverlayText();
        window._chunkedUploadOverlay.update(0, text.cancelling);
        cancelChunkedUploadState(cancellationState);
    });

    try {
        const result = await uploadFileInChunks(file, function (percent) {
            window._chunkedUploadOverlay.update(percent, getChunkedUploadProgressMessage(percent, cancellationState.isResumingUpload === true));
        }, cancellationState, checkInOptions);

        logDebug('Chunked upload completed successfully! Staged file path:', result.StagedFilePath);

        const uploadedFileName = result.RecordFilePath || result.StagedFilePath;
        const fullUploadedFileName = result.FullUploadedFileName || result.StagedFilePath;

        // Register post-save verification + cleanup metadata.
        if (uploadedFileName) {
            registerPendingUpload(uploadedFileName, {
                expectedHash: result.AssembledSha256 || '',
                sessionId: result.SessionId || '',
                stagedFilePath: result.StagedFilePath || '',
                fullUploadedFileName: result.FullUploadedFileName || '',
                fileCacheKey: cancellationState.fileCacheKey || '',
                originalFileName: file.name
            }, file.name);
            logDebug('Registered pending post-save operations for:', uploadedFileName);
        }

        const text = getChunkedUploadOverlayText();
        window._chunkedUploadOverlay.update(100, text.uploadComplete);
    window._chunkedUploadOverlay.disableCancel();

        // Mirror the native widget success state so the selected file remains visible
        // in the dialog after the chunked upload completes.
        if (applySuccessfulUploadState(koViewModel, file, uploadedFileName, fullUploadedFileName)) {
            logDebug('Injected staged path and visible success state into KO uploader. UploadedFileName:', uploadedFileName);
        } else {
            console.warn('Could not find KO ViewModel for uploader context; upload may not save correctly.');
        }

        // Brief pause so the user sees 100% before the overlay disappears.
        setTimeout(function () { window._chunkedUploadOverlay.hide(); }, 800);
    } catch (error) {
        if (isChunkedUploadCancelled(error)) {
            logDebug('Chunked upload cancelled by user.');
            const text = getChunkedUploadOverlayText();
            window._chunkedUploadOverlay.update(0, text.uploadCancelled);
            setTimeout(function () { window._chunkedUploadOverlay.hide(); }, 700);
            return;
        }

        console.error('Chunked upload failed:', error);
        window._chunkedUploadOverlay.disableCancel();
        const text = getChunkedUploadOverlayText();
        window._chunkedUploadOverlay.update(0, text.uploadFailedPrefix + error.message);
        // Leave the overlay visible on error so the user can read the message,
        // then auto-dismiss after 4 seconds.
        setTimeout(function () { window._chunkedUploadOverlay.hide(); }, 4000);
    } finally {
        // Always reset chooser value so selecting the same file again re-triggers change.
        if (clearInputElement && typeof clearInputElement.value !== 'undefined') {
            clearInputElement.value = '';
        }
    }
}

const handleChunkedUploadDrop = async function (event) {
    const dropZone = event && event.target && event.target.closest
        ? event.target.closest('.upload-drop-zone.dropzone')
        : null;

    if (!dropZone) return;

    const dt = event.dataTransfer;
    if (!dt || !dt.files || dt.files.length === 0) return;

    // Prevent native drop processing to avoid duplicate uploads.
    event.preventDefault();
    event.stopImmediatePropagation();

    const hiddenInput = dropZone.querySelector('input[type="file"][name="files[]"]');
    await processChunkedUploadFile(dt.files[0], hiddenInput || dropZone, hiddenInput || null);
};

const handleChunkedUploadDragOver = function (event) {
    const dropZone = event && event.target && event.target.closest
        ? event.target.closest('.upload-drop-zone.dropzone')
        : null;
    if (!dropZone) return;

    // Required for browsers to allow drop.
    event.preventDefault();
    if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy';
    }
};

if (window.__chunkedUploadChangeHandlerInstalled !== true) {
    document.addEventListener('change', handleChunkedUploadFileChange, true); // <-- 'true' enables the Capture phase. Do not remove.
    window.__chunkedUploadChangeHandlerInstalled = true;
}

if (window.__chunkedUploadDropHandlerInstalled !== true) {
    document.addEventListener('dragover', handleChunkedUploadDragOver, true);
    document.addEventListener('drop', handleChunkedUploadDrop, true);
    window.__chunkedUploadDropHandlerInstalled = true;
}

if (window.__chunkedUploadDeleteHandlerInstalled !== true) {
    document.addEventListener('click', handleChunkedUploadDeleteClick, true);
    document.addEventListener('click', handleChunkedUploadDeleteConfirmOkClick, true);
    document.addEventListener('click', handleChunkedUploadDeleteConfirmCancelClick, true);
    window.__chunkedUploadDeleteHandlerInstalled = true;
}