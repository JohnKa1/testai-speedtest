# Arquitetura do TestAi (`testai-speedtest`)

Guia vivo para consulta rápida de módulos, contratos DOM, invariantes de design/telemetria e comandos de verificação.

---

## 1. Estrutura de Diretórios

```text
TestAi/
├─ api/
│  └─ device-specs.js               # Endpoint serverless (/api/device-specs): MobileAPI.dev, rate limit e cache
├─ docs/
│  └─ ARCHITECTURE.md               # Este mapa arquitetural
├─ tsconfig.json                    # Verificação estática JSDoc (checkJs: true) sobre src/
├─ scripts/
│  └─ benchmark-profiles.mjs        # Simulador offline de perfis de medição (TestAi Lab)
├─ src/
│  ├─ config/
│  │  └─ speedtest.config.js        # Perfis TEST_PROFILES (light/standard/multigig/stability) e thresholds
│  ├─ diagnostics/
│  │  ├─ capability-advisor.js      # Cards de uso, estabilidade simples, tier Básico/Médio/Alto, bandas Wi-Fi
│  │  ├─ connection-diagnostics.js  # Motor multidimensional (bufferbloat, upload local, inconclusivo etc.)
│  │  └─ gaming-analyzer.js         # Análise gaming com pilares e tone dinâmico por gênero
│  ├─ lab/
│  │  └─ profiles.js                # Perfis candidatos isolados para lab.html
│  ├─ services/
│  │  ├─ device-specs.service.js    # Orquestração /api/device-specs -> Wikipedia -> Google Play Registry
│  │  └─ speedtest.service.js       # Motor multi-stream resiliente contra Cloudflare Edge (/__down e /__up)
│  ├─ storage/
│  │  └─ history.storage.js         # Persistência localStorage, comparação, JSON/CSV e laudo .TXT
│  ├─ styles/
│  │  ├─ main.css                   # Manifesto ordenado (@import)
│  │  ├─ tokens.css                 # Variáveis CSS :root (único local com hex/# e rgba)
│  │  ├─ base.css                   # Reset, layout shell, topbar, .card e proteção min-width: 0
│  │  ├─ controls.css               # Control bar, botões, foco, progress bar e banners
│  │  ├─ simple-mode.css            # Hero, gauge SVG, stats simples, grid e esqueleto 2x2 (.capabilities-grid.is-empty)
│  │  ├─ device-panel.css           # Busca de aparelhos, bandas Wi-Fi e comparativo de 3 camadas
│  │  ├─ advanced-mode.css          # Telemetria NOC, charts, abas, diagnóstico, tabela técnica e histórico
│  │  ├─ states-tooltips.css        # Skeletons (.is-empty) e tooltips [data-tip]
│  │  └─ responsive.css             # Breakpoints (720px, 1025px) e prefers-reduced-motion
│  ├─ ui/
│  │  ├─ telemetry-view.js          # Estado ao vivo, gauge, banners, skeletons e progress bar
│  │  ├─ simple-view.js             # Veredito simplificado, esqueleto 2x2 e grid "O que posso fazer?"
│  │  ├─ device-panel.js            # Chips populares, busca e renderização da ficha do aparelho
│  │  ├─ diagnostics-view.js        # Diagnóstico, Gaming e tabela de Telemetria Técnica
│  │  └─ history-view.js            # Tabela de histórico local e comparação lado a lado
│  ├─ components/
│  │  ├─ charts.js                  # 3 gráficos Canvas HD lendo tokens CSS (--series-down / --series-up / --ok)
│  │  └─ thermometer.js             # Componente legado (oculto via .thermometer-box)
│  ├─ utils/
│  │  ├─ formatters.js              # Estatísticas, computeMeanMbps, computePeakMbps, resolvePrimaryAndPeakSpeed
│  │  └─ validators.js              # METRIC_STATUS e sanitização numérica
│  ├─ types.js                      # Contratos @typedef JSDoc centrais (SpeedTestResult, DiagnosisResult etc.)
│  ├─ main.js                       # Orquestrador principal e initApp() idempotente
│  └─ lab.js                        # Controlador isolado da bancada lab.html
├─ tests/
│  ├─ helpers.js                    # Mocks de DOM/localStorage e fixtures
│  ├─ testai.test.js                # Smoke tests dos contratos de exportação pública dos módulos
│  ├─ diagnostics.test.js           # Regras de diagnóstico, upload local, gaming e cards práticos
│  ├─ device-specs.test.js          # Lookup online, normalização &nbsp;, categorias/bandas e API
│  ├─ speedtest-storage.test.js     # Perfis, mediana 0.5, média/pico, formatadores e histórico
│  └─ ui-integrity.test.js          # Contratos HTML, CSS modular, tokens e inicialização de main.js
├─ index.html                       # Aplicação principal (Modo Simples + Modo Avançado)
├─ lab.html                         # Bancada isolada TestAi Lab (dev)
└─ vite.config.js                   # Proxy /api/device-specs sob demanda (sem quebrar HMR)
```

---

## 2. Onde Alterar Cada Coisa

| Necessidade | Arquivo(s) principal(is) |
| --- | --- |
| Cores, espaçamentos e fontes | [`src/styles/tokens.css`](../src/styles/tokens.css) |
| Hero, gauge SVG e "O que posso fazer?" | [`src/styles/simple-mode.css`](../src/styles/simple-mode.css), [`src/ui/simple-view.js`](../src/ui/simple-view.js) |
| Painel de smartphones e bandas Wi-Fi | [`src/styles/device-panel.css`](../src/styles/device-panel.css), [`src/ui/device-panel.js`](../src/ui/device-panel.js) |
| Classificação Básico/Médio/Alto e médias Wi-Fi | [`src/diagnostics/capability-advisor.js`](../src/diagnostics/capability-advisor.js) |
| Regras de diagnóstico e upload local | [`src/diagnostics/connection-diagnostics.js`](../src/diagnostics/connection-diagnostics.js) |
| Gráficos Canvas (cores, eixos, legendas) | [`src/components/charts.js`](../src/components/charts.js) |
| Perfis e blocos de medição Cloudflare | [`src/config/speedtest.config.js`](../src/config/speedtest.config.js) |
| Endpoint serverless `/api/device-specs` | [`api/device-specs.js`](../api/device-specs.js) |

---

## 3. Contratos Críticos de DOM (Não Quebrar)

- **Botões e seletores globais:** `#startBtnSimple`, `#startBtnAdv`, `#modeSimpleBtn`, `#modeAdvancedBtn`, `#profileSelect`, `#contextToggleBtn`, `#contextDrawer`, `#linkTypeSelect`, `#contractedInput`.
- **Modo Simples:** `#simpleSpeedStage` (`--pct` e `data-gauge-tone`), `#simpleCurrentSpeed`, `#simpleSpeedUnit`, `#simpleDownloadVal`, `#simpleDownloadAvg`, `#simpleUploadVal`, `#simpleUploadAvg`, `#simplePingVal`, `#simpleStabilityVal`, `#simpleStabilitySub`, `#simpleVerdictCard`, `#capabilitiesGrid`.
- **Modo Avançado:** `#currentSpeed`, `#advSpeedUnit`, `#avgSpeed` (`PICO OBSERVADO`), `#avgBreakdown`, `#uploadValue`, `#uploadPeakMeta`, `#pingValue`, `#jitterValue`, `#downloadLatencyValue`, `#uploadLatencyValue`, `#loadedJitterValue`, `#throughputChart`, `#latencyChart`, `#historyChart`, `#diagnosticCard`, `#gamingCard`, `#techMetricsBody`, `#historyTableBody`.
- **Dispositivos:** `#deviceSearchForm`, `#deviceQueryInput`, `#deviceSearchBtn`, `#deviceQuickChips`, `#deviceFeedback`, `#deviceResultPanel`.

---

## 4. Invariantes do Sistema

1. **Média principal / Pico secundário nos cards:** cards e destaques visuais exibem a **média real** (`resolvePrimaryAndPeakSpeed`) como principal e o **pico pontual** como secundário; perfis do motor mantêm `bandwidthPercentile: 0.5` (mediana sustentada, sem P90/NAT Boost no laudo técnico).
2. **Tokens CSS e Contraste WCAG 2.2 AA:**
   - Hexadecimais e `rgba()` residem **exclusivamente** em `src/styles/tokens.css`.
   - `--brand` (`#00E5FF`) só aparece no logo (`.topbar h1 span`), botão primário (`.btn-primary`) e anel `:focus-visible`.
   - Apenas o arco do gauge (`.simple-gauge-arc`) possui glow.
   - Fontes nunca menores que `13px` (`0.8125rem`).
   - Violeta (`--series-up`) restrito a elementos gráficos/UI (`>= 3:1`), nunca em texto pequeno.
3. **Sem culpar provedor automaticamente no upload:** falhas parciais e upload baixo isolado informam primeiro possível limitação no envio deste dispositivo/rede local para a internet.
4. **Segurança:** toda renderização usa `textContent` / `createEl`; `MOBILEAPI_KEY` permanece estritamente no servidor (`api/device-specs.js`).

---

## 5. Comandos de Validação

```bash
npm test                               # Executa todas as suítes em tests/*.test.js
npm run typecheck                      # Valida contratos e tipos JSDoc via tsc (checkJs: true)
npm run build                          # Build de produção Vite (resolução de CSS e bundle ES)
node scripts/benchmark-profiles.mjs    # Benchmark determinístico offline dos perfis (TestAi Lab)
```
