async function initSimulationAnalysisApp() {
    const charts = {};
    const chartDefaults = {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { labels: { color: '#d1d5db' } } },
        scales: {
            x: { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.06)' } },
            y: { ticks: { color: '#9ca3af' }, grid: { color: 'rgba(255,255,255,0.06)' } }
        }
    };

    function destroyChart(id) {
        if (charts[id]) { charts[id].destroy(); delete charts[id]; }
    }

    function fmtPct(v) { return (typeof v === 'number' ? v : 0).toFixed(1) + '%'; }
    function fmtNum(v, d = 2) { return (typeof v === 'number' ? v : 0).toFixed(d); }

    function renderFromSummary(summary, telemetryRows) {
        document.getElementById('emptyState').classList.add('d-none');
        document.getElementById('analysisPanel').classList.remove('d-none');

        document.getElementById('metricAvgGoals').textContent = fmtNum(summary.avgGoalsPerMatch);
        document.getElementById('metricPossA').textContent = fmtPct(summary.possession?.teamASharePercent);
        document.getElementById('metricTackleRate').textContent = fmtPct((summary.tactical?.tackleSuccessRate || 0) * 100);
        document.getElementById('metricMatches').textContent = String(summary.completedMatches || telemetryRows?.length || 0);
        document.getElementById('rawSummary').textContent = JSON.stringify(summary, null, 2);

        const rows = telemetryRows || [];
        const goalLabels = rows.map((r) => `#${r.iteration || '?'}`);
        const goalData = rows.map((r) => r.totalGoals ?? 0);
        const possTrend = rows.map((r) => r.possessionShare?.teamA ?? 0);

        destroyChart('goalsChart');
        charts.goalsChart = new Chart(document.getElementById('goalsChart'), {
            type: 'bar',
            data: {
                labels: goalLabels.length ? goalLabels : ['Avg'],
                datasets: [{
                    label: 'Goals',
                    data: goalLabels.length ? goalData : [summary.avgGoalsPerMatch],
                    backgroundColor: 'rgba(0, 242, 254, 0.55)',
                    borderColor: '#00f2fe',
                    borderWidth: 1
                }]
            },
            options: chartDefaults
        });

        destroyChart('possessionChart');
        charts.possessionChart = new Chart(document.getElementById('possessionChart'), {
            type: 'doughnut',
            data: {
                labels: ['Team A', 'Team B', 'Loose Ball'],
                datasets: [{
                    data: [
                        summary.possession?.teamASharePercent || 0,
                        summary.possession?.teamBSharePercent || 0,
                        summary.possession?.looseSharePercent || 0
                    ],
                    backgroundColor: ['#00f2fe', '#ff0077', '#6b7280']
                }]
            },
            options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { labels: { color: '#d1d5db' } } } }
        });

        destroyChart('tacticalChart');
        charts.tacticalChart = new Chart(document.getElementById('tacticalChart'), {
            type: 'bar',
            data: {
                labels: ['Passes', 'Shots', 'Tackles', 'Tackle OK', 'Corners', 'Goal Kicks', 'Fouls', 'Free Kicks', 'Yellows', 'Reds', 'Shifts A', 'Shifts B'],
                datasets: [{
                    label: 'Per Match (avg)',
                    data: [
                        summary.tactical?.passAttemptsPerMatch || 0,
                        summary.tactical?.shootAttemptsPerMatch || 0,
                        summary.tactical?.tackleAttemptsPerMatch || 0,
                        summary.tactical?.tackleSuccessesPerMatch || 0,
                        summary.tactical?.cornerKicksPerMatch || 0,
                        summary.tactical?.goalKicksPerMatch || 0,
                        summary.tactical?.foulsPerMatch || 0,
                        summary.tactical?.freeKicksPerMatch || 0,
                        summary.tactical?.yellowCardsPerMatch || 0,
                        summary.tactical?.redCardsPerMatch || 0,
                        summary.tactical?.strategyShiftsAPerMatch || 0,
                        summary.tactical?.strategyShiftsBPerMatch || 0
                    ],
                    backgroundColor: [
                        '#38bdf8', '#f472b6', '#fbbf24', '#34d399', '#a78bfa',
                        '#60a5fa', '#f87171', '#fb923c', '#eab308', '#ef4444',
                        '#00f2fe', '#ffc107'
                    ]
                }]
            },
            options: chartDefaults
        });

        destroyChart('possessionTrendChart');
        charts.possessionTrendChart = new Chart(document.getElementById('possessionTrendChart'), {
            type: 'line',
            data: {
                labels: goalLabels.length ? goalLabels : ['1'],
                datasets: [{
                    label: 'Team A %',
                    data: possTrend.length ? possTrend : [summary.possession?.teamASharePercent || 0],
                    borderColor: '#00f2fe',
                    backgroundColor: 'rgba(0, 242, 254, 0.15)',
                    fill: true,
                    tension: 0.25
                }]
            },
            options: chartDefaults
        });

        destroyChart('balanceChart');
        charts.balanceChart = new Chart(document.getElementById('balanceChart'), {
            type: 'bar',
            data: {
                labels: ['Expected Goals (xG)', 'Progressive Passes', 'Press Successes', 'Transition Goals'],
                datasets: [
                    {
                        label: 'Team A',
                        data: [
                            summary.tactical?.xgAPerMatch || 0,
                            summary.tactical?.progressivePassesAPerMatch || 0,
                            summary.tactical?.pressSuccessesAPerMatch || 0,
                            summary.tactical?.transitionGoalsAPerMatch || 0
                        ],
                        backgroundColor: 'rgba(0, 242, 254, 0.75)',
                        borderColor: '#00f2fe',
                        borderWidth: 1
                    },
                    {
                        label: 'Team B',
                        data: [
                            summary.tactical?.xgBPerMatch || 0,
                            summary.tactical?.progressivePassesBPerMatch || 0,
                            summary.tactical?.pressSuccessesBPerMatch || 0,
                            summary.tactical?.transitionGoalsBPerMatch || 0
                        ],
                        backgroundColor: 'rgba(255, 0, 119, 0.75)',
                        borderColor: '#ff0077',
                        borderWidth: 1
                    }
                ]
            },
            options: chartDefaults
        });
    }

    function summarizeTelemetry(rows) {
        const n = rows.length;
        if (!n) return null;
        const totals = {
            goals: 0, possA: 0, possB: 0, loose: 0,
            pass: 0, shoot: 0, tack: 0, tackOk: 0,
            corners: 0, goalkicks: 0, fouls: 0, freekicks: 0, yellowcards: 0, redcards: 0,
            shiftsA: 0, shiftsB: 0,
            xgA: 0, xgB: 0, progressivePassesA: 0, progressivePassesB: 0,
            pressSuccessesA: 0, pressSuccessesB: 0, transitionGoalsA: 0, transitionGoalsB: 0,
            substitutionsA: 0, substitutionsB: 0
        };
        for (const r of rows) {
            totals.goals += r.totalGoals || 0;
            totals.possA += r.possessionShare?.teamA || 0;
            totals.possB += r.possessionShare?.teamB || 0;
            totals.loose += r.possessionShare?.loose || 0;
            totals.pass += r.tactical?.passAttempts || 0;
            totals.shoot += r.tactical?.shootAttempts || 0;
            totals.tack += r.tactical?.tackleAttempts || 0;
            totals.tackOk += r.tactical?.tackleSuccesses || 0;
            totals.corners += r.tactical?.cornerKicks || 0;
            totals.goalkicks += r.tactical?.goalKicks || 0;
            totals.fouls += r.tactical?.fouls || 0;
            totals.freekicks += r.tactical?.freeKicks || 0;
            totals.yellowcards += r.tactical?.yellowCards || 0;
            totals.redcards += r.tactical?.redCards || 0;
            totals.shiftsA += r.tactical?.strategyShiftsA || 0;
            totals.shiftsB += r.tactical?.strategyShiftsB || 0;
            totals.xgA += r.tactical?.xgA || 0;
            totals.xgB += r.tactical?.xgB || 0;
            totals.progressivePassesA += r.tactical?.progressivePassesA || 0;
            totals.progressivePassesB += r.tactical?.progressivePassesB || 0;
            totals.pressSuccessesA += r.tactical?.pressSuccessesA || 0;
            totals.pressSuccessesB += r.tactical?.pressSuccessesB || 0;
            totals.transitionGoalsA += r.tactical?.transitionGoalsA || 0;
            totals.transitionGoalsB += r.tactical?.transitionGoalsB || 0;
            totals.substitutionsA += r.tactical?.substitutionsA || 0;
            totals.substitutionsB += r.tactical?.substitutionsB || 0;
        }
        return {
            completedMatches: n,
            avgGoalsPerMatch: totals.goals / n,
            possession: {
                teamASharePercent: totals.possA / n,
                teamBSharePercent: totals.possB / n,
                looseSharePercent: totals.loose / n
            },
            tactical: {
                passAttemptsPerMatch: totals.pass / n,
                shootAttemptsPerMatch: totals.shoot / n,
                tackleAttemptsPerMatch: totals.tack / n,
                tackleSuccessesPerMatch: totals.tackOk / n,
                tackleSuccessRate: totals.tack > 0 ? totals.tackOk / totals.tack : 0,
                cornerKicksPerMatch: totals.corners / n,
                goalKicksPerMatch: totals.goalkicks / n,
                foulsPerMatch: totals.fouls / n,
                freeKicksPerMatch: totals.freekicks / n,
                yellowCardsPerMatch: totals.yellowcards / n,
                redCardsPerMatch: totals.redcards / n,
                strategyShiftsAPerMatch: totals.shiftsA / n,
                strategyShiftsBPerMatch: totals.shiftsB / n,
                xgAPerMatch: totals.xgA / n,
                xgBPerMatch: totals.xgB / n,
                progressivePassesAPerMatch: totals.progressivePassesA / n,
                progressivePassesBPerMatch: totals.progressivePassesB / n,
                pressSuccessesAPerMatch: totals.pressSuccessesA / n,
                pressSuccessesBPerMatch: totals.pressSuccessesB / n,
                transitionGoalsAPerMatch: totals.transitionGoalsA / n,
                transitionGoalsBPerMatch: totals.transitionGoalsB / n,
                substitutionsAPerMatch: totals.substitutionsA / n,
                substitutionsBPerMatch: totals.substitutionsB / n
            }
        };
    }

    function readJsonBlob(file, handler) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            try {
                handler(JSON.parse(reader.result), file);
            } catch (e) {
                alert('Invalid JSON: ' + e.message);
            }
        };
        reader.readAsText(file);
    }

    function setDropZoneLoaded(zone, fileName) {
        if (!zone) return;
        zone.classList.add('is-loaded');
        zone.classList.remove('is-dragover');
        const nameEl = zone.querySelector('.drop-zone__file');
        if (nameEl) nameEl.textContent = fileName || '';
    }

    function handleSummaryData(data, file) {
        if (file) setDropZoneLoaded(document.getElementById('summaryDropZone'), file.name);
        renderFromSummary(data, null);
    }

    function handleTelemetryData(rows, file) {
        if (!Array.isArray(rows)) {
            alert('telemetry.json must be an array');
            return;
        }
        if (file) setDropZoneLoaded(document.getElementById('telemetryDropZone'), file.name);
        const summary = summarizeTelemetry(rows);
        renderFromSummary(summary, rows);
    }

    function bindDropZone(zoneId, inputId, onFile) {
        const zone = document.getElementById(zoneId);
        const input = document.getElementById(inputId);
        if (!zone || !input) return;

        input.addEventListener('change', () => {
            const file = input.files?.[0];
            if (file) onFile(file);
        });

        // Prevent browser from opening the dropped file as a navigation
        const prevent = (e) => {
            e.preventDefault();
            e.stopPropagation();
        };

        ['dragenter', 'dragover'].forEach((ev) => {
            zone.addEventListener(ev, (e) => {
                prevent(e);
                zone.classList.add('is-dragover');
            });
        });

        ['dragleave', 'dragend'].forEach((ev) => {
            zone.addEventListener(ev, (e) => {
                prevent(e);
                // Only clear when leaving the zone itself (not child nodes)
                if (ev === 'dragleave' && e.relatedTarget && zone.contains(e.relatedTarget)) return;
                zone.classList.remove('is-dragover');
            });
        });

        zone.addEventListener('drop', (e) => {
            prevent(e);
            zone.classList.remove('is-dragover');
            const file = e.dataTransfer?.files?.[0];
            if (!file) return;
            // Reflect selection in the hidden input when possible
            try {
                const dt = new DataTransfer();
                dt.items.add(file);
                input.files = dt.files;
            } catch (_) { /* older browsers: still process the File from the drop */ }
            onFile(file);
        });
    }

    bindDropZone('summaryDropZone', 'summaryFile', (file) => {
        readJsonBlob(file, (data, f) => handleSummaryData(data, f));
    });

    bindDropZone('telemetryDropZone', 'telemetryFile', (file) => {
        readJsonBlob(file, (data, f) => handleTelemetryData(data, f));
    });
}

module.exports = { initSimulationAnalysisApp };
