cat << 'EOF' > README.md
# Sistema de Monitoramento de Roteador via SNMP (MikroTik RouterOS CHR)

Trabalho prático da disciplina de **Projeto e Administração de Redes** — **IFBA (Campus Vitória da Conquista)**.

- **Integrantes da Equipe:** Osmir Santos Meira e Sávio Neri Pessoa
- **Equipamento Monitorado:** MikroTik RouterOS CHR (Cloud Hosted Router) via SNMPv2c

---

## 1. Arquitetura e Tecnologias (Documentação Técnica)
- **Backend (`server.js`):** Desenvolvido em **Node.js** com **Express**, utilizando a biblioteca `net-snmp` para consultas SNMPv2c periódicas, `sqlite3` para persistência histórica em banco de dados relacional local (`telemetria.db`) e `nodemailer` para envio de alertas por e-mail via SMTP.
- **Frontend (`public/index.html`):** Interface web responsiva construída com **HTML5**, **TailwindCSS** e **Chart.js** para renderização dos gráficos temporais ao vivo e históricos.
- **Separação de Responsabilidades:** A arquitetura separa em módulos/funções independentes a lógica de coleta SNMP (`executarCicloColeta`), o armazenamento persistente (`salvarEProcessarAmostra`), o motor de avaliação de thresholds e transição de estado (`avaliarThresholds`) e a camada de apresentação REST/Web.

---

## 2. MIBs, OIDs e Cálculo de Métricas
| Métrica | MIB | OID Utilizado | Unidade / Tipo |
| :--- | :--- | :--- | :--- |
| **Tráfego de Entrada (IN)** | `IF-MIB` (`ifInOctets`) | `1.3.6.1.2.1.2.2.1.10.<ifIndex>` | Contadores de bytes convertidos para **bps** |
| **Tráfego de Saída (OUT)** | `IF-MIB` (`ifOutOctets`) | `1.3.6.1.2.1.2.2.1.16.<ifIndex>` | Contadores de bytes convertidos para **bps** |
| **Utilização da CPU (%)** | `HOST-RESOURCES-MIB` (`hrProcessorLoad`) | `1.3.6.1.2.1.25.3.3.1.2.1` | Percentual direto (**0% a 100%**) |

### Fórmula do Cálculo de Taxa em bps e Tratamentos
A taxa de bits por segundo é calculada entre duas coletas consecutivas pela fórmula:
$$\text{Taxa (bps)} = \frac{(\text{Octetos}_{\text{atual}} - \text{Octetos}_{\text{anterior}}) \times 8}{\Delta t_{\text{segundos}}}$$
- **Tratamento de anomalias:** O sistema verifica automaticamente reinicialização do contador de 32 bits (*counter wrap* somando $2^{32}-1$), reinicialização do roteador, troca de endereço IP/interface monitorada e retornos não numéricos, descartando leituras negativas ou absurdas.

---

## 3. Comportamento do Botão Resetar e Estratégia de Alertas
- **Controles em Tempo Real (Iniciar, Pausar e Resetar):**
  - **Iniciar:** Inicia o ciclo de coleta protegendo contra múltiplos processos concorrentes caso pressionado repetidas vezes.
  - **Pausar:** Interrompe o temporizador de consultas SNMP preservando os dados já exibidos na tela.
  - **Resetar:** Limpa **exclusivamente** a série exibida na sessão em tempo real (`sessaoAtual`), **preservando integralmente todo o histórico já persistido** no banco de dados SQLite (`telemetria.db`).
- **Avaliação Separada de Thresholds:** Os limites de tráfego são configurados e avaliados **separadamente** para Entrada (`thresholdInBps`) e Saída (`thresholdOutBps`), além do limite de utilização de CPU (`thresholdCpu`).
- **Prevenção de Notificações Repetitivas:** O disparo de alertas opera por **transição de estado** (*Normal $\rightarrow$ Excedido*), só gerando novo alerta caso a métrica normalize e volte a exceder o limite, aliado a uma janela de espera (*Cooldown* de 60 segundos) para envios de e-mail.

---

## 4. Pré-requisitos, Instalação e Execução

### Pré-requisitos
- **Node.js** (v18 ou superior) e **NPM** instalados.
- Roteador **MikroTik RouterOS CHR** acessível na rede (ex: via QEMU/KVM ou VirtualBox no IP `192.168.88.1`).

### Configuração do SNMP no MikroTik RouterOS CHR
No terminal do MikroTik (ou via WinBox em `IP -> SNMP`), habilite o serviço SNMPv2c com comunidade de leitura:
```routeros
/ip address add address=192.168.88.1/24 interface=ether1
/snmp set enabled=yes contact="Equipe_PAR_IFBA" location="Lab_PAR"
/snmp community set [ find default=yes ] name=public addresses=0.0.0.0/0 read-access=yes
