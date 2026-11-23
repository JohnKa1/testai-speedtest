/**
 * Suíte de contratos de módulos públicos do TestAi.
 * Garante que todas as exportações refatoradas (core, serviços, storage e src/ui/*)
 * permanecem íntegras após divisões arquiteturais.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import './helpers.js';
import * as speedtestConfig from '../src/config/speedtest.config.js';
import * as connectionDiagnostics from '../src/diagnostics/connection-diagnostics.js';
import * as capabilityAdvisor from '../src/diagnostics/capability-advisor.js';
import * as gamingAnalyzer from '../src/diagnostics/gaming-analyzer.js';
import * as deviceService from '../src/services/device-specs.service.js';
import * as speedtestService from '../src/services/speedtest.service.js';
import * as historyStorage from '../src/storage/history.storage.js';
import * as formatters from '../src/utils/formatters.js';
import * as validators from '../src/utils/validators.js';
import * as charts from '../src/components/charts.js';
import * as telemetryView from '../src/ui/telemetry-view.js';
import * as simpleView from '../src/ui/simple-view.js';
import * as devicePanel from '../src/ui/device-panel.js';
import * as diagnosticsView from '../src/ui/diagnostics-view.js';
import * as historyView from '../src/ui/history-view.js';

describe('TestAi — Contratos de Módulos Públicos', () => {
  it('expõe todas as funções públicas esperadas nos módulos core e src/ui/*', () => {
    assert.ok(speedtestConfig.TEST_PROFILES.standard);
    assert.equal(typeof connectionDiagnostics.evaluateConnection, 'function');
    assert.equal(typeof capabilityAdvisor.evaluatePracticalCapabilities, 'function');
    assert.equal(typeof capabilityAdvisor.evaluateSimpleStability, 'function');
    assert.equal(typeof capabilityAdvisor.normalizeSpecText, 'function');
    assert.equal(typeof gamingAnalyzer.evaluateGamingReadiness, 'function');
    assert.equal(typeof deviceService.DeviceSpecsService, 'function');
    assert.equal(typeof speedtestService.SpeedTestService, 'function');
    assert.equal(typeof historyStorage.toHistoryRecord, 'function');
    assert.equal(typeof historyStorage.buildTechnicalReportTxt, 'function');
    assert.equal(typeof formatters.resolvePrimaryAndPeakSpeed, 'function');
    assert.equal(typeof formatters.formatMetricWithUnit, 'function');
    assert.equal(typeof validators.resolveMetric, 'function');
    assert.equal(typeof charts.renderThroughputChart, 'function');
    assert.equal(typeof charts.renderLatencyComparisonChart, 'function');
    assert.equal(typeof charts.renderHistoryChart, 'function');
    assert.equal(typeof telemetryView.resetTelemetryUI, 'function');
    assert.equal(typeof telemetryView.updateSimpleGauge, 'function');
    assert.equal(typeof simpleView.renderSimpleVerdict, 'function');
    assert.equal(typeof simpleView.renderCapabilitiesSkeleton, 'function');
    assert.equal(typeof simpleView.renderCapabilitiesGrid, 'function');
    assert.equal(typeof devicePanel.createDevicePanelController, 'function');
    assert.equal(typeof devicePanel.renderDeviceComparisonPanel, 'function');
    assert.equal(typeof devicePanel.showDeviceFeedback, 'function');
    assert.equal(typeof devicePanel.hideDeviceFeedback, 'function');
    assert.equal(typeof devicePanel.getBrandDisplayLabel, 'function');
    assert.equal(typeof devicePanel.getBrandPlaceholderExample, 'function');
    assert.equal(typeof devicePanel.getBrandSearchName, 'function');
    assert.equal(typeof diagnosticsView.renderDiagnosticsAndGaming, 'function');
    assert.equal(typeof diagnosticsView.renderTechnicalPanel, 'function');
    assert.equal(typeof diagnosticsView.resetDiagnosticsAndTechnicalUI, 'function');
    assert.equal(typeof historyView.renderHistoryPanel, 'function');
  });
});
