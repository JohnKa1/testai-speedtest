# TestAi — Diagnóstico Inteligente de Conexão e Hardware

> **Produção (Live Demo):** [https://testai-speedtest.vercel.app](https://testai-speedtest.vercel.app)

![Licença MIT](https://img.shields.io/badge/licen%C3%A7a-MIT-10B981)
![Stack](https://img.shields.io/badge/stack-Vanilla%20JS%20%2B%20Vite%207-60A5FA)
![Dependências de Runtime](https://img.shields.io/badge/runtime%20deps-0-10B981)
![Testes Automatizados](https://img.shields.io/badge/testes-42%20passando%20(node%3Atest)-60A5FA)

Aplicação web de diagnóstico de rede e análise comparativa de capacidade Wi-Fi/hardware de dispositivos. Projetada para entregar medições contínuas e resilientes para o usuário final (**Modo Simples**) e telemetria detalhada para análise técnica (**Modo Avançado / NOC**).

---

## Interface (Modo Simples e Modo Avançado)

### Modo Simples — Diagnóstico Direto, Leitura de Velocidade e Consulta de Dispositivo
![Modo Simples — Diagnóstico direto, leitura de velocidade, cards práticos e consulta progressiva de dispositivo](docs/screenshots/modo-simples.png)

### Modo Avançado / NOC (Parte 1) — Telemetria em Tempo Real e Latência sob Carga
![Modo Avançado / NOC (Parte 1) — Telemetria detalhada de vazão, ping, jitter e latência sob carga (bufferbloat)](docs/screenshots/modo-avancado-1.png)

### Modo Avançado / NOC (Parte 2) — Diagnóstico Técnico, Histórico e Comparativo de Hardware
![Modo Avançado / NOC (Parte 2) — Diagnóstico multidimensional, distribuição estatística, histórico local e consulta de dispositivo](docs/screenshots/modo-avancado-2.png)

---

## 1. Como o Sistema Funciona

### 1.1 Servidores Utilizados na Medição
- **Infraestrutura de rede:** [Cloudflare Edge Anycast](https://speed.cloudflare.com) via HTTP/TLS (nó PoP mais próximo da conexão do usuário):
  - **Ping e Download:** `GET https://speed.cloudflare.com/__down`
  - **Upload:** `POST https://speed.cloudflare.com/__up`
- **Telemetria de borda:** cada resposta expõe cabeçalhos `Server-Timing` (`cfSpeedEdge`, `cfSpeedWorker`, `cfReqDur` e métricas TCP `cfL4` com `rtt` em microssegundos) e tempos do navegador via `PerformanceResourceTiming` (`responseStart - requestStart`).

---

### 1.2 Como Cada Métrica é Medida e Calculada

#### Ping Ocioso (RTT Base)
1. Antes das amostras oficiais, o motor envia **1 sonda de aquecimento** (`bytes=0&during=warmup`, descartada) para estabelecer TLS/conexão sem contaminar o resultado.
2. Em seguida, executa de **8 a 16 sondagens sequenciais** (`bytes=0&during=idle`, conforme o perfil), com timeout individual de `1200 ms` e teto total de fase (`1600–2800 ms`).
3. Cada RTT passa pelo filtro `resolveNetworkRttMs` (`src/services/speedtest.service.js`), que subtrai o tempo de processamento do servidor e, caso haja pico artificial do Worker Cloudflare (`serverMs > 100 ms`) ou atraso de handshake inicial, utiliza o RTT TCP real informado em `cfL4`.
4. O valor consolidado exibido é a **mediana (`P50`)** das amostras válidas.

#### Jitter (Ocioso e Sob Carga)
- Calculado por `computeJitterMs` como a **média das diferenças absolutas entre amostras consecutivas de RTT** (em milissegundos), exigindo ao menos 2 amostras válidas:
  $$\text{Jitter} = \frac{1}{N - 1} \sum_{i=1}^{N-1} |\text{RTT}_i - \text{RTT}_{i-1}|$$
- Medido separadamente em repouso (**Jitter Ocioso**) e durante carga intensa de download/upload (**Jitter sob Carga**).

#### Download Multi-Stream Contínuo
- Abre **3 a 6 fluxos paralelos** lendo os blocos continuamente via `ReadableStream` (`getReader()`, com fallback para `arrayBuffer()`).
- **Janela deslizante de 1 segundo (`250 ms` por tick):** evita depender apenas do fechamento de arquivos gigantes; assim, a primeira amostra surge em ~`250 ms`.
- **Resiliência a *stalls* e limites HTTP:** se um fluxo individual ficar `2000 ms` sem receber bytes, apenas aquele fluxo é abortado e reiniciado em paralelo enquanto os demais mantêm o link saturado; respostas `HTTP 429` ou `403` reduzem automaticamente o tamanho do bloco (*downshift*) sem interromper o teste.
- **Descarte de *ramp-up* (Slow Start):** descarta os primeiros `1000 ms` da fase quando existem ao menos `4` amostras em regime permanente (`selectSteadyStatePoints`).
- **Apresentação:** a **Média sustentada** é a métrica principal (fonte única de verdade em cards, diagnóstico, comparativo de dispositivo, histórico e laudo `.TXT`), o **Pico observado** aparece como referência secundária e a tabela técnica mostra `Mín / P50 / Média`.

#### Upload Multi-Stream Contínuo
- Executa **3 a 4 fluxos paralelos** contra `/__up` com blocos adaptativos (`128 KB` a `5 MB`).
- Para não congestionar conexões lentas (`< 5 Mbps`), os fluxos extras (`workerId >= 2`) aguardam a primeira confirmação HTTP ou até `450 ms` antes de entrar em paralelo.
- No navegador, utiliza `XMLHttpRequest` monitorando `xhr.upload.onprogress` para detectar travamentos individuais (`2800 ms` sem progresso). Os Mbps reportados baseiam-se em **bytes confirmados com HTTP 200** (evitando picos ilusórios de buffer TCP do sistema operacional), recorrendo a bytes em voo apenas após `1200 ms` sem resposta caso o enlace seja muito lento (`< 3 Mbps`).

#### Latência sob Carga & Bufferbloat (`ΔRTT`)
- Durante as fases de download e upload, uma sonda paralela independente dispara requisições leves (`bytes=0&during=download` e `during=upload`, intervalo de `300–400 ms`) para medir quanto a fila do roteador/provedor retém pacotes interativos sob tráfego intenso.
- O delta sob carga é `ΔRTT = max(0, Latência sob Carga P50 - Ping Ocioso P50)`:
  - `<= 20 ms`: controlado / protegido.
  - `21–59 ms`: elevação moderada / possível congestionamento.
  - `>= 60 ms`: alerta de **possível bufferbloat** (retenção severa de fila).

#### Detecção de Aba em Segundo Plano (`visibilitychange`) e Pausa Visual na Medição
- Como navegadores reduzem a frequência de timers quando uma aba é minimizada ou trocada, o TestAi monitora `document.visibilityState` durante testes ativos e alerta no banner caso a aba tenha ficado em segundo plano.
- **Camada de fundo em rede e vidro fosco (`.bg-layer` + `.glass`):** a deriva visual de fundo (`bg-drift 90s`) opera apenas quando `prefers-reduced-motion: no-preference` está ativo e **pausa automaticamente** durante toda a medição (`body.is-measuring`) e quando a aba fica oculta (`body.is-page-hidden`), garantindo prioridade de CPU/GPU para a telemetria. O protocolo e as medições reais comparativas (`A/B/C`) estão documentados em [`docs/medicoes-fundo.md`](./docs/medicoes-fundo.md).

---

### 1.3 Perfis de Medição (`src/config/speedtest.config.js`)

| Perfil | Fluxos (↓ / ↑) | Duração por Fase | Pings Ociosos | Consumo Estimado | Indicação |
| :--- | :--- | :--- | :--- | :--- | :--- |
| `light` (Econômico / Móvel) | `3 ↓ / 3 ↑` | `4,5 s` | `8` | `~35–140 MB` | Redes móveis 4G/5G ou triagem rápida |
| `standard` (Padrão Adaptativo) | `4 ↓ / 4 ↑` | `6,5 s` | `10` | `~120–450 MB` | Links residenciais/corporativos de 100 Mbps a 1 Gbps |
| `multigig` (Alta Capacidade) | `6 ↓ / 4 ↑` | `8,0 s` | `10` | `~350–950 MB` | Saturação de planos Gigabit e Multi-Gigabit |
| `stability` (Bufferbloat) | `4 ↓ / 4 ↑` | `9,0 s` | `16` | `~220–620 MB` | Investigação prolongada de estabilidade e *bufferbloat* |

---

### 1.4 Diagnóstico Multidimensional, Gaming e Cards Práticos
- **Diagnóstico Multidimensional (`src/diagnostics/connection-diagnostics.js`):** avalia conjuntamente Download, Upload, Ping, Jitter, `ΔRTT` sob download/upload, coeficiente de variação (`cv`) e plano contratado opcional. Em falhas ou quedas isoladas de upload, aponta primeiro possíveis gargalos no caminho do aparelho ou rede local para a internet (Wi-Fi fraco, VPN, extensão, firewall) sem culpar o provedor automaticamente.
- **Avaliação Gaming (`src/diagnostics/gaming-analyzer.js`):** analisa 4 pilares (Resposta Base, Jitter, Resiliência sob Download e Resiliência sob Upload) e compatibilidade orientativa por gênero (`FPS / Battle Royale`, `MOBA / Esportes` e `MMORPG / Cooperativo`), deixando explícito que o RTT reflete o percurso até a borda Cloudflare, não servidores específicos de jogos.
- **Cards Práticos ("O que posso fazer com minha internet?"):** exibe um esqueleto 2×2 antes/durante o teste (zero salto de layout) e, ao concluir, apresenta os 4 cenários: **Streaming & Vídeo**, **Downloads & Arquivos**, **Jogos & Chamadas** e **Casa Conectada**.

---

### 1.5 Fluxo Progressivo "Consulte seu dispositivo" e Fontes de Especificações
A seção **Consulte seu dispositivo** (`src/ui/device-panel.js` + `src/services/device-specs.service.js`) opera **100% no navegador (sem backend nem chaves de API)** em um fluxo progressivo acessível:

1. **Etapa 1 — Seleção de marca (Grade 4×2 em desktop `>= 720px` e 2×4 em telas menores):**
   - Implementada com rádios nativos (`<input type="radio" class="brand-radio sr-only">`) associados a `<label class="brand-option">`, com estilo selecionado neutro (`--surface-2`, borda forte e ícone `✓` com `aria-hidden="true"`).
   - A tradução do rótulo de exibição para `"Outras marcas"` (`brand.id === 'outras'`) ocorre em ponto único da camada de UI (`getBrandDisplayLabel`), mantendo o serviço inalterado.
   - Navegação por setas do teclado altera a marca e anuncia via região `aria-live="polite"` (`#deviceBrandStatus`) sem roubar o foco; clique ou toque move o foco diretamente para o campo de modelo.
2. **Etapa 2 — Campo de modelo, sugestões instantâneas e saída para o Google:**
   - O passo 2 (`#deviceModelStep`) permanece oculto (`.hidden`) até que uma marca seja escolhida e recebe um placeholder com exemplo da marca que resolve offline (`getBrandPlaceholderExample`).
   - A cada tecla digitada, exibe sugestões instantâneas da marca (janela 2015–2026) que podem ser fechadas com `Escape` preservando a marca e o texto digitado, e atualiza o link externo `"Seu dispositivo não aparece? Pesquisar no Google"` (`#deviceGoogleLink`, montado pela função pura `buildGoogleSearchUrl` em `src/utils/google-search.js` usando `getBrandSearchName(brand.id)`).
   - Diferencia os estados de retorno: `not-found` (*"Não encontramos “{texto}” nas fontes consultadas."* + link do Google destacado), `error` de rede (*"Não foi possível consultar agora."* + link do Google destacado) e `empty` (sem link ativo).
3. **Fontes de especificações e tolerância de busca (*Postel's law*):**
   - Resolve entradas compactas/sem espaço (ex.: `a10`, `s25fe`, `iphone16`, `motog84`, `e22`, preservando códigos homologados como `SM-A065M`) primeiro no catálogo determinístico local e, quando ausente localmente, consulta duas camadas públicas abertas:
     - **Camada 1 — Wikipedia Online (MediaWiki API EN e PT):** `https://en.wikipedia.org/w/api.php` e `https://pt.wikipedia.org/w/api.php` (*parsing* de `Infobox` e normalização de entidades HTML).
     - **Camada 2 — Google Play Certified Devices Registry (via jsDelivr CDN):** `https://cdn.jsdelivr.net/gh/bsthen/device-models/devices.json` / `supported_devices.csv` (30.000+ modelos regionais e códigos homologados).
4. **Rotulagem honesta dos dados (`src/diagnostics/capability-advisor.js`):**
   - Classifica deterministicamente o aparelho (**Básico**, **Médio** ou **Alto Desempenho**), estima a **média real em Mbps por banda Wi-Fi (`2,4 GHz`, `5 GHz` e `6 GHz`)** e distingue explicitamente:
     1. **Especificação Teórica Documentada** (padrão Wi-Fi/rádio do aparelho)
     2. **Estimativa em Condições Favoráveis** (faixa prática determinística por banda/categoria)
     3. **Velocidade Medida Neste Navegador** (resultado real do teste executado)

---

### 1.6 Privacidade, Comportamento de Rede e Segurança
- **Transparência de rede na consulta de dispositivos:**
  - **Durante a digitação:** o filtro de sugestões coerentes e a montagem do link de busca ocorrem **100% localmente** no navegador (nenhuma requisição de rede é disparada a cada tecla).
  - **Ao submeter a consulta ("Consultar" ou clique em sugestão):** se o modelo já constar no catálogo determinístico local, a resolução é 100% offline; caso contrário, o navegador consulta as APIs públicas da Wikipedia (`pt.wikipedia.org`, `en.wikipedia.org`) e, se necessário, o catálogo no jsDelivr (`cdn.jsdelivr.net`).
  - **Link externo para o Google (`#deviceGoogleLink`):** é um elemento `<a target="_blank" rel="noopener noreferrer">` estático, sem uso da Clipboard API e sem caixas de permissão; nenhuma informação é enviada ao Google a menos que o usuário clique voluntariamente no link.
- **Histórico 100% local:** as medições ficam salvas apenas no `localStorage` do navegador (`chave testai_history_v2`, máximo de `100` registros), com comparação lado a lado e exportação em `.json`, `.csv` e laudo técnico `.txt`. Nenhum banco externo armazena resultados do usuário.
- **Aplicação 100% estática e segura:** toda inserção de texto no DOM usa `textContent` (prevenção contra XSS), não há segredos/chaves de API nem backend serverless, e o [vercel.json](./vercel.json) aplica cabeçalhos HTTP de endurecimento (`Content-Security-Policy`, `Strict-Transport-Security`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy` e `Permissions-Policy`).

---

## 2. Arquitetura Modular e Ferramentas

Veja o mapa completo de diretórios, contratos DOM críticos e invariantes em [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md):

- `src/config/`: perfis multi-stream (`TEST_PROFILES`) e limiares de diagnóstico/gaming.
- `src/services/`: motor de velocidade (`speedtest.service.js`) e lookup online em 2 camadas abertas (`device-specs.service.js`).
- `src/diagnostics/`: regras puras de diagnóstico de rede, gaming e capacidade de dispositivos.
- `src/ui/` e `src/main.js`: camada de interface desacoplada coordenada por `initApp()`.
- `src/styles/`: design system modular baseado em tokens CSS em `tokens.css` (dark mode técnico com contraste WCAG 2.2 AA).
- `src/types.js` e `tsconfig.json`: contratos JSDoc validados via TypeScript (`checkJs: true`).
- `lab.html`, `src/lab/` e `scripts/benchmark-profiles.mjs`: bancada isolada (*TestAi Lab*) para simular ou comparar perfis sequenciais com `@cloudflare/speedtest`.
- `tests/`: suítes unitárias e de integridade modular (`node --test tests/*.test.js`).

---

## 3. Como Executar Localmente

### Pré-requisitos
- Node.js 18+ e npm.

### 1. Instalar dependências
```bash
npm install
```

### 2. Iniciar servidor de desenvolvimento
```bash
npm run dev
```

### 3. Executar checagem de tipos, testes e build
```bash
npm run typecheck
npm test
npm run build
npm run preview
```

### 4. Simulador offline de perfis (TestAi Lab)
```bash
node scripts/benchmark-profiles.mjs
```

---

## Licença
Distribuído sob a licença MIT.
