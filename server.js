const express = require('express');
const snmp = require('net-snmp');
const nodemailer = require('nodemailer');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 1. BANCO DE DADOS SQLITE (Persistência Histórica - Requisito 3.2)
const db = new sqlite3.Database('./telemetria.db');
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS amostras (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        epoch INTEGER NOT NULL,
        bps_in REAL NOT NULL,
        bps_out REAL NOT NULL,
        cpu_load INTEGER NOT NULL,
        router_ip TEXT,
        if_index INTEGER
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS logs_eventos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        tipo TEXT NOT NULL,
        mensagem TEXT NOT NULL
    )`);
});

function registrarEvento(tipo, mensagem) {
    const agora = new Date().toISOString();
    db.run(`INSERT INTO logs_eventos (timestamp, tipo, mensagem) VALUES (?, ?, ?)`, [agora, tipo, mensagem]);
}

// 2. CONFIGURAÇÃO PADRÃO EM MEMÓRIA (Requisito 5)
let config = {
    routerIp: '192.168.56.101', // IP do MikroTik CHR
    community: 'public',
    ifIndex: 1,                 // Índice da interface (1 = ether1 no MikroTik)
    intervalSec: 3,             // Intervalo de coleta em segundos
    thresholdInBps: 500000,     // Limite IN (500 kbps padrão)
    thresholdOutBps: 500000,    // Limite OUT (500 kbps padrão)
    thresholdCpu: 80,           // Limite CPU (80%)
    alertPopup: true,
    alertEmail: false,
    emailDestino: '',
    smtpHost: 'smtp.gmail.com',
    smtpPort: 587,
    smtpUser: '',
    smtpPass: '',
    modoSimulacao: false        // Permite testar sem a VM ligada se necessário
};

// 3. ESTADO DA COLETA E CONTROLE DE COOLDOWN DE ALERTAS (Requisitos 3.1, 4 e 6)
let timerColeta = null;
let coletando = false;
let ultimaLeitura = null;       // Guarda { inOctets, outOctets, timestampMs, ifIndex, routerIp }
let sessaoAtual = [];           // Amostras da sessão em tempo real (limpas no Resetar)
let alertasPendentesPopup = []; // Fila de pop-ups para o frontend exibir

// Estado de histerese/transição (Normal -> Excedido) e Cooldown de 60s para evitar spam de e-mails
let estadoAlerta = {
    inExcedido: false,
    outExcedido: false,
    cpuExcedido: false,
    ultimoEmailMs: { in: 0, out: 0, cpu: 0 }
};
const COOLDOWN_EMAIL_MS = 60000; // 60 segundos entre e-mails da mesma métrica

// 4. FUNÇÃO DE ENVIO DE E-MAIL (Requisito 4)
async function dispararEmailAlerta(alerta) {
    if (!config.alertEmail || !config.emailDestino) return;

    const agoraMs = Date.now();
    if (agoraMs - estadoAlerta.ultimoEmailMs[alerta.chave] < COOLDOWN_EMAIL_MS) {
        return; // Dentro da janela de espera (prevenção de e-mails repetitivos)
    }
    estadoAlerta.ultimoEmailMs[alerta.chave] = agoraMs;

    if (!config.smtpUser || !config.smtpPass) {
        const msgFalha = `Alerta de E-mail preparado para ${config.emailDestino} (${alerta.metrica}: ${alerta.valor}), mas credenciais SMTP não foram preenchidas.`;
        registrarEvento('AVISO_EMAIL', msgFalha);
        alertasPendentesPopup.push({
            metrica: 'Aviso de E-mail (SMTP)',
            valor: 'Simulado / Sem SMTP',
            limite: config.emailDestino,
            horario: alerta.horario,
            detalhe: msgFalha
        });
        return;
    }

    try {
        const transporter = nodemailer.createTransport({
            host: config.smtpHost,
            port: Number(config.smtpPort),
            secure: false,
            auth: { user: config.smtpUser, pass: config.smtpPass }
        });

        await transporter.sendMail({
            from: `"Monitor SNMP MikroTik" <${config.smtpUser}>`,
            to: config.emailDestino,
            subject: `[ALERTA SNMP] Limite Excedido: ${alerta.metrica}`,
            text: `Alerta de Monitoramento de Rede\n\n` +
                  `Métrica: ${alerta.metrica}\n` +
                  `Valor Observado: ${alerta.valor}\n` +
                  `Limite Configurado: ${alerta.limite}\n` +
                  `Horário: ${alerta.horario}\n` +
                  `Roteador: ${config.routerIp} (Interface Index: ${config.ifIndex})`
        });
        registrarEvento('EMAIL_ENVIADO', `E-mail enviado para ${config.emailDestino} referente a ${alerta.metrica}`);
    } catch (err) {
        const erroMsg = `Falha ao enviar e-mail para ${config.emailDestino}: ${err.message}`;
        registrarEvento('ERRO_EMAIL', erroMsg);
        alertasPendentesPopup.push({
            metrica: 'Falha no Envio de E-mail',
            valor: err.message,
            limite: config.emailDestino,
            horario: alerta.horario
        });
    }
}

// 5. AVALIAÇÃO DE THRESHOLDS COM TRANSIÇÃO DE ESTADO (Requisito 4)
function avaliarThresholds(bpsIn, bpsOut, cpu, horarioFormatado) {
    // 5.1 Avaliação Tráfego IN
    if (bpsIn > config.thresholdInBps) {
        if (!estadoAlerta.inExcedido) {
            estadoAlerta.inExcedido = true;
            const info = {
                chave: 'in',
                metrica: 'Tráfego de Entrada (IN)',
                valor: `${bpsIn.toFixed(2)} bps`,
                limite: `${config.thresholdInBps} bps`,
                horario: horarioFormatado
            };
            registrarEvento('ALERTA_THRESHOLD', `${info.metrica} atingiu ${info.valor} (Limite: ${info.limite})`);
            if (config.alertPopup) alertasPendentesPopup.push(info);
            if (config.alertEmail) dispararEmailAlerta(info);
        }
    } else {
        estadoAlerta.inExcedido = false; // Recuperou para o estado normal
    }

    // 5.2 Avaliação Tráfego OUT
    if (bpsOut > config.thresholdOutBps) {
        if (!estadoAlerta.outExcedido) {
            estadoAlerta.outExcedido = true;
            const info = {
                chave: 'out',
                metrica: 'Tráfego de Saída (OUT)',
                valor: `${bpsOut.toFixed(2)} bps`,
                limite: `${config.thresholdOutBps} bps`,
                horario: horarioFormatado
            };
            registrarEvento('ALERTA_THRESHOLD', `${info.metrica} atingiu ${info.valor} (Limite: ${info.limite})`);
            if (config.alertPopup) alertasPendentesPopup.push(info);
            if (config.alertEmail) dispararEmailAlerta(info);
        }
    } else {
        estadoAlerta.outExcedido = false;
    }

    // 5.3 Avaliação CPU
    if (cpu > config.thresholdCpu) {
        if (!estadoAlerta.cpuExcedido) {
            estadoAlerta.cpuExcedido = true;
            const info = {
                chave: 'cpu',
                metrica: 'Utilização da CPU',
                valor: `${cpu} %`,
                limite: `${config.thresholdCpu} %`,
                horario: horarioFormatado
            };
            registrarEvento('ALERTA_THRESHOLD', `${info.metrica} atingiu ${info.valor} (Limite: ${info.limite})`);
            if (config.alertPopup) alertasPendentesPopup.push(info);
            if (config.alertEmail) dispararEmailAlerta(info);
        }
    } else {
        estadoAlerta.cpuExcedido = false;
    }
}

// 6. CONSULTA SNMP E CÁLCULO DE TAXA EM BPS (Requisito 2 e 6)
function executarCicloColeta() {
    if (!coletando) return;

    const agoraMs = Date.now();
    const dataIso = new Date(agoraMs).toISOString();
    const horarioBr = new Date(agoraMs).toLocaleTimeString('pt-BR');

    // Se estiver em modo simulação para testes rápidos de bancada
    if (config.modoSimulacao) {
        const bpsIn = Math.floor(150000 + Math.random() * 450000);
        const bpsOut = Math.floor(100000 + Math.random() * 400000);
        const cpu = Math.floor(15 + Math.random() * 75);
        salvarEProcessarAmostra(dataIso, agoraMs, horarioBr, bpsIn, bpsOut, cpu);
        return;
    }

    // OIDs padrão MIB-II (IF-MIB) e HOST-RESOURCES-MIB suportados pelo MikroTik RouterOS CHR
    const oidInOctets = `1.3.6.1.2.1.2.2.1.10.${config.ifIndex}`;
    const oidOutOctets = `1.3.6.1.2.1.2.2.1.16.${config.ifIndex}`;
    const oidCpuLoad = `1.3.6.1.2.1.25.3.3.1.2.1`;

    const session = snmp.createSession(config.routerIp, config.community, {
        port: 161,
        retries: 1,
        timeout: 2000,
        version: snmp.Version2c
    });

    session.get([oidInOctets, oidOutOctets, oidCpuLoad], (error, varbinds) => {
        session.close();
        if (error) {
            const msgErro = `Falha SNMP (${config.routerIp}): ${error.message}`;
            registrarEvento('ERRO_SNMP', msgErro);
            alertasPendentesPopup.push({
                metrica: 'Erro de Comunicação SNMP',
                valor: error.message,
                limite: `Host: ${config.routerIp}`,
                horario: horarioBr
            });
            return;
        }

        for (let vb of varbinds) {
            if (snmp.isVarbindError(vb)) {
                const msgOid = `OID não suportado ou inválido: ${snmp.varbindError(vb)}`;
                registrarEvento('ERRO_OID', msgOid);
                return;
            }
        }

        const inOctetsAtual = Number(varbinds[0].value);
        const outOctetsAtual = Number(varbinds[1].value);
        const cpuAtual = Number(varbinds[2].value);

        if (isNaN(inOctetsAtual) || isNaN(outOctetsAtual) || isNaN(cpuAtual)) {
            registrarEvento('ERRO_DADOS', 'Retorno SNMP não numérico ou inválido.');
            return;
        }

        // Verifica se é a primeira leitura ou se houve mudança de roteador/interface
        if (
            !ultimaLeitura ||
            ultimaLeitura.routerIp !== config.routerIp ||
            ultimaLeitura.ifIndex !== config.ifIndex
        ) {
            ultimaLeitura = {
                inOctets: inOctetsAtual,
                outOctets: outOctetsAtual,
                timestampMs: agoraMs,
                ifIndex: config.ifIndex,
                routerIp: config.routerIp
            };
            registrarEvento('INFO', `Contador base SNMP inicializado para ${config.routerIp} (ifIndex ${config.ifIndex}).`);
            return;
        }

        const deltaSegundos = (agoraMs - ultimaLeitura.timestampMs) / 1000.0;
        if (deltaSegundos <= 0) return;

        let diffIn = inOctetsAtual - ultimaLeitura.inOctets;
        let diffOut = outOctetsAtual - ultimaLeitura.outOctets;

        // Tratamento de Reinicialização do Contador (Counter Wrap de 32 bits ou reboot do roteador)
        const MAX_COUNTER_32 = 4294967295;
        if (diffIn < 0) {
            diffIn += MAX_COUNTER_32; // Corrige wrap de 32-bit
            if (diffIn < 0) diffIn = 0; // Se ainda negativo (reboot do equipamento), descarta pico negativo
        }
        if (diffOut < 0) {
            diffOut += MAX_COUNTER_32;
            if (diffOut < 0) diffOut = 0;
        }

        // Fórmula oficial da especificação: Taxa em bps = (diferença de bytes * 8) / intervalo real em segundos
        const bpsIn = (diffIn * 8) / deltaSegundos;
        const bpsOut = (diffOut * 8) / deltaSegundos;

        // Atualiza a referência para o próximo ciclo
        ultimaLeitura = {
            inOctets: inOctetsAtual,
            outOctets: outOctetsAtual,
            timestampMs: agoraMs,
            ifIndex: config.ifIndex,
            routerIp: config.routerIp
        };

        salvarEProcessarAmostra(dataIso, agoraMs, horarioBr, bpsIn, bpsOut, cpuAtual);
    });
}

function salvarEProcessarAmostra(dataIso, agoraMs, horarioBr, bpsIn, bpsOut, cpu) {
    const amostra = {
        timestamp: dataIso,
        horario: horarioBr,
        epoch: agoraMs,
        bps_in: Number(bpsIn.toFixed(2)),
        bps_out: Number(bpsOut.toFixed(2)),
        cpu_load: cpu
    };

    sessaoAtual.push(amostra);
    if (sessaoAtual.length > 100) sessaoAtual.shift();

    db.run(
        `INSERT INTO amostras (timestamp, epoch, bps_in, bps_out, cpu_load, router_ip, if_index) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [dataIso, agoraMs, amostra.bps_in, amostra.bps_out, amostra.cpu_load, config.routerIp, config.ifIndex]
    );

    avaliarThresholds(amostra.bps_in, amostra.bps_out, amostra.cpu_load, horarioBr);
}

// 7. ROTAS DA API REST PARA O FRONTEND
app.get('/api/status', (req, res) => {
    const alertas = [...alertasPendentesPopup];
    alertasPendentesPopup = []; // Limpa a fila após entregar ao frontend
    res.json({
        coletando,
        config,
        sessaoAtual,
        alertas
    });
});

app.post('/api/controle', (req, res) => {
    const { acao } = req.body;

    if (acao === 'iniciar') {
        // Requisito 6: Evitar múltiplos processos de coleta ao pressionar Iniciar repetidas vezes
        if (!coletando) {
            coletando = true;
            ultimaLeitura = null;
            executarCicloColeta();
            timerColeta = setInterval(executarCicloColeta, config.intervalSec * 1000);
            registrarEvento('CONTROLE', 'Coleta em tempo real iniciada.');
        }
    } else if (acao === 'pausar') {
        coletando = false;
        if (timerColeta) {
            clearInterval(timerColeta);
            timerColeta = null;
        }
        registrarEvento('CONTROLE', 'Coleta em tempo real pausada (dados em tela preservados).');
    } else if (acao === 'resetar') {
        // Requisito 3.1: Limpa apenas a série em tempo real, preservando o histórico no banco SQLite!
        sessaoAtual = [];
        ultimaLeitura = null;
        registrarEvento('CONTROLE', 'Visualização em tempo real resetada (histórico SQLite preservado).');
    }

    res.json({ sucesso: true, coletando, sessaoAtual });
});

app.post('/api/config', (req, res) => {
    const nova = req.body;

    // Validação do intervalo de coleta (Requisito 5: rejeitar zero ou valores negativos)
    const intervalo = Number(nova.intervalSec);
    if (isNaN(intervalo) || intervalo <= 0) {
        return res.status(400).json({ erro: 'O intervalo de coleta deve ser maior que zero (em segundos).' });
    }

    // Validação do formato de e-mail se alerta por e-mail estiver ativo (Requisito 5)
    const regexEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (nova.alertEmail && (!nova.emailDestino || !regexEmail.test(nova.emailDestino))) {
        return res.status(400).json({ erro: 'Informe um endereço de e-mail com formato válido.' });
    }

    if (Number(nova.thresholdInBps) <= 0 || Number(nova.thresholdOutBps) <= 0 || Number(nova.thresholdCpu) <= 0) {
        return res.status(400).json({ erro: 'Os limites (thresholds) devem ser valores positivos.' });
    }

    config = {
        ...config,
        routerIp: nova.routerIp.trim(),
        community: nova.community.trim(),
        ifIndex: Number(nova.ifIndex),
        intervalSec: intervalo,
        thresholdInBps: Number(nova.thresholdInBps),
        thresholdOutBps: Number(nova.thresholdOutBps),
        thresholdCpu: Number(nova.thresholdCpu),
        alertPopup: Boolean(nova.alertPopup),
        alertEmail: Boolean(nova.alertEmail),
        emailDestino: nova.emailDestino ? nova.emailDestino.trim() : '',
        smtpHost: nova.smtpHost || config.smtpHost,
        smtpPort: nova.smtpPort || config.smtpPort,
        smtpUser: nova.smtpUser || '',
        smtpPass: nova.smtpPass || '',
        modoSimulacao: Boolean(nova.modoSimulacao)
    };

    // Reinicia o timer se o intervalo mudou enquanto coletava
    if (coletando) {
        clearInterval(timerColeta);
        timerColeta = setInterval(executarCicloColeta, config.intervalSec * 1000);
    }

    registrarEvento('CONFIG', `Configurações atualizadas (Host: ${config.routerIp}, Intervalo: ${config.intervalSec}s).`);
    res.json({ sucesso: true, config });
});

app.get('/api/historico', (req, res) => {
    const { inicio, fim } = req.query;
    if (!inicio || !fim) {
        return res.status(400).json({ erro: 'Informe data/hora de início e fim para filtrar.' });
    }

    const epochInicio = new Date(inicio).getTime();
    const epochFim = new Date(fim).getTime();

    db.all(
        `SELECT * FROM amostras WHERE epoch >= ? AND epoch <= ? ORDER BY epoch ASC`,
        [epochInicio, epochFim],
        (err, rows) => {
            if (err) return res.status(500).json({ erro: err.message });
            res.json({ amostras: rows });
        }
    );
});

app.get('/api/logs', (req, res) => {
    db.all(`SELECT * FROM logs_eventos ORDER BY id DESC LIMIT 30`, [], (err, rows) => {
        if (err) return res.status(500).json({ erro: err.message });
        res.json({ logs: rows });
    });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`Servidor SNMP rodando em http://localhost:${PORT}`);
});
