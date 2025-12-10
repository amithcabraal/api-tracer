// Config
const DURATION_THRESHOLD_MS = 300;
const TIMING_WARN_MS = 2000;
const TIMING_CRIT_MS = 5000;
const SPLUNK_UI_HOST = 'https://allwyn.signalfx.com/#';

// State
let currentDataItems = [];
let currentMetadata = {};
let availableReports = {}; 

window.registerReportData = function(filename, data) {
    if (data.data && data.metadata) {
        availableReports[filename] = data;
    } else {
        availableReports[filename] = {
            metadata: { filename: filename },
            data: data
        };
    }
};

function switchReport() {
    const selector = document.getElementById('reportSelector');
    const selectedFilename = selector.value;
    
    if (!selectedFilename || !availableReports[selectedFilename]) return;

    const report = availableReports[selectedFilename];
    currentDataItems = report.data || [];
    currentMetadata = report.metadata || {};

    renderMetadata(currentMetadata);
    filterAndRender();
}

async function handleFileUpload(event) {
    const file = event.target.files[0];
    if (!file) return;

    availableReports = {}; 
    document.getElementById('reportSelector').innerHTML = '';
    document.getElementById('reportSelector').style.display = 'none';

    if (file.name.endsWith('.zip')) {
        await processZipFile(file);
    } else {
        const reader = new FileReader();
        reader.onload = (e) => processSingleContent(file.name, e.target.result);
        reader.readAsText(file);
    }
}

async function tryLoadDefaultZip() {
    try {
        const response = await fetch('report-data.zip');
        if (response.ok) {
            const blob = await response.blob();
            const file = new File([blob], "report-data.zip", { type: "application/zip" });
            await processZipFile(file);
        }
    } catch (e) {
        console.log("No default report-data.zip found.");
    }
}

async function processZipFile(file) {
    try {
        const zip = new JSZip();
        const zipContents = await zip.loadAsync(file);
        
        const promises = [];
        zip.forEach((relativePath, zipEntry) => {
            if (!zipEntry.dir && (zipEntry.name.endsWith('.js') || zipEntry.name.endsWith('.json'))) {
                const p = zipEntry.async("string").then(content => {
                    processSingleContent(zipEntry.name, content, true); 
                });
                promises.push(p);
            }
        });

        await Promise.all(promises);
        
        const filenames = Object.keys(availableReports).sort();
        if (filenames.length > 0) {
            const selector = document.getElementById('reportSelector');
            selector.innerHTML = '';
            
            filenames.forEach(name => {
                const opt = document.createElement('option');
                opt.value = name;
                opt.textContent = name;
                selector.appendChild(opt);
            });
            
            selector.style.display = 'block';
            selector.value = filenames[0];
            switchReport(); 
        } else {
            alert("No valid report files found in ZIP.");
        }

    } catch (e) {
        alert("Error reading ZIP file: " + e.message);
    }
}

function processSingleContent(filename, content, accumulate = false) {
    try {
        let jsonStr = content;
        if (content.trim().startsWith('window.registerReportData')) {
            new Function(content)();
            return;
        } 
        
        if (content.trim().startsWith('const reportData =')) {
            jsonStr = content.replace('const reportData =', '').trim();
            if (jsonStr.endsWith(';')) jsonStr = jsonStr.slice(0, -1);
        }

        const data = JSON.parse(jsonStr);
        window.registerReportData(filename, data);

        if (!accumulate) {
            switchReport(); 
        }

    } catch (err) {
        console.error(`Failed to parse ${filename}`, err);
    }
}

function renderMetadata(metadata) {
    const container = document.getElementById('metadata-container');
    if (!metadata || Object.keys(metadata).length === 0) {
        container.style.display = 'none';
        return;
    }
    const fmtDate = (isoStr) => isoStr ? new Date(isoStr).toLocaleString() : 'N/A';

    container.innerHTML = `
        <div class="meta-item"><strong>File</strong><span>${metadata.filename || 'Unknown'}</span></div>
        <div class="meta-item"><strong>Filter</strong><span>${metadata.filterDomain || 'N/A'}</span></div>
        <div class="meta-item"><strong>Requests</strong><span>${metadata.totalRequests || 0}</span></div>
        <div class="meta-item"><strong>Start</strong><span>${fmtDate(metadata.traceStartTime)}</span></div>
        <div class="meta-item"><strong>End</strong><span>${fmtDate(metadata.traceEndTime)}</span></div>
    `;
    container.style.display = 'grid';
}

function highlightCache(text) {
    if (!text) return 'N/A';
    
    let className = '';
    if (text.includes('max-age=0') || text.includes('no-cache') || text.includes('no-store')) {
        className = 'cache-text-red';
    } else if (text.includes('s-maxage=0')) {
        className = 'cache-text-orange';
    }
    
    if (className) {
        return `<span class="${className}">${text}</span>`;
    }
    return text;
}

function getHarTimingClass(timeMs) {
    if (timeMs > TIMING_CRIT_MS) return 'timing-crit';
    if (timeMs > TIMING_WARN_MS) return 'timing-warn';
    return '';
}

function renderTable(dataToRender) {
    const tbody = document.getElementById('reportBody');
    const htmlRows = [];

    if (!dataToRender || dataToRender.length === 0) {
        tbody.innerHTML = '<tr><td colspan="3" style="text-align:center; padding: 20px;">No data matches the current filters.</td></tr>';
        return;
    }

    dataToRender.forEach((item, index) => {
        if (item.tracedUrls.length === 0) return;

        const rowSpan = item.tracedUrls.length;
        const harMethod = (item.method || 'N/A').toUpperCase();
        const rowNum = item.originalIndex + 1; // Use preserved index

        const firstTrace = item.tracedUrls[0];
        const firstTraceMethod = (firstTrace.method || 'N/A').toUpperCase();
        const firstTraceDurationMs = firstTrace.duration / 1000;
        const firstTraceSlowClass = firstTraceDurationMs > DURATION_THRESHOLD_MS ? 'slow-trace' : '';
        const firstTraceHtml = `<span class="method-tag method-${firstTraceMethod}">${firstTraceMethod}</span><span class="url-text">${firstTrace.url}</span> <span class="duration-tag">(${firstTraceDurationMs.toFixed(0)} ms)</span>`;

        const harTimeClass = getHarTimingClass(item.harResponseTime);
        const cacheHtml = highlightCache(item.cacheControl);

        htmlRows.push(`
          <tr class="trace-group-master">
            <td rowspan="${rowSpan}" class="row-number source-url-cell">${rowNum}</td>
            <td rowspan="${rowSpan}" class="source-url-cell">
                <span class="method-tag method-${harMethod}">${harMethod}</span><span class="url-text">${item.sourceUrl}</span><br>
                <small class="id-link">
                    ID: <a href="${SPLUNK_UI_HOST}/apm/traces/${item.correlationId}" target="_blank">${item.correlationId}</a>
                </small><br>
                <small class="har-timing ${harTimeClass}">
                    HAR Time: ${item.harResponseTime} ms
                </small><br>
                <small class="cache-control">
                    Cache: ${cacheHtml}
                </small>
            </td>
            <td class="trace-url-cell ${firstTraceSlowClass}">${firstTraceHtml}</td>
          </tr>
        `);

        for (let i = 1; i < rowSpan; i++) {
            const trace = item.tracedUrls[i];
            const m = (trace.method || 'N/A').toUpperCase();
            const dMs = trace.duration / 1000;
            const slow = dMs > DURATION_THRESHOLD_MS ? 'slow-trace' : '';
            const html = `<span class="method-tag method-${m}">${m}</span><span class="url-text">${trace.url}</span> <span class="duration-tag">(${dMs.toFixed(0)} ms)</span>`;

            htmlRows.push(`
              <tr class="trace-group-child">
                <td class="trace-url-cell ${slow}">${html}</td>
              </tr>
            `);
        }
    });

    tbody.innerHTML = htmlRows.join('');
}

function filterAndRender() {
    const sourceUrlFilter = document.getElementById('sourceUrlFilter').value.toLowerCase();
    const cacheFilter = document.getElementById('cacheFilter').value.toLowerCase();
    const domainFilter = document.getElementById('domainFilter').value.toLowerCase();
    const textFilter = document.getElementById('textFilter').value.toLowerCase();

    // Map original items to include their original index before filtering
    const indexedData = currentDataItems.map((item, index) => ({ ...item, originalIndex: index }));

    const filtered = indexedData.map(item => {
        // 1. Filter Source URL (match anywhere)
        if (sourceUrlFilter && !item.sourceUrl.toLowerCase().includes(sourceUrlFilter)) {
            return null;
        }

        // 2. Filter Cache Header
        const itemCache = (item.cacheControl || '').toLowerCase();
        if (cacheFilter && !itemCache.includes(cacheFilter)) {
            return null;
        }

        // 3. Filter Traced URLs (Domain & Text)
        const visibleTraces = item.tracedUrls.filter(t => {
            const txt = t.url.toLowerCase();
            // Allow errors/no-trace messages to show if trace filters are empty
            if (txt.startsWith('- no')) return domainFilter === '' && textFilter === '';
            
            let domain = '';
            const m = txt.match(/https?:\/\/([a-z0-9.-]+)/);
            if (m) domain = m[1];
            
            const domainMatch = domainFilter === '' || domain.includes(domainFilter);
            const textMatch = textFilter === '' || txt.includes(textFilter);

            return domainMatch && textMatch;
        });

        if (visibleTraces.length === 0) return null;

        return { ...item, tracedUrls: visibleTraces };
    }).filter(item => item !== null);

    renderTable(filtered);
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('sourceUrlFilter').addEventListener('keyup', filterAndRender);
    document.getElementById('cacheFilter').addEventListener('keyup', filterAndRender);
    document.getElementById('domainFilter').addEventListener('keyup', filterAndRender);
    document.getElementById('textFilter').addEventListener('keyup', filterAndRender);
    
    document.getElementById('fileInput').addEventListener('change', handleFileUpload);
    tryLoadDefaultZip();
});

window.switchReport = switchReport;

