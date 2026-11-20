# TestAi — Diagnóstico Inteligente de Conexão e Hardware

Aplicação web moderna de diagnóstico avançado de conexão de internet e análise prática da capacidade de hardware de smartphones e dispositivos conectados.

---

## 🎯 Principais Funcionalidades

- **Medição Precisa de Vazão**: Download, Upload, Ping ocioso (RTT) e Jitter estatístico.
- **Detecção de Bufferbloat (Latência sob Carga)**: Avaliação de variação de latência e jitter durante download e upload intensos.
- **Cards Práticos de Cenários de Uso**: Separação clara entre a experiência de **Streaming 4K**, **Downloads Pesados**, **Jogos Online / Videochamadas** e **Casa Conectada**.
- **Inteligência de Dispositivos**:
  - Consulta online de especificações técnicas (MobileAPI.dev, Wikipedia e Google Play Certified Devices Registry).
  - Classificação automática da categoria do aparelho: **Básico (Entrada)**, **Médio (Intermediário)** ou **Alto Desempenho (Topo de Linha)**.
  - Estimativa determinística de **média real esperada em Mbps por banda**: Wi-Fi 2,4 GHz, Wi-Fi 5 GHz e Wi-Fi 6 GHz (indicando explicitamente incompatibilidade quando o aparelho não suporta a frequência).
- **Modos de Visualização**:
  - **Modo Simples**: Visão direta e amigável para usuário final e cliente.
  - **Modo Avançado (NOC / Engenharia)**: Telemetria detalhada, distribuição de percentis (Mín / P50 / P90 / Máx), gráficos de vazão e laudo técnico para exportação.
- **Histórico e Exportação**: Armazenamento local no navegador com exportação em `.json`, `.csv` e cópia de laudo técnico em `.txt`.

---

## 🛠️ Tecnologias Utilizadas

- **Runtime & Build**: [Vite](https://vitejs.dev/) v7
- **Linguagem**: JavaScript Vanilla (ES Modules), HTML5 semântico e CSS3 (Design System responsivo em dark mode técnico)
- **Engine de Teste de Velocidade**: `@cloudflare/speedtest`
- **Testes Unitários**: Node.js Native Test Runner (`node --test`)
- **Backend Serverless**: Handler Node.js em `api/device-specs.js` (compatível com Vercel, Netlify e middleware Vite)

---

## 🚀 Como Executar o Projeto Localmente

### 1. Clonar o repositório e instalar dependências
```bash
npm install
```

### 2. Configurar variáveis de ambiente (opcional)
Copie o arquivo de exemplo:
```bash
cp .env.example .env
```
> Caso não configure uma chave em `MOBILEAPI_KEY`, o TestAi utilizará automaticamente as camadas de consulta pública online (Wikipedia e Google Play Registry) com fallback inteligente.

### 3. Rodar em modo de desenvolvimento
```bash
npm run dev
```

### 4. Executar os testes unitários
```bash
npm test
```

### 5. Gerar build de produção
```bash
npm run build
npm run preview
```

---

## 📄 Licença
Distribuído sob a licença MIT.
