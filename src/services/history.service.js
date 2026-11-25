/**
 * Serviço de fachada da visão resumida (últimos 10 testes) sobre o repositório
 * canônico unificado (`history.storage.js`, `schemaVersion: 2`), garantindo
 * migração transparente, limpeza sincronizada e exportação CSV/JSON com paridade total.
 */

import { DEFAULT_RUNTIME_CONFIG } from './runtime-config.js';
import {
  appendHistoryRecord,
  clearHistory as clearUnifiedHistory,
  exportHistoryCsv,
  LEGACY_HISTORY_V1_KEY,
  loadHistory,
  normalizeHistoryRecord,
  toHistoryRecord,
  UNIFIED_HISTORY_KEY
} from '../storage/history.storage.js';

export const HISTORY_STORAGE_KEY = UNIFIED_HISTORY_KEY;
export const LEGACY_HISTORY_STORAGE_KEY = LEGACY_HISTORY_V1_KEY;
export const MAX_HISTORY_ENTRIES = 10;

function roundNullable(value, decimals = 2) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/**
 * Carrega até 10 entradas mais recentes do armazenamento canônico unificado
 * (executando migração transparente caso haja dados legados `v1`).
 *
 * @param {Storage | null} [storageOverride]
 */
export function loadHistoryEntries(storageOverride) {
  if (storageOverride === null) return [];
  return loadHistory(storageOverride).slice(0, MAX_HISTORY_ENTRIES);
}

/**
 * Constrói um registro canônico `schemaVersion: 2` a partir do resultado do motor.
 *
 * @param {any} result
 * @param {any} [runtimeConfig]
 */
export function buildHistoryEntry(result, runtimeConfig = DEFAULT_RUNTIME_CONFIG) {
  return toHistoryRecord(result, null, null, runtimeConfig || DEFAULT_RUNTIME_CONFIG);
}

/**
 * Grava uma entrada no repositório canônico unificado preservando os até 100 itens
 * do modo avançado e retornando a janela dos 10 itens mais recentes para o Modo Simples.
 *
 * @param {any} entry
 * @param {Storage | null} [storageOverride]
 */
export function saveHistoryEntry(entry, storageOverride) {
  if (storageOverride === null) return [];
  const normalized = normalizeHistoryRecord(entry);
  if (!normalized) {
    return loadHistoryEntries(storageOverride);
  }
  const updated = appendHistoryRecord(normalized, storageOverride);
  return updated.slice(0, MAX_HISTORY_ENTRIES);
}

/**
 * Limpa integralmente o repositório unificado (sincronizando Modo Simples e Modo Avançado).
 *
 * @param {Storage | null} [storageOverride]
 * @returns {Array<never>}
 */
export function clearHistory(storageOverride) {
  if (storageOverride === null) return [];
  clearUnifiedHistory(storageOverride);
  return [];
}

/**
 * Calcula a diferença numérica entre o teste atual e o teste imediatamente anterior.
 *
 * @param {any} current
 * @param {any} previous
 * @returns {{
 *   downloadDeltaMbps: number | null,
 *   uploadDeltaMbps: number | null,
 *   pingDeltaMs: number | null,
 *   loadedDeltaMs: number | null
 * } | null}
 */
export function computeComparisonDelta(current, previous) {
  if (!current || !previous) {
    return null;
  }

  const diffField = (currVal, prevVal) => {
    if (
      typeof currVal !== 'number' ||
      !Number.isFinite(currVal) ||
      typeof prevVal !== 'number' ||
      !Number.isFinite(prevVal)
    ) {
      return null;
    }
    return roundNullable(currVal - prevVal, 2);
  };

  return {
    downloadDeltaMbps: diffField(current.downloadMbps, previous.downloadMbps),
    uploadDeltaMbps: diffField(current.uploadMbps, previous.uploadMbps),
    pingDeltaMs: diffField(current.pingMs, previous.pingMs),
    loadedDeltaMs: diffField(current.loadedDeltaMs, previous.loadedDeltaMs)
  };
}

/**
 * Exporta entradas em CSV RFC 4180 usando o esquema canônico unificado `schemaVersion: 2`.
 *
 * @param {any[]} entries
 * @returns {string}
 */
export function exportHistoryAsCsv(entries) {
  return exportHistoryCsv(entries);
}

/**
 * Exporta entradas em JSON identado normalizando para `schemaVersion: 2`.
 *
 * @param {any[]} entries
 * @returns {string}
 */
export function exportHistoryAsJson(entries) {
  const list = Array.isArray(entries)
    ? entries.map((item) => normalizeHistoryRecord(item) || item)
    : [];
  return JSON.stringify(list, null, 2);
}
