const CHUNKED_UPLOAD_VERBOSE_STORAGE_KEY = 'cm_chunked_upload_verbose';
const CHUNKED_UPLOAD_DEBUG_BANNER_ID = 'cm-chunked-upload-debug-banner';
// Badge constants removed — async attach state is now surfaced via the native "Record created" message area.
const CHUNKED_UPLOAD_POST_ATTACH_QUERY_SESSION_KEY = 'cm_chunked_upload_post_attach_query';
const CHUNKED_UPLOAD_POST_ATTACH_QUERY_SET_AT_SESSION_KEY = 'cm_chunked_upload_post_attach_query_set_utc';
const CHUNKED_UPLOAD_POST_ATTACH_QUERY_TTL_MS = 2 * 60 * 1000;
const SERVICE_API_BASE_URL = '/contentmanager/serviceapi';
const JSON_ACCEPT_HEADERS = { 'Accept': 'application/json' };
const CHUNKED_UPLOAD_ROUTE_ROOT = (window.CHUNKED_UPLOAD_ROUTE_ROOT || 'Upload').replace(/^\/+|\/+$/g, '');
const CHUNKED_UPLOAD_DEFAULT_MAX_CONCURRENT = 4;
const CHUNKED_UPLOAD_MAX_CONCURRENT_STORAGE_KEY = 'cm_chunked_upload_max_concurrent';
const CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_SESSION_KEY = 'cm_chunked_upload_dynamic_concurrency';
const CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_UPDATED_AT_SESSION_KEY = 'cm_chunked_upload_dynamic_concurrency_updated_utc';
const CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_TTL_MS = 30 * 60 * 1000;
const CHUNKED_UPLOAD_PERF_ONLY_MAX_CONCURRENT_CAP = 4;
const CHUNKED_UPLOAD_LARGE_FILE_PILOT_THRESHOLD_MB_DEFAULT = 256;
const CHUNKED_UPLOAD_DYNAMIC_THRESHOLD_SESSION_KEY = 'cm_chunked_upload_dynamic_threshold_mb';
const CHUNKED_UPLOAD_DYNAMIC_THRESHOLD_UPDATED_AT_SESSION_KEY = 'cm_chunked_upload_dynamic_threshold_updated_utc';
const CHUNKED_UPLOAD_DYNAMIC_THRESHOLD_TTL_MS = 30 * 60 * 1000;
const CHUNKED_UPLOAD_LARGE_FILE_PILOT_THRESHOLD_MB_MIN = 128;
const CHUNKED_UPLOAD_LARGE_FILE_PILOT_THRESHOLD_MB_MAX = 2048;
const CHUNKED_UPLOAD_PERF_ONLY_THRESHOLD_MB_CAP = 1024;
const CHUNKED_UPLOAD_RESUME_KEY_PREFIX = 'cm_upload_staged_';
const CHUNKED_UPLOAD_RESUME_SWEEP_MARKER_KEY = 'cm_upload_staged_last_sweep_utc';
const CHUNKED_UPLOAD_RESUME_SWEEP_INTERVAL_MS = 6 * 60 * 60 * 1000;
const CHUNKED_UPLOAD_RESUME_SWEEP_MAX_KEYS = 25;
const CHUNKED_UPLOAD_SESSION_ID_REGEX = /^[a-z0-9]{32}$/i;
const CHUNKED_UPLOAD_CREATED_IN_PROGRESS_SUFFIX = ', background upload in progress...';

let CHUNKED_UPLOAD_VERBOSE = false;
let _chunkedUploadLargeFileTimeoutRecoveryShown = false;
let _chunkedUploadAsyncAttachRetryContext = null;
let _chunkedUploadCreatedMessageObserver = null;
let _chunkedUploadCreatedMessageBaseText = '';
let _chunkedUploadAsyncAttachRetryInProgress = false;
let _chunkedUploadAsyncAttachAutoRefreshScheduled = false;

let _chunkedUploadResumeSweepPromise = null;
const _chunkedUploadRecentNativeIntercepts = {};
const _chunkedUploadActiveFileKeys = {};
let _chunkedUploadLastContextElement = null;
let _chunkedUploadPendingSuggestedTitle = '';
let _chunkedUploadPendingTitleContextElement = null;
let _chunkedUploadPendingTitleSetAtUtc = 0;
let _chunkedUploadPendingTitleApplyTimer = null;
let _chunkedUploadPendingTitleObserver = null;
let _chunkedUploadCommandPanelObserver = null;

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
    // Priority: explicit page/global override, then persisted user setting, then dynamic hint, then default.
    if (window.CHUNKED_UPLOAD_MAX_CONCURRENT !== undefined && window.CHUNKED_UPLOAD_MAX_CONCURRENT !== null) {
        return clampChunkedUploadConcurrency(window.CHUNKED_UPLOAD_MAX_CONCURRENT);
    }

    const persistedValue = getPersistedChunkedUploadConcurrency();
    if (persistedValue !== null) {
        return clampChunkedUploadConcurrency(persistedValue);
    }

    // Dynamic concurrency can be disabled from host page.
    if (window.CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_ENABLED === false) {
        return CHUNKED_UPLOAD_DEFAULT_MAX_CONCURRENT;
    }

    const cached = getCachedChunkedUploadDynamicConcurrency();
    if (cached !== null) {
        const hints = resolveChunkedUploadBandwidthHints();
        const normalizedCached = applyChunkedUploadPerfOnlyConcurrencyCap(cached, hints.networkHintMbps, hints.performanceHintMbps);
        if (normalizedCached !== cached) {
            cacheChunkedUploadDynamicConcurrency(normalizedCached);
        }
        return normalizedCached;
    }

    const resolvedDynamic = calculateChunkedUploadDynamicConcurrency();
    if (resolvedDynamic !== null) {
        cacheChunkedUploadDynamicConcurrency(resolvedDynamic);
        return resolvedDynamic;
    }

    return CHUNKED_UPLOAD_DEFAULT_MAX_CONCURRENT;
}

function resolveChunkedUploadLargeFilePilotThresholdMb() {
    // Fixed async-attach gate: always use the default threshold.
    return CHUNKED_UPLOAD_LARGE_FILE_PILOT_THRESHOLD_MB_DEFAULT;
}

function resolveChunkedUploadLargeFilePilotThresholdBytes() {
    return resolveChunkedUploadLargeFilePilotThresholdMb() * 1024 * 1024;
}

function isChunkedUploadLargeFilePilotCandidate(fileSize) {
    const normalizedSize = Number(fileSize || 0);
    return Number.isFinite(normalizedSize) && normalizedSize >= resolveChunkedUploadLargeFilePilotThresholdBytes();
}

window.getChunkedUploadLargeFilePilotThresholdMb = function () {
    return resolveChunkedUploadLargeFilePilotThresholdMb();
};

window.setChunkedUploadLargeFilePilotThresholdMb = function (value) {
    window.CHUNKED_UPLOAD_LARGE_FILE_PILOT_THRESHOLD_MB = null;
    return CHUNKED_UPLOAD_LARGE_FILE_PILOT_THRESHOLD_MB_DEFAULT;
};

window.resetChunkedUploadLargeFilePilotThresholdMb = function () {
    window.CHUNKED_UPLOAD_LARGE_FILE_PILOT_THRESHOLD_MB = null;
    clearCachedChunkedUploadDynamicThresholdMb();
    return resolveChunkedUploadLargeFilePilotThresholdMb();
};

window.refreshChunkedUploadDynamicThresholdMb = function () {
    clearCachedChunkedUploadDynamicThresholdMb();
    return resolveChunkedUploadLargeFilePilotThresholdMb();
};

window.getChunkedUploadDynamicThresholdDiagnostics = function () {
    return buildChunkedUploadDynamicThresholdDiagnostics();
};

window.refreshChunkedUploadDynamicConcurrency = function () {
    clearCachedChunkedUploadDynamicConcurrency();
    return resolveChunkedUploadConcurrency();
};

window.getChunkedUploadDynamicConcurrencyDiagnostics = function () {
    return buildChunkedUploadDynamicConcurrencyDiagnostics();
};

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

function clampChunkedUploadLargeFilePilotThresholdMb(value) {
    const parsed = parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
        return CHUNKED_UPLOAD_LARGE_FILE_PILOT_THRESHOLD_MB_DEFAULT;
    }
    return Math.max(CHUNKED_UPLOAD_LARGE_FILE_PILOT_THRESHOLD_MB_MIN, Math.min(CHUNKED_UPLOAD_LARGE_FILE_PILOT_THRESHOLD_MB_MAX, parsed));
}

function readChunkedUploadNetworkDownlinkMbps() {
    const connection = navigator && (navigator.connection || navigator.mozConnection || navigator.webkitConnection);
    if (!connection) return null;

    const downlink = Number(connection.downlink || 0);
    if (Number.isFinite(downlink) && downlink > 0) {
        return downlink;
    }

    const effectiveType = String(connection.effectiveType || '').toLowerCase();
    if (effectiveType === 'slow-2g') return 0.05;
    if (effectiveType === '2g') return 0.2;
    if (effectiveType === '3g') return 1.5;
    if (effectiveType === '4g') return 10;
    if (effectiveType === '5g') return 35;
    return null;
}

function readChunkedUploadNetworkUplinkMbps() {
    const configured = Number(window.CHUNKED_UPLOAD_NETWORK_UPLINK_MBPS || 0);
    if (Number.isFinite(configured) && configured > 0) {
        return configured;
    }

    const connection = navigator && (navigator.connection || navigator.mozConnection || navigator.webkitConnection);
    if (!connection) return null;

    const rawUplink = Number(connection.uplink || connection.uploadDownlink || 0);
    if (Number.isFinite(rawUplink) && rawUplink > 0) {
        return rawUplink;
    }

    // Browser upload bandwidth hints are often unavailable; downlink is a conservative fallback.
    return readChunkedUploadNetworkDownlinkMbps();
}

function readChunkedUploadPerformanceHintMbps() {
    try {
        if (!window.performance || typeof window.performance.getEntriesByType !== 'function') {
            return null;
        }

        const entries = window.performance.getEntriesByType('resource') || [];
        let bestMbps = null;
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i];
            if (!entry || !entry.transferSize || !entry.duration) continue;
            if (entry.transferSize < 80 * 1024) continue; // Ignore tiny assets.

            const bits = Number(entry.transferSize) * 8;
            const seconds = Number(entry.duration) / 1000;
            if (!Number.isFinite(bits) || !Number.isFinite(seconds) || seconds <= 0) continue;

            const mbps = bits / seconds / 1000 / 1000;
            if (!Number.isFinite(mbps) || mbps <= 0) continue;

            if (bestMbps === null || mbps > bestMbps) {
                bestMbps = mbps;
            }
        }

        return bestMbps;
    } catch (e) {
        return null;
    }
}

function applyChunkedUploadPerfOnlyConcurrencyCap(concurrency, networkHint, perfHint) {
    let normalized = clampChunkedUploadConcurrency(concurrency);
    if (!Number.isFinite(networkHint) && Number.isFinite(perfHint)) {
        normalized = Math.min(normalized, CHUNKED_UPLOAD_PERF_ONLY_MAX_CONCURRENT_CAP);
    }
    return normalized;
}

function buildChunkedUploadDynamicThresholdDiagnostics() {
    const explicitOverrideMb = null;

    const connection = navigator && (navigator.connection || navigator.mozConnection || navigator.webkitConnection);
    const connectionDownlinkMbps = connection ? Number(connection.downlink || 0) : null;
    const connectionUplinkMbps = connection ? Number(connection.uplink || connection.uploadDownlink || 0) : null;
    const connectionEffectiveType = connection ? String(connection.effectiveType || '') : '';

    return {
        dynamicEnabled: false,
        explicitOverrideMb: explicitOverrideMb,
        cache: {
            rawMb: null,
            normalizedMb: null,
            updatedUtcMs: null,
            ageMs: null,
            ttlMs: CHUNKED_UPLOAD_DYNAMIC_THRESHOLD_TTL_MS,
            valid: false
        },
        inputs: {
            connectionDownlinkMbps: Number.isFinite(connectionDownlinkMbps) && connectionDownlinkMbps > 0 ? connectionDownlinkMbps : null,
            connectionUplinkMbps: Number.isFinite(connectionUplinkMbps) && connectionUplinkMbps > 0 ? connectionUplinkMbps : null,
            connectionEffectiveType: connectionEffectiveType || null,
            networkHintMbps: null,
            performanceHintMbps: null,
            chosenMbps: null
        },
        mapping: {
            minMb: CHUNKED_UPLOAD_LARGE_FILE_PILOT_THRESHOLD_MB_MIN,
            maxMb: CHUNKED_UPLOAD_LARGE_FILE_PILOT_THRESHOLD_MB_MAX,
            perfOnlyCapMb: CHUNKED_UPLOAD_PERF_ONLY_THRESHOLD_MB_CAP,
            defaultMb: CHUNKED_UPLOAD_LARGE_FILE_PILOT_THRESHOLD_MB_DEFAULT,
            mappedThresholdMb: null
        },
        resolvedThresholdMb: resolveChunkedUploadLargeFilePilotThresholdMb()
    };
}

function buildChunkedUploadDynamicConcurrencyDiagnostics() {
    const configuredRaw = window.CHUNKED_UPLOAD_MAX_CONCURRENT;
    const configuredParsed = parseInt(configuredRaw, 10);
    const explicitOverride = (window.CHUNKED_UPLOAD_MAX_CONCURRENT !== undefined && window.CHUNKED_UPLOAD_MAX_CONCURRENT !== null)
        ? clampChunkedUploadConcurrency(configuredParsed)
        : null;

    const persistedRaw = getPersistedChunkedUploadConcurrency();
    const persistedParsed = parseInt(persistedRaw, 10);
    const persistedConcurrency = (persistedRaw !== null && Number.isFinite(persistedParsed))
        ? clampChunkedUploadConcurrency(persistedParsed)
        : null;

    const hints = resolveChunkedUploadBandwidthHints();
    const networkHintMbps = hints.networkHintMbps;
    const performanceHintMbps = hints.performanceHintMbps;
    const chosenMbps = hints.chosenMbps;

    const mappedConcurrency = (Number.isFinite(chosenMbps) && chosenMbps > 0)
        ? (function () {
            let mapped = clampChunkedUploadConcurrency(mapChunkedUploadMbpsToConcurrency(chosenMbps));
            mapped = applyChunkedUploadPerfOnlyConcurrencyCap(mapped, networkHintMbps, performanceHintMbps);
            return mapped;
        }())
        : null;

    let cacheRaw = null;
    let cacheUpdatedUtcMs = null;
    let cacheAgeMs = null;
    let cacheValid = false;
    let cacheNormalized = null;
    try {
        cacheRaw = sessionStorage.getItem(CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_SESSION_KEY);
        cacheUpdatedUtcMs = sessionStorage.getItem(CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_UPDATED_AT_SESSION_KEY);

        if (cacheRaw && cacheUpdatedUtcMs) {
            const updatedMs = Number(cacheUpdatedUtcMs);
            const ageMs = Date.now() - updatedMs;
            if (Number.isFinite(ageMs) && ageMs >= 0) {
                cacheAgeMs = ageMs;
                cacheValid = ageMs <= CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_TTL_MS;
            }

            const parsed = Number(cacheRaw);
            if (Number.isFinite(parsed) && parsed > 0) {
                cacheNormalized = clampChunkedUploadConcurrency(parsed);
            }
        }
    } catch (e) {
        // Ignore sessionStorage read issues.
    }

    return {
        dynamicEnabled: window.CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_ENABLED !== false,
        explicitOverride: explicitOverride,
        persistedConcurrency: persistedConcurrency,
        cache: {
            raw: cacheRaw,
            normalized: cacheNormalized,
            updatedUtcMs: cacheUpdatedUtcMs,
            ageMs: cacheAgeMs,
            ttlMs: CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_TTL_MS,
            valid: cacheValid
        },
        inputs: {
            networkHintMbps: Number.isFinite(networkHintMbps) && networkHintMbps > 0 ? networkHintMbps : null,
            performanceHintMbps: Number.isFinite(performanceHintMbps) && performanceHintMbps > 0 ? performanceHintMbps : null,
            chosenMbps: Number.isFinite(chosenMbps) && chosenMbps > 0 ? chosenMbps : null
        },
        mapping: {
            minConcurrent: 1,
            maxConcurrent: 8,
            perfOnlyCap: CHUNKED_UPLOAD_PERF_ONLY_MAX_CONCURRENT_CAP,
            defaultConcurrent: CHUNKED_UPLOAD_DEFAULT_MAX_CONCURRENT,
            mappedConcurrent: mappedConcurrency
        },
        resolvedConcurrency: resolveChunkedUploadConcurrency()
    };
}

function getCachedChunkedUploadDynamicConcurrency() {
    try {
        const raw = sessionStorage.getItem(CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_SESSION_KEY);
        const updatedRaw = sessionStorage.getItem(CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_UPDATED_AT_SESSION_KEY);
        if (!raw || !updatedRaw) return null;

        const updated = Number(updatedRaw);
        const ageMs = Date.now() - updated;
        if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_TTL_MS) {
            clearCachedChunkedUploadDynamicConcurrency();
            return null;
        }

        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            clearCachedChunkedUploadDynamicConcurrency();
            return null;
        }

        return clampChunkedUploadConcurrency(parsed);
    } catch (e) {
        return null;
    }
}

function cacheChunkedUploadDynamicConcurrency(value) {
    try {
        const normalized = clampChunkedUploadConcurrency(value);
        sessionStorage.setItem(CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_SESSION_KEY, String(normalized));
        sessionStorage.setItem(CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_UPDATED_AT_SESSION_KEY, String(Date.now()));
    } catch (e) {
        // Ignore sessionStorage write issues.
    }
}

function clearCachedChunkedUploadDynamicConcurrency() {
    try {
        sessionStorage.removeItem(CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_SESSION_KEY);
        sessionStorage.removeItem(CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_UPDATED_AT_SESSION_KEY);
    } catch (e) {
        // Ignore sessionStorage delete issues.
    }
}

function getCachedChunkedUploadDynamicThresholdMb() {
    try {
        const raw = sessionStorage.getItem(CHUNKED_UPLOAD_DYNAMIC_THRESHOLD_SESSION_KEY);
        const updatedRaw = sessionStorage.getItem(CHUNKED_UPLOAD_DYNAMIC_THRESHOLD_UPDATED_AT_SESSION_KEY);
        if (!raw || !updatedRaw) return null;

        const updated = Number(updatedRaw);
        const ageMs = Date.now() - updated;
        if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > CHUNKED_UPLOAD_DYNAMIC_THRESHOLD_TTL_MS) {
            clearCachedChunkedUploadDynamicThresholdMb();
            return null;
        }

        const parsed = Number(raw);
        if (!Number.isFinite(parsed) || parsed <= 0) {
            clearCachedChunkedUploadDynamicThresholdMb();
            return null;
        }

        return clampChunkedUploadLargeFilePilotThresholdMb(parsed);
    } catch (e) {
        return null;
    }
}

function cacheChunkedUploadDynamicThresholdMb(value) {
    try {
        const normalized = clampChunkedUploadLargeFilePilotThresholdMb(value);
        sessionStorage.setItem(CHUNKED_UPLOAD_DYNAMIC_THRESHOLD_SESSION_KEY, String(normalized));
        sessionStorage.setItem(CHUNKED_UPLOAD_DYNAMIC_THRESHOLD_UPDATED_AT_SESSION_KEY, String(Date.now()));
    } catch (e) {
        // Ignore sessionStorage write issues.
    }
}

function clearCachedChunkedUploadDynamicThresholdMb() {
    try {
        sessionStorage.removeItem(CHUNKED_UPLOAD_DYNAMIC_THRESHOLD_SESSION_KEY);
        sessionStorage.removeItem(CHUNKED_UPLOAD_DYNAMIC_THRESHOLD_UPDATED_AT_SESSION_KEY);
    } catch (e) {
        // Ignore sessionStorage delete issues.
    }
}

function installChunkedUploadDynamicThresholdRefresh() {
    const connection = navigator && (navigator.connection || navigator.mozConnection || navigator.webkitConnection);
    if (!connection || typeof connection.addEventListener !== 'function') {
        return;
    }

    connection.addEventListener('change', function () {
        if (window.CHUNKED_UPLOAD_DYNAMIC_THRESHOLD_ENABLED !== false) {
            clearCachedChunkedUploadDynamicThresholdMb();
        }

        if (window.CHUNKED_UPLOAD_DYNAMIC_CONCURRENCY_ENABLED !== false) {
            clearCachedChunkedUploadDynamicConcurrency();
        }
    });
}

function getChunkedUploadDebugBanner() {
    let banner = document.getElementById(CHUNKED_UPLOAD_DEBUG_BANNER_ID);
    if (banner) return banner;

    banner = document.createElement('div');
    banner.id = CHUNKED_UPLOAD_DEBUG_BANNER_ID;
    banner.style.cssText = [
        'display:none',
        'position:fixed',
        'bottom:8px',
        'left:16px',
        'right:auto',
        'width:min(720px, calc(100vw - 32px))',
        'z-index:100000',
        'background:#fff4d6',
        'border:1px solid #e0b252',
        'border-radius:10px',
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

function applyChunkedUploadPageBottomInset(px) {
    if (!document.body) return;

    const normalized = Math.max(0, Number(px) || 0);
    if (normalized <= 0) {
        document.body.style.removeProperty('padding-bottom');
        return;
    }

    document.body.style.setProperty('padding-bottom', `${normalized}px`, 'important');
}

function resolveChunkedUploadDebugBannerInsetPx() {
    const banner = document.getElementById(CHUNKED_UPLOAD_DEBUG_BANNER_ID);
    if (!banner || banner.style.display === 'none') {
        return 0;
    }

    return (banner.offsetHeight || 0) + 8;
}

function updateChunkedUploadDebugBanner() {
    if (!document.body) return;

    const banner = getChunkedUploadDebugBanner();
    const message = banner.querySelector('#cm-chunked-upload-debug-banner-message');
    if (!CHUNKED_UPLOAD_VERBOSE) {
        banner.style.display = 'none';
        applyChunkedUploadPageBottomInset(0);
        return;
    }

    if (message) {
        message.textContent = 'Chunked Upload debug mode is ON. Verbose browser logging and diagnostic helpers are enabled.';
    }
    banner.style.display = 'flex';
    applyChunkedUploadPageBottomInset(resolveChunkedUploadDebugBannerInsetPx());
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

function getChunkedUploadCreatedMessageElement() {
    // Targets the h4.clsErrorTitle inside the "Record created" success panel.
    return document.querySelector('.clsNoItem .clsErrorTitle');
}

function updateChunkedUploadCreatedMessageForAsyncAttach(state) {
    const normalized = String(state || '').toLowerCase();
    const nativeText = (typeof HP !== 'undefined' && HP && HP.HPTRIM && HP.HPTRIM.Messages && HP.HPTRIM.Messages.web_single_record_created)
        ? HP.HPTRIM.Messages.web_single_record_created
        : 'Record created';

    if (normalized === 'queued' || normalized === 'running') {
        const currentElement = getChunkedUploadCreatedMessageElement();
        const currentText = currentElement ? String(currentElement.textContent || '').trim() : '';

        if (currentText && currentText.toLowerCase().indexOf('background upload in progress') < 0) {
            _chunkedUploadCreatedMessageBaseText = currentText;
        }

        if (!_chunkedUploadCreatedMessageBaseText) {
            _chunkedUploadCreatedMessageBaseText = nativeText;
        }

        const progressText = `${_chunkedUploadCreatedMessageBaseText}${CHUNKED_UPLOAD_CREATED_IN_PROGRESS_SUFFIX}`;

        // Disconnect any previous observer before starting a new one.
        if (_chunkedUploadCreatedMessageObserver) {
            try { _chunkedUploadCreatedMessageObserver.disconnect(); } catch (e) { /* ignore */ }
            _chunkedUploadCreatedMessageObserver = null;
        }

        if (!setChunkedUploadCreatedMessageText(progressText) && typeof MutationObserver !== 'undefined' && document.body) {
            // Panel not rendered yet — watch for it.
            _chunkedUploadCreatedMessageObserver = new MutationObserver(function () {
                if (setChunkedUploadCreatedMessageText(progressText)) {
                    if (_chunkedUploadCreatedMessageObserver) {
                        try { _chunkedUploadCreatedMessageObserver.disconnect(); } catch (e) { /* ignore */ }
                        _chunkedUploadCreatedMessageObserver = null;
                    }
                }
            });
            _chunkedUploadCreatedMessageObserver.observe(document.body, { childList: true, subtree: true });
        }
    } else {
        // Completed (succeeded or failed) — stop watching and restore the native text.
        if (_chunkedUploadCreatedMessageObserver) {
            try { _chunkedUploadCreatedMessageObserver.disconnect(); } catch (e) { /* ignore */ }
            _chunkedUploadCreatedMessageObserver = null;
        }
        const restoreText = _chunkedUploadCreatedMessageBaseText || nativeText;
        setChunkedUploadCreatedMessageText(restoreText);
        _chunkedUploadCreatedMessageBaseText = '';
    }
}

function setChunkedUploadCreatedMessageText(text) {
    const el = getChunkedUploadCreatedMessageElement();
    if (!el) return false;
    el.textContent = text;
    return true;
}

let _chunkedUploadFinishedButtonSuppressed = false;
let _chunkedUploadFinishedButtonObserver = null;

function getChunkedUploadFinishedButtons() {
    return document.querySelectorAll(
        'button[name="saveBtn"][type="submit"][data-bind*="finished"], button[data-bind*="$parent.finished"], button[data-bind*="finished"]'
    );
}

function applyChunkedUploadFinishedButtonSuppression(suppress) {
    const shouldSuppress = suppress === true;
    _chunkedUploadFinishedButtonSuppressed = shouldSuppress;

    const buttons = getChunkedUploadFinishedButtons();
    for (let i = 0; i < buttons.length; i++) {
        const button = buttons[i];
        if (!button) continue;

        if (shouldSuppress) {
            if (!button.hasAttribute('data-cup-orig-display')) {
                button.setAttribute('data-cup-orig-display', button.style.display || '');
            }
            button.style.display = 'none';
            button.disabled = true;
            button.setAttribute('aria-disabled', 'true');
        } else {
            const originalDisplay = button.getAttribute('data-cup-orig-display');
            if (originalDisplay !== null) {
                button.style.display = originalDisplay;
                button.removeAttribute('data-cup-orig-display');
            }
            button.disabled = false;
            button.removeAttribute('aria-disabled');
        }
    }

    if (shouldSuppress) {
        if (!_chunkedUploadFinishedButtonObserver && typeof MutationObserver !== 'undefined' && document.body) {
            _chunkedUploadFinishedButtonObserver = new MutationObserver(function () {
                if (_chunkedUploadFinishedButtonSuppressed !== true) return;
                const currentButtons = getChunkedUploadFinishedButtons();
                for (let i = 0; i < currentButtons.length; i++) {
                    const currentButton = currentButtons[i];
                    if (!currentButton) continue;
                    if (!currentButton.hasAttribute('data-cup-orig-display')) {
                        currentButton.setAttribute('data-cup-orig-display', currentButton.style.display || '');
                    }
                    currentButton.style.display = 'none';
                    currentButton.disabled = true;
                    currentButton.setAttribute('aria-disabled', 'true');
                }
            });
            _chunkedUploadFinishedButtonObserver.observe(document.body, { childList: true, subtree: true });
        }
    } else if (_chunkedUploadFinishedButtonObserver) {
        try {
            _chunkedUploadFinishedButtonObserver.disconnect();
        } catch (e) {
            // Ignore observer cleanup issues.
        }
        _chunkedUploadFinishedButtonObserver = null;
    }
}

function setChunkedUploadAsyncAttachRetryContext(pending, recordUri) {
    if (!pending || !recordUri || recordUri <= 0) {
        return;
    }

    _chunkedUploadAsyncAttachRetryContext = {
        pending: pending,
        recordUri: recordUri
    };
}

function clearChunkedUploadAsyncAttachRetryContext() {
    _chunkedUploadAsyncAttachRetryContext = null;
    _chunkedUploadAsyncAttachRetryInProgress = false;
}

async function retryChunkedUploadAsyncAttachFromBadge() {
    if (_chunkedUploadAsyncAttachRetryInProgress) {
        return;
    }

    const context = _chunkedUploadAsyncAttachRetryContext;
    if (!context || !context.pending || !context.recordUri) {
        return;
    }

    _chunkedUploadAsyncAttachRetryInProgress = true;
    updateAsyncAttachBadge(null, 'running');

    try {
        await runChunkedUploadAsyncAttach(context.pending, context.recordUri);
    } catch (error) {
        console.error('[ChunkedUpload] Async attach retry failed:', error);
    } finally {
        _chunkedUploadAsyncAttachRetryInProgress = false;
    }
}

function tryParseChunkedUploadErrorBody(bodyText) {
    if (!bodyText) return null;
    try {
        return JSON.parse(bodyText);
    } catch (e) {
        return null;
    }
}

function createChunkedUploadHttpError(prefix, statusCode, bodyText) {
    const parsed = tryParseChunkedUploadErrorBody(bodyText);
    const responseStatus = parsed && parsed.ResponseStatus ? parsed.ResponseStatus : null;
    const detail = responseStatus && responseStatus.Message
        ? String(responseStatus.Message)
        : (bodyText ? String(bodyText).slice(0, 240) : '');

    const message = `${prefix} (HTTP ${statusCode})${detail ? `: ${detail}` : ''}`;
    const error = new Error(message);
    error.httpStatus = statusCode;
    error.errorCode = responseStatus && responseStatus.ErrorCode ? String(responseStatus.ErrorCode) : '';
    error.responseMessage = responseStatus && responseStatus.Message ? String(responseStatus.Message) : '';
    return error;
}

function isChunkedUploadAsyncAttachRetryableError(error) {
    if (!error) return true;

    const status = Number(error.httpStatus || 0);
    const errorCode = String(error.errorCode || '').toLowerCase();
    const message = String(error.message || '').toLowerCase();
    const responseMessage = String(error.responseMessage || '').toLowerCase();
    const combined = `${message} ${responseMessage}`;

    if (status === 404) return false;
    if (errorCode === 'notfound') return false;
    if (combined.indexOf('source file was not found') >= 0) return false;

    return true;
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
installChunkedUploadDynamicThresholdRefresh();
window.addEventListener('resize', updateChunkedUploadDebugBanner);
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

function notifyChunkedUploadLargeFileTimeoutRecovery(pending, statusCode) {
    if (_chunkedUploadLargeFileTimeoutRecoveryShown) {
        return;
    }

    _chunkedUploadLargeFileTimeoutRecoveryShown = true;
    const fileName = pending && pending.originalFileName ? pending.originalFileName : 'the selected file';
    const thresholdMb = resolveChunkedUploadLargeFilePilotThresholdMb();

    const message =
        `Large-file save request timed out (HTTP ${statusCode}) after chunk upload completed for ${fileName}. ` +
        `The record may have been created successfully. The page will refresh to clear the stuck save spinner. ` +
        `(Pilot threshold: ${thresholdMb} MB)`;

    console.warn('[ChunkedUpload]', message);

    setTimeout(function () {
        try {
            alert(message);
        } catch (e) {
            // Ignore alert issues and continue with refresh.
        }
        window.location.reload();
    }, 50);
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

async function startChunkedUploadAsyncAttach(pending, recordUri) {
    const formData = createFormDataWithCsrf();
    formData.append('SessionId', pending.sessionId || '');
    formData.append('RecordUri', String(recordUri || 0));
    formData.append('FileName', pending.originalFileName || '');
    formData.append('FullUploadedFileName', pending.fullUploadedFileName || '');
    formData.append('StagedFilePath', pending.stagedFilePath || '');
    formData.append('NewRevision', String(pending.newRevision === true));
    formData.append('KeepCheckedOut', String(pending.keepCheckedOut === true));
    formData.append('Comments', pending.comments || '');

    const res = await fetch(buildUploadRoute('attach/start'), {
        method: 'POST',
        credentials: 'include',
        headers: JSON_ACCEPT_HEADERS,
        body: formData
    });

    if (!res.ok) {
        const body = await res.text();
        throw createChunkedUploadHttpError('Failed to start async attach', res.status, body);
    }

    return await res.json();
}

async function preflightChunkedUploadAsyncAttach(pending) {
    const formData = createFormDataWithCsrf();
    formData.append('SessionId', pending.sessionId || '');
    formData.append('FullUploadedFileName', pending.fullUploadedFileName || '');
    formData.append('StagedFilePath', pending.stagedFilePath || '');

    const res = await fetch(buildUploadRoute('attach/preflight'), {
        method: 'POST',
        credentials: 'include',
        headers: JSON_ACCEPT_HEADERS,
        body: formData
    });

    if (!res.ok) {
        const body = await res.text();
        throw createChunkedUploadHttpError('Failed to preflight async attach', res.status, body);
    }

    return await res.json();
}

async function pollChunkedUploadAsyncAttach(jobId, timeoutMs, onStatus) {
    const started = Date.now();
    const maxDuration = timeoutMs > 0 ? timeoutMs : (30 * 60 * 1000);

    while ((Date.now() - started) < maxDuration) {
        const res = await fetch(buildUploadRoute(`attach/${jobId}`), {
            method: 'GET',
            credentials: 'include',
            headers: JSON_ACCEPT_HEADERS
        });

        if (!res.ok) {
            const body = await res.text();
            throw createChunkedUploadHttpError('Failed to query async attach status', res.status, body);
        }

        const status = await res.json();
        if (typeof onStatus === 'function') {
            onStatus(status);
        }
        if (status && status.Completed === true) {
            return status;
        }

        await new Promise(function (resolve) { setTimeout(resolve, 2000); });
    }

    throw new Error('Timed out waiting for async attach completion.');
}

function scheduleChunkedUploadPostAttachRefresh(recordUri, options) {
    const effective = options || {};
    if (effective.isRecordCreateFlow !== true) return;

    const numericUri = Number(recordUri || 0);
    if (!Number.isFinite(numericUri) || numericUri <= 0) return;
    if (_chunkedUploadAsyncAttachAutoRefreshScheduled) return;

    _chunkedUploadAsyncAttachAutoRefreshScheduled = true;

    setTimeout(function () {
        updateChunkedUploadCreatedMessageForAsyncAttach('succeeded');
        applyChunkedUploadFinishedButtonSuppression(false);
    }, 300);
}

function setChunkedUploadPendingPostAttachUri(recordUri) {
    const numericUri = Number(recordUri || 0);
    if (!Number.isFinite(numericUri) || numericUri <= 0) return;

    try {
        sessionStorage.setItem(CHUNKED_UPLOAD_POST_ATTACH_QUERY_SESSION_KEY, String(numericUri));
        sessionStorage.setItem(CHUNKED_UPLOAD_POST_ATTACH_QUERY_SET_AT_SESSION_KEY, String(Date.now()));
    } catch (e) {
        // Ignore storage write issues.
    }
}

function consumeChunkedUploadPendingPostAttachUri() {
    try {
        const stored = sessionStorage.getItem(CHUNKED_UPLOAD_POST_ATTACH_QUERY_SESSION_KEY);
        const setAtRaw = sessionStorage.getItem(CHUNKED_UPLOAD_POST_ATTACH_QUERY_SET_AT_SESSION_KEY);

        sessionStorage.removeItem(CHUNKED_UPLOAD_POST_ATTACH_QUERY_SESSION_KEY);
        sessionStorage.removeItem(CHUNKED_UPLOAD_POST_ATTACH_QUERY_SET_AT_SESSION_KEY);

        const numericUri = Number(stored || 0);
        if (!Number.isFinite(numericUri) || numericUri <= 0) return 0;

        const ageMs = Date.now() - Number(setAtRaw || 0);
        if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > CHUNKED_UPLOAD_POST_ATTACH_QUERY_TTL_MS) {
            return 0;
        }

        return numericUri;
    } catch (e) {
        return 0;
    }
}

async function runChunkedUploadAsyncAttach(pending, recordUri, options) {
    const effectiveOptions = options || {};
    updateAsyncAttachBadgeForPending(pending, 'running');
    if (effectiveOptions.isRecordCreateFlow === true) {
        updateChunkedUploadCreatedMessageForAsyncAttach('running');
    }

    try {
        const start = await startChunkedUploadAsyncAttach(pending, recordUri);
        if (!start || !start.JobId) {
            throw new Error('Async attach start response did not include a JobId.');
        }

        logDebug(`[ChunkedUpload] Started async attach job ${start.JobId} for record ${recordUri}.`);
        const status = await pollChunkedUploadAsyncAttach(start.JobId, 30 * 60 * 1000, function (nextStatus) {
            if (!nextStatus) return;
            const state = String(nextStatus.Status || '').toLowerCase();
            if (state === 'queued') {
                updateAsyncAttachBadgeForPending(pending, 'queued');
                if (effectiveOptions.isRecordCreateFlow === true) {
                    updateChunkedUploadCreatedMessageForAsyncAttach('queued');
                }
            } else if (state === 'running') {
                updateAsyncAttachBadgeForPending(pending, 'running');
                if (effectiveOptions.isRecordCreateFlow === true) {
                    updateChunkedUploadCreatedMessageForAsyncAttach('running');
                }
            }
        });

        if (status && status.Succeeded === true) {
            clearChunkedUploadAsyncAttachRetryContext();
            if (effectiveOptions.isRecordCreateFlow !== true) {
                updateAsyncAttachBadgeForPending(pending, 'succeeded');
            }

            if (pending.expectedHash) {
                await verifyDocumentHash(recordUri, pending.expectedHash);
            }

            await cleanupChunkedUpload(pending);
            console.log(`[ChunkedUpload] Async attach completed for record ${recordUri}.`);
            scheduleChunkedUploadPostAttachRefresh(recordUri, effectiveOptions);
            return;
        }

        const errorMessage = status && status.ErrorMessage ? status.ErrorMessage : 'Async attach did not complete successfully.';
        throw new Error(errorMessage);
    } catch (error) {
        const isRetryable = isChunkedUploadAsyncAttachRetryableError(error);
        const rawMessage = error && error.message ? error.message : String(error || 'Async attach failed.');
        const message = isRetryable
            ? rawMessage
            : 'Async attach source file was not found. Please upload the file again and save the record.';

        if (isRetryable) {
            setChunkedUploadAsyncAttachRetryContext(pending, recordUri);
        } else {
            clearChunkedUploadAsyncAttachRetryContext();
        }

        updateAsyncAttachBadgeForPending(pending, 'failed', `Async attach failed: ${message}`);
        if (effectiveOptions.isRecordCreateFlow === true) {
            updateChunkedUploadCreatedMessageForAsyncAttach('failed');
            applyChunkedUploadFinishedButtonSuppression(false);
        }
        throw error;
    }
}

async function canProceedWithChunkedUploadRecordSave(pending) {
    if (!pending || pending.isLargeFilePilotCandidate !== true) {
        return { allow: true, reason: '' };
    }

    const sessionId = String(pending.sessionId || '').trim();
    if (!isValidChunkedUploadSessionId(sessionId)) {
        return {
            allow: false,
            reason: 'Upload session is missing or invalid. Please re-upload the file before saving the record.'
        };
    }

    try {
        const preflight = await preflightChunkedUploadAsyncAttach(pending);
        if (preflight && preflight.SourcePathAllowed === false) {
            return {
                allow: false,
                reason: 'Upload source file is outside the allowed attach path. Please re-upload the file before saving the record.'
            };
        }

        if (preflight && preflight.SourceExists === false) {
            return {
                allow: false,
                reason: 'Upload source file was not found or expired. Please re-upload the file before saving the record.'
            };
        }

        return { allow: true, reason: '' };
    } catch (e) {
        const status = Number(e && e.httpStatus || 0);
        const errorCode = String(e && e.errorCode || '').toLowerCase();
        if (status === 404 || status === 410 || status === 400 || errorCode === 'notfound') {
            return {
                allow: false,
                reason: 'Upload session was not found or expired. Please re-upload the file before saving the record.'
            };
        }

        // Do not block save on transient probe failures.
        return { allow: true, reason: '' };
    }
}

function shouldRollbackChunkedUploadRecordAfterAttachFailure(error) {
    return !isChunkedUploadAsyncAttachRetryableError(error);
}

async function tryRollbackChunkedUploadCreatedRecord(recordUri, error) {
    const numericUri = Number(recordUri || 0);
    if (!Number.isFinite(numericUri) || numericUri <= 0) {
        return { attempted: false, deleted: false, reason: 'No record URI available.' };
    }

    if (!shouldRollbackChunkedUploadRecordAfterAttachFailure(error)) {
        return { attempted: false, deleted: false, reason: 'Attach failure is retryable.' };
    }

    try {
        const res = await fetch(`${SERVICE_API_BASE_URL}/Record/${numericUri}`, {
            method: 'DELETE',
            credentials: 'include',
            headers: JSON_ACCEPT_HEADERS
        });

        if (res.ok || res.status === 404) {
            return { attempted: true, deleted: true, reason: '' };
        }

        return {
            attempted: true,
            deleted: false,
            reason: `Rollback delete failed (HTTP ${res.status}).`
        };
    } catch (e) {
        return {
            attempted: true,
            deleted: false,
            reason: e && e.message ? String(e.message) : 'Rollback delete failed.'
        };
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

function resolvePendingChunkedUploadForSaveBody(outboundBody) {
    const pendingKeys = Object.keys(_chunkedUploadPendingOps);
    if (!pendingKeys.length) {
        return { pending: null, matchedKey: null };
    }

    let pending = null;
    let matchedKey = null;
    for (const key of pendingKeys) {
        if (typeof outboundBody === 'string' && outboundBody.includes(key.replace(/\\/g, '\\\\'))) {
            pending = _chunkedUploadPendingOps[key];
            matchedKey = key;
            break;
        }
    }

    if (!pending && pendingKeys.length === 1) {
        matchedKey = pendingKeys[0];
        pending = _chunkedUploadPendingOps[matchedKey];
    }

    return {
        pending: pending,
        matchedKey: matchedKey
    };
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
            let outboundBody = body;
            const isNativeFileUploadCall =
                _method === 'POST' &&
                isChunkedUploadNativePostFormDataUrl(_url);

            if (isNativeFileUploadCall) {
                const intercepted = tryInterceptChunkedUploadNativeFormDataBody(outboundBody);
                if (intercepted) {
                    logDebug('[ChunkedUpload] Intercepted native PostFormData upload and delegated to chunked flow.');
                    return;
                }
            }

            const isRecordSaveCall =
                _method === 'POST' &&
                (/\/ServiceApi\/Record\b/i.test(_url) || /\/ServiceApi\/RecordCheckIn\b/i.test(_url) || /\/ServiceApi\/Record\/\d+\/CheckIn\b/i.test(_url));
            const isRecordCreateStyleCheckInCall =
                _method === 'POST' &&
                /\/ServiceApi\/RecordCheckIn\b/i.test(_url);
            const isRecordCheckInCall =
                _method === 'POST' &&
                (/\/ServiceApi\/RecordCheckIn\b/i.test(_url) || /\/ServiceApi\/Record\/\d+\/CheckIn\b/i.test(_url));
            const isRecordCreateCall =
                ((_method === 'POST' &&
                    /\/ServiceApi\/Record\b/i.test(_url) &&
                    !isRecordCheckInCall)
                    || isRecordCreateStyleCheckInCall);

            if (isRecordSaveCall) {
                ensureChunkedUploadTitleBeforeSubmit(_chunkedUploadPendingTitleContextElement || _chunkedUploadLastContextElement || document.body);
                outboundBody = enforceChunkedUploadTitleInRecordSaveBody(outboundBody);

                const preSaveMatch = resolvePendingChunkedUploadForSaveBody(outboundBody);
                if (preSaveMatch.pending && preSaveMatch.pending.isLargeFilePilotCandidate === true) {
                    (async function () {
                        const gate = await canProceedWithChunkedUploadRecordSave(preSaveMatch.pending);
                        if (!gate.allow) {
                            try {
                                if (preSaveMatch.pending.fileCacheKey) {
                                    localStorage.removeItem(preSaveMatch.pending.fileCacheKey);
                                }
                            } catch (e) {
                                // Ignore localStorage cleanup issues.
                            }

                            unregisterPendingUpload(preSaveMatch.matchedKey, preSaveMatch.pending);
                            updateAsyncAttachBadgeForPending(preSaveMatch.pending, 'failed', gate.reason);
                            alert(`${gate.reason}`);
                            return;
                        }

                        xhr.addEventListener('load', async function () {
                            try {
                                const isGatewayTimeout = xhr.status === 504 || xhr.status === 524;

                                if (xhr.status < 200 || xhr.status >= 300) {
                                    const responseText = String(xhr.responseText || '').trim();
                                    if (responseText) {
                                        let parsed = null;
                                        try {
                                            parsed = JSON.parse(responseText);
                                        } catch (e) {
                                            parsed = null;
                                        }

                                        if (parsed && parsed.ResponseStatus) {
                                            console.error('[ChunkedUpload] Record save failed:', {
                                                httpStatus: xhr.status,
                                                errorCode: parsed.ResponseStatus.ErrorCode || '',
                                                message: parsed.ResponseStatus.Message || '',
                                                stackTrace: parsed.ResponseStatus.StackTrace || ''
                                            });
                                        } else {
                                            console.error(`[ChunkedUpload] Record save failed (HTTP ${xhr.status}) body:`, responseText.slice(0, 1200));
                                        }
                                    } else {
                                        console.error(`[ChunkedUpload] Record save failed (HTTP ${xhr.status}) with empty response body.`);
                                    }

                                    if (isGatewayTimeout) {
                                        // CM record save timed out at the proxy — the server likely completed
                                        // the save but the response was dropped. We cannot verify the hash
                                        // (no URI in response), but we can still clean up staged artifacts
                                        // to prevent chunks lingering on disk.
                                        const gatewayTimeoutMatch = resolvePendingChunkedUploadForSaveBody(outboundBody);
                                        const pending = gatewayTimeoutMatch.pending;
                                        const matchedKey = gatewayTimeoutMatch.matchedKey;
                                        if (!pending) return;

                                        console.warn(`[ChunkedUpload] Record save returned HTTP ${xhr.status}. Skipping hash verification; attempting cleanup of staged artifacts.`);
                                        unregisterPendingUpload(matchedKey, pending);
                                        await cleanupChunkedUpload(pending);

                                        if (pending.isLargeFilePilotCandidate === true) {
                                            notifyChunkedUploadLargeFileTimeoutRecovery(pending, xhr.status);
                                        }
                                    }
                                    return;
                                }

                                const data = JSON.parse(xhr.responseText);
                                if (!data || !data.Results || !data.Results.length) return;
                                const uri = data.Results[0].Uri;
                                if (!uri) return;

                                const postSaveMatch = resolvePendingChunkedUploadForSaveBody(outboundBody);
                                const pending = postSaveMatch.pending;
                                const matchedKey = postSaveMatch.matchedKey;
                                if (!pending) return;

                                unregisterPendingUpload(matchedKey, pending);
                                clearChunkedUploadSuggestedTitle();

                                if (pending.isLargeFilePilotCandidate === true) {
                                    try {
                                        await runChunkedUploadAsyncAttach(pending, uri, {
                                            isRecordCreateFlow: isRecordCreateCall === true
                                        });
                                    } catch (attachError) {
                                        console.error('[ChunkedUpload] Async attach failed:', attachError);

                                        if (isRecordCreateCall === true) {
                                            const rollback = await tryRollbackChunkedUploadCreatedRecord(uri, attachError);
                                            if (rollback.deleted === true) {
                                                alert(`Large-file async attach failed and the new record was rolled back to prevent a metadata-only record. ${attachError.message || attachError}`);
                                            } else {
                                                const rollbackDetail = rollback.attempted
                                                    ? ` Rollback could not be completed automatically: ${rollback.reason || 'unknown error'}.`
                                                    : '';
                                                alert(`Large-file async attach failed: ${attachError.message || attachError}.${rollbackDetail}`);
                                            }
                                        } else {
                                            alert(`Large-file async attach failed: ${attachError.message || attachError}`);
                                        }
                                    }
                                    return;
                                }

                                if (pending.expectedHash) {
                                    await verifyDocumentHash(uri, pending.expectedHash);
                                }

                                await cleanupChunkedUpload(pending);
                            } catch (e) {
                                console.warn('Post-save hash verification error:', e);
                            }
                        });

                        return originalSend.call(xhr, outboundBody);
                    })();
                    return;
                }

                xhr.addEventListener('load', async function () {
                    try {
                        const isGatewayTimeout = xhr.status === 504 || xhr.status === 524;

                        if (xhr.status < 200 || xhr.status >= 300) {
                            const responseText = String(xhr.responseText || '').trim();
                            if (responseText) {
                                let parsed = null;
                                try {
                                    parsed = JSON.parse(responseText);
                                } catch (e) {
                                    parsed = null;
                                }

                                if (parsed && parsed.ResponseStatus) {
                                    console.error('[ChunkedUpload] Record save failed:', {
                                        httpStatus: xhr.status,
                                        errorCode: parsed.ResponseStatus.ErrorCode || '',
                                        message: parsed.ResponseStatus.Message || '',
                                        stackTrace: parsed.ResponseStatus.StackTrace || ''
                                    });
                                } else {
                                    console.error(`[ChunkedUpload] Record save failed (HTTP ${xhr.status}) body:`, responseText.slice(0, 1200));
                                }
                            } else {
                                console.error(`[ChunkedUpload] Record save failed (HTTP ${xhr.status}) with empty response body.`);
                            }

                            if (isGatewayTimeout) {
                                // CM record save timed out at the proxy — the server likely completed
                                // the save but the response was dropped. We cannot verify the hash
                                // (no URI in response), but we can still clean up staged artifacts
                                // to prevent chunks lingering on disk.
                                const pendingKeys = Object.keys(_chunkedUploadPendingOps);
                                if (!pendingKeys.length) return;

                                let pending = null;
                                let matchedKey = null;
                                for (const key of pendingKeys) {
                                    if (typeof outboundBody === 'string' && outboundBody.includes(key.replace(/\\/g, '\\\\'))) {
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

                                console.warn(`[ChunkedUpload] Record save returned HTTP ${xhr.status}. Skipping hash verification; attempting cleanup of staged artifacts.`);
                                unregisterPendingUpload(matchedKey, pending);
                                await cleanupChunkedUpload(pending);

                                if (pending.isLargeFilePilotCandidate === true) {
                                    notifyChunkedUploadLargeFileTimeoutRecovery(pending, xhr.status);
                                }
                            }
                            return;
                        }

                        const data = JSON.parse(xhr.responseText);
                        if (!data || !data.Results || !data.Results.length) return;
                        const uri = data.Results[0].Uri;
                        if (!uri) return;

                        const pendingKeys = Object.keys(_chunkedUploadPendingOps);
                        if (!pendingKeys.length) return;

                        let pending = null;
                        let matchedKey = null;
                        for (const key of pendingKeys) {
                            if (typeof outboundBody === 'string' && outboundBody.includes(key.replace(/\\/g, '\\\\'))) {
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
                        clearChunkedUploadSuggestedTitle();

                        if (pending.isLargeFilePilotCandidate === true) {
                            try {
                                await runChunkedUploadAsyncAttach(pending, uri, {
                                    isRecordCreateFlow: isRecordCreateCall === true
                                });
                            } catch (attachError) {
                                console.error('[ChunkedUpload] Async attach failed:', attachError);
                                alert(`Large-file async attach failed: ${attachError.message || attachError}`);
                            }
                            return;
                        }

                        if (pending.expectedHash) {
                            await verifyDocumentHash(uri, pending.expectedHash);
                        }

                        await cleanupChunkedUpload(pending);
                    } catch (e) {
                        console.warn('Post-save hash verification error:', e);
                    }
                });
            }
            return originalSend.call(xhr, outboundBody);
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

    // 2. Check the global __RequestVerificationToken object
    if (window.__RequestVerificationToken) {
        return window.__RequestVerificationToken;
    }

    // 3. Fallback to DOM elements
    const inputElement = document.querySelector('input[name="__RequestVerificationToken"]');
    if (inputElement) {
        return inputElement.value;
    }
    
    return null;
}

function readCheckInOptionsFromModel(model) {
    if (!model || typeof model !== 'object') return null;

    const newRevisionValue =
        typeof model.newRevision === 'function' ? model.newRevision() : model.newRevision;
    const keepCheckedOutValue =
        typeof model.keepCheckedOut === 'function' ? model.keepCheckedOut() : model.keepCheckedOut;
    const commentsValue =
        typeof model.comments === 'function' ? model.comments() : model.comments;

    if (typeof newRevisionValue === 'undefined'
        && typeof keepCheckedOutValue === 'undefined'
        && typeof commentsValue === 'undefined') {
        return null;
    }

    return {
        newRevision: coerceChunkedUploadBoolean(newRevisionValue, true),
        keepCheckedOut: coerceChunkedUploadBoolean(keepCheckedOutValue, false),
        comments: commentsValue == null ? '' : String(commentsValue)
    };
}

function resolveCheckInOptionsFromContext(sourceElement) {
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

    const rootCheckInForm = window.root && window.root.checkInForm;
    const rootOptions = readCheckInOptionsFromModel(rootCheckInForm);
    if (rootOptions) {
        return rootOptions;
    }

    return defaults;
}

function createChunkedUploadCancelledError() {
    const error = new Error('Chunked upload cancelled by user.');
    error.name = 'AbortError';
    error.isChunkedUploadCancelled = true;
    return error;
}

function isChunkedUploadCancelled(error) {
    if (!error) return false;
    if (error.isChunkedUploadCancelled === true) return true;

    const name = String(error.name || '').toLowerCase();
    if (name === 'aborterror') return true;

    const message = String(error.message || '').toLowerCase();
    if (message.indexOf('cancelled') >= 0 || message.indexOf('canceled') >= 0 || message.indexOf('aborted') >= 0) {
        return true;
    }

    return false;
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
        // Cloudflare can return gateway timeouts for long-running complete operations,
        // so retry complete a small number of times before failing.
        const maxCompleteAttempts = 3;
        let completeRes = null;
        for (let completeAttempt = 1; completeAttempt <= maxCompleteAttempts; completeAttempt++) {
            const completeFormData = createFormDataWithCsrf();
            completeRes = await fetch(buildUploadRoute(`${sessionId}/complete`), {
                method: 'POST',
                credentials: 'include',
                headers: JSON_ACCEPT_HEADERS,
                body: completeFormData,
                signal: cancellationState && cancellationState.abortController ? cancellationState.abortController.signal : undefined
            });

            if (completeRes.ok) {
                break;
            }

            const isGatewayTimeout = completeRes.status === 504 || completeRes.status === 524;
            if (isGatewayTimeout && completeAttempt < maxCompleteAttempts && !(cancellationState && cancellationState.cancelled)) {
                const delayMs = 1500 * completeAttempt;
                logDebug(`Complete call timed out (HTTP ${completeRes.status}). Retrying in ${delayMs}ms (attempt ${completeAttempt + 1}/${maxCompleteAttempts}).`);
                await new Promise(function (resolve) { setTimeout(resolve, delayMs); });
                continue;
            }

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

    rememberChunkedUploadContext(fileInput);
    await processChunkedUploadFile(fileInput.files[0], fileInput, fileInput);
};

function resolveUploadKoViewModel(sourceElement) {
    if (typeof ko === 'undefined' || !sourceElement) return null;

    const resolveFromBindingContext = function (element) {
        if (!ko.contextFor || !element) return null;

        let context = null;
        try {
            context = ko.contextFor(element);
        } catch (e) {
            return null;
        }

        let safety = 0;
        while (context && safety < 16) {
            const data = context.$data;
            if (data && typeof data.uploadedFiles === 'function') {
                return data;
            }
            context = context.$parentContext;
            safety++;
        }

        return null;
    };

    // In some CM dialogs (including Check In), KO bindings may live on a parent container.
    let current = sourceElement;
    let depth = 0;
    while (current && depth < 12) {
        const contextVm = resolveFromBindingContext(current);
        if (contextVm) {
            return contextVm;
        }

        const vm = ko.dataFor(current);
        if (vm && typeof vm.uploadedFiles === 'function') {
            return vm;
        }
        current = current.parentElement;
        depth++;
    }

    return null;
}

function resolveAnyUploadKoViewModel() {
    if (typeof ko === 'undefined' || !ko.dataFor) return null;

    const candidates = document.querySelectorAll(
        'input[type="file"][name="files[]"], input[type="file"][name="file"], input[type="file"], .upload-drop-zone, .dropzone, [data-dropzone]'
    );

    for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i];
        if (!isChunkedUploadElementVisible(candidate)) continue;
        const vm = resolveUploadKoViewModel(candidate);
        if (vm) return vm;
    }

    for (let i = 0; i < candidates.length; i++) {
        const vm = resolveUploadKoViewModel(candidates[i]);
        if (vm) return vm;
    }

    return null;
}

function updateAsyncAttachBadge(koViewModelId, state, detailText) {
    const normalized = String(state || '').toLowerCase();
    const isInProgress = normalized === 'queued' || normalized === 'running';
    const isTerminal = normalized === 'succeeded' || normalized === 'failed' || !state || normalized === 'hidden';

    applyChunkedUploadFinishedButtonSuppression(isInProgress);
    updateChunkedUploadCreatedMessageForAsyncAttach(normalized);

    if (isTerminal) {
        clearChunkedUploadAsyncAttachRetryContext();
    }
}

function updateAsyncAttachBadgeForPending(pending, state, detailText) {
    updateAsyncAttachBadge(null, state, detailText);
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

function hasChunkedUploadCommandPanelFiles() {
    const vm = resolveAnyUploadKoViewModel();
    if (vm && typeof vm.uploadedFiles === 'function') {
        try {
            const files = vm.uploadedFiles();
            if (files && files.length > 0) {
                return true;
            }
        } catch (e) {
            // Ignore KO observable read errors and fallback to DOM check.
        }
    }

    const uploadedItems = document.querySelectorAll('#idCreationRecCommandPanel .clsUploadedListItem');
    return !!(uploadedItems && uploadedItems.length > 0);
}

function syncChunkedUploadCommandPanelInteractivityGuard() {
    if (!hasChunkedUploadCommandPanelFiles()) {
        if (_chunkedUploadCommandPanelObserver) {
            try {
                _chunkedUploadCommandPanelObserver.disconnect();
            } catch (e) {
                // Ignore observer disconnect issues.
            }
            _chunkedUploadCommandPanelObserver = null;
        }
        return;
    }

    ensureChunkedUploadCommandPanelInteractive(3);

    if (_chunkedUploadCommandPanelObserver || typeof MutationObserver === 'undefined' || !document.body) {
        return;
    }

    _chunkedUploadCommandPanelObserver = new MutationObserver(function () {
        if (!hasChunkedUploadCommandPanelFiles()) {
            if (_chunkedUploadCommandPanelObserver) {
                try {
                    _chunkedUploadCommandPanelObserver.disconnect();
                } catch (e) {
                    // Ignore observer disconnect issues.
                }
                _chunkedUploadCommandPanelObserver = null;
            }
            return;
        }

        ensureChunkedUploadCommandPanelInteractive(0);
    });

    _chunkedUploadCommandPanelObserver.observe(document.body, {
        attributes: true,
        childList: true,
        subtree: true,
        attributeFilter: ['class']
    });
}

function ensureChunkedUploadCommandPanelInteractive(retryCount) {
    const attempts = Number.isFinite(retryCount) ? retryCount : 0;
    const root = window.root;

    if (root && root.recordMainCreationPanel && typeof root.recordMainCreationPanel.disableUploaded === 'function') {
        root.recordMainCreationPanel.disableUploaded(false);
    }

    const commandPanel = document.querySelector('#idCreationRecCommandPanel .clsRecCommandPanel');
    if (commandPanel && commandPanel.classList && commandPanel.classList.contains('disabledAction')) {
        commandPanel.classList.remove('disabledAction');
    }

    if (attempts > 0) {
        setTimeout(function () {
            ensureChunkedUploadCommandPanelInteractive(attempts - 1);
        }, 140);
    }
}

function applySuccessfulUploadState(koViewModel, file, uploadedFileName, fullUploadedFileName, options) {
    if (!koViewModel || typeof ko === 'undefined') return false;

    const effectiveOptions = options || {};
    const deferNativeAttach = effectiveOptions.deferNativeAttach === true;

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
        if (!deferNativeAttach) {
            koViewModel.uploadedFiles([{
                FullUploadedFileName: fullUploadedFileName,
                UploadedFileName: uploadedFileName,
                OriginalFileName: '"' + file.name + '"',
                FileStatus: ko.observable(readyStatus)
            }]);
        } else {
            // For large-file async attach pilot, keep a visible row in the uploader
            // but avoid injecting a native upload token so save remains metadata-only.
            koViewModel.uploadedFiles([{
                FullUploadedFileName: '',
                UploadedFileName: '',
                OriginalFileName: '"' + file.name + '"',
                FileStatus: ko.observable(readyStatus)
            }]);
        }
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

    // CM may re-apply disabledAction after uploadedFiles changes (e.g. record type selection).
    // Keep panel interactive while uploaded files are present.
    syncChunkedUploadCommandPanelInteractivityGuard();

    syncUploadWidgetProgressDom(koViewModel, 100);
    return true;
}

function applySuccessfulUploadStateWithRetry(file, uploadedFileName, fullUploadedFileName, options) {
    const maxAttempts = 12;
    const retryDelayMs = 150;
    let attempts = 0;

    function tryApply() {
        attempts++;
        const vm = resolveAnyUploadKoViewModel();
        if (applySuccessfulUploadState(vm, file, uploadedFileName, fullUploadedFileName, options)) {
            logDebug('Applied uploader success state after deferred KO VM resolution.');
            return;
        }

        if (attempts < maxAttempts) {
            setTimeout(tryApply, retryDelayMs);
        } else {
            logDebug('Could not resolve uploader KO VM after retries; keeping native form flow.');
        }
    }

    setTimeout(tryApply, retryDelayMs);
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

function resetChunkedUploadWidgetAfterCancel(koViewModel, clearInputElement) {
    const resolvedVm =
        koViewModel ||
        resolveUploadKoViewModel(clearInputElement) ||
        resolveUploadKoViewModel(_chunkedUploadLastContextElement || document.activeElement || document.body) ||
        resolveAnyUploadKoViewModel();

    if (resolvedVm) {
        try {
            if (typeof resolvedVm.clearForm === 'function') {
                resolvedVm.clearForm();
            }
        } catch (e) {
            // Ignore clearForm failures and continue with explicit resets.
        }

        if (typeof resolvedVm.files === 'function') {
            resolvedVm.files([]);
        }

        if (typeof resolvedVm.uploadingFiles === 'function') {
            resolvedVm.uploadingFiles([]);
        }

        if (typeof resolvedVm.uploadedFiles === 'function') {
            resolvedVm.uploadedFiles([]);
        }

        if (typeof resolvedVm.uploadProgress === 'function') {
            resolvedVm.uploadProgress(0);
        }

        if (typeof resolvedVm.showUploadingPanel === 'function') {
            resolvedVm.showUploadingPanel(false);
        }

        // The top-left Upload button in SimpleUpload is bound to enable: uploadSuccessStatus.
        if (typeof resolvedVm.uploadSuccessStatus === 'function') {
            resolvedVm.uploadSuccessStatus(true);
        }

        if (typeof resolvedVm.disableRemoveBtn === 'function') {
            resolvedVm.disableRemoveBtn(false);
        }

        if (typeof resolvedVm.statusMessage === 'function') {
            resolvedVm.statusMessage('');
        }
    }

    if (clearInputElement && typeof clearInputElement.value !== 'undefined') {
        clearInputElement.value = '';
    }

    ensureChunkedUploadCommandPanelInteractive(6);
    syncChunkedUploadCommandPanelInteractivityGuard();
}

const handleChunkedUploadDeleteConfirmOkClick = function (event) {
    const okButton = event && event.target && event.target.closest
        ? event.target.closest('button#okBtn')
        : null;

    if (!okButton) return;

    updateAsyncAttachBadge(null, 'hidden');

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
    updateAsyncAttachBadge(null, 'hidden');
};

function isChunkedUploadNativePostFormDataUrl(rawUrl) {
    const normalized = String(rawUrl || '').toLowerCase();
    return normalized.indexOf('/api/fileupload/postformdata') !== -1;
}

function buildChunkedUploadFileIdentityKey(file) {
    if (!file) return '';
    return [String(file.name || ''), String(file.size || 0), String(file.lastModified || 0)].join('|');
}

function shouldSkipChunkedUploadRecentNativeIntercept(file) {
    const key = buildChunkedUploadFileIdentityKey(file);
    if (!key) return false;

    const now = Date.now();
    const lastIntercept = Number(_chunkedUploadRecentNativeIntercepts[key] || 0);
    if (Number.isFinite(lastIntercept) && (now - lastIntercept) < 1500) {
        return true;
    }

    _chunkedUploadRecentNativeIntercepts[key] = now;
    return false;
}

function rememberChunkedUploadContext(element) {
    if (element && element.nodeType === 1) {
        _chunkedUploadLastContextElement = element;
    }
}

function isChunkedUploadFileActive(file) {
    const key = buildChunkedUploadFileIdentityKey(file);
    if (!key) return false;
    return _chunkedUploadActiveFileKeys[key] === true;
}

function markChunkedUploadFileActive(file) {
    const key = buildChunkedUploadFileIdentityKey(file);
    if (!key) return '';
    _chunkedUploadActiveFileKeys[key] = true;
    return key;
}

function clearChunkedUploadFileActive(key) {
    if (!key) return;
    delete _chunkedUploadActiveFileKeys[key];
}

function isChunkedUploadElementVisible(element) {
    return !!(element && (element.offsetWidth || element.offsetHeight || element.getClientRects().length));
}

function toChunkedUploadSuggestedTitle(fileName) {
    const raw = String(fileName || '').trim();
    if (!raw) return '';

    const dotIndex = raw.lastIndexOf('.');
    if (dotIndex > 0) {
        return raw.slice(0, dotIndex);
    }

    return raw;
}

function applyChunkedUploadTitleValue(titleElement, suggested) {
    if (!titleElement || !suggested) return false;

    titleElement.value = suggested;
    titleElement.setAttribute('value', suggested);
    titleElement.dispatchEvent(new Event('input', { bubbles: true }));
    titleElement.dispatchEvent(new Event('change', { bubbles: true }));
    titleElement.dispatchEvent(new Event('blur', { bubbles: true }));

    return String(titleElement.value || '').trim() === suggested;
}

function resolveChunkedUploadRecordFormVm(contextElement) {
    if (typeof ko === 'undefined') return null;

    const looksLikeRecordFormVm = function (vm) {
        if (!vm || typeof vm !== 'object') return false;
        if (vm.myName === 'RecordDataEntryForm') return true;
        if (vm.freeTextTitle && typeof vm.freeTextTitle.Value === 'function') return true;
        if (vm.recordTitleDecorator && typeof vm.recordTitleDecorator.Value === 'function') return true;
        return false;
    };

    let current = contextElement && contextElement.nodeType === 1 ? contextElement : document.activeElement;
    let depth = 0;
    while (current && depth < 20) {
        try {
            if (ko.dataFor) {
                const vm = ko.dataFor(current);
                if (looksLikeRecordFormVm(vm)) return vm;
            }

            if (ko.contextFor) {
                let context = ko.contextFor(current);
                let safety = 0;
                while (context && safety < 20) {
                    if (looksLikeRecordFormVm(context.$data)) {
                        return context.$data;
                    }
                    context = context.$parentContext;
                    safety++;
                }
            }
        } catch (e) {
            // Ignore KO context lookup failures and continue climbing DOM.
        }

        current = current.parentElement;
        depth++;
    }

    const rootRecordForm = window.root && window.root.recordMainCreationPanel;
    if (looksLikeRecordFormVm(rootRecordForm)) {
        return rootRecordForm;
    }

    return null;
}

function applyChunkedUploadTitleViaRecordFormVm(recordFormVm, suggested) {
    if (!recordFormVm || !suggested) return false;

    try {
        if (recordFormVm.titleString && typeof recordFormVm.titleString === 'function') {
            recordFormVm.titleString(suggested);
        }

        if (recordFormVm.freeTextTitle && typeof recordFormVm.freeTextTitle.Value === 'function') {
            recordFormVm.freeTextTitle.Value(suggested);
            if (typeof recordFormVm.freeTextTitle.error === 'function') {
                recordFormVm.freeTextTitle.error('');
            }
            return true;
        }

        if (recordFormVm.recordTitleDecorator && typeof recordFormVm.recordTitleDecorator.Value === 'function') {
            recordFormVm.recordTitleDecorator.Value(suggested);
            if (typeof recordFormVm.recordTitleDecorator.error === 'function') {
                recordFormVm.recordTitleDecorator.error('');
            }
            return true;
        }
    } catch (e) {
        logDebug('[ChunkedUpload] Failed to apply title via RecordDataEntryForm VM:', e);
    }

    return false;
}

function rememberChunkedUploadSuggestedTitle(file, contextElement) {
    const suggested = toChunkedUploadSuggestedTitle(file && file.name);
    if (!suggested) return;

    _chunkedUploadPendingSuggestedTitle = suggested;
    _chunkedUploadPendingTitleContextElement = contextElement || null;
    _chunkedUploadPendingTitleSetAtUtc = Date.now();
    ensureChunkedUploadPendingTitleObserver();
    scheduleChunkedUploadPendingTitleApply(contextElement || _chunkedUploadLastContextElement || document.body);
}

function clearChunkedUploadSuggestedTitle() {
    if (_chunkedUploadPendingTitleApplyTimer) {
        clearTimeout(_chunkedUploadPendingTitleApplyTimer);
        _chunkedUploadPendingTitleApplyTimer = null;
    }
    if (_chunkedUploadPendingTitleObserver) {
        try {
            _chunkedUploadPendingTitleObserver.disconnect();
        } catch (e) {
            // Ignore observer disconnect errors.
        }
        _chunkedUploadPendingTitleObserver = null;
    }

    _chunkedUploadPendingSuggestedTitle = '';
    _chunkedUploadPendingTitleContextElement = null;
    _chunkedUploadPendingTitleSetAtUtc = 0;
}

function scheduleChunkedUploadPendingTitleApply(contextElement) {
    if (!_chunkedUploadPendingSuggestedTitle) {
        return;
    }

    if (_chunkedUploadPendingTitleApplyTimer) {
        clearTimeout(_chunkedUploadPendingTitleApplyTimer);
        _chunkedUploadPendingTitleApplyTimer = null;
    }

    const context = contextElement || _chunkedUploadPendingTitleContextElement || _chunkedUploadLastContextElement || document.body;
    _chunkedUploadPendingTitleApplyTimer = setTimeout(function () {
        _chunkedUploadPendingTitleApplyTimer = null;
        ensureChunkedUploadTitleBeforeSubmit(context);
    }, 120);
}

function ensureChunkedUploadPendingTitleObserver() {
    if (_chunkedUploadPendingTitleObserver) {
        return;
    }

    if (typeof MutationObserver === 'undefined') {
        return;
    }

    const startObserver = function () {
        if (!document.body) {
            return false;
        }

        _chunkedUploadPendingTitleObserver = new MutationObserver(function () {
            if (!_chunkedUploadPendingSuggestedTitle) {
                return;
            }
            scheduleChunkedUploadPendingTitleApply(_chunkedUploadPendingTitleContextElement || _chunkedUploadLastContextElement || document.body);
        });

        _chunkedUploadPendingTitleObserver.observe(document.body, {
            childList: true,
            subtree: true
        });

        return true;
    };

    if (startObserver()) {
        return;
    }

    document.addEventListener('DOMContentLoaded', function onReady() {
        document.removeEventListener('DOMContentLoaded', onReady);
        startObserver();
    });
}

function findChunkedUploadTitleElement(contextElement, options) {
    const config = options || {};
    const preferEmpty = config.preferEmpty === true;
    const excludeElement = config.excludeElement || null;
    const roots = [];
    
    // First priority: search within contextual form (not body or document)
    if (contextElement && contextElement.closest) {
        const contextualForm = contextElement.closest('form, [role="tabpanel"], .content-wrapper');
        if (contextualForm) {
            roots.push(contextualForm);
        }
    }
    
    // Always include document as fallback to ensure we find the title element
    roots.push(document);

    for (let r = 0; r < roots.length; r++) {
        const root = roots[r];
        if (!root || typeof root.querySelectorAll !== 'function') continue;

        // Prefer controls explicitly tied to the "Title (Free Text Part)" label.
        const labels = root.querySelectorAll('label');
        for (let i = 0; i < labels.length; i++) {
            const label = labels[i];
            const text = String(label.textContent || '').toLowerCase().replace(/\s+/g, ' ').trim();
            if (text.indexOf('title (free text part)') < 0) continue;

            const forId = label.getAttribute('for');
            if (forId) {
                const byFor = root.querySelector(`#${forId}`);
                if (byFor && (byFor.tagName === 'TEXTAREA' || byFor.tagName === 'INPUT')) {
                    if (excludeElement && byFor === excludeElement) continue;
                    if (preferEmpty && String(byFor.value || '').trim()) continue;
                    return byFor;
                }
            }

            const nearby = label.parentElement && label.parentElement.querySelector
                ? label.parentElement.querySelector('textarea, input[type="text"]')
                : null;
            if (nearby) {
                if (excludeElement && nearby === excludeElement) continue;
                if (preferEmpty && String(nearby.value || '').trim()) continue;
                return nearby;
            }
        }

        let firstMatch = null;
        let firstEmptyMatch = null;

        const controls = root.querySelectorAll('textarea, input[type="text"]');
        for (let i = 0; i < controls.length; i++) {
            const control = controls[i];
            if (!control || control.disabled || !isChunkedUploadElementVisible(control)) continue;
            if (excludeElement && control === excludeElement) continue;

            const attrs = [
                control.name,
                control.id,
                control.getAttribute('aria-label'),
                control.getAttribute('placeholder'),
                control.getAttribute('data-bind'),
                control.getAttribute('data-field'),
                control.className
            ].join(' ').toLowerCase();

            const isExplicitTitleField =
                attrs.indexOf('recordtitle') >= 0 ||
                attrs.indexOf('recordtypedtitle') >= 0 ||
                attrs.indexOf('freetexttitle') >= 0 ||
                attrs.indexOf('title (free text part)') >= 0;

            if (isExplicitTitleField) {
                if (!firstMatch) {
                    firstMatch = control;
                }

                const value = String(control.value || '').trim();
                if (!value && !firstEmptyMatch) {
                    firstEmptyMatch = control;
                }
            }
        }

        if (preferEmpty && firstEmptyMatch) {
            return firstEmptyMatch;
        }
        if (firstMatch) {
            return firstMatch;
        }

        for (let i = 0; i < labels.length; i++) {
            const label = labels[i];
            const text = String(label.textContent || '').toLowerCase();
            if (text.indexOf('title') < 0) continue;

            const forId = label.getAttribute('for');
            if (forId) {
                const byFor = root.querySelector(`#${forId}`);
                if (byFor && (byFor.tagName === 'TEXTAREA' || byFor.tagName === 'INPUT')) {
                    if (excludeElement && byFor === excludeElement) continue;
                    if (preferEmpty && String(byFor.value || '').trim()) continue;
                    return byFor;
                }
            }

            const nearby = label.parentElement && label.parentElement.querySelector
                ? label.parentElement.querySelector('textarea, input[type="text"]')
                : null;
            if (nearby) {
                if (excludeElement && nearby === excludeElement) continue;
                if (preferEmpty && String(nearby.value || '').trim()) continue;
                return nearby;
            }
        }
    }

    return null;
}

function tryAutofillChunkedUploadTitle(file, contextElement) {
    const suggested = toChunkedUploadSuggestedTitle(file && file.name);
    if (!suggested) {
        logDebug('[ChunkedUpload] Could not derive suggested title from filename.');
        return false;
    }

    const recordFormVm = resolveChunkedUploadRecordFormVm(contextElement);
    if (recordFormVm) {
        const existingVmTitle = String(
            (recordFormVm.freeTextTitle && typeof recordFormVm.freeTextTitle.Value === 'function' && recordFormVm.freeTextTitle.Value()) ||
            (recordFormVm.recordTitleDecorator && typeof recordFormVm.recordTitleDecorator.Value === 'function' && recordFormVm.recordTitleDecorator.Value()) ||
            ''
        ).trim();

        if (!existingVmTitle && applyChunkedUploadTitleViaRecordFormVm(recordFormVm, suggested)) {
            logDebug(`[ChunkedUpload] Autofilled title via RecordDataEntryForm VM: "${suggested}"`);
            return true;
        }
    }

    let titleElement = findChunkedUploadTitleElement(contextElement, { preferEmpty: true });
    if (!titleElement) {
        logDebug('[ChunkedUpload] Could not find title element for autofill.');
        return false;
    }

    const existing = String(titleElement.value || '').trim();
    if (existing) {
        const alternateTitleElement = findChunkedUploadTitleElement(contextElement, {
            preferEmpty: true,
            excludeElement: titleElement
        });
        if (alternateTitleElement) {
            titleElement = alternateTitleElement;
        } else {
            logDebug('[ChunkedUpload] Title element already has value, skipping autofill.');
            return false;
        }
    }

    if (applyChunkedUploadTitleValue(titleElement, suggested)) {
        logDebug(`[ChunkedUpload] Autofilled title to: "${suggested}"`);
        return true;
    }

    const verifyValue = String(titleElement.value || '').trim();
    logDebug(`[ChunkedUpload] Title autofill failed - value was not persisted (found: "${verifyValue}")`);
    return false;
}

function ensureChunkedUploadTitleBeforeSubmit(formElement) {
    if (!_chunkedUploadPendingSuggestedTitle) {
        return;
    }

    const ageMs = Date.now() - Number(_chunkedUploadPendingTitleSetAtUtc || 0);
    if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > (10 * 60 * 1000)) {
        clearChunkedUploadSuggestedTitle();
        return;
    }

    const searchRoot = formElement || _chunkedUploadPendingTitleContextElement || _chunkedUploadLastContextElement || document.body;

    const recordFormVm = resolveChunkedUploadRecordFormVm(searchRoot);
    if (recordFormVm) {
        const currentVmTitle = String(
            (recordFormVm.freeTextTitle && typeof recordFormVm.freeTextTitle.Value === 'function' && recordFormVm.freeTextTitle.Value()) ||
            (recordFormVm.recordTitleDecorator && typeof recordFormVm.recordTitleDecorator.Value === 'function' && recordFormVm.recordTitleDecorator.Value()) ||
            ''
        ).trim();

        // If title already exists in CM's form model, do not touch any DOM fields.
        // This prevents deferred reapply from accidentally filling unrelated inputs.
        if (currentVmTitle) {
            return;
        }

        if (!currentVmTitle && applyChunkedUploadTitleViaRecordFormVm(recordFormVm, _chunkedUploadPendingSuggestedTitle)) {
            logDebug(`[ChunkedUpload] Restored pending title via RecordDataEntryForm VM before submit: "${_chunkedUploadPendingSuggestedTitle}"`);
            return;
        }
    }

    const titleElement = findChunkedUploadTitleElement(searchRoot, { preferEmpty: true });
    if (!titleElement) {
        return;
    }

    const existing = String(titleElement.value || '').trim();
    if (existing) {
        return;
    }

    const applied = applyChunkedUploadTitleValue(titleElement, _chunkedUploadPendingSuggestedTitle);
    if (applied) {
        logDebug(`[ChunkedUpload] Restored pending title before submit: "${_chunkedUploadPendingSuggestedTitle}"`);
    }
}

const handleChunkedUploadRecordCreateClick = function (event) {
    const createButton = event && event.target && event.target.closest
        ? event.target.closest('#saveBtn, button#saveBtn, button[data-bind*="submit"], .btn-primary')
        : null;

    if (!createButton) return;

    const formElement = createButton.closest('form') || _chunkedUploadPendingTitleContextElement || _chunkedUploadLastContextElement || document.body;
    ensureChunkedUploadTitleBeforeSubmit(formElement);
};

const handleChunkedUploadRecordCreateCancelClick = function (event) {
    const cancelButton = event && event.target && event.target.closest
        ? event.target.closest('button[name="cancelBtn"], button[data-bind*="$parent.cancel"], button[data-bind*="cancel"]')
        : null;

    if (!cancelButton) return;
    if (!cancelButton.closest('.clsNewCreateRecordPanel')) return;

    updateAsyncAttachBadge(null, 'hidden');
    clearChunkedUploadSuggestedTitle();
};

const handleChunkedUploadFormFieldChange = function (event) {
    if (!_chunkedUploadPendingSuggestedTitle) {
        return;
    }

    const target = event && event.target && event.target.nodeType === 1 ? event.target : null;
    if (!target) {
        return;
    }

    if (target.matches && target.matches('input[type="file"], input[name="files[]"], input[name="file"]')) {
        return;
    }

    scheduleChunkedUploadPendingTitleApply(target);
};

function applyChunkedUploadTitleToPayloadObject(payload, suggestedTitle) {
    if (!payload || typeof payload !== 'object' || !suggestedTitle) {
        return false;
    }

    let changed = false;
    const keys = ['RecordTitle', 'RecordTypedTitle', 'freeTextTitle'];

    const setIfBlank = function (key) {
        const current = payload[key];

        if (current === undefined || current === null || current === '') {
            payload[key] = suggestedTitle;
            return true;
        }

        if (typeof current === 'string') {
            if (!current.trim()) {
                payload[key] = suggestedTitle;
                return true;
            }
            return false;
        }

        if (typeof current === 'object') {
            if ('Value' in current && (!current.Value || !String(current.Value).trim())) {
                current.Value = suggestedTitle;
                return true;
            }
            if ('NameString' in current && (!current.NameString || !String(current.NameString).trim())) {
                current.NameString = suggestedTitle;
                return true;
            }
        }

        return false;
    };

    for (let i = 0; i < keys.length; i++) {
        if (setIfBlank(keys[i])) {
            changed = true;
        }
    }

    if (!('RecordTitle' in payload) && !('RecordTypedTitle' in payload) && !('freeTextTitle' in payload)) {
        payload.RecordTitle = suggestedTitle;
        changed = true;
    }

    return changed;
}

function resolveChunkedUploadPendingForPayload(payloadText) {
    const pendingKeys = Object.keys(_chunkedUploadPendingOps || {});
    if (!pendingKeys.length) return null;

    // Prefer exact payload token match when available.
    if (typeof payloadText === 'string' && payloadText) {
        for (let i = 0; i < pendingKeys.length; i++) {
            const key = pendingKeys[i];
            if (payloadText.includes(key.replace(/\\/g, '\\\\')) || payloadText.includes(key)) {
                return {
                    uploadedFileName: key,
                    pending: _chunkedUploadPendingOps[key]
                };
            }
        }
    }

    if (pendingKeys.length === 1) {
        const key = pendingKeys[0];
        return {
            uploadedFileName: key,
            pending: _chunkedUploadPendingOps[key]
        };
    }

    return null;
}

function applyChunkedUploadFilePayloadObject(payload, payloadText) {
    if (!payload || typeof payload !== 'object') return false;

    const resolved = resolveChunkedUploadPendingForPayload(payloadText);
    if (!resolved || !resolved.pending) return false;

    const pending = resolved.pending;
    if (pending.isLargeFilePilotCandidate === true) {
        // Large-file pilot intentionally avoids native attach payload.
        return false;
    }

    const uploadedFileName = String(resolved.uploadedFileName || '').trim();
    if (!uploadedFileName) return false;

    let changed = false;
    const existingRecordFilePath = String(payload.RecordFilePath || '').trim();
    const existingFromFileName = String(payload.fromFileName || '').trim();

    if (!existingRecordFilePath) {
        payload.RecordFilePath = uploadedFileName;
        changed = true;
    }

    if (!existingFromFileName && pending.originalFileName) {
        payload.fromFileName = pending.originalFileName;
        changed = true;
    }

    return changed;
}

function enforceChunkedUploadTitleInRecordSaveBody(body) {
    const suggested = String(_chunkedUploadPendingSuggestedTitle || '').trim();
    if (!body) {
        return body;
    }

    if (typeof body === 'string') {
        const trimmed = body.trim();
        if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
            try {
                const parsed = JSON.parse(body);
                const titleChanged = suggested ? applyChunkedUploadTitleToPayloadObject(parsed, suggested) : false;
                const fileChanged = applyChunkedUploadFilePayloadObject(parsed, body);
                if (titleChanged || fileChanged) {
                    return JSON.stringify(parsed);
                }
            } catch (e) {
                // Ignore JSON parse errors and keep original body.
            }
        }
        return body;
    }

    if (typeof body === 'object') {
        if (suggested) {
            applyChunkedUploadTitleToPayloadObject(body, suggested);
        }
        applyChunkedUploadFilePayloadObject(body, '');
        return body;
    }

    return body;
}

function hideChunkedUploadProgressMessageDom() {
    const textNodes = document.querySelectorAll('div, span');
    for (let i = 0; i < textNodes.length; i++) {
        const node = textNodes[i];
        const text = String(node.textContent || '').trim();

        if (/^Upload Progress\s*:\s*\d+%$/i.test(text)) {
            const container = node.closest('div, li, section') || node;
            if (container && container.style) {
                container.style.display = 'none';
            } else if (node.style) {
                node.style.display = 'none';
            }
        }
    }
}

function extractChunkedUploadFileFromFormData(formData) {
    if (!formData || typeof formData.entries !== 'function') return null;

    const iterator = formData.entries();
    if (!iterator || typeof iterator.next !== 'function') return null;

    let step = iterator.next();
    while (step && step.done !== true) {
        const pair = step.value || [];
        const value = pair[1];
        if (value && typeof value === 'object' && typeof value.name === 'string' && typeof value.size === 'number') {
            return value;
        }
        step = iterator.next();
    }

    return null;
}

function tryInterceptChunkedUploadNativeFormDataBody(body) {
    if (!body || typeof FormData === 'undefined' || !(body instanceof FormData)) {
        return false;
    }

    const file = extractChunkedUploadFileFromFormData(body);
    if (!file) return false;
    if (isChunkedUploadFileActive(file)) return true;
    if (shouldSkipChunkedUploadRecentNativeIntercept(file)) return true;

    const fallbackInput = _chunkedUploadLastContextElement || document.querySelector('input[type="file"][name="files[]"], input[type="file"][name="file"], input[type="file"]');
    rememberChunkedUploadContext(fallbackInput || document.body);
    void processChunkedUploadFile(file, fallbackInput || document.body, fallbackInput || null);
    return true;
}

function tryInterceptChunkedUploadNativeFormSubmit(formElement) {
    if (!formElement || !formElement.action) return false;
    if (!isChunkedUploadNativePostFormDataUrl(formElement.action)) return false;

    const fileInput = formElement.querySelector('input[type="file"]');
    if (!fileInput || !fileInput.files || fileInput.files.length === 0) return false;

    rememberChunkedUploadContext(fileInput);
    void processChunkedUploadFile(fileInput.files[0], fileInput, fileInput);
    return true;
}

const handleChunkedUploadNativeFormSubmit = function (event) {
    const formElement = event && event.target && event.target.closest
        ? event.target.closest('form')
        : null;

    if (!formElement) return;
    ensureChunkedUploadTitleBeforeSubmit(formElement);
    if (!tryInterceptChunkedUploadNativeFormSubmit(formElement)) return;

    // Stop legacy native file upload form submit; chunked upload has been started.
    event.preventDefault();
    event.stopImmediatePropagation();
};

(function installChunkedUploadNativeFormSubmitInterceptor() {
    if (window.__chunkedUploadNativeFormSubmitInterceptorInstalled === true) {
        return;
    }
    window.__chunkedUploadNativeFormSubmitInterceptorInstalled = true;

    document.addEventListener('submit', handleChunkedUploadNativeFormSubmit, true);

    const FormProto = (window.HTMLFormElement && window.HTMLFormElement.prototype)
        ? window.HTMLFormElement.prototype
        : null;
    if (!FormProto || FormProto.__chunkedUploadSubmitPatched === true) {
        return;
    }

    const originalSubmit = FormProto.submit;
    if (typeof originalSubmit !== 'function') {
        return;
    }

    FormProto.submit = function () {
        if (tryInterceptChunkedUploadNativeFormSubmit(this)) {
            return;
        }
        return originalSubmit.apply(this, arguments);
    };
    FormProto.__chunkedUploadSubmitPatched = true;
})();

async function processChunkedUploadFile(file, contextElement, clearInputElement) {
    if (!file) return;

    const effectiveContext = contextElement || _chunkedUploadLastContextElement || document.activeElement || document.body;
    rememberChunkedUploadContext(effectiveContext);

    // Reset per-flow auto-refresh guard so every new create flow can trigger post-attach navigation.
    _chunkedUploadAsyncAttachAutoRefreshScheduled = false;

    if (isChunkedUploadFileActive(file)) {
        logDebug('[ChunkedUpload] Skipping duplicate process invocation for active file:', file.name);
        return;
    }

    const activeFileKey = markChunkedUploadFileActive(file);

    // Starting a new upload should clear stale async attach status from prior flows.
    updateAsyncAttachBadge(null, 'hidden');
    hideChunkedUploadProgressMessageDom();

    const koViewModel = resolveUploadKoViewModel(effectiveContext) || resolveAnyUploadKoViewModel();
    const checkInOptions = resolveCheckInOptionsFromContext(effectiveContext);
    const isLargeFilePilotCandidate = isChunkedUploadLargeFilePilotCandidate(file.size);
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
            hideChunkedUploadProgressMessageDom();
            window._chunkedUploadOverlay.update(percent, getChunkedUploadProgressMessage(percent, cancellationState.isResumingUpload === true));
        }, cancellationState, checkInOptions);

        logDebug('Chunked upload completed successfully! Staged file path:', result.StagedFilePath);

        const uploadedFileName = result.RecordFilePath || result.StagedFilePath;
        const fullUploadedFileName = result.FullUploadedFileName || result.StagedFilePath;
        const uiUploadedFileName = isLargeFilePilotCandidate ? '' : uploadedFileName;

        if (isLargeFilePilotCandidate) {
            logDebug(`Large-file pilot is active for ${file.name} (${file.size} bytes). Threshold=${resolveChunkedUploadLargeFilePilotThresholdMb()} MB.`);
        }

        // Register post-save verification + cleanup metadata.
        if (uploadedFileName) {
            registerPendingUpload(uploadedFileName, {
                expectedHash: result.AssembledSha256 || '',
                sessionId: result.SessionId || '',
                stagedFilePath: result.StagedFilePath || '',
                fullUploadedFileName: result.FullUploadedFileName || '',
                fileCacheKey: cancellationState.fileCacheKey || '',
                originalFileName: file.name,
                fileSize: file.size || 0,
                isLargeFilePilotCandidate: isLargeFilePilotCandidate,
                newRevision: checkInOptions.newRevision === true,
                keepCheckedOut: checkInOptions.keepCheckedOut === true,
                comments: checkInOptions.comments || ''
            }, file.name);
            logDebug('Registered pending post-save operations for:', uploadedFileName);
        }

        const text = getChunkedUploadOverlayText();
        window._chunkedUploadOverlay.update(100, text.uploadComplete);
    window._chunkedUploadOverlay.disableCancel();

        // Mirror the native widget success state so the selected file remains visible
        // in the dialog after the chunked upload completes.
        if (applySuccessfulUploadState(koViewModel, file, uiUploadedFileName, fullUploadedFileName, {
            deferNativeAttach: isLargeFilePilotCandidate
        })) {
            logDebug('Injected staged path and visible success state into KO uploader. UploadedFileName:', uiUploadedFileName || '(deferred async attach)');
        } else {
            logDebug('Could not find KO ViewModel for uploader context; retrying shortly.');
            applySuccessfulUploadStateWithRetry(file, uiUploadedFileName, fullUploadedFileName, {
                deferNativeAttach: isLargeFilePilotCandidate
            });
        }

        hideChunkedUploadProgressMessageDom();
        rememberChunkedUploadSuggestedTitle(file, effectiveContext);
        tryAutofillChunkedUploadTitle(file, effectiveContext);
        if (isLargeFilePilotCandidate) {
            updateAsyncAttachBadge(null, 'queued');
        }

        // Brief pause so the user sees 100% before the overlay disappears.
        setTimeout(function () { window._chunkedUploadOverlay.hide(); }, 800);
    } catch (error) {
        if (isChunkedUploadCancelled(error)) {
            logDebug('Chunked upload cancelled by user.');
            resetChunkedUploadWidgetAfterCancel(koViewModel, clearInputElement);
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
        clearChunkedUploadFileActive(activeFileKey);
        // Always reset chooser value so selecting the same file again re-triggers change.
        if (clearInputElement && typeof clearInputElement.value !== 'undefined') {
            clearInputElement.value = '';
        }
    }
}

function resolveChunkedUploadDropContext(event) {
    if (!event) return null;

    const resolveInput = function (root) {
        if (!root || typeof root.querySelector !== 'function') return null;
        return root.querySelector('input[type="file"][name="files[]"], input[type="file"][name="file"], input[type="file"]');
    };

    const path = (typeof event.composedPath === 'function') ? event.composedPath() : [];
    for (let i = 0; i < path.length; i++) {
        const node = path[i];
        if (!node || node === window || node === document) continue;

        if (node.matches && node.matches('.upload-drop-zone.dropzone, .upload-drop-zone, .dropzone, [data-dropzone]')) {
            return {
                container: node,
                input: resolveInput(node)
            };
        }

        const candidateInput = resolveInput(node);
        if (candidateInput) {
            return {
                container: node,
                input: candidateInput
            };
        }
    }

    const target = event.target;
    let current = target && target.nodeType === 1 ? target : (target && target.parentElement ? target.parentElement : null);
    let depth = 0;
    while (current && depth < 16) {
        if (current.matches && current.matches('.upload-drop-zone.dropzone, .upload-drop-zone, .dropzone, [data-dropzone]')) {
            return {
                container: current,
                input: resolveInput(current)
            };
        }

        const candidateInput = resolveInput(current);
        if (candidateInput) {
            return {
                container: current,
                input: candidateInput
            };
        }

        current = current.parentElement;
        depth++;
    }

    const globalInput = document.querySelector('input[type="file"][name="files[]"], input[type="file"][name="file"], input[type="file"]');
    if (!globalInput) return null;
    return { container: globalInput, input: globalInput };
}

function isChunkedUploadFileDrop(event) {
    if (!event || !event.dataTransfer) return false;

    const files = event.dataTransfer.files;
    if (files && files.length > 0) {
        return true;
    }

    const items = event.dataTransfer.items;
    if (!items || items.length === 0) {
        return false;
    }

    for (let i = 0; i < items.length; i++) {
        if (items[i] && items[i].kind === 'file') {
            return true;
        }
    }

    return false;
}

const handleChunkedUploadDrop = async function (event) {
    if (!isChunkedUploadFileDrop(event)) return;

    const dropContext = resolveChunkedUploadDropContext(event);
    if (!dropContext) return;

    const dt = event.dataTransfer;
    if (!dt || !dt.files || dt.files.length === 0) return;

    // Prevent native drop processing to avoid duplicate uploads.
    event.preventDefault();
    event.stopImmediatePropagation();

    rememberChunkedUploadContext(dropContext.input || dropContext.container);
    await processChunkedUploadFile(dt.files[0], dropContext.input || dropContext.container, dropContext.input || null);
};

const handleChunkedUploadDragOver = function (event) {
    if (!isChunkedUploadFileDrop(event)) return;

    const dropContext = resolveChunkedUploadDropContext(event);
    if (!dropContext) return;

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
    window.addEventListener('dragover', handleChunkedUploadDragOver, true);
    window.addEventListener('drop', handleChunkedUploadDrop, true);
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

if (window.__chunkedUploadRecordCreateClickHandlerInstalled !== true) {
    document.addEventListener('click', handleChunkedUploadRecordCreateClick, true);
    document.addEventListener('click', handleChunkedUploadRecordCreateCancelClick, true);
    window.__chunkedUploadRecordCreateClickHandlerInstalled = true;
}

if (window.__chunkedUploadFormFieldChangeHandlerInstalled !== true) {
    document.addEventListener('change', handleChunkedUploadFormFieldChange, true);
    window.__chunkedUploadFormFieldChangeHandlerInstalled = true;
}

(function applyChunkedUploadPendingPostAttachQueryOnLoad() {
    if (window.__chunkedUploadPostAttachQueryApplied === true) {
        return;
    }
    window.__chunkedUploadPostAttachQueryApplied = true;

    // Drain any stale key from previous builds; current flow does not replay creator-query navigation.
    consumeChunkedUploadPendingPostAttachUri();
})();

function resolveChunkedUploadBandwidthHints() {
    const networkHintMbps = readChunkedUploadNetworkUplinkMbps();
    const performanceHintMbps = readChunkedUploadPerformanceHintMbps();

    let chosenMbps = null;
    if (Number.isFinite(networkHintMbps) && Number.isFinite(performanceHintMbps)) {
        // Use conservative estimate to avoid over-thresholding on unstable links.
        chosenMbps = Math.min(networkHintMbps, performanceHintMbps);
    } else if (Number.isFinite(networkHintMbps)) {
        chosenMbps = networkHintMbps;
    } else if (Number.isFinite(performanceHintMbps)) {
        chosenMbps = performanceHintMbps;
    }

    return {
        networkHintMbps: networkHintMbps,
        performanceHintMbps: performanceHintMbps,
        chosenMbps: chosenMbps
    };
}

function mapChunkedUploadMbpsToConcurrency(mbps) {
    if (!Number.isFinite(mbps) || mbps <= 0) {
        return CHUNKED_UPLOAD_DEFAULT_MAX_CONCURRENT;
    }

    if (mbps < 1) return 1;
    if (mbps < 3) return 2;
    if (mbps < 8) return 3;
    if (mbps < 20) return 4;
    if (mbps < 50) return 5;
    if (mbps < 100) return 6;
    if (mbps < 200) return 7;
    return 8;
}

function calculateChunkedUploadDynamicConcurrency() {
    const hints = resolveChunkedUploadBandwidthHints();
    const networkHint = hints.networkHintMbps;
    const perfHint = hints.performanceHintMbps;
    const chosenMbps = hints.chosenMbps;

    if (!Number.isFinite(chosenMbps) || chosenMbps <= 0) {
        return null;
    }

    let mappedConcurrency = clampChunkedUploadConcurrency(mapChunkedUploadMbpsToConcurrency(chosenMbps));
    mappedConcurrency = applyChunkedUploadPerfOnlyConcurrencyCap(mappedConcurrency, networkHint, perfHint);

    return mappedConcurrency;
}