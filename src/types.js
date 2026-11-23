/**
 * Definições centrais de tipos JSDoc do TestAi para verificação estática (`checkJs: true`).
 * Não contém código executável em runtime.
 */

/** @typedef {'pending' | 'measured' | 'unavailable' | 'failed'} MetricStatus */

/** @typedef {'good' | 'warning' | 'danger' | 'info' | 'neutral'} SemanticTone */

/**
 * @typedef {Object} MetricEntry
 * @property {number | null} value
 * @property {MetricStatus} status
 * @property {string} unit
 */

/**
 * @typedef {Object} BandwidthSample
 * @property {number} index
 * @property {number} bps
 * @property {number} mbps
 * @property {number | null} bytes
 * @property {number | null} duration
 * @property {number | null} measTime
 */

/**
 * @typedef {Object} LatencySample
 * @property {number} index
 * @property {number} ms
 */

/**
 * @typedef {Object} DescriptiveStats
 * @property {number} count
 * @property {number} min
 * @property {number} p10
 * @property {number} p50
 * @property {number} mean
 * @property {number} p90
 * @property {number} p95
 * @property {number} max
 * @property {number} stdDev
 * @property {number} cv
 */

/**
 * @typedef {Object} SpeedTestMetrics
 * @property {MetricEntry} download
 * @property {MetricEntry} upload
 * @property {MetricEntry} ping
 * @property {MetricEntry} jitter
 * @property {MetricEntry} downloadLatency
 * @property {MetricEntry} uploadLatency
 * @property {MetricEntry} downloadJitter
 * @property {MetricEntry} uploadJitter
 * @property {MetricEntry} downloadLatencyDelta
 * @property {MetricEntry} uploadLatencyDelta
 */

/**
 * @typedef {Object} SpeedTestResult
 * @property {string} id
 * @property {string} timestamp
 * @property {boolean} incomplete
 * @property {number} durationMs
 * @property {{ id: string, label: string }} profile
 * @property {'sustained' | 'commercial'} [measurementMode]
 * @property {{ download: number, upload: number }} [parallelStreams]
 * @property {{ linkType: string, contractedMbps: number | null, notes: string }} context
 * @property {SpeedTestMetrics} metrics
 * @property {{
 *   download: DescriptiveStats | null,
 *   upload: DescriptiveStats | null,
 *   unloadedLatency: DescriptiveStats | null,
 *   downloadLatency: DescriptiveStats | null,
 *   uploadLatency: DescriptiveStats | null
 * }} stats
 * @property {{ totalDownloadBytes: number, totalUploadBytes: number, totalBytes: number }} transfer
 * @property {{
 *   downloadPoints: BandwidthSample[],
 *   uploadPoints: BandwidthSample[],
 *   unloadedLatencyPoints: LatencySample[],
 *   downloadLatencyPoints: LatencySample[],
 *   uploadLatencyPoints: LatencySample[]
 * }} series
 * @property {Record<string, any> | null} rawSummary
 */

/**
 * @typedef {Object} SecondaryFinding
 * @property {string} [code]
 * @property {'good' | 'warning' | 'danger'} severity
 * @property {string} title
 * @property {string} summary
 */

/**
 * @typedef {Object} DiagnosisResult
 * @property {string} code
 * @property {'good' | 'warning' | 'danger'} severity
 * @property {string} title
 * @property {string} summary
 * @property {string} observed
 * @property {string[]} basisMetrics
 * @property {string} meaning
 * @property {string[]} probableCauses
 * @property {string[]} userActions
 * @property {string} confirmatoryTest
 * @property {SecondaryFinding[]} secondaryFindings
 */

/**
 * @typedef {Object} GamingPillar
 * @property {string} label
 * @property {string} value
 * @property {string} status
 * @property {string} detail
 */

/**
 * @typedef {Object} GamingGenreFit
 * @property {string} category
 * @property {string} fit
 * @property {SemanticTone} tone
 * @property {string} note
 */

/**
 * @typedef {Object} GamingResult
 * @property {string} verdictCode
 * @property {'good' | 'warning' | 'danger'} severity
 * @property {string} badge
 * @property {string} title
 * @property {string} summary
 * @property {GamingPillar[]} pillars
 * @property {GamingGenreFit[]} genres
 */

/**
 * @typedef {Object} CapabilityCard
 * @property {string} id
 * @property {string} title
 * @property {string} status
 * @property {SemanticTone} tone
 * @property {string} description
 */

/**
 * @typedef {Object} WifiBandEstimate
 * @property {string} label
 * @property {boolean} supported
 * @property {string} status
 * @property {string} speedRange
 * @property {string | null} typicalSpeed
 * @property {string} note
 */

/**
 * @typedef {Object} DeviceSpec
 * @property {string} [id]
 * @property {string} manufacturer
 * @property {string} model
 * @property {string} [regionalVariant]
 * @property {string} [source]
 * @property {string} [dataVersion]
 * @property {{ chipset?: string | null, ram?: string | null }} [hardware]
 * @property {{
 *   generation?: string | null,
 *   standards?: string | null,
 *   bands?: string[],
 *   supports6Ghz?: boolean,
 *   theoreticalLinkMbps?: number | null,
 *   favorableRangeMbps?: string | null,
 *   mimo?: string | null,
 *   channelWidthsMhz?: number[]
 * }} [wifi]
 * @property {{
 *   has4G?: boolean,
 *   has5G?: boolean,
 *   bands4G?: string[],
 *   bands5G?: string[]
 * }} [cellular]
 */

/**
 * @typedef {Object} HistoryRecord
 * @property {string} id
 * @property {string} timestamp
 * @property {boolean} incomplete
 * @property {number} durationMs
 * @property {string} profileLabel
 * @property {{ linkType?: string, contractedMbps?: number | null, notes?: string }} context
 * @property {number | null} downloadMbps
 * @property {number | null} uploadMbps
 * @property {number | null} pingMs
 * @property {number | null} jitterMs
 * @property {number | null} downloadLatencyMs
 * @property {number | null} uploadLatencyMs
 * @property {number | null} downloadLatencyDeltaMs
 * @property {number | null} uploadLatencyDeltaMs
 * @property {number | null} downloadJitterMs
 * @property {number | null} uploadJitterMs
 * @property {number | null} totalBytes
 * @property {string} diagnosisCode
 * @property {string} diagnosisTitle
 * @property {string} diagnosisSummary
 * @property {string} gamingBadge
 */

export {};
