/**
 * HAR-to-Splunk APM Trace Mapper (Batch Mode)
 *
 * Usage:
 * node api-tracer.js <output_zip_name> <domain_regex> <har_file_1> [har_file_2] ...
 *
 * Example:
 * node api-tracer.js my-reports.zip "api\\.example\\.com" login.har checkout.har
 */

import fs from 'fs';
import path from 'path';
import fetch from 'node-fetch';
import https from 'https';
import AdmZip from 'adm-zip';

// =================================================================
// --- CONFIGURATION ---
// =================================================================

const HAR_CORRELATION_ID_HEADER = 'x-correlation-id';
const HAR_CACHE_CONTROL_HEADER = 'x-cache-control';
const SPLUNK_APM_GQL_PATH = '/v2/apm/graphql?op=TraceFullDetailsLessValidation';
const DEBUG_TRACE_DIR = './splunk_traces';

// =================================================================
// --- Main Script Logic ---
// =================================================================

async function main() {
    try {
        // --- 1. Validate Arguments ---
        // Expected: node api-tracer.js <zip_name> <regex> <har1> ...
        const args = process.argv.slice(2);

        if (args.length < 3) {
            console.error('Error: Insufficient arguments.');
            console.error('Usage: node api-tracer.js <output_zip_name> <domain_regex> <har_file_1> [har_file_2] ...');
            process.exit(1);
        }

        const outputZipName = args[0].endsWith('.zip') ? args[0] : `${args[0]}.zip`;
        const domainRegexStr = args[1];
        const harFiles = args.slice(2);

        // --- 2. Check Environment Variables ---
        const { SPLUNK_HOST, SPLUNK_APM_TOKEN, SPLUNK_UI_HOST } = process.env;
        if (!SPLUNK_HOST || !SPLUNK_APM_TOKEN || !SPLUNK_UI_HOST) {
            console.error('Error: Missing environment variables (SPLUNK_HOST, SPLUNK_APM_TOKEN, SPLUNK_UI_HOST).');
            process.exit(1);
        }

        // --- 3. Create Debug Directory (Optional) ---
        try {
            if (!fs.existsSync(DEBUG_TRACE_DIR)) {
                fs.mkdirSync(DEBUG_TRACE_DIR);
            }
        } catch (err) {}

        // Initialize ZIP object
        const zip = new AdmZip();
        console.log(`--- Processing ${harFiles.length} HAR file(s) ---`);

        // --- 4. Process Each HAR File ---
        for (const harFilePath of harFiles) {
            console.log(`\nProcessing: ${harFilePath}`);

            if (!fs.existsSync(harFilePath)) {
                console.error(`  [Skipped] File not found: ${harFilePath}`);
                continue;
            }

            try {
                // Generate the data structure for this HAR
                const reportData = await processSingleHar(harFilePath, domainRegexStr, SPLUNK_HOST, SPLUNK_APM_TOKEN);

                if (reportData) {
                    // Create a JS file content string
                    // We save it as a JS file that calls registerReportData
                    // This allows the viewer to load it easily if extracted, or parsed if in zip.
                    const jsonData = JSON.stringify(reportData, null, 2);
                    const fileContent = `window.registerReportData("${path.basename(harFilePath)}", ${jsonData});`;

                    const outputFileName = `${path.basename(harFilePath)}.report-data.js`;
                    zip.addFile(outputFileName, Buffer.from(fileContent, 'utf8'));
                    console.log(`  [Success] Added ${outputFileName} to archive.`);
                }
            } catch (err) {
                console.error(`  [Error] Failed to process ${harFilePath}:`, err.message);
            }
        }

        // --- 5. Write ZIP File ---
        console.log(`\n--- Writing Archive: ${outputZipName} ---`);
        zip.writeZip(outputZipName);
        console.log('Done!');

    } catch (err) {
        console.error('An unexpected fatal error occurred:', err.message);
    }
}

// =================================================================
// --- Processing Logic ---
// =================================================================

async function processSingleHar(harFilePath, regexStr, splunkHost, apmToken) {
    // 1. Parse HAR
    const allRequests = parseHarFile(harFilePath, regexStr);

    if (allRequests.length === 0) {
        console.warn(`  [Info] No matching requests found in ${harFilePath}`);
        return null;
    }

    // 2. Group by ID to query efficiently
    const idToUrlsMap = new Map();
    for (const req of allRequests) {
        if (!idToUrlsMap.has(req.id)) idToUrlsMap.set(req.id, []);
        idToUrlsMap.get(req.id).push(req);
    }

    // 3. Query Splunk
    const traceDataCache = new Map();
    const ids = Array.from(idToUrlsMap.keys());

    for (const correlationId of ids) {
        process.stdout.write('.');
        const tracedUrls = await querySplunkApm(correlationId, splunkHost, apmToken);
        traceDataCache.set(correlationId, tracedUrls);
    }
    process.stdout.write('\n');

    // 4. Build Results
    const results = [];
    for (const req of allRequests) {
        const tracedUrls = traceDataCache.get(req.id) || [{ method: 'N/A', url: '- No trace data found -', duration: 0 }];
        results.push({
            sourceUrl: req.sourceUrl,
            method: req.method,
            correlationId: req.id,
            cacheControl: req.cacheControl,
            startedDateTime: req.startedDateTime,
            harResponseTime: req.harResponseTime,
            tracedUrls: tracedUrls.length > 0 ? tracedUrls : [{ method: 'N/A', url: '- No leaf node traces found -', duration: 0 }]
        });
    }

    // 5. Sort Chronologically
    results.sort((a, b) => new Date(a.startedDateTime) - new Date(b.startedDateTime));

    // 6. Metadata
    let startTime = null;
    let endTime = null;
    if (results.length > 0) {
        startTime = results[0].startedDateTime;
        endTime = results[results.length - 1].startedDateTime;
    }

    return {
        metadata: {
            filename: path.basename(harFilePath),
            generatedAt: new Date().toISOString(),
            filterDomain: regexStr,
            traceStartTime: startTime,
            traceEndTime: endTime,
            totalRequests: results.length
        },
        data: results
    };
}

// --- Helper Functions ---

function parseHarFile(filePath, regexStr) {
    const allRequests = [];
    const domainRegex = new RegExp(regexStr);
    let harData, har;

    try {
        harData = fs.readFileSync(filePath, 'utf8');
        har = JSON.parse(harData);
    } catch (err) {
        throw new Error(`Failed to read/parse HAR file: ${err.message}`);
    }

    if (!har.log || !har.log.entries) throw new Error('Invalid HAR file format.');

    for (const entry of har.log.entries) {
        const sourceUrl = entry.request.url;
        if (domainRegex.test(sourceUrl)) {
            let correlationId = findHeaderValue(entry.request.headers, HAR_CORRELATION_ID_HEADER);
            if (!correlationId && entry.response) correlationId = findHeaderValue(entry.response.headers, HAR_CORRELATION_ID_HEADER);

            if (correlationId) {
                const cacheControl = findHeaderValue(entry.response.headers, HAR_CACHE_CONTROL_HEADER) ||
                                     findHeaderValue(entry.response.headers, 'cache-control') || 'N/A';
                const timings = entry.timings;
                // Some HARs have -1 for unavailable timings, ensure we don't sum negatives
                const wait = Math.max(0, timings.wait || 0);
                const receive = Math.max(0, timings.receive || 0);
                const harResponseTime = wait + receive;

                allRequests.push({
                    id: correlationId,
                    cacheControl,
                    startedDateTime: entry.startedDateTime,
                    sourceUrl,
                    method: entry.request.method,
                    harResponseTime: Math.round(harResponseTime)
                });
            }
        }
    }
    return allRequests;
}

function findHeaderValue(headers, headerName) {
    if (!headers || !Array.isArray(headers)) return null;
    const h = headers.find(x => x.name.toLowerCase() === headerName.toLowerCase());
    return h ? h.value : null;
}

async function querySplunkApm(traceId, splunkHost, apmToken) {
    const endpoint = `https://${splunkHost}${SPLUNK_APM_GQL_PATH}`;
    const ignoreSSLErrors = process.env.IGNORE_SSL === 'true';
    let fetchAgent = ignoreSSLErrors ? new https.Agent({ rejectUnauthorized: false }) : undefined;

    const targetedQuery = {
        operationName: "TraceFullDetailsLessValidation",
        variables: { spanLimit: 1000, id: traceId },
        query: "query TraceFullDetailsLessValidation($id: ID!, $spanLimit: Float = 5000) {\n  trace: traceLessValidation(id: $id, spanLimit: $spanLimit) {\n    traceID\n    spans\n  }\n}\n"
    };

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-sf-token': apmToken },
            body: JSON.stringify(targetedQuery),
            agent: fetchAgent
        });

        const jsonResponse = await response.json();

        try {
            const debugFilePath = path.join(DEBUG_TRACE_DIR, `${traceId}.json`);
            fs.writeFileSync(debugFilePath, JSON.stringify(jsonResponse, null, 2));
        } catch(e){}

        if (!response.ok) return [{ method: 'N/A', url: `- Splunk API Error ${response.status} -`, duration: 0 }];
        return parseApmResponse(jsonResponse);
    } catch (err) {
        return [{ method: 'N/A', url: `- Error fetching data -`, duration: 0 }];
    }
}

function parseApmResponse(jsonResponse) {
    if (!jsonResponse.data?.trace?.spans) return [{ method: 'N/A', url: '- No spans found -', duration: 0 }];

    let spans = jsonResponse.data.trace.spans;
    if (typeof spans === 'string') {
        try { spans = JSON.parse(spans); } catch (e) { return [{ method: 'N/A', url: '- Error parsing spans JSON -', duration: 0 }]; }
    }
    if (!Array.isArray(spans)) return [{ method: 'N/A', url: '- No spans found -', duration: 0 }];

    const parentSpanIds = new Set();
    spans.forEach(s => s.references?.forEach(r => { if (r.refType === 'CHILD_OF') parentSpanIds.add(r.spanID); }));

    const seenUrls = new Map();
    spans.forEach(s => {
        if (!parentSpanIds.has(s.spanID) && s.tags) {
            const urlTag = s.tags.find(t => t.key === 'url.full' && t.value);
            if (urlTag) {
                const url = urlTag.value.trim();
                const methodTag = s.tags.find(t => t.key === 'http.request.method');
                const method = (methodTag ? methodTag.value : 'N/A').toUpperCase();
                const duration = s.duration || 0;
                const startTime = s.startTime || 0;

                if (!seenUrls.has(url) || seenUrls.get(url).startTime > startTime) {
                    seenUrls.set(url, { method, url, duration, startTime });
                }
            }
        }
    });

    const traces = [...seenUrls.values()];
    if (traces.length === 0) return [{ method: 'N/A', url: '- No leaf node traces found -', duration: 0 }];
    return traces.sort((a, b) => a.startTime - b.startTime);
}

main();


