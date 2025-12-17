// Config
const DURATION_THRESHOLD_MS = 300;
const TIMING_WARN_MS = 2000;
const TIMING_CRIT_MS = 5000;
const SPLUNK_UI_HOST = 'https://allwyn.signalfx.com/#';

// State
let currentDataItems = [];
let currentMetadata = {};
let availableReports = {}; 
let cy = null; // Cytoscape instance

// --- Data Loading & Management ---

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
    renderNetworkGraph(); // Render graph for the new data
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
        if (!accumulate) switchReport(); 
    } catch (err) {
        console.error(`Failed to parse ${filename}`, err);
    }
}

// --- View Switching ---

window.switchView = function(viewName) {
    const tabs = document.querySelectorAll('.view-tab');
    tabs.forEach(t => t.classList.remove('active'));
    
    // Toggle Active Tab Style
    const activeTab = Array.from(tabs).find(t => t.textContent.includes(viewName === 'table' ? 'Table' : 'Graph'));
    if (activeTab) activeTab.classList.add('active');

    document.getElementById('tableContainer').style.display = viewName === 'table' ? 'block' : 'none';
    const netContainer = document.getElementById('networkContainer');
    netContainer.style.display = viewName === 'network' ? 'block' : 'none';

    if (viewName === 'network') {
        if (cy) {
            cy.resize();
            cy.layout({ name: 'dagre', rankDir: 'LR', nodeSep: 50, rankSep: 100 }).run();
        } else {
            renderNetworkGraph();
        }
    }
};

// --- Graph Rendering ---

function renderNetworkGraph() {
    const container = document.getElementById('networkContainer');
    if (container.style.display === 'none') return;

    // We want One Node Per Task (Service + TaskArn)
    // Key: "Service::TaskArn" (or "Service::null" if missing)
    const taskNodes = new Map(); // Key -> { service, taskArn, id }
    const edges = new Map(); // "sourceKey->targetKey" -> { count, totalDuration }

    // Helper to generate unique key
    const getNodeKey = (service, taskArn) => `${service}::${taskArn || 'unknown'}`;

    // Aggregate data from all traces in the current report
    currentDataItems.forEach(item => {
        if (!item.graphData) return;
        
        // Map spanID to its Node Key for this specific trace
        const spanToNodeKey = new Map();
        
        item.graphData.forEach(span => {
            const key = getNodeKey(span.service, span.taskArn);
            spanToNodeKey.set(span.spanId, key);
            
            // Register Node if new
            if (!taskNodes.has(key)) {
                taskNodes.set(key, { 
                    service: span.service, 
                    taskArn: span.taskArn
                });
            }
        });

        // Edges: Link Parent Node -> Child Node
        item.graphData.forEach(span => {
            if (span.parentId && spanToNodeKey.has(span.parentId)) {
                const sourceKey = spanToNodeKey.get(span.parentId);
                const targetKey = getNodeKey(span.service, span.taskArn);
                
                // Allow self-loops if different spans? Usually we ignore service-internal calls for high level graphs,
                // but for task-level, self-loops might be interesting (intra-task calls). 
                // Let's filter perfectly identical source/target to keep graph clean unless requested otherwise.
                if (sourceKey !== targetKey) {
                    const edgeKey = `${sourceKey}->${targetKey}`;
                    const edgeData = edges.get(edgeKey) || { count: 0, totalDuration: 0 };
                    
                    edgeData.count++;
                    edgeData.totalDuration += (span.duration || 0); // micros
                    edges.set(edgeKey, edgeData);
                }
            }
        });
    });

    const elements = [];

    // Create Nodes
    // We need to number tasks per service to give them friendly labels like "Gateway #1", "Gateway #2"
    const serviceCounters = new Map(); // Service -> count

    taskNodes.forEach((info, key) => {
        let label = info.service;
        
        // Only append counter if we have distinct tasks (i.e. taskArn is not null)
        // OR if we just want to enumerate unique nodes regardless.
        // Let's enumerate if we have a taskArn.
        if (info.taskArn) {
            const count = (serviceCounters.get(info.service) || 0) + 1;
            serviceCounters.set(info.service, count);
            label += ` #${count}`;
        } else {
            // For the "null" task bucket, just show Service Name + "?"
            // Or just Service Name if it's the only one.
            label += ` (?)`; 
        }

        elements.push({
            data: { 
                id: key, 
                label: label,
                tooltip: info.taskArn || 'Task ARN not found'
            }
        });
    });

    // Create Edges
    edges.forEach((data, key) => {
        const [source, target] = key.split('->');
        const avgMs = data.count > 0 ? (data.totalDuration / data.count / 1000).toFixed(0) : 0;
        
        elements.push({
            data: { 
                source: source, 
                target: target, 
                label: `${data.count} calls\nAvg: ${avgMs}ms` 
            }
        });
    });

    if (cy) cy.destroy(); 

    cy = cytoscape({
        container: container,
        elements: elements,
        style: [
            {
                selector: 'node',
                style: {
                    'background-color': '#007acc',
                    'label': 'data(label)',
                    'color': '#fff',
                    'text-valign': 'center',
                    'text-halign': 'center',
                    'text-wrap': 'wrap',
                    'font-size': '12px',
                    'width': '140px',
                    'height': '60px',
                    'shape': 'round-rectangle',
                    'border-width': 1,
                    'border-color': '#fff'
                }
            },
            {
                selector: 'edge',
                style: {
                    'width': 2,
                    'line-color': '#999',
                    'target-arrow-color': '#999',
                    'target-arrow-shape': 'triangle',
                    'curve-style': 'bezier',
                    'label': 'data(label)', 
                    'font-size': '10px',
                    'color': '#333',
                    'text-rotation': 'autorotate',
                    'text-background-opacity': 1,
                    'text-background-color': '#fff',
                    'text-background-padding': '2px'
                }
            }
        ],
        layout: {
            name: 'dagre',
            rankDir: 'LR', 
            nodeSep: 50,
            rankSep: 100
        }
    });

    cy.on('tap', 'node', function(evt){
        const node = evt.target;
        alert(`Tasks for ${node.id().split('::')[0]}:\n\n${node.data('tooltip')}`);
    });
}


// --- Table Rendering & Filtering ---

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
        const rowNum = item.originalIndex + 1; 

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

    const indexedData = currentDataItems.map((item, index) => ({ ...item, originalIndex: index }));

    const filtered = indexedData.map(item => {
        if (sourceUrlFilter && !item.sourceUrl.toLowerCase().includes(sourceUrlFilter)) return null;
        const itemCache = (item.cacheControl || '').toLowerCase();
        if (cacheFilter && !itemCache.includes(cacheFilter)) return null;

        const visibleTraces = item.tracedUrls.filter(t => {
            const txt = t.url.toLowerCase();
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
