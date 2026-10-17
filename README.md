# Sistema de Monitoramento de Roteador via SNMP (MikroTik RouterOS CHR)

Trabalho prático da disciplina de **Projeto e Administração de Redes** (IFBA - Campus Vitória da Conquista).

## 1. Arquitetura e Tecnologias
- **Backend:** Node.js com Express, `net-snmp` (coleta SNMPv2c), `sqlite3` (persistência histórica em arquivo `telemetria.db`) e `nodemailer` (notificações por e-mail).
- **Frontend:** HTML5, TailwindCSS e Chart.js para visualização em tempo real e histórica.
- **Separação de responsabilidades:** Coleta SNMP, cálculo de séries temporais, persistência SQLite, motor de avaliação de thresholds e apresentação visual desacoplados.

## 2. MIBs, OIDs e Cálculo de Métricas
- **Tráfego de Entrada (IN):** MIB `IF-MIB` (`ifInOctets`) — OID `1.3.6.1.2.1.2.2.1.10.<ifIndex>`
- **Tráfego de Saída (OUT):** MIB `IF-MIB` (`ifOutOctets`) — OID `1.3.6.1.2.1.2.2.1.16.<ifIndex>`
- **Utilização de CPU (%):** MIB `HOST-RESOURCES-MIB` (`hrProcessorLoad`) — OID `1.3.6.1.2.1.25.3.3.1.2.1`
- **Cálculo de bps:** `Taxa (bps) = ((Octetos_Atual - Octetos_Anterior) * 8) / Intervalo_Real_Segundos`. Trata automaticamente reinicialização do contador de 32 bits (*counter wrap*), reboot do roteador e mudança de interface.

## 3. Comportamento do Botão Resetar e Estratégia de Alertas
- **Botão Resetar:** Limpa exclusivamente os vetores da visualização da sessão em tempo real (`sessaoAtual`), mantendo intactos todos os registros já persistidos no banco de dados SQLite (`telemetria.db`) para consultas históricas.
- **Limites de Tráfego (Thresholds):** Os limites de tráfego são configurados e avaliados **separadamente** para Entrada (IN) e Saída (OUT), além do limite percentual de CPU.
- **Prevenção de Alertas Repetitivos:** Utiliza detecção de transição de estado (*Normal -> Excedido*) combinada com janela de espera (*Cooldown* de 60 segundos) para e-mails, evitando inundação de mensagens enquanto a métrica permanecer acima do threshold.

## 4. Instalação e Execução
1. Instale as dependências:
   ```bash
   npm install
