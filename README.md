# TestAi — Diagnóstico Inteligente de Conexão e Hardware

Aplicação web de diagnóstico de rede e análise comparativa de capacidade Wi-Fi/hardware de dispositivos. Projetada para entregar medições contínuas e resilientes para o usuário final (**Modo Simples**) e telemetria detalhada para análise técnica (**Modo Avançado / NOC**).

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

#### Detecção de Aba em Segundo Plano (`visibilitychange`)
- Como navegadores reduzem a frequência de timers quando uma aba é minimizada ou trocada, o TestAi monitora `document.visibilityState` durante testes ativos e alerta no banner caso a aba tenha ficado em segundo plano.

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

### 1.5 Onde Consultamos as Especificações dos Celulares
O módulo de **Inteligência de Dispositivos** (`src/services/device-specs.service.js`) opera **100% no navegador (sem backend nem chaves de API)** consultando fontes online abertas em **2 camadas com fallback automático** e busca tolerante a digitações compactas/sem espaço (*Postel's law*, ex.: `a10`, `s25fe`, `iphone16`, `motog84`, `e22`, mantendo códigos homologados como `SM-A065M` intactos):

1. **Camada 1 — Wikipedia Online (MediaWiki API EN e PT):**
   - Consulta `https://en.wikipedia.org/w/api.php` e `https://pt.wikipedia.org/w/api.php`, realizando *parsing* e desembrulhamento recursivo de `Infobox` (`{{...}}`) e normalização de entidades HTML (`&nbsp;`, `&#160;`) para extrair SoC/chipset, RAM, geração/padrões Wi-Fi (`/6`, `/6e`, `/7`) e suporte 4G/5G.
2. **Camada 2 — Google Play Certified Devices Registry (via jsDelivr CDN):**
   - Consulta `https://cdn.jsdelivr.net/gh/bsthen/device-models/devices.json` para mapear mais de 30.000 modelos regionais, códigos homologados de fabricante e aparelhos de entrada/legados.

A partir dos dados obtidos, `src/diagnostics/capability-advisor.js` classifica deterministicamente o smartphone (**Básico**, **Médio** ou **Alto Desempenho**), estima a **média real em Mbps por banda Wi-Fi (`2,4 GHz`, `5 GHz` e `6 GHz`)** e separa explicitamente:
1. Especificação Teórica Documentada
2. Estimativa em Condições Favoráveis
3. Velocidade Medida Neste Navegador

---

### 1.6 Privacidade, Armazenamento Local e Segurança
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
