const CHUNKED_UPLOAD_VERBOSE = (window.CHUNKED_UPLOAD_VERBOSE === true);
const SERVICE_API_BASE_URL = '/contentmanager/serviceapi';
const JSON_ACCEPT_HEADERS = { 'Accept': 'application/json' };
const CHUNKED_UPLOAD_ROUTE_ROOT = (window.CHUNKED_UPLOAD_ROUTE_ROOT || 'Upload').replace(/^\/+|\/+$/g, '');
const CHUNKED_UPLOAD_DEFAULT_MAX_CONCURRENT = 3;
const CHUNKED_UPLOAD_MAX_CONCURRENT_STORAGE_KEY = 'cm_chunked_upload_max_concurrent';

function clampChunkedUploadConcurrency(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed)) return CHUNKED_UPLOAD_DEFAULT_MAX_CONCURRENT;
    if (parsed < 1) return 1;
    if (parsed > 8) return 8;
    return parsed;
}

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
    const uploadProgressText = getChunkedUploadMessage('web_upload_progress', 'Upload Progress');
    const uploadingFilesText = getChunkedUploadMessage('web_uploading_files', 'Uploading files');

    return {
        cancel: cancelText,
        cancelling: cancelText + '\u2026',
        uploadComplete: uploadText + ' ' + completeText,
        uploadCancelled: uploadCancelledText,
        uploadProgress: uploadProgressText,
        uploadingFiles: uploadingFilesText
    };
}

logDebug("🚀 CHUNKED UPLOAD SCRIPT IS LOADED AND RUNNING!");

// ---------------------------------------------------------------------------
// Post-save hash verification
// After the chunked upload completes, we store the expected document hash here
// keyed by the RecordFilePath token (e.g. "1168\upload.bin").
// An XHR interceptor watches for the CM record-save response, extracts the
// new record URI, then queries DocumentHash via ServiceAPI and compares.
// ---------------------------------------------------------------------------
const _chunkedUploadPendingOps = {};

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

                        delete _chunkedUploadPendingOps[matchedKey];

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
    const error = new Error('Upload cancelled');
    error.isChunkedUploadCancelled = true;
    return error;
}

function isChunkedUploadCancelled(error) {
    return !!(error && (error.isChunkedUploadCancelled === true || error.name === 'AbortError'));
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
                    reject(new Error(`HTTP ${xhr.status}: ${xhr.statusText}`));
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
                    reject(new Error('Network error during chunk upload'));
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
async function uploadFileInChunks(file, onProgress, cancellationState) {
    const chunkSize = 4 * 1024 * 1024; // 4MB chunk size
    const expectedChunks = Math.ceil(file.size / chunkSize);
    
    // Create a unique cache key for this specific file
    const fileCacheKey = `cm_upload_staged_${file.name}_${file.size}_${file.lastModified}`;
    if (cancellationState) {
        cancellationState.fileCacheKey = fileCacheKey;
    }
    let sessionId = localStorage.getItem(fileCacheKey);

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
            startFormData.append('NewRevision', 'true');
            startFormData.append('KeepCheckedOut', 'false');

            const startRes = await fetch(buildUploadRoute('start'), {
                method: 'POST',
                credentials: 'include',
                headers: JSON_ACCEPT_HEADERS,
                body: startFormData,
                signal: cancellationState && cancellationState.abortController ? cancellationState.abortController.signal : undefined
            });

            if (!startRes.ok) throw new Error('Failed to start upload session');
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
            throw new Error('Failed to query missing chunks. The session may have expired.');
        }

        const missingData = await missingRes.json();
        const missingChunks = missingData.MissingChunks || [];
        let uploadedCount = expectedChunks - missingChunks.length;

        if (onProgress && expectedChunks > 0) {
            onProgress(Math.round((uploadedCount / expectedChunks) * 100));
        }

        // Loop ONLY over the missing chunks
        // Upload missing chunks in parallel batches (configurable concurrency, default 3)
        const maxConcurrentUploads = resolveChunkedUploadConcurrency();

        for (let i = 0; i < missingChunks.length; i += maxConcurrentUploads) {
            if (cancellationState && cancellationState.cancelled) {
                throw createChunkedUploadCancelledError();
            }

            // Build a batch of up to maxConcurrentUploads chunks
            const batch = missingChunks.slice(i, i + maxConcurrentUploads);
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

        if (!completeRes.ok) throw new Error('Failed to complete upload');

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
            '">Preparing\u2026</div>',
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
            overlay.querySelector('#cm-cup-label').textContent = text.uploadProgress;
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
        koViewModel.statusMessage('Upload complete');
    }

    if (typeof koViewModel.uploadProgress === 'function') {
        koViewModel.uploadProgress(100);
    }

    syncUploadWidgetProgressDom(koViewModel, 100);
    return true;
}

async function processChunkedUploadFile(file, contextElement, clearInputElement) {
    if (!file) return;

    const koViewModel = resolveUploadKoViewModel(contextElement);
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
            const text = getChunkedUploadOverlayText();
            window._chunkedUploadOverlay.update(percent, text.uploadingFiles + ' ' + percent + '%');
        }, cancellationState);

        logDebug('Chunked upload completed successfully! Staged file path:', result.StagedFilePath);

        const uploadedFileName = result.RecordFilePath || result.StagedFilePath;
        const fullUploadedFileName = result.FullUploadedFileName || result.StagedFilePath;

        // Register post-save verification + cleanup metadata.
        if (uploadedFileName) {
            _chunkedUploadPendingOps[uploadedFileName] = {
                expectedHash: result.AssembledSha256 || '',
                sessionId: result.SessionId || '',
                stagedFilePath: result.StagedFilePath || '',
                fullUploadedFileName: result.FullUploadedFileName || ''
            };
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
        window._chunkedUploadOverlay.update(0, 'Upload Failed: ' + error.message);
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